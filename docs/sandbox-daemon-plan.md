# RoomTalk Sandbox Daemon Plan

## Goal

Replace the per-turn runner process model with one sandbox-local daemon per E2B sandbox. RoomTalk remains the control plane: rooms, permissions, persistence, model gateway tokens, and sandbox lifecycle. The daemon becomes the execution plane: workspace tools, foreground process sessions, browser/dev-server state, and agent backend adapters.

The target shape is:

```text
RoomTalk server
  -> ensure/create E2B sandbox
  -> ensure sandbox daemon is healthy
  -> send turn/control requests to daemon
  <- persist daemon events and stream them to the room

E2B sandbox daemon
  -> owns /workspace execution
  -> dispatches agent backends
  -> manages long-running tool sessions
  -> emits structured JSONL events
```

## Current Branch Scope

This branch implements the daemon foundation and server integration behind `CODE_AGENT_RUNNER_CLIENT=daemon`:

- `roomtalk_code_agent_runner.daemon` supports `code-agent`, `codex`, and `codex-app-server` run requests, control forwarding, health, shutdown, and Codex thread queries.
- The Node server keeps one daemon process per sandbox in memory, sends per-turn secrets in request `env`, and no longer stops the daemon at normal turn end.
- Sandbox lifetime is split into idle and active TTLs: default idle is 2 minutes, default active is 60 minutes.
- The E2B artifact metadata and build smoke checks include the daemon entrypoint.

It does not publish the E2B template or flip production envs by itself.

## Why This Change

The current server starts a new runner command for each turn:

```text
turn starts -> python -m roomtalk_code_agent_runner... -> final/error -> stop process
```

That keeps each turn isolated, but it also causes repeated startup cost and makes process lifetime semantics blurry. It also led to the E2B timeout bug: RoomTalk allowed a turn to run longer than the sandbox lifecycle timeout, so E2B terminated the command stream with `2: [unknown] terminated`.

The daemon model makes the lifecycle explicit:

- E2B sandbox lifetime is managed at the sandbox level.
- The daemon is the long-lived local service inside the sandbox.
- Agent turns are requests handled by the daemon, not separate E2B command processes.
- Long-running foreground tools are first-class sessions owned by the daemon.

## Non-Goals

- Do not move shell/file/browser execution onto the Fly server.
- Do not make RoomTalk server understand Codex internals.
- Do not require one daemon per agent backend.
- Do not remove the existing per-turn JSONL runner path until daemon mode is proven with tests and smoke runs.

## Agent Backends

The daemon supports three backend adapters:

- `code-agent`: existing Coco/code-agent runner.
- `codex`: Codex CLI adapter.
- `codex-app-server`: Codex app-server SDK adapter.

The server chooses the backend per room/turn and sends it in the daemon request. The daemon routes to the adapter.

## Protocol

The daemon reads JSONL requests from stdin and emits JSONL events on stdout.

Requests:

```json
{"schemaVersion":1,"type":"health","requestId":"..."}
{"schemaVersion":1,"type":"run","backend":"codex-app-server","turnId":"...","sessionId":"...","prompt":"..."}
{"schemaVersion":1,"type":"interrupt","turnId":"...","reason":"user_stop"}
{"schemaVersion":1,"type":"steer","turnId":"...","prompt":"..."}
{"schemaVersion":1,"type":"approval_response","turnId":"...","approvalId":"...","decision":"accept"}
{"schemaVersion":1,"type":"thread_list","roomId":"...","workspace":"/workspace"}
{"schemaVersion":1,"type":"thread_read","roomId":"...","workspace":"/workspace","threadId":"..."}
{"schemaVersion":1,"type":"shutdown"}
```

Events:

```json
{"schemaVersion":1,"type":"daemon_ready","daemonId":"...","pid":123}
{"schemaVersion":1,"type":"health_result","requestId":"...","status":"ok"}
{"schemaVersion":1,"type":"status","turnId":"...","status":"running"}
{"schemaVersion":1,"type":"text_delta","turnId":"...","messageId":"...","delta":"..."}
{"schemaVersion":1,"type":"tool_call","turnId":"...","id":"...","name":"shell","args":{}}
{"schemaVersion":1,"type":"tool_result","turnId":"...","id":"...","name":"shell","success":true,"output":"..."}
{"schemaVersion":1,"type":"final","turnId":"...","messageId":"...","answer":"...","sessionId":"..."}
{"schemaVersion":1,"type":"error","turnId":"...","message":"...","code":"...","retryable":false}
```

Every turn-scoped event must include `turnId`. The daemon must reject a new `run` while another run is active unless a future explicit queue mode is added.

## Lifecycle

Sandbox timeout is no longer a per-turn substitute.

- Idle sandbox TTL: short, default 2 minutes.
- Active sandbox TTL: long, default 60 minutes.
- Turn start: server extends sandbox timeout to active TTL and ensures daemon health.
- Turn completion/error/cancel: server stops the active turn if needed and shortens sandbox timeout to idle TTL.
- User stop: server sends `interrupt`; if that does not finish, it may send `shutdown` or stop the daemon process.
- Server restart: existing recovery marks running rooms as interrupted; daemon reconnection can be added once E2B command reconnect support is exposed.

## Implementation Phases

### Phase 1: Daemon Protocol Foundation

- Add `roomtalk_code_agent_runner.daemon`.
- Daemon reads multiple JSONL requests from stdin.
- Daemon routes `run` to the three existing backend functions.
- Add `health`, `shutdown`, and active-turn rejection.
- Add Python tests for multiple sequential turns and busy rejection.

### Phase 2: Server Daemon Client

- Add TypeScript daemon protocol types and parser coverage.
- Add a daemon client that can start the daemon command once per sandbox handle and reuse the process across turns while the Node process is alive.
- Keep the current per-turn runner client as a fallback.
- Add observability for daemon start, health, request, response, and shutdown.

### Phase 3: Sandbox Timeout Semantics

- Extend the E2B driver/service with `setTimeout`.
- Add lifecycle methods:
  - `extendSandboxForActiveTurn(handle)`
  - `shortenSandboxAfterTurn(handle)`
- Add envs:
  - `CODE_AGENT_IDLE_SANDBOX_TTL_MS=120000`
  - `CODE_AGENT_ACTIVE_SANDBOX_TTL_MS=3600000`
- Stop using short command timeouts for CodexApp turns.

### Phase 4: Agent Backend Migration

- Route `codex-app-server` through daemon mode first.
- Then route `codex` and `code-agent`.
- Preserve `sessionId` behavior: the server stores final `sessionId`, and the next `run` request passes it back.
- Keep per-turn runner mode behind a feature flag until production smoke is stable.

### Phase 5: Persistent Daemon Reconnect

- Expose E2B command reconnect/list support if available.
- Persist daemon pid/session metadata in room/sandbox metadata or a daemon registry table.
- Reconnect after server restart when safe; otherwise start a new daemon after recovery marks old turns interrupted.

## Verification

- Python unit tests for daemon request loop and backend routing.
- TypeScript tests for protocol parsing, daemon client request/response flow, and sandbox timeout transitions.
- E2B smoke:
  - health request
  - two sequential turns in one daemon process
  - foreground HTTP server plus second tool call
  - interrupt cleanup
  - sandbox timeout active/idle transition

## Rollout

1. Ship daemon code in the E2B artifact but keep server using per-turn runner.
2. Enable daemon mode for one internal CodexApp room.
3. Validate sequential turns, long foreground tools, and final/session persistence.
4. Enable for CodexApp rooms.
5. Enable for Codex CLI and code-agent backends.
6. Remove per-turn runner fallback after enough production soak.
