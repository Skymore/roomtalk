# Code Agent App-Server Integration Progress

[中文](code-agent-app-server-integration-progress.zh.md)

Status: Important implementation progress record; current behavior is defined by the runtime architecture
Reviewed: 2026-07-12

## Goal

Add Codex app-server as a backend beside the in-house Coco agent and the legacy Codex CLI adapter while keeping one RoomTalk session/runner contract. Backend-specific behavior should live behind adapters instead of leaking into room, persistence, queue, permission, and workspace code.

## Design Constraints

- RoomTalk remains the control plane and E2B remains the execution plane.
- Backend selection is per room/turn and survives retry/recovery.
- User Codex subscription auth is encrypted at rest and injected only for that user's run.
- The app-server backend shares ordered text/tool/status/usage event semantics with Coco.
- Workspace, room context, model gateway, publishing, queue/steer/interrupt, and access control remain backend-independent.
- No client-wide turn lock or other deprecated CLI-era constraint may be reintroduced.

## Commit Plan and Progress

1. Generalize runner request/backend naming without breaking Coco.
2. Add app-server protocol/client adapter and normalize events.
3. Connect encrypted Codex subscription auth and versioned refresh persistence.
4. Persist/reuse backend session or thread identifiers.
5. Route room-selected backend through the common session scheduler.
6. Extend daemon dispatch and query/control behavior.
7. Add focused service/protocol tests and a real artifact/E2B smoke.

By 2026-07-04, the app-server backend was wired through the shared request, daemon, session, auth-refresh, and event boundaries. Later production direction made `codex-app-server` the supported Codex backend and retained the CLI adapter only for migration/compatibility.

## Evidence Used

The design was grounded in the Codex app-server protocol and local integration behavior: request/session lifecycle, structured item events, approvals, interrupt, thread continuation/query, model/reasoning settings, image input, and auth refresh. RoomTalk maps those backend events into its own durable turn/message model instead of exposing raw protocol objects to the browser.

## Validation

- Protocol serialization and chunk parsing.
- App-server event mapping into RoomTalk text/tool/final/error shapes.
- Session-service routing while Coco remains the default or another room selects Codex.
- Encrypted auth injection, refresh, unchanged-auth detection, and stale concurrent write protection.
- Queue, steer, interrupt, approval, image input, context/publish capability, usage, and ordered transcript boundaries.
- Real E2B template/app-server smoke after artifact pins match source.

## Risks and Lessons

- A backend adapter can appear functional while still losing item ordering or usage details.
- Thread continuation must not become the authoritative room-history source.
- Auth refresh requires lease/version semantics because multiple turns may use one user connection.
- Source integration is incomplete until the pinned E2B artifact contains the same runner/backend dependencies.
- Shared abstractions must follow app-server semantics rather than preserve accidental CLI limitations.
