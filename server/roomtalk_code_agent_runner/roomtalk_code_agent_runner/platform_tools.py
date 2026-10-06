from __future__ import annotations

import argparse
import base64
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

from .constants import ROOMTALK_CODE_AGENT_USER_AGENT
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
        elif args.command == "site" and args.site_command == "versions":
            result = _list_static_site_versions(args, env)
        elif args.command == "site" and args.site_command == "activate":
            _require_write_access(env)
            result = _activate_static_site_version(args, env)
        elif args.command == "site" and args.site_command == "unpublish":
            _require_write_access(env)
            result = _unpublish_static_site(args, env)
        elif args.command == "room":
            result = _read_room_context(args, env)
        elif args.command == "watch":
            if args.watch_command != "list":
                _require_write_access(env)
            result = _personal_watch(args, env)
        elif args.command == "updates":
            if args.updates_command == "read":
                _require_write_access(env)
            result = _personal_updates(args, env)
        elif args.command == "idea":
            if args.idea_command == "propose":
                _require_write_access(env)
            result = _personal_idea(args, env)
        elif args.command == "browser":
            _require_write_access(env)
            result = _personal_browser(args, env)
        elif args.command == "google":
            operation = args.google_command
            query = {"operation": operation}
            for key in ("id", "query", "calendarId", "timeMin", "timeMax"):
                value = getattr(args, key, None)
                if value is not None:
                    query[key] = value
            if operation in ("save-draft", "propose"):
                _require_write_access(env)
                body = {"operation": operation, "data": json.loads(Path(args.file).read_text(encoding="utf-8"))}
                result = _read_room_context_path("/personal-google", env, method="PATCH", body=body)
            elif operation == "import-attachment":
                _require_write_access(env)
                result = _read_room_context_path("/personal-google", env, method="PATCH", body={"operation": operation, "reference": args.reference})
            else:
                result = _read_room_context_path("/personal-google?" + urllib_parse.urlencode(query), env)
            result = {"success": True, **result, "tool": "PersonalGoogle"}
        elif args.command == "task":
            operation = args.task_command
            if operation in ("request-input", "delegate", "control"):
                _require_write_access(env)
                if operation == "control":
                    body = {"operation": operation, "id": args.id, "action": args.action}
                else:
                    payload = json.loads(Path(args.file).read_text(encoding="utf-8"))
                    body = {"operation": operation, "data": payload} if operation == "delegate" else payload
                result = _read_room_context_path("/personal-task", env, method="PATCH", body=body)
            else:
                query = {"operation": operation}
                if getattr(args, "id", None):
                    query["id"] = args.id
                result = _read_room_context_path("/personal-task?" + urllib_parse.urlencode(query), env)
            result = {"success": True, **result, "tool": "PersonalTask"}
        elif args.command == "computer":
            result = _personal_computer(args, env)
        elif args.command == "file":
            if args.file_command != "list":
                _require_write_access(env)
            result = _personal_file(args, env)
        elif args.command == "result":
            if args.result_command in ("save", "get"):
                _require_write_access(env)
            result = _personal_result(args, env)
        elif args.command == "goal":
            if args.goal_command != "list":
                _require_write_access(env)
            result = _personal_goal(args, env)
        elif args.command == "memory":
            if args.memory_command in ("set", "save", "forget", "merge"):
                _require_write_access(env)
            result = _personal_memory(args, env)
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

    site = subparsers.add_parser("site", help="Publish and manage versioned RoomTalk static sites.")
    site_subparsers = site.add_subparsers(dest="site_command", required=True)
    site_list = site_subparsers.add_parser("list", help="List static sites published by the current room.")
    site_list.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
    site_publish = site_subparsers.add_parser("publish", help="Publish a static HTML/CSS/JS directory.")
    _add_publish_arguments(site_publish)
    site_versions = site_subparsers.add_parser("versions", help="List every retained version of one published site.")
    site_versions.add_argument("--slug", required=True, help="Stable site slug whose versions should be listed.")
    site_versions.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
    site_activate = site_subparsers.add_parser("activate", help="Point a site's stable URL at a retained version.")
    site_activate.add_argument("--slug", required=True, help="Stable site slug to update.")
    site_activate.add_argument("--version", required=True, help="Version ID to activate at the stable site URL.")
    site_activate.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
    site_unpublish = site_subparsers.add_parser("unpublish", help="Take a published static site offline.")
    site_unpublish.add_argument("--slug", required=True, help="Published site URL slug to take offline.")
    site_unpublish.add_argument("--json", action="store_true", help="Print machine-readable JSON.")

    watch = subparsers.add_parser("watch", help="Track real pages and conditions in a separate saved browser.")
    watch_sub = watch.add_subparsers(dest="watch_command", required=True)
    watch_create = watch_sub.add_parser("create")
    watch_create.add_argument("--title", required=True)
    watch_create.add_argument("--url", required=True)
    watch_create.add_argument("--condition", choices=("change", "contains", "price_below"), required=True)
    watch_create.add_argument("--value", default="")
    watch_create.add_argument("--interval-minutes", type=int, default=15)
    watch_create.add_argument("--json", action="store_true")
    for action in ("pause", "resume", "check", "stop", "remove"):
        command = watch_sub.add_parser(action)
        command.add_argument("--id", required=True)
        if action != "remove":
            command.add_argument("--expected-updated-at", required=True)
        command.add_argument("--json", action="store_true")
    listing = watch_sub.add_parser("list")
    listing.add_argument("--id")
    listing.add_argument("--limit", type=int, default=50)
    listing.add_argument("--offset", type=int, default=0)
    listing.add_argument("--json", action="store_true")
    updates = subparsers.add_parser("updates", help="Read persistent task and page updates.")
    updates_sub = updates.add_subparsers(dest="updates_command", required=True)
    listing = updates_sub.add_parser("list")
    listing.add_argument("--unread", action="store_true")
    listing.add_argument("--limit", type=int, default=50)
    listing.add_argument("--offset", type=int, default=0)
    listing.add_argument("--json", action="store_true")
    read_update = updates_sub.add_parser("read")
    read_update.add_argument("--id", required=True)
    read_update.add_argument("--json", action="store_true")

    idea = subparsers.add_parser("idea", help="Propose useful work with a saved personal source.")
    idea_sub = idea.add_subparsers(dest="idea_command", required=True)
    propose = idea_sub.add_parser("propose")
    propose.add_argument("--source-kind", choices=("goal", "memory", "result", "browser"), required=True)
    for field in ("source-id", "title", "reason", "prompt"):
        propose.add_argument("--" + field, required=True)
    propose.add_argument("--json", action="store_true")
    listing = idea_sub.add_parser("list")
    listing.add_argument("--status", choices=("new", "accepted", "dismissed", "all"), default="new")
    listing.add_argument("--limit", type=int, default=50)
    listing.add_argument("--offset", type=int, default=0)
    listing.add_argument("--json", action="store_true")

    computer = subparsers.add_parser("computer", help="Use the personal computer's real terminal, files and desktop.")
    computer_sub = computer.add_subparsers(dest="computer_command", required=True)
    for name in ("status", "start", "stop", "run", "list", "read", "write", "mkdir", "copy-document", "import-pdf", "desktop", "screenshot"):
        command = computer_sub.add_parser(name)
        command.add_argument("--json", action="store_true")
        if name in ("list", "read", "write", "mkdir", "copy-document", "import-pdf"):
            command.add_argument("--path", default="/workspace" if name == "list" else None, required=name != "list")
        if name in ("write", "desktop"):
            command.add_argument("--file", required=True)
        if name in ("run", "desktop"):
            command.add_argument("--operation-id", required=True, help="Reuse only for an exact duplicate request.")
        if name == "run":
            command.add_argument("--command", dest="shell_command", required=True)
            command.add_argument("--cwd", default="/workspace")
        if name in ("desktop", "screenshot"):
            command.add_argument("--output", required=True, help="Save the actual screenshot inside the runner workspace.")
        if name == "screenshot":
            command.add_argument("--receipt-id")
        if name == "copy-document":
            command.add_argument("--file-id", required=True)

    google = subparsers.add_parser("google", help="Read connected Gmail/Calendar and prepare reviewed actions.")
    google_sub = google.add_subparsers(dest="google_command", required=True)
    for name in ("status", "mail", "thread", "message", "calendars", "events", "drafts", "actions", "save-draft", "propose", "import-attachment"):
        command = google_sub.add_parser(name)
        command.add_argument("--json", action="store_true")
        if name in ("save-draft", "propose"):
            command.add_argument("--file", required=True)
        if name in ("thread", "message"):
            command.add_argument("--id", required=True)
        if name == "mail":
            command.add_argument("--query")
        if name == "import-attachment":
            command.add_argument("--reference", required=True)
        if name == "events":
            command.add_argument("--calendar-id", dest="calendarId")
            command.add_argument("--time-min", dest="timeMin")
            command.add_argument("--time-max", dest="timeMax")

    task = subparsers.add_parser("task", help="Delegate, inspect and control saved personal tasks.")
    task_sub = task.add_subparsers(dest="task_command", required=True)
    for name in ("list", "get", "delegate", "control", "request-input"):
        command = task_sub.add_parser(name)
        command.add_argument("--json", action="store_true")
        if name == "get":
            command.add_argument("--id", help="Task room id; defaults to this task")
        if name == "delegate":
            command.add_argument("--file", required=True, help="JSON {prompt,title?,kind?:agent|plan|document|finance,goalId?,input?:{csv?,messageId?}}")
        if name == "control":
            command.add_argument("--id", required=True)
            command.add_argument("--action", required=True, choices=("pause", "resume", "retry", "cancel"))
        if name == "request-input":
            command.add_argument("--file", required=True, help="JSON {question,fileId?,fields?: [actual PDF field names]}")

    browser = subparsers.add_parser("browser", help="Read and operate your personal agent's actual shared browser.")
    browser_sub = browser.add_subparsers(dest="browser_command", required=True)
    for action in ("create", "sessions", "open", "read", "click", "fill", "text", "key", "scroll", "close", "list", "import_pdf"):
        command = browser_sub.add_parser(action)
        command.add_argument("--json", action="store_true")
        if action == "import_pdf": command.add_argument("--id", required=True)
        if action in ("open","create"): command.add_argument("--url", required=True)
        if action not in ("list","sessions","create"): command.add_argument("--session-id")
        if action in ("click", "fill"): command.add_argument("--selector", required=True)
        if action in ("fill", "text"): command.add_argument("--text", required=True)
        if action == "key": command.add_argument("--key", required=True)
        if action == "scroll": command.add_argument("--delta-y", type=int, required=True)
        if action == "list":
            command.add_argument("--room-id")
            command.add_argument("--limit", type=int, default=50)
            command.add_argument("--offset", type=int, default=0)

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

    memory = subparsers.add_parser("memory", help="Read or update your personal agent's persistent memory.")
    memory_subparsers = memory.add_subparsers(dest="memory_command", required=True)
    memory_get = memory_subparsers.add_parser("get", help="Read the latest personal memory and its update timestamp.")
    memory_get.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
    memory_set = memory_subparsers.add_parser("set", help="Replace personal memory using its last read update timestamp.")
    memory_set.add_argument("--file", required=True, help="UTF-8 file containing the complete updated memory.")
    memory_set.add_argument("--expected-updated-at", required=True, help="updatedAt returned by memory get.")
    memory_set.add_argument("--json", action="store_true", help="Print machine-readable JSON.")

    memory_list = memory_subparsers.add_parser("list", help="Read persistent preferences, facts and topic notes.")
    memory_search = memory_subparsers.add_parser("search", help="Find persistent memories by keywords.")
    memory_search.add_argument("--query", required=True)
    for command in (memory_list, memory_search):
        command.add_argument("--id", help="Read one full document by its persistent id.")
        command.add_argument("--kind", choices=("preference", "fact", "topic"))
        command.add_argument("--limit", type=int, default=50)
        command.add_argument("--offset", type=int, default=0)
        command.add_argument("--json", action="store_true")
    memory_save = memory_subparsers.add_parser("save", help="Save one memory or update it using id and expectedUpdatedAt.")
    memory_save.add_argument("--file", required=True, help="JSON with kind, title, content, and optional id/expectedUpdatedAt.")
    memory_save.add_argument("--json", action="store_true")
    memory_merge = memory_subparsers.add_parser("merge", help="Atomically merge reviewed memories and preserve their sources.")
    memory_merge.add_argument("--file", required=True, help="JSON with retained id, kind, title, reviewed content and entries [{id,updatedAt}].")
    memory_merge.add_argument("--json", action="store_true")
    memory_forget = memory_subparsers.add_parser("forget", help="Forget one memory using its last read timestamp.")
    memory_forget.add_argument("--id", required=True)
    memory_forget.add_argument("--expected-updated-at", required=True)
    memory_forget.add_argument("--json", action="store_true")

    file_parser = subparsers.add_parser("file", help="Import, read and fill persistent personal PDFs.")
    file_commands = file_parser.add_subparsers(dest="file_command", required=True)
    file_list = file_commands.add_parser("list")
    file_list.add_argument("--id")
    file_list.add_argument("--limit", type=int, default=50)
    file_list.add_argument("--offset", type=int, default=0)
    file_list.add_argument("--json", action="store_true")
    file_import = file_commands.add_parser("import")
    file_import.add_argument("--file", required=True, help="An existing PDF, at most 10 MiB.")
    file_import.add_argument("--json", action="store_true")
    file_get = file_commands.add_parser("get")
    file_get.add_argument("--id", required=True)
    file_get.add_argument("--output", required=True)
    file_get.add_argument("--json", action="store_true")
    file_fill = file_commands.add_parser("fill")
    file_fill.add_argument("--id", required=True)
    file_fill.add_argument("--fields-json", required=True, help="JSON object of confirmed PDF field values.")
    file_fill.add_argument("--json", action="store_true")

    result = subparsers.add_parser("result", help="Save and reopen private persistent plans, documents and web results.")
    result_commands = result.add_subparsers(dest="result_command", required=True)
    result_save = result_commands.add_parser("save")
    result_save.add_argument("--file", required=True, help="An existing file, at most 4 MiB; text at most 512 KiB.")
    result_save.add_argument("--kind", required=True, choices=("plan", "document", "web", "comparison", "finance"))
    result_save.add_argument("--title", required=True)
    result_save.add_argument("--summary", default="")
    result_save.add_argument("--json", action="store_true")
    result_list = result_commands.add_parser("list")
    result_list.add_argument("--id")
    result_list.add_argument("--room-id")
    result_list.add_argument("--limit", type=int, default=50)
    result_list.add_argument("--offset", type=int, default=0)
    result_list.add_argument("--json", action="store_true")
    result_get = result_commands.add_parser("get")
    result_get.add_argument("--id", required=True)
    result_get.add_argument("--output", required=True, help="Write the persisted file to this workspace path.")
    result_get.add_argument("--json", action="store_true")

    goal = subparsers.add_parser("goal", help="Manage personal goals and durable background work.")
    goal_commands = goal.add_subparsers(dest="goal_command", required=True)
    goal_list = goal_commands.add_parser("list", help="Read goals, milestones, schedule and actual latest run status.")
    goal_list.add_argument("--id")
    goal_list.add_argument("--limit", type=int, default=20)
    goal_list.add_argument("--offset", type=int, default=0)
    goal_list.add_argument("--json", action="store_true")
    for action in ("create", "update"):
        command = goal_commands.add_parser(action)
        command.add_argument("--file", required=True, help="JSON goal fields; update requires id and expectedUpdatedAt.")
        command.add_argument("--json", action="store_true")
    for action in ("run", "pause", "resume", "cancel", "delete"):
        command = goal_commands.add_parser(action)
        command.add_argument("--id", required=True)
        if action != "run":
            command.add_argument("--expected-updated-at", required=True)
        command.add_argument("--json", action="store_true")

    return parser


def _add_publish_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--root", default=".", help="Static site directory, relative to the workspace.")
    parser.add_argument("--entry", default="index.html", help="Entry file relative to --root.")
    parser.add_argument(
        "--slug",
        required=True,
        help="Required stable URL slug. Reuse the same slug to publish a new version of an existing site.",
    )
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


def _personal_computer(args: argparse.Namespace, env: dict[str, str]) -> dict[str, Any]:
    operation = args.computer_command
    read = operation in ("status", "list", "read", "screenshot")
    body: dict[str, Any] = {"operation": operation}
    for flag, key in (("path", "path"), ("receipt_id", "receiptId"), ("file_id", "fileId"), ("operation_id", "operationId")):
        value = getattr(args, flag, None)
        if value is not None:
            body[key] = value
    if operation == "run":
        body.update(command=args.shell_command, cwd=args.cwd)
    elif operation == "write":
        body["text"] = Path(args.file).read_text(encoding="utf-8")
    elif operation == "desktop":
        body["action"] = json.loads(Path(args.file).read_text(encoding="utf-8"))
    if read:
        result = _read_room_context_path("/personal-computer?" + urllib_parse.urlencode(body), env)
    else:
        _require_write_access(env)
        result = _read_room_context_path("/personal-computer", env, method="PATCH", body=body)
    if operation in ("desktop", "screenshot"):
        content = result.pop("data", None)
        if content:
            target = validate_workspace_path(Path(args.output).expanduser().absolute(), env)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(base64.b64decode(content, validate=True))
            result["screenshot"] = str(target)
            result["inspectWith"] = "view_image"
    return {"success": True, **result, "tool": "PersonalComputer"}


def _personal_file(args: argparse.Namespace, env: dict[str, str]) -> dict[str, Any]:
    action = args.file_command
    if action == "list":
        query = {"limit": args.limit, "offset": args.offset}
        if args.id:
            query["id"] = args.id
        result = _read_room_context_path("/personal-files?" + urllib_parse.urlencode(query), env)
    elif action == "get":
        result = _read_room_context_path("/personal-files?" + urllib_parse.urlencode({"id": args.id, "content": "true"}), env)
        target = validate_workspace_path(Path(args.output).expanduser().absolute(), env)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.b64decode(result.pop("content"), validate=True))
        result["output"] = str(target)
    elif action == "fill":
        fields = json.loads(args.fields_json)
        if not isinstance(fields, dict):
            raise RunnerError("PDF fields must be a JSON object", code="personal_file_invalid")
        result = _read_room_context_path("/personal-files", env, method="PATCH", body={"action": "fill", "id": args.id, "fields": fields})
    else:
        source = Path(args.file)
        if source.stat().st_size > 10 * 1024 * 1024:
            raise RunnerError("PDF files are limited to 10 MiB", code="personal_file_invalid")
        result = _read_room_context_path("/personal-files", env, method="PATCH", body={
            "action": "import", "name": source.name, "content": base64.b64encode(source.read_bytes()).decode("ascii"),
        })
    return {**result, "tool": "PersonalFile"}


def _personal_result(args: argparse.Namespace, env: dict[str, str]) -> dict[str, Any]:
    if args.result_command == "save":
        source = Path(args.file)
        if source.stat().st_size > 4 * 1024 * 1024:
            raise RunnerError("Results are limited to 4 MiB", code="personal_result_invalid")
        result = _read_room_context_path("/personal-results", env, method="PATCH", body={
            "kind": args.kind, "title": args.title, "summary": args.summary,
            "filename": source.name, "content": base64.b64encode(source.read_bytes()).decode("ascii"),
        })
    elif args.result_command == "get":
        result = _read_room_context_path(f"/personal-results?{urllib_parse.urlencode({'id': args.id, 'content': 'true'})}", env)
        target = validate_workspace_path(Path(args.output).expanduser().absolute(), env)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.b64decode(result.pop("content"), validate=True))
        result["output"] = str(target)
    else:
        query = {"limit": args.limit, "offset": args.offset}
        if args.id:
            query["id"] = args.id
        if args.room_id:
            query["roomId"] = args.room_id
        result = _read_room_context_path(f"/personal-results?{urllib_parse.urlencode(query)}", env)
    return {**result, "tool": "PersonalResult"}


def _personal_goal(args: argparse.Namespace, env: dict[str, str]) -> dict[str, Any]:
    if args.goal_command == "list":
        query = {"limit": args.limit, "offset": args.offset}
        if args.id:
            query["id"] = args.id
        result = _read_room_context_path(f"/personal-goals?{urllib_parse.urlencode(query)}", env)
    else:
        if args.goal_command in ("create", "update"):
            payload = json.loads(Path(args.file).read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                raise RunnerError("Goal file must contain a JSON object", code="personal_goal_invalid")
        else:
            payload = {"id": args.id}
            if args.goal_command != "run":
                payload["expectedUpdatedAt"] = args.expected_updated_at
        result = _read_room_context_path("/personal-goals", env, method="PATCH", body={**payload, "action": args.goal_command})
    return {**result, "tool": "PersonalGoal"}


def _personal_memory(args: argparse.Namespace, env: dict[str, str]) -> dict[str, Any]:
    if args.memory_command in ("list", "search"):
        query = {"limit": args.limit, "offset": args.offset}
        if args.id:
            query["id"] = args.id
        if args.kind:
            query["kind"] = args.kind
        if args.memory_command == "search":
            query["query"] = args.query
        result = _read_room_context_path(f"/personal-memory/records?{urllib_parse.urlencode(query)}", env)
    elif args.memory_command in ("save", "merge"):
        payload = json.loads(Path(args.file).read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise RunnerError("Memory file must contain a JSON object", code="personal_memory_invalid")
        result = _read_room_context_path("/personal-memory/records", env, method="PATCH", body={**payload, "action": args.memory_command})
    elif args.memory_command == "forget":
        result = _read_room_context_path("/personal-memory/records", env, method="PATCH", body={
            "action": "forget", "id": args.id, "expectedUpdatedAt": args.expected_updated_at,
        })
    elif args.memory_command == "set":
        memory = Path(args.file).read_text(encoding="utf-8")
        if len(memory) > 16_000:
            raise RunnerError("Personal memory is limited to 16000 characters", code="personal_memory_invalid")
        result = _read_room_context_path("/personal-memory", env, method="PATCH", body={
            "memory": memory, "expectedUpdatedAt": args.expected_updated_at,
        })
    else:
        result = _read_room_context_path("/personal-memory", env)
    return {**result, "tool": "PersonalMemory"}


def _personal_watch(args: argparse.Namespace, env: dict[str, str]) -> dict[str, Any]:
    action = args.watch_command
    if action == "list":
        query = {"limit": args.limit, "offset": args.offset}
        if args.id:
            query["id"] = args.id
        result = _read_room_context_path("/personal-watches?" + urllib_parse.urlencode(query), env)
    else:
        if action == "create":
            body = {"action": action, "title": args.title, "url": args.url, "condition": args.condition,
                    "value": args.value, "intervalMinutes": args.interval_minutes}
        else:
            body = {"action": action, "id": args.id}
            if action != "remove":
                body["expectedUpdatedAt"] = args.expected_updated_at
        result = _read_room_context_path("/personal-watches", env, method="PATCH", body=body)
    return {**result, "tool": "PersonalWatch"}


def _personal_updates(args: argparse.Namespace, env: dict[str, str]) -> dict[str, Any]:
    if args.updates_command == "read":
        result = _read_room_context_path("/personal-notifications", env, method="PATCH", body={"id": args.id})
    else:
        query = {"unread": str(args.unread).lower(), "limit": args.limit, "offset": args.offset}
        result = _read_room_context_path("/personal-notifications?" + urllib_parse.urlencode(query), env)
    return {**result, "tool": "PersonalUpdates"}


def _personal_idea(args: argparse.Namespace, env: dict[str, str]) -> dict[str, Any]:
    if args.idea_command == "propose":
        result = _read_room_context_path("/personal-ideas", env, method="PATCH", body={
            "sourceKind": args.source_kind, "sourceId": args.source_id,
            "title": args.title, "reason": args.reason, "prompt": args.prompt,
        })
    else:
        query = {"status": args.status, "limit": args.limit, "offset": args.offset}
        result = _read_room_context_path("/personal-ideas?" + urllib_parse.urlencode(query), env)
    return {**result, "tool": "PersonalIdea"}


def _personal_browser(args: argparse.Namespace, env: dict[str, str]) -> dict[str, Any]:
    if args.browser_command == "sessions":
        result = _read_room_context_path("/personal-browser?operation=sessions", env)
    elif args.browser_command == "list":
        query = {"limit": args.limit, "offset": args.offset}
        if args.room_id: query["roomId"] = args.room_id
        result = _read_room_context_path("/personal-browser?" + urllib_parse.urlencode(query), env)
    else:
        body = {"action": args.browser_command}
        if getattr(args,"session_id",None): body["sessionId"] = args.session_id
        for key in ("url", "selector", "text", "key", "delta_y", "id"):
            if hasattr(args, key): body["deltaY" if key == "delta_y" else key] = getattr(args, key)
        result = _read_room_context_path("/personal-browser", env, method="PATCH", body=body)
    return {**result, "tool": "PersonalBrowser"}


def _read_room_context_path(path: str, env: dict[str, str], *, method: str = "GET", body: dict[str, Any] | None = None) -> dict[str, Any]:
    base_url = (env.get("ROOMTALK_ROOM_CONTEXT_URL") or "").strip().rstrip("/")
    token = (env.get("ROOMTALK_ROOM_CONTEXT_TOKEN") or "").strip()
    socket_path = (env.get("ROOMTALK_ROOM_CONTEXT_SOCKET") or "").strip()
    if not socket_path and (not base_url or not token):
        raise RunnerError("Room context is not available for this turn", code="room_context_unavailable")

    if socket_path:
        return _get_room_context_from_broker(socket_path, path, method=method, body=body)
    return _get_room_context(f"{base_url}{path}", token, method=method, body=body)


def _list_static_sites(env: dict[str, str]) -> dict[str, Any]:
    result = _read_room_context_path("/sites", env)
    return {**result, "tool": "ListStaticSites"}


def _list_static_site_versions(args: argparse.Namespace, env: dict[str, str]) -> dict[str, Any]:
    result = _read_room_context_path("/sites", env)
    sites = result.get("sites")
    if not isinstance(sites, list):
        raise RunnerError("Published site list response was incomplete", code="invalid_site_list_response")
    slug = str(args.slug).strip()
    site = next((item for item in sites if isinstance(item, dict) and item.get("slug") == slug), None)
    if not isinstance(site, dict):
        raise RunnerError(f"Published site not found: {slug}", code="published_site_not_found")
    versions = site.get("versions")
    if not isinstance(versions, list):
        raise RunnerError("Published site version history was unavailable", code="site_versions_unavailable")
    return {
        "success": True,
        "tool": "ListStaticSiteVersions",
        "slug": slug,
        "url": site.get("url") or "",
        "currentVersionId": site.get("versionId") or "",
        "versions": versions,
    }


def _get_room_context_from_broker(socket_path: str, path: str, *, method: str = "GET", body: dict[str, Any] | None = None) -> dict[str, Any]:
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(30)
            client.connect(socket_path)
            request = {"path": path, **({"method": method, "body": body} if method != "GET" else {})}
            client.sendall((json.dumps(request, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
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


def _get_room_context(url: str, token: str, *, method: str = "GET", body: dict[str, Any] | None = None) -> dict[str, Any]:
    request = urllib_request.Request(url, method=method, data=(
        json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    ), headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        **({"Content-Type": "application/json"} if body is not None else {}),
        "User-Agent": ROOMTALK_CODE_AGENT_USER_AGENT,
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
    room_id = (env.get("ROOMTALK_CODE_AGENT_ROOM_ID") or "").strip()
    turn_id = (env.get("ROOMTALK_CODE_AGENT_TURN_ID") or "").strip()
    if not publish_url or not _has_static_publish_credentials(env):
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

    publish_token = _resolve_static_publish_token(env)
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
            connection.putheader("User-Agent", ROOMTALK_CODE_AGENT_USER_AGENT)
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
    if not publish_url or not _has_static_publish_credentials(env):
        raise RunnerError("Static site management is not available for this turn", code="unpublish_unavailable")

    publish_token = _resolve_static_publish_token(env)
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


def _activate_static_site_version(args: argparse.Namespace, env: dict[str, str]) -> dict[str, Any]:
    publish_url = (env.get("ROOMTALK_STATIC_PUBLISH_URL") or "").strip()
    if not publish_url or not _has_static_publish_credentials(env):
        raise RunnerError("Static site management is not available for this turn", code="activate_version_unavailable")

    publish_token = _resolve_static_publish_token(env)
    response = _post_static_publish_payload(
        f"{publish_url.rstrip('/')}/activate",
        publish_token,
        {"slug": str(args.slug).strip(), "versionId": str(args.version).strip()},
    )
    slug = response.get("slug")
    version_id = response.get("versionId")
    url = response.get("url")
    if not isinstance(slug, str) or not slug or not isinstance(version_id, str) or not version_id or not isinstance(url, str) or not url:
        raise RunnerError("Static site version activation response was incomplete", code="invalid_activate_version_response")
    return {
        "success": True,
        "tool": "ActivateStaticSiteVersion",
        "url": url,
        "versionUrl": response.get("versionUrl") or "",
        "slug": slug,
        "versionId": version_id,
    }


def _has_static_publish_credentials(env: dict[str, str]) -> bool:
    access_token = (env.get("ROOMTALK_STATIC_PUBLISH_TOKEN") or "").strip()
    refresh_url = (env.get("ROOMTALK_STATIC_PUBLISH_REFRESH_URL") or "").strip()
    refresh_token = (env.get("ROOMTALK_STATIC_PUBLISH_REFRESH_TOKEN") or "").strip()
    return bool(access_token or (refresh_url and refresh_token))


def _resolve_static_publish_token(env: dict[str, str]) -> str:
    refresh_url = (env.get("ROOMTALK_STATIC_PUBLISH_REFRESH_URL") or "").strip()
    refresh_token = (env.get("ROOMTALK_STATIC_PUBLISH_REFRESH_TOKEN") or "").strip()
    if refresh_url or refresh_token:
        if not refresh_url or not refresh_token:
            raise RunnerError("Static site publish refresh metadata is incomplete", code="publish_refresh_unavailable")
        response = _post_static_publish_payload(refresh_url, refresh_token, {})
        token = response.get("token")
        if not isinstance(token, str) or not token:
            raise RunnerError("Static site publish token refresh response was incomplete", code="invalid_publish_refresh_response")
        return token
    token = (env.get("ROOMTALK_STATIC_PUBLISH_TOKEN") or "").strip()
    if not token:
        raise RunnerError("Static site publishing is not available for this turn", code="publish_unavailable")
    return token


def _delete_static_publish_payload(url: str, token: str, payload: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = urllib_request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": ROOMTALK_CODE_AGENT_USER_AGENT,
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
        if result.get("tool") == "ListStaticSiteVersions":
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return
        if result.get("tool") == "ActivateStaticSiteVersion":
            print(
                "Activated static site version: {url}\n"
                "Slug: {slug}\n"
                "Version: {versionId}".format(**result)
            )
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
