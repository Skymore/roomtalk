from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from roomtalk_coco_runner import platform_tools


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
    monkeypatch.setenv("COCO_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("ROOMTALK_WORKSPACE", str(workspace))
    monkeypatch.setenv("ROOMTALK_CODE_AGENT_ROOM_ID", "room-1")
    monkeypatch.setenv("ROOMTALK_CODE_AGENT_TURN_ID", "turn-1")
    monkeypatch.setenv("ROOMTALK_STATIC_PUBLISH_URL", "https://room.example/api/coco/publish-static-site")
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
    assert posted["url"] == "https://room.example/api/coco/publish-static-site"
    assert posted["token"] == "turn-token"
    assert posted["payload"]["roomId"] == "room-1"
    assert posted["payload"]["turnId"] == "turn-1"
    assert posted["payload"]["entry"] == "index.html"
    assert posted["payload"]["title"] == "Codex demo"
    assert [file["path"] for file in posted["payload"]["files"]] == ["index.html"]
