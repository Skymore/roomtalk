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
        elif args.command == "background-shell":
            result = _background_shell(args, env)
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

    background = subparsers.add_parser(
        "background-shell",
        help="Start or manage a tracked long-running background shell command.",
    )
    background.add_argument(
        "action",
        nargs="?",
        default="list",
        choices=("start", "status", "stop", "list"),
        help="Background command action.",
    )
    background.add_argument("--command", default="", help="Foreground command to start in the background.")
    background.add_argument("--cwd", default="", help="Working directory inside the workspace.")
    background.add_argument("--name", default="", help="Human-readable job name.")
    background.add_argument("--port", dest="ports", action="append", type=int, default=[], help="Expected served port. Repeatable.")
    background.add_argument("--job-id", default="", help="Job id for status or stop.")
    background.add_argument("--wait-ms", type=int, default=None, help="Maximum wait time for start/status.")
    background.add_argument("--log-tail-chars", type=int, default=None, help="Recent log characters to include.")
    background.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
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


def _background_shell(args: argparse.Namespace, env: dict[str, str]) -> dict[str, Any]:
    try:
        from core.tools import BackgroundShellTool
    except Exception as exc:
        raise RunnerError("BackgroundShell is not available in this sandbox", code="background_shell_unavailable") from exc

    workspace = _workspace_from_env(env)
    arguments: dict[str, Any] = {"action": args.action}
    if args.command:
        arguments["command"] = args.command
    if args.cwd:
        arguments["cwd"] = args.cwd
    if args.name:
        arguments["name"] = args.name
    if args.ports:
        arguments["ports"] = args.ports
    if args.job_id:
        arguments["job_id"] = args.job_id
    if args.wait_ms is not None:
        arguments["wait_ms"] = args.wait_ms
    if args.log_tail_chars is not None:
        arguments["log_tail_chars"] = args.log_tail_chars

    outcome = BackgroundShellTool(workspace).invoke(arguments)
    return {
        "success": bool(getattr(outcome, "success", False)),
        "tool": "BackgroundShell",
        "content": str(getattr(outcome, "content", "")),
        "metadata": getattr(outcome, "metadata", None) or {},
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
