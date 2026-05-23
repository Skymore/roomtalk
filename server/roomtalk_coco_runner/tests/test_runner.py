from __future__ import annotations

import io
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

from roomtalk_coco_runner.runner import (
    EventEmitter,
    RunnerError,
    RunnerRequest,
    _add_coco_source_to_path,
    _api_key_for,
    _base_url_for,
    canonical_allowed_paths_for_engine,
    main,
    parse_request,
    replay_tool_events,
    resolve_allowed_roots,
    run_request,
    tool_names_for_mode,
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


def test_parse_request_validates_schema_and_required_fields():
    parsed = parse_request(json.dumps(request()))

    assert parsed.room_id == "room-1"
    assert parsed.turn_id == "turn-1"
    assert parsed.mode == "plan"
    assert parsed.allowed_paths == (".",)

    with pytest.raises(RunnerError, match="Unsupported schemaVersion"):
        parse_request(json.dumps(request(schemaVersion=2)))

    with pytest.raises(RunnerError, match="Expected non-empty string field 'prompt'"):
        parse_request(json.dumps(request(prompt="")))


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


def test_tool_policy_keeps_plan_read_only_and_requires_explicit_write_or_shell_flags():
    assert tool_names_for_mode("plan", {
        "ROOMTALK_COCO_ALLOW_WRITE_TOOLS": "true",
        "ROOMTALK_COCO_ALLOW_SHELL": "true",
    }) == ("Read", "Glob", "Grep")

    assert tool_names_for_mode("acceptEdits", {}) == ("Read", "Glob", "Grep")
    assert tool_names_for_mode("acceptEdits", {"ROOMTALK_COCO_ALLOW_WRITE_TOOLS": "true"}) == (
        "Read",
        "Glob",
        "Grep",
        "Write",
        "Edit",
    )
    assert tool_names_for_mode("acceptEdits", {
        "ROOMTALK_COCO_ALLOW_WRITE_TOOLS": "true",
        "ROOMTALK_COCO_ALLOW_SHELL": "true",
    }) == ("Read", "Glob", "Grep", "Write", "Edit", "Shell")


def test_tool_policy_treats_empty_env_as_an_isolated_environment(monkeypatch):
    monkeypatch.setenv("ROOMTALK_COCO_ALLOW_WRITE_TOOLS", "true")
    monkeypatch.setenv("ROOMTALK_COCO_ALLOW_SHELL", "true")

    assert tool_names_for_mode("acceptEdits", {}) == ("Read", "Glob", "Grep")


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


def test_replay_tool_events_marks_common_error_outputs_and_non_text_content():
    messages = [
        {
            "role": "assistant",
            "content": [
                {"type": "tool_use", "id": "tool-1", "name": "Read", "input": {"file_path": "missing.txt"}},
                {"type": "tool_use", "id": "tool-2", "name": "Screenshot", "input": {}},
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "tool-1",
                    "content": "FileNotFoundError: missing.txt",
                },
                {
                    "type": "tool_result",
                    "tool_use_id": "tool-2",
                    "content": [{"type": "image", "source": {"type": "base64", "data": "abc"}}],
                },
            ],
        },
    ]

    events = replay_tool_events(messages)

    assert events[3]["type"] == "tool_result"
    assert events[2]["type"] == "tool_result"
    assert events[2]["success"] is False
    assert events[3]["success"] is True
    assert events[3]["output"] == "[non-text content omitted]"


def test_add_coco_source_to_path_validates_configured_directory(tmp_path: Path):
    source_dir = tmp_path / "coco-src"
    source_dir.mkdir()

    _add_coco_source_to_path({"COCO_SOURCE_DIR": str(source_dir)})
    _add_coco_source_to_path({"COCO_SOURCE_DIR": str(source_dir)})

    assert str(source_dir.resolve()) in sys.path
    assert sys.path.count(str(source_dir.resolve())) == 1

    with pytest.raises(RunnerError, match="COCO_SOURCE_DIR does not exist"):
        _add_coco_source_to_path({"COCO_SOURCE_DIR": str(tmp_path / "missing")})


def test_model_proxy_env_overrides_direct_provider_credentials():
    env = {
        "COCO_MODEL_PROXY_URL": "https://model-proxy.internal/",
        "COCO_MODEL_PROXY_TOKEN": "short-lived-proxy-token",
        "DEEPSEEK_API_KEY": "must-not-use",
        "DEEPSEEK_BASE_URL": "https://api.deepseek.com",
    }

    assert _api_key_for("deepseek", env) == "short-lived-proxy-token"
    assert _base_url_for("deepseek", env) == "https://model-proxy.internal"

    with pytest.raises(RunnerError, match="COCO_MODEL_PROXY_TOKEN is required"):
        _api_key_for("deepseek", {"COCO_MODEL_PROXY_URL": "https://model-proxy.internal"})

    with pytest.raises(RunnerError, match="COCO_MODEL_PROXY_URL must be an HTTPS URL"):
        _base_url_for("deepseek", {
            "COCO_MODEL_PROXY_URL": "http://model-proxy.internal",
            "COCO_MODEL_PROXY_TOKEN": "short-lived-proxy-token",
        })


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


def test_run_request_emits_tool_events_before_terminal_final():
    output = io.StringIO()
    parsed = parse_request(json.dumps(request()))

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
    from roomtalk_coco_runner import runner

    def fail_run_request(parsed_request, *, emitter):
        raise RuntimeError("engine failed")

    monkeypatch.setattr(runner, "run_request", fail_run_request)
    stdout = io.StringIO()
    exit_code = runner.main(io.StringIO(json.dumps(request(turnId="turn-42")) + "\n"), stdout)

    events = event_lines(stdout)
    assert exit_code == 1
    assert events[0]["type"] == "error"
    assert events[0]["turnId"] == "turn-42"
