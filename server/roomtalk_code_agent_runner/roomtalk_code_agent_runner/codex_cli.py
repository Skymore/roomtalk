from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, TextIO

from .runner import (
    EventEmitter,
    RunnerError,
    RunnerRequest,
    parse_request,
    validate_workspace_path,
)
from .room_context_broker import start_room_context_broker

SCHEMA_VERSION = 1
PUBLISH_STATIC_SITE_TOOL = "PublishStaticSite"
DEFAULT_CODEX_CLI_BIN = "codex"
DEFAULT_CODEX_SECRET_PARENT = "/tmp/roomtalk-codex"
DEFAULT_CODEX_MODEL = "gpt-5.6-sol"
DEFAULT_CODEX_REASONING_EFFORT = "high"
DEFAULT_CODEX_PERMISSION_MODE = "approveForMe"
ALLOWED_CODEX_MODELS = {
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex-spark",
}
ALLOWED_CODEX_REASONING_EFFORTS = {"low", "medium", "high", "xhigh"}
ALLOWED_CODEX_PERMISSION_MODES = {"plan", "edit", "approveForMe", "fullAccess"}
MAX_STDERR_TAIL_CHARS = 4_000
ROOM_CONTEXT_PERMISSION_PROFILE = "roomtalk-room-context-read"
ROOM_CONTEXT_WORKSPACE_PERMISSION_PROFILE = "roomtalk-room-context-workspace"


@dataclass
class CodexCliRunConfig:
    cli_bin: str = DEFAULT_CODEX_CLI_BIN
    secret_parent: Path = Path(DEFAULT_CODEX_SECRET_PARENT)
    auth_json_path: Path | None = None
    refreshed_auth_json_path: Path | None = None
    auth_refresh_url: str | None = None
    auth_refresh_token: str | None = None
    auth_version: int = 0
    keep_codex_home: bool = False


@dataclass
class CodexCliEventMapper:
    turn_id: str
    message_id: str
    workspace: Path
    fallback_session_id: str | None = None
    session_id: str | None = None
    usage: dict[str, Any] | None = None
    ignored_item_types: dict[str, int] = field(default_factory=dict)
    command_tool_names: dict[str, str] = field(default_factory=dict)

    def map_event(self, event: dict[str, Any]) -> list[dict[str, Any]]:
        event_type = event.get("type")
        if event_type == "thread.started":
            thread_id = event.get("thread_id")
            if isinstance(thread_id, str) and thread_id:
                self.session_id = thread_id
            return [self._status("starting", "codex thread started")]

        if event_type == "turn.started":
            return [self._status("running", "codex turn started")]

        if event_type == "turn.completed":
            self.usage = _to_runner_usage(event.get("usage")) or self.usage
            return [self._status("complete", "codex turn completed")]

        if event_type in ("turn.failed", "error"):
            message = event.get("message") or event.get("error") or "Codex CLI turn failed"
            return [{
                "schemaVersion": SCHEMA_VERSION,
                "type": "error",
                "turnId": self.turn_id,
                "message": str(message),
                "code": "codex_cli_error",
                "retryable": False,
            }]

        item = event.get("item")
        if not isinstance(item, dict):
            return []

        item_type = item.get("type")
        item_id = str(item.get("id") or "")
        if item_type == "agent_message" and event_type == "item.completed":
            text = str(item.get("text") or "")
            return [{
                "schemaVersion": SCHEMA_VERSION,
                "type": "text_delta",
                "messageId": self.message_id,
                "turnId": self.turn_id,
                "delta": f"{_normalize_workspace_text(self.workspace, text)}\n\n",
            }]

        if item_type == "command_execution" and event_type == "item.started":
            command = str(item.get("command") or "")
            tool_name = _roomtalk_tool_name(command) or "shell"
            self.command_tool_names[item_id] = tool_name
            return [{
                "schemaVersion": SCHEMA_VERSION,
                "type": "tool_call",
                "id": item_id,
                "name": tool_name,
                "args": {"command": command},
                "messageId": f"codex_tool_{item_id}",
            }]

        if item_type == "command_execution" and event_type == "item.completed":
            exit_code = item.get("exit_code")
            normalized_exit_code = exit_code if isinstance(exit_code, int) else None
            command = str(item.get("command") or "")
            tool_name = _roomtalk_tool_name(command) or self.command_tool_names.get(item_id) or "shell"
            event_payload: dict[str, Any] = {
                "schemaVersion": SCHEMA_VERSION,
                "type": "tool_result",
                "id": item_id,
                "name": tool_name,
                "success": item.get("status") == "completed" and (normalized_exit_code in (None, 0)),
                "output": _normalize_workspace_text(self.workspace, str(item.get("aggregated_output") or "")),
                "messageId": f"codex_tool_result_{item_id}",
            }
            if normalized_exit_code is not None:
                event_payload["exitCode"] = normalized_exit_code
            return [event_payload]

        if item_type == "file_change" and event_type == "item.started":
            changes = _normalize_changes(self.workspace, item.get("changes"))
            return [{
                "schemaVersion": SCHEMA_VERSION,
                "type": "tool_call",
                "id": item_id,
                "name": "file_change",
                "args": {"changes": changes},
                "messageId": f"codex_tool_{item_id}",
            }]

        if item_type == "file_change" and event_type == "item.completed":
            changes = _normalize_changes(self.workspace, item.get("changes"))
            return [{
                "schemaVersion": SCHEMA_VERSION,
                "type": "tool_result",
                "id": item_id,
                "name": "file_change",
                "success": item.get("status") == "completed",
                "output": "\n".join(f"{change.get('kind')} {change.get('path')}" for change in changes),
                "messageId": f"codex_tool_result_{item_id}",
            }]

        if event_type in ("item.started", "item.completed") and isinstance(item_type, str):
            self.ignored_item_types[item_type] = self.ignored_item_types.get(item_type, 0) + 1
        return []

    def final_event(self, answer: str) -> dict[str, Any]:
        event: dict[str, Any] = {
            "schemaVersion": SCHEMA_VERSION,
            "type": "final",
            "messageId": self.message_id,
            "turnId": self.turn_id,
            "answer": _normalize_workspace_text(self.workspace, answer),
            "sessionId": self.session_id or self.fallback_session_id or "codex-cli-session",
        }
        if self.usage:
            event["usage"] = self.usage
        return event

    def _status(self, status: str, message: str) -> dict[str, Any]:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "type": "status",
            "turnId": self.turn_id,
            "status": status,
            "message": message,
        }


def config_from_env(env: dict[str, str] | None = None) -> CodexCliRunConfig:
    env = env or os.environ
    auth_json_path = _path_from_env(env.get("ROOMTALK_CODEX_AUTH_JSON_PATH"))
    refreshed_auth_json_path = _path_from_env(env.get("ROOMTALK_CODEX_REFRESHED_AUTH_JSON_PATH"))
    return CodexCliRunConfig(
        cli_bin=(env.get("CODEX_CLI_BIN") or DEFAULT_CODEX_CLI_BIN).strip() or DEFAULT_CODEX_CLI_BIN,
        secret_parent=Path(env.get("ROOMTALK_CODEX_SECRET_PARENT") or DEFAULT_CODEX_SECRET_PARENT),
        auth_json_path=auth_json_path,
        refreshed_auth_json_path=refreshed_auth_json_path,
        auth_refresh_url=(env.get("ROOMTALK_CODEX_AUTH_REFRESH_URL") or "").strip() or None,
        auth_refresh_token=(env.get("ROOMTALK_CODEX_AUTH_REFRESH_TOKEN") or "").strip() or None,
        auth_version=_non_negative_int(env.get("ROOMTALK_CODEX_AUTH_VERSION")),
        keep_codex_home=env.get("ROOMTALK_CODEX_KEEP_HOME") == "true",
    )


def run_request(
    request: RunnerRequest,
    *,
    emitter: EventEmitter,
    config: CodexCliRunConfig | None = None,
    popen_factory: Callable[..., subprocess.Popen] = subprocess.Popen,
    env: dict[str, str] | None = None,
) -> None:
    if request.images:
        raise RunnerError(
            "Image input is not supported by the deprecated Codex CLI backend; use codex-app-server",
            code="codex_cli_image_unsupported",
            turn_id=request.turn_id,
        )
    env = dict(env or os.environ)
    config = config or config_from_env(env)
    workspace = validate_workspace_path(request.workspace, env)
    codex_home = _create_codex_home(config, request.turn_id)
    last_message_path = codex_home / "last-message.txt"
    stderr_tail = _Tail(MAX_STDERR_TAIL_CHARS)
    room_context_broker = start_room_context_broker(env, request.turn_id)

    emitter.emit({
        "type": "status",
        "turnId": request.turn_id,
        "status": "starting",
        "message": "codex_cli starting",
    })

    try:
        _write_codex_config(codex_home, request, env, workspace)
        _restore_auth_json(config, codex_home)

        process = popen_factory(
            _build_codex_exec_args(config, request, env, workspace, last_message_path),
            cwd=str(workspace),
            env=_build_child_env(env, codex_home),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        stderr_thread = _start_stderr_tail_thread(process.stderr, stderr_tail)
        mapper = CodexCliEventMapper(
            turn_id=request.turn_id,
            message_id=f"codex_{request.turn_id}",
            workspace=workspace,
            fallback_session_id=request.session_id,
        )
        try:
            _consume_codex_stdout(process.stdout, mapper, emitter)
            exit_code = process.wait()
        finally:
            stderr_thread.join(timeout=1)

        refreshed_auth = codex_home / "auth.json"
        if refreshed_auth.exists() and config.refreshed_auth_json_path:
            _write_private_file(config.refreshed_auth_json_path, refreshed_auth.read_text(encoding="utf-8"))

        if exit_code != 0:
            tail = stderr_tail.value()
            message = f"Codex CLI exited with code {exit_code}"
            if tail:
                message = f"{message}: {tail}"
            raise RunnerError(message, code="codex_exit", turn_id=request.turn_id)

        if not last_message_path.exists():
            raise RunnerError("Codex CLI exited without a final answer file", code="codex_missing_final", turn_id=request.turn_id)

        emitter.emit(mapper.final_event(last_message_path.read_text(encoding="utf-8")))
    finally:
        room_context_broker.close()
        if not config.keep_codex_home:
            shutil.rmtree(codex_home, ignore_errors=True)


def _build_codex_exec_args(
    config: CodexCliRunConfig,
    request: RunnerRequest,
    env: dict[str, str],
    workspace: Path,
    last_message_path: Path,
) -> list[str]:
    model = _normalize_codex_model(request.codex_model)
    reasoning_effort = _normalize_codex_reasoning_effort(request.codex_reasoning_effort)
    service_tier = _normalize_codex_service_tier(request.codex_service_tier)
    permission = _codex_exec_permissions(request)
    args = [
        config.cli_bin,
        "exec",
        "--json",
        "--ephemeral",
        "--model",
        model,
        "-c",
        f'approval_policy="{permission.approval_policy}"',
        "-c",
        f'model_reasoning_effort="{reasoning_effort}"',
        "-c",
        f'service_tier="{service_tier}"',
    ]
    room_context_profile = _codex_room_context_permission_profile(request, env)
    if permission.sandbox == "workspace-write" and not room_context_profile:
        args.extend([
            "-c",
            "sandbox_workspace_write.network_access=true",
        ])
    if room_context_profile:
        args.extend(["-c", f'default_permissions="{room_context_profile}"'])
    else:
        args.extend(["--sandbox", permission.sandbox])
    args.extend([
        "--cd",
        str(workspace),
        "--output-last-message",
        str(last_message_path),
        _prompt_with_roomtalk_tools(request, env),
    ])
    return args


def _normalize_codex_model(value: str | None) -> str:
    if not value:
        return DEFAULT_CODEX_MODEL
    return value if value in ALLOWED_CODEX_MODELS else DEFAULT_CODEX_MODEL


def _normalize_codex_reasoning_effort(value: str | None) -> str:
    if not value:
        return DEFAULT_CODEX_REASONING_EFFORT
    return value if value in ALLOWED_CODEX_REASONING_EFFORTS else DEFAULT_CODEX_REASONING_EFFORT


def _normalize_codex_service_tier(value: str | None) -> str:
    return "priority" if value == "priority" else "default"


@dataclass(frozen=True)
class _CodexExecPermissions:
    mode: str
    sandbox: str
    approval_policy: str


def _codex_exec_permissions(request: RunnerRequest) -> _CodexExecPermissions:
    mode = _normalize_codex_permission_mode(request.codex_permission_mode, request.mode)
    if mode == "plan":
        return _CodexExecPermissions(mode=mode, sandbox="read-only", approval_policy="never")
    if mode == "edit":
        return _CodexExecPermissions(mode=mode, sandbox="workspace-write", approval_policy="never")
    if mode == "fullAccess":
        return _CodexExecPermissions(mode=mode, sandbox="danger-full-access", approval_policy="never")
    return _CodexExecPermissions(mode="approveForMe", sandbox="workspace-write", approval_policy="never")


def _normalize_codex_permission_mode(value: str | None, runner_mode: str) -> str:
    if runner_mode == "plan":
        return "plan"
    if not value:
        return DEFAULT_CODEX_PERMISSION_MODE
    return value if value in ALLOWED_CODEX_PERMISSION_MODES else DEFAULT_CODEX_PERMISSION_MODE


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


def _consume_codex_stdout(stream: Any, mapper: CodexCliEventMapper, emitter: EventEmitter) -> None:
    if stream is None:
        raise RunnerError("Codex CLI did not expose stdout", code="codex_process_error", turn_id=mapper.turn_id)
    for line_number, line in enumerate(stream, start=1):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError as exc:
            raise RunnerError(
                f"Invalid Codex exec JSONL at line {line_number}: {exc.msg}",
                code="codex_protocol_error",
                turn_id=mapper.turn_id,
            ) from exc
        if not isinstance(event, dict) or not isinstance(event.get("type"), str):
            raise RunnerError(
                f"Invalid Codex exec JSONL at line {line_number}: event must include a type",
                code="codex_protocol_error",
                turn_id=mapper.turn_id,
            )
        for mapped in mapper.map_event(event):
            emitter.emit(mapped)


def _create_codex_home(config: CodexCliRunConfig, turn_id: str) -> Path:
    parent = config.secret_parent
    parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=f"codex-{turn_id}-", dir=str(parent)))


def _restore_auth_json(config: CodexCliRunConfig, codex_home: Path) -> None:
    if not config.auth_json_path:
        raise RunnerError("codex_cli requires ROOMTALK_CODEX_AUTH_JSON_PATH", code="codex_missing_auth")
    auth_json = config.auth_json_path.read_text(encoding="utf-8")
    _write_private_file(codex_home / "auth.json", auth_json)


def _write_codex_config(codex_home: Path, request: RunnerRequest, env: dict[str, str], workspace: Path) -> None:
    sandbox = _codex_exec_permissions(request).sandbox
    room_context_socket = _codex_room_context_socket(env)
    room_context_profile = _codex_room_context_permission_profile(request, env)
    lines = [
        'cli_auth_credentials_store = "file"',
    ]
    if room_context_profile:
        lines.extend([f'default_permissions = "{room_context_profile}"', ""])
    else:
        lines.extend([f'sandbox_mode = "{sandbox}"', ""])
    lines.extend([
        "[shell_environment_policy]",
        'inherit = "core"',
        "ignore_default_excludes = false",
        'exclude = ["CODEX_HOME", "CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY", "*_TOKEN", "*_SECRET", "*_KEY"]',
        "",
    ])
    tool_env = _roomtalk_tool_env(request, env, workspace)
    if tool_env:
        lines.append("[shell_environment_policy.set]")
        for key in sorted(tool_env):
            lines.append(f"{key} = {_toml_string(tool_env[key])}")
        lines.append("")
    if room_context_profile and room_context_socket:
        extends = ":read-only" if room_context_profile == ROOM_CONTEXT_PERMISSION_PROFILE else ":workspace"
        lines.extend([
            f"[permissions.{room_context_profile}]",
            'description = "RoomTalk shell permissions with a turn-scoped local context broker."',
            f'extends = "{extends}"',
            "",
            f"[permissions.{room_context_profile}.network]",
            "enabled = true",
            "",
        ])
        if room_context_profile == ROOM_CONTEXT_WORKSPACE_PERMISSION_PROFILE:
            lines.extend([
                f"[permissions.{room_context_profile}.network.domains]",
                '"*" = "allow"',
                "",
            ])
        lines.extend([
            f"[permissions.{room_context_profile}.network.unix_sockets]",
            f"{_toml_string(room_context_socket)} = \"allow\"",
            "",
        ])
    trusted_projects = _trusted_project_paths(workspace, env)
    if trusted_projects:
        lines.append("[projects]")
        for project_path in trusted_projects:
            lines.extend([
                f"[projects.{_toml_string(project_path)}]",
                'trust_level = "trusted"',
            ])
        lines.append("")
    _write_private_file(codex_home / "config.toml", "\n".join(lines))


def _write_private_file(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    path.write_text(value, encoding="utf-8")
    path.chmod(0o600)


def _build_child_env(env: dict[str, str], codex_home: Path) -> dict[str, str]:
    child_env: dict[str, str] = {}
    for key, value in env.items():
        upper = key.upper()
        if upper in {"CODEX_HOME", "CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"}:
            continue
        if upper.endswith("_TOKEN") or upper.endswith("_SECRET") or upper.endswith("_KEY"):
            continue
        if upper.startswith("ROOMTALK_CODEX_"):
            continue
        child_env[key] = value
    child_env["CODEX_HOME"] = str(codex_home)
    return child_env


def _trusted_project_paths(workspace: Path, env: dict[str, str]) -> list[str]:
    paths: list[str] = []
    workspace_path = str(workspace)
    workspace_root = (env.get("CODE_AGENT_WORKSPACE_ROOT") or "").strip()
    if workspace_root:
        paths.append(workspace_root)
    if workspace_path == "/workspace" or workspace_path.startswith("/workspace/"):
        paths.append("/workspace")
    paths.append(workspace_path)
    return list(dict.fromkeys(paths))


def _roomtalk_tool_env(request: RunnerRequest, env: dict[str, str], workspace: Path) -> dict[str, str]:
    read_only = _codex_exec_permissions(request).mode == "plan"
    values: dict[str, str] = {
        "ROOMTALK_CODE_AGENT_ROOM_ID": request.room_id,
        "ROOMTALK_CODE_AGENT_TURN_ID": request.turn_id,
        "ROOMTALK_CODE_AGENT_CLI_ACCESS": "read-only" if read_only else "full",
        "ROOMTALK_WORKSPACE": str(workspace),
    }
    room_context_keys = (
        ("ROOMTALK_ROOM_CONTEXT_SOCKET",)
        if (env.get("ROOMTALK_ROOM_CONTEXT_SOCKET") or "").strip()
        else ("ROOMTALK_ROOM_CONTEXT_URL", "ROOMTALK_ROOM_CONTEXT_TOKEN")
    )
    read_only_keys = (
        "PYTHONPATH",
        "CODE_AGENT_WORKSPACE_ROOT",
        "ROOMTALK_GITHUB_TOKEN_PATH",
        "GIT_CONFIG_GLOBAL",
        "GIT_TERMINAL_PROMPT",
    ) + room_context_keys
    write_keys = (
        "ROOMTALK_CODE_AGENT_ENABLE_STATIC_PUBLISH",
        "ROOMTALK_STATIC_PUBLISH_URL",
        "ROOMTALK_STATIC_PUBLISH_PUBLIC_BASE_URL",
        "ROOMTALK_STATIC_PUBLISH_TOKEN",
        "ROOMTALK_E2B_PORT_HOST_TEMPLATE",
        "ROOMTALK_E2B_PORT_URL_TEMPLATE",
        "CODE_AGENT_PORT_HOST_TEMPLATE",
        "CODE_AGENT_PORT_URL_TEMPLATE",
        "ROOMTALK_CODE_AGENT_BACKGROUND_JOBS_DIR",
        "CODE_AGENT_BACKGROUND_JOBS_DIR",
    )
    for key in read_only_keys + (() if read_only else write_keys):
        value = (env.get(key) or "").strip()
        if value:
            values[key] = value
    return values


def _prompt_with_roomtalk_tools(request: RunnerRequest, env: dict[str, str]) -> str:
    permission = _codex_exec_permissions(request)
    if permission.mode == "plan":
        mode_guidance = "This RoomTalk turn is in Plan mode. Inspect and explain, but do not edit files, run mutating commands, start background services, or publish sites."
    elif permission.mode == "edit":
        mode_guidance = "This RoomTalk turn is in Edit mode. You may edit files and run commands inside the workspace. If an approval prompt blocks progress, stop and explain what approval is needed."
    elif permission.mode == "fullAccess":
        mode_guidance = "This RoomTalk turn is in Full access mode. You may use the isolated sandbox without Codex filesystem restrictions, but keep work relevant to the requested workspace."
    else:
        mode_guidance = "This RoomTalk turn is in Approve for me mode. You may edit files and run commands inside the workspace without approval prompts."

    tool_lines = [
        "RoomTalk sandbox context:",
        f"- {mode_guidance}",
        f"- Current RoomTalk room: {request.room_id}.",
        "- Keep generated files, downloaded references, and publish roots inside the current workspace.",
        "- This is a non-interactive cloud sandbox. Work within the configured sandbox permissions for this turn.",
    ]
    if _codex_room_context_enabled(env):
        tool_lines.extend([
            "- RoomTalk is the source of truth for room conversation history; the Codex thread may not include messages from before this thread or from other participants.",
            "- When prior discussion is needed, run `roomtalk room history --limit 20 --json`. Do not read the full room history by default.",
            "- To find older discussion, run `roomtalk room search --query <text> --limit 20 --json`; use `roomtalk room delta --since <message-id> --json` for messages after a known point.",
            "- To inspect sites published by this room, run `roomtalk site list --json`.",
        ])
    if _codex_static_publish_enabled(env):
        tool_lines.extend([
            "- To publish a plain static site or frontend build output, run `roomtalk site publish --root <dir> --entry index.html` after creating the site directory.",
            "- To take a site offline, run `roomtalk site unpublish --slug <slug>`. This removes the published site; it does not delete workspace files.",
            "- Use static publishing for HTML/CSS/JS sites and frontend apps that produce static build output.",
            "- Do not use static publishing for apps that require a long-running server process, database, backend API, WebSocket server, or runtime-only framework behavior.",
        ])
    return "\n".join(tool_lines) + "\n\nUser request:\n" + request.prompt


def _codex_static_publish_enabled(env: dict[str, str]) -> bool:
    return (
        env.get("ROOMTALK_CODE_AGENT_ENABLE_STATIC_PUBLISH") == "true"
        and bool((env.get("ROOMTALK_STATIC_PUBLISH_URL") or "").strip())
        and bool((env.get("ROOMTALK_STATIC_PUBLISH_TOKEN") or "").strip())
    )


def _codex_room_context_enabled(env: dict[str, str]) -> bool:
    return bool((env.get("ROOMTALK_ROOM_CONTEXT_SOCKET") or "").strip()) or (
        bool((env.get("ROOMTALK_ROOM_CONTEXT_URL") or "").strip())
        and bool((env.get("ROOMTALK_ROOM_CONTEXT_TOKEN") or "").strip())
    )


def _codex_room_context_socket(env: dict[str, str]) -> str | None:
    value = (env.get("ROOMTALK_ROOM_CONTEXT_SOCKET") or "").strip()
    if not value or not Path(value).is_absolute():
        return None
    return value


def _codex_room_context_permission_profile(request: RunnerRequest, env: dict[str, str]) -> str | None:
    if not _codex_room_context_socket(env):
        return None
    mode = _codex_exec_permissions(request).mode
    if mode == "plan":
        return ROOM_CONTEXT_PERMISSION_PROFILE
    if mode in {"edit", "approveForMe"}:
        return ROOM_CONTEXT_WORKSPACE_PERMISSION_PROFILE
    return None


def _roomtalk_tool_name(command: str) -> str | None:
    normalized = " ".join(command.split()).lower()
    if "roomtalk site list" in normalized or "platform_tools site list" in normalized:
        return "ListStaticSites"
    if "roomtalk site unpublish" in normalized or "platform_tools site unpublish" in normalized:
        return "UnpublishStaticSite"
    if (
        "roomtalk site publish" in normalized
        or "platform_tools site publish" in normalized
        or "roomtalk publish-static-site" in normalized
        or "platform_tools publish-static-site" in normalized
    ):
        return PUBLISH_STATIC_SITE_TOOL
    if "roomtalk room " in normalized or "platform_tools room " in normalized:
        return "RoomContext"
    return None


def _toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _start_stderr_tail_thread(stream: Any, tail: "_Tail") -> threading.Thread:
    def consume() -> None:
        if stream is None:
            return
        for chunk in stream:
            tail.push(str(chunk))

    thread = threading.Thread(target=consume, daemon=True)
    thread.start()
    return thread


class _Tail:
    def __init__(self, max_chars: int):
        self.max_chars = max_chars
        self._value = ""

    def push(self, value: str) -> None:
        self._value = f"{self._value}{value}"[-self.max_chars:]

    def value(self) -> str:
        return self._value.strip()


def _to_runner_usage(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    prompt_tokens = value.get("input_tokens")
    completion_tokens = value.get("output_tokens")
    if not isinstance(prompt_tokens, int) or not isinstance(completion_tokens, int):
        return None
    total_tokens = value.get("total_tokens")
    result: dict[str, Any] = {
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "totalTokens": total_tokens if isinstance(total_tokens, int) else prompt_tokens + completion_tokens,
        "source": "reported",
    }
    cached = value.get("cached_input_tokens")
    if isinstance(cached, int):
        result["cachedPromptTokens"] = cached
        result["cacheHitRate"] = cached / prompt_tokens if prompt_tokens > 0 else 0
    return result


def _normalize_changes(workspace: Path, value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    changes = []
    for item in value:
        if not isinstance(item, dict):
            continue
        change = dict(item)
        path_value = change.get("path")
        if isinstance(path_value, str):
            change["path"] = _normalize_workspace_path(workspace, path_value)
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


def _normalize_workspace_text(workspace: Path, value: str) -> str:
    prefix = str(workspace).rstrip("/") + "/"
    return value.replace(prefix, "")


def _path_from_env(value: str | None) -> Path | None:
    if not value or not value.strip():
        return None
    path = Path(value.strip())
    if not path.is_absolute():
        raise RunnerError("Codex auth paths must be absolute", code="invalid_codex_auth_path")
    return path


def _non_negative_int(value: str | None) -> int:
    try:
        return max(0, int(value or "0"))
    except ValueError:
        return 0


def _emit_error(stream: TextIO, error: Exception, turn_id: str | None = None) -> None:
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
    EventEmitter(stream).emit(event)


if __name__ == "__main__":
    raise SystemExit(main())
