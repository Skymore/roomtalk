from __future__ import annotations

import argparse
import asyncio
import base64
import json
import mimetypes
import os
import queue
import re
import shutil
import sys
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, TextIO
from urllib import request as urllib_request
from urllib.parse import urlparse

from .constants import ROOMTALK_CODE_AGENT_USER_AGENT
from .runner import (
    ControlQueue,
    EventEmitter,
    RunnerError,
    RunnerRequest,
    _emit_error,
    parse_request,
)

ACP_BACKENDS = ("opencode", "hermes-agent")
MAX_ACP_TOOL_OUTPUT_CHARS = 20_000
MAX_ACP_IMAGE_BYTES = 10 * 1024 * 1024
HARNESS_STATE_ROOT = Path("/tmp/roomtalk-harnesses")


@dataclass(frozen=True)
class ACPHarnessSpec:
    backend: str
    display_name: str
    command: str
    args: tuple[str, ...]


def harness_spec(backend: str) -> ACPHarnessSpec:
    if backend == "opencode":
        return ACPHarnessSpec(
            backend=backend,
            display_name="OpenCode",
            command="opencode",
            args=("acp",),
        )
    if backend == "hermes-agent":
        return ACPHarnessSpec(
            backend=backend,
            display_name="Hermes",
            command="hermes",
            args=("acp",),
        )
    raise RunnerError(f"Unsupported ACP harness backend: {backend}", code="unsupported_backend")


def _safe_state_segment(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip(".-")
    return normalized[:80] or "room"


def _model_gateway(env: Mapping[str, str]) -> tuple[str, str]:
    base_url = (env.get("CODE_AGENT_MODEL_PROXY_URL") or "").strip().rstrip("/")
    token = (env.get("CODE_AGENT_MODEL_PROXY_TOKEN") or "").strip()
    parsed = urlparse(base_url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise RunnerError(
            "OpenCode and Hermes require the RoomTalk HTTPS model gateway",
            code="harness_model_gateway_required",
        )
    if not token:
        raise RunnerError(
            "OpenCode and Hermes require a turn-scoped RoomTalk model gateway token",
            code="harness_model_gateway_token_missing",
        )
    return base_url, token


def opencode_config(request: RunnerRequest, base_url: str, token: str) -> dict[str, Any]:
    permission = {
        "*": "ask",
        "read": "allow",
        "glob": "allow",
        "grep": "allow",
        "list": "allow",
    }
    if request.mode == "plan":
        permission.update({"edit": "deny", "bash": "deny", "webfetch": "deny"})
    elif request.mode == "acceptEdits":
        permission.update({"edit": "allow", "bash": "ask"})
    elif request.mode == "edit":
        permission.update({"edit": "ask", "bash": "ask"})
    else:
        permission["*"] = "allow"

    return {
        "$schema": "https://opencode.ai/config.json",
        "model": f"roomtalk/{request.api_model}",
        "provider": {
            "roomtalk": {
                "npm": "@ai-sdk/openai-compatible",
                "name": "RoomTalk",
                "options": {
                    "baseURL": base_url,
                    "apiKey": token,
                },
                "models": {
                    request.api_model: {
                        "name": request.model_id,
                    },
                },
            },
        },
        "permission": permission,
    }


def hermes_config(request: RunnerRequest, base_url: str) -> dict[str, Any]:
    return {
        "model": {
            "default": request.api_model,
            "provider": "custom",
            "base_url": base_url,
        },
        "terminal": {
            "cwd": str(request.workspace),
            "env_type": "local",
        },
        "mcp_servers": {},
    }


def build_harness_env(
    backend: str,
    request: RunnerRequest,
    env: Mapping[str, str],
    *,
    state_root: Path = HARNESS_STATE_ROOT,
) -> dict[str, str]:
    base_url, token = _model_gateway(env)
    child_env = dict(env)
    room_root = state_root / _safe_state_segment(request.room_id)

    if backend == "opencode":
        opencode_root = room_root / "opencode"
        child_env.update({
            "OPENCODE_CONFIG_CONTENT": json.dumps(
                opencode_config(request, base_url, token),
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            "XDG_CACHE_HOME": str(opencode_root / "cache"),
            "XDG_CONFIG_HOME": str(opencode_root / "config"),
            "XDG_DATA_HOME": str(opencode_root / "data"),
            "XDG_STATE_HOME": str(opencode_root / "state"),
        })
        for path in ("cache", "config", "data", "state"):
            (opencode_root / path).mkdir(parents=True, exist_ok=True)
        return child_env

    if backend == "hermes-agent":
        hermes_home = room_root / "hermes"
        hermes_home.mkdir(parents=True, exist_ok=True)
        (hermes_home / "config.yaml").write_text(
            json.dumps(hermes_config(request, base_url), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        child_env.update({
            "HERMES_HOME": str(hermes_home),
            "HERMES_ACP_SKIP_CONFIGURED_MCP": "1",
            "HERMES_INFERENCE_MODEL": request.api_model,
            "HERMES_INFERENCE_PROVIDER": "custom",
            "HERMES_SESSION_SOURCE": "roomtalk",
            "OPENAI_API_KEY": token,
            "OPENAI_BASE_URL": base_url,
        })
        return child_env

    raise RunnerError(f"Unsupported ACP harness backend: {backend}", code="unsupported_backend")


def _launch_command(
    spec: ACPHarnessSpec,
    request: RunnerRequest,
    env: Mapping[str, str],
) -> tuple[str, tuple[str, ...]]:
    configured = (env.get(f"ROOMTALK_{spec.backend.upper().replace('-', '_')}_BIN") or "").strip()
    command = configured or spec.command
    args = spec.args
    if request.mode != "plan":
        return command, args

    bwrap = shutil.which("bwrap", path=env.get("PATH"))
    if not bwrap:
        raise RunnerError(
            f"{spec.display_name} plan mode requires bubblewrap for a read-only workspace",
            code="harness_plan_sandbox_unavailable",
            turn_id=request.turn_id,
        )
    workspace = str(request.workspace)
    return bwrap, (
        "--die-with-parent",
        "--bind", "/", "/",
        "--ro-bind", workspace, workspace,
        "--chdir", workspace,
        "--",
        command,
        *args,
    )


def _unwrap_session_id(value: str | None, backend: str) -> str | None:
    prefix = f"acp:{backend}:"
    if value and value.startswith(prefix) and len(value) > len(prefix):
        return value[len(prefix):]
    return None


def _wrap_session_id(value: str, backend: str) -> str:
    return f"acp:{backend}:{value}"


def _stringify(value: Any, *, limit: int = MAX_ACP_TOOL_OUTPUT_CHARS) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        text = value
    else:
        try:
            text = json.dumps(value, ensure_ascii=False, default=str)
        except Exception:
            text = str(value)
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n[truncated {len(text) - limit} characters]"


def _record(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if value is None:
        return {}
    return {"value": value}


def _content_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, list):
        return "\n".join(filter(None, (_content_text(item) for item in content)))
    content_type = getattr(content, "type", None)
    if content_type == "content":
        return _content_text(getattr(content, "content", None))
    if content_type == "diff":
        return _stringify({
            "path": getattr(content, "path", None),
            "oldText": getattr(content, "old_text", None),
            "newText": getattr(content, "new_text", None),
        })
    text = getattr(content, "text", None)
    if isinstance(text, str):
        return text
    if hasattr(content, "model_dump"):
        return _stringify(content.model_dump(by_alias=True, exclude_none=True))
    return _stringify(content)


def _tool_args(update: Any) -> dict[str, Any]:
    args = _record(getattr(update, "raw_input", None))
    kind = getattr(update, "kind", None)
    if kind:
        args.setdefault("kind", kind)
    locations = getattr(update, "locations", None)
    if locations:
        args.setdefault(
            "locations",
            [
                item.model_dump(by_alias=True, exclude_none=True)
                if hasattr(item, "model_dump")
                else _record(item)
                for item in locations
            ],
        )
    content = _content_text(getattr(update, "content", None))
    if content:
        args.setdefault("content", content)
    return args


class ACPEventBridge:
    def __init__(
        self,
        *,
        backend: str,
        request: RunnerRequest,
        emitter: EventEmitter,
    ) -> None:
        self.backend = backend
        self.request = request
        self.emitter = emitter
        self.answer_parts: list[str] = []
        self.tool_names: dict[str, str] = {}
        self.completed_tools: set[str] = set()
        self.pending_permissions: dict[str, asyncio.Future[str]] = {}
        self.connection: Any = None

    def on_connect(self, conn: Any) -> None:
        self.connection = conn

    async def session_update(self, session_id: str, update: Any, **kwargs: Any) -> None:
        del session_id, kwargs
        update_type = getattr(update, "session_update", None)
        if update_type == "agent_message_chunk":
            content = getattr(update, "content", None)
            if getattr(content, "type", None) != "text":
                return
            delta = str(getattr(content, "text", "") or "")
            self.answer_parts.append(delta)
            self.emitter.emit({
                "type": "text_delta",
                "turnId": self.request.turn_id,
                "messageId": self.request.turn_id,
                "delta": delta,
            })
            return

        if update_type == "tool_call":
            self._emit_tool_call(update)
            return

        if update_type == "tool_call_update":
            tool_call_id = str(getattr(update, "tool_call_id", "") or "")
            if not tool_call_id:
                return
            if tool_call_id not in self.tool_names:
                self._emit_tool_call(update)
            status = getattr(update, "status", None)
            if status not in {"completed", "failed"} or tool_call_id in self.completed_tools:
                return
            self.completed_tools.add(tool_call_id)
            name = self.tool_names.get(tool_call_id, str(getattr(update, "title", "") or "tool"))
            output = getattr(update, "raw_output", None)
            if output is None:
                output = _content_text(getattr(update, "content", None))
            self.emitter.emit({
                "type": "tool_result",
                "turnId": self.request.turn_id,
                "id": tool_call_id,
                "name": name,
                "success": status == "completed",
                "output": _stringify(output),
                "messageId": f"acp_tool_result_{tool_call_id}",
            })
            return

        if update_type == "usage_update":
            used = int(getattr(update, "used", 0) or 0)
            size = int(getattr(update, "size", 0) or 0)
            self.emitter.emit({
                "type": "usage",
                "turnId": self.request.turn_id,
                "usage": {
                    "promptTokens": used,
                    "completionTokens": 0,
                    "totalTokens": used,
                    "modelContextWindow": size,
                    "source": "estimated",
                },
            })

    def _emit_tool_call(self, update: Any) -> None:
        tool_call_id = str(getattr(update, "tool_call_id", "") or "")
        if not tool_call_id or tool_call_id in self.tool_names:
            return
        name = str(getattr(update, "title", "") or getattr(update, "kind", "") or "tool")
        self.tool_names[tool_call_id] = name
        self.emitter.emit({
            "type": "tool_call",
            "turnId": self.request.turn_id,
            "id": tool_call_id,
            "name": name,
            "args": _tool_args(update),
            "messageId": f"acp_tool_call_{tool_call_id}",
        })

    async def request_permission(
        self,
        options: list[Any],
        session_id: str,
        tool_call: Any,
        **kwargs: Any,
    ) -> Any:
        del session_id, kwargs
        from acp.schema import AllowedOutcome, DeniedOutcome, RequestPermissionResponse

        selected = self._automatic_permission(options, tool_call)
        if selected == "":
            return RequestPermissionResponse(outcome=DeniedOutcome(outcome="cancelled"))
        if selected is None:
            approval_id = f"acp_{uuid.uuid4().hex[:16]}"
            future = asyncio.get_running_loop().create_future()
            self.pending_permissions[approval_id] = future
            kind = str(getattr(tool_call, "kind", "") or "")
            title = str(getattr(tool_call, "title", "") or "Agent permission request")
            self.emitter.emit({
                "type": "approval_request",
                "turnId": self.request.turn_id,
                "id": approval_id,
                "approvalId": approval_id,
                "approvalType": "command" if kind == "execute" else "file_change",
                "title": title,
                "message": f"{harness_spec(self.backend).display_name} requests permission for this action.",
                "args": {
                    **_tool_args(tool_call),
                    "options": [
                        option.model_dump(by_alias=True, exclude_none=True)
                        if hasattr(option, "model_dump")
                        else _record(option)
                        for option in options
                    ],
                },
                "messageId": f"acp_approval_{approval_id}",
            })
            try:
                decision = await future
            finally:
                self.pending_permissions.pop(approval_id, None)
            selected = self._option_for_decision(options, decision)

        if not selected:
            return RequestPermissionResponse(outcome=DeniedOutcome(outcome="cancelled"))
        return RequestPermissionResponse(
            outcome=AllowedOutcome(outcome="selected", option_id=selected),
        )

    def _automatic_permission(self, options: list[Any], tool_call: Any) -> str | None:
        if self.request.mode == "plan":
            return ""
        if self.request.mode in {"approveForMe", "fullAccess"}:
            return self._allow_option(options, prefer_persistent=True)
        if self.request.mode == "acceptEdits" and getattr(tool_call, "kind", None) in {
            "edit", "delete", "move",
        }:
            return self._allow_option(options, prefer_persistent=False)
        return None

    @staticmethod
    def _allow_option(options: list[Any], *, prefer_persistent: bool) -> str | None:
        allowed = [
            option for option in options
            if str(getattr(option, "kind", "") or "").startswith("allow")
        ]
        if not allowed:
            return None
        if prefer_persistent:
            persistent = next(
                (option for option in allowed if getattr(option, "kind", None) == "allow_always"),
                None,
            )
            if persistent is not None:
                return str(persistent.option_id)
        return str(allowed[0].option_id)

    def _option_for_decision(self, options: list[Any], decision: str) -> str | None:
        if decision not in {"accept", "acceptForSession"}:
            return None
        return self._allow_option(options, prefer_persistent=decision == "acceptForSession")

    def resolve_permission(self, approval_id: str, decision: str) -> bool:
        future = self.pending_permissions.get(approval_id)
        if future is None or future.done():
            return False
        future.set_result(decision)
        return True

    async def write_text_file(self, **kwargs: Any) -> None:
        del kwargs
        raise RunnerError("ACP client filesystem writes are disabled", code="acp_client_fs_disabled")

    async def read_text_file(self, **kwargs: Any) -> None:
        del kwargs
        raise RunnerError("ACP client filesystem reads are disabled", code="acp_client_fs_disabled")

    async def create_terminal(self, **kwargs: Any) -> None:
        del kwargs
        raise RunnerError("ACP client terminals are disabled", code="acp_client_terminal_disabled")

    async def terminal_output(self, **kwargs: Any) -> None:
        del kwargs
        raise RunnerError("ACP client terminals are disabled", code="acp_client_terminal_disabled")

    async def release_terminal(self, **kwargs: Any) -> None:
        del kwargs
        raise RunnerError("ACP client terminals are disabled", code="acp_client_terminal_disabled")

    async def wait_for_terminal_exit(self, **kwargs: Any) -> None:
        del kwargs
        raise RunnerError("ACP client terminals are disabled", code="acp_client_terminal_disabled")

    async def kill_terminal(self, **kwargs: Any) -> None:
        del kwargs
        raise RunnerError("ACP client terminals are disabled", code="acp_client_terminal_disabled")

    async def ext_method(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        del method, params
        return {}

    async def ext_notification(self, method: str, params: dict[str, Any]) -> None:
        del method, params


def _emit_control_result(
    emitter: EventEmitter,
    request: RunnerRequest,
    control: Mapping[str, Any],
    *,
    accepted: bool,
    message: str | None = None,
) -> None:
    control_id = control.get("controlId")
    if not isinstance(control_id, str) or not control_id:
        return
    event: dict[str, Any] = {
        "type": "control_result",
        "turnId": request.turn_id,
        "controlId": control_id,
        "controlType": str(control.get("type") or "unknown"),
        "accepted": accepted,
    }
    if message:
        event["message"] = message
    emitter.emit(event)


async def _control_loop(
    *,
    request: RunnerRequest,
    emitter: EventEmitter,
    bridge: ACPEventBridge,
    connection: Any,
    session_id: str,
    control_queue: ControlQueue,
) -> None:
    while True:
        try:
            control = await asyncio.to_thread(control_queue.get, True, 0.1)
        except queue.Empty:
            await asyncio.sleep(0)
            continue
        if control is None:
            return
        control_type = control.get("type")
        if control.get("schemaVersion") != 1 or control.get("turnId") != request.turn_id:
            _emit_control_result(
                emitter,
                request,
                control,
                accepted=False,
                message="The target turn is no longer active",
            )
            continue
        if control_type == "interrupt":
            await connection.cancel(session_id=session_id)
            _emit_control_result(emitter, request, control, accepted=True)
            continue
        if control_type == "steer":
            _emit_control_result(
                emitter,
                request,
                control,
                accepted=False,
                message="ACP harnesses do not expose a portable live-steer capability",
            )
            continue
        if control_type == "approval_response":
            approval_id = control.get("approvalId")
            decision = control.get("decision")
            accepted = (
                isinstance(approval_id, str)
                and isinstance(decision, str)
                and bridge.resolve_permission(approval_id, decision)
            )
            _emit_control_result(
                emitter,
                request,
                control,
                accepted=accepted,
                message=None if accepted else "Approval request is no longer pending",
            )
            continue
        _emit_control_result(
            emitter,
            request,
            control,
            accepted=False,
            message="Unsupported control type",
        )


def _prior_message_text(message: Mapping[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return _stringify(content)
    parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type == "text":
            parts.append(str(block.get("text") or ""))
        elif block_type == "tool_use":
            parts.append(
                f"[tool call {block.get('name') or 'tool'}: {_stringify(block.get('input'))}]"
            )
        elif block_type == "tool_result":
            parts.append(f"[tool result: {_stringify(block.get('content'))}]")
    return "\n".join(filter(None, parts))


def _prompt_text(request: RunnerRequest, *, restored_session: bool, env: Mapping[str, str]) -> str:
    mode_guidance = {
        "plan": "This turn is read-only. Inspect and explain; do not modify workspace files.",
        "edit": "Ask for permission before commands or file changes that the harness marks as sensitive.",
        "acceptEdits": "Workspace edits are allowed; ask before sensitive commands or external side effects.",
        "approveForMe": "RoomTalk may auto-approve routine sandbox actions. Keep actions scoped to the request.",
        "fullAccess": "The isolated sandbox is fully enabled. Keep all actions relevant to the request.",
    }[request.mode]
    policy = [
        "RoomTalk orchestration policy (system-provided):",
        mode_guidance,
        "Work only in the current workspace. RoomTalk owns room permissions, turn lifecycle, and durable conversation state.",
    ]
    if env.get("ROOMTALK_ROOM_CONTEXT_SOCKET"):
        policy.append(
            "Use `roomtalk room history --limit 20 --json` or `roomtalk room search --query <text> --limit 20 --json` only when older room context is needed."
        )
    if request.prior_messages and not restored_session:
        policy.append("Recovered RoomTalk conversation context:")
        for message in request.prior_messages:
            role = str(message.get("role") or "unknown").capitalize()
            text = _prior_message_text(message)
            if text:
                policy.append(f"{role}: {text}")
    policy.extend(["User request:", request.prompt])
    return "\n\n".join(policy)


def _download_image(url: str) -> tuple[str, str]:
    request = urllib_request.Request(
        url,
        headers={"User-Agent": ROOMTALK_CODE_AGENT_USER_AGENT},
        method="GET",
    )
    with urllib_request.urlopen(request, timeout=30) as response:
        content_type = str(response.headers.get_content_type() or "")
        data = response.read(MAX_ACP_IMAGE_BYTES + 1)
    if len(data) > MAX_ACP_IMAGE_BYTES:
        raise RunnerError("ACP harness image exceeds 10 MiB", code="harness_image_too_large")
    if not content_type.startswith("image/"):
        guessed = mimetypes.guess_type(urlparse(url).path)[0] or ""
        content_type = guessed if guessed.startswith("image/") else ""
    if not content_type:
        raise RunnerError("ACP harness image has an unsupported content type", code="harness_image_invalid")
    return base64.b64encode(data).decode("ascii"), content_type


async def _prompt_blocks(request: RunnerRequest, text: str, supports_images: bool) -> list[Any]:
    from acp import image_block, text_block

    blocks: list[Any] = [text_block(text)]
    if not request.images:
        return blocks
    if not supports_images:
        raise RunnerError(
            "Selected ACP harness does not advertise image prompts",
            code="harness_images_unsupported",
            turn_id=request.turn_id,
        )
    for image in request.images:
        data, mime_type = await asyncio.to_thread(_download_image, image.url)
        blocks.append(image_block(data, mime_type, uri=image.url))
    return blocks


def _mode_ids(session_response: Any) -> set[str]:
    modes = getattr(session_response, "modes", None)
    available = getattr(modes, "available_modes", None) or []
    return {
        str(getattr(mode, "id", "") or "")
        for mode in available
        if getattr(mode, "id", None)
    }


async def _configure_session(
    *,
    backend: str,
    request: RunnerRequest,
    connection: Any,
    session_id: str,
    session_response: Any,
) -> None:
    desired_model = (
        f"roomtalk/{request.api_model}"
        if backend == "opencode"
        else f"custom:{request.api_model}"
    )
    try:
        await connection.set_session_model(session_id=session_id, model_id=desired_model)
    except Exception:
        # Both harnesses also receive the model through their isolated runtime
        # configuration, so an older ACP implementation may omit this unstable method.
        pass

    available_modes = _mode_ids(session_response)
    desired_mode: str | None = None
    if backend == "opencode":
        candidates = ("plan",) if request.mode == "plan" else ("build", "default")
    else:
        candidates = {
            "plan": ("default",),
            "edit": ("default",),
            "acceptEdits": ("accept_edits", "default"),
            "approveForMe": ("dont_ask", "accept_edits", "default"),
            "fullAccess": ("dont_ask", "accept_edits", "default"),
        }[request.mode]
    desired_mode = next((candidate for candidate in candidates if candidate in available_modes), None)
    if desired_mode:
        await connection.set_session_mode(session_id=session_id, mode_id=desired_mode)


async def _drain_stderr(stream: Any, tail: list[str]) -> None:
    if stream is None:
        return
    while True:
        line = await stream.readline()
        if not line:
            return
        tail.append(line.decode("utf-8", errors="replace").rstrip())
        del tail[:-40]


async def _run_request_async(
    backend: str,
    request: RunnerRequest,
    *,
    emitter: EventEmitter,
    env: Mapping[str, str],
    control_queue: ControlQueue,
    spawn: Callable[..., Any] | None = None,
) -> None:
    try:
        from acp import PROTOCOL_VERSION, spawn_agent_process
        from acp.schema import Implementation
    except ImportError as exc:
        raise RunnerError(
            "ACP Python SDK is not installed in the sandbox artifact",
            code="acp_sdk_missing",
            turn_id=request.turn_id,
        ) from exc

    spec = harness_spec(backend)
    child_env = build_harness_env(backend, request, env)
    command, args = _launch_command(spec, request, child_env)
    spawn_agent = spawn or spawn_agent_process
    bridge = ACPEventBridge(backend=backend, request=request, emitter=emitter)
    stderr_tail: list[str] = []

    emitter.emit({
        "type": "status",
        "turnId": request.turn_id,
        "status": "starting",
        "message": f"{spec.display_name} ACP harness starting",
    })

    try:
        context = spawn_agent(
            bridge,
            command,
            *args,
            env=child_env,
            cwd=request.workspace,
            use_unstable_protocol=True,
        )
        async with context as (connection, process):
            stderr_task = asyncio.create_task(_drain_stderr(getattr(process, "stderr", None), stderr_tail))
            try:
                initialized = await connection.initialize(
                    protocol_version=PROTOCOL_VERSION,
                    client_info=Implementation(
                        name="roomtalk",
                        title="RoomTalk orchestration layer",
                        version="1",
                    ),
                )
                capabilities = getattr(initialized, "agent_capabilities", None)
                native_session_id = _unwrap_session_id(request.session_id, backend)
                restored_session = False
                session_response: Any = None
                if native_session_id and getattr(capabilities, "load_session", False):
                    try:
                        session_response = await connection.load_session(
                            cwd=str(request.workspace),
                            session_id=native_session_id,
                            mcp_servers=[],
                        )
                        restored_session = session_response is not None
                    except Exception:
                        native_session_id = None
                if not native_session_id or not restored_session:
                    session_response = await connection.new_session(
                        cwd=str(request.workspace),
                        mcp_servers=[],
                    )
                    native_session_id = str(session_response.session_id)

                await _configure_session(
                    backend=backend,
                    request=request,
                    connection=connection,
                    session_id=native_session_id,
                    session_response=session_response,
                )
                emitter.emit({
                    "type": "status",
                    "turnId": request.turn_id,
                    "status": "running",
                    "message": f"{spec.display_name} ACP session running",
                })

                control_task = asyncio.create_task(_control_loop(
                    request=request,
                    emitter=emitter,
                    bridge=bridge,
                    connection=connection,
                    session_id=native_session_id,
                    control_queue=control_queue,
                ))
                try:
                    prompt = _prompt_text(request, restored_session=restored_session, env=env)
                    prompt_capabilities = getattr(capabilities, "prompt_capabilities", None)
                    blocks = await _prompt_blocks(
                        request,
                        prompt,
                        bool(getattr(prompt_capabilities, "image", False)),
                    )
                    response = await connection.prompt(
                        session_id=native_session_id,
                        prompt=blocks,
                    )
                finally:
                    control_task.cancel()
                    try:
                        await control_task
                    except asyncio.CancelledError:
                        pass

                usage = getattr(response, "usage", None)
                final_event: dict[str, Any] = {
                    "type": "final",
                    "turnId": request.turn_id,
                    "messageId": request.turn_id,
                    "answer": "".join(bridge.answer_parts),
                    "sessionId": _wrap_session_id(native_session_id, backend),
                }
                if usage is not None:
                    prompt_tokens = int(getattr(usage, "input_tokens", 0) or 0)
                    completion_tokens = int(getattr(usage, "output_tokens", 0) or 0)
                    final_event["usage"] = {
                        "promptTokens": prompt_tokens,
                        "completionTokens": completion_tokens,
                        "totalTokens": int(
                            getattr(usage, "total_tokens", prompt_tokens + completion_tokens)
                            or prompt_tokens + completion_tokens
                        ),
                        "cachedPromptTokens": int(getattr(usage, "cached_read_tokens", 0) or 0),
                        "reasoningOutputTokens": int(getattr(usage, "thought_tokens", 0) or 0),
                        "source": "reported",
                    }
                emitter.emit(final_event)
            finally:
                stderr_task.cancel()
                try:
                    await stderr_task
                except asyncio.CancelledError:
                    pass
    except FileNotFoundError as exc:
        raise RunnerError(
            f"{spec.display_name} executable is missing from the sandbox artifact",
            code="harness_executable_missing",
            turn_id=request.turn_id,
        ) from exc
    except RunnerError:
        raise
    except Exception as exc:
        detail = f"; stderr: {' | '.join(stderr_tail[-8:])}" if stderr_tail else ""
        raise RunnerError(
            f"{spec.display_name} ACP harness failed: {exc}{detail}",
            code="acp_harness_failed",
            turn_id=request.turn_id,
        ) from exc


def run_request(
    backend: str,
    request: RunnerRequest,
    *,
    emitter: EventEmitter,
    env: Mapping[str, str] | None = None,
    control_queue: ControlQueue | None = None,
) -> None:
    if backend not in ACP_BACKENDS:
        raise RunnerError(f"Unsupported ACP harness backend: {backend}", code="unsupported_backend")
    controls = control_queue or queue.Queue()
    asyncio.run(_run_request_async(
        backend,
        request,
        emitter=emitter,
        env=dict(env or os.environ),
        control_queue=controls,
    ))


def _start_control_reader(stdin: TextIO, controls: ControlQueue) -> threading.Thread:
    def read() -> None:
        for line in stdin:
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                controls.put(value)
        controls.put(None)

    thread = threading.Thread(target=read, daemon=True)
    thread.start()
    return thread


def main(
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
    argv: list[str] | None = None,
) -> int:
    parser = argparse.ArgumentParser(description="RoomTalk ACP harness adapter")
    parser.add_argument("--backend", choices=ACP_BACKENDS, required=True)
    args = parser.parse_args(argv)
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    line = stdin.readline()
    request: RunnerRequest | None = None
    if not line:
        _emit_error(stdout, RunnerError("No runner request received", code="missing_request"))
        return 1
    try:
        request = parse_request(line)
        controls: ControlQueue = queue.Queue()
        _start_control_reader(stdin, controls)
        run_request(
            args.backend,
            request,
            emitter=EventEmitter(stdout),
            control_queue=controls,
        )
        return 0
    except Exception as exc:
        _emit_error(stdout, exc, turn_id=request.turn_id if request else None)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
