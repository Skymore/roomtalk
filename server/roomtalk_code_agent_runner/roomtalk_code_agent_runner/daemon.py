from __future__ import annotations

import json
import os
import queue
import sys
import threading
from dataclasses import dataclass
from typing import Any, Callable, TextIO

from .runner import EventEmitter, RunnerError, RunnerRequest, parse_request

SCHEMA_VERSION = 1
SUPPORTED_BACKENDS = ("code-agent", "codex", "codex-app-server")

DaemonRunHandler = Callable[[RunnerRequest, EventEmitter, dict[str, str], "queue.Queue[dict[str, Any] | None]"], None]


@dataclass
class _ActiveRun:
    turn_id: str
    backend: str
    control_queue: "queue.Queue[dict[str, Any] | None]"
    thread: threading.Thread


class SandboxDaemon:
    def __init__(
        self,
        *,
        stdin: TextIO,
        stdout: TextIO,
        env: dict[str, str] | None = None,
        handlers: dict[str, DaemonRunHandler] | None = None,
    ) -> None:
        self.stdin = stdin
        self.emitter = EventEmitter(stdout)
        self.env = dict(env or os.environ)
        self.handlers = handlers or _default_handlers()
        self._lock = threading.Lock()
        self._active: _ActiveRun | None = None

    def run(self) -> int:
        self.emitter.emit({
            "type": "daemon_ready",
            "daemonId": self.env.get("ROOMTALK_SANDBOX_DAEMON_ID") or "roomtalk-sandbox-daemon",
            "pid": os.getpid(),
            "backends": list(SUPPORTED_BACKENDS),
        })

        for line_number, line in enumerate(self.stdin, start=1):
            if not line.strip():
                continue
            try:
                should_stop = self._handle_line(line, line_number)
            except Exception as exc:
                self._emit_error(exc)
                should_stop = False
            if should_stop:
                break

        self._request_active_stop("daemon input closed")
        self._join_active()
        return 0

    def _handle_line(self, line: str, line_number: int) -> bool:
        raw = self._parse_raw_request(line, line_number)
        request_type = raw.get("type")

        if request_type == "health":
            self.emitter.emit({
                "type": "health_result",
                "requestId": raw.get("requestId") if isinstance(raw.get("requestId"), str) else None,
                "status": "ok",
                "activeTurnId": self._active_turn_id(),
            })
            return False

        if request_type == "shutdown":
            self.emitter.emit({"type": "daemon_stopping", "reason": "shutdown_request"})
            return True

        if request_type == "run":
            self._start_run(raw)
            return False

        if request_type in ("thread_list", "thread_read"):
            self._run_thread_query(raw)
            return False

        if request_type in ("interrupt", "steer", "approval_response"):
            self._send_control(raw)
            return False

        raise RunnerError(f"Unsupported daemon request type: {request_type}", code="unsupported_daemon_request")

    def _parse_raw_request(self, line: str, line_number: int) -> dict[str, Any]:
        try:
            raw = json.loads(line)
        except json.JSONDecodeError as exc:
            raise RunnerError(f"Invalid daemon JSON request at line {line_number}: {exc.msg}", code="invalid_json") from exc
        if not isinstance(raw, dict):
            raise RunnerError("Daemon request must be a JSON object", code="invalid_request")
        if raw.get("schemaVersion") != SCHEMA_VERSION:
            raise RunnerError(f"Unsupported schemaVersion: {raw.get('schemaVersion')}", code="unsupported_schema")
        return raw

    def _start_run(self, raw: dict[str, Any]) -> None:
        backend = _read_backend(raw)
        env = self._run_env(raw)
        request = parse_request(json.dumps(raw, ensure_ascii=False, separators=(",", ":")))
        handler = self.handlers.get(backend)
        if handler is None:
            raise RunnerError(f"Unsupported daemon backend: {backend}", code="unsupported_backend", turn_id=request.turn_id)

        with self._lock:
            self._reap_finished_active_locked()
            if self._active is not None:
                self._emit_error(
                    RunnerError(
                        f"Sandbox daemon is busy with turn {self._active.turn_id}",
                        code="daemon_busy",
                        turn_id=request.turn_id,
                    )
                )
                return
            control_queue: "queue.Queue[dict[str, Any] | None]" = queue.Queue()
            thread = threading.Thread(
                target=self._run_backend,
                args=(backend, request, handler, env, control_queue),
                daemon=True,
            )
            self._active = _ActiveRun(
                turn_id=request.turn_id,
                backend=backend,
                control_queue=control_queue,
                thread=thread,
            )
            thread.start()

    def _run_thread_query(self, raw: dict[str, Any]) -> None:
        with self._lock:
            self._reap_finished_active_locked()
            if self._active is not None:
                raise RunnerError("Sandbox daemon is busy with an active turn", code="daemon_busy")
        from .codex_sdk_app_server import parse_app_server_request, run_thread_query_request

        request = parse_app_server_request(json.dumps(raw, ensure_ascii=False, separators=(",", ":")))
        env = self._run_env(raw)
        run_thread_query_request(request, emitter=self.emitter, env=env)

    def _run_backend(
        self,
        backend: str,
        request: RunnerRequest,
        handler: DaemonRunHandler,
        env: dict[str, str],
        control_queue: "queue.Queue[dict[str, Any] | None]",
    ) -> None:
        try:
            self.emitter.emit({
                "type": "status",
                "turnId": request.turn_id,
                "status": "starting",
                "message": f"sandbox daemon dispatching {backend}",
            })
            handler(request, self.emitter, env, control_queue)
        except Exception as exc:
            self._emit_error(exc, turn_id=request.turn_id)
        finally:
            control_queue.put(None)
            released = False
            with self._lock:
                active = self._active
                if active is not None and active.turn_id == request.turn_id:
                    self._active = None
                    released = True
            if released:
                self.emitter.emit({
                    "type": "turn_released",
                    "turnId": request.turn_id,
                })

    def _reap_finished_active_locked(self) -> None:
        active = self._active
        if active is not None and not active.thread.is_alive():
            self._active = None

    def _send_control(self, raw: dict[str, Any]) -> None:
        turn_id = raw.get("turnId")
        if not isinstance(turn_id, str) or not turn_id:
            raise RunnerError("Control request requires a turnId", code="invalid_request")
        with self._lock:
            active = self._active
        if active is None or active.turn_id != turn_id:
            self._emit_error(RunnerError("No active daemon turn matches control request", code="daemon_no_active_turn", turn_id=turn_id))
            return
        active.control_queue.put(raw)

    def _request_active_stop(self, reason: str) -> None:
        with self._lock:
            active = self._active
        if active is not None:
            active.control_queue.put({
                "schemaVersion": SCHEMA_VERSION,
                "type": "interrupt",
                "turnId": active.turn_id,
                "reason": reason,
            })

    def _join_active(self) -> None:
        while True:
            with self._lock:
                active = self._active
            if active is None:
                return
            active.thread.join(timeout=0.5)

    def _active_turn_id(self) -> str | None:
        with self._lock:
            return self._active.turn_id if self._active is not None else None

    def _run_env(self, raw: dict[str, Any]) -> dict[str, str]:
        requested = raw.get("env")
        if requested is None:
            return dict(self.env)
        if not isinstance(requested, dict):
            raise RunnerError("Daemon run env must be an object", code="invalid_request", turn_id=raw.get("turnId") if isinstance(raw.get("turnId"), str) else None)
        env = dict(self.env)
        for key, value in requested.items():
            if not isinstance(key, str) or not key:
                raise RunnerError("Daemon run env keys must be non-empty strings", code="invalid_request", turn_id=raw.get("turnId") if isinstance(raw.get("turnId"), str) else None)
            if not isinstance(value, str):
                raise RunnerError(f"Daemon run env value must be a string: {key}", code="invalid_request", turn_id=raw.get("turnId") if isinstance(raw.get("turnId"), str) else None)
            env[key] = value
        return env

    def _emit_error(self, error: Exception, *, turn_id: str | None = None) -> None:
        runner_error = error if isinstance(error, RunnerError) else RunnerError(str(error), turn_id=turn_id)
        event: dict[str, Any] = {
            "type": "error",
            "message": str(runner_error),
            "code": runner_error.code,
            "retryable": False,
        }
        event_turn_id = runner_error.turn_id or turn_id
        if event_turn_id:
            event["turnId"] = event_turn_id
        self.emitter.emit(event)


def _read_backend(raw: dict[str, Any]) -> str:
    value = raw.get("backend") or raw.get("agent") or "code-agent"
    if not isinstance(value, str) or not value:
        raise RunnerError("Daemon run request requires a backend", code="invalid_request", turn_id=raw.get("turnId") if isinstance(raw.get("turnId"), str) else None)
    if value not in SUPPORTED_BACKENDS:
        raise RunnerError(f"Unsupported daemon backend: {value}", code="unsupported_backend", turn_id=raw.get("turnId") if isinstance(raw.get("turnId"), str) else None)
    return value


def _default_handlers() -> dict[str, DaemonRunHandler]:
    return {
        "code-agent": _run_code_agent,
        "codex": _run_codex_cli,
        "codex-app-server": _run_codex_app_server,
    }


def _run_code_agent(
    request: RunnerRequest,
    emitter: EventEmitter,
    env: dict[str, str],
    control_queue: "queue.Queue[dict[str, Any] | None]",
) -> None:
    from .runner import run_request

    with _temporary_environ(env):
        run_request(request, emitter=emitter, control_queue=control_queue)


def _run_codex_cli(
    request: RunnerRequest,
    emitter: EventEmitter,
    env: dict[str, str],
    control_queue: "queue.Queue[dict[str, Any] | None]",
) -> None:
    del control_queue
    from .codex_cli import run_request

    run_request(request, emitter=emitter, env=env)


def _run_codex_app_server(
    request: RunnerRequest,
    emitter: EventEmitter,
    env: dict[str, str],
    control_queue: "queue.Queue[dict[str, Any] | None]",
) -> None:
    from .codex_sdk_app_server import run_request

    run_request(request, emitter=emitter, env=env, control_queue=control_queue)


class _temporary_environ:
    def __init__(self, values: dict[str, str]) -> None:
        self.values = values
        self.original: dict[str, str] | None = None

    def __enter__(self) -> None:
        self.original = dict(os.environ)
        os.environ.clear()
        os.environ.update(self.values)

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        assert self.original is not None
        os.environ.clear()
        os.environ.update(self.original)


def main(stdin: TextIO | None = None, stdout: TextIO | None = None) -> int:
    return SandboxDaemon(
        stdin=stdin or sys.stdin,
        stdout=stdout or sys.stdout,
    ).run()


if __name__ == "__main__":
    raise SystemExit(main())
