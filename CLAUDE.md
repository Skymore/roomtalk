# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

RoomTalk — a real-time AI collaboration platform with shared chat rooms and sandboxed code-agent workspaces. The repo contains a React client (`client-heroui/`), a Node.js control plane (`server/src/`), and a Python JSONL runner/daemon (`server/roomtalk_code_agent_runner/`) packaged into pinned E2B artifacts.

## Development Commands

```bash
# Start everything (builds server, then launches both)
./start.sh

# Server (Express + Socket.IO, port 3012)
cd server && npm run dev          # ts-node-dev hot reload
cd server && npm run build        # tsc → dist/
cd server && npm start            # run compiled dist/src/server.js
cd server && npm test             # Node built-in test runner (src/**/*.test.ts)

# Client (React + Vite, port 3011)
cd client-heroui && npm run dev   # Vite dev server
cd client-heroui && npm run build # i18n check + tsc + vite build
cd client-heroui && npm run lint  # ESLint
cd client-heroui && npm test      # Vitest

# E2E (Playwright)
cd client-heroui && npm run test:e2e
cd client-heroui && npm run test:e2e:postgres   # against PostgreSQL store

# i18n
cd client-heroui && npm run check:i18n          # verify all keys present
cd client-heroui && npm run translate:i18n:dry   # preview auto-translations
cd client-heroui && npm run translate:i18n       # apply auto-translations

# Persistence smoke test (uses disposable PostgreSQL plus local Redis DB 15, never prod)
cd server && TEST_DATABASE_URL="postgres://localhost/message_system_test" npm run smoke:persistence
```

## Architecture

### Persistence: PostgreSQL Durable + Redis Realtime

The server uses a `CompositeRoomStore` (`server/src/repositories/store.ts`) that combines:

- **DurableRoomStore** — `PostgresStore`. Runtime startup requires `PERSISTENCE_STORE=postgres`; it owns rooms, messages, room events, members, media metadata, auth, and push subscriptions. `RedisStore` remains only for legacy migration/contract coverage, not as a serving-mode authority.
- **RealtimeRoomStore** — always Redis. Manages online presence, socket sessions, ephemeral member counts.
- **RoomMessageCacheStore** (optional) — Redis TTL cache in front of PostgreSQL reads, invalidated on writes.

The `CompositeRoomStore` delegates every method to the right sub-store and handles cache invalidation automatically. When adding runtime durable operations, implement PostgreSQL first and proxy through `CompositeRoomStore`; keep the legacy Redis contract aligned only when the migration/import path still needs that operation.

Room synchronization follows these invariants:

- Commit each safe, schema-versioned room-event after-image in the same PostgreSQL transaction as its canonical mutation.
- Treat `LISTEN/NOTIFY` as a hint. Each app coalesces same-room watermarks, reads a committed event range, reauthorizes local room sockets before complete payloads, and emits with `io.local`; incomplete or oversized payloads use one head-only notification.
- Apply only contiguous client prefixes. A per-room `idle/replay/replace/prepend` controller gives recovery priority over pagination. Replay small gaps, snapshot retained gaps above 500 events, and clear stale target/gap watermarks before handling `CURSOR_AHEAD` so a restored database cannot cause an empty-page loop.
- Stop on `EVENT_PAYLOAD_INVALID`; do not advance past a malformed event. Public membership events remain empty `members.changed` signals.
- Do not hydrate old events from current rows, add a realtime delivery outbox, or restore `messageVersion`/`roomVersion`.
- Keep typing, presence, AI chunks, voice, and WebRTC outside the durable sequence. Buffer early AI transient events by `messageId` within the 60-second, 64-ID, 512-event, 512-KiB limits.
- Emit `ai_stream_error` with an explicit `persisted` flag. The normal path persists a complete safe error Message and includes it with `persisted: true`; if terminal persistence fails, use `persisted: false` so the client terminalizes the local placeholder and schedules recovery.
- Keep a message ID bound to its original room. PostgreSQL rejects cross-room upserts; a future move operation must be an explicit source delete plus target upsert.
- Update the canonical message array and React `previous` state separately so transient handlers preserve pending and failed optimistic sends.

Production crossed the immutable `0003`/`0004` boundary on 2026-07-21 with every old app process stopped. Future incompatible event migrations require the same maintenance window or an explicit two-phase protocol.

### Socket Event Handlers

Socket handlers are split by domain in `server/src/socket/`:
- `roomHandlers.ts` — create/join/leave rooms, member management, room settings
- `messageHandlers.ts` — send/edit/delete messages, message history, reactions
- `aiHandlers.ts` — AI streaming (`ask_ai`), model selection, role drafts
- `codeAgentWorkspaceHandlers.ts` — authenticated sandbox snapshots, files/diffs, PTY terminal, preview sessions, and workspace mutations
- `transcriptionHandlers.ts` — audio transcription via AssemblyAI

All registered in `registerSocketHandlers.ts`, sharing a `SocketHandlerDeps` context.

### Server Services

- `aiModels.ts` — model registry, normalization, model options from env
- `aiClients.ts` — OpenRouter/direct API client factory
- `aiStreamRecovery.ts` — marks interrupted streaming messages as failed on startup
- `mediaObjectStorage.ts` — S3-compatible object storage (SeaweedFS in current production; Tigris retained for rollback), presigned URLs
- `clientAuth.ts` — password hashing, token-based auth
- `googleAuth.ts` — Google OAuth credential verification
- `pushNotifications.ts` — web-push notifications
- `messageDomain.ts` — message construction helpers, reply references

### Client Structure

Single-page app with one route (`/`). `MessagePage` is the main orchestrator handling room state, socket events, and view switching. Key layers:

- **Views**: `WelcomeView` (room list), `ChatRoomView` (chat), `SettingsView`, `SavedRoomList`
- **Socket**: `utils/socket.ts` — singleton connection, all emit/on wrappers
- **State**: `utils/roomState.ts`, `utils/messageState.ts`, `utils/appPersistence.ts` — localStorage-backed state
- **Hooks**: `useRoomMessageEvents` (message sync), `useAIRoles`, `useStickers`, `useCachedMedia`
- **i18n**: `utils/i18n.ts` + `utils/languages.ts` — en/zh/hi/ja/ko translations, browser language detection

Desktop uses a sidebar layout (`DesktopSidebar`); mobile uses bottom navigation (`BottomNav`). Breakpoint at 768px.

### Media Pipeline

Upload: client requests a presigned URL → uploads to the configured S3-compatible store (SeaweedFS in current production) or explicit local development storage → confirms to the server → the server creates a `MediaAsset` record. Download: the server generates signed read URLs on demand. Legacy base64 image cleanup is available through `npm run migrate:media-to-object-storage`; it defaults to dry-run and requires `--execute` plus a verified backup file before uploading objects or updating PostgreSQL.

### AI Streaming

Client sends `ask_ai` with role, model, and context. The server selects the configured provider client (DeepSeek, Anthropic, OpenAI, or OpenRouter) and streams transient `ai_chunk` events after the durable placeholder exists. A successful run persists the final Message before `ai_stream_end`. A failed run persists the complete error Message before `ai_stream_error`, which carries the same Message as a fast path. Messages have `status: 'streaming' | 'complete' | 'error'`. On server restart, `aiStreamRecovery` marks orphaned streaming messages as failed.

### Code-Agent Runtime

Code-agent rooms are a separate request path from ordinary chat. RoomTalk is the control plane; untrusted files, commands, terminals, and agent backends run in one room-scoped E2B sandbox.

- `codeAgentSessionService.ts` validates room access/mode/backend, acquires and renews fenced room execution leases, materializes queued inputs at turn boundaries, persists durable turns, issues scoped credentials, streams ordered runner events, handles queue/steer/interrupt/approval controls, and saves backend session IDs.
- `codeAgentSandboxLifecycle.ts` creates or reconnects sandboxes, applies active/idle TTLs, recovers stale states, and migrates workspaces across pinned artifact upgrades.
- `codeAgentDaemonRegistry.ts` serializes one reusable JSONL daemon per sandbox and reclaims daemons on shutdown; bounded thread-query/release waits recycle unhealthy daemon handles.
- `codeAgentRoomContext.ts` + `codeAgentRoomContextRoutes.ts` expose bounded room history/search/message/site reads through a turn-scoped sandbox broker and `roomtalk` CLI.
- `codeAgentModelGateway.ts` proxies only the selected provider/model with turn-scoped tokens, budgets, and usage accounting; provider keys never reach the browser.
- `codexConnection.ts` + `codexConnectionRoutes.ts` let room owners connect a Codex subscription through device authorization; RoomTalk encrypts the auth material and injects the room owner's connection as a per-run sandbox secret for authorized room members. Coco remains the in-house CLI coding agent/engine.
- `githubConnection.ts` + `githubConnectionRoutes.ts` validate and encrypt GitHub PATs per RoomTalk client; code-agent rooms resolve the current room owner's PAT and inject token/Git-config secret files only for authorized room turns so `gh` and HTTPS Git work without exposing the PAT in prompts.
- `publishedStaticSite.ts` stores room-owned versioned static artifacts in local/S3-compatible object storage and serves stable `/p/:slug/` URLs.
- `e2bCodeAgentSandboxService.ts` owns workspace files, Git changes/diffs/refs, PTY sessions, preview targets, archive migration, and sandbox SDK operations.

The browser workspace includes files/search/editing, asset previews, Git diff/review comments, a streamed PTY terminal, dev-server/browser previews, and published artifacts. Every workspace read/mutation/session rechecks the room's owner/admin/member access policy and applies bounded path, payload, and runtime-session limits. The current architecture and ownership boundaries are documented in `docs/code-agent-runtime-architecture.md`.

## Deployment

`master` is the release branch. Production at [https://room.ruit.me/](https://room.ruit.me/) runs the root multi-stage image on the local MacBook through Docker Compose and Cloudflare Tunnel. PostgreSQL 17 owns durable state and the bounded room-event log, Redis 7 is rebuildable realtime/cache state, SeaweedFS 4.29 provides the S3-compatible object boundary, and E2B provides per-room execution sandboxes. `roomtalk.ruit.me` remains a compatibility hostname and `roomtalk-objects.ruit.me` carries presigned browser object transfers.

A source push does not deploy production. Runtime changes are applied from the production checkout with `node scripts/local-production.mjs --profile edge up -d --build`, which loads secrets from the macOS Keychain; verify Compose health plus loopback/public `/api/status`. Documentation-only changes do not require a rebuild. The former scheduled Fly workflow is manually disabled and the Fly app is suspended; Supabase, Tigris, and Upstash remain rollback sources only. Current production selects `CODE_AGENT_RUNNER_CLIENT=daemon`, `CODE_AGENT_BACKEND=codex-app-server`, a two-minute idle sandbox TTL, and a one-hour active TTL.

### Code Agent / E2B Artifact Rule

Production code-agent rooms run from a pinned E2B sandbox artifact, not directly from the deployed Node app source or a local code-agent engine checkout. Any change to `server/roomtalk_code_agent_runner`, runner tools, runner system prompts, the sandbox Dockerfile, dependency locks, or files copied by `scripts/code-agent/prepare-sandbox-context.mjs` must bump the runner package version when applicable, `ops/code-agent-sandbox/artifact.lock.json`, and the artifact metadata in `ops/code-agent-sandbox/Dockerfile`; rebuild/publish the E2B template; update `CODE_AGENT_E2B_TEMPLATE_ID` / `CODE_AGENT_ARTIFACT_VERSION`; and verify with an E2B smoke or direct runner check. Any code-agent engine change in `/Users/sky/projects/code-agent-engine` must first be committed and pushed there, then RoomTalk must update `ops/code-agent-sandbox/artifact.lock.json` `codeAgentEngine.sourceRef` and production `CODE_AGENT_SOURCE_REF`, rebuild the E2B template, and verify it. Otherwise production sandboxes will keep using the old runner or old code-agent engine even after app deploys.

### Codex Backend Direction

`codex-app-server` is the supported Codex backend and the target for all new features, fixes, protocol work, and production behavior. The `codex` backend and `roomtalk_code_agent_runner.codex_cli` are deprecated legacy compatibility paths. Keep them only while existing data or explicit migration work still requires them; do not add new product capabilities, UI behavior, or architecture to the Codex CLI path. Shared code must follow app-server semantics and must not reintroduce CLI-era constraints such as a client-wide turn lock.

### Task Completion, Validation, and Push Rule

Choose validation from the actual diff, affected behavior, and blast radius. Do not mechanically run every test suite or both production builds for every task. Before validating, classify the change and select checks that can catch its plausible failures:

- Documentation, comments, copy-only changes, and other low-risk changes that do not affect runtime or build inputs: run only relevant structural/content checks such as `git diff --check`, parsing, or link validation. Do not run application tests or production builds without a specific risk that they would detect.
- Narrow implementation changes: run the closest focused tests and the affected package's typecheck or build when compilation is a relevant failure mode.
- Shared contracts, persistence, auth/permissions, realtime ordering, cross-package APIs, dependencies/configuration, or broad frontend/backend changes: expand validation to the relevant suites and affected production builds. Run both production builds only when both sides can be affected or the release risk justifies it.
- E2E, external-service smoke tests, and E2B artifact rebuilds: run them when behavior crosses those boundaries or when the artifact rule below requires them.

Use engineering judgment rather than change size alone: a one-line auth or schema change can require broad validation, while a larger documentation edit may require none. In the final report, state which checks ran; when tests or builds were intentionally skipped, briefly state why.

After completing and appropriately validating a task, commit the work and push it directly to `origin/master`; when working from a detached HEAD, use `git push origin HEAD:master`. Confirm that local `HEAD` and `origin/master` resolve to the same commit. Do not leave completed, validated changes only in the local worktree. Treat source push and production deployment as separate states: deploy the Mac only when runtime/build/configuration scope changed and the task requires release, then verify the real public target.

Before the final push, check whether the change falls under the E2B artifact rule above. If it does, the task is not complete until the E2B template and artifact pins are updated, the new template is built and verified, and production is pointed at the matching E2B version. Finish with all source, lockfile, Dockerfile, and production pin changes committed and pushed to `origin/master`.

## Coding Conventions

- TypeScript, two-space indent, no semicolons in some newer files (inconsistent — match the file you're editing)
- React components: PascalCase files (`MessageInput.tsx`), functional components, HeroUI + Tailwind
- Hooks: `useThing.ts`
- Tests colocated: `Thing.test.tsx` / `thing.test.ts`
- Client ESLint enforces React hook rules; prefix unused params with `_`
- Commits: short present-tense subjects, prefixed (`fix:`, `stickers:`, etc.)
- Codebase has Chinese comments throughout — this is intentional, keep the language of existing comments when editing nearby code
