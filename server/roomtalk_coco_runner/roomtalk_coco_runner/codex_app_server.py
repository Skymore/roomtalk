from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, TextIO

from .codex_cli import (
    CodexCliRunConfig,
    _build_child_env,
    _codex_exec_permissions,
    _create_codex_home,
    _normalize_codex_model,
    _normalize_codex_reasoning_effort,
    _normalize_workspace_text,
    _restore_auth_json,
    _roomtalk_tool_name,
    _start_stderr_tail_thread,
    _write_codex_config,
    _write_private_file,
    config_from_env,
)
from .runner import EventEmitter, RunnerError, RunnerRequest, parse_request, validate_workspace_path

SCHEMA_VERSION = 1
MAX_STDERR_TAIL_CHARS = 4_000
APP_SERVER_CLIENT_INFO = {
    "name": "roomtalk",
    "title": "RoomTalk",
    "version": "0.1.0",
}


@dataclass
class CodexAppServerJsonRpcMapper:
    turn_id: str
    message_id: str
    workspace: Path
    fallback_session_id: str | None = None
    session_id: str | None = None
    answer_parts: list[str] = field(default_factory=list)
    completed_agent_message_ids: set[str] = field(default_factory=set)
    streamed_agent_message_ids: set[str] = field(default_factory=set)
    command_tool_names: dict[str, str] = field(default_factory=dict)
    ignored_item_types: dict[str, int] = field(default_factory=dict)

    def map_notification(self, message: dict[str, Any]) -> list[dict[str, Any]]:
        method = str(message.get("method") or "")
        params = message.get("params") if isinstance(message.get("params"), dict) else {}

        if method == "thread/started":
            thread_id = _read_nested_string(params, "thread", "id") or _read_string(params, "threadId")
            if thread_id:
                self.session_id = thread_id
            return [self._status("starting", "codex app-server thread started")]

        if method == "turn/started":
            return [self._status("running", "codex app-server turn started")]

        if method == "item/agentMessage/delta":
            delta = str(params.get("delta") or "")
            item_id = str(params.get("itemId") or "")
            if item_id:
                self.streamed_agent_message_ids.add(item_id)
            if delta:
                normalized = _normalize_workspace_text(self.workspace, delta)
                self.answer_parts.append(normalized)
                return [{
                    "schemaVersion": SCHEMA_VERSION,
                    "type": "text_delta",
                    "messageId": self.message_id,
                    "turnId": self.turn_id,
                    "delta": normalized,
                }]
            return []

        if method == "item/started":
            item = params.get("item")
            return self._map_item(item, completed=False) if isinstance(item, dict) else []

        if method == "item/completed":
            item = params.get("item")
            return self._map_item(item, completed=True) if isinstance(item, dict) else []

        if method == "turn/completed":
            turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
            status = str(turn.get("status") or "")
            if status == "failed":
                error = turn.get("error") if isinstance(turn.get("error"), dict) else {}
                return [{
                    "schemaVersion": SCHEMA_VERSION,
                    "type": "error",
                    "turnId": self.turn_id,
                    "message": str(error.get("message") or "Codex app-server turn failed"),
                    "code": "codex_app_server_error",
                    "retryable": False,
                }]
            return [self._status("complete", "codex app-server turn completed")]

        return []

    def final_event(self) -> dict[str, Any]:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "type": "final",
            "messageId": self.message_id,
            "turnId": self.turn_id,
            "answer": _normalize_workspace_text(self.workspace, "".join(self.answer_parts)),
            "sessionId": self.session_id or self.fallback_session_id or "codex-app-server-session",
        }

    def _map_item(self, item: dict[str, Any], *, completed: bool) -> list[dict[str, Any]]:
        item_type = str(item.get("type") or "")
        item_id = str(item.get("id") or "")

        if item_type == "agentMessage" and completed:
            text = str(item.get("text") or "")
            if text and item_id not in self.streamed_agent_message_ids and item_id not in self.completed_agent_message_ids:
                self.completed_agent_message_ids.add(item_id)
                normalized = _normalize_workspace_text(self.workspace, text)
                self.answer_parts.append(normalized)
                return [{
                    "schemaVersion": SCHEMA_VERSION,
                    "type": "text_delta",
                    "messageId": self.message_id,
                    "turnId": self.turn_id,
                    "delta": normalized,
                }]
            return []

        if item_type == "commandExecution" and not completed:
            command = str(item.get("command") or "")
            tool_name = _roomtalk_tool_name(command) or "shell"
            self.command_tool_names[item_id] = tool_name
            return [{
                "schemaVersion": SCHEMA_VERSION,
                "type": "tool_call",
                "id": item_id,
                "name": tool_name,
                "args": {"command": command},
                "messageId": f"codex_app_tool_{item_id}",
            }]

        if item_type == "commandExecution" and completed:
            exit_code = item.get("exitCode")
            normalized_exit_code = exit_code if isinstance(exit_code, int) else None
            command = str(item.get("command") or "")
            tool_name = _roomtalk_tool_name(command) or self.command_tool_names.get(item_id) or "shell"
            status = str(item.get("status") or "")
            event: dict[str, Any] = {
                "schemaVersion": SCHEMA_VERSION,
                "type": "tool_result",
                "id": item_id,
                "name": tool_name,
                "success": status == "completed" and (normalized_exit_code in (None, 0)),
                "output": _normalize_workspace_text(self.workspace, str(item.get("aggregatedOutput") or "")),
                "messageId": f"codex_app_tool_result_{item_id}",
            }
            if normalized_exit_code is not None:
                event["exitCode"] = normalized_exit_code
            duration_ms = item.get("durationMs")
            if isinstance(duration_ms, int):
                event["elapsedMs"] = duration_ms
            return [event]

        if item_type == "fileChange" and not completed:
            changes = _normalize_app_server_changes(self.workspace, item.get("changes"))
            return [{
                "schemaVersion": SCHEMA_VERSION,
                "type": "tool_call",
                "id": item_id,
                "name": "file_change",
                "args": {"changes": changes},
                "messageId": f"codex_app_tool_{item_id}",
            }]

        if item_type == "fileChange" and completed:
            changes = _normalize_app_server_changes(self.workspace, item.get("changes"))
            return [{
                "schemaVersion": SCHEMA_VERSION,
                "type": "tool_result",
                "id": item_id,
                "name": "file_change",
                "success": str(item.get("status") or "") == "completed",
                "output": "\n".join(f"{change.get('kind')} {change.get('path')}" for change in changes),
                "messageId": f"codex_app_tool_result_{item_id}",
            }]

        if item_type and completed:
            self.ignored_item_types[item_type] = self.ignored_item_types.get(item_type, 0) + 1
        return []

    def _status(self, status: str, message: str) -> dict[str, Any]:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "type": "status",
            "turnId": self.turn_id,
            "status": status,
            "message": message,
        }


def run_request(
    request: RunnerRequest,
    *,
    emitter: EventEmitter,
    config: CodexCliRunConfig | None = None,
    popen_factory: Callable[..., subprocess.Popen] = subprocess.Popen,
    env: dict[str, str] | None = None,
) -> None:
    env = dict(env or os.environ)
    config = config or config_from_env(env)
    workspace = validate_workspace_path(request.workspace, env)
    codex_home = _create_codex_home(config, request.turn_id)
    stderr_tail = _Tail(MAX_STDERR_TAIL_CHARS)

    emitter.emit({
        "type": "status",
        "turnId": request.turn_id,
        "status": "starting",
        "message": "codex_app_server starting",
    })

    process: Any | None = None
    timeout: threading.Timer | None = None
    timed_out = False

    try:
        _write_codex_config(codex_home, request, env, workspace)
        _restore_auth_json(config, codex_home)

        process = popen_factory(
            [config.cli_bin, "app-server", "--stdio"],
            cwd=str(workspace),
            env=_build_child_env(env, codex_home),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        stderr_thread = _start_stderr_tail_thread(process.stderr, stderr_tail)

        def kill_after_timeout() -> None:
            nonlocal timed_out
            timed_out = True
            process.kill()

        timeout = threading.Timer(config.timeout_ms / 1000, kill_after_timeout)
        timeout.daemon = True
        timeout.start()

        try:
            mapper = CodexAppServerJsonRpcMapper(
                turn_id=request.turn_id,
                message_id=f"codex_app_{request.turn_id}",
                workspace=workspace,
                fallback_session_id=request.session_id,
            )
            _drive_app_server(process, request, mapper, emitter, env, workspace)
            exit_code = _stop_app_server(process)
        finally:
            timeout.cancel()
            stderr_thread.join(timeout=1)

        if timed_out:
            raise RunnerError(
                f"Codex app-server timed out after {config.timeout_ms}ms",
                code="codex_app_server_timeout",
                turn_id=request.turn_id,
            )

        refreshed_auth = codex_home / "auth.json"
        if refreshed_auth.exists() and config.refreshed_auth_json_path:
            _write_private_file(config.refreshed_auth_json_path, refreshed_auth.read_text(encoding="utf-8"))

        if exit_code not in (0, None):
            tail = stderr_tail.value()
            message = f"Codex app-server exited with code {exit_code}"
            if tail:
                message = f"{message}: {tail}"
            raise RunnerError(message, code="codex_app_server_exit", turn_id=request.turn_id)
    finally:
        if process is not None and getattr(process, "returncode", None) is None:
            _terminate_process(process)
        if not config.keep_codex_home:
            shutil.rmtree(codex_home, ignore_errors=True)


def _drive_app_server(
    process: Any,
    request: RunnerRequest,
    mapper: CodexAppServerJsonRpcMapper,
    emitter: EventEmitter,
    env: dict[str, str],
    workspace: Path,
) -> None:
    if process.stdin is None or process.stdout is None:
        raise RunnerError("Codex app-server did not expose stdio", code="codex_app_server_process_error", turn_id=request.turn_id)

    next_id = 0

    def send(method: str, params: dict[str, Any] | None = None, *, request_id: int | None = None) -> int | None:
        nonlocal next_id
        payload: dict[str, Any] = {"method": method, "params": params or {}}
        if request_id is not None:
            payload["id"] = request_id
        elif method != "initialized":
            payload["id"] = next_id
            next_id += 1
        process.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
        process.stdin.flush()
        return payload.get("id") if isinstance(payload.get("id"), int) else None

    initialize_id = send("initialize", {
        "clientInfo": APP_SERVER_CLIENT_INFO,
        "capabilities": {
            "experimentalApi": True,
        },
    })
    send("initialized", {})
    thread_start_id = send("thread/start", _thread_start_params(request, workspace))
    turn_start_id: int | None = None
    turn_completed = False

    for line_number, line in enumerate(process.stdout, start=1):
        if not line.strip():
            continue
        message = _parse_json_rpc_line(line, line_number, request.turn_id)

        if _is_server_request(message):
            _respond_to_server_request(process, message)
            continue

        if "id" in message:
            if message.get("error"):
                error = message.get("error") if isinstance(message.get("error"), dict) else {}
                raise RunnerError(
                    str(error.get("message") or f"Codex app-server request {message.get('id')} failed"),
                    code="codex_app_server_rpc_error",
                    turn_id=request.turn_id,
                )
            if message.get("id") == initialize_id:
                continue
            if message.get("id") == thread_start_id:
                thread_id = _read_nested_string(message, "result", "thread", "id")
                if not thread_id:
                    raise RunnerError("Codex app-server thread/start response did not include thread.id", code="codex_app_server_protocol_error", turn_id=request.turn_id)
                mapper.session_id = thread_id
                turn_start_id = send("turn/start", _turn_start_params(request, env, workspace, thread_id))
                continue
            if message.get("id") == turn_start_id:
                continue
            continue

        if "id" not in message and isinstance(message.get("method"), str):
            for mapped in mapper.map_notification(message):
                emitter.emit(mapped)
                if mapped.get("type") == "error":
                    raise RunnerError(str(mapped.get("message") or "Codex app-server turn failed"), code="codex_app_server_error", turn_id=request.turn_id)
            if message.get("method") == "turn/completed":
                turn_completed = True
                break

    if not turn_completed:
        raise RunnerError("Codex app-server exited before turn/completed", code="codex_app_server_missing_completion", turn_id=request.turn_id)

    emitter.emit(mapper.final_event())


def _thread_start_params(request: RunnerRequest, workspace: Path) -> dict[str, Any]:
    permission = _codex_exec_permissions(request)
    return {
        "model": _normalize_codex_model(request.codex_model),
        "cwd": str(workspace),
        "ephemeral": True,
        "sandbox": permission.sandbox,
        "approvalPolicy": permission.approval_policy,
    }


def _turn_start_params(request: RunnerRequest, env: dict[str, str], workspace: Path, thread_id: str) -> dict[str, Any]:
    permission = _codex_exec_permissions(request)
    return {
        "threadId": thread_id,
        "input": [{"type": "text", "text": _prompt_with_app_server_tools(request, env)}],
        "cwd": str(workspace),
        "model": _normalize_codex_model(request.codex_model),
        "effort": _normalize_codex_reasoning_effort(request.codex_reasoning_effort),
        "approvalPolicy": permission.approval_policy,
        "sandboxPolicy": _sandbox_policy_for_permission(permission.sandbox, workspace),
    }


def _sandbox_policy_for_permission(sandbox: str, workspace: Path) -> dict[str, Any]:
    if sandbox == "read-only":
        return {"type": "readOnly", "networkAccess": False}
    if sandbox == "danger-full-access":
        return {"type": "dangerFullAccess"}
    return {
        "type": "workspaceWrite",
        "networkAccess": True,
        "writableRoots": [str(workspace)],
    }


def _prompt_with_app_server_tools(request: RunnerRequest, env: dict[str, str]) -> str:
    from .codex_cli import _prompt_with_roomtalk_tools

    return _prompt_with_roomtalk_tools(request, env)


def _parse_json_rpc_line(line: str, line_number: int, turn_id: str) -> dict[str, Any]:
    try:
        message = json.loads(line)
    except json.JSONDecodeError as exc:
        raise RunnerError(
            f"Invalid Codex app-server JSONL at line {line_number}: {exc.msg}",
            code="codex_app_server_protocol_error",
            turn_id=turn_id,
        ) from exc
    if not isinstance(message, dict):
        raise RunnerError(
            f"Invalid Codex app-server JSONL at line {line_number}: message must be an object",
            code="codex_app_server_protocol_error",
            turn_id=turn_id,
        )
    return message


def _is_server_request(message: dict[str, Any]) -> bool:
    method = message.get("method")
    return isinstance(message.get("id"), (int, str)) and isinstance(method, str)


def _respond_to_server_request(process: Any, message: dict[str, Any]) -> None:
    method = str(message.get("method") or "")
    if method in ("item/commandExecution/requestApproval", "item/fileChange/requestApproval"):
        result: dict[str, Any] = {"decision": "decline"}
    elif method == "item/permissions/requestApproval":
        result = {
            "permissions": {
                "fileSystem": None,
                "network": None,
            },
            "scope": "turn",
        }
    else:
        result = {"error": "Unsupported server request in RoomTalk non-interactive runner"}
    process.stdin.write(json.dumps({"id": message["id"], "result": result}, separators=(",", ":")) + "\n")
    process.stdin.flush()


def _stop_app_server(process: Any) -> int | None:
    if getattr(process, "returncode", None) is not None:
        return process.returncode
    stdin = getattr(process, "stdin", None)
    if stdin is not None:
        try:
            stdin.close()
        except Exception:
            pass
    _terminate_process(process)
    try:
        process.wait(timeout=5)
        return 0
    except TypeError:
        process.wait()
        return 0
    except Exception:
        process.kill()
        try:
            process.wait(timeout=5)
            return 0
        except Exception:
            return None


def _terminate_process(process: Any) -> None:
    if getattr(process, "returncode", None) is not None:
        return
    terminate = getattr(process, "terminate", None)
    if callable(terminate):
        terminate()
        return
    kill = getattr(process, "kill", None)
    if callable(kill):
        kill()


def _normalize_app_server_changes(workspace: Path, value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    changes: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        change = dict(item)
        raw_path = change.get("path") or change.get("movePath")
        if isinstance(raw_path, str):
            change["path"] = _normalize_workspace_path(workspace, raw_path)
        if "kind" not in change and isinstance(change.get("type"), str):
            change["kind"] = change["type"]
        changes.append(change)
    return changes


def _normalize_workspace_path(workspace: Path, value: str) -> str:
    path = Path(value)
    if not path.is_absolute():
        return value
    try:
        return str(path.relative_to(workspace))
    except ValueError:
        return value


def _read_string(value: dict[str, Any], key: str) -> str | None:
    item = value.get(key)
    return item if isinstance(item, str) and item else None


def _read_nested_string(value: dict[str, Any], *keys: str) -> str | None:
    current: Any = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current if isinstance(current, str) and current else None


class _Tail:
    def __init__(self, max_chars: int):
        self.max_chars = max_chars
        self._value = ""

    def push(self, value: str) -> None:
        self._value = f"{self._value}{value}"[-self.max_chars:]

    def value(self) -> str:
        return self._value.strip()


def main(stdin: TextIO | None = None, stdout: TextIO | None = None) -> int:
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    line = stdin.readline()
    request: RunnerRequest | None = None
    if not line:
        _emit_error(stdout, RunnerError("No runner request received", code="missing_request"))
        return 1
    try:
        request = parse_request(line)
        run_request(request, emitter=EventEmitter(stdout))
        return 0
    except Exception as exc:
        turn_id = request.turn_id if request else None
        if isinstance(exc, RunnerError):
            turn_id = exc.turn_id or turn_id
        _emit_error(stdout, exc, turn_id=turn_id)
        return 1


def _emit_error(stdout: TextIO, exc: Exception, *, turn_id: str | None = None) -> None:
    event = {
        "schemaVersion": SCHEMA_VERSION,
        "type": "error",
        "message": str(exc),
        "code": exc.code if isinstance(exc, RunnerError) else "runner_exception",
    }
    if turn_id:
        event["turnId"] = turn_id
    stdout.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
    stdout.flush()


if __name__ == "__main__":
    raise SystemExit(main())
