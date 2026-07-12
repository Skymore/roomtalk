# Code Agent Sandbox Plan

[中文原文](code-agent-sandbox.md)

Status: Historical design and implementation record
Reviewed: 2026-07-12

> This plan records the original path from a chat application to room-scoped coding workspaces. Production has since expanded to reusable JSONL daemons, Coco and Codex backends, room-context and model brokers, workspace review surfaces, durable static artifacts, and pause/resume lifecycle management. Use the [current runtime architecture](code-agent-runtime-architecture.md) as the operating contract.

## Purpose

RoomTalk needed a code-agent room that could inspect and modify a real repository, execute commands, and report tool activity without giving the browser direct access to an execution host.

The durable product boundary was established here:

- RoomTalk owns rooms, identity, permissions, persistence, sandbox lifecycle, budgets, rollout controls, and the web UI.
- A room-scoped sandbox owns untrusted files and processes.
- The existing Code Agent engine owns the model/tool loop, tool semantics, and coding workflow.
- A versioned runner protocol connects the two systems. RoomTalk does not reimplement the agent loop.

## Original User Experience

A user creates a Code Agent room, selects an execution mode, submits a coding task, watches assistant text and tool activity stream into the room, and returns later to the same durable conversation and workspace. The first release deliberately excluded shared host files, unrestricted networking, arbitrary browser-to-sandbox control, and multi-room reuse of one filesystem.

## Architecture

```text
Browser
  -> RoomTalk control plane
       -> room access and posting policy
       -> durable messages and turn state
       -> sandbox lifecycle and runner client
       -> ordered UI events
  -> one room-scoped E2B sandbox
       -> JSONL runner
       -> Code Agent engine
       -> workspace files and processes
```

The room is the isolation and ownership boundary. A sandbox ID, artifact version, workspace revision, backend session ID, and execution state are persisted so a later request can reconnect or recover instead of silently creating a second authority.

## Runner Contract

The runner reads one JSON object per line and emits one event per line. A request contains a protocol version, request/turn IDs, workspace root, prompt, mode, backend/model selection, bounded transcript, and scoped credentials. Events include assistant text deltas, tool start/progress/result, approval requests, usage, structured errors, and a terminal result.

Important contract rules:

- stdout is protocol-only; diagnostics go to stderr.
- IDs make retries and replay distinguishable.
- every request terminates with exactly one final result or error.
- untrusted tool output is bounded before it crosses into RoomTalk.
- secrets are injected as scoped runtime material and never serialized into room messages.

## Persistence and Revision Semantics

UI history and model context are related but different views. RoomTalk persists messages and normalized tool events for replay, while prompt assembly applies current context limits and backend-specific conversion. A workspace revision is captured at a completed turn boundary; retrying a message does not imply rewinding files unless an explicit restore operation succeeds.

The original plan introduced states for sandbox creation, readiness, running, interruption, failure, and termination. Current code adds fenced leases, queued input materialization, stale-run recovery, daemon recycling, artifact migration, and pause/auto-resume behavior.

## Permissions and Security

Every request must re-check room access and the selected room mode. The browser receives neither provider keys nor a raw sandbox credential. File paths, payload sizes, command runtime, preview targets, and archive sizes are bounded. RoomTalk mediates approvals and records enough information to audit who requested a turn and which backend executed it.

The current permission modes are documented in the runtime architecture. The important historical rule still holds: a read-only/plan turn cannot obtain write-capable tools merely because an earlier turn used edit mode.

## Frontend Shape

The plan evolved the chat surface into a coding workspace with:

- coding-task composer and run controls;
- assistant and tool-event timeline;
- files, search, preview, and editing;
- Git changes, diffs, and review comments;
- streamed terminal sessions;
- development-server previews and published artifacts;
- responsive mobile and desktop shells.

RoomTalk remains the only browser-facing authority. Workspace reads and mutations travel through authenticated server handlers.

## Testing and Rollout

The planned test ladder was:

1. runner serialization and malformed-output contract tests;
2. store and lifecycle unit tests;
3. fake-runner service tests for ordering, retries, and interruption;
4. real runner smoke tests in an isolated workspace;
5. E2B artifact build and sandbox smoke tests;
6. browser E2E for room creation, turns, recovery, and permissions;
7. a feature-flagged rollout with rollback to ordinary chat behavior.

The current artifact contract is stricter: runner or sandbox-runtime changes require a new pinned artifact and E2B verification, as described in [Code Agent Sandbox Artifact](code-agent-sandbox-artifact.md).

## Historical Phases

- Phase 0 established boundaries and adaptation points.
- Phase 1 defined the JSONL contract and fake runner.
- Phase 2 added types, migrations, and persistence.
- Phase 3 implemented sandbox lifecycle management.
- Phase 4 connected the Code Agent `ask_ai` path.
- Phase 5 introduced the workspace-oriented UI.
- Phase 6 packaged the real runner and sandbox image.
- Phase 7 covered gradual rollout, observation, and rollback.

These phases are complete as an architectural line, although the production system continued to add backends and control surfaces afterward.

## Decisions That Still Apply

- Keep file/process isolation even when the backend changes.
- Keep RoomTalk's control-plane responsibilities separate from the agent engine.
- Use a protocol boundary instead of importing an agent loop into the server.
- Treat room history, execution state, and workspace state as recoverable durable facts.
- Version and verify the sandbox artifact independently from the Fly application image.
- Prefer source-owned event sequencing over timestamp-based reconstruction.

For current module ownership, recovery behavior, and configuration, continue with the [runtime architecture](code-agent-runtime-architecture.md), [sandbox daemon](sandbox-daemon-plan.md), and [configuration reference](configuration.md).
