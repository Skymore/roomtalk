from __future__ import annotations

import io
import json
import os
import queue
import threading
import time
from pathlib import Path
from typing import Any

from roomtalk_code_agent_runner import codex_app_server, codex_sdk_app_server
from roomtalk_code_agent_runner.runner import EventEmitter, parse_request
from test_runner import event_lines, request


class FakeModel:
    def __init__(self, data: dict[str, Any]):
        self.data = data

    def model_dump(self, **_kwargs: Any) -> dict[str, Any]:
        return self.data


class FakeNotification:
    def __init__(self, method: str, params: dict[str, Any]):
        self.method = method
        self.payload = FakeModel(params)


class FakeSdkClient:
    def __init__(
        self,
        sdk_config: Any,
        approval_handler: Any,
        *,
        notifications: list[Any] | None = None,
        control_queue: "queue.Queue[dict[str, Any] | None] | None" = None,
        resume_error: Exception | None = None,
        thread_list_result: dict[str, Any] | None = None,
        thread_read_result: dict[str, Any] | None = None,
    ):
        self.sdk_config = sdk_config
        self.approval_handler = approval_handler
        self.notifications = list(notifications or [])
        self.control_queue = control_queue
        self.resume_error = resume_error
        self.thread_list_result = thread_list_result or {"data": [], "nextCursor": None}
        self.thread_read_result = thread_read_result or {"thread": {}}
        self.calls: list[tuple[str, Any]] = []
        self.started_env: dict[str, str] = {}
        self.closed = False
        self.approval_results: list[dict[str, Any]] = []

    def start(self):
        self.calls.append(("start", None))
        self.started_env = dict(os.environ)
        codex_home = Path(self.started_env["CODEX_HOME"])
        (codex_home / "auth.json").write_text('{"accessToken":"refreshed"}', encoding="utf-8")

    def initialize(self):
        self.calls.append(("initialize", None))
        return FakeModel({})

    def thread_resume(self, thread_id: str, params: dict[str, Any]):
        self.calls.append(("thread_resume", {"thread_id": thread_id, "params": params}))
        if self.resume_error:
            raise self.resume_error
        return FakeModel({"thread": {"id": "thread-sdk-1"}})

    def thread_start(self, params: dict[str, Any]):
        self.calls.append(("thread_start", params))
        return FakeModel({"thread": {"id": "thread-sdk-new"}})

    def turn_start(self, thread_id: str, input_items: list[dict[str, Any]], params: dict[str, Any]):
        self.calls.append(("turn_start", {"thread_id": thread_id, "input": input_items, "params": params}))
        return FakeModel({"turn": {"id": "turn-sdk-1"}})

    def next_turn_notification(self, turn_id: str):
        self.calls.append(("next_turn_notification", turn_id))
        if not self.notifications:
            raise RuntimeError("no fake notification queued")
        item = self.notifications.pop(0)
        if isinstance(item, ApprovalStep):
            result_holder: list[dict[str, Any]] = []

            def ask_for_approval() -> None:
                result_holder.append(self.approval_handler(item.method, item.params))

            thread = threading.Thread(target=ask_for_approval)
            thread.start()
            time.sleep(0.05)
            assert self.control_queue is not None
            self.control_queue.put({
                "schemaVersion": 1,
                "type": "approval_response",
                "turnId": item.roomtalk_turn_id,
                "approvalId": item.approval_id,
                "decision": item.decision,
            })
            thread.join(timeout=2)
            assert result_holder
            self.approval_results.append(result_holder[0])
            return self.next_turn_notification(turn_id)
        if isinstance(item, ControlStep):
            assert self.control_queue is not None
            self.control_queue.put(item.control)
            deadline = time.time() + 2
            while not any(name == item.expected_call for name, _payload in self.calls) and time.time() < deadline:
                time.sleep(0.01)
            return self.next_turn_notification(turn_id)
        return item

    def thread_list(self, params: dict[str, Any]):
        self.calls.append(("thread_list", params))
        return FakeModel(self.thread_list_result)

    def thread_read(self, thread_id: str, include_turns: bool = False):
        self.calls.append(("thread_read", {"thread_id": thread_id, "include_turns": include_turns}))
        return FakeModel(self.thread_read_result)

    def turn_interrupt(self, thread_id: str, turn_id: str):
        self.calls.append(("turn_interrupt", {"thread_id": thread_id, "turn_id": turn_id}))
        return FakeModel({})

    def turn_steer(self, thread_id: str, turn_id: str, input_items: list[dict[str, Any]]):
        self.calls.append(("turn_steer", {"thread_id": thread_id, "turn_id": turn_id, "input": input_items}))
        return FakeModel({})

    def close(self):
        self.closed = True


class FakeSdkClientFactory:
    def __init__(self, **client_kwargs: Any):
        self.client_kwargs = client_kwargs
        self.clients: list[FakeSdkClient] = []

    def __call__(self, sdk_config: Any, approval_handler: Any):
        client = FakeSdkClient(sdk_config, approval_handler, **self.client_kwargs)
        self.clients.append(client)
        return client


class ApprovalStep:
    def __init__(self, *, roomtalk_turn_id: str, approval_id: str, decision: str):
        self.roomtalk_turn_id = roomtalk_turn_id
        self.approval_id = approval_id
        self.decision = decision
        self.method = "item/commandExecution/requestApproval"
        self.params = {
            "threadId": "thread-sdk-1",
            "turnId": "turn-sdk-1",
            "itemId": approval_id,
            "command": "npm install",
            "cwd": "/workspace/project",
            "startedAtMs": 123,
        }


class ControlStep:
    def __init__(self, control: dict[str, Any], expected_call: str):
        self.control = control
        self.expected_call = expected_call


def codex_sdk_request(workspace: Path, **overrides: Any):
    return parse_request(json.dumps(request(
        turnId="turn-sdk",
        sessionId="session-prev",
        prompt="inspect with sdk app server",
        workspace=str(workspace),
        **overrides,
    )))


def test_codex_sdk_app_server_maps_sdk_notifications_and_sanitizes_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    def fail_turn_watchdog(*_args, **_kwargs):
        raise AssertionError("Codex SDK app-server turns must not create a watchdog timer")

    monkeypatch.setattr(codex_sdk_app_server.threading, "Timer", fail_turn_watchdog)
    monkeypatch.setattr(
        codex_app_server,
        "_materialize_codex_image_url",
        lambda _url, *, turn_id: f"data:image/png;base64,{turn_id}",
    )
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    auth_json = tmp_path / "auth.json"
    refreshed_auth_json = tmp_path / "refreshed" / "auth.json"
    auth_json.write_text('{"accessToken":"initial"}', encoding="utf-8")
    stdout = io.StringIO()
    factory = FakeSdkClientFactory(notifications=[
        FakeNotification("turn/started", {"threadId": "thread-sdk-1", "turn": {"id": "turn-sdk-1"}}),
        FakeNotification("item/agentMessage/delta", {"threadId": "thread-sdk-1", "turnId": "turn-sdk-1", "itemId": "msg-1", "delta": f"I read {workspace}/demo.txt"}),
        FakeNotification("item/started", {"threadId": "thread-sdk-1", "turnId": "turn-sdk-1", "item": {"id": "cmd-1", "type": "commandExecution", "command": "ls", "status": "running", "cwd": str(workspace)}}),
        FakeNotification("item/commandExecution/outputDelta", {"threadId": "thread-sdk-1", "turnId": "turn-sdk-1", "itemId": "cmd-1", "delta": f"{workspace}/demo.txt\n"}),
        FakeNotification("item/completed", {"threadId": "thread-sdk-1", "turnId": "turn-sdk-1", "item": {"id": "cmd-1", "type": "commandExecution", "command": "ls", "status": "completed", "exitCode": 0, "aggregatedOutput": "", "cwd": str(workspace), "durationMs": 7}}),
        FakeNotification("thread/tokenUsage/updated", {"threadId": "thread-sdk-1", "turnId": "turn-sdk-1", "tokenUsage": {"last": {"totalTokens": 12, "inputTokens": 8, "cachedInputTokens": 2, "outputTokens": 4, "reasoningOutputTokens": 1}, "total": {"totalTokens": 12, "inputTokens": 8, "cachedInputTokens": 2, "outputTokens": 4, "reasoningOutputTokens": 1}}}),
        FakeNotification("turn/completed", {"threadId": "thread-sdk-1", "turn": {"id": "turn-sdk-1", "status": "completed", "items": []}}),
    ])

    codex_sdk_app_server.run_request(
        codex_sdk_request(
            workspace,
            codexModel="gpt-5.3-codex-spark",
            codexReasoningEffort="high",
            images=[{"url": "https://media.example/signed/input.png?token=secret"}],
        ),
        emitter=EventEmitter(stdout),
        config=codex_sdk_app_server.CodexCliRunConfig(
            cli_bin="/usr/local/bin/codex",
            secret_parent=tmp_path / "secrets",
            auth_json_path=auth_json,
            refreshed_auth_json_path=refreshed_auth_json,
        ),
        client_factory=factory,
        env={
            "PATH": "/usr/bin",
            "HOME": "/home/roomtalk",
            "CODE_AGENT_WORKSPACE_ROOT": str(tmp_path),
            "OPENAI_API_KEY": "sk-should-not-leak",
            "ROOMTALK_CODEX_AUTH_JSON_PATH": str(auth_json),
            "PUBLIC_VALUE": "visible",
        },
    )

    client = factory.clients[0]
    assert client.sdk_config.codex_bin == "/usr/local/bin/codex"
    assert client.sdk_config.cwd == str(workspace)
    assert "OPENAI_API_KEY" not in client.started_env
    assert client.started_env["PUBLIC_VALUE"] == "visible"
    assert refreshed_auth_json.read_text(encoding="utf-8") == '{"accessToken":"refreshed"}'

    turn_start = next(call[1] for call in client.calls if call[0] == "turn_start")
    assert turn_start["thread_id"] == "thread-sdk-1"
    assert turn_start["params"]["model"] == "gpt-5.3-codex-spark"
    assert turn_start["params"]["effort"] == "high"
    assert turn_start["params"]["serviceTier"] == "default"
    assert turn_start["params"]["sandboxPolicy"]["type"] == "readOnly"
    assert turn_start["input"][1] == {
        "type": "image",
        "url": "data:image/png;base64,turn-sdk",
    }

    events = event_lines(stdout)
    assert [event["type"] for event in events] == [
        "status",
        "status",
        "text_delta",
        "tool_call",
        "tool_result",
        "usage",
        "status",
        "final",
    ]
    assert events[2]["delta"] == "I read demo.txt"
    assert events[4]["output"] == "demo.txt\n"
    assert events[-1]["answer"] == "I read demo.txt"
    assert events[-1]["sessionId"] == "thread-sdk-1"
    assert events[-1]["usage"]["source"] == "reported"


def test_codex_sdk_app_server_resolves_relative_codex_bin_from_path(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    auth_json = tmp_path / "auth.json"
    auth_json.write_text('{"accessToken":"initial"}', encoding="utf-8")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    codex_bin = bin_dir / "codex"
    codex_bin.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    codex_bin.chmod(0o755)
    stdout = io.StringIO()
    factory = FakeSdkClientFactory(notifications=[
        FakeNotification("turn/completed", {"threadId": "thread-sdk-1", "turn": {"id": "turn-sdk-1", "status": "completed", "items": []}}),
    ])

    codex_sdk_app_server.run_request(
        codex_sdk_request(workspace),
        emitter=EventEmitter(stdout),
        config=codex_sdk_app_server.CodexCliRunConfig(
            cli_bin="codex",
            secret_parent=tmp_path / "secrets",
            auth_json_path=auth_json,
        ),
        client_factory=factory,
        env={
            "PATH": str(bin_dir),
            "HOME": "/home/roomtalk",
            "CODE_AGENT_WORKSPACE_ROOT": str(tmp_path),
            "ROOMTALK_CODEX_AUTH_JSON_PATH": str(auth_json),
        },
    )

    assert factory.clients[0].sdk_config.codex_bin == str(codex_bin)


def test_codex_sdk_app_server_falls_back_to_new_thread_when_resume_fails(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    auth_json = tmp_path / "auth.json"
    auth_json.write_text('{"accessToken":"initial"}', encoding="utf-8")
    stdout = io.StringIO()
    factory = FakeSdkClientFactory(
        resume_error=RuntimeError("thread not found"),
        notifications=[
            FakeNotification("turn/completed", {"threadId": "thread-sdk-new", "turn": {"id": "turn-sdk-1", "status": "completed", "items": []}}),
        ],
    )

    codex_sdk_app_server.run_request(
        codex_sdk_request(workspace),
        emitter=EventEmitter(stdout),
        config=codex_sdk_app_server.CodexCliRunConfig(secret_parent=tmp_path / "secrets", auth_json_path=auth_json),
        client_factory=factory,
        env={"CODE_AGENT_WORKSPACE_ROOT": str(tmp_path)},
    )

    call_names = [name for name, _payload in factory.clients[0].calls]
    assert "thread_resume" in call_names
    assert "thread_start" in call_names
    assert event_lines(stdout)[-1]["sessionId"] == "thread-sdk-new"


def test_codex_sdk_app_server_routes_interactive_approval_response(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    auth_json = tmp_path / "auth.json"
    auth_json.write_text('{"accessToken":"initial"}', encoding="utf-8")
    stdout = io.StringIO()
    controls: "queue.Queue[dict[str, Any] | None]" = queue.Queue()
    factory = FakeSdkClientFactory(
        control_queue=controls,
        notifications=[
            ApprovalStep(roomtalk_turn_id="turn-sdk", approval_id="cmd-approval", decision="accept"),
            FakeNotification("turn/completed", {"threadId": "thread-sdk-1", "turn": {"id": "turn-sdk-1", "status": "completed", "items": []}}),
        ],
    )

    codex_sdk_app_server.run_request(
        codex_sdk_request(workspace, mode="edit", codexPermissionMode="edit"),
        emitter=EventEmitter(stdout),
        config=codex_sdk_app_server.CodexCliRunConfig(secret_parent=tmp_path / "secrets", auth_json_path=auth_json),
        client_factory=factory,
        control_queue=controls,
        env={"CODE_AGENT_WORKSPACE_ROOT": str(tmp_path)},
    )

    client = factory.clients[0]
    assert client.approval_results == [{"decision": "accept"}]
    events = event_lines(stdout)
    approval = next(event for event in events if event["type"] == "approval_request")
    assert approval["approvalType"] == "command"
    assert approval["args"]["approvalId"] == "cmd-approval"
    approval_result = next(event for event in events if event["type"] == "tool_result" and event["name"] == "approval_request")
    assert approval_result["success"] is True


def test_codex_sdk_app_server_acknowledges_steer_controls(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    auth_json = tmp_path / "auth.json"
    auth_json.write_text('{"accessToken":"initial"}', encoding="utf-8")
    stdout = io.StringIO()
    controls: "queue.Queue[dict[str, Any] | None]" = queue.Queue()
    factory = FakeSdkClientFactory(
        control_queue=controls,
        notifications=[
            ControlStep({
                "schemaVersion": 1,
                "type": "steer",
                "turnId": "turn-sdk",
                "controlId": "control-steer-1",
                "prompt": "use Bing instead",
            }, "turn_steer"),
            FakeNotification("turn/completed", {"threadId": "thread-sdk-1", "turn": {"id": "turn-sdk-1", "status": "completed", "items": []}}),
        ],
    )

    codex_sdk_app_server.run_request(
        codex_sdk_request(workspace),
        emitter=EventEmitter(stdout),
        config=codex_sdk_app_server.CodexCliRunConfig(secret_parent=tmp_path / "secrets", auth_json_path=auth_json),
        client_factory=factory,
        control_queue=controls,
        env={"CODE_AGENT_WORKSPACE_ROOT": str(tmp_path)},
    )

    result = next(event for event in event_lines(stdout) if event.get("controlId") == "control-steer-1")
    assert result["type"] == "control_result"
    assert result["accepted"] is True


def test_codex_sdk_app_server_runs_thread_list_query(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    def fail_turn_watchdog(*_args, **_kwargs):
        raise AssertionError("Codex SDK app-server thread queries must not create a watchdog timer")

    monkeypatch.setattr(codex_sdk_app_server.threading, "Timer", fail_turn_watchdog)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    auth_json = tmp_path / "auth.json"
    auth_json.write_text('{"accessToken":"initial"}', encoding="utf-8")
    stdout = io.StringIO()
    factory = FakeSdkClientFactory(thread_list_result={
        "data": [{"id": "thread-1", "title": "Inspect project", "updatedAt": "2026-07-04T10:00:00Z"}],
        "nextCursor": "cursor-next",
    })
    query = codex_sdk_app_server.parse_app_server_request(json.dumps({
        "schemaVersion": 1,
        "type": "thread_list",
        "roomId": "room-threads",
        "clientId": "client-1",
        "workspace": str(workspace),
        "limit": 10,
        "searchTerm": "inspect",
    }))

    codex_sdk_app_server.run_thread_query_request(
        query,
        emitter=EventEmitter(stdout),
        config=codex_sdk_app_server.CodexCliRunConfig(secret_parent=tmp_path / "secrets", auth_json_path=auth_json),
        client_factory=factory,
        env={"CODE_AGENT_WORKSPACE_ROOT": str(tmp_path)},
    )

    thread_list = next(call[1] for call in factory.clients[0].calls if call[0] == "thread_list")
    assert thread_list == {
        "limit": 10,
        "sortKey": "updated_at",
        "sortDirection": "desc",
        "cwd": str(workspace),
        "archived": False,
        "searchTerm": "inspect",
    }
    assert event_lines(stdout) == [{
        "schemaVersion": 1,
        "type": "thread_list_result",
        "roomId": "room-threads",
        "threads": [{"id": "thread-1", "title": "Inspect project", "updatedAt": "2026-07-04T10:00:00Z"}],
        "nextCursor": "cursor-next",
        "backwardsCursor": None,
    }]
