from __future__ import annotations

import inspect
import base64
import json
import os
import posixpath
import re
import sys
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, TextIO
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import urlparse

SCHEMA_VERSION = 1
READ_ONLY_TOOLS = ("Read", "Glob", "Grep")
WRITE_TOOLS = ("Write", "Edit")
SHELL_TOOL = "Shell"
BACKGROUND_SHELL_TOOL = "BackgroundShell"
PUBLISH_STATIC_SITE_TOOL = "PublishStaticSite"
MAX_TOOL_OUTPUT_CHARS = 20_000
DEFAULT_WORKSPACE_ROOT = "/workspace"
MAX_STATIC_PUBLISH_FILES = 100
MAX_STATIC_PUBLISH_TOTAL_BYTES = 5 * 1024 * 1024
MAX_STATIC_PUBLISH_FILE_BYTES = 2 * 1024 * 1024


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
    prior_messages: list[dict[str, Any]]
    mode: str
    provider: str
    model_id: str
    api_model: str
    codex_model: str | None
    codex_reasoning_effort: str | None
    codex_permission_mode: str | None
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
    if mode not in ("plan", "acceptEdits", "edit", "approveForMe", "fullAccess"):
        raise RunnerError(f"Unsupported mode: {mode}", code="invalid_mode", turn_id=raw.get("turnId"))

    allowed_paths_raw = raw.get("allowedPaths")
    if not isinstance(allowed_paths_raw, list) or not all(isinstance(item, str) for item in allowed_paths_raw):
        raise RunnerError("Expected allowedPaths to be a string array", code="invalid_request", turn_id=raw.get("turnId"))

    session_id_raw = raw.get("sessionId")
    session_id = session_id_raw if isinstance(session_id_raw, str) and session_id_raw else None
    prior_messages = _parse_prior_messages(raw.get("priorMessages"), turn_id=raw.get("turnId"))

    return RunnerRequest(
        room_id=string_field("roomId"),
        turn_id=string_field("turnId"),
        session_id=session_id,
        prompt=string_field("prompt"),
        prior_messages=prior_messages,
        mode=mode,
        provider=string_field("provider"),
        model_id=string_field("modelId"),
        api_model=string_field("apiModel"),
        codex_model=_optional_string(raw.get("codexModel"), "codexModel", turn_id=raw.get("turnId")),
        codex_reasoning_effort=_optional_string(raw.get("codexReasoningEffort"), "codexReasoningEffort", turn_id=raw.get("turnId")),
        codex_permission_mode=_optional_string(raw.get("codexPermissionMode"), "codexPermissionMode", turn_id=raw.get("turnId")),
        workspace=Path(string_field("workspace")),
        allowed_paths=tuple(allowed_paths_raw),
    )


def _optional_string(value: Any, key: str, *, turn_id: str | None = None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise RunnerError(f"Expected non-empty string field {key!r}", code="invalid_request", turn_id=turn_id)
    return value.strip()


def _parse_prior_messages(value: Any, *, turn_id: str | None = None) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise RunnerError("Expected priorMessages to be an array", code="invalid_request", turn_id=turn_id)

    messages: list[dict[str, Any]] = []
    for index, message in enumerate(value):
        if not isinstance(message, dict):
            raise RunnerError(f"Expected priorMessages[{index}] to be an object", code="invalid_request", turn_id=turn_id)
        role = message.get("role")
        if role not in ("user", "assistant"):
            raise RunnerError(f"Invalid priorMessages[{index}].role", code="invalid_request", turn_id=turn_id)
        content = message.get("content")
        if isinstance(content, str):
            messages.append({"role": role, "content": content})
            continue
        if not isinstance(content, list):
            raise RunnerError(f"Invalid priorMessages[{index}].content", code="invalid_request", turn_id=turn_id)

        blocks: list[dict[str, Any]] = []
        for block_index, block in enumerate(content):
            if not isinstance(block, dict):
                raise RunnerError(
                    f"Expected priorMessages[{index}].content[{block_index}] to be an object",
                    code="invalid_request",
                    turn_id=turn_id,
                )
            block_type = block.get("type")
            if block_type == "text":
                text = block.get("text")
                if not isinstance(text, str):
                    raise RunnerError(
                        f"Invalid text block in priorMessages[{index}].content[{block_index}]",
                        code="invalid_request",
                        turn_id=turn_id,
                    )
                blocks.append({"type": "text", "text": text})
            elif block_type == "tool_use":
                tool_id = block.get("id")
                name = block.get("name")
                tool_input = block.get("input")
                if not isinstance(tool_id, str) or not tool_id or not isinstance(name, str) or not name or not isinstance(tool_input, dict):
                    raise RunnerError(
                        f"Invalid tool_use block in priorMessages[{index}].content[{block_index}]",
                        code="invalid_request",
                        turn_id=turn_id,
                    )
                blocks.append({"type": "tool_use", "id": tool_id, "name": name, "input": tool_input})
            elif block_type == "tool_result":
                tool_use_id = block.get("tool_use_id")
                result_content = block.get("content")
                if not isinstance(tool_use_id, str) or not tool_use_id or not isinstance(result_content, str):
                    raise RunnerError(
                        f"Invalid tool_result block in priorMessages[{index}].content[{block_index}]",
                        code="invalid_request",
                        turn_id=turn_id,
                    )
                result_block: dict[str, Any] = {
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": result_content,
                }
                if isinstance(block.get("is_error"), bool):
                    result_block["is_error"] = block["is_error"]
                blocks.append(result_block)
            else:
                raise RunnerError(
                    f"Unsupported block type in priorMessages[{index}].content[{block_index}]: {block_type!r}",
                    code="invalid_request",
                    turn_id=turn_id,
                )
        messages.append({"role": role, "content": blocks})
    return messages


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
        tools.append(BACKGROUND_SHELL_TOOL)
    if _static_publish_enabled(env):
        tools.append(PUBLISH_STATIC_SITE_TOOL)
    return tuple(tools)


def _static_publish_enabled(env: dict[str, str]) -> bool:
    return (
        env.get("ROOMTALK_COCO_ENABLE_STATIC_PUBLISH") == "true"
        and bool((env.get("ROOMTALK_STATIC_PUBLISH_URL") or "").strip())
        and bool((env.get("ROOMTALK_STATIC_PUBLISH_TOKEN") or "").strip())
    )


def system_prompt_for_tools(tool_names: Iterable[str], mode: str) -> str:
    available = tuple(tool_names)
    unavailable = tuple(
        tool for tool in (*READ_ONLY_TOOLS, *WRITE_TOOLS, SHELL_TOOL, BACKGROUND_SHELL_TOOL, PUBLISH_STATIC_SITE_TOOL)
        if tool not in available
    )
    descriptions = {
        "Read": "Read files",
        "Glob": "Find files with glob patterns; use **/* to list a project recursively",
        "Grep": "Search file contents",
        "Write": "Create or overwrite a complete file",
        "Edit": "Replace an exact unique string in an existing file",
        "Shell": "Run foreground shell commands",
        "BackgroundShell": "Start or manage tracked long-running background commands and exposed port URLs",
        "PublishStaticSite": "Publish a static HTML/CSS/JS site directory to a stable RoomTalk URL",
    }
    available_lines = "\n".join(f"- {tool}: {descriptions[tool]}" for tool in available)
    unavailable_line = ", ".join(unavailable) if unavailable else "none"
    mode_guidance = (
        "This run is read-only. Do not call unavailable write or shell tools. "
        "If the user asks you to create, edit, or run code, explain that this room is currently in plan mode and provide the code or commands inline."
        if mode == "plan"
        else "This run may use only the available tools listed below. Do not call any unavailable tools."
    )
    return f"""You are Coco, a terminal coding assistant.

Available tools for this run:
{available_lines}

Unavailable tools for this run: {unavailable_line}.
{mode_guidance}

Use Read / Glob / Grep to verify the workspace before editing. Edit requires old_string to match exactly once.
Keep all downloaded repositories, fetched reference files, generated files, and publish roots inside the current workspace. In RoomTalk sandboxes this is normally /workspace. Do not work in /tmp or /var/tmp unless a tool explicitly needs an ephemeral cache; workspace-scoped tools cannot read, edit, or publish files outside the workspace.
Use Shell only for foreground commands that finish. Use BackgroundShell for servers, watchers, dev servers, slow async tasks, or anything that should keep running after the tool returns. Pass a foreground command to BackgroundShell; do not include nohup, disown, setsid, or '&'. Include expected ports when starting web apps so URLs can be returned.
Use PublishStaticSite after creating a static site directory that can run as plain HTML/CSS/JS. Do not use PublishStaticSite for Flask, Node, Python, databases, or any server-side app.
When exploring a project structure, use Glob with pattern "**/*" to find files recursively.
After tools return, answer clearly. Avoid redundant calls and endless loops."""


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
        if provider == "anthropic" and proxy_url.endswith("/v1"):
            # Anthropic's SDK appends /v1/messages itself. OpenAI-compatible
            # SDKs expect base_url to include /v1, so only strip it here.
            return proxy_url[:-3]
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


STATIC_PUBLISH_MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".wasm": "application/wasm",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
}

STATIC_PUBLISH_SKIP_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".cache",
    ".venv",
    "venv",
    "node_modules",
    "__pycache__",
}

STATIC_PUBLISH_SECRET_RE = re.compile(
    r"^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|.*(?:secret|credential|private[_-]?key).*)$",
    re.IGNORECASE,
)


def _normalize_static_publish_relative_path(raw_path: str) -> str | None:
    if not isinstance(raw_path, str):
        return None
    raw_path = raw_path.replace("\\", "/").strip()
    if not raw_path or raw_path.startswith("/") or "\x00" in raw_path:
        return None
    normalized = posixpath.normpath(raw_path)
    if normalized in ("", ".", "..") or normalized.startswith("../"):
        return None
    parts = normalized.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return None
    if any(part in STATIC_PUBLISH_SKIP_DIRS for part in parts):
        return None
    basename = parts[-1]
    if basename.startswith(".") or STATIC_PUBLISH_SECRET_RE.match(basename):
        return None
    return normalized


def _static_publish_mime_type(site_path: str) -> str | None:
    return STATIC_PUBLISH_MIME_TYPES.get(Path(site_path).suffix.lower())


def _resolve_static_publish_root(workspace: Path, root: Any):
    raw_root = root if isinstance(root, str) and root.strip() else "."
    root_path = Path(raw_root)
    resolved_workspace = workspace.resolve(strict=False)
    resolved = root_path.resolve(strict=False) if root_path.is_absolute() else (resolved_workspace / root_path).resolve(strict=False)
    try:
        resolved.relative_to(resolved_workspace)
    except ValueError as exc:
        raise RunnerError("PublishStaticSite root must stay inside the workspace", code="invalid_publish_root") from exc
    if not resolved.exists() or not resolved.is_dir():
        raise RunnerError("PublishStaticSite root must be an existing directory", code="invalid_publish_root")
    return resolved


def _collect_static_publish_files(workspace: Path, arguments: dict[str, Any]) -> tuple[str, list[dict[str, Any]], int]:
    root = _resolve_static_publish_root(workspace, arguments.get("root"))
    entry = _normalize_static_publish_relative_path(str(arguments.get("entry") or "index.html"))
    if not entry or not _static_publish_mime_type(entry):
        raise RunnerError("PublishStaticSite entry must be a supported relative static file path", code="invalid_publish_entry")

    files: list[dict[str, Any]] = []
    total_bytes = 0
    for path_item in sorted(root.rglob("*")):
        if path_item.is_dir():
            continue
        if path_item.is_symlink():
            continue
        try:
            relative = path_item.relative_to(root).as_posix()
        except ValueError:
            continue
        parts = relative.split("/")
        if any(part in STATIC_PUBLISH_SKIP_DIRS for part in parts[:-1]):
            continue
        basename = parts[-1]
        if STATIC_PUBLISH_SECRET_RE.match(basename):
            raise RunnerError(f"PublishStaticSite refuses to publish secret-like file: {relative}", code="unsafe_publish_file")
        if basename.startswith("."):
            continue
        site_path = _normalize_static_publish_relative_path(relative)
        if not site_path:
            continue
        mime_type = _static_publish_mime_type(site_path)
        if not mime_type:
            continue
        data = path_item.read_bytes()
        if not data:
            continue
        if len(data) > MAX_STATIC_PUBLISH_FILE_BYTES:
            raise RunnerError(f"PublishStaticSite file is too large: {site_path}", code="publish_file_too_large")
        total_bytes += len(data)
        if total_bytes > MAX_STATIC_PUBLISH_TOTAL_BYTES:
            raise RunnerError("PublishStaticSite payload is too large", code="publish_too_large")
        files.append({
            "path": site_path,
            "mimeType": mime_type,
            "byteSize": len(data),
            "contentBase64": base64.b64encode(data).decode("ascii"),
        })
        if len(files) > MAX_STATIC_PUBLISH_FILES:
            raise RunnerError("PublishStaticSite has too many files", code="publish_too_many_files")

    if not files:
        raise RunnerError("PublishStaticSite found no supported static files to publish", code="empty_publish_site")
    if entry not in {item["path"] for item in files}:
        raise RunnerError(f"PublishStaticSite entry file was not found: {entry}", code="missing_publish_entry")
    return entry, files, total_bytes


def _post_static_publish_payload(url: str, token: str, payload: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = urllib_request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib_request.urlopen(request, timeout=30) as response:
            response_body = response.read().decode("utf-8")
            parsed = json.loads(response_body) if response_body.strip() else {}
            return parsed if isinstance(parsed, dict) else {}
    except urllib_error.HTTPError as exc:
        response_text = exc.read().decode("utf-8", errors="replace")
        try:
            parsed_error = json.loads(response_text)
            message = parsed_error.get("error") if isinstance(parsed_error, dict) else None
        except json.JSONDecodeError:
            message = None
        raise RunnerError(
            f"PublishStaticSite failed with HTTP {exc.code}: {message or response_text or exc.reason}",
            code="publish_http_error",
        ) from exc
    except urllib_error.URLError as exc:
        raise RunnerError(f"PublishStaticSite request failed: {exc.reason}", code="publish_request_failed") from exc


def _create_publish_static_site_tool(Tool, ToolOutcome, ToolSpec, request: RunnerRequest, env: dict[str, str]):
    workspace = request.workspace.resolve(strict=False)
    publish_url = (env.get("ROOMTALK_STATIC_PUBLISH_URL") or "").strip()
    publish_token = (env.get("ROOMTALK_STATIC_PUBLISH_TOKEN") or "").strip()

    class PublishStaticSiteTool(Tool):
        @property
        def spec(self):
            return ToolSpec(
                name=PUBLISH_STATIC_SITE_TOOL,
                description=(
                    "Publish a static site directory from the current workspace to a stable RoomTalk URL. "
                    "Use only for static HTML/CSS/JS assets, not server-side apps."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "root": {
                            "type": "string",
                            "description": "Directory containing the static site, relative to the workspace. Defaults to current directory.",
                        },
                        "entry": {
                            "type": "string",
                            "description": "Entry HTML file relative to root. Defaults to index.html.",
                        },
                        "slug": {
                            "type": "string",
                            "description": "Optional URL slug. RoomTalk will sanitize it and reject slugs owned by another room.",
                        },
                        "title": {
                            "type": "string",
                            "description": "Optional display title for the published site manifest.",
                        },
                    },
                    "required": [],
                },
                is_read_only=False,
                is_concurrency_safe=False,
            )

        def invoke(self, arguments: dict[str, Any]):
            try:
                entry, files, total_bytes = _collect_static_publish_files(workspace, arguments)
                payload: dict[str, Any] = {
                    "roomId": request.room_id,
                    "turnId": request.turn_id,
                    "entry": entry,
                    "files": files,
                }
                if isinstance(arguments.get("slug"), str) and arguments["slug"].strip():
                    payload["slug"] = arguments["slug"].strip()
                if isinstance(arguments.get("title"), str) and arguments["title"].strip():
                    payload["title"] = arguments["title"].strip()

                response = _post_static_publish_payload(publish_url, publish_token, payload)
                url = response.get("url")
                if not isinstance(url, str) or not url:
                    raise RunnerError("PublishStaticSite response did not include a URL", code="invalid_publish_response")
                slug = response.get("slug")
                version_id = response.get("versionId")
                file_count = response.get("fileCount", len(files))
                byte_count = response.get("totalBytes", total_bytes)
                content = (
                    f"Published static site: {url}\n"
                    f"Slug: {slug or 'unknown'}\n"
                    f"Entry: {entry}\n"
                    f"Version: {version_id or 'unknown'}\n"
                    f"Files: {file_count}\n"
                    f"Bytes: {byte_count}"
                )
                return ToolOutcome(success=True, content=content, metadata=response)
            except RunnerError as exc:
                return ToolOutcome(success=False, content=str(exc), error=str(exc))
            except OSError as exc:
                message = f"PublishStaticSite failed to read files: {exc}"
                return ToolOutcome(success=False, content=message, error=message)

    return PublishStaticSiteTool()


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
    from core.tools.base import Tool, ToolOutcome, ToolSpec
    try:
        from core.tools import BackgroundShellTool
    except ImportError:  # pragma: no cover - compatibility with older Coco artifacts
        BackgroundShellTool = None

    workspace = request.workspace.resolve(strict=False)
    engine_allowed_paths = canonical_allowed_paths_for_engine(workspace, request.allowed_paths)

    tool_names = tool_names_for_mode(request.mode, env)
    if BackgroundShellTool is None:
        tool_names = tuple(tool for tool in tool_names if tool != BACKGROUND_SHELL_TOOL)
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
    if "BackgroundShell" in tool_names and BackgroundShellTool is not None:
        tools.append(BackgroundShellTool(workspace))
    if PUBLISH_STATIC_SITE_TOOL in tool_names:
        tools.append(_create_publish_static_site_tool(Tool, ToolOutcome, ToolSpec, request, env))

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
    permissions = PermissionChecker(auto_approve=True, mode="plan" if request.mode == "plan" else "acceptEdits")
    allowed_tools = set(READ_ONLY_TOOLS) if request.mode == "plan" else None
    return Engine(
        llm,
        tools,
        system=system_prompt_for_tools(tool_names, request.mode),
        permissions=permissions,
        allowed_tools=allowed_tools,
        workspace=workspace,
        allowed_paths=list(engine_allowed_paths),
    )


def prompt_with_background_jobs(prompt: str) -> str:
    try:
        from core.tools.background_shell import summarize_background_jobs
    except Exception:
        return prompt
    try:
        summary = summarize_background_jobs()
    except Exception:
        return prompt
    if not summary.strip():
        return prompt
    return (
        "Context for this Coco turn. This is system-provided state from the same sandbox, not a new user request.\n"
        f"{summary}\n\n"
        "User request:\n"
        f"{prompt}"
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


def _tool_result_success(block: dict[str, Any], exit_code: int | None) -> bool:
    if block.get("is_error") is True:
        return False
    if exit_code is not None:
        return exit_code == 0
    return True


def _engine_supports_tool_events(engine: Any) -> bool:
    try:
        parameters = inspect.signature(engine.run).parameters
    except (TypeError, ValueError):
        return False
    return "on_tool_event" in parameters


def _engine_supports_prior_messages(engine: Any) -> bool:
    try:
        parameters = inspect.signature(engine.run).parameters
    except (TypeError, ValueError):
        return False
    return "prior_messages" in parameters


def _live_tool_event_to_runner_event(event: dict[str, Any], turn_id: str) -> dict[str, Any]:
    if not isinstance(event, dict):
        raise RunnerError("Coco tool event must be a JSON object", code="invalid_tool_event", turn_id=turn_id)
    event_type = event.get("type")
    if event_type == "tool_call":
        raw_input = event.get("input")
        return {
            "type": "tool_call",
            "id": str(event.get("id") or ""),
            "name": str(event.get("name") or "unknown"),
            "args": raw_input if isinstance(raw_input, dict) else {},
            "turnId": turn_id,
        }
    if event_type == "tool_result":
        output = event.get("output")
        output_text = output if isinstance(output, str) else str(output or "")
        output_text, truncated = _truncate_output(output_text)
        success = event.get("success")
        mapped: dict[str, Any] = {
            "type": "tool_result",
            "id": str(event.get("id") or ""),
            "name": str(event.get("name") or "unknown"),
            "success": success if isinstance(success, bool) else False,
            "output": output_text,
            "turnId": turn_id,
        }
        elapsed_ms = event.get("elapsed_ms")
        if isinstance(elapsed_ms, (int, float)):
            mapped["elapsedMs"] = elapsed_ms
        exit_code = event.get("exit_code")
        if isinstance(exit_code, int):
            mapped["exitCode"] = exit_code
        if truncated:
            mapped["truncated"] = True
        return mapped
    raise RunnerError(f"Unsupported Coco tool event type: {event_type!r}", code="invalid_tool_event", turn_id=turn_id)


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
                success = _tool_result_success(block, exit_code)
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

        def on_tool_event(event: dict[str, Any]) -> None:
            emitter.emit(_live_tool_event_to_runner_event(event, request.turn_id))

        live_tool_events_enabled = _engine_supports_tool_events(engine)
        run_kwargs: dict[str, Any] = {"on_text_chunk": on_text_chunk}
        if _engine_supports_prior_messages(engine):
            run_kwargs["prior_messages"] = request.prior_messages or None
        if live_tool_events_enabled:
            run_kwargs["on_tool_event"] = on_tool_event

        result = engine.run(prompt_with_background_jobs(request.prompt), **run_kwargs)
        if not live_tool_events_enabled:
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
