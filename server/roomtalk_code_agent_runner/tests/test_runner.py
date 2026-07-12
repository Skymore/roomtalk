from __future__ import annotations

import io
import json
import os
import queue
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from roomtalk_code_agent_runner.runner import (
    EventEmitter,
    RunnerError,
    RunnerRequest,
    UNBOUNDED_MODEL_STEPS,
    _add_code_agent_source_to_path,
    _api_key_for,
    _base_url_for,
    _coco_step_limits,
    _collect_static_publish_files,
    _partial_history_for_steer,
    _read_only_shell_argv,
    _model_step_event_from_response,
    canonical_allowed_paths_for_engine,
    main,
    parse_request,
    replay_tool_events,
    resolve_allowed_roots,
    run_request,
    scoped_workspace_cwd,
    system_prompt_for_tools,
    tool_names_for_mode,
    validate_workspace_path,
)


def request(**overrides):
    payload = {
        "schemaVersion": 1,
        "type": "run",
        "roomId": "room-1",
        "turnId": "turn-1",
        "sessionId": None,
        "prompt": "inspect the project",
        "mode": "plan",
        "provider": "openrouter",
        "modelId": "deepseek-v4-pro",
        "apiModel": "deepseek/deepseek-v4-pro",
        "workspace": "/tmp/workspace",
        "allowedPaths": ["."],
    }
    payload.update(overrides)
    return payload


def event_lines(buffer: io.StringIO):
    return [json.loads(line) for line in buffer.getvalue().splitlines() if line.strip()]


def test_coco_model_step_limits_are_unbounded_by_default_and_configurable():
    assert UNBOUNDED_MODEL_STEPS == sys.maxsize
    assert _coco_step_limits({}) == (sys.maxsize, sys.maxsize)
    assert _coco_step_limits({
        "COCO_MAX_STEPS_SIMPLE": "40",
        "COCO_MAX_STEPS_COMPLEX": "100",
    }) == (40, 100)

    with pytest.raises(RunnerError, match="COCO_MAX_STEPS_SIMPLE must be a positive integer"):
        _coco_step_limits({"COCO_MAX_STEPS_SIMPLE": "0"})


def test_parse_request_validates_schema_and_required_fields():
    parsed = parse_request(json.dumps(request()))

    assert parsed.room_id == "room-1"
    assert parsed.turn_id == "turn-1"
    assert parsed.mode == "plan"
    assert parsed.allowed_paths == (".",)
    assert parsed.prior_messages == []
    assert parsed.images == ()
    assert parsed.codex_model is None
    assert parsed.codex_reasoning_effort is None
    assert parsed.codex_permission_mode is None
    assert parsed.codex_service_tier is None

    parsed_codex = parse_request(json.dumps(request(
        codexModel="gpt-5.5",
        codexReasoningEffort="xhigh",
        codexPermissionMode="approveForMe",
        codexServiceTier="priority",
    )))
    assert parsed_codex.codex_model == "gpt-5.5"
    assert parsed_codex.codex_reasoning_effort == "xhigh"
    assert parsed_codex.codex_permission_mode == "approveForMe"
    assert parsed_codex.codex_service_tier == "priority"

    prior_messages = [
        {"role": "user", "content": "list files"},
        {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "I will inspect."},
                {"type": "tool_use", "id": "tool-1", "name": "Glob", "input": {"pattern": "**/*"}},
            ],
        },
        {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": "tool-1", "content": "No files found."},
            ],
        },
    ]
    parsed_with_prior = parse_request(json.dumps(request(priorMessages=prior_messages)))
    assert parsed_with_prior.prior_messages == prior_messages

    parsed_with_image = parse_request(json.dumps(request(images=[{
        "url": "https://media.example/signed/input.png?token=secret",
    }])))
    assert parsed_with_image.images[0].url == "https://media.example/signed/input.png?token=secret"

    with pytest.raises(RunnerError, match="Unsupported schemaVersion"):
        parse_request(json.dumps(request(schemaVersion=2)))

    with pytest.raises(RunnerError, match="Expected non-empty string field 'prompt'"):
        parse_request(json.dumps(request(prompt="")))

    with pytest.raises(RunnerError, match="Invalid tool_use block"):
        parse_request(json.dumps(request(priorMessages=[{
            "role": "assistant",
            "content": [{"type": "tool_use", "id": "tool-1", "name": "Glob", "input": "bad"}],
        }])))

    with pytest.raises(RunnerError, match="must be an absolute HTTPS URL"):
        parse_request(json.dumps(request(images=[{
            "url": "/api/media/private.png",
        }])))

    with pytest.raises(RunnerError, match="must be an absolute HTTPS URL"):
        parse_request(json.dumps(request(images=[{
            "url": "file:///tmp/private.png",
        }])))


def test_partial_steer_history_preserves_current_image_urls():
    image_url = "https://media.example/signed/input.png?token=secret"
    history = _partial_history_for_steer([], "describe this", "partial", [image_url])

    assert history == [
        {
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "url", "url": image_url}},
                {"type": "text", "text": "describe this"},
            ],
        },
        {"role": "assistant", "content": "partial"},
    ]


def test_allowed_paths_are_workspace_relative_and_cannot_escape(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    inside = workspace / "src"
    inside.mkdir()

    roots = resolve_allowed_roots(workspace, [".", "src"])
    assert roots == (workspace.resolve(), inside.resolve())
    assert canonical_allowed_paths_for_engine(workspace, [".", "src"]) == (".", "src")

    with pytest.raises(RunnerError, match="escapes workspace"):
        resolve_allowed_roots(workspace, [".."])


def test_workspace_path_must_stay_inside_configured_root(tmp_path: Path, monkeypatch):
    workspace_root = tmp_path / "workspaces"
    inside = workspace_root / "room-1"
    outside = tmp_path / "outside"
    monkeypatch.setenv("CODE_AGENT_WORKSPACE_ROOT", str(workspace_root))

    assert validate_workspace_path(inside) == inside.resolve()

    with pytest.raises(RunnerError, match="absolute path"):
        validate_workspace_path(Path("relative-workspace"))

    with pytest.raises(RunnerError, match="CODE_AGENT_WORKSPACE_ROOT"):
        validate_workspace_path(outside)

    assert not outside.exists()


def test_tool_policy_keeps_plan_read_only_and_requires_explicit_write_or_shell_flags():
    assert tool_names_for_mode("plan", {
        "ROOMTALK_CODE_AGENT_ALLOW_WRITE_TOOLS": "true",
        "ROOMTALK_CODE_AGENT_ALLOW_SHELL": "true",
    }) == ("Read", "Glob", "Grep", "Shell")
    assert tool_names_for_mode("plan", {}) == ("Read", "Glob", "Grep")

    assert tool_names_for_mode("acceptEdits", {}) == ("Read", "Glob", "Grep")
    assert tool_names_for_mode("acceptEdits", {"ROOMTALK_CODE_AGENT_ALLOW_WRITE_TOOLS": "true"}) == (
        "Read",
        "Glob",
        "Grep",
        "Write",
        "Edit",
    )
    assert tool_names_for_mode("acceptEdits", {
        "ROOMTALK_CODE_AGENT_ALLOW_WRITE_TOOLS": "true",
        "ROOMTALK_CODE_AGENT_ALLOW_SHELL": "true",
    }) == ("Read", "Glob", "Grep", "Write", "Edit", "Shell", "BackgroundShell")
    assert tool_names_for_mode("acceptEdits", {
        "ROOMTALK_CODE_AGENT_ENABLE_STATIC_PUBLISH": "true",
        "ROOMTALK_STATIC_PUBLISH_URL": "https://room.example/api/code-agent/publish-static-site",
        "ROOMTALK_STATIC_PUBLISH_TOKEN": "turn-token",
    }) == ("Read", "Glob", "Grep")
    assert tool_names_for_mode("fullAccess", {
        "ROOMTALK_CODE_AGENT_ALLOW_WRITE_TOOLS": "true",
        "ROOMTALK_CODE_AGENT_ALLOW_SHELL": "true",
        "ROOMTALK_CODE_AGENT_ENABLE_STATIC_PUBLISH": "true",
        "ROOMTALK_STATIC_PUBLISH_URL": "https://room.example/api/code-agent/publish-static-site",
        "ROOMTALK_STATIC_PUBLISH_TOKEN": "turn-token",
    }) == (
        "Read",
        "Glob",
        "Grep",
        "Write",
        "Edit",
        "Shell",
        "BackgroundShell",
    )


def test_tool_policy_treats_empty_env_as_an_isolated_environment(monkeypatch):
    monkeypatch.setenv("ROOMTALK_CODE_AGENT_ALLOW_WRITE_TOOLS", "true")
    monkeypatch.setenv("ROOMTALK_CODE_AGENT_ALLOW_SHELL", "true")

    assert tool_names_for_mode("acceptEdits", {}) == ("Read", "Glob", "Grep")


def test_system_prompt_matches_the_actual_tool_set():
    plan_prompt = system_prompt_for_tools(("Read", "Glob", "Grep", "Shell"), "plan")
    assert "- Read:" in plan_prompt
    assert "- Write:" not in plan_prompt
    assert "- Shell:" in plan_prompt
    assert "Unavailable tools for this run: Write, Edit, BackgroundShell" in plan_prompt
    assert "read-only" in plan_prompt
    assert "OS sandbox" in plan_prompt
    room_context_prompt = system_prompt_for_tools(
        ("Read", "Glob", "Grep", "Shell"),
        "plan",
        room_context_enabled=True,
    )
    assert "RoomTalk is the source of truth" in room_context_prompt
    assert "roomtalk room history --limit 20 --json" in room_context_prompt
    assert "roomtalk site list --json" in room_context_prompt

    edit_prompt = system_prompt_for_tools(("Read", "Glob", "Grep", "Write", "Edit"), "acceptEdits")
    assert "- Write:" in edit_prompt
    assert "- Edit:" in edit_prompt
    assert "- Shell:" not in edit_prompt
    assert "Unavailable tools for this run: Shell, BackgroundShell" in edit_prompt
    shell_prompt = system_prompt_for_tools(("Read", "Glob", "Grep", "Write", "Edit", "Shell", "BackgroundShell"), "acceptEdits")
    assert "- BackgroundShell:" in shell_prompt
    assert "Use Shell only for foreground commands" in shell_prompt
    assert "Keep all downloaded repositories, fetched reference files, generated files, and publish roots inside the current workspace" in shell_prompt
    assert "Do not work in /tmp or /var/tmp" in shell_prompt
    site_prompt = system_prompt_for_tools(
        ("Read", "Glob", "Grep", "Shell"),
        "acceptEdits",
        room_context_enabled=True,
        static_site_write_enabled=True,
    )
    assert "PublishStaticSite" not in site_prompt
    assert "roomtalk site list --json" in site_prompt
    assert "roomtalk site publish --root <dir>" in site_prompt
    assert "roomtalk site unpublish --slug <slug>" in site_prompt


def test_read_only_shell_uses_os_sandbox_and_disables_network_by_default(tmp_path: Path):
    argv = _read_only_shell_argv("git status --short", tmp_path, {"PATH": "/usr/bin:/bin"})

    assert argv[0] == "bwrap"
    assert "--unshare-all" in argv
    assert "--share-net" not in argv
    assert argv[argv.index("--ro-bind") + 1:argv.index("--ro-bind") + 3] == ["/", "/"]
    assert ["--tmpfs", "/tmp"] == argv[argv.index("--tmpfs"):argv.index("--tmpfs") + 2]
    assert argv[-3:] == ["/bin/sh", "-lc", "git status --short"]


def test_read_only_shell_keeps_network_off_and_exposes_scoped_room_context_socket(tmp_path: Path):
    socket_path = str(tmp_path / "room-context.sock")
    argv = _read_only_shell_argv("roomtalk room history --json", tmp_path, {
        "PYTHONPATH": "/opt/code-agent-engine/src:/opt/roomtalk_code_agent_runner",
        "ROOMTALK_ROOM_CONTEXT_SOCKET": socket_path,
    })

    assert "--share-net" not in argv
    assert "ROOMTALK_ROOM_CONTEXT_SOCKET" in argv
    assert argv[argv.index("ROOMTALK_ROOM_CONTEXT_SOCKET") + 1] == socket_path
    assert argv[argv.index("PYTHONPATH") + 1] == "/opt/code-agent-engine/src:/opt/roomtalk_code_agent_runner"
    assert "ROOMTALK_STATIC_PUBLISH_TOKEN" not in argv
    assert argv[argv.index("ROOMTALK_CODE_AGENT_CLI_ACCESS") + 1] == "read-only"


def test_static_publish_file_collection_is_scoped_and_filters_non_static_files(tmp_path: Path):
    workspace = tmp_path / "workspace"
    site = workspace / "site"
    assets = site / "assets"
    assets.mkdir(parents=True)
    (site / "index.html").write_text("<!doctype html><script src='assets/app.js'></script>", encoding="utf-8")
    (assets / "app.js").write_text("console.log('ok')", encoding="utf-8")
    (site / "app.py").write_text("print('not static')", encoding="utf-8")
    (site / ".DS_Store").write_text("ignored", encoding="utf-8")

    entry, files, total_bytes = _collect_static_publish_files(workspace, {"root": "site"})

    assert entry == "index.html"
    assert [file["path"] for file in files] == ["assets/app.js", "index.html"]
    assert total_bytes == sum(file["byteSize"] for file in files)

    with pytest.raises(RunnerError, match="root must stay inside"):
        _collect_static_publish_files(workspace, {"root": ".."})


def test_static_publish_file_collection_rejects_secret_like_files(tmp_path: Path):
    workspace = tmp_path / "workspace"
    site = workspace / "site"
    site.mkdir(parents=True)
    (site / "index.html").write_text("<!doctype html>", encoding="utf-8")
    (site / ".env").write_text("SECRET=value", encoding="utf-8")

    with pytest.raises(RunnerError, match="secret-like"):
        _collect_static_publish_files(workspace, {"root": "site"})


def test_replay_tool_events_preserves_pairing_and_result_metadata():
    messages = [
        {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "I will run tests."},
                {"type": "tool_use", "id": "tool-1", "name": "Shell", "input": {"command": "pytest"}},
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "tool-1",
                    "content": [{"type": "text", "text": "failed\n[exit code: 2]"}],
                },
            ],
        },
    ]

    events = replay_tool_events(messages, turn_id="turn-1")

    assert events == [
        {"type": "tool_call", "id": "tool-1", "name": "Shell", "args": {"command": "pytest"}, "turnId": "turn-1"},
        {
            "type": "tool_result",
            "id": "tool-1",
            "name": "Shell",
            "success": False,
            "output": "failed\n[exit code: 2]",
            "exitCode": 2,
            "turnId": "turn-1",
        },
    ]


def test_replay_tool_events_uses_structured_errors_and_non_text_content():
    messages = [
        {
            "role": "assistant",
            "content": [
                {"type": "tool_use", "id": "tool-1", "name": "Read", "input": {"file_path": "missing.txt"}},
                {"type": "tool_use", "id": "tool-2", "name": "Screenshot", "input": {}},
                {"type": "tool_use", "id": "tool-3", "name": "Read", "input": {"file_path": "plain.txt"}},
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "tool-1",
                    "content": "FileNotFoundError: missing.txt",
                    "is_error": True,
                },
                {
                    "type": "tool_result",
                    "tool_use_id": "tool-2",
                    "content": [{"type": "image", "source": {"type": "base64", "data": "abc"}}],
                },
                {
                    "type": "tool_result",
                    "tool_use_id": "tool-3",
                    "content": "FileNotFoundError: plain text without structured error marker",
                },
            ],
        },
    ]

    events = replay_tool_events(messages)

    results = [event for event in events if event["type"] == "tool_result"]
    assert [event["id"] for event in results] == ["tool-1", "tool-2", "tool-3"]
    assert results[0]["success"] is False
    assert results[1]["success"] is True
    assert results[1]["output"] == "[non-text content omitted]"
    assert results[2]["success"] is True


def test_add_code_agent_source_to_path_validates_configured_directory(tmp_path: Path):
    source_dir = tmp_path / "code-agent-engine-src"
    source_dir.mkdir()

    _add_code_agent_source_to_path({"CODE_AGENT_SOURCE_DIR": str(source_dir)})
    _add_code_agent_source_to_path({"CODE_AGENT_SOURCE_DIR": str(source_dir)})

    assert str(source_dir.resolve()) in sys.path
    assert sys.path.count(str(source_dir.resolve())) == 1

    with pytest.raises(RunnerError, match="CODE_AGENT_SOURCE_DIR does not exist"):
        _add_code_agent_source_to_path({"CODE_AGENT_SOURCE_DIR": str(tmp_path / "missing")})


def test_model_proxy_env_overrides_direct_provider_credentials():
    env = {
        "CODE_AGENT_MODEL_PROXY_URL": "https://model-proxy.internal/",
        "CODE_AGENT_MODEL_PROXY_TOKEN": "short-lived-proxy-token",
        "DEEPSEEK_API_KEY": "must-not-use",
        "DEEPSEEK_BASE_URL": "https://api.deepseek.com",
    }

    assert _api_key_for("deepseek", env) == "short-lived-proxy-token"
    assert _base_url_for("deepseek", env) == "https://model-proxy.internal"

    with pytest.raises(RunnerError, match="CODE_AGENT_MODEL_PROXY_TOKEN is required"):
        _api_key_for("deepseek", {"CODE_AGENT_MODEL_PROXY_URL": "https://model-proxy.internal"})

    with pytest.raises(RunnerError, match="CODE_AGENT_MODEL_PROXY_URL must be an HTTPS URL"):
        _base_url_for("deepseek", {
            "CODE_AGENT_MODEL_PROXY_URL": "http://model-proxy.internal",
            "CODE_AGENT_MODEL_PROXY_TOKEN": "short-lived-proxy-token",
        })


def test_model_proxy_base_url_matches_provider_sdk_path_contracts():
    env = {
        "CODE_AGENT_MODEL_PROXY_URL": "https://room.example/api/code-agent/model-gateway/v1/",
        "CODE_AGENT_MODEL_PROXY_TOKEN": "short-lived-proxy-token",
    }

    assert _base_url_for("anthropic", env) == "https://room.example/api/code-agent/model-gateway"
    assert _base_url_for("deepseek", env) == "https://room.example/api/code-agent/model-gateway/v1"
    assert _base_url_for("openrouter", env) == "https://room.example/api/code-agent/model-gateway/v1"
    assert _base_url_for("openai", env) == "https://room.example/api/code-agent/model-gateway/v1"


@dataclass
class Usage:
    input_tokens: int = 10
    output_tokens: int = 5
    cache_read: int = 4


@dataclass
class EngineResult:
    answer: str
    messages: list[dict]
    usage: Usage | None = None


@dataclass
class ModelResponse:
    content: list[dict[str, Any]]
    usage: Usage | None = None


def test_model_step_event_preserves_text_tools_and_per_hop_usage():
    event = _model_step_event_from_response(ModelResponse(
        content=[
            {"type": "text", "text": "I will inspect."},
            {"type": "tool_use", "id": "tool-1", "name": "Read", "input": {}},
            {"type": "tool_use", "id": "tool-2", "name": "Glob", "input": {}},
        ],
        usage=Usage(input_tokens=30, output_tokens=7, cache_read=10),
    ), "turn-1", 3)

    assert event == {
        "type": "model_step",
        "turnId": "turn-1",
        "stepId": "turn-1:step:3",
        "sequence": 3,
        "hasText": True,
        "toolCallIds": ["tool-1", "tool-2"],
        "usage": {
            "promptTokens": 30,
            "completionTokens": 7,
            "totalTokens": 37,
            "cachedPromptTokens": 10,
            "cacheHitRate": 1 / 3,
            "source": "reported",
        },
    }


def test_model_step_event_keeps_tool_only_hop_billable():
    event = _model_step_event_from_response(ModelResponse(
        content=[{"type": "tool_use", "id": "tool-1", "name": "Shell", "input": {}}],
        usage=Usage(),
    ), "turn-1", 1)

    assert event["hasText"] is False
    assert event["toolCallIds"] == ["tool-1"]
    assert event["usage"]["source"] == "reported"


def test_model_step_event_rejects_unbillable_empty_response():
    with pytest.raises(RunnerError, match="neither text nor tool calls"):
        _model_step_event_from_response(ModelResponse(content=[], usage=Usage()), "turn-1", 1)


class FakeEngine:
    def run(self, prompt, on_text_chunk=None):
        assert prompt == "inspect the project"
        on_text_chunk("hello ")
        on_text_chunk("world")
        return EngineResult(
            answer="hello world",
            usage=Usage(),
            messages=[
                {
                    "role": "assistant",
                    "content": [
                        {"type": "tool_use", "id": "tool-1", "name": "Read", "input": {"file_path": "README.md"}},
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "tool_result", "tool_use_id": "tool-1", "content": "# Project"},
                    ],
                },
            ],
        )


class KwargsOnlyEngine(FakeEngine):
    def run(self, prompt, on_text_chunk=None, **kwargs):
        assert "on_tool_event" not in kwargs
        return super().run(prompt, on_text_chunk=on_text_chunk)


class LiveToolEventEngine:
    def run(self, prompt, on_text_chunk=None, on_tool_event=None):
        assert prompt == "inspect the project"
        on_text_chunk("before ")
        on_tool_event({
            "type": "tool_call",
            "id": "tool-1",
            "name": "Read",
            "input": {"file_path": "README.md"},
        })
        on_tool_event({
            "type": "tool_result",
            "id": "tool-1",
            "name": "Read",
            "input": {"file_path": "README.md"},
            "success": True,
            "output": "# Project",
            "elapsed_ms": 12.5,
        })
        on_text_chunk("after")
        return EngineResult(
            answer="after",
            usage=Usage(),
            messages=[
                {
                    "role": "assistant",
                    "content": [
                        {"type": "tool_use", "id": "tool-1", "name": "Read", "input": {"file_path": "README.md"}},
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "tool_result", "tool_use_id": "tool-1", "content": "# Project"},
                    ],
                },
            ],
        )


class PriorAwareEngine:
    def __init__(self, expected_prior_messages):
        self.expected_prior_messages = expected_prior_messages

    def run(self, prompt, prior_messages=None, on_text_chunk=None):
        assert prompt == "inspect the project"
        assert prior_messages == self.expected_prior_messages
        return EngineResult(answer="ok", messages=[], usage=None)


class ImageUrlAwareEngine:
    def run(self, prompt, prior_messages=None, image_urls=None, on_text_chunk=None):
        assert prompt == "inspect the project"
        assert prior_messages is None
        assert image_urls == ["https://media.example/signed/input.png?token=secret"]
        return EngineResult(answer="image inspected", messages=[], usage=Usage())


def test_run_request_falls_back_to_replay_for_kwargs_only_engine(monkeypatch):
    output = io.StringIO()
    parsed = parse_request(json.dumps(request()))
    monkeypatch.setenv("CODE_AGENT_WORKSPACE_ROOT", "/tmp")

    run_request(parsed, emitter=EventEmitter(output), engine_factory=lambda _request: KwargsOnlyEngine())

    events = event_lines(output)
    assert [event["type"] for event in events] == [
        "status",
        "status",
        "text_delta",
        "text_delta",
        "tool_call",
        "tool_result",
        "final",
    ]
    assert events[4]["id"] == "tool-1"
    assert events[5]["id"] == "tool-1"
    assert events[5]["output"] == "# Project"


def test_run_request_uses_live_tool_events_without_replay(monkeypatch):
    output = io.StringIO()
    parsed = parse_request(json.dumps(request()))
    monkeypatch.setenv("CODE_AGENT_WORKSPACE_ROOT", "/tmp")

    run_request(parsed, emitter=EventEmitter(output), engine_factory=lambda _request: LiveToolEventEngine())

    events = event_lines(output)
    assert [event["type"] for event in events] == [
        "status",
        "status",
        "text_delta",
        "tool_call",
        "tool_result",
        "text_delta",
        "final",
    ]
    assert events[2]["delta"] == "before "
    assert events[3] == {
        "schemaVersion": 1,
        "type": "tool_call",
        "id": "tool-1",
        "name": "Read",
        "args": {"file_path": "README.md"},
        "turnId": "turn-1",
    }
    assert events[4]["id"] == "tool-1"
    assert events[4]["output"] == "# Project"
    assert events[4]["success"] is True
    assert events[4]["elapsedMs"] == 12.5
    assert events[5]["delta"] == "after"
    assert len([event for event in events if event["type"] == "tool_call"]) == 1
    assert len([event for event in events if event["type"] == "tool_result"]) == 1


def test_run_request_passes_prior_messages_to_code_agent_engine(monkeypatch):
    prior_messages = [
        {"role": "user", "content": "list files"},
        {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "I will inspect."},
                {"type": "tool_use", "id": "tool-1", "name": "Glob", "input": {"pattern": "**/*"}},
            ],
        },
        {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": "tool-1", "content": "No files found."},
            ],
        },
    ]
    output = io.StringIO()
    parsed = parse_request(json.dumps(request(priorMessages=prior_messages)))
    monkeypatch.setenv("CODE_AGENT_WORKSPACE_ROOT", "/tmp")

    run_request(
        parsed,
        emitter=EventEmitter(output),
        engine_factory=lambda _request: PriorAwareEngine(prior_messages),
    )

    events = event_lines(output)
    assert events[-1]["type"] == "final"
    assert events[-1]["answer"] == "ok"


def test_run_request_passes_remote_image_urls_to_coco_engine(monkeypatch):
    output = io.StringIO()
    parsed = parse_request(json.dumps(request(images=[{
        "url": "https://media.example/signed/input.png?token=secret",
    }])))
    monkeypatch.setenv("CODE_AGENT_WORKSPACE_ROOT", "/tmp")

    run_request(
        parsed,
        emitter=EventEmitter(output),
        engine_factory=lambda _request: ImageUrlAwareEngine(),
    )

    events = event_lines(output)
    assert events[-1]["type"] == "final"
    assert events[-1]["answer"] == "image inspected"


def test_run_request_emits_tool_events_before_terminal_final(monkeypatch):
    output = io.StringIO()
    parsed = parse_request(json.dumps(request()))
    monkeypatch.setenv("CODE_AGENT_WORKSPACE_ROOT", "/tmp")

    run_request(parsed, emitter=EventEmitter(output), engine_factory=lambda _request: FakeEngine())

    events = event_lines(output)
    assert [event["type"] for event in events] == [
        "status",
        "status",
        "text_delta",
        "text_delta",
        "tool_call",
        "tool_result",
        "final",
    ]
    assert events[-1]["answer"] == "hello world"
    assert events[-1]["sessionId"] == "turn-1"
    assert events[-1]["usage"]["promptTokens"] == 10
    assert events[-1]["usage"]["cachedPromptTokens"] == 4
    assert events[-1]["usage"]["cacheHitRate"] == 0.4


def test_run_request_reports_zero_cache_hit_rate(monkeypatch):
    output = io.StringIO()
    parsed = parse_request(json.dumps(request()))
    monkeypatch.setenv("CODE_AGENT_WORKSPACE_ROOT", "/tmp")

    class UncachedEngine:
        def run(self, prompt, on_text_chunk=None):
            return EngineResult(answer="ok", messages=[], usage=Usage(cache_read=0))

    run_request(parsed, emitter=EventEmitter(output), engine_factory=lambda _request: UncachedEngine())

    events = event_lines(output)
    assert events[-1]["type"] == "final"
    assert events[-1]["usage"]["cachedPromptTokens"] == 0
    assert events[-1]["usage"]["cacheHitRate"] == 0


def test_run_request_scopes_and_restores_cwd(tmp_path: Path, monkeypatch):
    output = io.StringIO()
    workspace = tmp_path / "workspace"
    parsed = parse_request(json.dumps(request(workspace=str(workspace))))
    original_cwd = Path.cwd()
    monkeypatch.setenv("CODE_AGENT_WORKSPACE_ROOT", str(tmp_path))

    class CwdCheckingEngine:
        def run(self, prompt, on_text_chunk=None):
            assert Path.cwd() == workspace.resolve()
            return EngineResult(answer="ok", messages=[])

    def engine_factory(_request):
        assert Path.cwd() == workspace.resolve()
        return CwdCheckingEngine()

    run_request(parsed, emitter=EventEmitter(output), engine_factory=engine_factory)

    assert Path.cwd() == original_cwd
    assert workspace.is_dir()


def test_scoped_workspace_cwd_restores_cwd_after_error(tmp_path: Path, monkeypatch):
    workspace = tmp_path / "workspace"
    original_cwd = Path.cwd()
    monkeypatch.setenv("CODE_AGENT_WORKSPACE_ROOT", str(tmp_path))

    with pytest.raises(RuntimeError, match="boom"):
        with scoped_workspace_cwd(workspace):
            assert Path.cwd() == workspace.resolve()
            raise RuntimeError("boom")

    assert Path.cwd() == original_cwd


def test_run_request_applies_coco_steer_without_ending_the_turn(tmp_path: Path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setenv("CODE_AGENT_WORKSPACE_ROOT", str(tmp_path))
    parsed = parse_request(json.dumps(request(workspace=str(workspace))))
    controls: "queue.Queue[dict[str, Any] | None]" = queue.Queue()
    output = io.StringIO()

    class SteerableEngine:
        def __init__(self):
            self.started = threading.Event()
            self.aborted = threading.Event()
            self.prompts: list[str] = []
            self.prior_messages: list[list[dict] | None] = []

        def abort(self):
            self.aborted.set()

        def run(self, prompt, prior_messages=None, on_text_chunk=None):
            self.prompts.append(prompt)
            self.prior_messages.append(prior_messages)
            if len(self.prompts) == 1:
                on_text_chunk("before steer ")
                self.started.set()
                assert self.aborted.wait(timeout=2)
                self.aborted.clear()
                raise RuntimeError("aborted for steer")
            assert "use Bing instead" in prompt
            on_text_chunk("after steer")
            return EngineResult(answer="after steer", messages=[], usage=Usage())

    engine = SteerableEngine()
    thread = threading.Thread(
        target=run_request,
        kwargs={
            "request": parsed,
            "emitter": EventEmitter(output),
            "engine_factory": lambda _request: engine,
            "control_queue": controls,
        },
    )
    thread.start()
    assert engine.started.wait(timeout=2)
    controls.put({
        "schemaVersion": 1,
        "type": "steer",
        "turnId": parsed.turn_id,
        "controlId": "control-steer-1",
        "messageId": "queued-steer-1",
        "prompt": "use Bing instead",
    })
    thread.join(timeout=3)

    assert not thread.is_alive()
    assert len(engine.prompts) == 2
    assert engine.prior_messages[1][-2:] == [
        {"role": "user", "content": "inspect the project"},
        {"role": "assistant", "content": "before steer "},
    ]
    events = event_lines(output)
    assert any(event == {
        "schemaVersion": 1,
        "type": "control_result",
        "turnId": parsed.turn_id,
        "controlId": "control-steer-1",
        "controlType": "steer",
        "accepted": True,
    } for event in events)
    assert any(event == {
        "schemaVersion": 1,
        "type": "user_input_inserted",
        "turnId": parsed.turn_id,
        "messageId": "queued-steer-1",
    } for event in events)
    assert [event["delta"] for event in events if event["type"] == "text_delta"] == ["before steer ", "after steer"]
    assert events[-1]["type"] == "final"
    assert events[-1]["answer"] == "after steer"


def test_run_request_interrupts_coco_cleanly(tmp_path: Path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setenv("CODE_AGENT_WORKSPACE_ROOT", str(tmp_path))
    parsed = parse_request(json.dumps(request(workspace=str(workspace))))
    controls: "queue.Queue[dict[str, Any] | None]" = queue.Queue()
    output = io.StringIO()

    class InterruptibleEngine:
        def __init__(self):
            self.started = threading.Event()
            self.aborted = threading.Event()

        def abort(self):
            self.aborted.set()

        def run(self, prompt, on_text_chunk=None):
            on_text_chunk("partial")
            self.started.set()
            assert self.aborted.wait(timeout=2)
            raise RuntimeError("aborted")

    engine = InterruptibleEngine()
    thread = threading.Thread(
        target=run_request,
        kwargs={
            "request": parsed,
            "emitter": EventEmitter(output),
            "engine_factory": lambda _request: engine,
            "control_queue": controls,
        },
    )
    thread.start()
    assert engine.started.wait(timeout=2)
    controls.put({
        "schemaVersion": 1,
        "type": "interrupt",
        "turnId": parsed.turn_id,
        "controlId": "control-interrupt-1",
    })
    thread.join(timeout=3)

    assert not thread.is_alive()
    events = event_lines(output)
    assert any(event.get("controlId") == "control-interrupt-1" and event.get("accepted") is True for event in events)
    assert any(event.get("message") == "Coco turn interrupted" for event in events)
    assert events[-1]["type"] == "final"
    assert events[-1]["answer"] == "partial"


def test_run_request_rejects_coco_steer_when_engine_cannot_abort(tmp_path: Path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setenv("CODE_AGENT_WORKSPACE_ROOT", str(tmp_path))
    parsed = parse_request(json.dumps(request(workspace=str(workspace))))
    controls: "queue.Queue[dict[str, Any] | None]" = queue.Queue()
    output = io.StringIO()

    class NonInterruptibleEngine:
        def __init__(self):
            self.started = threading.Event()
            self.release = threading.Event()

        def run(self, prompt, on_text_chunk=None):
            self.started.set()
            assert self.release.wait(timeout=2)
            return EngineResult(answer="done", messages=[], usage=Usage())

    engine = NonInterruptibleEngine()
    thread = threading.Thread(
        target=run_request,
        kwargs={
            "request": parsed,
            "emitter": EventEmitter(output),
            "engine_factory": lambda _request: engine,
            "control_queue": controls,
        },
    )
    thread.start()
    assert engine.started.wait(timeout=2)
    controls.put({
        "schemaVersion": 1,
        "type": "steer",
        "turnId": parsed.turn_id,
        "controlId": "control-steer-rejected",
        "prompt": "change direction",
    })

    deadline = time.time() + 2
    while "control-steer-rejected" not in output.getvalue() and time.time() < deadline:
        time.sleep(0.01)
    engine.release.set()
    thread.join(timeout=3)

    result = next(event for event in event_lines(output) if event.get("controlId") == "control-steer-rejected")
    assert result["accepted"] is False
    assert "does not support live steer" in result["message"]


def test_current_code_agent_engine_file_tools_resolve_relative_paths_against_scoped_cwd(tmp_path: Path, monkeypatch):
    engine_source = Path(os.environ.get("CODE_AGENT_SOURCE_DIR") or "/Users/sky/projects/code-agent-engine/src")
    if not (engine_source / "core/tools/file_read.py").exists():
        pytest.skip("Code-agent engine source is not available for file tool contract testing")

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "README.md").write_text("hello from scoped workspace\n", encoding="utf-8")
    monkeypatch.setenv("CODE_AGENT_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.syspath_prepend(str(engine_source))

    from core.tools import FileReadTool, GlobTool, GrepTool

    with scoped_workspace_cwd(workspace):
        read_result = FileReadTool().invoke({"file_path": "README.md"})
        glob_result = GlobTool().invoke({"pattern": "*.md"})
        grep_result = GrepTool().invoke({"pattern": "scoped"})

    assert read_result.success is True
    assert "hello from scoped workspace" in read_result.content
    assert "README.md" in glob_result.content
    assert "README.md" in grep_result.content


def test_main_emits_error_for_invalid_json():
    stdout = io.StringIO()
    exit_code = main(io.StringIO("{invalid json}\n"), stdout)

    events = event_lines(stdout)
    assert exit_code == 1
    assert events[0]["type"] == "error"
    assert events[0]["code"] == "invalid_json"


def test_main_emits_error_for_empty_stdin():
    stdout = io.StringIO()
    exit_code = main(io.StringIO(""), stdout)

    events = event_lines(stdout)
    assert exit_code == 1
    assert events[0]["type"] == "error"
    assert events[0]["code"] == "missing_request"


def test_main_preserves_turn_id_when_engine_raises_after_request_parse(monkeypatch):
    from roomtalk_code_agent_runner import runner

    def fail_run_request(parsed_request, *, emitter, **kwargs):
        del kwargs
        raise RuntimeError("engine failed")

    monkeypatch.setattr(runner, "run_request", fail_run_request)
    stdout = io.StringIO()
    exit_code = runner.main(io.StringIO(json.dumps(request(turnId="turn-42")) + "\n"), stdout)

    events = event_lines(stdout)
    assert exit_code == 1
    assert events[0]["type"] == "error"
    assert events[0]["turnId"] == "turn-42"
