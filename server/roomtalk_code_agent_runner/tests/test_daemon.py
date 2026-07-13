from __future__ import annotations

import io
import json
import queue
import threading
import time
from typing import Any

from roomtalk_code_agent_runner import daemon as daemon_module
from roomtalk_code_agent_runner.daemon import SandboxDaemon
from roomtalk_code_agent_runner.runner import EventEmitter, RunnerRequest


def request(**overrides: Any) -> dict[str, Any]:
    payload = {
        "schemaVersion": 1,
        "type": "run",
        "backend": "code-agent",
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


def lines(*payloads: dict[str, Any]) -> io.StringIO:
    return io.StringIO("".join(json.dumps(payload) + "\n" for payload in payloads))


def event_lines(buffer: io.StringIO) -> list[dict[str, Any]]:
    return [json.loads(line) for line in buffer.getvalue().splitlines() if line.strip()]


class InteractiveLines:
    def __init__(self) -> None:
        self._queue: "queue.Queue[str | None]" = queue.Queue()

    def write_json(self, payload: dict[str, Any]) -> None:
        self._queue.put(json.dumps(payload) + "\n")

    def close(self) -> None:
        self._queue.put(None)

    def __iter__(self) -> "InteractiveLines":
        return self

    def __next__(self) -> str:
        line = self._queue.get(timeout=2)
        if line is None:
            raise StopIteration
        return line


def wait_for_event(buffer: io.StringIO, predicate: Any) -> dict[str, Any]:
    deadline = time.time() + 2
    while time.time() < deadline:
        for event in event_lines(buffer):
            if predicate(event):
                return event
        time.sleep(0.01)
    raise AssertionError(f"timed out waiting for event; saw: {buffer.getvalue()}")


def test_daemon_handles_health_and_multiple_sequential_runs():
    calls: list[tuple[str, str]] = []

    def handler(req: RunnerRequest, emitter: EventEmitter, env: dict[str, str], controls: "queue.Queue[dict[str, Any] | None]") -> None:
        del env, controls
        calls.append((req.turn_id, req.prompt))
        emitter.emit({
            "type": "final",
            "turnId": req.turn_id,
            "messageId": f"message-{req.turn_id}",
            "answer": f"done {req.prompt}",
            "sessionId": f"session-{req.turn_id}",
        })

    stdin = InteractiveLines()
    stdout = io.StringIO()
    daemon = SandboxDaemon(
        stdin=stdin,  # type: ignore[arg-type]
        stdout=stdout,
        handlers={
            "code-agent": handler,
            "codex": handler,
            "codex-app-server": handler,
        },
    )

    thread = threading.Thread(target=daemon.run)
    thread.start()
    wait_for_event(stdout, lambda event: event["type"] == "daemon_ready")

    stdin.write_json({"schemaVersion": 1, "type": "health", "requestId": "health-1"})
    wait_for_event(stdout, lambda event: event["type"] == "health_result" and event["requestId"] == "health-1")

    stdin.write_json(request(turnId="turn-1", prompt="first", env={"ROOMTALK_TEST_TURN_ENV": "first-env"}))
    wait_for_event(stdout, lambda event: event["type"] == "final" and event["turnId"] == "turn-1")
    wait_for_event(stdout, lambda event: event["type"] == "turn_released" and event["turnId"] == "turn-1")

    stdin.write_json(request(turnId="turn-2", prompt="second", backend="codex", env={"ROOMTALK_TEST_TURN_ENV": "second-env"}))
    wait_for_event(stdout, lambda event: event["type"] == "final" and event["turnId"] == "turn-2")
    wait_for_event(stdout, lambda event: event["type"] == "turn_released" and event["turnId"] == "turn-2")

    stdin.write_json({"schemaVersion": 1, "type": "shutdown"})
    thread.join(timeout=2)
    assert not thread.is_alive()

    events = event_lines(stdout)
    assert events[0]["type"] == "daemon_ready"
    health_event = next(event for event in events if event["type"] == "health_result")
    assert health_event == {
        "schemaVersion": 1,
        "type": "health_result",
        "requestId": "health-1",
        "status": "ok",
        "activeTurnId": None,
    }
    assert [event["turnId"] for event in events if event["type"] == "final"] == ["turn-1", "turn-2"]
    assert [event["turnId"] for event in events if event["type"] == "turn_released"] == ["turn-1", "turn-2"]
    assert calls == [("turn-1", "first"), ("turn-2", "second")]


def test_daemon_merges_per_run_env_without_reusing_previous_values():
    seen: list[tuple[str, str | None]] = []

    def handler(req: RunnerRequest, emitter: EventEmitter, env: dict[str, str], controls: "queue.Queue[dict[str, Any] | None]") -> None:
        del controls
        seen.append((req.turn_id, env.get("ROOMTALK_TEST_TURN_ENV")))
        emitter.emit({
            "type": "final",
            "turnId": req.turn_id,
            "messageId": f"message-{req.turn_id}",
            "answer": "done",
            "sessionId": f"session-{req.turn_id}",
        })

    stdin = InteractiveLines()
    stdout = io.StringIO()
    daemon = SandboxDaemon(
        stdin=stdin,  # type: ignore[arg-type]
        stdout=stdout,
        env={"ROOMTALK_BASE_ENV": "base"},
        handlers={"code-agent": handler},
    )
    thread = threading.Thread(target=daemon.run)
    thread.start()
    wait_for_event(stdout, lambda event: event["type"] == "daemon_ready")

    stdin.write_json(request(turnId="turn-1", env={"ROOMTALK_TEST_TURN_ENV": "one"}))
    wait_for_event(stdout, lambda event: event["type"] == "final" and event["turnId"] == "turn-1")
    stdin.write_json(request(turnId="turn-2", env={"ROOMTALK_TEST_TURN_ENV": "two"}))
    wait_for_event(stdout, lambda event: event["type"] == "final" and event["turnId"] == "turn-2")
    stdin.write_json({"schemaVersion": 1, "type": "shutdown"})
    thread.join(timeout=2)

    assert seen == [("turn-1", "one"), ("turn-2", "two")]


def test_daemon_rejects_concurrent_run_while_active():
    def slow_handler(req: RunnerRequest, emitter: EventEmitter, env: dict[str, str], controls: "queue.Queue[dict[str, Any] | None]") -> None:
        del env, controls
        time.sleep(0.05)
        emitter.emit({
            "type": "final",
            "turnId": req.turn_id,
            "messageId": f"message-{req.turn_id}",
            "answer": "done",
            "sessionId": f"session-{req.turn_id}",
        })

    stdout = io.StringIO()
    daemon = SandboxDaemon(
        stdin=lines(
            request(turnId="turn-1"),
            request(turnId="turn-2"),
            {"schemaVersion": 1, "type": "shutdown"},
        ),
        stdout=stdout,
        handlers={"code-agent": slow_handler},
    )

    assert daemon.run() == 0

    events = event_lines(stdout)
    busy = [event for event in events if event.get("code") == "daemon_busy"]
    assert len(busy) == 1
    assert busy[0]["turnId"] == "turn-2"
    assert [event["turnId"] for event in events if event["type"] == "final"] == ["turn-1"]


def test_daemon_routes_control_messages_to_active_turn():
    def controlled_handler(req: RunnerRequest, emitter: EventEmitter, env: dict[str, str], controls: "queue.Queue[dict[str, Any] | None]") -> None:
        del env
        control = controls.get(timeout=1)
        emitter.emit({
            "type": "status",
            "turnId": req.turn_id,
            "status": "running",
            "message": f"control:{control['type'] if control else 'none'}",
        })
        emitter.emit({
            "type": "final",
            "turnId": req.turn_id,
            "messageId": f"message-{req.turn_id}",
            "answer": "controlled",
            "sessionId": f"session-{req.turn_id}",
        })

    stdout = io.StringIO()
    daemon = SandboxDaemon(
        stdin=lines(
            request(turnId="turn-1", backend="codex-app-server"),
            {"schemaVersion": 1, "type": "interrupt", "turnId": "turn-1", "reason": "test"},
            {"schemaVersion": 1, "type": "shutdown"},
        ),
        stdout=stdout,
        handlers={"codex-app-server": controlled_handler},
    )

    assert daemon.run() == 0

    events = event_lines(stdout)
    assert any(event.get("message") == "control:interrupt" for event in events)
    assert any(event.get("type") == "final" and event.get("turnId") == "turn-1" for event in events)
    assert any(event.get("type") == "turn_released" and event.get("turnId") == "turn-1" for event in events)


def test_daemon_runs_thread_query_with_per_request_env(monkeypatch: Any):
    seen: list[tuple[str, str | None]] = []

    def fake_run_thread_query_request(request: Any, emitter: EventEmitter, env: dict[str, str], **kwargs: Any) -> None:
        del kwargs
        seen.append((request.type, env.get("ROOMTALK_CODEX_AUTH_JSON_PATH")))
        emitter.emit({
            "type": "thread_list_result",
            "roomId": request.room_id,
            "threads": [{"id": "thread-1"}],
            "nextCursor": None,
            "backwardsCursor": None,
        })

    from roomtalk_code_agent_runner import codex_app_server
    monkeypatch.setattr(codex_app_server, "run_thread_query_request", fake_run_thread_query_request)

    stdout = io.StringIO()
    daemon = SandboxDaemon(
        stdin=lines(
            {
                "schemaVersion": 1,
                "type": "thread_list",
                "roomId": "room-threads",
                "clientId": "client-1",
                "workspace": "/tmp/workspace",
                "env": {"ROOMTALK_CODEX_AUTH_JSON_PATH": "/tmp/auth.json"},
            },
            {"schemaVersion": 1, "type": "shutdown"},
        ),
        stdout=stdout,
        env={"ROOMTALK_CODEX_AUTH_JSON_PATH": "/tmp/base-auth.json"},
    )

    assert daemon.run() == 0

    events = event_lines(stdout)
    assert seen == [("thread_list", "/tmp/auth.json")]
    assert any(event.get("type") == "thread_list_result" and event.get("threads") == [{"id": "thread-1"}] for event in events)


def test_default_handlers_keep_coco_cli_and_app_server_routes_separate():
    handlers = daemon_module._default_handlers()

    assert handlers == {
        "code-agent": daemon_module._run_code_agent,
        "codex": daemon_module._run_codex_cli,
        "codex-app-server": daemon_module._run_codex_app_server,
    }
