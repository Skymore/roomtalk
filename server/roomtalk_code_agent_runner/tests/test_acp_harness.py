from __future__ import annotations

import asyncio
import io
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from roomtalk_code_agent_runner.acp_harness import (
    ACPEventBridge,
    _configure_session,
    _unwrap_session_id,
    _wrap_session_id,
    build_harness_env,
    hermes_config,
    opencode_config,
)
from roomtalk_code_agent_runner.runner import EventEmitter, RunnerRequest


def runner_request(**overrides: Any) -> RunnerRequest:
    values = {
        "room_id": "room-1",
        "turn_id": "turn-1",
        "session_id": None,
        "prompt": "inspect the project",
        "prior_messages": [],
        "mode": "edit",
        "provider": "openrouter",
        "model_id": "deepseek-v4-pro",
        "api_model": "deepseek/deepseek-v4-pro",
        "codex_model": None,
        "codex_reasoning_effort": None,
        "codex_permission_mode": None,
        "codex_service_tier": None,
        "workspace": Path("/workspace"),
        "allowed_paths": (".",),
        "images": (),
    }
    values.update(overrides)
    return RunnerRequest(**values)


def events(buffer: io.StringIO) -> list[dict[str, Any]]:
    return [json.loads(line) for line in buffer.getvalue().splitlines()]


def test_opencode_config_routes_models_through_roomtalk_gateway_and_enforces_plan():
    config = opencode_config(
        runner_request(mode="plan"),
        "https://room.example/api/code-agent/model-gateway/v1",
        "turn-token",
    )

    assert config["model"] == "roomtalk/deepseek/deepseek-v4-pro"
    assert config["provider"]["roomtalk"]["options"] == {
        "baseURL": "https://room.example/api/code-agent/model-gateway/v1",
        "apiKey": "turn-token",
    }
    assert config["permission"]["read"] == "allow"
    assert config["permission"]["edit"] == "deny"
    assert config["permission"]["bash"] == "deny"


def test_hermes_config_uses_an_isolated_custom_openai_compatible_provider():
    config = hermes_config(
        runner_request(),
        "https://room.example/api/code-agent/model-gateway/v1",
    )

    assert config["model"] == {
        "default": "deepseek/deepseek-v4-pro",
        "provider": "custom",
        "base_url": "https://room.example/api/code-agent/model-gateway/v1",
    }
    assert config["terminal"]["cwd"] == "/workspace"


def test_build_harness_env_isolates_hermes_state_and_uses_turn_token(tmp_path: Path):
    env = build_harness_env(
        "hermes-agent",
        runner_request(),
        {
            "CODE_AGENT_MODEL_PROXY_URL": "https://room.example/api/code-agent/model-gateway/v1",
            "CODE_AGENT_MODEL_PROXY_TOKEN": "turn-token",
        },
        state_root=tmp_path,
    )

    assert env["OPENAI_API_KEY"] == "turn-token"
    assert env["OPENAI_BASE_URL"].endswith("/v1")
    assert env["HERMES_SESSION_SOURCE"] == "roomtalk"
    config_path = Path(env["HERMES_HOME"]) / "config.yaml"
    assert json.loads(config_path.read_text(encoding="utf-8"))["model"]["provider"] == "custom"


def test_acp_session_ids_are_backend_scoped():
    wrapped = _wrap_session_id("native-session", "opencode")

    assert wrapped == "acp:opencode:native-session"
    assert _unwrap_session_id(wrapped, "opencode") == "native-session"
    assert _unwrap_session_id(wrapped, "hermes-agent") is None


def test_hermes_session_model_stays_on_the_roomtalk_custom_provider():
    calls: list[tuple[str, dict[str, str]]] = []

    class Connection:
        async def set_session_model(self, **kwargs: str) -> None:
            calls.append(("model", kwargs))

        async def set_session_mode(self, **kwargs: str) -> None:
            calls.append(("mode", kwargs))

    asyncio.run(_configure_session(
        backend="hermes-agent",
        request=runner_request(mode="fullAccess"),
        connection=Connection(),
        session_id="session-1",
        session_response=SimpleNamespace(
            modes=SimpleNamespace(
                available_modes=[
                    SimpleNamespace(id="default"),
                    SimpleNamespace(id="dont_ask"),
                ],
            ),
        ),
    ))

    assert calls == [
        ("model", {
            "session_id": "session-1",
            "model_id": "custom:deepseek/deepseek-v4-pro",
        }),
        ("mode", {"session_id": "session-1", "mode_id": "dont_ask"}),
    ]


def test_event_bridge_maps_text_and_tool_lifecycle_to_roomtalk_jsonl():
    output = io.StringIO()
    bridge = ACPEventBridge(
        backend="opencode",
        request=runner_request(),
        emitter=EventEmitter(output),
    )

    async def run() -> None:
        await bridge.session_update(
            "session-1",
            SimpleNamespace(
                session_update="agent_message_chunk",
                content=SimpleNamespace(type="text", text="hello"),
            ),
        )
        await bridge.session_update(
            "session-1",
            SimpleNamespace(
                session_update="tool_call",
                tool_call_id="tool-1",
                title="Read file",
                kind="read",
                raw_input={"path": "README.md"},
                locations=[],
                content=[],
            ),
        )
        await bridge.session_update(
            "session-1",
            SimpleNamespace(
                session_update="tool_call_update",
                tool_call_id="tool-1",
                title="Read file",
                kind="read",
                status="completed",
                raw_input=None,
                raw_output="contents",
                locations=[],
                content=[],
            ),
        )

    asyncio.run(run())

    emitted = events(output)
    assert [event["type"] for event in emitted] == ["text_delta", "tool_call", "tool_result"]
    assert emitted[0]["delta"] == "hello"
    assert emitted[1]["args"]["path"] == "README.md"
    assert emitted[2]["success"] is True
    assert emitted[2]["output"] == "contents"
