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
    ACPHarnessSpec,
    ACPEventBridge,
    ACP_MISSING_TERMINAL_TOOL_RESULT_OUTPUT,
    MAX_ACP_FRAME_BYTES,
    OPENCODE_INVALID_TOOL_OUTPUT_PREFIX,
    OPENCODE_INVALID_TOOL_PUBLIC_OUTPUT,
    _configure_session,
    _control_loop,
    _mode_ids,
    _open_session,
    _prompt_session,
    _run_request_async,
    _unwrap_session_id,
    _wrap_session_id,
    build_harness_env,
    hermes_config,
    opencode_config,
    _launch_command,
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


def opencode_config_options(current_value: str) -> list[SimpleNamespace]:
    return [
        SimpleNamespace(
            id="mode",
            category="mode",
            current_value=current_value,
            options=[
                SimpleNamespace(value="plan"),
                SimpleNamespace(value="build"),
            ],
        ),
    ]


def test_acp_process_transport_accepts_bounded_frames_larger_than_asyncio_default(tmp_path: Path):
    captured: dict[str, Any] = {}

    class FailingContext:
        async def __aenter__(self):
            raise RuntimeError("stop after transport creation")

        async def __aexit__(self, *_args: Any):
            return False

    def spawn(*args: Any, **kwargs: Any) -> FailingContext:
        captured["args"] = args
        captured["kwargs"] = kwargs
        return FailingContext()

    try:
        asyncio.run(_run_request_async(
            "opencode",
            runner_request(workspace=tmp_path),
            emitter=EventEmitter(io.StringIO()),
            env={
                "CODE_AGENT_MODEL_PROXY_URL": "https://room.example/api/code-agent/model-gateway/v1",
                "CODE_AGENT_MODEL_PROXY_TOKEN": "turn-token",
            },
            control_queue=queue.Queue(),
            spawn=spawn,
        ))
    except RunnerError as error:
        assert error.code == "acp_harness_failed"
    else:
        raise AssertionError("the fake process context must stop the request")

    assert MAX_ACP_FRAME_BYTES > 64 * 1024
    assert captured["kwargs"]["transport_kwargs"] == {"limit": MAX_ACP_FRAME_BYTES}


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


def test_plan_wrapper_mounts_a_writable_dev_namespace_for_runner_processes(monkeypatch: Any):
    monkeypatch.setattr(
        "roomtalk_code_agent_runner.acp_harness.shutil.which",
        lambda _name, path=None: "/usr/bin/bwrap",
    )
    command, args = _launch_command(
        ACPHarnessSpec(
            backend="probe",
            display_name="Probe",
            command="runner-probe",
            args=("--acp",),
        ),
        runner_request(mode="plan", workspace=Path("/workspace")),
        {"PATH": "/usr/bin"},
    )

    assert command == "/usr/bin/bwrap"
    assert args[0:3] == ("--die-with-parent", "--bind", "/")
    assert args[3:5] == ("/", "--dev")
    assert args[5:7] == ("/dev", "--ro-bind")
    assert args[-2:] == ("runner-probe", "--acp")


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
    assert config["auxiliary"] == {
        "title_generation": {
            "enabled": False,
        },
    }
    assert config["mcp_servers"] == {}


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
    config = json.loads(config_path.read_text(encoding="utf-8"))
    model = config["model"]
    assert model["provider"] == "custom:roomtalk"
    assert model["api_key"] == "turn-token"
    assert model["api_mode"] == "chat_completions"
    assert config["auxiliary"]["title_generation"]["enabled"] is False
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


def test_acp_session_model_update_failures_are_safe_and_fail_closed():
    fake_secret = "ROOMTALK_PRIVATE_TOKEN=fake-model-update-secret"

    class Connection:
        async def set_session_model(self, **_kwargs: str) -> None:
            raise RuntimeError(fake_secret)

    for backend, session_response in (
        ("opencode", SimpleNamespace(
            session_id="session-1",
            config_options=opencode_config_options("build"),
        )),
        ("hermes-agent", SimpleNamespace(
            session_id="session-1",
            modes=SimpleNamespace(available_modes=[SimpleNamespace(id="default")]),
        )),
    ):
        try:
            asyncio.run(_configure_session(
                backend=backend,
                request=runner_request(mode="plan"),
                connection=Connection(),
                session_id="session-1",
                session_response=session_response,
            ))
        except RunnerError as error:
            assert error.code == "acp_session_model_update_failed"
            assert str(error) == "ACP session model update failed"
            assert fake_secret not in str(error)
        else:
            raise AssertionError(f"{backend} must reject a failed session model update")


def test_hermes_fails_closed_when_session_mode_is_unavailable_or_update_fails():
    fake_secret = "ROOMTALK_PRIVATE_TOKEN=fake-mode-update-secret"

    class MissingModeConnection:
        async def set_session_model(self, **_kwargs: str) -> None:
            return None

        async def set_session_mode(self, **_kwargs: str) -> None:
            raise AssertionError("unadvertised modes must not be selected")

    try:
        asyncio.run(_configure_session(
            backend="hermes-agent",
            request=runner_request(mode="plan"),
            connection=MissingModeConnection(),
            session_id="session-1",
            session_response=SimpleNamespace(session_id="session-1"),
        ))
    except RunnerError as error:
        assert error.code == "acp_session_mode_unavailable"
        assert str(error) == "Hermes Agent ACP session did not advertise the requested mode"
    else:
        raise AssertionError("Hermes Agent must reject an unavailable session mode")

    class FailingModeConnection:
        async def set_session_model(self, **_kwargs: str) -> None:
            return None

        async def set_session_mode(self, **_kwargs: str) -> None:
            raise RuntimeError(fake_secret)

    try:
        asyncio.run(_configure_session(
            backend="hermes-agent",
            request=runner_request(mode="fullAccess"),
            connection=FailingModeConnection(),
            session_id="session-1",
            session_response=SimpleNamespace(
                session_id="session-1",
                modes=SimpleNamespace(available_modes=[SimpleNamespace(id="dont_ask")]),
            ),
        ))
    except RunnerError as error:
        assert error.code == "acp_session_mode_update_failed"
        assert str(error) == "Hermes Agent ACP session mode update failed"
        assert fake_secret not in str(error)
    else:
        raise AssertionError("Hermes Agent must reject a failed session mode update")


def test_mode_ids_supports_legacy_modes_and_config_options_without_flattening_other_selects():
    response = {
        "modes": {
            "availableModes": [
                {"id": "default"},
                {"id": "dont_ask"},
            ],
        },
        "configOptions": [
            {
                "id": "mode",
                "category": "mode",
                "currentValue": "plan",
                "options": [{
                    "group": "primary",
                    "options": [{"value": "plan"}, {"value": "build"}],
                }],
            },
            {
                "id": "theme",
                "category": "display",
                "options": [{"value": "build"}, {"value": "dark"}],
            },
        ],
    }

    assert _mode_ids(response) == {"default", "dont_ask", "plan", "build"}


def test_opencode_config_options_switch_restored_sessions_between_plan_and_build():
    for request_mode, prior_mode, expected_mode in [
        ("fullAccess", "plan", "build"),
        ("plan", "build", "plan"),
    ]:
        calls: list[tuple[str, dict[str, str]]] = []

        class Connection:
            async def set_session_model(self, **kwargs: str) -> None:
                calls.append(("model", kwargs))

            async def set_config_option(self, **kwargs: str) -> None:
                calls.append(("config", kwargs))

            async def set_session_mode(self, **_kwargs: str) -> None:
                raise AssertionError("configOptions must use set_config_option")

        asyncio.run(_configure_session(
            backend="opencode",
            request=runner_request(
                mode=request_mode,
                session_id="acp:opencode:restored-session",
            ),
            connection=Connection(),
            session_id="restored-session",
            session_response=SimpleNamespace(
                session_id="restored-session",
                config_options=opencode_config_options(prior_mode),
            ),
        ))

        assert calls[-1] == (
            "config",
            {
                "session_id": "restored-session",
                "config_id": "mode",
                "value": expected_mode,
            },
        )


def test_opencode_new_and_loaded_session_config_options_reach_mode_configuration():
    for restored, request_mode, expected_mode in [
        (False, "fullAccess", "build"),
        (True, "plan", "plan"),
    ]:
        output = io.StringIO()
        request = runner_request(
            mode=request_mode,
            session_id="acp:opencode:session-1" if restored else None,
        )
        bridge = ACPEventBridge(
            backend="opencode",
            request=request,
            emitter=EventEmitter(output),
        )
        configured_modes: list[str] = []
        session_response = SimpleNamespace(
            session_id="session-1",
            config_options=opencode_config_options("plan" if expected_mode == "build" else "build"),
        )

        class Connection:
            async def load_session(self, **_kwargs: Any) -> Any:
                if not restored:
                    raise AssertionError("new sessions must not load")
                return session_response

            async def new_session(self, **_kwargs: Any) -> Any:
                if restored:
                    raise AssertionError("loaded sessions must not create")
                return session_response

            async def set_session_model(self, **_kwargs: str) -> None:
                return None

            async def set_config_option(self, **kwargs: str) -> None:
                configured_modes.append(kwargs["value"])

        async def run() -> bool:
            response, session_id, was_restored = await _open_session(
                backend="opencode",
                request=request,
                connection=Connection(),
                capabilities=SimpleNamespace(load_session=True),
                bridge=bridge,
            )
            await _configure_session(
                backend="opencode",
                request=request,
                connection=Connection(),
                session_id=session_id,
                session_response=response,
            )
            return was_restored

        assert asyncio.run(run()) is restored
        assert configured_modes == [expected_mode]


def test_opencode_legacy_modes_still_update_explicitly_without_config_options():
    calls: list[tuple[str, dict[str, str]]] = []

    class Connection:
        async def set_session_model(self, **kwargs: str) -> None:
            calls.append(("model", kwargs))

        async def set_session_mode(self, **kwargs: str) -> None:
            calls.append(("mode", kwargs))

        async def set_config_option(self, **_kwargs: str) -> None:
            raise AssertionError("legacy modes must use set_session_mode")

    asyncio.run(_configure_session(
        backend="opencode",
        request=runner_request(mode="fullAccess"),
        connection=Connection(),
        session_id="session-1",
        session_response=SimpleNamespace(
            modes=SimpleNamespace(
                available_modes=[
                    SimpleNamespace(id="plan"),
                    SimpleNamespace(id="build"),
                ],
            ),
        ),
    ))

    assert calls[-1] == (
        "mode",
        {"session_id": "session-1", "mode_id": "build"},
    )


def test_opencode_fails_closed_when_the_requested_mode_is_not_advertised():
    class Connection:
        async def set_session_model(self, **_kwargs: str) -> None:
            return None

        async def set_config_option(self, **_kwargs: str) -> None:
            raise AssertionError("unadvertised modes must not be selected")

        async def set_session_mode(self, **_kwargs: str) -> None:
            raise AssertionError("unadvertised modes must not be selected")

    for session_response in [
        SimpleNamespace(session_id="session-1"),
        SimpleNamespace(
            session_id="session-1",
            config_options=[SimpleNamespace(
                id="mode",
                category="mode",
                current_value="plan",
                options=[SimpleNamespace(value="plan")],
            )],
        ),
    ]:
        try:
            asyncio.run(_configure_session(
                backend="opencode",
                request=runner_request(mode="fullAccess"),
                connection=Connection(),
                session_id="session-1",
                session_response=session_response,
            ))
        except RunnerError as error:
            assert error.code == "acp_session_mode_unavailable"
            assert str(error) == "OpenCode ACP session did not advertise the requested mode"
        else:
            raise AssertionError("OpenCode must reject an unavailable session mode")


def test_opencode_fails_closed_when_config_option_update_fails():
    class Connection:
        async def set_session_model(self, **_kwargs: str) -> None:
            return None

        async def set_config_option(self, **_kwargs: str) -> None:
            raise RuntimeError("raw ACP detail must not escape")

    try:
        asyncio.run(_configure_session(
            backend="opencode",
            request=runner_request(mode="plan"),
            connection=Connection(),
            session_id="session-1",
            session_response=SimpleNamespace(
                session_id="session-1",
                config_options=opencode_config_options("build"),
            ),
        ))
    except RunnerError as error:
        assert error.code == "acp_session_mode_update_failed"
        assert str(error) == "OpenCode ACP session mode update failed"
        assert "raw ACP detail" not in str(error)
    else:
        raise AssertionError("OpenCode must reject a failed session mode update")


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


def test_event_bridge_preserves_structured_tool_failure_with_warning_suffix():
    output = io.StringIO()
    bridge = ACPEventBridge(
        backend="hermes-agent",
        request=runner_request(),
        emitter=EventEmitter(output),
    )

    asyncio.run(bridge.session_update(
        "session-1",
        SimpleNamespace(
            session_update="tool_call_update",
            tool_call_id="tool-fail",
            title="Run command",
            kind="execute",
            status="completed",
            raw_input={"command": "pwd"},
            raw_output='{"output":"","exit_code":-1,"error":"PermissionError"}\n\n[Tool loop warning: retrying]',
            locations=[],
            content=[],
        ),
    ))

    emitted = events(output)
    assert emitted[-1]["type"] == "tool_result"
    assert emitted[-1]["success"] is False
    assert emitted[-1]["exitCode"] == -1
    assert emitted[-1]["output"].endswith("[Tool loop warning: retrying]")


def test_opencode_completed_tool_maps_production_user_abort_metadata_to_failure():
    output = io.StringIO()
    bridge = ACPEventBridge(
        backend="opencode",
        request=runner_request(),
        emitter=EventEmitter(output),
    )

    asyncio.run(bridge.session_update(
        "session-1",
        SimpleNamespace(
            session_update="tool_call_update",
            tool_call_id="tool-abort",
            title="Run command",
            kind="execute",
            status="completed",
            raw_input={"command": "sleep 300"},
            raw_output={
                "output": "",
                "metadata": {
                    "exit": None,
                    "output": "(no output)\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>",
                    "truncated": False,
                },
            },
            locations=[],
            content=[],
        ),
    ))

    result = events(output)[-1]
    assert result["success"] is False
    assert "exitCode" not in result


def test_opencode_completed_tool_preserves_metadata_exit_zero():
    output = io.StringIO()
    bridge = ACPEventBridge(
        backend="opencode",
        request=runner_request(),
        emitter=EventEmitter(output),
    )

    asyncio.run(bridge.session_update(
        "session-1",
        SimpleNamespace(
            session_update="tool_call_update",
            tool_call_id="tool-success",
            title="Run command",
            kind="execute",
            status="completed",
            raw_input={"command": "pwd"},
            raw_output={
                "output": "(no output)\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>",
                "metadata": {
                    "exit": 0,
                    "output": "(no output)\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>",
                    "truncated": False,
                },
            },
            locations=[],
            content=[],
        ),
    ))

    result = events(output)[-1]
    assert result["success"] is True
    assert result["exitCode"] == 0
    assert "failureCode" not in result


def _completed_opencode_result(*, kind: str, metadata: dict[str, Any], outer_output: str) -> dict[str, Any]:
    output = io.StringIO()
    bridge = ACPEventBridge(
        backend="opencode",
        request=runner_request(),
        emitter=EventEmitter(output),
    )
    asyncio.run(bridge.session_update(
        "session-1",
        SimpleNamespace(
            session_update="tool_call_update",
            tool_call_id="tool-outcome",
            title="Tool",
            kind=kind,
            status="completed",
            raw_input=None,
            raw_output={"output": outer_output, "metadata": metadata},
            locations=[],
            content=[],
        ),
    ))
    return events(output)[-1]


def test_opencode_completed_execute_classifies_invalid_tool_without_exposing_details():
    fake_private_detail = "fake-private-detail-must-not-escape"
    result = _completed_opencode_result(
        kind="execute",
        metadata={"truncated": False},
        outer_output=f"{OPENCODE_INVALID_TOOL_OUTPUT_PREFIX}{fake_private_detail}",
    )

    assert result["success"] is False
    assert result["failureCode"] == "invalid_tool"
    assert "exitCode" not in result
    assert result["output"] == OPENCODE_INVALID_TOOL_PUBLIC_OUTPUT
    assert OPENCODE_INVALID_TOOL_OUTPUT_PREFIX not in result["output"]
    assert fake_private_detail not in json.dumps(result)


def test_opencode_invalid_tool_classifier_requires_execute_and_absent_exit_key():
    non_execute = _completed_opencode_result(
        kind="read",
        metadata={"truncated": False},
        outer_output=OPENCODE_INVALID_TOOL_OUTPUT_PREFIX,
    )
    null_exit = _completed_opencode_result(
        kind="execute",
        metadata={"exit": None, "truncated": False},
        outer_output=OPENCODE_INVALID_TOOL_OUTPUT_PREFIX,
    )
    ordinary = _completed_opencode_result(
        kind="execute",
        metadata={"truncated": False},
        outer_output="ordinary output",
    )

    for result in (non_execute, null_exit, ordinary):
        assert result["success"] is True
        assert "failureCode" not in result
        assert "exitCode" not in result


def test_opencode_metadata_exit_remains_authoritative_over_invalid_tool_prefix():
    success = _completed_opencode_result(
        kind="execute",
        metadata={"exit": 0, "truncated": False},
        outer_output=OPENCODE_INVALID_TOOL_OUTPUT_PREFIX,
    )
    failure = _completed_opencode_result(
        kind="execute",
        metadata={"exit": 2, "truncated": False},
        outer_output=OPENCODE_INVALID_TOOL_OUTPUT_PREFIX,
    )

    assert (success["success"], success["exitCode"]) == (True, 0)
    assert (failure["success"], failure["exitCode"]) == (False, 2)
    assert "failureCode" not in success
    assert "failureCode" not in failure


def test_opencode_failed_status_does_not_reclassify_as_invalid_tool():
    output = io.StringIO()
    bridge = ACPEventBridge(
        backend="opencode",
        request=runner_request(),
        emitter=EventEmitter(output),
    )
    asyncio.run(bridge.session_update(
        "session-1",
        SimpleNamespace(
            session_update="tool_call_update",
            tool_call_id="tool-failed",
            title="Tool",
            kind="execute",
            status="failed",
            raw_input=None,
            raw_output={
                "output": OPENCODE_INVALID_TOOL_OUTPUT_PREFIX,
                "metadata": {"truncated": False},
            },
            locations=[],
            content=[],
        ),
    ))

    result = events(output)[-1]
    assert result["success"] is False
    assert "failureCode" not in result


def test_opencode_non_terminal_abort_metadata_is_not_an_abort_sentinel():
    output = io.StringIO()
    bridge = ACPEventBridge(
        backend="opencode",
        request=runner_request(),
        emitter=EventEmitter(output),
    )

    asyncio.run(bridge.session_update(
        "session-1",
        SimpleNamespace(
            session_update="tool_call_update",
            tool_call_id="tool-partial",
            title="Run command",
            kind="execute",
            status="completed",
            raw_input={"command": "cat output"},
            raw_output={
                "output": "partial",
                "metadata": {
                    "output": "partial\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>\ntrailing",
                    "truncated": False,
                },
            },
            locations=[],
            content=[],
        ),
    ))

    result = events(output)[-1]
    assert result["success"] is True
    assert "exitCode" not in result


def test_opencode_output_containing_aborted_is_not_an_abort_sentinel():
    output = io.StringIO()
    bridge = ACPEventBridge(
        backend="opencode",
        request=runner_request(),
        emitter=EventEmitter(output),
    )

    asyncio.run(bridge.session_update(
        "session-1",
        SimpleNamespace(
            session_update="tool_call_update",
            tool_call_id="tool-text",
            title="Run command",
            kind="execute",
            status="completed",
            raw_input={"command": "printf aborted"},
            raw_output={
                "output": "aborted is ordinary command output",
                "metadata": {
                    "output": "aborted is ordinary command output",
                    "truncated": False,
                },
            },
            locations=[],
            content=[],
        ),
    ))

    result = events(output)[-1]
    assert result["success"] is True
    assert "exitCode" not in result


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


def test_hermes_extra_ambiguous_state_rows_fail_closed_without_exposing_blocked_output(tmp_path: Path):
    fake_blocked_output = "ROOMTALK_PRIVATE_TOKEN=fake-blocked-tool-output"
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
                tool_call_id="visible-read",
                title="read_file",
                kind="read",
                raw_input={"path": "README.md"},
                locations=[],
                content=[],
            ),
        )
        with sqlite3.connect(state_db) as connection:
            connection.executemany(
                "INSERT INTO messages (session_id, role, content, tool_name) VALUES (?, 'tool', ?, ?)",
                [
                    ("session-1", fake_blocked_output, "read_file"),
                    ("session-1", '{"content":"visible result"}', "read_file"),
                ],
            )
        await bridge.flush_tools_at_final("session-1")

    asyncio.run(run())

    emitted = events(output)
    assert [event["type"] for event in emitted] == ["tool_call", "tool_result"]
    assert emitted[1]["success"] is False
    assert emitted[1]["output"] == ACP_MISSING_TERMINAL_TOOL_RESULT_OUTPUT
    assert fake_blocked_output not in json.dumps(emitted)


def test_hermes_extra_distinct_state_row_allows_unique_exact_visible_match(tmp_path: Path):
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
                tool_call_id="visible-read",
                title="read_file",
                kind="read",
                raw_input={"path": "README.md"},
                locations=[],
                content=[],
            ),
        )
        with sqlite3.connect(state_db) as connection:
            connection.executemany(
                "INSERT INTO messages (session_id, role, content, tool_name) VALUES (?, 'tool', ?, ?)",
                [
                    ("session-1", '{"output":"unrelated","exit_code":0}', "terminal"),
                    ("session-1", '{"content":"visible result"}', "read_file"),
                ],
            )
        await bridge.flush_tools_at_final("session-1")

    asyncio.run(run())

    emitted = events(output)
    assert [event["type"] for event in emitted] == ["tool_call", "tool_result"]
    assert emitted[1]["success"] is True
    assert emitted[1]["output"] == '{"content":"visible result"}'


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


def test_hermes_event_bridge_marks_leading_json_failure_with_warning_suffix(tmp_path: Path):
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
                title="Run command",
                kind="execute",
                raw_input={"command": "pwd"},
                locations=[],
                content=[],
            ),
        )
        with sqlite3.connect(state_db) as connection:
            connection.execute(
                "INSERT INTO messages (session_id, role, content, tool_name) VALUES (?, 'tool', ?, ?)",
                (
                    "session-1",
                    '{"output":"","exit_code":-1,"error":"PermissionError"}\n\n[Tool loop warning: retrying]',
                    "terminal",
                ),
            )
        await bridge.flush_tools_at_final("session-1")

    asyncio.run(run())

    emitted = events(output)
    assert emitted[-1]["type"] == "tool_result"
    assert emitted[-1]["success"] is False
    assert emitted[-1]["exitCode"] == -1


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
                session_update="tool_call",
                tool_call_id="tool-2",
                title="Second read",
                kind="read",
                raw_input={"path": "SECOND.md"},
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
    assert [event["type"] for event in emitted] == [
        "tool_call",
        "tool_call",
        "tool_result",
        "tool_result",
    ]
    assert [event["success"] for event in emitted[2:]] == [False, False]
    assert [event["output"] for event in emitted[2:]] == [
        ACP_MISSING_TERMINAL_TOOL_RESULT_OUTPUT,
        ACP_MISSING_TERMINAL_TOOL_RESULT_OUTPUT,
    ]
    assert "partial contents" not in json.dumps(emitted[2:])


def test_event_bridge_preserves_explicit_terminal_tool_results_without_duplicates():
    output = io.StringIO()
    bridge = ACPEventBridge(
        backend="opencode",
        request=runner_request(),
        emitter=EventEmitter(output),
    )

    async def run() -> None:
        for tool_call_id, status, raw_output in (
            ("tool-complete", "completed", "complete output"),
            ("tool-failed", "failed", "failed output"),
        ):
            await bridge.session_update(
                "session-1",
                SimpleNamespace(
                    session_update="tool_call",
                    tool_call_id=tool_call_id,
                    title="Tool",
                    kind="read",
                    status=status,
                    raw_input=None,
                    raw_output=raw_output,
                    locations=[],
                    content=[],
                ),
            )

    asyncio.run(run())
    bridge.close_tools_at_final()
    bridge.close_tools_at_final()

    emitted = events(output)
    assert [event["type"] for event in emitted] == [
        "tool_call",
        "tool_result",
        "tool_call",
        "tool_result",
    ]
    assert [(event["success"], event["output"]) for event in emitted if event["type"] == "tool_result"] == [
        (True, "complete output"),
        (False, "failed output"),
    ]


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
