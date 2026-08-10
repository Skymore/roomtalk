from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from roomtalk_code_agent_runner import _codex_app_server_protocol as codex_app_server


class FakeImageResponse:
    def __init__(
        self,
        body: bytes,
        *,
        content_type: str = "image/png",
        content_length: str | None = None,
        final_url: str = "https://media.example/final.png",
    ):
        self.body = body
        self.headers = {
            "Content-Type": content_type,
            "Content-Length": content_length if content_length is not None else str(len(body)),
        }
        self.final_url = final_url
        self.read_limits: list[int] = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def geturl(self):
        return self.final_url

    def read(self, limit: int):
        self.read_limits.append(limit)
        return self.body[:limit]


def test_codex_user_message_item_confirms_pending_steer_insertion(tmp_path: Path):
    mapper = codex_app_server.CodexAppServerJsonRpcMapper(
        turn_id="turn-roomtalk",
        message_id="ai-1",
        workspace=tmp_path,
    )

    assert mapper.map_notification({
        "method": "item/started",
        "params": {
            "item": {
                "type": "userMessage",
                "id": "item-1",
                "clientId": "queued-steer-1",
                "content": [{"type": "text", "text": "use Bing instead"}],
            },
        },
    }) == [{
        "schemaVersion": 1,
        "type": "user_input_inserted",
        "turnId": "turn-roomtalk",
        "messageId": "queued-steer-1",
    }]


def test_codex_retrying_error_is_a_safe_non_terminal_status(tmp_path: Path):
    mapper = codex_app_server.CodexAppServerJsonRpcMapper(
        turn_id="turn-roomtalk",
        message_id="ai-1",
        workspace=tmp_path,
    )
    fake_secret = "ROOMTALK_PRIVATE_TOKEN=retry-detail"

    events = mapper.map_notification({
        "method": "error",
        "params": {
            "willRetry": True,
            "error": {"message": fake_secret, "additionalDetails": fake_secret},
            "additionalDetails": fake_secret,
        },
    })

    assert events == [{
        "schemaVersion": 1,
        "type": "status",
        "turnId": "turn-roomtalk",
        "status": "running",
        "message": "codex app-server reconnecting",
    }]
    assert fake_secret not in repr(events)


@pytest.mark.parametrize("will_retry", [False, None, 1, "true"])
def test_codex_error_without_strict_retry_signal_remains_terminal(tmp_path: Path, will_retry: Any):
    mapper = codex_app_server.CodexAppServerJsonRpcMapper(
        turn_id="turn-roomtalk",
        message_id="ai-1",
        workspace=tmp_path,
    )
    params: dict[str, Any] = {"error": {"message": "terminal failure"}}
    if will_retry is not None:
        params["willRetry"] = will_retry

    events = mapper.map_notification({"method": "error", "params": params})

    assert len(events) == 1
    assert events[0]["type"] == "error"
    assert events[0]["message"] == "terminal failure"


def test_codex_failed_turn_completion_remains_terminal_after_retrying_error(tmp_path: Path):
    mapper = codex_app_server.CodexAppServerJsonRpcMapper(
        turn_id="turn-roomtalk",
        message_id="ai-1",
        workspace=tmp_path,
    )

    assert mapper.map_notification({
        "method": "error",
        "params": {"willRetry": True, "error": {"message": "temporary"}},
    })[0]["type"] == "status"
    completed = mapper.map_notification({
        "method": "turn/completed",
        "params": {"turn": {"status": "failed", "error": {"message": "final failure"}}},
    })

    assert len(completed) == 1
    assert completed[0]["type"] == "error"
    assert completed[0]["message"] == "final failure"


def test_codex_image_url_is_materialized_in_memory(monkeypatch: pytest.MonkeyPatch):
    image_url = "https://media.example/signed/input.png?token=secret"
    response = FakeImageResponse(b"png-bytes", content_type="image/png; charset=binary")
    captured: dict[str, Any] = {}

    def fake_urlopen(request, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        return response

    monkeypatch.setattr(codex_app_server.urllib_request, "urlopen", fake_urlopen)

    result = codex_app_server._materialize_codex_image_url(image_url, turn_id="turn-image")

    assert result == "data:image/png;base64,cG5nLWJ5dGVz"
    assert captured["request"].full_url == image_url
    assert captured["timeout"] == codex_app_server.CODEX_IMAGE_FETCH_TIMEOUT_SECONDS
    assert response.read_limits == [codex_app_server.MAX_CODEX_IMAGE_BYTES + 1]


def test_codex_image_materialization_enforces_transport_boundaries(monkeypatch: pytest.MonkeyPatch):
    image_url = "https://media.example/signed/input.png?token=secret"

    monkeypatch.setattr(
        codex_app_server.urllib_request,
        "urlopen",
        lambda *_args, **_kwargs: FakeImageResponse(b"text", content_type="text/plain"),
    )
    with pytest.raises(codex_app_server.RunnerError) as invalid_type:
        codex_app_server._materialize_codex_image_url(image_url, turn_id="turn-image")
    assert invalid_type.value.code == "codex_image_invalid_content_type"
    assert "token=secret" not in str(invalid_type.value)

    monkeypatch.setattr(
        codex_app_server.urllib_request,
        "urlopen",
        lambda *_args, **_kwargs: FakeImageResponse(
            b"image",
            content_length=str(codex_app_server.MAX_CODEX_IMAGE_BYTES + 1),
        ),
    )
    with pytest.raises(codex_app_server.RunnerError) as too_large:
        codex_app_server._materialize_codex_image_url(image_url, turn_id="turn-image")
    assert too_large.value.code == "codex_image_too_large"

    monkeypatch.setattr(
        codex_app_server.urllib_request,
        "urlopen",
        lambda *_args, **_kwargs: FakeImageResponse(b"image", final_url="http://media.example/input.png"),
    )
    with pytest.raises(codex_app_server.RunnerError) as insecure_redirect:
        codex_app_server._materialize_codex_image_url(image_url, turn_id="turn-image")
    assert insecure_redirect.value.code == "codex_image_insecure_redirect"
