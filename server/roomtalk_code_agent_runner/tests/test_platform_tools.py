from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from roomtalk_code_agent_runner import platform_tools


def test_publish_static_site_command_posts_roomtalk_payload(tmp_path: Path, monkeypatch, capsys):
    workspace = tmp_path / "workspace"
    site = workspace / "site"
    site.mkdir(parents=True)
    (site / "index.html").write_text("<!doctype html><h1>Codex</h1>", encoding="utf-8")
    posted: dict[str, Any] = {}

    def fake_post(url: str, token: str, payload: dict[str, Any]):
        posted["url"] = url
        posted["token"] = token
        posted["payload"] = payload
        return {
            "url": "https://room.example/p/codex-demo/",
            "slug": "codex-demo",
            "entry": "index.html",
            "versionId": "version-1",
            "fileCount": 1,
            "totalBytes": 29,
        }

    monkeypatch.setattr(platform_tools, "_post_static_publish_payload", fake_post)
    monkeypatch.setenv("CODE_AGENT_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("ROOMTALK_WORKSPACE", str(workspace))
    monkeypatch.setenv("ROOMTALK_CODE_AGENT_ROOM_ID", "room-1")
    monkeypatch.setenv("ROOMTALK_CODE_AGENT_TURN_ID", "turn-1")
    monkeypatch.setenv("ROOMTALK_STATIC_PUBLISH_URL", "https://room.example/api/code-agent/publish-static-site")
    monkeypatch.setenv("ROOMTALK_STATIC_PUBLISH_TOKEN", "turn-token")

    exit_code = platform_tools.main([
        "publish-static-site",
        "--root",
        "site",
        "--entry",
        "index.html",
        "--title",
        "Codex demo",
        "--json",
    ])

    assert exit_code == 0
    output = json.loads(capsys.readouterr().out)
    assert output["url"] == "https://room.example/p/codex-demo/"
    assert posted["url"] == "https://room.example/api/code-agent/publish-static-site"
    assert posted["token"] == "turn-token"
    assert posted["payload"]["roomId"] == "room-1"
    assert posted["payload"]["turnId"] == "turn-1"
    assert posted["payload"]["entry"] == "index.html"
    assert posted["payload"]["title"] == "Codex demo"
    assert [file["path"] for file in posted["payload"]["files"]] == ["index.html"]


def test_publish_static_site_is_rejected_by_read_only_cli_access(monkeypatch, capsys):
    monkeypatch.setenv("ROOMTALK_CODE_AGENT_CLI_ACCESS", "read-only")

    assert platform_tools.main(["publish-static-site", "--json"]) == 1
    assert json.loads(capsys.readouterr().out)["code"] == "roomtalk_cli_read_only"


@pytest.mark.parametrize(("argv", "expected_suffix"), [
    (["room", "history", "--limit", "12", "--before", "m-20", "--json"], "/history?limit=12&beforeMessageId=m-20"),
    (["room", "delta", "--since", "m-10", "--limit", "30", "--json"], "/delta?sinceMessageId=m-10&limit=30"),
    (["room", "search", "--query", "deploy failed", "--limit", "8", "--json"], "/search?query=deploy+failed&limit=8"),
    (["room", "message", "message/with space", "--json"], "/messages/message%2Fwith%20space"),
])
def test_room_context_commands_use_scoped_api(argv, expected_suffix, monkeypatch, capsys):
    requested: dict[str, str] = {}

    def fake_get(url: str, token: str):
        requested["url"] = url
        requested["token"] = token
        return {"success": True, "tool": "RoomContext", "messages": []}

    monkeypatch.setattr(platform_tools, "_get_room_context", fake_get)
    monkeypatch.setenv("ROOMTALK_ROOM_CONTEXT_URL", "https://room.example/api/code-agent/room-context")
    monkeypatch.setenv("ROOMTALK_ROOM_CONTEXT_TOKEN", "room-token")

    assert platform_tools.main(argv) == 0
    assert requested["url"] == f"https://room.example/api/code-agent/room-context{expected_suffix}"
    assert requested["token"] == "room-token"
    assert json.loads(capsys.readouterr().out)["tool"] == "RoomContext"


def test_room_context_command_fails_without_turn_token(capsys, monkeypatch):
    monkeypatch.delenv("ROOMTALK_ROOM_CONTEXT_URL", raising=False)
    monkeypatch.delenv("ROOMTALK_ROOM_CONTEXT_TOKEN", raising=False)
    assert platform_tools.main(["room", "history", "--json"]) == 1
    assert json.loads(capsys.readouterr().out)["code"] == "room_context_unavailable"


def test_background_shell_command_is_not_exposed(capsys):
    with pytest.raises(SystemExit) as exc:
        platform_tools.main(["background-shell", "list"])

    assert exc.value.code == 2
    assert "invalid choice" in capsys.readouterr().err
