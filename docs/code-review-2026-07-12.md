# RoomTalk Code Review — 2026-07-12

[中文](code-review-2026-07-12.zh.md)

Status: Dated review report
Reviewed: 2026-07-12

## Scope

This review covers the current `master` implementation at `5c961ce2`, organized by runtime boundary rather than commit history:

- `server/src/socket`: room, message, Workspace, terminal, and preview socket handlers
- `server/src/services`: Code Agent sessions, daemon queries, E2B workspace operations, and room lifecycle
- `server/src/repositories`: Redis and PostgreSQL persistence semantics
- `server/roomtalk_code_agent_runner`: packaged Python runner and daemon
- `client-heroui/src`: Workspace preview, Markdown rendering, socket state, and bundle boundaries
- package manifests and production dependency trees

The initial review ran the server, client, and Python test suites, both production builds, frontend lint, and production dependency audits. The implementation work below is intentionally validated together after every issue is fixed so cross-module behavior is tested from one final tree.

## Confirmed issues and commit boundaries

| ID | Priority | Module | Issue | Intended fix boundary |
| --- | --- | --- | --- | --- |
| RT-REV-001 | P0 | Workspace preview | Same-origin HTML preview combines `allow-scripts` and `allow-same-origin`, allowing previewed workspace code to reach the parent application and browser credentials. | Move executable previews onto an isolated origin boundary and remove same-origin iframe capability. |
| RT-REV-002 | P1 | Workspace authorization | File, terminal, and preview socket operations check room membership but bypass the room's `owner` / `admin` / `member` Code Agent policy. | Route every Workspace operation through the canonical Code Agent room policy and add role-matrix coverage. |
| RT-REV-003 | P1 | Agent concurrency | Per-room active-turn exclusion is process-local, so horizontally scaled instances can run overlapping turns in one sandbox. | Add a durable room lease with expiration and fencing, shared by direct starts and queued-message claims. |
| RT-REV-004 | P1 | Room deletion | Sandbox and published-site cleanup happens before durable room deletion, so cleanup or store failures can leave a live room with resources already destroyed. | Introduce a durable deletion boundary and idempotent post-commit cleanup semantics. |
| RT-REV-005 | P2 | Workspace sessions | Terminal and preview state has no per-room capacity or idle lifecycle; closed terminal snapshots retain large output tails indefinitely. | Add bounded session/history limits, delete closed sessions, and clean room-scoped runtime state. |
| RT-REV-006 | P2 | Socket payloads | Socket.IO accepts payloads up to 25 MB while messages, identity fields, and A2UI actions lack matching domain limits or bounded structure. | Add shared payload schemas, size/depth limits, and rejection tests. |
| RT-REV-007 | P2 | Daemon queries | Thread queries have no deadline; a hung app-server query can permanently occupy the daemon connection. | Add query deadlines and recycle the daemon after a timeout. |
| RT-REV-008 | P2 | E2B workspace mutations | Reads enforce canonical workspace containment, but write/create/rename/delete only perform lexical path normalization and may traverse an outbound symlink. | Enforce canonical parent/target containment for every mutation and add symlink regression coverage. |
| RT-REV-009 | P3 | Workspace preview UI | iframe load and error callbacks are registered both through React props and native listeners, producing duplicate state/reporting events. | Keep one event subscription path and cover one callback per navigation. |
| RT-REV-010 | P3 | Markdown rendering | Preprocessing removes legitimate horizontal rules and Setext heading underlines. | Stop deleting separator lines and rely on the Markdown parser. |
| RT-REV-011 | P1 | Dependencies | The production dependency trees contain critical/high advisories, including server multipart/HTTP/socket packages and client router/socket packages. | Upgrade within compatible ranges first, then apply reviewed major migrations where required; keep both lockfiles auditable. |

Each issue above is implemented as one commit so it can be reviewed, reverted, or cherry-picked independently. Tests that belong to an issue are included in the same issue commit.

## Refactoring follow-ups

The following structural improvements are valuable but should not be mixed into the security and correctness fixes above unless a fix naturally extracts the boundary:

1. Split `codeAgentWorkspaceHandlers.ts` into authorization, file, terminal, and preview controllers.
2. Split Redis and PostgreSQL stores into room, message, membership, media, and agent-turn repositories backed by shared contract tests.
3. Split `CodeAgentFileBrowserPanel.tsx`, `MessageInput.tsx`, and `utils/socket.ts` into domain controllers and state machines.
4. Move translations into language/namespace resources and lazy-load heavy Markdown, Mermaid, diff, and syntax-highlighting code.
5. Replace repository `null` / `void` error swallowing with explicit operation results at mutation boundaries.

These are tracked as follow-up architecture work because performing large mechanical splits in the same release would make the security fixes harder to audit and increase rollout risk.

## Final validation and release gate

After all issue commits are complete:

1. Run server tests and production build.
2. Run client tests, lint, i18n validation, and production build.
3. Run Python runner tests.
4. Run focused persistence, authorization, preview, terminal, daemon, and workspace-path tests.
5. Re-run production dependency audits and document any advisory that cannot be removed safely.
6. Rebuild and publish the pinned E2B artifact if packaged runner/runtime inputs changed, then run the packaged smoke test.
7. Push the complete commit series to `origin/master`, dispatch the Fly deployment workflow, and verify Fly health plus the production status endpoint.
