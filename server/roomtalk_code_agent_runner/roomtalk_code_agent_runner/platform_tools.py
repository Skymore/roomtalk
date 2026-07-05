from __future__ import annotations

import argparse
import json
import os
import sys
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
        if args.command == "publish-static-site":
            result = _publish_static_site(args, env)
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


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="roomtalk",
        description="RoomTalk sandbox helper tools for code-agent backends.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    publish = subparsers.add_parser(
        "publish-static-site",
        help="Publish a static HTML/CSS/JS directory to RoomTalk.",
    )
    publish.add_argument("--root", default=".", help="Static site directory, relative to the workspace.")
    publish.add_argument("--entry", default="index.html", help="Entry file relative to --root.")
    publish.add_argument("--slug", default="", help="Optional URL slug.")
    publish.add_argument("--title", default="", help="Optional display title.")
    publish.add_argument("--json", action="store_true", help="Print machine-readable JSON.")

    return parser


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
        "files": files,
    }
    if args.slug:
        payload["slug"] = str(args.slug).strip()
    if args.title:
        payload["title"] = str(args.title).strip()

    response = _post_static_publish_payload(publish_url, publish_token, payload)
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


def _workspace_from_env(env: dict[str, str]) -> Path:
    raw_workspace = (env.get("ROOMTALK_WORKSPACE") or os.getcwd()).strip()
    return validate_workspace_path(Path(raw_workspace), env)


def _print_result(result: dict[str, Any], *, json_output: bool) -> None:
    if json_output:
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return
    if result.get("success") is True:
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
        content = result.get("content")
        print(str(content or "OK"))
        return
    print(f"Error: {result.get('error') or result.get('content') or 'RoomTalk tool failed'}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
