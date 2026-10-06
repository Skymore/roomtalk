# Personal Agent: Codex-first implementation plan

[中文](personal-agent-implementation-plan.zh.md)

Status: Implemented; release verification in progress
Updated: 2026-10-05

## Scope

Add a dedicated personal-agent entry to RoomTalk, with one agent per signed-in account. Follow Muse's persistent main conversation, topic conversations, avatar status, goals and activity log. Use `codex-app-server` and reuse existing E2B workspaces, turns, approvals, queues, files and artifacts.

Deploy the completed first version to the current local production stack and verify public behavior. This version does not introduce a second gateway, email/payment integrations, a connector marketplace or additional harnesses.

## Authentication

This release reuses the system's existing Codex subscription connections through app-server. It adds no API provider or OAuth application. Execution remains separate from authentication so API support can follow.

OpenAI restricts the older app-server authentication for commercial or hosted services. A hosted subscription product needs the applicable Sign in with ChatGPT qualification. Reusing an existing connection does not establish that qualification; successful technical sign-in does not establish hosted authorization.

- [Codex app-server authentication restrictions](https://learn.chatgpt.com/docs/app-server#auth-endpoints)
- [Sign in with ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source)
- [Muse product design](https://introducing.muse.ai/)

## Behavior and ownership

1. Signed-in users receive a profile and private main conversation, with a name, avatar, preferences and editable memory.
2. Topic conversations and goal runs reuse code-agent rooms with explicit personal ownership and main/task metadata.
3. PostgreSQL owns profiles, memory, goals and schedules. Sandboxes own execution and working files.
4. Room discovery, joins, messages, media, workspace access, subscriptions and context reads enforce ownership. Personal rooms cannot use ordinary sharing, invitations or ownership transfer.
5. Every turn reads current personal context and passes it to Codex without repeating internal context in the transcript.
6. Goals support manual, daily and weekly runs, a local time and timezone, editing, pausing, deletion and immediate execution.
7. Persist execution requests before dispatch. Recover after restarts and prevent multiple app instances from claiming the same scheduled occurrence.
8. Closing the browser does not cancel execution. Activity retains results; completion uses existing account push delivery.

## UI

Add Personal Agent to desktop and mobile navigation. Show the agent avatar, name, current work and main conversation. Provide conversations, goals, activity and memory/settings surfaces. Reuse files and artifact panels, keep developer tools in advanced controls, and follow the existing `StatusMessage` feedback style. Every visible action must connect to real persistence or execution.

## Delivery checklist

- [x] Append migrations; add profile/goal persistence and atomic schedule claims.
- [x] Add personal APIs and close ordinary room access leaks.
- [x] Integrate personal Codex context, background scheduling and completion notifications.
- [x] Implement desktop/mobile conversations, goals, activity and editable memory.
- [ ] Complete the chosen authentication path and verify a real Codex turn.
- [x] Run relevant authorization, persistence, scheduling and session tests, client tests and both builds.
- [ ] Verify main/topic conversations, memory, goals, reload recovery and privacy through real UI.
- [ ] Push to `origin/master`, confirm production checkout state and deploy.
- [ ] Verify local/public readiness, deployed navigation and real Codex sandbox memory read/write.

## Release constraints

Append migrations without changing historical checksums. This release extends the sandbox's `roomtalk memory` tool, so it requires the runner version and E2B artifact workflow in `CLAUDE.md`, matching production pins, and a real sandbox memory-tool check.

Validation includes a second account accessing a personal room ID, concurrent scheduler claims, persisted dispatch recovery, timezone/DST behavior and continued execution after leaving the page. Mock-runner tests cannot prove real Codex functionality.

Deploy with `node scripts/local-production.mjs --profile edge up -d --build`. Report source push, Compose deployment, E2B artifact state and public smoke separately.

## Validation record

- Both production builds passed, together with relevant authorization, persistence, scheduler, session and client tests.
- Five disposable PostgreSQL tests passed for concurrent main-room creation, memory CAS, atomic schedule claims, durable queue admission and rollback.
- 83 Python runner/broker/CLI/app-server/daemon/ACP tests passed.
- E2B artifact `roomtalk-code-agent-2026-10-05-personal-memory-v1` was built and published; runner version `0.1.55`.
- Browser end-to-end verification, production deployment and real Codex memory read/write remain in progress.
