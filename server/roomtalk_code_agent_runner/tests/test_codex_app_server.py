from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

import pytest

from roomtalk_code_agent_runner import codex_app_server
from roomtalk_code_agent_runner.runner import EventEmitter, parse_request
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


def test_codex_app_server_drives_json_rpc_and_maps_notifications(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    def fail_turn_watchdog(*_args, **_kwargs):
        raise AssertionError("Codex app-server turns must not create a watchdog timer")

    monkeypatch.setattr(codex_app_server.threading, "Timer", fail_turn_watchdog)
    materialized_urls: list[str] = []

    def fake_materialize(image_url: str, *, turn_id: str):
        materialized_urls.append(f"{turn_id}:{image_url}")
        return "data:image/png;base64,cG5n"

    monkeypatch.setattr(codex_app_server, "_materialize_codex_image_url", fake_materialize)
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
        {"method": "item/completed", "params": {"threadId": "thread-app-1", "turnId": "turn-app-1", "item": {"id": "msg-1", "type": "agentMessage", "text": f"I read {workspace}/demo.txt after the tool"}}},
        {"method": "item/completed", "params": {"threadId": "thread-app-1", "turnId": "turn-app-1", "item": {"id": "file-1", "type": "fileChange", "status": "completed", "changes": [{"type": "update", "path": f"{workspace}/demo.txt"}]}}},
        {"method": "thread/tokenUsage/updated", "params": {"threadId": "thread-app-1", "turnId": "turn-app-1", "tokenUsage": {"last": {"totalTokens": 12, "inputTokens": 8, "cachedInputTokens": 2, "outputTokens": 4, "reasoningOutputTokens": 1}, "total": {"totalTokens": 50, "inputTokens": 40, "cachedInputTokens": 5, "outputTokens": 10, "reasoningOutputTokens": 2}, "modelContextWindow": 200000}}},
        {"method": "turn/completed", "params": {"threadId": "thread-app-1", "turn": {"id": "turn-app-1", "status": "completed", "items": []}}},
    ])

    codex_app_server.run_request(
        codex_app_request(
            workspace,
            codexModel="gpt-5.6-sol",
            codexReasoningEffort="high",
            codexServiceTier="priority",
            images=[{
                "url": "https://media.example/signed/input.png?token=secret",
            }],
        ),
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
            "CODE_AGENT_WORKSPACE_ROOT": str(tmp_path),
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
        "text_delta",
        "tool_result",
        "usage",
        "status",
        "final",
    ]
    assert events[2]["delta"] == "I read demo.txt"
    assert events[4]["output"] == "demo.txt\n"
    assert events[5]["delta"] == " after the tool"
    assert events[-1]["answer"] == "I read demo.txt after the tool"
    assert events[-1]["sessionId"] == "thread-app-1"
    assert events[-1]["usage"] == {
        "promptTokens": 8,
        "completionTokens": 4,
        "totalTokens": 12,
        "source": "reported",
        "cachedPromptTokens": 2,
        "cacheHitRate": 0.25,
        "modelContextWindow": 200000,
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
    assert sent[2]["params"]["model"] == "gpt-5.6-sol"
    assert sent[2]["params"]["serviceTier"] == "priority"
    assert sent[3]["method"] == "turn/start"
    assert sent[3]["params"]["threadId"] == "thread-app-1"
    assert sent[3]["params"]["model"] == "gpt-5.6-sol"
    assert sent[3]["params"]["effort"] == "high"
    assert sent[3]["params"]["serviceTier"] == "priority"
    assert sent[3]["params"]["sandboxPolicy"]["type"] == "readOnly"
    assert sent[3]["params"]["sandboxPolicy"]["networkAccess"] is False
    assert "roomtalk publish-static-site" not in sent[3]["params"]["input"][0]["text"]
    assert sent[3]["params"]["input"][1] == {
        "type": "image",
        "url": "data:image/png;base64,cG5n",
    }
    assert materialized_urls == [
        "turn-app-server:https://media.example/signed/input.png?token=secret",
    ]
    assert not (Path(call["env"]["CODEX_HOME"]) / "auth.json").exists()
    assert not (Path(call["env"]["CODEX_HOME"]) / "config.toml").exists()


def test_codex_app_server_uses_read_only_network_profile_when_room_context_is_available(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    auth_json = tmp_path / "auth.json"
    auth_json.write_text('{"accessToken":"initial"}', encoding="utf-8")
    stdout = io.StringIO()
    popen = FakeAppServerPopenFactory([
        {"id": 0, "result": {}},
        {"id": 1, "result": {"thread": {"id": "thread-room-context"}}},
        {"id": 2, "result": {"turn": {"id": "turn-room-context"}}},
        {"method": "turn/completed", "params": {"threadId": "thread-room-context", "turn": {"id": "turn-room-context", "status": "completed", "items": []}}},
    ])

    codex_app_server.run_request(
        codex_app_request(workspace, mode="plan", codexPermissionMode="plan"),
        emitter=EventEmitter(stdout),
        config=codex_app_server.CodexCliRunConfig(
            secret_parent=tmp_path / "secrets",
            auth_json_path=auth_json,
        ),
        popen_factory=popen,
        env={
            "CODE_AGENT_WORKSPACE_ROOT": str(tmp_path),
            "ROOMTALK_ROOM_CONTEXT_URL": "https://room.example/api/code-agent/room-context",
            "ROOMTALK_ROOM_CONTEXT_TOKEN": "room-context-token",
        },
    )

    sent = jsonrpc_lines(popen.processes[0])
    thread_resume = next(message for message in sent if message.get("method") == "thread/resume")
    turn_start = next(message for message in sent if message.get("method") == "turn/start")
    assert thread_resume["params"]["permissions"] == "roomtalk-room-context-read"
    assert "sandbox" not in thread_resume["params"]
    assert turn_start["params"]["permissions"] == "roomtalk-room-context-read"
    assert "sandboxPolicy" not in turn_start["params"]


@pytest.mark.parametrize(
    ("permission_mode", "runner_mode", "sandbox", "sandbox_policy", "approval_policy", "approvals_reviewer"),
    [
        ("plan", "plan", "read-only", "readOnly", "on-request", "user"),
        ("edit", "acceptEdits", "workspace-write", "workspaceWrite", "on-request", "user"),
        ("approveForMe", "acceptEdits", "workspace-write", "workspaceWrite", "on-request", "auto_review"),
        ("fullAccess", "acceptEdits", "danger-full-access", "dangerFullAccess", "never", "user"),
    ],
)
def test_codex_app_server_matches_codex_cli_permission_presets(
    tmp_path: Path,
    permission_mode: str,
    runner_mode: str,
    sandbox: str,
    sandbox_policy: str,
    approval_policy: str,
    approvals_reviewer: str,
):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    run_request = codex_app_request(
        workspace,
        mode=runner_mode,
        codexPermissionMode=permission_mode,
    )
    thread_params = codex_app_server._thread_start_params(run_request, {}, workspace)
    turn_params = codex_app_server._turn_start_params(run_request, {}, workspace, "thread-app-2")

    assert thread_params["sandbox"] == sandbox
    assert thread_params["approvalPolicy"] == approval_policy
    assert thread_params["approvalsReviewer"] == approvals_reviewer
    assert turn_params["sandboxPolicy"]["type"] == sandbox_policy
    assert turn_params["approvalPolicy"] == approval_policy
    assert turn_params["approvalsReviewer"] == approvals_reviewer


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
        env={"CODE_AGENT_WORKSPACE_ROOT": str(tmp_path)},
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
        env={"CODE_AGENT_WORKSPACE_ROOT": str(tmp_path)},
    )

    response = next(message for message in jsonrpc_lines(popen.processes[0]) if message.get("id") == 44)
    assert response["result"] == {
        "accessToken": "secret-access-token",
        "chatgptAccountId": "acct-token",
        "chatgptPlanType": "pro",
    }


def test_codex_app_server_delegates_auth_refresh_to_roomtalk(tmp_path: Path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    auth_json = tmp_path / "auth.json"
    auth_json.write_text(json.dumps({
        "tokens": {
            "access_token": "expired-access-token",
            "refresh_token": "secret-refresh-token",
            "account_id": "acct-token",
        },
    }), encoding="utf-8")
    refreshed_auth_path = tmp_path / "refreshed-auth.json"
    refreshed_auth_json = json.dumps({
        "tokens": {
            "access_token": "fresh-access-token",
            "refresh_token": "rotated-refresh-token",
            "account_id": "acct-token",
        },
    })
    refresh_requests = []

    def fake_refresh(config, params):
        refresh_requests.append((config.auth_version, params))
        return {
            "authJson": refreshed_auth_json,
            "authVersion": 8,
            "accessToken": "fresh-access-token",
            "chatgptAccountId": "acct-token",
            "chatgptPlanType": "pro",
        }

    monkeypatch.setattr(codex_app_server, "_request_roomtalk_auth_refresh", fake_refresh)
    popen = FakeAppServerPopenFactory([
        {"id": 0, "result": {}},
        {"id": 1, "result": {"thread": {"id": "thread-app-refresh"}}},
        {
            "id": 44,
            "method": "account/chatgptAuthTokens/refresh",
            "params": {"reason": "unauthorized", "previousAccountId": "acct-token"},
        },
        {"id": 2, "result": {"turn": {"id": "turn-app-refresh"}}},
        {"method": "turn/completed", "params": {"threadId": "thread-app-refresh", "turn": {"id": "turn-app-refresh", "status": "completed", "items": []}}},
    ])
    config = codex_app_server.CodexCliRunConfig(
        secret_parent=tmp_path / "secrets",
        auth_json_path=auth_json,
        refreshed_auth_json_path=refreshed_auth_path,
        auth_refresh_url="https://room.example/api/code-agent/codex-auth/refresh",
        auth_refresh_token="turn-token",
        auth_version=7,
    )

    codex_app_server.run_request(
        codex_app_request(workspace),
        emitter=EventEmitter(io.StringIO()),
        config=config,
        popen_factory=popen,
        env={"CODE_AGENT_WORKSPACE_ROOT": str(tmp_path)},
    )

    response = next(message for message in jsonrpc_lines(popen.processes[0]) if message.get("id") == 44)
    assert response["result"] == {
        "accessToken": "fresh-access-token",
        "chatgptAccountId": "acct-token",
        "chatgptPlanType": "pro",
    }
    assert refresh_requests == [(7, {"reason": "unauthorized", "previousAccountId": "acct-token"})]
    assert config.auth_version == 8
    assert json.loads(refreshed_auth_path.read_text(encoding="utf-8"))["tokens"]["access_token"] == "fresh-access-token"


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
        env={"CODE_AGENT_WORKSPACE_ROOT": str(tmp_path)},
    )

    events = event_lines(stdout)
    approval = next(event for event in events if event["type"] == "approval_request")
    assert approval["id"] == "cmd-approval"
    assert approval["approvalType"] == "command"
    assert approval["args"]["approvalId"] == "cmd-approval"
    assert approval["args"]["command"] == "npm install"
    assert approval["args"]["cwd"] == str(workspace)
    assert all(message.get("id") != 88 for message in jsonrpc_lines(popen.processes[0]))


def test_codex_app_server_runs_thread_list_query(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    def fail_turn_watchdog(*_args, **_kwargs):
        raise AssertionError("Codex app-server thread queries must not create a watchdog timer")

    monkeypatch.setattr(codex_app_server.threading, "Timer", fail_turn_watchdog)
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
        env={"CODE_AGENT_WORKSPACE_ROOT": str(tmp_path)},
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
