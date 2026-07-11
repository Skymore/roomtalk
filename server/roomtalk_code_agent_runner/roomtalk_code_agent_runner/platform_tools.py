from __future__ import annotations

import argparse
import http.client
import json
import os
import socket
import sys
from urllib import parse as urllib_parse
from urllib import error as urllib_error
from urllib import request as urllib_request
from pathlib import Path
from typing import Any, Sequence

from .runner import (
    RunnerError,
    _collect_static_publish_files,
    _post_static_publish_payload,
    validate_workspace_path,
)


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    env = dict(os.environ)
    try:
        if args.command == "publish-static-site" or (args.command == "site" and args.site_command == "publish"):
            _require_write_access(env)
            result = _publish_static_site(args, env)
        elif args.command == "site" and args.site_command == "list":
            result = _list_static_sites(env)
        elif args.command == "site" and args.site_command == "unpublish":
            _require_write_access(env)
            result = _unpublish_static_site(args, env)
        elif args.command == "room":
            result = _read_room_context(args, env)
        else:  # pragma: no cover - argparse prevents this.
            parser.error("missing command")
            return 2
        _print_result(result, json_output=bool(getattr(args, "json", False)))
        return 0 if result.get("success") is True else 1
    except RunnerError as exc:
        _print_result({"success": False, "error": str(exc), "code": exc.code}, json_output=bool(getattr(args, "json", False)))
        return 1
    except Exception as exc:
        _print_result({"success": False, "error": str(exc), "code": "roomtalk_tool_error"}, json_output=bool(getattr(args, "json", False)))
        return 1


def _require_write_access(env: dict[str, str]) -> None:
    if (env.get("ROOMTALK_CODE_AGENT_CLI_ACCESS") or "").strip().lower() == "read-only":
        raise RunnerError(
            "This RoomTalk CLI command is not available in Plan mode",
            code="roomtalk_cli_read_only",
        )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="roomtalk",
        description="RoomTalk sandbox helper tools for code-agent backends.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    legacy_publish = subparsers.add_parser(
        "publish-static-site",
        help="Compatibility alias for `roomtalk site publish`.",
    )
    _add_publish_arguments(legacy_publish)

    site = subparsers.add_parser("site", help="Publish or unpublish a RoomTalk static site.")
    site_subparsers = site.add_subparsers(dest="site_command", required=True)
    site_list = site_subparsers.add_parser("list", help="List static sites published by the current room.")
    site_list.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
    site_publish = site_subparsers.add_parser("publish", help="Publish a static HTML/CSS/JS directory.")
    _add_publish_arguments(site_publish)
    site_unpublish = site_subparsers.add_parser("unpublish", help="Take a published static site offline.")
    site_unpublish.add_argument("--slug", required=True, help="Published site URL slug to take offline.")
    site_unpublish.add_argument("--json", action="store_true", help="Print machine-readable JSON.")

    room = subparsers.add_parser("room", help="Read the current RoomTalk room context.")
    room_subparsers = room.add_subparsers(dest="room_command", required=True)

    history = room_subparsers.add_parser("history", help="Read recent room messages.")
    history.add_argument("--limit", type=int, default=20)
    history.add_argument("--before", default="", help="Read messages before this message ID.")
    history.add_argument("--json", action="store_true", help="Print machine-readable JSON.")

    delta = room_subparsers.add_parser("delta", help="Read messages after a known message ID.")
    delta.add_argument("--since", required=True, help="Read messages after this message ID.")
    delta.add_argument("--limit", type=int, default=50)
    delta.add_argument("--json", action="store_true", help="Print machine-readable JSON.")

    search = room_subparsers.add_parser("search", help="Search recent room messages.")
    search.add_argument("--query", required=True, help="Text to search for.")
    search.add_argument("--limit", type=int, default=20)
    search.add_argument("--json", action="store_true", help="Print machine-readable JSON.")

    message = room_subparsers.add_parser("message", help="Read one room message by ID.")
    message.add_argument("message_id")
    message.add_argument("--json", action="store_true", help="Print machine-readable JSON.")

    return parser


def _add_publish_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--root", default=".", help="Static site directory, relative to the workspace.")
    parser.add_argument("--entry", default="index.html", help="Entry file relative to --root.")
    parser.add_argument("--slug", default="", help="Optional URL slug.")
    parser.add_argument("--title", default="", help="Optional display title.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON.")


def _read_room_context(args: argparse.Namespace, env: dict[str, str]) -> dict[str, Any]:
    if args.room_command == "history":
        query: dict[str, Any] = {"limit": args.limit}
        if args.before:
            query["beforeMessageId"] = args.before
        path = f"/history?{urllib_parse.urlencode(query)}"
    elif args.room_command == "delta":
        path = f"/delta?{urllib_parse.urlencode({'sinceMessageId': args.since, 'limit': args.limit})}"
    elif args.room_command == "search":
        path = f"/search?{urllib_parse.urlencode({'query': args.query, 'limit': args.limit})}"
    elif args.room_command == "message":
        path = f"/messages/{urllib_parse.quote(args.message_id, safe='')}"
    else:  # pragma: no cover - argparse prevents this.
        raise RunnerError("Unsupported room context command", code="room_context_command_invalid")

    return _read_room_context_path(path, env)


def _read_room_context_path(path: str, env: dict[str, str]) -> dict[str, Any]:
    base_url = (env.get("ROOMTALK_ROOM_CONTEXT_URL") or "").strip().rstrip("/")
    token = (env.get("ROOMTALK_ROOM_CONTEXT_TOKEN") or "").strip()
    socket_path = (env.get("ROOMTALK_ROOM_CONTEXT_SOCKET") or "").strip()
    if not socket_path and (not base_url or not token):
        raise RunnerError("Room context is not available for this turn", code="room_context_unavailable")

    if socket_path:
        return _get_room_context_from_broker(socket_path, path)
    return _get_room_context(f"{base_url}{path}", token)


def _list_static_sites(env: dict[str, str]) -> dict[str, Any]:
    result = _read_room_context_path("/sites", env)
    return {**result, "tool": "ListStaticSites"}


def _get_room_context_from_broker(socket_path: str, path: str) -> dict[str, Any]:
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(30)
            client.connect(socket_path)
            client.sendall((json.dumps({"path": path}, separators=(",", ":")) + "\n").encode("utf-8"))
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = client.recv(64 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > 25 * 1024 * 1024:
                    raise RunnerError("Room context broker response is too large", code="room_context_response_too_large")
                chunks.append(chunk)
        response = json.loads(b"".join(chunks).decode("utf-8"))
    except RunnerError:
        raise
    except Exception as exc:
        raise RunnerError(f"Room context broker request failed: {exc}", code="room_context_broker_failed") from exc
    if not isinstance(response, dict):
        raise RunnerError("Room context broker response was not a JSON object", code="invalid_room_context_response")
    if response.get("success") is not True:
        raise RunnerError(
            str(response.get("error") or "Room context broker request failed"),
            code=str(response.get("code") or "room_context_broker_failed"),
        )
    payload = response.get("payload")
    if not isinstance(payload, dict):
        raise RunnerError("Room context broker payload was not a JSON object", code="invalid_room_context_response")
    return {"success": True, "tool": "RoomContext", **payload}


def _get_room_context(url: str, token: str) -> dict[str, Any]:
    request = urllib_request.Request(url, method="GET", headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": "roomtalk-code-agent-runner/1",
    })
    try:
        with urllib_request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        raise RunnerError(f"Room context request failed: {exc}", code="room_context_request_failed") from exc
    if not isinstance(payload, dict):
        raise RunnerError("Room context response was not a JSON object", code="invalid_room_context_response")
    return {"success": True, "tool": "RoomContext", **payload}


def _publish_static_site(args: argparse.Namespace, env: dict[str, str]) -> dict[str, Any]:
    publish_url = (env.get("ROOMTALK_STATIC_PUBLISH_URL") or "").strip()
    publish_token = (env.get("ROOMTALK_STATIC_PUBLISH_TOKEN") or "").strip()
    room_id = (env.get("ROOMTALK_CODE_AGENT_ROOM_ID") or "").strip()
    turn_id = (env.get("ROOMTALK_CODE_AGENT_TURN_ID") or "").strip()
    if not publish_url or not publish_token:
        raise RunnerError("Static site publishing is not available for this turn", code="publish_unavailable")
    if not room_id or not turn_id:
        raise RunnerError("RoomTalk publish metadata is missing for this turn", code="publish_metadata_missing")

    workspace = _workspace_from_env(env)
    entry, files, total_bytes = _collect_static_publish_files(workspace, {
        "root": args.root,
        "entry": args.entry,
    })
    payload: dict[str, Any] = {
        "roomId": room_id,
        "turnId": turn_id,
        "entry": entry,
        "files": [
            {"path": item["path"], "byteSize": item["byteSize"]}
            for item in files
        ],
    }
    if args.slug:
        payload["slug"] = str(args.slug).strip()
    if args.title:
        payload["title"] = str(args.title).strip()

    prepare = _post_static_publish_payload(f"{publish_url.rstrip('/')}/prepare", publish_token, payload)
    uploads = prepare.get("files")
    upload_token = prepare.get("uploadToken")
    if not isinstance(uploads, list) or not isinstance(upload_token, str) or not upload_token:
        raise RunnerError("PublishStaticSite prepare response was incomplete", code="invalid_publish_prepare_response")
    source_by_path = {str(item["path"]): Path(str(item["sourcePath"])) for item in files}
    for upload in uploads:
        if not isinstance(upload, dict):
            raise RunnerError("PublishStaticSite prepare response included an invalid file", code="invalid_publish_prepare_response")
        site_path = str(upload.get("path") or "")
        source_path = source_by_path.get(site_path)
        upload_url = str(upload.get("uploadUrl") or "")
        mime_type = str(upload.get("mimeType") or "")
        byte_size = upload.get("byteSize")
        if source_path is None or not upload_url or not mime_type or not isinstance(byte_size, int):
            raise RunnerError("PublishStaticSite prepare response included an invalid file", code="invalid_publish_prepare_response")
        _put_static_publish_file(
            urllib_parse.urljoin(publish_url, upload_url),
            source_path,
            mime_type,
            byte_size,
        )
    response = _post_static_publish_payload(
        f"{publish_url.rstrip('/')}/finalize",
        publish_token,
        {"uploadToken": upload_token},
    )
    url = response.get("url")
    if not isinstance(url, str) or not url:
        raise RunnerError("PublishStaticSite response did not include a URL", code="invalid_publish_response")
    return {
        "success": True,
        "tool": "PublishStaticSite",
        "url": url,
        "slug": response.get("slug") or "",
        "entry": response.get("entry") or entry,
        "versionId": response.get("versionId") or "",
        "fileCount": response.get("fileCount", len(files)),
        "totalBytes": response.get("totalBytes", total_bytes),
    }


def _put_static_publish_file(url: str, source_path: Path, mime_type: str, byte_size: int) -> None:
    parsed = urllib_parse.urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise RunnerError("PublishStaticSite direct upload URL was invalid", code="invalid_publish_upload_url")
    connection_type = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    connection = connection_type(parsed.hostname, parsed.port, timeout=120)
    request_path = urllib_parse.urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
    try:
        with source_path.open("rb") as source:
            connection.putrequest("PUT", request_path)
            connection.putheader("Content-Type", mime_type)
            connection.putheader("Content-Length", str(byte_size))
            connection.putheader("User-Agent", "roomtalk-code-agent-runner/1")
            connection.endheaders()
            while chunk := source.read(1024 * 1024):
                connection.send(chunk)
            response = connection.getresponse()
            response_body = response.read()
            if response.status < 200 or response.status >= 300:
                message = response_body.decode("utf-8", errors="replace")
                raise RunnerError(
                    f"PublishStaticSite direct upload failed with HTTP {response.status}: {message or response.reason}",
                    code="publish_upload_http_error",
                )
    except RunnerError:
        raise
    except OSError as exc:
        raise RunnerError(
            f"PublishStaticSite direct upload failed: {exc}",
            code="publish_upload_failed",
        ) from exc
    finally:
        connection.close()


def _unpublish_static_site(args: argparse.Namespace, env: dict[str, str]) -> dict[str, Any]:
    publish_url = (env.get("ROOMTALK_STATIC_PUBLISH_URL") or "").strip()
    publish_token = (env.get("ROOMTALK_STATIC_PUBLISH_TOKEN") or "").strip()
    if not publish_url or not publish_token:
        raise RunnerError("Static site management is not available for this turn", code="unpublish_unavailable")

    response = _delete_static_publish_payload(publish_url, publish_token, {"slug": str(args.slug).strip()})
    slug = response.get("slug")
    url = response.get("url")
    if not isinstance(slug, str) or not slug or not isinstance(url, str) or not url:
        raise RunnerError("Static site unpublish response was incomplete", code="invalid_unpublish_response")
    return {
        "success": True,
        "tool": "UnpublishStaticSite",
        "url": url,
        "slug": slug,
        "objectCount": response.get("objectCount", 0),
    }


def _delete_static_publish_payload(url: str, token: str, payload: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = urllib_request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="DELETE",
    )
    try:
        with urllib_request.urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8")
            parsed = json.loads(raw) if raw.strip() else {}
            return parsed if isinstance(parsed, dict) else {}
    except urllib_error.HTTPError as exc:
        response_text = exc.read().decode("utf-8", errors="replace")
        try:
            parsed_error = json.loads(response_text)
            message = parsed_error.get("error") if isinstance(parsed_error, dict) else None
        except json.JSONDecodeError:
            message = None
        raise RunnerError(
            f"UnpublishStaticSite failed with HTTP {exc.code}: {message or response_text or exc.reason}",
            code="unpublish_http_error",
        ) from exc
    except urllib_error.URLError as exc:
        raise RunnerError(f"UnpublishStaticSite request failed: {exc.reason}", code="unpublish_request_failed") from exc


def _workspace_from_env(env: dict[str, str]) -> Path:
    raw_workspace = (env.get("ROOMTALK_WORKSPACE") or os.getcwd()).strip()
    return validate_workspace_path(Path(raw_workspace), env)


def _print_result(result: dict[str, Any], *, json_output: bool) -> None:
    if json_output:
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return
    if result.get("success") is True:
        if result.get("tool") == "UnpublishStaticSite":
            print(
                "Unpublished static site: {url}\n"
                "Slug: {slug}\n"
                "Objects deleted: {objectCount}".format(**result)
            )
            return
        if result.get("tool") == "ListStaticSites":
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return
        if result.get("tool") == "PublishStaticSite":
            print(
                "Published static site: {url}\n"
                "Slug: {slug}\n"
                "Entry: {entry}\n"
                "Version: {versionId}\n"
                "Files: {fileCount}\n"
                "Bytes: {totalBytes}".format(**result)
            )
            return
        if result.get("tool") == "RoomContext":
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return
        content = result.get("content")
        print(str(content or "OK"))
        return
    print(f"Error: {result.get('error') or result.get('content') or 'RoomTalk tool failed'}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
