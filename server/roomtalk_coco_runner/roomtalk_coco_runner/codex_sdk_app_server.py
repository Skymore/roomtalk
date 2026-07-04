from __future__ import annotations

import json
import os
import queue
import shutil
import sys
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, TextIO

from .codex_app_server import (
    APP_SERVER_CLIENT_INFO,
    CodexAppServerJsonRpcMapper,
    CodexThreadQueryRequest,
    ControlQueue,
    SCHEMA_VERSION,
    _AppServerRunState,
    _PendingApproval,
    _approval_request_event,
    _approval_response_result,
    _approval_result_event,
    _chatgpt_auth_tokens_refresh_result,
    _codex_app_server_permissions,
    _codex_error_code,
    _codex_error_retryable,
    _create_persistent_app_server_home,
    _is_interactive_approval_method,
    _pending_approval_from_request,
    _persistent_app_server_home_enabled,
    _remove_app_server_sensitive_files,
    _thread_query_params,
    _thread_resume_params,
    _thread_start_params,
    _turn_start_params,
    parse_app_server_request,
)
from .codex_cli import (
    CodexCliRunConfig,
    _build_child_env,
    _restore_auth_json,
    _write_codex_config,
    _write_private_file,
    config_from_env,
)
from .runner import EventEmitter, RunnerError, RunnerRequest, validate_workspace_path

SdkClientFactory = Callable[[Any, Callable[[str, dict[str, Any] | None], dict[str, Any]]], Any]


@dataclass(frozen=True)
class _RoomTalkSdkConfig:
    codex_bin: str
    cwd: str
    client_name: str
    client_title: str
    client_version: str
    experimental_api: bool


class _SdkApprovalCoordinator:
    def __init__(
        self,
        *,
        request: RunnerRequest | None,
        emitter: EventEmitter | None,
        state: _AppServerRunState | None,
        config: CodexCliRunConfig,
        codex_home: Path,
    ) -> None:
        self.request = request
        self.emitter = emitter
        self.state = state
        self.config = config
        self.codex_home = codex_home
        self._condition = threading.Condition()
        self._decisions: dict[str, str] = {}
        self._stopped = False

    def handle(self, method: str, params: dict[str, Any] | None) -> dict[str, Any]:
        if (
            self.request is not None
            and self.emitter is not None
            and self.state is not None
            and _is_interactive_approval_method(method)
            and _codex_app_server_permissions(self.request).approval_policy == "on-request"
        ):
            return self._handle_interactive_approval(method, params or {})
        return _default_server_request_result(method, params, self.config, self.codex_home)

    def resolve(self, approval_id: str, decision: str) -> bool:
        state = self.state
        if state is not None and state.pop_pending_approval(approval_id) is None:
            return False
        with self._condition:
            self._decisions[approval_id] = decision
            self._condition.notify_all()
        return True

    def stop(self) -> None:
        with self._condition:
            self._stopped = True
            self._condition.notify_all()

    def _handle_interactive_approval(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        assert self.request is not None
        assert self.emitter is not None
        assert self.state is not None
        pending = _pending_approval_from_request({"method": method, "params": params, "id": params.get("approvalId") or params.get("itemId")})
        self.state.add_pending_approval(pending)
        self.emitter.emit(_approval_request_event(self.request.turn_id, pending))

        deadline = time.monotonic() + max(self.config.timeout_ms / 1000, 1)
        with self._condition:
            while not self._stopped and not self.state.stopped and pending.approval_id not in self._decisions:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._condition.wait(timeout=min(remaining, 0.5))
            decision = self._decisions.pop(pending.approval_id, "decline")

        return _approval_response_result(pending, decision)


def run_request(
    request: RunnerRequest,
    *,
    emitter: EventEmitter,
    config: CodexCliRunConfig | None = None,
    env: dict[str, str] | None = None,
    control_queue: ControlQueue | None = None,
    client_factory: SdkClientFactory | None = None,
) -> None:
    env = dict(env or os.environ)
    config = config or config_from_env(env)
    workspace = validate_workspace_path(request.workspace, env)
    persistent_codex_home = _persistent_app_server_home_enabled(env)
    codex_home = _create_persistent_app_server_home(config, request) if persistent_codex_home else _create_codex_home_like_cli(config, request.turn_id)
    state = _AppServerRunState(roomtalk_turn_id=request.turn_id)
    approvals = _SdkApprovalCoordinator(request=request, emitter=emitter, state=state, config=config, codex_home=codex_home)
    client: Any | None = None
    timeout: threading.Timer | None = None
    timed_out = False

    emitter.emit({
        "type": "status",
        "turnId": request.turn_id,
        "status": "starting",
        "message": "codex_sdk_app_server starting",
    })

    try:
        _write_codex_config(codex_home, request, env, workspace)
        _restore_auth_json(config, codex_home)

        child_env = _build_child_env(env, codex_home)
        sdk_config = _build_sdk_config(config, workspace)
        client = (client_factory or _default_sdk_client_factory)(sdk_config, approvals.handle)

        def close_after_timeout() -> None:
            nonlocal timed_out
            timed_out = True
            state.stop()
            approvals.stop()
            _close_client(client)

        timeout = threading.Timer(config.timeout_ms / 1000, close_after_timeout)
        timeout.daemon = True
        timeout.start()

        try:
            _start_client_with_env(client, child_env)
            client.initialize()
            control_thread = _start_sdk_control_dispatch_thread(control_queue, client, state, approvals, emitter) if control_queue else None
            try:
                mapper = CodexAppServerJsonRpcMapper(
                    turn_id=request.turn_id,
                    message_id=f"codex_sdk_app_{request.turn_id}",
                    workspace=workspace,
                    fallback_session_id=request.session_id,
                )
                thread_id = _open_thread(client, request, workspace, emitter, mapper)
                mapper.session_id = thread_id
                state.set_thread_id(thread_id)

                turn_params = _turn_start_params(request, env, workspace, thread_id)
                turn_response = client.turn_start(thread_id, turn_params["input"], params=turn_params)
                app_turn_id = _extract_nested_string(turn_response, "turn", "id")
                if not app_turn_id:
                    raise RunnerError("Codex SDK turn/start response did not include turn.id", code="codex_sdk_app_server_protocol_error", turn_id=request.turn_id)
                state.set_turn_id(app_turn_id)

                _consume_turn_notifications(client, app_turn_id, mapper, emitter)
                emitter.emit(mapper.final_event())
            finally:
                state.stop()
                approvals.stop()
                if control_thread is not None:
                    control_thread.join(timeout=1)
        finally:
            if timeout is not None:
                timeout.cancel()

        if timed_out:
            raise RunnerError(
                f"Codex SDK app-server timed out after {config.timeout_ms}ms",
                code="codex_sdk_app_server_timeout",
                turn_id=request.turn_id,
            )

        refreshed_auth = codex_home / "auth.json"
        if refreshed_auth.exists() and config.refreshed_auth_json_path:
            _write_private_file(config.refreshed_auth_json_path, refreshed_auth.read_text(encoding="utf-8"))
    finally:
        state.stop()
        approvals.stop()
        _close_client(client)
        if persistent_codex_home and not config.keep_codex_home:
            _remove_app_server_sensitive_files(codex_home)
        elif not config.keep_codex_home:
            shutil.rmtree(codex_home, ignore_errors=True)


def run_thread_query_request(
    request: CodexThreadQueryRequest,
    *,
    emitter: EventEmitter,
    config: CodexCliRunConfig | None = None,
    env: dict[str, str] | None = None,
    client_factory: SdkClientFactory | None = None,
) -> None:
    env = dict(env or os.environ)
    config = config or config_from_env(env)
    workspace = validate_workspace_path(request.workspace, env)
    codex_home = _create_persistent_app_server_home(config, request)
    approvals = _SdkApprovalCoordinator(request=None, emitter=None, state=None, config=config, codex_home=codex_home)
    client: Any | None = None
    timeout: threading.Timer | None = None
    timed_out = False

    try:
        _restore_auth_json(config, codex_home)
        child_env = _build_child_env(env, codex_home)
        sdk_config = _build_sdk_config(config, workspace)
        client = (client_factory or _default_sdk_client_factory)(sdk_config, approvals.handle)

        def close_after_timeout() -> None:
            nonlocal timed_out
            timed_out = True
            approvals.stop()
            _close_client(client)

        timeout = threading.Timer(config.timeout_ms / 1000, close_after_timeout)
        timeout.daemon = True
        timeout.start()

        try:
            _start_client_with_env(client, child_env)
            client.initialize()
            if request.type == "thread_list":
                result = _response_to_dict(client.thread_list(_thread_query_params(request, workspace)))
                emitter.emit({
                    "schemaVersion": SCHEMA_VERSION,
                    "type": "thread_list_result",
                    "roomId": request.room_id,
                    "threads": result.get("data") if isinstance(result.get("data"), list) else [],
                    "nextCursor": result.get("nextCursor") if isinstance(result.get("nextCursor"), str) else None,
                    "backwardsCursor": result.get("backwardsCursor") if isinstance(result.get("backwardsCursor"), str) else None,
                })
            else:
                result = _response_to_dict(client.thread_read(str(request.thread_id), include_turns=request.include_turns))
                thread = result.get("thread")
                emitter.emit({
                    "schemaVersion": SCHEMA_VERSION,
                    "type": "thread_read_result",
                    "roomId": request.room_id,
                    "thread": thread if isinstance(thread, dict) else {},
                })
        finally:
            if timeout is not None:
                timeout.cancel()

        if timed_out:
            raise RunnerError("Codex SDK app-server timed out during thread query", code="codex_sdk_app_server_timeout")

        refreshed_auth = codex_home / "auth.json"
        if refreshed_auth.exists() and config.refreshed_auth_json_path:
            _write_private_file(config.refreshed_auth_json_path, refreshed_auth.read_text(encoding="utf-8"))
    finally:
        approvals.stop()
        _close_client(client)
        if not config.keep_codex_home:
            _remove_app_server_sensitive_files(codex_home)


def _open_thread(
    client: Any,
    request: RunnerRequest,
    workspace: Path,
    emitter: EventEmitter,
    mapper: CodexAppServerJsonRpcMapper,
) -> str:
    if request.session_id:
        try:
            response = client.thread_resume(request.session_id, _thread_resume_params(request, workspace))
            thread_id = _extract_nested_string(response, "thread", "id")
            if thread_id:
                return thread_id
            raise RunnerError("Codex SDK thread/resume response did not include thread.id", code="codex_sdk_app_server_protocol_error", turn_id=request.turn_id)
        except Exception:
            emitter.emit(mapper._status("running", "codex SDK app-server resume failed; starting a new thread"))

    response = client.thread_start(_thread_start_params(request, workspace))
    thread_id = _extract_nested_string(response, "thread", "id")
    if not thread_id:
        raise RunnerError("Codex SDK thread/start response did not include thread.id", code="codex_sdk_app_server_protocol_error", turn_id=request.turn_id)
    return thread_id


def _consume_turn_notifications(
    client: Any,
    app_turn_id: str,
    mapper: CodexAppServerJsonRpcMapper,
    emitter: EventEmitter,
) -> None:
    turn_completed = False
    while True:
        notification = client.next_turn_notification(app_turn_id)
        message = _notification_to_json_rpc_message(notification)
        for mapped in mapper.map_notification(message):
            emitter.emit(mapped)
            if mapped.get("type") == "error":
                raise RunnerError(str(mapped.get("message") or "Codex SDK app-server turn failed"), code="codex_sdk_app_server_error", turn_id=mapper.turn_id)
        if message.get("method") == "turn/completed":
            turn_completed = True
            break
    if not turn_completed:
        raise RunnerError("Codex SDK app-server exited before turn/completed", code="codex_sdk_app_server_missing_completion", turn_id=mapper.turn_id)


def _start_sdk_control_dispatch_thread(
    control_queue: ControlQueue,
    client: Any,
    state: _AppServerRunState,
    approvals: _SdkApprovalCoordinator,
    emitter: EventEmitter,
) -> threading.Thread:
    def dispatch_controls() -> None:
        while True:
            try:
                control = control_queue.get()
            except Exception:
                return
            if control is None:
                return
            if control.get("schemaVersion") != SCHEMA_VERSION or control.get("turnId") != state.roomtalk_turn_id:
                continue
            control_type = control.get("type")
            try:
                if control_type == "interrupt":
                    active_ids = state.active_ids()
                    if not active_ids:
                        emitter.emit(_control_status(state.roomtalk_turn_id, "error", "Codex turn is not ready to interrupt"))
                        continue
                    thread_id, app_turn_id = active_ids
                    client.turn_interrupt(thread_id, app_turn_id)
                    emitter.emit(_control_status(state.roomtalk_turn_id, "running", "Codex interrupt sent"))
                elif control_type == "steer":
                    prompt = control.get("prompt")
                    if not isinstance(prompt, str) or not prompt.strip():
                        continue
                    active_ids = state.active_ids()
                    if not active_ids:
                        emitter.emit(_control_status(state.roomtalk_turn_id, "error", "Codex turn is not ready to steer"))
                        continue
                    thread_id, app_turn_id = active_ids
                    client.turn_steer(thread_id, app_turn_id, [{"type": "text", "text": prompt.strip(), "text_elements": []}])
                    emitter.emit(_control_status(state.roomtalk_turn_id, "running", "Codex steer sent"))
                elif control_type == "approval_response":
                    approval_id = control.get("approvalId")
                    decision = control.get("decision")
                    if not isinstance(approval_id, str) or not isinstance(decision, str):
                        continue
                    success = approvals.resolve(approval_id, decision)
                    emitter.emit(_approval_result_event(approval_id, decision, success=success, output=None if success else "Approval request is no longer pending."))
            except Exception as exc:
                emitter.emit({
                    "schemaVersion": SCHEMA_VERSION,
                    "type": "error",
                    "turnId": state.roomtalk_turn_id,
                    "message": str(exc),
                    "code": "codex_sdk_app_server_control_error",
                    "retryable": False,
                })

    thread = threading.Thread(target=dispatch_controls, daemon=True)
    thread.start()
    return thread


def _control_status(turn_id: str, status: str, message: str) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "type": "status",
        "turnId": turn_id,
        "status": status,
        "message": message,
    }


def _default_server_request_result(
    method: str,
    params: dict[str, Any] | None,
    config: CodexCliRunConfig,
    codex_home: Path,
) -> dict[str, Any]:
    del params
    if method in ("item/commandExecution/requestApproval", "item/fileChange/requestApproval"):
        return {"decision": "decline"}
    if method == "item/permissions/requestApproval":
        return {"permissions": {}, "scope": "turn", "strictAutoReview": True}
    if method in ("execCommandApproval", "applyPatchApproval"):
        return {"decision": "denied"}
    if method == "item/tool/requestUserInput":
        return {"answers": {}}
    if method == "mcpServer/elicitation/request":
        return {"action": "decline", "content": None, "_meta": None}
    if method == "account/chatgptAuthTokens/refresh":
        return _chatgpt_auth_tokens_refresh_result(config, codex_home)
    return {}


def _build_sdk_config(config: CodexCliRunConfig, workspace: Path) -> Any:
    return _RoomTalkSdkConfig(
        codex_bin=config.cli_bin,
        cwd=str(workspace),
        client_name=APP_SERVER_CLIENT_INFO["name"],
        client_title=APP_SERVER_CLIENT_INFO["title"],
        client_version=APP_SERVER_CLIENT_INFO["version"],
        experimental_api=True,
    )


def _default_sdk_client_factory(
    sdk_config: Any,
    approval_handler: Callable[[str, dict[str, Any] | None], dict[str, Any]],
) -> Any:
    try:
        from openai_codex import CodexConfig
        from openai_codex.client import CodexClient
    except ImportError as exc:
        raise RunnerError(
            "openai-codex Python SDK is not installed in the sandbox",
            code="codex_sdk_unavailable",
        ) from exc
    official_config = CodexConfig(
        codex_bin=sdk_config.codex_bin,
        cwd=sdk_config.cwd,
        client_name=sdk_config.client_name,
        client_title=sdk_config.client_title,
        client_version=sdk_config.client_version,
        experimental_api=sdk_config.experimental_api,
    )
    return CodexClient(config=official_config, approval_handler=approval_handler)


def _start_client_with_env(client: Any, child_env: dict[str, str]) -> None:
    with _temporary_process_environ(child_env):
        client.start()


@contextmanager
def _temporary_process_environ(values: dict[str, str]):
    original = dict(os.environ)
    try:
        os.environ.clear()
        os.environ.update(values)
        yield
    finally:
        os.environ.clear()
        os.environ.update(original)


def _notification_to_json_rpc_message(notification: Any) -> dict[str, Any]:
    method = getattr(notification, "method", None)
    if not isinstance(method, str):
        method = str(_read_dict_value(notification, "method") or "")
    payload = getattr(notification, "payload", None)
    if payload is None and isinstance(notification, dict):
        payload = notification.get("payload") or notification.get("params")
    params = _model_to_dict(payload)
    return {
        "method": method,
        "params": params if isinstance(params, dict) else {},
    }


def _response_to_dict(response: Any) -> dict[str, Any]:
    value = _model_to_dict(response)
    return value if isinstance(value, dict) else {}


def _model_to_dict(value: Any) -> Any:
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        try:
            return model_dump(by_alias=True, exclude_none=True, mode="json")
        except TypeError:
            return model_dump()
    return value


def _extract_nested_string(value: Any, *keys: str) -> str | None:
    current: Any = _response_to_dict(value)
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current if isinstance(current, str) and current else None


def _read_dict_value(value: Any, key: str) -> Any:
    return value.get(key) if isinstance(value, dict) else None


def _close_client(client: Any | None) -> None:
    if client is None:
        return
    close = getattr(client, "close", None)
    if callable(close):
        try:
            close()
        except Exception:
            pass


def _create_codex_home_like_cli(config: CodexCliRunConfig, turn_id: str) -> Path:
    import tempfile

    parent = config.secret_parent
    parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=f"codex-sdk-{turn_id}-", dir=str(parent)))


def main(stdin: TextIO | None = None, stdout: TextIO | None = None) -> int:
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    line = stdin.readline()
    request: RunnerRequest | CodexThreadQueryRequest | None = None
    if not line:
        _emit_error(stdout, RunnerError("No runner request received", code="missing_request"))
        return 1
    try:
        request = parse_app_server_request(line)
        if isinstance(request, RunnerRequest):
            control_queue: ControlQueue = queue.Queue()
            _start_runner_control_reader(stdin, control_queue)
            run_request(request, emitter=EventEmitter(stdout), control_queue=control_queue)
        else:
            run_thread_query_request(request, emitter=EventEmitter(stdout))
        return 0
    except Exception as exc:
        turn_id = request.turn_id if isinstance(request, RunnerRequest) else None
        if isinstance(exc, RunnerError):
            turn_id = exc.turn_id or turn_id
        _emit_error(stdout, exc, turn_id=turn_id)
        return 1


def _start_runner_control_reader(stdin: TextIO, control_queue: ControlQueue) -> threading.Thread:
    def read_controls() -> None:
        for line in stdin:
            if not line.strip():
                continue
            try:
                raw = json.loads(line)
                if isinstance(raw, dict):
                    control_queue.put(raw)
            except Exception:
                continue
        control_queue.put(None)

    thread = threading.Thread(target=read_controls, daemon=True)
    thread.start()
    return thread


def _emit_error(stdout: TextIO, exc: Exception, *, turn_id: str | None = None) -> None:
    error: Any = getattr(exc, "error", None)
    error_dict = error if isinstance(error, dict) else {}
    event = {
        "schemaVersion": SCHEMA_VERSION,
        "type": "error",
        "message": str(exc),
        "code": exc.code if isinstance(exc, RunnerError) else _codex_error_code(error_dict),
        "retryable": _codex_error_retryable(error_dict),
    }
    if turn_id:
        event["turnId"] = turn_id
    stdout.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
    stdout.flush()


if __name__ == "__main__":
    raise SystemExit(main())
