from __future__ import annotations

import json
import os
import re
import sys
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, TextIO
from urllib.parse import urlparse

SCHEMA_VERSION = 1
READ_ONLY_TOOLS = ("Read", "Glob", "Grep")
WRITE_TOOLS = ("Write", "Edit")
SHELL_TOOL = "Shell"
MAX_TOOL_OUTPUT_CHARS = 20_000
DEFAULT_WORKSPACE_ROOT = "/workspace"
ERROR_OUTPUT_RE = re.compile(
    r"(^|\n)\s*(error|fatal|exception|traceback\b|permission denied\b|file not found\b|"
    r"[A-Za-z_][A-Za-z0-9_]*(Error|Exception):)",
    re.IGNORECASE,
)


class RunnerError(Exception):
    def __init__(self, message: str, *, code: str = "runner_error", turn_id: str | None = None):
        super().__init__(message)
        self.code = code
        self.turn_id = turn_id


@dataclass(frozen=True)
class RunnerRequest:
    room_id: str
    turn_id: str
    session_id: str | None
    prompt: str
    mode: str
    provider: str
    model_id: str
    api_model: str
    workspace: Path
    allowed_paths: tuple[str, ...]


class EventEmitter:
    def __init__(self, stream: TextIO):
        self._stream = stream

    def emit(self, event: dict[str, Any]) -> None:
        event.setdefault("schemaVersion", SCHEMA_VERSION)
        self._stream.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
        self._stream.flush()


def parse_request(line: str) -> RunnerRequest:
    try:
        raw = json.loads(line)
    except json.JSONDecodeError as exc:
        raise RunnerError(f"Invalid JSON request: {exc.msg}", code="invalid_json") from exc

    if not isinstance(raw, dict):
        raise RunnerError("Runner request must be a JSON object", code="invalid_request")
    if raw.get("schemaVersion") != SCHEMA_VERSION:
        raise RunnerError(f"Unsupported schemaVersion: {raw.get('schemaVersion')}", code="unsupported_schema")
    if raw.get("type") != "run":
        raise RunnerError(f"Unsupported request type: {raw.get('type')}", code="unsupported_type")

    def string_field(key: str) -> str:
        value = raw.get(key)
        if not isinstance(value, str) or not value:
            raise RunnerError(f"Expected non-empty string field {key!r}", code="invalid_request")
        return value

    mode = string_field("mode")
    if mode not in ("plan", "acceptEdits"):
        raise RunnerError(f"Unsupported mode: {mode}", code="invalid_mode", turn_id=raw.get("turnId"))

    allowed_paths_raw = raw.get("allowedPaths")
    if not isinstance(allowed_paths_raw, list) or not all(isinstance(item, str) for item in allowed_paths_raw):
        raise RunnerError("Expected allowedPaths to be a string array", code="invalid_request", turn_id=raw.get("turnId"))

    session_id_raw = raw.get("sessionId")
    session_id = session_id_raw if isinstance(session_id_raw, str) and session_id_raw else None

    return RunnerRequest(
        room_id=string_field("roomId"),
        turn_id=string_field("turnId"),
        session_id=session_id,
        prompt=string_field("prompt"),
        mode=mode,
        provider=string_field("provider"),
        model_id=string_field("modelId"),
        api_model=string_field("apiModel"),
        workspace=Path(string_field("workspace")),
        allowed_paths=tuple(allowed_paths_raw),
    )


def resolve_allowed_roots(workspace: Path, allowed_paths: Iterable[str]) -> tuple[Path, ...]:
    workspace_root = workspace.resolve(strict=False)
    roots: list[Path] = []
    for raw_path in allowed_paths:
        if not raw_path.strip():
            raise RunnerError("allowedPaths entries must be non-empty", code="invalid_allowed_path")
        candidate = Path(raw_path)
        if candidate.is_absolute():
            resolved = candidate.resolve(strict=False)
        else:
            resolved = (workspace_root / candidate).resolve(strict=False)
        try:
            resolved.relative_to(workspace_root)
        except ValueError as exc:
            raise RunnerError(
                f"allowedPaths entry escapes workspace: {raw_path}",
                code="invalid_allowed_path",
            ) from exc
        roots.append(resolved)
    if not roots:
        raise RunnerError("allowedPaths must contain at least one path", code="invalid_allowed_path")
    return tuple(roots)


def canonical_allowed_paths_for_engine(workspace: Path, allowed_paths: Iterable[str]) -> tuple[str, ...]:
    workspace_root = workspace.resolve(strict=False)
    roots = resolve_allowed_roots(workspace_root, allowed_paths)
    engine_paths: list[str] = []
    for root in roots:
        relative = root.relative_to(workspace_root)
        engine_paths.append(str(relative) if str(relative) != "." else ".")
    return tuple(engine_paths)


def workspace_root_from_env(env: dict[str, str] | None = None) -> Path:
    if env is None:
        env = os.environ
    raw_root = (env.get("COCO_WORKSPACE_ROOT") or DEFAULT_WORKSPACE_ROOT).strip()
    root = Path(raw_root).expanduser()
    if not root.is_absolute():
        raise RunnerError("COCO_WORKSPACE_ROOT must be an absolute path", code="invalid_workspace")
    return root.resolve(strict=False)


def validate_workspace_path(workspace: Path, env: dict[str, str] | None = None) -> Path:
    if not workspace.is_absolute():
        raise RunnerError("workspace must be an absolute path", code="invalid_workspace")

    resolved_workspace = workspace.expanduser().resolve(strict=False)
    root = workspace_root_from_env(env)
    try:
        resolved_workspace.relative_to(root)
    except ValueError as exc:
        raise RunnerError(
            f"workspace must be inside COCO_WORKSPACE_ROOT: {workspace}",
            code="invalid_workspace",
        ) from exc
    return resolved_workspace


def tool_names_for_mode(mode: str, env: dict[str, str] | None = None) -> tuple[str, ...]:
    if env is None:
        env = os.environ
    if mode == "plan":
        return READ_ONLY_TOOLS
    tools = [*READ_ONLY_TOOLS]
    if env.get("ROOMTALK_COCO_ALLOW_WRITE_TOOLS") == "true":
        tools.extend(WRITE_TOOLS)
    if env.get("ROOMTALK_COCO_ALLOW_SHELL") == "true":
        tools.append(SHELL_TOOL)
    return tuple(tools)


def _provider_for_coco(provider: str):
    from core.models import Provider

    if provider == "anthropic":
        return Provider.ANTHROPIC
    if provider == "openrouter":
        return Provider.OPENROUTER
    if provider in ("openai", "deepseek"):
        # DeepSeek is OpenAI-compatible in Coco; keep this in sync with
        # _api_key_for and _base_url_for when adding compatible providers.
        return Provider.OPENAI
    raise RunnerError(f"Unsupported provider for Coco: {provider}", code="unsupported_provider")


def _model_proxy_url(env: dict[str, str]) -> str | None:
    proxy_url = (env.get("COCO_MODEL_PROXY_URL") or "").strip()
    if not proxy_url:
        return None
    parsed = urlparse(proxy_url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise RunnerError(
            "COCO_MODEL_PROXY_URL must be an HTTPS URL",
            code="invalid_model_proxy_url",
        )
    return proxy_url.rstrip("/")


def _model_proxy_token(env: dict[str, str]) -> str | None:
    token = (env.get("COCO_MODEL_PROXY_TOKEN") or "").strip()
    return token or None


def _api_key_for(provider: str, env: dict[str, str]) -> str | None:
    if _model_proxy_url(env):
        token = _model_proxy_token(env)
        if not token:
            raise RunnerError("COCO_MODEL_PROXY_TOKEN is required when COCO_MODEL_PROXY_URL is set", code="model_proxy_token_missing")
        return token
    if provider == "anthropic":
        return env.get("ANTHROPIC_API_KEY")
    if provider == "openrouter":
        return env.get("OPENROUTER_API_KEY")
    if provider == "deepseek":
        return env.get("DEEPSEEK_API_KEY")
    return env.get("OPENAI_API_KEY")


def _base_url_for(provider: str, env: dict[str, str]) -> str | None:
    proxy_url = _model_proxy_url(env)
    if proxy_url:
        return proxy_url
    if provider == "anthropic":
        return env.get("ANTHROPIC_BASE_URL")
    if provider == "openrouter":
        return env.get("OPENROUTER_BASE_URL")
    if provider == "deepseek":
        return env.get("DEEPSEEK_BASE_URL") or "https://api.deepseek.com"
    return env.get("OPENAI_BASE_URL")


def _max_tokens(env: dict[str, str]) -> int:
    try:
        return max(1, int(env.get("ROOMTALK_COCO_MAX_TOKENS") or env.get("COCO_MAX_TOKENS") or "16384"))
    except ValueError:
        return 16384


def _add_coco_source_to_path(env: dict[str, str]) -> None:
    source_dir = env.get("COCO_SOURCE_DIR")
    if source_dir:
        source_path = Path(source_dir).expanduser().resolve(strict=False)
        if not source_path.is_dir():
            raise RunnerError(
                f"COCO_SOURCE_DIR does not exist or is not a directory: {source_dir}",
                code="coco_source_not_found",
            )
        source_entry = str(source_path)
        if source_entry not in sys.path:
            sys.path.insert(0, source_entry)


@contextmanager
def scoped_workspace_cwd(workspace: Path):
    resolved_workspace = validate_workspace_path(workspace)
    resolved_workspace.mkdir(parents=True, exist_ok=True)
    previous_cwd = Path.cwd()
    # Coco's current file tools resolve relative paths from cwd. Keep cwd scoped
    # to the duration of one runner turn and always restore it for tests/local use.
    os.chdir(resolved_workspace)
    try:
        yield resolved_workspace
    finally:
        os.chdir(previous_cwd)


def create_coco_engine(request: RunnerRequest, env: dict[str, str] | None = None):
    if env is None:
        env = os.environ
    _add_coco_source_to_path(env)

    from core.engine import Engine
    from core.llm import LLMClient
    from core.models import AppSettings
    from core.permissions import PermissionChecker
    from core.tools import FileEditTool, FileReadTool, FileWriteTool, GlobTool, GrepTool, ShellTool

    workspace = request.workspace.resolve(strict=False)
    engine_allowed_paths = canonical_allowed_paths_for_engine(workspace, request.allowed_paths)

    tool_names = tool_names_for_mode(request.mode, env)
    tools = []
    if "Read" in tool_names:
        tools.append(FileReadTool())
    if "Glob" in tool_names:
        tools.append(GlobTool())
    if "Grep" in tool_names:
        tools.append(GrepTool())
    if "Write" in tool_names:
        tools.append(FileWriteTool())
    if "Edit" in tool_names:
        tools.append(FileEditTool())
    if "Shell" in tool_names:
        # Shell is intentionally env-gated because PermissionChecker runs with
        # auto-approve below. The Node caller must only enable this for trusted
        # sandbox processes with scoped credentials.
        tools.append(ShellTool(workspace))

    settings = AppSettings(
        provider=_provider_for_coco(request.provider),
        model=request.api_model,
        api_key=_api_key_for(request.provider, env),
        base_url=_base_url_for(request.provider, env),
        max_tokens=_max_tokens(env),
    )
    llm = LLMClient.from_settings(settings)
    # File access enforcement is delegated to Coco tools plus the outer sandbox.
    # This adapter validates requested roots but does not intercept each tool IO.
    permissions = PermissionChecker(auto_approve=True, mode=request.mode)
    allowed_tools = set(READ_ONLY_TOOLS) if request.mode == "plan" else None
    return Engine(
        llm,
        tools,
        permissions=permissions,
        allowed_tools=allowed_tools,
        workspace=workspace,
        allowed_paths=list(engine_allowed_paths),
    )


def _iter_blocks(content: Any) -> Iterable[dict[str, Any]]:
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict):
                yield block


_EXIT_CODE_RE = re.compile(r"\[exit code:\s*(-?\d+)\]")


def _parse_exit_code(output: str) -> int | None:
    match = _EXIT_CODE_RE.search(output)
    if not match:
        return None
    try:
        return int(match.group(1))
    except ValueError:
        return None


def _truncate_output(output: str) -> tuple[str, bool]:
    if len(output) <= MAX_TOOL_OUTPUT_CHARS:
        return output, "\n...[truncated]...\n" in output
    return output[:MAX_TOOL_OUTPUT_CHARS], True


def _tool_content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text" and isinstance(block.get("text"), str):
                    parts.append(block["text"])
                elif isinstance(block.get("content"), str):
                    parts.append(block["content"])
                elif block.get("type"):
                    parts.append("[non-text content omitted]")
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts)
    return str(content or "")


def _tool_result_success(block: dict[str, Any], output: str, exit_code: int | None) -> bool:
    if block.get("is_error") is True:
        return False
    if exit_code is not None:
        return exit_code == 0
    return ERROR_OUTPUT_RE.search(output) is None


def replay_tool_events(messages: list[dict[str, Any]], turn_id: str | None = None) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    calls: dict[str, dict[str, Any]] = {}
    for message in messages:
        role = message.get("role")
        if role == "assistant":
            for block in _iter_blocks(message.get("content")):
                if block.get("type") != "tool_use":
                    continue
                tool_id = str(block.get("id") or "")
                if not tool_id:
                    continue
                call = {
                    "id": tool_id,
                    "name": str(block.get("name") or "unknown"),
                    "args": block.get("input") if isinstance(block.get("input"), dict) else {},
                }
                calls[tool_id] = call
                event = {"type": "tool_call", **call}
                if turn_id:
                    event["turnId"] = turn_id
                events.append(event)
        elif role == "user":
            for block in _iter_blocks(message.get("content")):
                if block.get("type") != "tool_result":
                    continue
                tool_id = str(block.get("tool_use_id") or "")
                call = calls.get(tool_id, {"id": tool_id, "name": "unknown", "args": {}})
                output = _tool_content_to_text(block.get("content"))
                output, truncated = _truncate_output(output)
                exit_code = _parse_exit_code(output)
                success = _tool_result_success(block, output, exit_code)
                event: dict[str, Any] = {
                    "type": "tool_result",
                    "id": tool_id,
                    "name": call["name"],
                    "success": success,
                    "output": output,
                }
                if exit_code is not None:
                    event["exitCode"] = exit_code
                if truncated:
                    event["truncated"] = True
                if turn_id:
                    event["turnId"] = turn_id
                events.append(event)
    return events


def _usage_to_event_usage(usage: Any) -> dict[str, Any] | None:
    if usage is None:
        return None
    prompt_tokens = int(getattr(usage, "input_tokens", 0) or 0)
    completion_tokens = int(getattr(usage, "output_tokens", 0) or 0)
    result: dict[str, Any] = {
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "totalTokens": prompt_tokens + completion_tokens,
        "source": "reported",
    }
    cached = int(getattr(usage, "cache_read", 0) or 0)
    if cached:
        result["cachedPromptTokens"] = cached
        result["cacheHitRate"] = cached / prompt_tokens if prompt_tokens > 0 else 0
    return result


def run_request(
    request: RunnerRequest,
    *,
    emitter: EventEmitter,
    engine_factory: Callable[[RunnerRequest], Any] = create_coco_engine,
) -> None:
    message_id = request.turn_id
    emitter.emit({
        "type": "status",
        "turnId": request.turn_id,
        "status": "starting",
        "message": "Coco runner starting",
    })

    with scoped_workspace_cwd(request.workspace):
        engine = engine_factory(request)
        emitter.emit({
            "type": "status",
            "turnId": request.turn_id,
            "status": "running",
            "message": "Coco engine running",
        })

        def on_text_chunk(delta: str) -> None:
            emitter.emit({"type": "text_delta", "messageId": message_id, "turnId": request.turn_id, "delta": delta})

        result = engine.run(request.prompt, on_text_chunk=on_text_chunk)
        for event in replay_tool_events(getattr(result, "messages", []) or [], turn_id=request.turn_id):
            emitter.emit(event)

        usage = _usage_to_event_usage(getattr(result, "usage", None))
        final_event: dict[str, Any] = {
            "type": "final",
            "messageId": message_id,
            "turnId": request.turn_id,
            "answer": str(getattr(result, "answer", "") or ""),
            "sessionId": request.session_id or request.turn_id,
        }
        if usage:
            final_event["usage"] = usage
        emitter.emit(final_event)


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
