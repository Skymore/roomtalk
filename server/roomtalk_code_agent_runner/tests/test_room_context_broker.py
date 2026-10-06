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
