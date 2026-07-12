# RoomTalk Sandbox Daemon Runtime and Protocol

Verified against `master` and the production non-secret runtime configuration: 2026-07-12

## Goal

Use one sandbox-local daemon per E2B sandbox instead of starting a new E2B command process for every agent turn. RoomTalk remains the control plane for rooms, permissions, durable turns, fenced room leases, scoped tokens, and sandbox lifecycle. The daemon owns only the agent backend request loop; files, PTY terminals, preview sessions, and dev servers are separate sandbox services and are not daemon-owned protocol state.

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

## Current Implementation

Production currently uses `CODE_AGENT_RUNNER_CLIENT=daemon` with an E2B sandbox and `codex-app-server` as the default backend:

- `roomtalk_code_agent_runner.daemon` supports Coco (`code-agent`), Codex app-server, the legacy Codex CLI compatibility adapter, control forwarding, health, shutdown, and app-server thread queries.
- The Node server keeps one daemon process per sandbox in memory, sends per-turn secrets in request `env`, and no longer stops the daemon at normal turn end.
- Sandbox lifetime is split into idle and active TTLs: default idle is 2 minutes, default active is 60 minutes.
- A durable fenced lease serializes mutating turns per room across RoomTalk processes; the daemon independently rejects a second active run in the same sandbox.
- The E2B artifact metadata, Docker readiness checks, and runner tests include the daemon entrypoint.
- A 10-second bounded release wait handles a missing `turn_released`; app-server thread queries have a 30-second timeout and recycle the daemon if the query channel wedges.

## Why This Shape

The earlier implementation started a new runner command for each turn:

```text
turn starts -> python -m roomtalk_code_agent_runner... -> final/error -> stop process
```

That repeated runtime startup and coupled command-stream lifetime to sandbox timeout. It also made backend thread/session state and long-lived workspace processes harder to reason about.

The daemon model makes the lifecycle explicit:

- E2B sandbox lifetime is managed at the sandbox level.
- The daemon is the long-lived local service inside the sandbox.
- Agent turns are requests handled by the daemon, not separate E2B command processes.
- Long-running background tools and PTY/dev-server processes live in the sandbox independently of a single runner request.

## Non-Goals

- Do not move shell/file/browser execution onto the Fly server.
- Do not make RoomTalk server understand Codex internals.
- Do not require one daemon per agent backend.
- Do not make daemon handles durable: stdin/stdout handles belong to one Node process and cannot be serialized safely.
- Do not add new product behavior to the deprecated Codex CLI adapter.

## Agent Backends

The daemon accepts three backend identifiers, but only two are current product paths:

- `code-agent`: existing Coco/code-agent runner.
- `codex-app-server`: supported Codex app-server adapter (implemented by the SDK app-server runner command).
- `codex`: deprecated Codex CLI compatibility adapter.

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
{"schemaVersion":1,"type":"approval_request","turnId":"...","id":"...","title":"..."}
{"schemaVersion":1,"type":"final","turnId":"...","messageId":"...","answer":"...","sessionId":"..."}
{"schemaVersion":1,"type":"error","turnId":"...","message":"...","code":"...","retryable":false}
{"schemaVersion":1,"type":"turn_released","turnId":"..."}
```

This is a representative subset; runner events also include model-step usage, thread query results, and control acknowledgments. Every turn-scoped event must include `turnId`. A terminal `final`/`error` ends the logical result, while `turn_released` confirms backend cleanup. The daemon rejects a new `run` while another run is active; durable queuing belongs to RoomTalk, not the daemon.

## Lifecycle

Sandbox timeout is no longer a per-turn substitute.

- Idle sandbox TTL: short, default 2 minutes.
- Active sandbox TTL: long, default 60 minutes.
- Turn start: server extends sandbox timeout to active TTL and ensures daemon health.
- Turn completion/error/cancel: server stops the active turn if needed and shortens sandbox timeout to idle TTL.
- User stop: server sends `interrupt`; terminal runner events are not considered fully released until `turn_released` or the bounded release timeout.
- Server restart: durable recovery marks orphaned running turns as interrupted/error and can drain durable queued inputs. The new process removes stale daemon/app-server children before starting a replacement; it does not reconnect to the old stdin/stdout handles.
- Process shutdown: the in-memory registry stops every daemon owned by that Node process.

## Implementation Status

### Completed

- Multi-request JSONL daemon with ready/health/shutdown and busy rejection.
- Node daemon protocol/parser/client plus one in-memory process registry entry per sandbox.
- Sequential Coco and Codex app-server turns with per-turn environment overlays.
- Interrupt, steer, approval response, thread list/read, terminal events, and `turn_released` handling.
- Active/idle sandbox timeout transitions, stale child cleanup, process shutdown cleanup, and bounded release waits.
- Durable room leases, queued-input materialization at turn boundaries, and recovery of failed startup/queued states.
- Thread-query timeout that terminates the bad daemon handle so the next operation starts a clean process.

### Compatibility retained

- `CODE_AGENT_RUNNER_CLIENT=jsonl` remains useful for direct smoke tests and compatibility.
- The daemon still recognizes `codex`, but Codex CLI is deprecated; new protocol and UI work targets `codex-app-server`.

### Future only if E2B exposes a stable primitive

- Persist reconnectable daemon metadata only if E2B provides a stable command reconnect handle. A PID alone is insufficient because the Node process also needs a safe stdin/stdout transport and ownership fencing.
- Until then, treat daemon handles as process-local runtime state and use durable turn/lease recovery plus stale-process cleanup.

## Verification

- Python unit tests for daemon request loop and backend routing.
- TypeScript tests for protocol parsing, daemon client request/response flow, and sandbox timeout transitions.
- Store/session tests for fenced room leases, queue materialization, lost release, and startup recovery.
- E2B smoke:
  - health request
  - two sequential turns in one daemon process
  - foreground HTTP server plus second tool call
  - interrupt cleanup
  - sandbox timeout active/idle transition

## Release Contract

Daemon or protocol changes touch the E2B runtime contract. They require a runner version bump, matching `artifact.lock.json` and Dockerfile artifact metadata, a rebuilt/published E2B template, focused Python/Node protocol tests, and a real E2B check. Production `CODE_AGENT_E2B_TEMPLATE_ID`, `CODE_AGENT_ARTIFACT_VERSION`, and `CODE_AGENT_SOURCE_REF` must match before the change is complete.

Production currently selects daemon mode explicitly. A Fly source deploy without the matching template does not update the sandbox daemon.
