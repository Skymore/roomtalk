from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

import pytest

from roomtalk_coco_runner import codex_cli
from roomtalk_coco_runner.runner import EventEmitter, RunnerError, parse_request
from test_runner import event_lines, request


class FakeCodexProcess:
    def __init__(self, stdout: str, stderr: str = "", exit_code: int = 0):
        self.stdout = io.StringIO(stdout)
        self.stderr = io.StringIO(stderr)
        self.exit_code = exit_code
        self.killed = False

    def wait(self, timeout: float | None = None):
        return self.exit_code

    def kill(self):
        self.killed = True


class FakeCodexPopenFactory:
    def __init__(self, stdout_events: list[dict[str, Any]], *, stderr: str = "", exit_code: int = 0):
        self.stdout = "".join(json.dumps(event) + "\n" for event in stdout_events)
        self.stderr = stderr
        self.exit_code = exit_code
        self.calls: list[dict[str, Any]] = []

    def __call__(self, args, **kwargs):
        self.calls.append({"args": args, **kwargs})
        codex_home = Path(kwargs["env"]["CODEX_HOME"])
        workspace = kwargs["cwd"]
        (codex_home / "last-message.txt").write_text(f"Final answer from {workspace}/demo.txt", encoding="utf-8")
        (codex_home / "auth.json").write_text('{"accessToken":"refreshed"}', encoding="utf-8")
        return FakeCodexProcess(self.stdout, stderr=self.stderr, exit_code=self.exit_code)


def codex_request(workspace: Path):
    return parse_request(json.dumps(request(
        turnId="turn-codex",
        sessionId="session-prev",
        prompt="inspect with codex",
        workspace=str(workspace),
    )))


def test_codex_cli_maps_exec_jsonl_and_saves_refreshed_auth(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    auth_json = tmp_path / "auth.json"
    refreshed_auth_json = tmp_path / "refreshed" / "auth.json"
    auth_json.write_text('{"accessToken":"initial"}', encoding="utf-8")
    stdout = io.StringIO()
    popen = FakeCodexPopenFactory([
        {"type": "thread.started", "thread_id": "thread-1"},
        {"type": "turn.started"},
        {
            "type": "item.completed",
            "item": {
                "id": "msg-1",
                "type": "agent_message",
                "text": f"I read {workspace}/demo.txt",
            },
        },
        {
            "type": "item.started",
            "item": {"id": "cmd-1", "type": "command_execution", "command": "ls"},
        },
        {
            "type": "item.completed",
            "item": {
                "id": "cmd-1",
                "type": "command_execution",
                "status": "completed",
                "exit_code": 0,
                "aggregated_output": f"{workspace}/demo.txt\n",
            },
        },
        {
            "type": "item.completed",
            "item": {
                "id": "file-1",
                "type": "file_change",
                "status": "completed",
                "changes": [{"kind": "modified", "path": f"{workspace}/demo.txt"}],
            },
        },
        {"type": "turn.completed", "usage": {"input_tokens": 2, "output_tokens": 3, "total_tokens": 5}},
    ])

    codex_cli.run_request(
        codex_request(workspace),
        emitter=EventEmitter(stdout),
        config=codex_cli.CodexCliRunConfig(
            secret_parent=tmp_path / "secrets",
            auth_json_path=auth_json,
            refreshed_auth_json_path=refreshed_auth_json,
        ),
        popen_factory=popen,
        env={
            "PATH": "/usr/bin",
            "HOME": "/home/roomtalk",
            "COCO_WORKSPACE_ROOT": str(tmp_path),
            "OPENAI_API_KEY": "sk-should-not-leak",
            "GITHUB_TOKEN": "gh-should-not-leak",
            "ROOMTALK_CODEX_AUTH_JSON_PATH": str(auth_json),
            "PUBLIC_VALUE": "visible",
        },
    )

    events = event_lines(stdout)
    assert [event["type"] for event in events] == [
        "status",
        "status",
        "status",
        "text_delta",
        "tool_call",
        "tool_result",
        "tool_result",
        "status",
        "final",
    ]
    assert events[3]["delta"] == "I read demo.txt\n\n"
    assert events[5]["output"] == "demo.txt\n"
    assert events[-1]["answer"] == "Final answer from demo.txt"
    assert events[-1]["sessionId"] == "thread-1"
    assert events[-1]["usage"] == {
        "promptTokens": 2,
        "completionTokens": 3,
        "totalTokens": 5,
        "source": "reported",
    }

    call = popen.calls[0]
    assert call["args"][:8] == [
        "codex",
        "exec",
        "--json",
        "--ephemeral",
        "--sandbox",
        "workspace-write",
        "--cd",
        str(workspace),
    ]
    child_env = call["env"]
    assert child_env["PUBLIC_VALUE"] == "visible"
    assert child_env["CODEX_HOME"].startswith(str(tmp_path / "secrets"))
    assert "OPENAI_API_KEY" not in child_env
    assert "GITHUB_TOKEN" not in child_env
    assert "ROOMTALK_CODEX_AUTH_JSON_PATH" not in child_env
    assert refreshed_auth_json.read_text(encoding="utf-8") == '{"accessToken":"refreshed"}'
    assert not Path(child_env["CODEX_HOME"]).exists()


def test_codex_cli_requires_auth_json_path(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    with pytest.raises(RunnerError, match="ROOMTALK_CODEX_AUTH_JSON_PATH"):
        codex_cli.run_request(
            codex_request(workspace),
            emitter=EventEmitter(io.StringIO()),
            config=codex_cli.CodexCliRunConfig(secret_parent=tmp_path / "secrets"),
            popen_factory=FakeCodexPopenFactory([]),
            env={"COCO_WORKSPACE_ROOT": str(tmp_path)},
        )


def test_codex_cli_reports_nonzero_exit_with_stderr_tail(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    auth_json = tmp_path / "auth.json"
    auth_json.write_text('{"accessToken":"initial"}', encoding="utf-8")

    with pytest.raises(RunnerError, match="provider failed"):
        codex_cli.run_request(
            codex_request(workspace),
            emitter=EventEmitter(io.StringIO()),
            config=codex_cli.CodexCliRunConfig(
                secret_parent=tmp_path / "secrets",
                auth_json_path=auth_json,
            ),
            popen_factory=FakeCodexPopenFactory([], stderr="provider failed", exit_code=7),
            env={"COCO_WORKSPACE_ROOT": str(tmp_path)},
        )


def test_codex_cli_main_emits_error_events_for_invalid_requests():
    stdout = io.StringIO()

    exit_code = codex_cli.main(io.StringIO(""), stdout)

    assert exit_code == 1
    events = event_lines(stdout)
    assert events[0]["type"] == "error"
    assert events[0]["code"] == "missing_request"
