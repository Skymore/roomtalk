# Personal Agent: Codex-first implementation plan

[中文](personal-agent-implementation-plan.zh.md)

Status: Independent UI and OpenMuse memory library deployed; production validation complete
Updated: 2026-10-06

## Scope

Add a dedicated personal-agent entry to RoomTalk, with one agent per signed-in account. Follow Muse's persistent main conversation, topic conversations, avatar status, goals and activity log. Use `codex-app-server` and reuse E2B execution, turns, queues and files. Personal agents always use full access without model, permission or tool-approval controls.

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

Add Personal Agent to desktop and mobile navigation. Show the agent avatar, name, current work and main conversation. Provide conversations, goals, activity and memory/settings surfaces. Use a dedicated PersonalAgentConversation without CodeAgentRoomView or ordinary room navigation. Show bubbles, brief progress, attachments and result links; stopping preserves the draft, and follow the existing `StatusMessage` feedback style. Every visible action must connect to real persistence or execution.

## Delivery checklist

- [x] Append migrations; add profile/goal persistence and atomic schedule claims.
- [x] Add personal APIs and close ordinary room access leaks.
- [x] Integrate personal Codex context, background scheduling and completion notifications.
- [x] Implement desktop/mobile conversations, goals, activity and editable memory.
- [x] Complete the chosen authentication path and verify a real Codex turn.
- [x] Run relevant authorization, persistence, scheduling and session tests, client tests and both builds.
- [x] Verify main/topic conversations, memory, goals, reload recovery and privacy through real UI.
- [x] Push to `origin/master`, confirm production checkout state and deploy.
- [x] Verify local/public readiness, deployed navigation and real Codex sandbox memory read/write.

## Release constraints

Append migrations without changing historical checksums. This release extends the sandbox's `roomtalk memory` tool, so it requires the runner version and E2B artifact workflow in `CLAUDE.md`, matching production pins, and a real sandbox memory-tool check.

Validation includes a second account accessing a personal room ID, concurrent scheduler claims, persisted dispatch recovery, timezone/DST behavior and continued execution after leaving the page. Mock-runner tests cannot prove real Codex functionality.

Deploy with `node scripts/local-production.mjs --profile edge up -d --build`. Report source push, Compose deployment, E2B artifact state and public smoke separately.

## 2026-10-05 first-release validation

- Both production builds passed, together with relevant authorization, persistence, scheduler, session and client tests.
- Five disposable PostgreSQL tests passed for concurrent main-room creation, memory CAS, atomic schedule claims, durable queue admission and rollback.
- 83 Python runner/broker/CLI/app-server/daemon/ACP tests passed.
- E2B artifact `roomtalk-code-agent-2026-10-05-personal-memory-v1` was built and published; runner version `0.1.55`.
- 101 focused client unit tests, affected ESLint and both production builds passed. The isolated release branch also passed both builds.
- Chrome Playwright passed 2/2: memory persistence/reload, private main/topic conversations, goal pause/edit/resume, leaving and reloading while a goal runs, reopening completed results, another account receiving metadata 404/messages 403 and stale private-room cache removal.
- Browser end-to-end tests used real PostgreSQL/Redis with a fake Codex runner. Real model functionality was verified separately in production below.
- Feature source published to `origin/master`: `6816032f`. Production was built from original checkout `54dd1e73`, preserving its two existing local presence changes; those changes were not included in this feature's remote publication.
- Deployed using `node scripts/local-production.mjs --profile edge up -d --build`; production image `sha256:962b9f835b0f904ca304caec42661d61b0b7ac1ac5d2c6fb64d042e025707a7b`. Migration `0032_personal_agents` was applied with a recorded checksum.
- App, AI Worker, PostgreSQL, Redis, object storage and both Tunnel services are healthy. Loopback, `https://room.ruit.me` and `https://ai-chat.wenlin.dev` `/api/status` returned HTTP 200 and `ready: true`; a public browser confirmed personal navigation and guest sign-in guidance.
- Production template/artifact pins are `roomtalk-code-agent-2026-10-05-personal-memory-v1`; the engine source pin remains `0b5e44eb29ad1bec89b2143737f6917aafa79359`.
- An existing Codex subscription connection completed a real `codex-app-server` turn. Sandbox `roomtalk memory get/set`, read-back and PostgreSQL memory agreed; the turn and final message were `complete`. After lease release, the temporary goal/task/sandbox were removed and the probe memory was removed with CAS, preserving unrelated content.
- Completion push tests verify multi-device fan-out and owner isolation. Physical-device notification display was not tested in this release.

## 2026-10-06 independent UI and OpenMuse memory library

The [official Muse design screenshots](https://introducing.muse.ai/) and these source snapshots were inspected:

- [CopilotKit/OpenMuse, 73a7149](https://github.com/CopilotKit/openmuse/tree/73a714963b57e5cd1747fd3fbc6833e09a36b81a): explicitly supplied or confirmed preferences, separate owner-scoped entries, provenance and time.
- [diggerhq/OpenMuse, 2fff664](https://github.com/diggerhq/openmuse/blob/2fff664dac90f8d24b67b754912485106660c034/scripts/templates/memory.ts): cross-topic profile preferences and topic briefs, decisions, sources, completed and unfinished work, with versioned saves.

Migration `0033_personal_agent_memory_library` adds PostgreSQL preference/fact/topic entries with conversation/turn provenance and timestamps. Users search, page, correct, forget and revisit source conversations. Existing about-the-user notes are preserved; profile and entry edits check the last read timestamp.

Every turn loads current preferences and matching excerpts; full entries are retrieved on demand. Keyword search supports Chinese without an embedding API key; vector semantic retrieval is not claimed. Normal Codex turns remember confirmed lasting facts and compact topic decisions/next steps, search before updating, reread conflicts and report success only after persistence. Forgotten facts are not reconstructed from older transcripts without another user request.

`roomtalk memory list/search/save/forget` uses the current private turn broker and active execution lease. The server supplies provenance. Runner version is `0.1.56`; the matching E2B artifact is `roomtalk-code-agent-2026-10-06-personal-memory-library-v1`.

### Revision validation and deployment

- Full server tests passed 1098/1098, client tests 1135/1135 and Python runner tests 84/84. The final focused server suite passed 113/113, with affected ESLint and both production builds passing.
- Chrome Playwright passed 3/3, covering the independent conversation UI, fixed full access, memory creation/search/editing/forgetting, draft preservation after stopping, background goals, reload recovery and account isolation. These tests use real PostgreSQL/Redis with a fake Codex runner and now run in CI.
- Feature source `29d38bbe` passed [all CI jobs](https://github.com/Skymore/roomtalk/actions/runs/37405389564). Historical-migration seed fixtures now match the current repository while seeding; concurrent event tests use the actual committed event ID instead of assuming which request wins.
- The E2B artifact was rebuilt and published, and production pins updated. Append-only migration `0033_personal_agent_memory_library` was applied, including full access for existing personal rooms.
- Production was built from `4f3d7109`, retaining its two existing local presence changes. Image: `sha256:137459045effc0bc418b49ee180874843718621e03d90b4ce6c4bab39e4fdd6d`. App, AI Worker, PostgreSQL, Redis, object storage and both Tunnel services are healthy; loopback and both public `/api/status` endpoints returned HTTP 200 and `ready: true`.
- Four real sandbox turns using an existing Codex subscription verified remembering a topic with provenance, retrieving its value in a new conversation without supplying that value in the prompt, correcting the same entry without duplicates, and forgetting it. All turns completed and tool results matched PostgreSQL. After execution leases were released, temporary goals, conversations, sandboxes and probe memories were removed, preserving existing profile data.


## OpenMuse module sequence

Finish and verify one releasable module per iteration. Keep RoomTalk account ownership, PostgreSQL, durable turns and its executor; do not import OpenMuse's gateway or managed-thread dependencies. Structured memory and the independent conversation UI are the existing foundation.

| Order | Module | Existing foundation and next work |
| --- | --- | --- |
| 1 | Conversation management | Complete: stable main conversation, side chats, search, rename, archive and restore |
| 2 | Conversational goals and background tasks | Complete: shared scheduling, chat tools, milestones, actual execution status, cancellation and outcome completion; verified with real Codex |
| 3 | Memory organization | Complete: topic handoff, duplicate-title checks, reviewed merge, retained provenance and conversation binding; verified with real Codex |
| 4 | Rich results | Persistent plan, document and web cards with previews, downloads and cross-conversation retrieval implemented; production verification in progress |
| 5 | Browser and takeover | Present browsing and takeover in the personal UI using the existing execution environment |
| 6 | Suggestions and tracking | Source-backed suggestions with accept/dismiss, condition checks, deduplicated changes and notification preferences |

### Module 1: conversation management

Reference: [OpenMuse side-chat management](https://github.com/CopilotKit/openmuse/blob/73a714963b57e5cd1747fd3fbc6833e09a36b81a/apps/mobile/src/threads.tsx), with a stable main conversation, renaming, archiving and restoring. `PersonalAgentChats` owns the conversation panel, search and per-conversation rename and archive/restore buttons without workspace controls.

Append-only migration `0034_personal_agent_conversation_archive` persists archive metadata. Only the authenticated owner's side chats can be changed; the main conversation cannot be archived or renamed through this endpoint. Archiving preserves messages, sandbox execution and shared memory, and does not cancel goal schedules. Activity still shows background work; memory sources and original room links remain usable. Restore keeps the room ID. Durable events capture the archive after-image without rewriting old events, and runtime status updates preserve archive metadata.

Validation: server API, real PostgreSQL, historical migrations, event contracts and repository tests passed 120/120; focused client tests passed 11/11, with both production builds, i18n checks and affected ESLint passing. The complete Personal Agent Chrome Playwright flow passed: rename, search, archive, reload, restore, reopen the same transcript, and finish a running goal after archiving it. Another account receives 404 on mutation. Release verification is recorded separately. This module does not change runner tools or sandbox inputs, so the existing verified E2B artifact is retained.


### Module 2, first stage: shared goal saving and explicit schedules

Following [OpenMuse's durable goal service](https://github.com/CopilotKit/openmuse/blob/73a714963b57e5cd1747fd3fbc6833e09a36b81a/apps/server/src/engine/service.ts), goal forms now use a shared save service that the conversation tools will also call. The independent `PersonalAgentGoals` panel supports an explicit weekly weekday and a one-time execution date. Form edits send the revision they read, so another conversation's newer changes cannot be overwritten.

Append migration `0035_personal_agent_goal_schedules`. Existing weekly goals retain their original local creation weekday. One-time admission clears the next execution time in the same transaction that creates the private task room and saves its queued prompt. Restarting or repeating a scheduled claim cannot admit it twice. Task titles and prompts come from the goal read inside that transaction. A stale edit cannot recreate a deleted goal. Scheduled creation requires an explicit timezone; one-time dates are absolute instants with offsets.

Validation: 27 server tests passed across API, save service, DST scheduling, durable admission and actual PostgreSQL, including weekly migration, one-time admission/restart/repeated claims, and stale edits after deletion. Eleven client tests, both production builds, i18n and focused ESLint passed. Chrome created Friday and one-time schedules through the real form, reloaded them, and completed the existing private chat, memory, task execution and account-isolation flow. Conversation tools and execution-status controls remain subsequent work within module 2.


### Module 2, second stage: conversation tools, milestones and execution status

Following OpenMuse's distinction between outcomes, milestones and separate background executions, `roomtalk goal list/create/update/run/pause/resume/cancel/delete` now accesses the shared goal service through the current turn's private broker. Edits require the saved revision. Ordinary rooms, other owners, ended turns and read-only modes cannot write. The prompt requires confirmed schedule timezones, reading related goals first, evidence for progress, and no recursively running the same goal from its own execution conversation.

Append migration `0036_personal_agent_goal_progress` for milestones and outcome completion. Execution status comes from durable queued inputs, turns and actual leases; a successful occurrence does not automatically complete the outcome. Repeated manual admission reuses outstanding work. Cancellation pauses future occurrences and requests real queue/runner cancellation, while the UI distinguishes the request from actual stopping. Deletion preserves conversations and captures the changed room event. The independent goal panel offers milestone progress, complete/reopen, view work and cancel work. Direct weekday buttons fix the dropdown failing to open inside a long form.

Validation: 28 goal API/service/real PostgreSQL tests; 114 session/context/schedule regressions; 12 focused client tests; 27 Python broker/CLI tests; both builds, i18n and affected ESLint passed. The complete Chrome flow passed weekly/one-time scheduling, milestones, completed reload/reopen, background cancellation, mobile width and account isolation. Chrome uses real PostgreSQL/Redis and a simulated runner; actual Codex and release verification are recorded separately. Runner 0.1.57 and E2B `roomtalk-code-agent-2026-10-06-personal-goals-v1` are built and published.

Release verification: the existing Codex subscription completed five real tool turns and two background executions. Cross-conversation creation, modification/pause, run, outcome confirmation, reopening, cancellation and deletion matched PostgreSQL. The cancelled turn actually reached `cancelled` and released its lease. All seven private execution conversations, temporary goals and sandboxes were cleaned up without changing existing goals or memories. A direct template check confirmed runner 0.1.57 and all goal commands. The initially missed ACP artifact recognition constant was aligned; 21 backend/configuration tests passed.


### Module 3: topic handoff and memory organization

Following [OpenMuse document-based topic memory](https://github.com/diggerhq/openmuse/blob/2fff664dac90f8d24b67b754912485106660c034/scripts/templates/memory.ts), continuing a topic creates a private conversation bound to the same memory document. Each turn reads its complete current background, confirmed decisions, sources, verified work and next steps, rather than copying a truncated excerpt. Migration `0037_personal_agent_topic_handoff` persists bindings and provenance in PostgreSQL. Historical room events remain immutable; new events capture committed binding changes.

Normalized same-kind titles reject duplicate additions and return the existing entry for review. Users or the current conversation review full documents when reconciling related or conflicting information; newer timestamps do not establish truth. The independent memory panel supports selection, original-document review and merge. `roomtalk memory merge` uses the same service. A single transaction checks every source revision, retains one ID and all provenance, rebinds existing conversations and removes duplicates. Concurrent changes return a conflict while preserving the editor draft. Forgetting unbinds the document and stops future prompt injection.

Validation: 139 server/API/real PostgreSQL/event/runner-configuration tests; 99 repository and historical-migration tests; 13 focused client tests; 28 Python CLI/broker tests; both builds, i18n and affected ESLint passed. Chrome passed topic handoff, duplicate titles, concurrent-edit conflict, reviewed merging, source retention, conversation rebinding, reload, mobile width and forgetting. Runner 0.1.58 and E2B `roomtalk-code-agent-2026-10-06-personal-topics-v1` are published. Direct template verification and all five CI jobs passed. Actual Codex release verification is recorded separately.

Release verification: the direct template check confirmed runner 0.1.58 and memory merge. Production App, AI Worker and dependencies are healthy, with loopback and both public readiness endpoints passing. The existing Codex subscription completed five actual turns: saving a full sourced topic; reading handoff content beyond 500 characters in a new conversation without searching; merging a user-confirmed correction while retaining sources; reading the current document from the rebound original conversation; and forgetting/unbinding it. PostgreSQL and actual tool execution agree. Temporary goals, conversations, sandboxes and memories were removed. All five CI jobs passed for code commit `76472a99`. Production image `sha256:a12ae066bb1f83999d5c8290b7cd5a582e0273294625f8d76083c1d0d5cf7ff6` preserves the pre-existing local presence work.


### Module 4: persistent result cards

Following [OpenMuse chat result cards](https://github.com/CopilotKit/openmuse/blob/73a714963b57e5cd1747fd3fbc6833e09a36b81a/apps/mobile/src/thread-artifacts.tsx), cards hydrate through durable IDs. Migration `0038_personal_agent_results` stores actual room/turn provenance, titles, summaries, filenames and private object keys. Messages do not retain signed download URLs. Files use the existing object storage independently of sandbox lifetime. Replay reads cards by room/turn, and opening reauthorizes access to the actual persisted file.

`roomtalk result save/list/get` supports creation and cross-conversation reuse. Saving requires the owner's private writable active turn; insertion also checks the actual room/turn lease in PostgreSQL. A retrieved file can be revised and saved as a new result. Plans use Markdown. Document previews support Markdown, text, PDF and images, while other formats download for their native applications. Single-file HTML runs in an opaque frame and can be downloaded. Consumer cards contain only a title, short summary, open and download actions. Text is limited to 512 KiB and any file to 4 MiB. Archiving preserves results; clearing source history or deleting its conversation removes associated records and files.

Validation: 260 server/API/repository/real PostgreSQL/session/event tests; 14 client tests; 30 Python CLI/broker tests; both builds, i18n and affected ESLint passed. Chrome saved and replayed all three kinds, read a plan, downloaded matching actual PDF bytes, interacted with a web result, checked mobile layout, and rejected saves after turn completion. Chrome uses actual PostgreSQL/object storage and a simulated runner; actual Codex and production release verification are recorded separately. Runner 0.1.59 and E2B `roomtalk-code-agent-2026-10-06-personal-results-v1` are published, with direct result-command checks passing.
