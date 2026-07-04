from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

from roomtalk_coco_runner import codex_app_server
from roomtalk_coco_runner.runner import EventEmitter, parse_request
from test_runner import event_lines, request


class RecordingStdin:
    def __init__(self):
        self.lines: list[str] = []
        self.closed = False

    def write(self, value: str):
        self.lines.append(value)
        return len(value)

    def flush(self):
        pass

    def close(self):
        self.closed = True


class FakeAppServerProcess:
    def __init__(self, stdout: str, stderr: str = "", exit_code: int = 0):
        self.stdin = RecordingStdin()
        self.stdout = io.StringIO(stdout)
        self.stderr = io.StringIO(stderr)
        self.exit_code = exit_code
        self.returncode: int | None = None
        self.killed = False
        self.terminated = False

    def wait(self, timeout: float | None = None):
        if self.returncode is None:
            self.returncode = self.exit_code
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9

    def terminate(self):
        self.terminated = True
        self.returncode = -15


class FakeAppServerPopenFactory:
    def __init__(self, messages: list[dict[str, Any]], *, stderr: str = "", exit_code: int = 0):
        self.stdout = "".join(json.dumps(message) + "\n" for message in messages)
        self.stderr = stderr
        self.exit_code = exit_code
        self.calls: list[dict[str, Any]] = []
        self.processes: list[FakeAppServerProcess] = []

    def __call__(self, args, **kwargs):
        self.calls.append({"args": args, **kwargs})
        codex_home = Path(kwargs["env"]["CODEX_HOME"])
        (codex_home / "auth.json").write_text('{"accessToken":"refreshed"}', encoding="utf-8")
        process = FakeAppServerProcess(self.stdout, stderr=self.stderr, exit_code=self.exit_code)
        self.processes.append(process)
        return process


def codex_app_request(workspace: Path, **overrides: Any):
    return parse_request(json.dumps(request(
        turnId="turn-app-server",
        sessionId="session-prev",
        prompt="inspect with app server",
        workspace=str(workspace),
        **overrides,
    )))


def jsonrpc_lines(process: FakeAppServerProcess) -> list[dict[str, Any]]:
    return [json.loads(line) for line in process.stdin.lines]


def test_codex_app_server_drives_json_rpc_and_maps_notifications(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    auth_json = tmp_path / "auth.json"
    refreshed_auth_json = tmp_path / "refreshed" / "auth.json"
    auth_json.write_text('{"accessToken":"initial"}', encoding="utf-8")
    stdout = io.StringIO()
    popen = FakeAppServerPopenFactory([
        {"id": 0, "result": {"serverInfo": {"name": "codex"}}},
        {"id": 1, "result": {"thread": {"id": "thread-app-1"}}},
        {"id": 2, "result": {"turn": {"id": "turn-app-1"}}},
        {"method": "turn/started", "params": {"threadId": "thread-app-1", "turn": {"id": "turn-app-1"}}},
        {"method": "item/agentMessage/delta", "params": {"threadId": "thread-app-1", "turnId": "turn-app-1", "itemId": "msg-1", "delta": f"I read {workspace}/demo.txt"}},
        {"method": "item/started", "params": {"threadId": "thread-app-1", "turnId": "turn-app-1", "item": {"id": "cmd-1", "type": "commandExecution", "command": "ls", "status": "running", "commandActions": [], "cwd": str(workspace)}}},
        {"method": "item/completed", "params": {"threadId": "thread-app-1", "turnId": "turn-app-1", "item": {"id": "cmd-1", "type": "commandExecution", "command": "ls", "status": "completed", "exitCode": 0, "aggregatedOutput": f"{workspace}/demo.txt\n", "commandActions": [], "cwd": str(workspace), "durationMs": 12}}},
        {"method": "item/completed", "params": {"threadId": "thread-app-1", "turnId": "turn-app-1", "item": {"id": "file-1", "type": "fileChange", "status": "completed", "changes": [{"type": "update", "path": f"{workspace}/demo.txt"}]}}},
        {"method": "turn/completed", "params": {"threadId": "thread-app-1", "turn": {"id": "turn-app-1", "status": "completed", "items": []}}},
    ])

    codex_app_server.run_request(
        codex_app_request(workspace, codexModel="gpt-5.3-codex-spark", codexReasoningEffort="high"),
        emitter=EventEmitter(stdout),
        config=codex_app_server.CodexCliRunConfig(
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
            "ROOMTALK_CODEX_AUTH_JSON_PATH": str(auth_json),
            "PUBLIC_VALUE": "visible",
        },
    )

    events = event_lines(stdout)
    assert [event["type"] for event in events] == [
        "status",
        "status",
        "text_delta",
        "tool_call",
        "tool_result",
        "tool_result",
        "status",
        "final",
    ]
    assert events[2]["delta"] == "I read demo.txt"
    assert events[4]["output"] == "demo.txt\n"
    assert events[-1]["answer"] == "I read demo.txt"
    assert events[-1]["sessionId"] == "thread-app-1"

    call = popen.calls[0]
    assert call["args"] == ["codex", "app-server", "--stdio"]
    assert call["cwd"] == str(workspace)
    assert "OPENAI_API_KEY" not in call["env"]
    assert call["env"]["PUBLIC_VALUE"] == "visible"
    assert refreshed_auth_json.read_text(encoding="utf-8") == '{"accessToken":"refreshed"}'

    sent = jsonrpc_lines(popen.processes[0])
    assert sent[0]["method"] == "initialize"
    assert sent[0]["params"]["capabilities"]["experimentalApi"] is True
    assert sent[1]["method"] == "initialized"
    assert sent[2]["method"] == "thread/start"
    assert sent[2]["params"]["model"] == "gpt-5.3-codex-spark"
    assert sent[3]["method"] == "turn/start"
    assert sent[3]["params"]["threadId"] == "thread-app-1"
    assert sent[3]["params"]["model"] == "gpt-5.3-codex-spark"
    assert sent[3]["params"]["effort"] == "high"
    assert sent[3]["params"]["sandboxPolicy"]["type"] == "readOnly"
    assert "roomtalk publish-static-site" not in sent[3]["params"]["input"][0]["text"]


def test_codex_app_server_uses_workspace_write_for_approve_for_me_and_declines_approval_requests(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    auth_json = tmp_path / "auth.json"
    auth_json.write_text('{"accessToken":"initial"}', encoding="utf-8")
    stdout = io.StringIO()
    popen = FakeAppServerPopenFactory([
        {"id": 0, "result": {}},
        {"id": 1, "result": {"thread": {"id": "thread-app-2"}}},
        {"id": 2, "result": {"turn": {"id": "turn-app-2"}}},
        {
            "id": 99,
            "method": "item/commandExecution/requestApproval",
            "params": {
                "threadId": "thread-app-2",
                "turnId": "turn-app-2",
                "itemId": "cmd-approval",
                "command": "rm -rf demo",
                "startedAtMs": 1,
            },
        },
        {"method": "turn/completed", "params": {"threadId": "thread-app-2", "turn": {"id": "turn-app-2", "status": "completed", "items": []}}},
    ])

    codex_app_server.run_request(
        codex_app_request(workspace, mode="acceptEdits", codexPermissionMode="approveForMe"),
        emitter=EventEmitter(stdout),
        config=codex_app_server.CodexCliRunConfig(
            secret_parent=tmp_path / "secrets",
            auth_json_path=auth_json,
        ),
        popen_factory=popen,
        env={"COCO_WORKSPACE_ROOT": str(tmp_path)},
    )

    sent = jsonrpc_lines(popen.processes[0])
    turn_start = next(message for message in sent if message.get("method") == "turn/start")
    assert turn_start["params"]["approvalPolicy"] == "never"
    assert turn_start["params"]["sandboxPolicy"]["type"] == "workspaceWrite"
    assert turn_start["params"]["sandboxPolicy"]["networkAccess"] is True
    approval_response = next(message for message in sent if message.get("id") == 99)
    assert approval_response["result"]["decision"] == "decline"


def test_codex_app_server_main_emits_error_events_for_invalid_requests():
    stdout = io.StringIO()

    exit_code = codex_app_server.main(io.StringIO(""), stdout)

    assert exit_code == 1
    events = event_lines(stdout)
    assert events[0]["type"] == "error"
    assert events[0]["code"] == "missing_request"
