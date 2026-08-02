from __future__ import annotations

import asyncio
import io
import json
import queue
import sqlite3
import stat
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from roomtalk_code_agent_runner.acp_harness import (
    ACPEventBridge,
    _configure_session,
    _control_loop,
    _open_session,
    _prompt_session,
    _unwrap_session_id,
    _wrap_session_id,
    build_harness_env,
    hermes_config,
    opencode_config,
)
from roomtalk_code_agent_runner.runner import EventEmitter, RunnerError, RunnerRequest


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


def test_opencode_config_uses_anthropic_transport_for_anthropic_models():
    config = opencode_config(
        runner_request(
            provider="anthropic",
            model_id="claude-sonnet-5",
            api_model="claude-sonnet-5",
        ),
        "https://room.example/api/code-agent/model-gateway/v1",
        "turn-token",
    )

    assert config["provider"]["roomtalk"]["npm"] == "@ai-sdk/anthropic"


def test_hermes_config_uses_an_isolated_custom_openai_compatible_provider():
    config = hermes_config(
        runner_request(),
        "https://room.example/api/code-agent/model-gateway/v1",
        "turn-token",
    )

    assert config["model"] == {
        "default": "deepseek/deepseek-v4-pro",
        "provider": "custom:roomtalk",
        "base_url": "https://room.example/api/code-agent/model-gateway/v1",
        "api_key": "turn-token",
        "api_mode": "chat_completions",
    }
    assert config["providers"] == {
        "roomtalk": {
            "name": "RoomTalk",
            "base_url": "https://room.example/api/code-agent/model-gateway/v1",
            "api_key": "turn-token",
            "default_model": "deepseek/deepseek-v4-pro",
            "models": {"deepseek/deepseek-v4-pro": {}},
            "api_mode": "chat_completions",
            "discover_models": False,
        },
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
    model = json.loads(config_path.read_text(encoding="utf-8"))["model"]
    assert model["provider"] == "custom:roomtalk"
    assert model["api_key"] == "turn-token"
    assert model["api_mode"] == "chat_completions"
    assert stat.S_IMODE(Path(env["HERMES_HOME"]).stat().st_mode) == 0o700
    assert stat.S_IMODE(config_path.stat().st_mode) == 0o600


def test_hermes_config_uses_anthropic_messages_for_anthropic_models():
    config = hermes_config(
        runner_request(
            provider="anthropic",
            model_id="claude-sonnet-5",
            api_model="claude-sonnet-5",
        ),
        "https://room.example/api/code-agent/model-gateway/v1",
        "turn-token",
    )

    assert config["model"]["api_mode"] == "anthropic_messages"


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
            "model_id": "custom:roomtalk:deepseek/deepseek-v4-pro",
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


def test_event_bridge_maps_a_terminal_tool_call_start_without_waiting_for_an_update():
    output = io.StringIO()
    bridge = ACPEventBridge(
        backend="hermes-agent",
        request=runner_request(),
        emitter=EventEmitter(output),
    )

    asyncio.run(bridge.session_update(
        "session-1",
        SimpleNamespace(
            session_update="tool_call",
            tool_call_id="tool-1",
            title="Read file",
            kind="read",
            status="completed",
            raw_input={"path": "README.md"},
            raw_output="contents from terminal start",
            locations=[],
            content=[],
        ),
    ))

    emitted = events(output)
    assert [event["type"] for event in emitted] == ["tool_call", "tool_result"]
    assert emitted[1]["success"] is True
    assert emitted[1]["output"] == "contents from terminal start"


def test_hermes_event_bridge_recovers_exact_parallel_tool_results_before_answer_text(tmp_path: Path):
    state_db = tmp_path / "state.db"
    with sqlite3.connect(state_db) as connection:
        connection.execute(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_name TEXT)"
        )
        connection.execute(
            "INSERT INTO messages (session_id, role, content) VALUES (?, 'tool', ?)",
            ("session-1", "old result from a prior prompt"),
        )

    output = io.StringIO()
    bridge = ACPEventBridge(
        backend="hermes-agent",
        request=runner_request(),
        emitter=EventEmitter(output),
        hermes_state_db=state_db,
    )

    async def run() -> None:
        await bridge.begin_prompt("session-1")
        await bridge.session_update(
            "session-1",
            SimpleNamespace(
                session_update="tool_call",
                tool_call_id="tool-read",
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
                session_update="tool_call",
                tool_call_id="tool-shell",
                title="Run status",
                kind="execute",
                raw_input={"command": "git status --short"},
                locations=[],
                content=[],
            ),
        )
        await bridge.session_update(
            "session-1",
            SimpleNamespace(
                session_update="tool_call_update",
                tool_call_id="tool-shell",
                title="Run status",
                kind="execute",
                status="completed",
                raw_input=None,
                raw_output="$ git status --short",
                locations=[],
                content=[],
            ),
        )
        with sqlite3.connect(state_db) as connection:
            connection.executemany(
                "INSERT INTO messages (session_id, role, content, tool_name) VALUES (?, 'tool', ?, ?)",
                [
                    ("session-1", '{"output":"","exit_code":0,"error":null}', "terminal"),
                    ("session-1", '{"content":"# RoomTalk"}', "read_file"),
                ],
            )
        await bridge.session_update(
            "session-1",
            SimpleNamespace(
                session_update="agent_message_chunk",
                content=SimpleNamespace(type="text", text="done"),
            ),
        )
        await bridge.flush_tools_at_final("session-1")

    asyncio.run(run())

    emitted = events(output)
    assert [event["type"] for event in emitted] == [
        "tool_call",
        "tool_call",
        "tool_result",
        "tool_result",
        "text_delta",
    ]
    assert emitted[2]["id"] == "tool-read"
    assert emitted[2]["output"] == '{"content":"# RoomTalk"}'
    assert emitted[3]["id"] == "tool-shell"
    assert emitted[3]["output"] == '{"output":"","exit_code":0,"error":null}'
    assert emitted[3]["exitCode"] == 0
    assert emitted[4]["delta"] == "done"


def test_hermes_event_bridge_marks_recovered_tool_failures(tmp_path: Path):
    state_db = tmp_path / "state.db"
    with sqlite3.connect(state_db) as connection:
        connection.execute(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_name TEXT)"
        )

    output = io.StringIO()
    bridge = ACPEventBridge(
        backend="hermes-agent",
        request=runner_request(),
        emitter=EventEmitter(output),
        hermes_state_db=state_db,
    )

    async def run() -> None:
        await bridge.begin_prompt("session-1")
        await bridge.session_update(
            "session-1",
            SimpleNamespace(
                session_update="tool_call",
                tool_call_id="tool-fail",
                title="Run failing command",
                kind="execute",
                raw_input={"command": "false"},
                locations=[],
                content=[],
            ),
        )
        with sqlite3.connect(state_db) as connection:
            connection.execute(
                "INSERT INTO messages (session_id, role, content, tool_name) VALUES (?, 'tool', ?, ?)",
                ("session-1", '{"output":"","exit_code":7,"error":"failed"}', "terminal"),
            )
        await bridge.flush_tools_at_final("session-1")

    asyncio.run(run())

    emitted = events(output)
    assert emitted[-1]["type"] == "tool_result"
    assert emitted[-1]["success"] is False
    assert emitted[-1]["exitCode"] == 7


def test_event_bridge_closes_missing_terminal_tool_updates_before_final():
    output = io.StringIO()
    bridge = ACPEventBridge(
        backend="hermes-agent",
        request=runner_request(),
        emitter=EventEmitter(output),
    )

    async def run() -> None:
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
                status="in_progress",
                raw_input=None,
                raw_output="partial contents",
                locations=[],
                content=[],
            ),
        )

    asyncio.run(run())
    bridge.close_tools_at_final()
    bridge.close_tools_at_final()

    emitted = events(output)
    assert [event["type"] for event in emitted] == ["tool_call", "tool_result"]
    assert emitted[1]["success"] is True
    assert emitted[1]["output"] == "partial contents"


def test_loading_a_session_suppresses_replayed_updates_before_the_new_turn():
    output = io.StringIO()
    request = runner_request(session_id="acp:opencode:session-1")
    bridge = ACPEventBridge(
        backend="opencode",
        request=request,
        emitter=EventEmitter(output),
    )

    class Connection:
        async def load_session(self, **_kwargs: Any) -> Any:
            await bridge.session_update(
                "session-1",
                SimpleNamespace(
                    session_update="agent_message_chunk",
                    content=SimpleNamespace(type="text", text="old answer"),
                ),
            )
            return SimpleNamespace(session_id="session-1")

        async def new_session(self, **_kwargs: Any) -> Any:
            raise AssertionError("restored session should not create a new session")

    async def run() -> tuple[Any, str, bool]:
        opened = await _open_session(
            backend="opencode",
            request=request,
            connection=Connection(),
            capabilities=SimpleNamespace(load_session=True),
            bridge=bridge,
        )
        await bridge.session_update(
            "session-1",
            SimpleNamespace(
                session_update="agent_message_chunk",
                content=SimpleNamespace(type="text", text="new answer"),
            ),
        )
        return opened

    _, session_id, restored = asyncio.run(run())

    assert session_id == "session-1"
    assert restored is True
    assert bridge.answer_parts == ["new answer"]
    assert [event["delta"] for event in events(output)] == ["new answer"]


def test_approval_control_emits_a_paired_tool_result():
    output = io.StringIO()
    request = runner_request()
    bridge = ACPEventBridge(
        backend="opencode",
        request=request,
        emitter=EventEmitter(output),
    )

    async def run() -> str:
        permission = asyncio.get_running_loop().create_future()
        bridge.pending_permissions["approval-1"] = permission
        controls: queue.Queue[dict[str, Any] | None] = queue.Queue()
        controls.put({
            "schemaVersion": 1,
            "turnId": request.turn_id,
            "type": "approval_response",
            "controlId": "control-1",
            "approvalId": "approval-1",
            "decision": "acceptForSession",
        })
        controls.put(None)
        await _control_loop(
            request=request,
            emitter=bridge.emitter,
            bridge=bridge,
            connection=SimpleNamespace(),
            session_id="session-1",
            control_queue=controls,
        )
        return await permission

    assert asyncio.run(run()) == "acceptForSession"
    emitted = events(output)
    assert emitted[0] == {
        "schemaVersion": 1,
        "type": "tool_result",
        "turnId": "turn-1",
        "id": "approval-1",
        "name": "approval_request",
        "success": True,
        "output": "Approved for this session.",
        "messageId": "acp_approval_result_approval-1",
    }
    assert emitted[1]["type"] == "control_result"
    assert emitted[1]["accepted"] is True


def test_permission_request_returns_the_selected_acp_option():
    from acp.schema import PermissionOption

    output = io.StringIO()
    bridge = ACPEventBridge(
        backend="opencode",
        request=runner_request(),
        emitter=EventEmitter(output),
    )

    async def run() -> Any:
        pending = asyncio.create_task(bridge.request_permission(
            options=[PermissionOption(
                option_id="allow-once",
                kind="allow_once",
                name="Allow once",
            )],
            session_id="session-1",
            tool_call=SimpleNamespace(
                kind="execute",
                title="Run tests",
                raw_input={"command": "npm test"},
            ),
        ))
        while not bridge.pending_permissions:
            await asyncio.sleep(0)
        approval_id = next(iter(bridge.pending_permissions))
        assert bridge.resolve_permission(approval_id, "accept") is True
        return await asyncio.wait_for(pending, timeout=1)

    response = asyncio.run(run())

    assert response.outcome.outcome == "selected"
    assert response.outcome.option_id == "allow-once"
    emitted = events(output)
    assert emitted[0]["type"] == "approval_request"
    assert emitted[0]["args"]["command"] == "npm test"


def test_interrupt_closes_pending_approvals_before_cancelling_the_agent():
    output = io.StringIO()
    request = runner_request()
    bridge = ACPEventBridge(
        backend="hermes-agent",
        request=request,
        emitter=EventEmitter(output),
    )
    cancelled_sessions: list[str] = []

    class Connection:
        async def cancel(self, *, session_id: str) -> None:
            cancelled_sessions.append(session_id)

    async def run() -> str:
        permission = asyncio.get_running_loop().create_future()
        bridge.pending_permissions["approval-1"] = permission
        controls: queue.Queue[dict[str, Any] | None] = queue.Queue()
        controls.put({
            "schemaVersion": 1,
            "turnId": request.turn_id,
            "type": "interrupt",
            "controlId": "control-1",
        })
        controls.put(None)
        await _control_loop(
            request=request,
            emitter=bridge.emitter,
            bridge=bridge,
            connection=Connection(),
            session_id="session-1",
            control_queue=controls,
        )
        return await permission

    assert asyncio.run(run()) == "cancel"
    assert cancelled_sessions == ["session-1"]
    assert bridge.interrupted is True
    emitted = events(output)
    assert [event["type"] for event in emitted] == ["tool_result", "control_result"]
    assert emitted[0]["success"] is False
    assert emitted[0]["output"] == "Cancelled."
    assert emitted[1]["accepted"] is True


def test_prompt_errors_after_an_accepted_interrupt_close_as_a_normal_final():
    bridge = ACPEventBridge(
        backend="hermes-agent",
        request=runner_request(),
        emitter=EventEmitter(io.StringIO()),
    )
    bridge.interrupted = True

    class Connection:
        async def prompt(self, **kwargs: Any) -> Any:
            del kwargs
            raise RuntimeError("RequestError: prompt cancelled")

    response = asyncio.run(_prompt_session(
        connection=Connection(),
        session_id="session-1",
        blocks=[],
        bridge=bridge,
    ))

    assert response is None


def test_prompt_errors_without_an_interrupt_still_fail_the_turn():
    bridge = ACPEventBridge(
        backend="hermes-agent",
        request=runner_request(),
        emitter=EventEmitter(io.StringIO()),
    )

    class Connection:
        async def prompt(self, **kwargs: Any) -> Any:
            del kwargs
            raise RuntimeError("provider failed")

    try:
        asyncio.run(_prompt_session(
            connection=Connection(),
            session_id="session-1",
            blocks=[],
            bridge=bridge,
        ))
    except RuntimeError as error:
        assert str(error) == "provider failed"
    else:
        raise AssertionError("non-interrupt prompt failures must propagate")


def test_opencode_client_write_rpc_is_acknowledged_only_inside_workspace(tmp_path: Path):
    bridge = ACPEventBridge(
        backend="opencode",
        request=runner_request(workspace=tmp_path),
        emitter=EventEmitter(io.StringIO()),
    )

    asyncio.run(bridge.write_text_file(path="src/example.ts", content="updated"))

    try:
        asyncio.run(bridge.write_text_file(path="../outside.ts", content="nope"))
    except RunnerError as error:
        assert error.code == "acp_client_fs_outside_workspace"
    else:
        raise AssertionError("workspace escape should be rejected")
