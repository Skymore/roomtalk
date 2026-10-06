from __future__ import annotations

import json
import socket
import uuid
from pathlib import Path

import pytest

from roomtalk_code_agent_runner import platform_tools, room_context_broker


class FakeResponse:
    def __init__(self, payload: dict):
        self.payload = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self, _limit: int = -1):
        return self.payload


def test_suggestions_cli_uses_private_broker_and_preserves_source_and_page(monkeypatch, capsys):
    calls = []

    def upstream(request, timeout):
        calls.append((request.full_url, request.get_method(), request.headers["Authorization"],
                      json.loads(request.data) if request.data else None))
        return FakeResponse({"ideas": [], "total": 0} if request.get_method() == "GET" else {"idea": {"id": "saved"}})

    monkeypatch.setattr(room_context_broker.urllib_request, "urlopen", upstream)
    env = {"ROOMTALK_ROOM_CONTEXT_URL": "https://room.example/api/code-agent/room-context",
           "ROOMTALK_ROOM_CONTEXT_TOKEN": "private-idea-token",
           "ROOMTALK_ROOM_CONTEXT_BROKER_DIR": f"/tmp/rtb-{uuid.uuid4().hex[:8]}"}
    broker = room_context_broker.start_room_context_broker(env, "turn")
    monkeypatch.setenv("ROOMTALK_ROOM_CONTEXT_SOCKET", env["ROOMTALK_ROOM_CONTEXT_SOCKET"])
    try:
        assert platform_tools.main(["idea", "propose", "--source-kind", "memory", "--source-id", "real-note",
                                    "--title", "Follow up", "--reason", "Saved decision", "--prompt", "Create next steps", "--json"]) == 0
        assert calls[-1][1:] == ("PATCH", "Bearer private-idea-token", {
            "sourceKind": "memory", "sourceId": "real-note", "title": "Follow up", "reason": "Saved decision", "prompt": "Create next steps"})
        output = capsys.readouterr().out
        assert "private-idea-token" not in output
        assert json.loads(output)["tool"] == "PersonalIdea"
        monkeypatch.setenv("ROOMTALK_CODE_AGENT_CLI_ACCESS", "read-only")
        assert platform_tools.main(["idea", "list", "--status", "dismissed", "--limit", "20", "--offset", "50", "--json"]) == 0
        assert calls[-1][0].endswith("/personal-ideas?status=dismissed&limit=20&offset=50")
        capsys.readouterr()
        assert platform_tools.main(["idea", "propose", "--source-kind", "memory", "--source-id", "real-note",
                                    "--title", "Follow up", "--reason", "Saved decision", "--prompt", "Create next steps", "--json"]) == 1
        assert json.loads(capsys.readouterr().out)["code"] == "roomtalk_cli_read_only"
        assert len(calls) == 2
    finally:
        broker.close()


def test_broker_keeps_token_outside_cli_and_proxies_allowed_read(tmp_path: Path, monkeypatch):
    requested: dict[str, str] = {}

    def fake_urlopen(request, timeout):
        requested["url"] = request.full_url
        requested["authorization"] = request.headers["Authorization"]
        requested["timeout"] = str(timeout)
        return FakeResponse({"roomId": "room-1", "messages": []})

    monkeypatch.setattr(room_context_broker.urllib_request, "urlopen", fake_urlopen)
    env = {
        "ROOMTALK_ROOM_CONTEXT_URL": "https://room.example/api/code-agent/room-context",
        "ROOMTALK_ROOM_CONTEXT_TOKEN": "secret-turn-token",
        "ROOMTALK_ROOM_CONTEXT_BROKER_DIR": f"/tmp/rtb-{uuid.uuid4().hex[:8]}",
    }
    broker = room_context_broker.start_room_context_broker(env, "turn-1")
    socket_path = env["ROOMTALK_ROOM_CONTEXT_SOCKET"]
    assert "ROOMTALK_ROOM_CONTEXT_URL" not in env
    assert "ROOMTALK_ROOM_CONTEXT_TOKEN" not in env
    try:
        result = platform_tools._get_room_context_from_broker(socket_path, "/history?limit=20")
        assert result == {"success": True, "tool": "RoomContext", "roomId": "room-1", "messages": []}
        assert requested == {
            "url": "https://room.example/api/code-agent/room-context/history?limit=20",
            "authorization": "Bearer secret-turn-token",
            "timeout": "30",
        }
    finally:
        broker.close()

    assert "ROOMTALK_ROOM_CONTEXT_SOCKET" not in env
    assert env["ROOMTALK_ROOM_CONTEXT_URL"] == "https://room.example/api/code-agent/room-context"
    assert env["ROOMTALK_ROOM_CONTEXT_TOKEN"] == "secret-turn-token"
    assert not Path(socket_path).exists()


def test_broker_rejects_paths_outside_read_only_room_context_api(tmp_path: Path):
    env = {
        "ROOMTALK_ROOM_CONTEXT_URL": "https://room.example/api/code-agent/room-context",
        "ROOMTALK_ROOM_CONTEXT_TOKEN": "secret-turn-token",
        "ROOMTALK_ROOM_CONTEXT_BROKER_DIR": f"/tmp/rtb-{uuid.uuid4().hex[:8]}",
    }
    broker = room_context_broker.start_room_context_broker(env, "turn-1")
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.connect(env["ROOMTALK_ROOM_CONTEXT_SOCKET"])
            client.sendall(b'{"path":"/../publish-static-site"}\n')
            response = json.loads(client.recv(4096).decode("utf-8"))
        assert response["success"] is False
        assert response["code"] == "room_context_broker_path_denied"
    finally:
        broker.close()


def test_broker_allows_read_only_static_site_listing(monkeypatch):
    requested: dict[str, str] = {}

    def fake_urlopen(request, timeout):
        requested["url"] = request.full_url
        requested["authorization"] = request.headers["Authorization"]
        return FakeResponse({"roomId": "room-1", "sites": []})

    monkeypatch.setattr(room_context_broker.urllib_request, "urlopen", fake_urlopen)
    env = {
        "ROOMTALK_ROOM_CONTEXT_URL": "https://room.example/api/code-agent/room-context",
        "ROOMTALK_ROOM_CONTEXT_TOKEN": "secret-turn-token",
        "ROOMTALK_ROOM_CONTEXT_BROKER_DIR": f"/tmp/rtb-{uuid.uuid4().hex[:8]}",
    }
    broker = room_context_broker.start_room_context_broker(env, "turn-1")
    try:
        result = platform_tools._get_room_context_from_broker(env["ROOMTALK_ROOM_CONTEXT_SOCKET"], "/sites")
        assert result["sites"] == []
        assert requested == {
            "url": "https://room.example/api/code-agent/room-context/sites",
            "authorization": "Bearer secret-turn-token",
        }
    finally:
        broker.close()


def test_personal_memory_cli_reads_and_saves_through_private_broker(tmp_path: Path, monkeypatch, capsys):
    memory = "记" * 16_000
    expected_updated_at = "2026-10-05T18:00:00.000Z"
    requests = []

    def fake_urlopen(request, timeout):
        requests.append({
            "method": request.method, "url": request.full_url,
            "authorization": request.headers["Authorization"],
            "body": json.loads(request.data) if request.data else None,
        })
        return FakeResponse({"memory": memory if request.method == "PATCH" else "Seattle", "updatedAt": expected_updated_at})

    monkeypatch.setattr(room_context_broker.urllib_request, "urlopen", fake_urlopen)
    env = {
        "ROOMTALK_ROOM_CONTEXT_URL": "https://room.example/api/code-agent/room-context",
        "ROOMTALK_ROOM_CONTEXT_TOKEN": "secret-turn-token",
        "ROOMTALK_ROOM_CONTEXT_BROKER_DIR": f"/tmp/rtb-{uuid.uuid4().hex[:8]}",
    }
    broker = room_context_broker.start_room_context_broker(env, "turn-1")
    monkeypatch.setenv("ROOMTALK_ROOM_CONTEXT_SOCKET", env["ROOMTALK_ROOM_CONTEXT_SOCKET"])
    monkeypatch.delenv("ROOMTALK_ROOM_CONTEXT_URL", raising=False)
    monkeypatch.delenv("ROOMTALK_ROOM_CONTEXT_TOKEN", raising=False)
    source = tmp_path / "memory.txt"
    source.write_text(memory, encoding="utf-8")
    try:
        assert platform_tools.main(["memory", "get", "--json"]) == 0
        read = json.loads(capsys.readouterr().out)
        assert read["memory"] == "Seattle"
        assert read["updatedAt"] == expected_updated_at
        assert platform_tools.main(["memory", "set", "--file", str(source), "--expected-updated-at", read["updatedAt"], "--json"]) == 0
        saved = json.loads(capsys.readouterr().out)
        assert saved["memory"] == memory
        assert saved["tool"] == "PersonalMemory"
        assert "secret-turn-token" not in json.dumps(saved)
        assert requests == [
            {"method": "GET", "url": "https://room.example/api/code-agent/room-context/personal-memory", "authorization": "Bearer secret-turn-token", "body": None},
            {"method": "PATCH", "url": "https://room.example/api/code-agent/room-context/personal-memory", "authorization": "Bearer secret-turn-token", "body": {"memory": memory, "expectedUpdatedAt": expected_updated_at}},
        ]
    finally:
        broker.close()


@pytest.mark.parametrize("broker_request", [
    {"path": "/history", "method": "PATCH", "body": {}},
    {"path": "/personal-memory", "method": "DELETE"},
])
def test_memory_extension_does_not_allow_other_broker_mutations(broker_request):
    env = {
        "ROOMTALK_ROOM_CONTEXT_URL": "https://room.example/api/code-agent/room-context",
        "ROOMTALK_ROOM_CONTEXT_TOKEN": "secret-turn-token",
        "ROOMTALK_ROOM_CONTEXT_BROKER_DIR": f"/tmp/rtb-{uuid.uuid4().hex[:8]}",
    }
    broker = room_context_broker.start_room_context_broker(env, "turn-1")
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.connect(env["ROOMTALK_ROOM_CONTEXT_SOCKET"])
            client.sendall((json.dumps(broker_request) + "\n").encode("utf-8"))
            response = json.loads(client.recv(4096).decode("utf-8"))
        assert response["success"] is False
        assert response["code"] == "room_context_broker_operation_denied"
    finally:
        broker.close()


def test_tracking_cli_uses_private_broker_for_watches_updates_and_versions(monkeypatch, capsys):
    requests = []

    def fake_fetch(url, token, *, method="GET", body=None):
        requests.append((url, token, method, body))
        return {"watches": [], "notifications": [], "total": 0} if method == "GET" else {"watch": {"id": "w"}}

    monkeypatch.setattr(room_context_broker, "_fetch_room_context", fake_fetch)
    env = {"ROOMTALK_ROOM_CONTEXT_URL": "https://room.example/api/code-agent/room-context",
           "ROOMTALK_ROOM_CONTEXT_TOKEN": "private-tracking-token", "ROOMTALK_ROOM_CONTEXT_BROKER_DIR": f"/tmp/rtb-{uuid.uuid4().hex[:8]}"}
    broker = room_context_broker.start_room_context_broker(env, "tracking-turn")
    try:
        monkeypatch.setenv("ROOMTALK_ROOM_CONTEXT_SOCKET", env["ROOMTALK_ROOM_CONTEXT_SOCKET"])
        assert platform_tools.main(["watch", "create", "--title", "Stock", "--url", "https://example.org/stock",
                                    "--condition", "contains", "--value", "Available", "--interval", "30", "--json"]) == 0
        assert requests[-1][2:] == ("PATCH", {"action": "create", "title": "Stock", "url": "https://example.org/stock",
                                             "condition": "contains", "value": "Available", "intervalMinutes": 30})
        assert "private-tracking-token" not in capsys.readouterr().out
        assert platform_tools.main(["watch", "pause", "--id", "w", "--expected-updated-at", "2026-10-06T12:00:00Z", "--json"]) == 0
        assert requests[-1][3] == {"action": "pause", "id": "w", "expectedUpdatedAt": "2026-10-06T12:00:00Z"}
        capsys.readouterr()
        assert platform_tools.main(["updates", "list", "--unread", "--offset", "50", "--json"]) == 0
        assert requests[-1][0].endswith('/personal-notifications?unread=true&limit=50&offset=50')
        capsys.readouterr()
        assert platform_tools.main(["updates", "read", "--id", "notice", "--json"]) == 0
        assert requests[-1][3] == {"id": "notice"}
        capsys.readouterr()
        monkeypatch.setenv("ROOMTALK_CODE_AGENT_CLI_ACCESS", "read-only")
        assert platform_tools.main(["watch", "remove", "--id", "w", "--json"]) == 1
        assert json.loads(capsys.readouterr().out)["code"] == "roomtalk_cli_read_only"
    finally:
        broker.close()


def test_goal_cli_uses_private_broker_for_revisions_and_owner_scoped_status(tmp_path: Path, monkeypatch, capsys):
    requests = []

    def fake_fetch(url, token, *, method="GET", body=None):
        requests.append((url, token, method, body))
        return {"goals": [{"id": "g", "lastRun": {"status": "running"}}]} if method == "GET" else {"goal": {"id": "g"}}

    monkeypatch.setattr(room_context_broker, "_fetch_room_context", fake_fetch)
    env = {"ROOMTALK_ROOM_CONTEXT_URL": "https://room.example/api/code-agent/room-context",
           "ROOMTALK_ROOM_CONTEXT_TOKEN": "private-goal-token", "ROOMTALK_ROOM_CONTEXT_BROKER_DIR": f"/tmp/rtb-{uuid.uuid4().hex[:8]}"}
    broker = room_context_broker.start_room_context_broker(env, "goal-turn")
    try:
        monkeypatch.setenv("ROOMTALK_ROOM_CONTEXT_SOCKET", env["ROOMTALK_ROOM_CONTEXT_SOCKET"])
        assert platform_tools.main(["goal", "list", "--id", "g", "--json"]) == 0
        assert json.loads(capsys.readouterr().out)["goals"][0]["lastRun"]["status"] == "running"
        assert platform_tools.main(["goal", "cancel", "--id", "g", "--expected-updated-at", "2026-10-06T12:00:00Z", "--json"]) == 0
        assert "private-goal-token" not in capsys.readouterr().out
        assert requests[-1][2:] == ("PATCH", {"id": "g", "expectedUpdatedAt": "2026-10-06T12:00:00Z", "action": "cancel"})
        assert platform_tools.main(["goal", "run", "--id", "g", "--json"]) == 0
        capsys.readouterr()
        source = tmp_path / "goal.json"
        source.write_text(json.dumps({"title": "Review", "prompt": "Review it", "milestones": ["Read", "Summarize"]}))
        assert platform_tools.main(["goal", "create", "--file", str(source), "--json"]) == 0
        capsys.readouterr()
        assert requests[-1][3]["milestones"] == ["Read", "Summarize"]
        monkeypatch.setenv("ROOMTALK_CODE_AGENT_CLI_ACCESS", "read-only")
        assert platform_tools.main(["goal", "delete", "--id", "g", "--expected-updated-at", "2026-10-06T12:00:00Z", "--json"]) == 1
        assert json.loads(capsys.readouterr().out)["code"] == "roomtalk_cli_read_only"
    finally:
        broker.close()


def test_memory_merge_cli_keeps_revisions_and_token_inside_private_broker(tmp_path: Path, monkeypatch, capsys):
    requests = []

    def fake_fetch(url, token, *, method="GET", body=None):
        requests.append((url, token, method, body))
        return {"memories": [{"id": "one", "content": "Full document"}]} if method == "GET" else {"memory": {"id": "one"}}

    monkeypatch.setattr(room_context_broker, "_fetch_room_context", fake_fetch)
    env = {"ROOMTALK_ROOM_CONTEXT_URL": "https://room.example/api/code-agent/room-context",
           "ROOMTALK_ROOM_CONTEXT_TOKEN": "private-topic-token", "ROOMTALK_ROOM_CONTEXT_BROKER_DIR": f"/tmp/rtb-{uuid.uuid4().hex[:8]}"}
    broker = room_context_broker.start_room_context_broker(env, "topic-turn")
    try:
        monkeypatch.setenv("ROOMTALK_ROOM_CONTEXT_SOCKET", env["ROOMTALK_ROOM_CONTEXT_SOCKET"])
        assert platform_tools.main(["memory", "list", "--id", "one", "--json"]) == 0
        assert json.loads(capsys.readouterr().out)["memories"][0]["content"] == "Full document"
        assert "id=one" in requests[-1][0]
        source = tmp_path / "merge.json"
        payload = {"id": "one", "kind": "topic", "title": "Research", "content": "Reviewed decisions and next steps",
                   "entries": [{"id": "one", "updatedAt": "v1"}, {"id": "two", "updatedAt": "v2"}]}
        source.write_text(json.dumps(payload))
        assert platform_tools.main(["memory", "merge", "--file", str(source), "--json"]) == 0
        assert "private-topic-token" not in capsys.readouterr().out
        assert requests[-1][2:] == ("PATCH", {**payload, "action": "merge"})
        monkeypatch.setenv("ROOMTALK_CODE_AGENT_CLI_ACCESS", "read-only")
        assert platform_tools.main(["memory", "merge", "--file", str(source), "--json"]) == 1
        assert json.loads(capsys.readouterr().out)["code"] == "roomtalk_cli_read_only"
        assert len(requests) == 2
    finally:
        broker.close()


def test_large_personal_result_uses_active_private_broker_without_printing_token(tmp_path: Path, monkeypatch, capsys):
    import base64
    requests = []
    content = b"%PDF-1.4\n" + b"x" * 200_000
    source = tmp_path / "report.pdf"
    source.write_bytes(content)
    def fake_fetch(url, token, *, method="GET", body=None):
        requests.append((url, token, method, body))
        return {"result": {"id": "saved", "filename": "report.pdf"}} if method == "PATCH" else {"result": {"id": "saved"}, "content": base64.b64encode(content).decode()}
    monkeypatch.setattr(room_context_broker, "_fetch_room_context", fake_fetch)
    env = {"ROOMTALK_ROOM_CONTEXT_URL": "https://room.example/api/code-agent/room-context", "ROOMTALK_ROOM_CONTEXT_TOKEN": "secret-turn-token",
        "ROOMTALK_ROOM_CONTEXT_BROKER_DIR": f"/tmp/rtb-{uuid.uuid4().hex[:8]}"}
    broker = room_context_broker.start_room_context_broker(env, "turn-1")
    monkeypatch.setenv("ROOMTALK_ROOM_CONTEXT_SOCKET", env["ROOMTALK_ROOM_CONTEXT_SOCKET"])
    monkeypatch.setenv("CODE_AGENT_WORKSPACE_ROOT", str(tmp_path))
    try:
        assert platform_tools.main(["result", "save", "--file", str(source), "--kind", "document", "--title", "Report", "--json"]) == 0
        assert "secret-turn-token" not in capsys.readouterr().out
        assert base64.b64decode(requests[0][3]["content"]) == content
        target = tmp_path / "reopened.pdf"
        assert platform_tools.main(["result", "get", "--id", "saved", "--output", str(target), "--json"]) == 0
        assert target.read_bytes() == content
        assert "secret-turn-token" not in capsys.readouterr().out
    finally:
        broker.close()


def test_browser_cli_uses_live_private_broker_without_exposing_turn_token(monkeypatch, capsys):
    requests = []
    def fake_fetch(url, token, *, method="GET", body=None):
        requests.append((url, token, method, body))
        return {"text": "Actual browser page"} if method == "PATCH" else {"observations": []}
    monkeypatch.setattr(room_context_broker, "_fetch_room_context", fake_fetch)
    env = {"ROOMTALK_ROOM_CONTEXT_URL": "https://room.example/api/code-agent/room-context", "ROOMTALK_ROOM_CONTEXT_TOKEN": "private-browser-turn-token",
        "ROOMTALK_ROOM_CONTEXT_BROKER_DIR": f"/tmp/rtb-{uuid.uuid4().hex[:8]}"}
    broker = room_context_broker.start_room_context_broker(env, "browser-turn")
    monkeypatch.setenv("ROOMTALK_ROOM_CONTEXT_SOCKET", env["ROOMTALK_ROOM_CONTEXT_SOCKET"])
    try:
        assert platform_tools.main(["browser", "open", "--url", "https://example.org", "--json"]) == 0
        assert requests[0] == ("https://room.example/api/code-agent/room-context/personal-browser", "private-browser-turn-token", "PATCH", {"action": "open", "url": "https://example.org"})
        assert "private-browser-turn-token" not in capsys.readouterr().out
        assert platform_tools.main(["browser", "list", "--room-id", "private", "--json"]) == 0
        assert requests[1][2] == "GET"
        assert "/personal-browser?" in requests[1][0]
        assert "roomId=private" in requests[1][0]
        assert "private-browser-turn-token" not in capsys.readouterr().out
    finally:
        broker.close()
