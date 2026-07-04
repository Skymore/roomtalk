from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

from roomtalk_coco_runner import codex_app_server
from roomtalk_coco_runner.runner import EventEmitter, parse_request
from test_runner import event_lines, request


def fake_jwt(claims: dict[str, Any]) -> str:
    import base64

    def encode(value: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode("utf-8")).decode("ascii").rstrip("=")

    return ".".join([encode({"alg": "none"}), encode(claims), "signature"])


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
    def __init__(self, messages: list[dict[str, Any]], *, stderr: str = "", exit_code: int = 0, auth_json_written: str = '{"accessToken":"refreshed"}'):
        self.stdout = "".join(json.dumps(message) + "\n" for message in messages)
        self.stderr = stderr
        self.exit_code = exit_code
        self.auth_json_written = auth_json_written
        self.calls: list[dict[str, Any]] = []
        self.processes: list[FakeAppServerProcess] = []

    def __call__(self, args, **kwargs):
        self.calls.append({"args": args, **kwargs})
        codex_home = Path(kwargs["env"]["CODEX_HOME"])
        (codex_home / "auth.json").write_text(self.auth_json_written, encoding="utf-8")
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
        {"method": "item/commandExecution/outputDelta", "params": {"threadId": "thread-app-1", "turnId": "turn-app-1", "itemId": "cmd-1", "delta": f"{workspace}/demo.txt\n"}},
        {"method": "item/completed", "params": {"threadId": "thread-app-1", "turnId": "turn-app-1", "item": {"id": "cmd-1", "type": "commandExecution", "command": "ls", "status": "completed", "exitCode": 0, "aggregatedOutput": "", "commandActions": [], "cwd": str(workspace), "durationMs": 12}}},
        {"method": "item/completed", "params": {"threadId": "thread-app-1", "turnId": "turn-app-1", "item": {"id": "file-1", "type": "fileChange", "status": "completed", "changes": [{"type": "update", "path": f"{workspace}/demo.txt"}]}}},
        {"method": "thread/tokenUsage/updated", "params": {"threadId": "thread-app-1", "turnId": "turn-app-1", "tokenUsage": {"last": {"totalTokens": 12, "inputTokens": 8, "cachedInputTokens": 2, "outputTokens": 4, "reasoningOutputTokens": 1}, "total": {"totalTokens": 50, "inputTokens": 40, "cachedInputTokens": 5, "outputTokens": 10, "reasoningOutputTokens": 2}, "modelContextWindow": 200000}}},
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
    assert events[-1]["usage"] == {
        "promptTokens": 8,
        "completionTokens": 4,
        "totalTokens": 12,
        "source": "reported",
        "cachedPromptTokens": 2,
        "cacheHitRate": 0.25,
    }

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
    assert sent[2]["method"] == "thread/resume"
    assert sent[2]["params"]["threadId"] == "session-prev"
    assert sent[2]["params"]["model"] == "gpt-5.3-codex-spark"
    assert sent[3]["method"] == "turn/start"
    assert sent[3]["params"]["threadId"] == "thread-app-1"
    assert sent[3]["params"]["model"] == "gpt-5.3-codex-spark"
    assert sent[3]["params"]["effort"] == "high"
    assert sent[3]["params"]["sandboxPolicy"]["type"] == "readOnly"
    assert "roomtalk publish-static-site" not in sent[3]["params"]["input"][0]["text"]
    assert not (Path(call["env"]["CODEX_HOME"]) / "auth.json").exists()
    assert not (Path(call["env"]["CODEX_HOME"]) / "config.toml").exists()


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


def test_codex_app_server_falls_back_to_new_thread_when_resume_fails(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    auth_json = tmp_path / "auth.json"
    auth_json.write_text('{"accessToken":"initial"}', encoding="utf-8")
    stdout = io.StringIO()
    popen = FakeAppServerPopenFactory([
        {"id": 0, "result": {}},
        {"id": 1, "error": {"code": -32000, "message": "thread not found"}},
        {"id": 2, "result": {"thread": {"id": "thread-new"}}},
        {"id": 3, "result": {"turn": {"id": "turn-new"}}},
        {"method": "turn/completed", "params": {"threadId": "thread-new", "turn": {"id": "turn-new", "status": "completed", "items": []}}},
    ])

    codex_app_server.run_request(
        codex_app_request(workspace),
        emitter=EventEmitter(stdout),
        config=codex_app_server.CodexCliRunConfig(
            secret_parent=tmp_path / "secrets",
            auth_json_path=auth_json,
        ),
        popen_factory=popen,
        env={"COCO_WORKSPACE_ROOT": str(tmp_path)},
    )

    sent = jsonrpc_lines(popen.processes[0])
    assert [message["method"] for message in sent if "method" in message][:5] == [
        "initialize",
        "initialized",
        "thread/resume",
        "thread/start",
        "turn/start",
    ]
    assert sent[2]["params"]["threadId"] == "session-prev"
    assert sent[3]["params"]["ephemeral"] is False
    assert event_lines(stdout)[-1]["sessionId"] == "thread-new"


def test_codex_app_server_responds_to_auth_refresh_from_auth_json(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    auth_json = tmp_path / "auth.json"
    auth_json.write_text(json.dumps({
        "tokens": {
            "access_token": "secret-access-token",
            "account_id": "acct-token",
            "id_token": fake_jwt({
                "https://api.openai.com/auth": {
                    "chatgpt_account_id": "acct-claim",
                    "chatgpt_plan_type": "pro",
                },
            }),
        },
    }), encoding="utf-8")
    stdout = io.StringIO()
    refresh_auth_json = json.dumps({
        "tokens": {
            "access_token": "secret-access-token",
            "account_id": "acct-token",
            "id_token": fake_jwt({
                "https://api.openai.com/auth": {
                    "chatgpt_account_id": "acct-claim",
                    "chatgpt_plan_type": "pro",
                },
            }),
        },
    })
    popen = FakeAppServerPopenFactory([
        {"id": 0, "result": {}},
        {"id": 1, "result": {"thread": {"id": "thread-app-3"}}},
        {
            "id": 44,
            "method": "account/chatgptAuthTokens/refresh",
            "params": {"reason": "expired", "previousAccountId": "acct-token"},
        },
        {"id": 2, "result": {"turn": {"id": "turn-app-3"}}},
        {"method": "turn/completed", "params": {"threadId": "thread-app-3", "turn": {"id": "turn-app-3", "status": "completed", "items": []}}},
    ], auth_json_written=refresh_auth_json)

    codex_app_server.run_request(
        codex_app_request(workspace),
        emitter=EventEmitter(stdout),
        config=codex_app_server.CodexCliRunConfig(
            secret_parent=tmp_path / "secrets",
            auth_json_path=auth_json,
        ),
        popen_factory=popen,
        env={"COCO_WORKSPACE_ROOT": str(tmp_path)},
    )

    response = next(message for message in jsonrpc_lines(popen.processes[0]) if message.get("id") == 44)
    assert response["result"] == {
        "accessToken": "secret-access-token",
        "chatgptAccountId": "acct-token",
        "chatgptPlanType": "pro",
    }


def test_codex_app_server_emits_interactive_approval_request_in_edit_mode(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    auth_json = tmp_path / "auth.json"
    auth_json.write_text('{"accessToken":"initial"}', encoding="utf-8")
    stdout = io.StringIO()
    popen = FakeAppServerPopenFactory([
        {"id": 0, "result": {}},
        {"id": 1, "result": {"thread": {"id": "thread-app-approval"}}},
        {"id": 2, "result": {"turn": {"id": "turn-app-approval"}}},
        {
            "id": 88,
            "method": "item/commandExecution/requestApproval",
            "params": {
                "threadId": "thread-app-approval",
                "turnId": "turn-app-approval",
                "itemId": "cmd-approval",
                "command": "npm install",
                "cwd": str(workspace),
                "startedAtMs": 123,
            },
        },
        {"method": "turn/completed", "params": {"threadId": "thread-app-approval", "turn": {"id": "turn-app-approval", "status": "completed", "items": []}}},
    ])

    codex_app_server.run_request(
        codex_app_request(workspace, mode="edit", codexPermissionMode="edit"),
        emitter=EventEmitter(stdout),
        config=codex_app_server.CodexCliRunConfig(
            secret_parent=tmp_path / "secrets",
            auth_json_path=auth_json,
        ),
        popen_factory=popen,
        env={"COCO_WORKSPACE_ROOT": str(tmp_path)},
    )

    events = event_lines(stdout)
    approval = next(event for event in events if event["type"] == "approval_request")
    assert approval["id"] == "cmd-approval"
    assert approval["approvalType"] == "command"
    assert approval["args"]["approvalId"] == "cmd-approval"
    assert approval["args"]["command"] == "npm install"
    assert approval["args"]["cwd"] == str(workspace)
    assert all(message.get("id") != 88 for message in jsonrpc_lines(popen.processes[0]))


def test_codex_app_server_runs_thread_list_query(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    auth_json = tmp_path / "auth.json"
    auth_json.write_text('{"accessToken":"initial"}', encoding="utf-8")
    stdout = io.StringIO()
    popen = FakeAppServerPopenFactory([
        {"id": 0, "result": {}},
        {
            "id": 1,
            "result": {
                "data": [
                    {
                        "id": "thread-1",
                        "title": "Inspect project",
                        "updatedAt": "2026-07-04T10:00:00Z",
                    },
                ],
                "nextCursor": "cursor-next",
            },
        },
    ])
    request = codex_app_server.parse_app_server_request(json.dumps({
        "schemaVersion": 1,
        "type": "thread_list",
        "roomId": "room-threads",
        "clientId": "client-1",
        "workspace": str(workspace),
        "limit": 10,
        "searchTerm": "inspect",
    }))

    codex_app_server.run_thread_query_request(
        request,
        emitter=EventEmitter(stdout),
        config=codex_app_server.CodexCliRunConfig(
            secret_parent=tmp_path / "secrets",
            auth_json_path=auth_json,
        ),
        popen_factory=popen,
        env={"COCO_WORKSPACE_ROOT": str(tmp_path)},
    )

    sent = jsonrpc_lines(popen.processes[0])
    assert [message["method"] for message in sent if "method" in message] == [
        "initialize",
        "initialized",
        "thread/list",
    ]
    assert sent[2]["params"] == {
        "limit": 10,
        "sortKey": "updated_at",
        "sortDirection": "desc",
        "cwd": str(workspace),
        "archived": False,
        "searchTerm": "inspect",
    }
    events = event_lines(stdout)
    assert events == [{
        "schemaVersion": 1,
        "type": "thread_list_result",
        "roomId": "room-threads",
        "threads": [
            {
                "id": "thread-1",
                "title": "Inspect project",
                "updatedAt": "2026-07-04T10:00:00Z",
            },
        ],
        "nextCursor": "cursor-next",
        "backwardsCursor": None,
    }]


def test_codex_app_server_main_emits_error_events_for_invalid_requests():
    stdout = io.StringIO()

    exit_code = codex_app_server.main(io.StringIO(""), stdout)

    assert exit_code == 1
    events = event_lines(stdout)
    assert events[0]["type"] == "error"
    assert events[0]["code"] == "missing_request"
