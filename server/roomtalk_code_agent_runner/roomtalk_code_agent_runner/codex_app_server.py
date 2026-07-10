from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import base64
import time
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Callable, TextIO

from .codex_cli import (
    CodexCliRunConfig,
    _build_child_env,
    _codex_exec_permissions,
    _codex_room_context_permission_profile,
    _create_codex_home,
    _normalize_codex_model,
    _normalize_codex_reasoning_effort,
    _normalize_codex_service_tier,
    _normalize_workspace_text,
    _restore_auth_json,
    _roomtalk_tool_name,
    _start_stderr_tail_thread,
    _write_codex_config,
    _write_private_file,
    config_from_env,
)
from .runner import EventEmitter, RunnerError, RunnerRequest, parse_request, validate_workspace_path
from .room_context_broker import start_room_context_broker

SCHEMA_VERSION = 1
MAX_STDERR_TAIL_CHARS = 4_000
APP_SERVER_CLIENT_INFO = {
    "name": "roomtalk",
    "title": "RoomTalk",
    "version": "0.1.0",
}

ControlQueue = queue.Queue[dict[str, Any] | None]


@dataclass(frozen=True)
class CodexThreadQueryRequest:
    type: str
    room_id: str
    client_id: str | None
    workspace: Path
    cursor: str | None = None
    limit: int | None = None
    search_term: str | None = None
    thread_id: str | None = None
    include_turns: bool = False


@dataclass
class _PendingApproval:
    approval_id: str
    json_rpc_id: int | str
    method: str
    params: dict[str, Any]
    started_at_ms: int


@dataclass
class _AppServerRunState:
    roomtalk_turn_id: str
    thread_id: str | None = None
    app_turn_id: str | None = None
    pending_approvals: dict[str, _PendingApproval] = field(default_factory=dict)
    stopped: bool = False
    condition: threading.Condition = field(default_factory=threading.Condition)

    def set_thread_id(self, thread_id: str) -> None:
        with self.condition:
            self.thread_id = thread_id
            self.condition.notify_all()

    def set_turn_id(self, turn_id: str) -> None:
        with self.condition:
            self.app_turn_id = turn_id
            self.condition.notify_all()

    def stop(self) -> None:
        with self.condition:
            self.stopped = True
            self.condition.notify_all()

    def active_ids(self, timeout_seconds: float = 30) -> tuple[str, str] | None:
        deadline = time.monotonic() + timeout_seconds
        with self.condition:
            while not self.stopped and (not self.thread_id or not self.app_turn_id):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self.condition.wait(timeout=remaining)
            if self.thread_id and self.app_turn_id:
                return self.thread_id, self.app_turn_id
            return None

    def add_pending_approval(self, pending: _PendingApproval) -> None:
        with self.condition:
            self.pending_approvals[pending.approval_id] = pending
            self.condition.notify_all()

    def pop_pending_approval(self, approval_id: str) -> _PendingApproval | None:
        with self.condition:
            return self.pending_approvals.pop(approval_id, None)


@dataclass
class CodexAppServerJsonRpcMapper:
    turn_id: str
    message_id: str
    workspace: Path
    fallback_session_id: str | None = None
    session_id: str | None = None
    answer_parts: list[str] = field(default_factory=list)
    streamed_agent_message_text: dict[str, str] = field(default_factory=dict)
    completed_agent_message_ids: set[str] = field(default_factory=set)
    streamed_agent_message_ids: set[str] = field(default_factory=set)
    command_tool_names: dict[str, str] = field(default_factory=dict)
    command_output_parts: dict[str, list[str]] = field(default_factory=dict)
    file_change_output_parts: dict[str, list[str]] = field(default_factory=dict)
    ignored_item_types: dict[str, int] = field(default_factory=dict)
    usage: dict[str, Any] | None = None

    def map_notification(self, message: dict[str, Any]) -> list[dict[str, Any]]:
        method = str(message.get("method") or "")
        params = message.get("params") if isinstance(message.get("params"), dict) else {}

        if method == "error":
            error = params.get("error") if isinstance(params.get("error"), dict) else params
            return [{
                "schemaVersion": SCHEMA_VERSION,
                "type": "error",
                "turnId": self.turn_id,
                "message": str(error.get("message") or params.get("message") or "Codex app-server error"),
                "code": _codex_error_code(error),
                "retryable": _codex_error_retryable(error),
            }]

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
                if item_id:
                    self.streamed_agent_message_text[item_id] = self.streamed_agent_message_text.get(item_id, "") + normalized
                return [{
                    "schemaVersion": SCHEMA_VERSION,
                    "type": "text_delta",
                    "messageId": self.message_id,
                    "turnId": self.turn_id,
                    "delta": normalized,
                }]
            return []

        if method in ("item/commandExecution/outputDelta", "command/exec/outputDelta"):
            item_id = _read_string(params, "itemId") or _read_string(params, "callId") or _read_string(params, "id") or ""
            delta = str(params.get("delta") or "")
            if item_id and delta:
                self.command_output_parts.setdefault(item_id, []).append(_normalize_workspace_text(self.workspace, delta))
            return []

        if method == "item/fileChange/outputDelta":
            item_id = _read_string(params, "itemId") or ""
            delta = str(params.get("delta") or "")
            if item_id and delta:
                self.file_change_output_parts.setdefault(item_id, []).append(_normalize_workspace_text(self.workspace, delta))
            return []

        if method == "thread/tokenUsage/updated":
            self.usage = _to_runner_usage(params.get("tokenUsage")) or self.usage
            if not self.usage:
                return []
            return [{
                "schemaVersion": SCHEMA_VERSION,
                "type": "usage",
                "turnId": self.turn_id,
                "usage": self.usage,
            }]

        if method == "item/plan/delta":
            delta = str(params.get("delta") or "").strip()
            if delta:
                return [self._status("running", f"codex app-server plan: {delta[:200]}")]
            return []

        if method == "model/rerouted":
            return [self._status("running", "codex app-server rerouted model")]

        if method in ("warning", "guardianWarning", "deprecationNotice", "configWarning"):
            message_text = str(params.get("message") or params.get("warning") or method)
            return [self._status("running", message_text)]

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
                    "code": _codex_error_code(error),
                    "retryable": _codex_error_retryable(error),
                }]
            return [self._status("complete", "codex app-server turn completed")]

        return []

    def final_event(self) -> dict[str, Any]:
        event: dict[str, Any] = {
            "schemaVersion": SCHEMA_VERSION,
            "type": "final",
            "messageId": self.message_id,
            "turnId": self.turn_id,
            "answer": _normalize_workspace_text(self.workspace, "".join(self.answer_parts)),
            "sessionId": self.session_id or self.fallback_session_id or "codex-app-server-session",
        }
        if self.usage:
            event["usage"] = self.usage
        return event

    def _map_item(self, item: dict[str, Any], *, completed: bool) -> list[dict[str, Any]]:
        item_type = str(item.get("type") or "")
        item_id = str(item.get("id") or "")

        if item_type == "agentMessage" and completed:
            text = str(item.get("text") or "")
            if text and item_id not in self.completed_agent_message_ids:
                normalized = _normalize_workspace_text(self.workspace, text)
                streamed_text = self.streamed_agent_message_text.get(item_id, "")
                delta = normalized
                if streamed_text:
                    delta = normalized[len(streamed_text):] if normalized.startswith(streamed_text) else ""
                if not delta:
                    self.completed_agent_message_ids.add(item_id)
                    return []
                self.completed_agent_message_ids.add(item_id)
                self.answer_parts.append(delta)
                return [{
                    "schemaVersion": SCHEMA_VERSION,
                    "type": "text_delta",
                    "messageId": self.message_id,
                    "turnId": self.turn_id,
                    "delta": delta,
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
            aggregated_output = str(item.get("aggregatedOutput") or "")
            if not aggregated_output:
                aggregated_output = "".join(self.command_output_parts.get(item_id, []))
            event: dict[str, Any] = {
                "schemaVersion": SCHEMA_VERSION,
                "type": "tool_result",
                "id": item_id,
                "name": tool_name,
                "success": status == "completed" and (normalized_exit_code in (None, 0)),
                "output": _normalize_workspace_text(self.workspace, aggregated_output),
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
            output = "\n".join(f"{change.get('kind')} {change.get('path')}" for change in changes)
            if not output:
                output = "".join(self.file_change_output_parts.get(item_id, []))
            return [{
                "schemaVersion": SCHEMA_VERSION,
                "type": "tool_result",
                "id": item_id,
                "name": "file_change",
                "success": str(item.get("status") or "") == "completed",
                "output": output,
                "messageId": f"codex_app_tool_result_{item_id}",
            }]

        if item_type == "mcpToolCall" and not completed:
            server = str(item.get("server") or "mcp")
            tool = str(item.get("tool") or "tool")
            return [{
                "schemaVersion": SCHEMA_VERSION,
                "type": "tool_call",
                "id": item_id,
                "name": f"{server}.{tool}",
                "args": item.get("arguments") if isinstance(item.get("arguments"), dict) else {},
                "messageId": f"codex_app_tool_{item_id}",
            }]

        if item_type == "mcpToolCall" and completed:
            server = str(item.get("server") or "mcp")
            tool = str(item.get("tool") or "tool")
            error = item.get("error") if isinstance(item.get("error"), dict) else None
            result = item.get("result")
            return [{
                "schemaVersion": SCHEMA_VERSION,
                "type": "tool_result",
                "id": item_id,
                "name": f"{server}.{tool}",
                "success": error is None and str(item.get("status") or "") not in {"failed", "error"},
                "output": _stringify_tool_output(result if error is None else error),
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
    control_queue: ControlQueue | None = None,
) -> None:
    env = dict(env or os.environ)
    config = config or config_from_env(env)
    workspace = validate_workspace_path(request.workspace, env)
    persistent_codex_home = _persistent_app_server_home_enabled(env)
    codex_home = _create_persistent_app_server_home(config, request) if persistent_codex_home else _create_codex_home(config, request.turn_id)
    stderr_tail = _Tail(MAX_STDERR_TAIL_CHARS)
    room_context_broker = start_room_context_broker(env, request.turn_id)

    emitter.emit({
        "type": "status",
        "turnId": request.turn_id,
        "status": "starting",
        "message": "codex_app_server starting",
    })

    process: Any | None = None
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

        try:
            mapper = CodexAppServerJsonRpcMapper(
                turn_id=request.turn_id,
                message_id=f"codex_app_{request.turn_id}",
                workspace=workspace,
                fallback_session_id=request.session_id,
            )
            _drive_app_server(process, request, mapper, emitter, env, workspace, config, codex_home, control_queue=control_queue)
            exit_code = _stop_app_server(process)
        finally:
            stderr_thread.join(timeout=1)

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
        room_context_broker.close()
        if process is not None and getattr(process, "returncode", None) is None:
            _terminate_process(process)
        if persistent_codex_home and not config.keep_codex_home:
            _remove_app_server_sensitive_files(codex_home)
        elif not config.keep_codex_home:
            shutil.rmtree(codex_home, ignore_errors=True)


def parse_app_server_request(line: str) -> RunnerRequest | CodexThreadQueryRequest:
    try:
        raw = json.loads(line)
    except json.JSONDecodeError as exc:
        raise RunnerError(f"Invalid JSON request: {exc.msg}", code="invalid_json") from exc
    if not isinstance(raw, dict):
        raise RunnerError("Runner request must be a JSON object", code="invalid_request")
    if raw.get("schemaVersion") != SCHEMA_VERSION:
        raise RunnerError(f"Unsupported schemaVersion: {raw.get('schemaVersion')}", code="unsupported_schema")

    request_type = raw.get("type")
    if request_type == "run":
        return parse_request(line)
    if request_type in ("thread_list", "thread_read"):
        return _parse_thread_query_request(raw)
    raise RunnerError(f"Unsupported request type: {request_type}", code="unsupported_type")


def _parse_thread_query_request(raw: dict[str, Any]) -> CodexThreadQueryRequest:
    def string_field(key: str) -> str:
        value = raw.get(key)
        if not isinstance(value, str) or not value.strip():
            raise RunnerError(f"Expected non-empty string field {key!r}", code="invalid_request")
        return value.strip()

    limit_raw = raw.get("limit")
    limit = limit_raw if isinstance(limit_raw, int) and limit_raw > 0 else None
    if limit is not None:
        limit = min(limit, 100)

    thread_id = raw.get("threadId")
    request_type = string_field("type")
    if request_type == "thread_read" and (not isinstance(thread_id, str) or not thread_id.strip()):
        raise RunnerError("Expected non-empty string field 'threadId'", code="invalid_request")

    client_id = raw.get("clientId")
    cursor = raw.get("cursor")
    search_term = raw.get("searchTerm")
    return CodexThreadQueryRequest(
        type=request_type,
        room_id=string_field("roomId"),
        client_id=client_id.strip() if isinstance(client_id, str) and client_id.strip() else None,
        workspace=Path(string_field("workspace")),
        cursor=cursor if isinstance(cursor, str) and cursor else None,
        limit=limit,
        search_term=search_term.strip() if isinstance(search_term, str) and search_term.strip() else None,
        thread_id=thread_id.strip() if isinstance(thread_id, str) and thread_id.strip() else None,
        include_turns=raw.get("includeTurns") is True,
    )


def run_thread_query_request(
    request: CodexThreadQueryRequest,
    *,
    emitter: EventEmitter,
    config: CodexCliRunConfig | None = None,
    popen_factory: Callable[..., subprocess.Popen] = subprocess.Popen,
    env: dict[str, str] | None = None,
) -> None:
    env = dict(env or os.environ)
    config = config or config_from_env(env)
    workspace = validate_workspace_path(request.workspace, env)
    codex_home = _create_persistent_app_server_home(config, request)
    stderr_tail = _Tail(MAX_STDERR_TAIL_CHARS)
    process: Any | None = None
    try:
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

        try:
            _drive_app_server_thread_query(process, request, emitter, config, codex_home, workspace)
            exit_code = _stop_app_server(process)
        finally:
            stderr_thread.join(timeout=1)

        refreshed_auth = codex_home / "auth.json"
        if refreshed_auth.exists() and config.refreshed_auth_json_path:
            _write_private_file(config.refreshed_auth_json_path, refreshed_auth.read_text(encoding="utf-8"))

        if exit_code not in (0, None):
            tail = stderr_tail.value()
            message = f"Codex app-server exited with code {exit_code}"
            if tail:
                message = f"{message}: {tail}"
            raise RunnerError(message, code="codex_app_server_exit")
    finally:
        if process is not None and getattr(process, "returncode", None) is None:
            _terminate_process(process)
        if not config.keep_codex_home:
            _remove_app_server_sensitive_files(codex_home)


def _drive_app_server(
    process: Any,
    request: RunnerRequest,
    mapper: CodexAppServerJsonRpcMapper,
    emitter: EventEmitter,
    env: dict[str, str],
    workspace: Path,
    config: CodexCliRunConfig,
    codex_home: Path,
    control_queue: ControlQueue | None = None,
) -> None:
    if process.stdin is None or process.stdout is None:
        raise RunnerError("Codex app-server did not expose stdio", code="codex_app_server_process_error", turn_id=request.turn_id)

    next_id = 0
    send_lock = threading.Lock()
    state = _AppServerRunState(roomtalk_turn_id=request.turn_id)

    def send(method: str, params: dict[str, Any] | None = None, *, request_id: int | None = None) -> int | None:
        nonlocal next_id
        with send_lock:
            payload: dict[str, Any] = {"method": method, "params": params or {}}
            if request_id is not None:
                payload["id"] = request_id
            elif method != "initialized":
                payload["id"] = next_id
                next_id += 1
            process.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
            process.stdin.flush()
        return payload.get("id") if isinstance(payload.get("id"), int) else None

    def write_response(payload: dict[str, Any]) -> None:
        with send_lock:
            process.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
            process.stdin.flush()

    control_thread = _start_control_dispatch_thread(control_queue, send, write_response, state, emitter) if control_queue else None

    initialize_id = send("initialize", {
        "clientInfo": APP_SERVER_CLIENT_INFO,
        "capabilities": {
            "experimentalApi": True,
        },
    })
    send("initialized", {})
    thread_open_method = "thread/resume" if request.session_id else "thread/start"
    thread_open_id = send(thread_open_method, _thread_open_params(thread_open_method, request, env, workspace))
    turn_start_id: int | None = None
    turn_completed = False

    try:
        for line_number, line in enumerate(process.stdout, start=1):
            if not line.strip():
                continue
            message = _parse_json_rpc_line(line, line_number, request.turn_id)

            if _is_server_request(message):
                _respond_to_server_request(
                    process,
                    message,
                    config=config,
                    codex_home=codex_home,
                    request=request,
                    emitter=emitter,
                    state=state,
                    send_lock=send_lock,
                )
                continue

            if "id" in message:
                if message.get("error"):
                    if message.get("id") == thread_open_id and thread_open_method == "thread/resume":
                        for mapped in [mapper._status("running", "codex app-server resume failed; starting a new thread")]:
                            emitter.emit(mapped)
                        thread_open_method = "thread/start"
                        thread_open_id = send("thread/start", _thread_start_params(request, env, workspace))
                        continue
                    error = message.get("error") if isinstance(message.get("error"), dict) else {}
                    raise RunnerError(
                        str(error.get("message") or f"Codex app-server request {message.get('id')} failed"),
                        code="codex_app_server_rpc_error",
                        turn_id=request.turn_id,
                    )
                if message.get("id") == initialize_id:
                    continue
                if message.get("id") == thread_open_id:
                    thread_id = _read_nested_string(message, "result", "thread", "id")
                    if not thread_id:
                        raise RunnerError(f"Codex app-server {thread_open_method} response did not include thread.id", code="codex_app_server_protocol_error", turn_id=request.turn_id)
                    mapper.session_id = thread_id
                    state.set_thread_id(thread_id)
                    turn_start_id = send("turn/start", _turn_start_params(request, env, workspace, thread_id))
                    continue
                if message.get("id") == turn_start_id:
                    app_turn_id = _read_nested_string(message, "result", "turn", "id")
                    if app_turn_id:
                        state.set_turn_id(app_turn_id)
                    continue
                continue

            if "id" not in message and isinstance(message.get("method"), str):
                method = str(message.get("method") or "")
                params = message.get("params") if isinstance(message.get("params"), dict) else {}
                if method == "thread/started":
                    thread_id = _read_nested_string(params, "thread", "id") or _read_string(params, "threadId")
                    if thread_id:
                        state.set_thread_id(thread_id)
                elif method == "turn/started":
                    app_turn_id = _read_nested_string(params, "turn", "id") or _read_string(params, "turnId")
                    if app_turn_id:
                        state.set_turn_id(app_turn_id)
                for mapped in mapper.map_notification(message):
                    emitter.emit(mapped)
                    if mapped.get("type") == "error":
                        raise RunnerError(str(mapped.get("message") or "Codex app-server turn failed"), code="codex_app_server_error", turn_id=request.turn_id)
                if message.get("method") == "turn/completed":
                    turn_completed = True
                    break
    finally:
        state.stop()
        if control_thread is not None:
            control_thread.join(timeout=1)

    if not turn_completed:
        raise RunnerError("Codex app-server exited before turn/completed", code="codex_app_server_missing_completion", turn_id=request.turn_id)

    emitter.emit(mapper.final_event())


def _drive_app_server_thread_query(
    process: Any,
    request: CodexThreadQueryRequest,
    emitter: EventEmitter,
    config: CodexCliRunConfig,
    codex_home: Path,
    workspace: Path,
) -> None:
    if process.stdin is None or process.stdout is None:
        raise RunnerError("Codex app-server did not expose stdio", code="codex_app_server_process_error")

    next_id = 0

    def send(method: str, params: dict[str, Any] | None = None) -> int | None:
        nonlocal next_id
        payload: dict[str, Any] = {"method": method, "params": params or {}}
        if method != "initialized":
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
    query_method = "thread/list" if request.type == "thread_list" else "thread/read"
    query_id = send(query_method, _thread_query_params(request, workspace))

    for line_number, line in enumerate(process.stdout, start=1):
        if not line.strip():
            continue
        message = _parse_json_rpc_line(line, line_number, None)
        if _is_server_request(message):
            _respond_to_server_request(process, message, config=config, codex_home=codex_home)
            continue
        if "id" not in message:
            continue
        if message.get("id") == initialize_id:
            if message.get("error"):
                error = message.get("error") if isinstance(message.get("error"), dict) else {}
                raise RunnerError(str(error.get("message") or "Codex app-server initialize failed"), code="codex_app_server_rpc_error")
            continue
        if message.get("id") != query_id:
            continue
        if message.get("error"):
            error = message.get("error") if isinstance(message.get("error"), dict) else {}
            raise RunnerError(str(error.get("message") or f"Codex app-server {query_method} failed"), code="codex_app_server_rpc_error")
        result = message.get("result") if isinstance(message.get("result"), dict) else {}
        if request.type == "thread_list":
            emitter.emit({
                "schemaVersion": SCHEMA_VERSION,
                "type": "thread_list_result",
                "roomId": request.room_id,
                "threads": result.get("data") if isinstance(result.get("data"), list) else [],
                "nextCursor": result.get("nextCursor") if isinstance(result.get("nextCursor"), str) else None,
                "backwardsCursor": result.get("backwardsCursor") if isinstance(result.get("backwardsCursor"), str) else None,
            })
            return
        thread = result.get("thread")
        emitter.emit({
            "schemaVersion": SCHEMA_VERSION,
            "type": "thread_read_result",
            "roomId": request.room_id,
            "thread": thread if isinstance(thread, dict) else {},
        })
        return

    raise RunnerError(f"Codex app-server exited before {query_method} response", code="codex_app_server_missing_query_response")


def _thread_query_params(request: CodexThreadQueryRequest, workspace: Path) -> dict[str, Any]:
    if request.type == "thread_read":
        return {
            "threadId": request.thread_id,
            "includeTurns": request.include_turns,
        }
    params: dict[str, Any] = {
        "limit": request.limit or 25,
        "sortKey": "updated_at",
        "sortDirection": "desc",
        "cwd": str(workspace),
        "archived": False,
    }
    if request.cursor:
        params["cursor"] = request.cursor
    if request.search_term:
        params["searchTerm"] = request.search_term
    return params


def _persistent_app_server_home_enabled(env: dict[str, str]) -> bool:
    return env.get("ROOMTALK_CODEX_APP_SERVER_PERSIST_HOME", "true").lower() != "false"


def _create_persistent_app_server_home(config: CodexCliRunConfig, request: RunnerRequest | CodexThreadQueryRequest) -> Path:
    safe_room_id = _safe_path_part(request.room_id or "room")
    path = config.secret_parent / f"app-server-{safe_room_id}"
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    path.chmod(0o700)
    return path


def _remove_app_server_sensitive_files(codex_home: Path) -> None:
    for name in ("auth.json", "config.toml"):
        try:
            (codex_home / name).unlink()
        except FileNotFoundError:
            pass
        except Exception:
            pass


def _safe_path_part(value: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch in ("-", "_", ".") else "_" for ch in value)
    return safe[:80] or "room"


def _thread_open_params(method: str, request: RunnerRequest, env: dict[str, str], workspace: Path) -> dict[str, Any]:
    if method == "thread/resume":
        return _thread_resume_params(request, env, workspace)
    return _thread_start_params(request, env, workspace)


def _thread_start_params(request: RunnerRequest, env: dict[str, str], workspace: Path) -> dict[str, Any]:
    permission = _codex_app_server_permissions(request)
    return {
        "model": _normalize_codex_model(request.codex_model),
        "cwd": str(workspace),
        "ephemeral": False,
        **_thread_permission_params(request, env, permission.sandbox),
        "approvalPolicy": permission.approval_policy,
        "serviceTier": _normalize_codex_service_tier(request.codex_service_tier),
    }


def _thread_resume_params(request: RunnerRequest, env: dict[str, str], workspace: Path) -> dict[str, Any]:
    permission = _codex_app_server_permissions(request)
    return {
        "threadId": request.session_id,
        "model": _normalize_codex_model(request.codex_model),
        "cwd": str(workspace),
        **_thread_permission_params(request, env, permission.sandbox),
        "approvalPolicy": permission.approval_policy,
        "serviceTier": _normalize_codex_service_tier(request.codex_service_tier),
    }


def _turn_start_params(request: RunnerRequest, env: dict[str, str], workspace: Path, thread_id: str) -> dict[str, Any]:
    permission = _codex_app_server_permissions(request)
    params = {
        "threadId": thread_id,
        "input": [{"type": "text", "text": _prompt_with_app_server_tools(request, env)}],
        "cwd": str(workspace),
        "model": _normalize_codex_model(request.codex_model),
        "effort": _normalize_codex_reasoning_effort(request.codex_reasoning_effort),
        "serviceTier": _normalize_codex_service_tier(request.codex_service_tier),
        "approvalPolicy": permission.approval_policy,
    }
    room_context_profile = _codex_room_context_permission_profile(request, env)
    if room_context_profile:
        params["permissions"] = room_context_profile
    else:
        params["sandboxPolicy"] = _sandbox_policy_for_permission(permission.sandbox, workspace)
    return params


def _thread_permission_params(request: RunnerRequest, env: dict[str, str], sandbox: str) -> dict[str, str]:
    room_context_profile = _codex_room_context_permission_profile(request, env)
    if room_context_profile:
        return {"permissions": room_context_profile}
    return {"sandbox": sandbox}


def _sandbox_policy_for_permission(
    sandbox: str,
    workspace: Path,
    *,
    allow_read_only_network: bool = False,
) -> dict[str, Any]:
    if sandbox == "read-only":
        return {"type": "readOnly", "networkAccess": allow_read_only_network}
    if sandbox == "danger-full-access":
        return {"type": "dangerFullAccess"}
    return {
        "type": "workspaceWrite",
        "networkAccess": True,
        "writableRoots": [str(workspace)],
    }


def _codex_app_server_permissions(request: RunnerRequest):
    permission = _codex_exec_permissions(request)
    if permission.mode == "edit":
        return replace(permission, approval_policy="on-request")
    return permission


def _prompt_with_app_server_tools(request: RunnerRequest, env: dict[str, str]) -> str:
    from .codex_cli import _prompt_with_roomtalk_tools

    return _prompt_with_roomtalk_tools(request, env)


def _parse_json_rpc_line(line: str, line_number: int, turn_id: str | None) -> dict[str, Any]:
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


def _start_control_dispatch_thread(
    control_queue: ControlQueue,
    send: Callable[[str, dict[str, Any] | None], int | None],
    write_response: Callable[[dict[str, Any]], None],
    state: _AppServerRunState,
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
                    send("turn/interrupt", {"threadId": thread_id, "turnId": app_turn_id})
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
                    send("turn/steer", {
                        "threadId": thread_id,
                        "expectedTurnId": app_turn_id,
                        "input": [{"type": "text", "text": prompt.strip(), "text_elements": []}],
                    })
                    emitter.emit(_control_status(state.roomtalk_turn_id, "running", "Codex steer sent"))
                elif control_type == "approval_response":
                    approval_id = control.get("approvalId")
                    decision = control.get("decision")
                    if not isinstance(approval_id, str) or not isinstance(decision, str):
                        continue
                    pending = state.pop_pending_approval(approval_id)
                    if not pending:
                        emitter.emit(_approval_result_event(approval_id, decision, success=False, output="Approval request is no longer pending."))
                        continue
                    write_response({"id": pending.json_rpc_id, "result": _approval_response_result(pending, decision)})
                    emitter.emit(_approval_result_event(approval_id, decision, success=decision in ("accept", "acceptForSession")))
            except Exception as exc:
                emitter.emit({
                    "schemaVersion": SCHEMA_VERSION,
                    "type": "error",
                    "turnId": state.roomtalk_turn_id,
                    "message": str(exc),
                    "code": "codex_app_server_control_error",
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


def _is_interactive_approval_method(method: str) -> bool:
    return method in {
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
        "execCommandApproval",
        "applyPatchApproval",
    }


def _pending_approval_from_request(message: dict[str, Any]) -> _PendingApproval:
    method = str(message.get("method") or "")
    params = message.get("params") if isinstance(message.get("params"), dict) else {}
    message_id = message.get("id")
    approval_id = _first_string(
        params.get("approvalId"),
        params.get("itemId"),
        params.get("callId"),
        str(message_id) if message_id is not None else None,
    ) or "approval"
    if approval_id in ("None", "null"):
        approval_id = str(message_id) if message_id is not None else "approval"
    return _PendingApproval(
        approval_id=approval_id,
        json_rpc_id=message_id if isinstance(message_id, (int, str)) else approval_id,
        method=method,
        params=params,
        started_at_ms=int(params.get("startedAtMs") if isinstance(params.get("startedAtMs"), int) else time.time() * 1000),
    )


def _approval_request_event(turn_id: str, pending: _PendingApproval) -> dict[str, Any]:
    params = pending.params
    approval_type = _approval_type_for_method(pending.method)
    title = _approval_title_for_method(pending.method)
    reason = _first_string(params.get("reason"))
    command = params.get("command")
    if isinstance(command, list):
        command = " ".join(str(item) for item in command)
    args: dict[str, Any] = {
        "approvalId": pending.approval_id,
        "approvalType": approval_type,
        "requestMethod": pending.method,
        "startedAtMs": pending.started_at_ms,
    }
    for key in ("threadId", "turnId", "itemId", "callId", "cwd", "grantRoot", "environmentId"):
        if key in params:
            args[key] = params[key]
    if command:
        args["command"] = str(command)
    if reason:
        args["reason"] = reason
    if pending.method == "item/fileChange/requestApproval":
        args["changes"] = params.get("changes") if isinstance(params.get("changes"), list) else []
    if pending.method == "item/permissions/requestApproval":
        args["permissions"] = params.get("permissions") if isinstance(params.get("permissions"), dict) else {}
    if pending.method == "applyPatchApproval":
        args["fileChanges"] = params.get("fileChanges") if isinstance(params.get("fileChanges"), dict) else {}
    event: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "type": "approval_request",
        "turnId": turn_id,
        "id": pending.approval_id,
        "approvalId": pending.approval_id,
        "approvalType": approval_type,
        "title": title,
        "message": reason,
        "args": args,
        "messageId": f"codex_app_approval_{pending.approval_id}",
    }
    if command:
        event["command"] = str(command)
    if "cwd" in args:
        event["cwd"] = args["cwd"]
    if "changes" in args:
        event["changes"] = args["changes"]
    return event


def _approval_type_for_method(method: str) -> str:
    if method == "item/commandExecution/requestApproval":
        return "command"
    if method == "item/fileChange/requestApproval":
        return "file_change"
    if method == "item/permissions/requestApproval":
        return "permissions"
    if method == "execCommandApproval":
        return "exec_command"
    return "apply_patch"


def _approval_title_for_method(method: str) -> str:
    if method in ("item/commandExecution/requestApproval", "execCommandApproval"):
        return "Codex wants to run a command"
    if method in ("item/fileChange/requestApproval", "applyPatchApproval"):
        return "Codex wants to change files"
    return "Codex requests additional permissions"


def _approval_response_result(pending: _PendingApproval, decision: str) -> dict[str, Any]:
    if pending.method == "item/permissions/requestApproval":
        if decision in ("accept", "acceptForSession"):
            permissions = pending.params.get("permissions") if isinstance(pending.params.get("permissions"), dict) else {}
            return {
                "permissions": permissions,
                "scope": "session" if decision == "acceptForSession" else "turn",
                "strictAutoReview": True,
            }
        return {
            "permissions": {},
            "scope": "turn",
            "strictAutoReview": True,
        }

    if pending.method in ("execCommandApproval", "applyPatchApproval"):
        legacy_decision = {
            "accept": "approved",
            "acceptForSession": "approved_for_session",
            "decline": "denied",
            "cancel": "abort",
        }.get(decision, "denied")
        return {"decision": legacy_decision}

    normalized_decision = decision if decision in ("accept", "acceptForSession", "decline", "cancel") else "decline"
    return {"decision": normalized_decision}


def _approval_result_event(
    approval_id: str,
    decision: str,
    *,
    success: bool,
    output: str | None = None,
) -> dict[str, Any]:
    if output is None:
        output = "Approved." if success else ("Cancelled." if decision == "cancel" else "Declined.")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "type": "tool_result",
        "id": approval_id,
        "name": "approval_request",
        "success": success,
        "output": output,
        "messageId": f"codex_app_approval_result_{approval_id}",
    }


def _respond_to_server_request(
    process: Any,
    message: dict[str, Any],
    *,
    config: CodexCliRunConfig,
    codex_home: Path,
    request: RunnerRequest | None = None,
    emitter: EventEmitter | None = None,
    state: _AppServerRunState | None = None,
    send_lock: threading.Lock | None = None,
) -> None:
    method = str(message.get("method") or "")
    if (
        request is not None
        and emitter is not None
        and state is not None
        and _is_interactive_approval_method(method)
        and _codex_app_server_permissions(request).approval_policy == "on-request"
    ):
        pending = _pending_approval_from_request(message)
        state.add_pending_approval(pending)
        emitter.emit(_approval_request_event(request.turn_id, pending))
        return

    if method in ("item/commandExecution/requestApproval", "item/fileChange/requestApproval"):
        result: dict[str, Any] = {"decision": "decline"}
    elif method == "item/permissions/requestApproval":
        result = {
            "permissions": {},
            "scope": "turn",
            "strictAutoReview": True,
        }
    elif method in ("execCommandApproval", "applyPatchApproval"):
        result = {"decision": "denied"}
    elif method == "item/tool/requestUserInput":
        result = {"answers": {}}
    elif method == "mcpServer/elicitation/request":
        result = {"action": "decline", "content": None, "_meta": None}
    elif method == "account/chatgptAuthTokens/refresh":
        try:
            result = _chatgpt_auth_tokens_refresh_result(config, codex_home)
        except RunnerError as exc:
            _write_json_rpc_response(process, {"id": message["id"], "error": {"code": -32010, "message": str(exc)}}, send_lock=send_lock)
            return
    else:
        _write_json_rpc_response(process, {"id": message["id"], "error": {"code": -32601, "message": f"Unsupported server request in RoomTalk non-interactive runner: {method}"}}, send_lock=send_lock)
        return
    _write_json_rpc_response(process, {"id": message["id"], "result": result}, send_lock=send_lock)


def _write_json_rpc_response(process: Any, payload: dict[str, Any], *, send_lock: threading.Lock | None = None) -> None:
    if send_lock is None:
        process.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
        process.stdin.flush()
        return
    with send_lock:
        process.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
        process.stdin.flush()




def _chatgpt_auth_tokens_refresh_result(config: CodexCliRunConfig, codex_home: Path) -> dict[str, Any]:
    auth_path = codex_home / "auth.json"
    if not auth_path.exists() and config.auth_json_path:
        auth_path = config.auth_json_path
    parsed = _read_json_object(auth_path)
    tokens = _auth_tokens_object(parsed)
    access_token = _first_string(tokens.get("access_token"), tokens.get("accessToken"), parsed.get("access_token"), parsed.get("accessToken"))
    id_claims = _decode_jwt_payload(_first_string(tokens.get("id_token"), tokens.get("idToken"), parsed.get("id_token"), parsed.get("idToken")))
    access_claims = _decode_jwt_payload(access_token)
    auth_claim = _object_value(id_claims.get("https://api.openai.com/auth")) or _object_value(access_claims.get("https://api.openai.com/auth")) or {}
    account_id = _first_string(
        tokens.get("account_id"),
        tokens.get("accountId"),
        parsed.get("account_id"),
        parsed.get("accountId"),
        auth_claim.get("chatgpt_account_id"),
    )
    plan_type = _first_string(auth_claim.get("chatgpt_plan_type"), parsed.get("plan_type"), parsed.get("planType"))
    if not access_token or not account_id:
        raise RunnerError("Codex app-server requested ChatGPT auth refresh, but auth.json did not include an access token and account id", code="codex_app_server_auth_refresh_unavailable")
    return {
        "accessToken": access_token,
        "chatgptAccountId": account_id,
        "chatgptPlanType": plan_type,
    }


def _read_json_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RunnerError("Codex auth JSON is not readable", code="codex_auth_unreadable") from exc
    if not isinstance(value, dict):
        raise RunnerError("Codex auth JSON must be an object", code="codex_auth_invalid")
    return value


def _auth_tokens_object(parsed: dict[str, Any]) -> dict[str, Any]:
    openai_auth = _object_value(parsed.get("OPENAI_AUTH")) or _object_value(parsed.get("openaiAuth")) or {}
    return _object_value(parsed.get("tokens")) or _object_value(openai_auth.get("tokens")) or openai_auth or parsed


def _object_value(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _first_string(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str) and value:
            return value
    return None


def _decode_jwt_payload(token: str | None) -> dict[str, Any]:
    if not token or token.count(".") < 2:
        return {}
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(payload.encode("ascii")).decode("utf-8"))
        return decoded if isinstance(decoded, dict) else {}
    except Exception:
        return {}


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


def _to_runner_usage(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    last = value.get("last") if isinstance(value.get("last"), dict) else None
    total = value.get("total") if isinstance(value.get("total"), dict) else None
    usage = last or total
    if not usage:
        return None
    input_tokens = usage.get("inputTokens")
    output_tokens = usage.get("outputTokens")
    total_tokens = usage.get("totalTokens")
    if not isinstance(input_tokens, int) or not isinstance(output_tokens, int) or not isinstance(total_tokens, int):
        return None
    result: dict[str, Any] = {
        "promptTokens": input_tokens,
        "completionTokens": output_tokens,
        "totalTokens": total_tokens,
        "source": "reported",
    }
    cached = usage.get("cachedInputTokens")
    if isinstance(cached, int):
        result["cachedPromptTokens"] = cached
        result["cacheHitRate"] = cached / input_tokens if input_tokens > 0 else 0
    model_context_window = value.get("modelContextWindow")
    if isinstance(model_context_window, int) and model_context_window > 0:
        result["modelContextWindow"] = model_context_window
    return result


def _codex_error_code(error: Any) -> str:
    if not isinstance(error, dict):
        return "codex_app_server_error"
    info = error.get("info") or error.get("code") or error.get("type")
    if isinstance(info, str) and info:
        return f"codex_app_server_{info}"
    if isinstance(info, dict) and info:
        first_key = next(iter(info))
        return f"codex_app_server_{first_key}"
    return "codex_app_server_error"


def _codex_error_retryable(error: Any) -> bool:
    if not isinstance(error, dict):
        return False
    text = json.dumps(error, ensure_ascii=False).lower()
    return "serveroverloaded" in text or "overloaded" in text or "connectionfailed" in text or "disconnected" in text


def _stringify_tool_output(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, indent=2)
    except Exception:
        return str(value)


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
