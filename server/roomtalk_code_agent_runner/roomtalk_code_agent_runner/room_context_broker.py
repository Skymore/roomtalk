from __future__ import annotations

import json
import os
import re
import socketserver
import threading
import uuid
from pathlib import Path
from typing import Any, MutableMapping
from urllib import error as urllib_error
from urllib import request as urllib_request

ROOM_CONTEXT_SOCKET_ENV = "ROOMTALK_ROOM_CONTEXT_SOCKET"
MAX_BROKER_REQUEST_BYTES = 16 * 1024
MAX_BROKER_RESPONSE_BYTES = 25 * 1024 * 1024
_ALLOWED_PATH = re.compile(r"^/(?:history|delta|search)(?:\?.*)?$|^/messages/[^/?]+$|^/sites$")


class RoomContextBrokerError(Exception):
    def __init__(self, message: str, *, code: str):
        super().__init__(message)
        self.code = code


def _fetch_room_context(url: str, token: str) -> dict[str, Any]:
    request = urllib_request.Request(url, method="GET", headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": "roomtalk-code-agent-runner/1",
    })
    try:
        with urllib_request.urlopen(request, timeout=30) as response:
            raw = response.read(MAX_BROKER_RESPONSE_BYTES + 1)
    except urllib_error.HTTPError as exc:
        try:
            payload = json.loads(exc.read(MAX_BROKER_RESPONSE_BYTES + 1).decode("utf-8"))
        except Exception:
            payload = {}
        message = payload.get("error") if isinstance(payload, dict) else None
        code = payload.get("code") if isinstance(payload, dict) else None
        raise RoomContextBrokerError(
            str(message or f"Room context request failed with HTTP {exc.code}"),
            code=str(code or "room_context_request_failed"),
        ) from exc
    except Exception as exc:
        raise RoomContextBrokerError(f"Room context request failed: {exc}", code="room_context_request_failed") from exc
    if len(raw) > MAX_BROKER_RESPONSE_BYTES:
        raise RoomContextBrokerError("Room context response is too large", code="room_context_response_too_large")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise RoomContextBrokerError("Room context response is not valid JSON", code="invalid_room_context_response") from exc
    if not isinstance(payload, dict):
        raise RoomContextBrokerError("Room context response was not a JSON object", code="invalid_room_context_response")
    return payload


class _BrokerServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True

    def __init__(self, socket_path: str, base_url: str, token: str):
        self.base_url = base_url.rstrip("/")
        self.token = token
        super().__init__(socket_path, _BrokerHandler)


class _BrokerHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        try:
            raw = self.rfile.readline(MAX_BROKER_REQUEST_BYTES + 1)
            if not raw or len(raw) > MAX_BROKER_REQUEST_BYTES:
                raise RoomContextBrokerError("Invalid room context broker request", code="room_context_broker_invalid_request")
            request = json.loads(raw.decode("utf-8"))
            path = request.get("path") if isinstance(request, dict) else None
            if not isinstance(path, str) or not _ALLOWED_PATH.fullmatch(path):
                raise RoomContextBrokerError("Unsupported room context broker path", code="room_context_broker_path_denied")
            server = self.server
            assert isinstance(server, _BrokerServer)
            response = {"success": True, "payload": _fetch_room_context(f"{server.base_url}{path}", server.token)}
        except RoomContextBrokerError as exc:
            response = {"success": False, "error": str(exc), "code": exc.code}
        except Exception as exc:
            response = {"success": False, "error": str(exc), "code": "room_context_broker_error"}
        encoded = (json.dumps(response, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
        if len(encoded) > MAX_BROKER_RESPONSE_BYTES:
            encoded = b'{"success":false,"error":"Room context broker response is too large","code":"room_context_response_too_large"}\n'
        self.wfile.write(encoded)


class RoomContextBroker:
    def __init__(self, env: MutableMapping[str, str], turn_id: str):
        self.env = env
        self.turn_id = turn_id
        self.server: _BrokerServer | None = None
        self.thread: threading.Thread | None = None
        self.socket_path: Path | None = None
        self.previous_socket = env.get(ROOM_CONTEXT_SOCKET_ENV)
        self.previous_url = env.get("ROOMTALK_ROOM_CONTEXT_URL")
        self.previous_token = env.get("ROOMTALK_ROOM_CONTEXT_TOKEN")
        self.started = False

    def start(self) -> "RoomContextBroker":
        base_url = (self.env.get("ROOMTALK_ROOM_CONTEXT_URL") or "").strip()
        token = (self.env.get("ROOMTALK_ROOM_CONTEXT_TOKEN") or "").strip()
        if not base_url or not token:
            return self
        broker_dir = Path(
            (self.env.get("ROOMTALK_ROOM_CONTEXT_BROKER_DIR") or "").strip()
            or (Path.home() / ".rtctx")
        )
        broker_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        broker_dir.chmod(0o700)
        safe_turn = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in self.turn_id)[:12] or "turn"
        socket_path = broker_dir / f"{safe_turn}-{uuid.uuid4().hex[:8]}.sock"
        server = _BrokerServer(str(socket_path), base_url, token)
        socket_path.chmod(0o600)
        thread = threading.Thread(
            target=lambda: server.serve_forever(poll_interval=0.05),
            name=f"room-context-{safe_turn}",
            daemon=True,
        )
        thread.start()
        self.server = server
        self.thread = thread
        self.socket_path = socket_path
        self.env[ROOM_CONTEXT_SOCKET_ENV] = str(socket_path)
        self.env.pop("ROOMTALK_ROOM_CONTEXT_URL", None)
        self.env.pop("ROOMTALK_ROOM_CONTEXT_TOKEN", None)
        self.started = True
        return self

    def __enter__(self) -> "RoomContextBroker":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def close(self) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
        if self.thread is not None:
            self.thread.join(timeout=1)
        if self.socket_path is not None:
            self.socket_path.unlink(missing_ok=True)
            try:
                self.socket_path.parent.rmdir()
            except OSError:
                pass
        if self.previous_socket is None:
            self.env.pop(ROOM_CONTEXT_SOCKET_ENV, None)
        else:
            self.env[ROOM_CONTEXT_SOCKET_ENV] = self.previous_socket
        if self.started:
            if self.previous_url is None:
                self.env.pop("ROOMTALK_ROOM_CONTEXT_URL", None)
            else:
                self.env["ROOMTALK_ROOM_CONTEXT_URL"] = self.previous_url
            if self.previous_token is None:
                self.env.pop("ROOMTALK_ROOM_CONTEXT_TOKEN", None)
            else:
                self.env["ROOMTALK_ROOM_CONTEXT_TOKEN"] = self.previous_token


def start_room_context_broker(env: MutableMapping[str, str], turn_id: str) -> RoomContextBroker:
    return RoomContextBroker(env, turn_id).start()
