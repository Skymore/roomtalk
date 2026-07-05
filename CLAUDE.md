# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

RoomTalk — a real-time chat application with AI assistants, media sharing, stickers, and room management. Two packages in one repo: a React client (`client-heroui/`) and a Node.js server (`server/`).

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

# Persistence smoke test (uses local Redis DB 15, never prod)
cd server && npm run smoke:persistence
cd server && TEST_DATABASE_URL="postgres://localhost/message_system_test" npm run smoke:persistence
```

## Architecture

### Persistence: Dual-Store Pattern

The server uses a `CompositeRoomStore` (`server/src/repositories/store.ts`) that combines:

- **DurableRoomStore** — either `RedisStore` or `PostgresStore`, selected by `PERSISTENCE_STORE` env var (`redis` default, or `postgres`). Owns rooms, messages, members, media assets, auth, push subscriptions.
- **RealtimeRoomStore** — always Redis. Manages online presence, socket sessions, ephemeral member counts.
- **RoomMessageCacheStore** (optional) — Redis TTL cache in front of PostgreSQL reads, invalidated on writes.

The `CompositeRoomStore` delegates every method to the right sub-store and handles cache invalidation automatically. When adding new store operations, add the method to the `DurableRoomStore` interface, implement in both `RedisStore` and `PostgresStore`, then proxy through `CompositeRoomStore`.

### Socket Event Handlers

Socket handlers are split by domain in `server/src/socket/`:
- `roomHandlers.ts` — create/join/leave rooms, member management, room settings
- `messageHandlers.ts` — send/edit/delete messages, message history, reactions
- `aiHandlers.ts` — AI streaming (`ask_ai`), model selection, role drafts
- `transcriptionHandlers.ts` — audio transcription via AssemblyAI

All registered in `registerSocketHandlers.ts`, sharing a `SocketHandlerDeps` context.

### Server Services

- `aiModels.ts` — model registry, normalization, model options from env
- `aiClients.ts` — OpenRouter/direct API client factory
- `aiStreamRecovery.ts` — marks interrupted streaming messages as failed on startup
- `mediaObjectStorage.ts` — S3-compatible object storage (Tigris in prod), presigned URLs
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

Upload: client requests presigned URL → uploads to S3/Tigris or local media storage → confirms to server → server creates a `MediaAsset` record. Download: server generates signed read URLs on demand. Legacy base64 image cleanup is available through `npm run migrate:media-to-object-storage`; it defaults to dry-run and requires `--execute` plus a verified backup file before uploading objects or updating PostgreSQL.

### AI Streaming

Client sends `ask_ai` socket event with role/model/context. Server selects the configured provider client (DeepSeek, Anthropic, OpenAI, or OpenRouter), streams chunks as `ai_chunk`, and ends with `ai_stream_end`. Messages have `status: 'streaming' | 'complete' | 'error'`. On server restart, `aiStreamRecovery` marks orphaned streaming messages as failed.

## Deployment

Push to `master` triggers CI (`.github/workflows/fly-deploy.yml`): builds server + client, checks translations, verifies Fly secrets, deploys to Fly.io. Never run `fly deploy` manually.

Production: Fly.io app `message-system` in `dfw` region, Node 22 Alpine, 512MB VM. PostgreSQL on Supabase, Redis on Upstash, media on Tigris (S3-compatible).

### Code Agent / E2B Artifact Rule

Production code-agent rooms run from a pinned E2B sandbox artifact, not directly from the deployed Node app source or a local code-agent engine checkout. Any change to `server/roomtalk_code_agent_runner`, runner tools, runner system prompts, the sandbox Dockerfile, or files copied by `scripts/code-agent/prepare-sandbox-context.mjs` must bump `ops/code-agent-sandbox/artifact.lock.json` and `ops/code-agent-sandbox/Dockerfile`, rebuild the E2B template, update `CODE_AGENT_E2B_TEMPLATE_ID` / `CODE_AGENT_ARTIFACT_VERSION`, and verify with an E2B smoke or direct runner check. Any code-agent engine change in `/Users/sky/projects/code-agent-engine` must first be committed and pushed there, then RoomTalk must update `ops/code-agent-sandbox/artifact.lock.json` `codeAgentEngine.sourceRef` and production `CODE_AGENT_SOURCE_REF`, rebuild the E2B template, and verify it. Otherwise production sandboxes will keep using the old runner or old code-agent engine even after app deploys.

## Coding Conventions

- TypeScript, two-space indent, no semicolons in some newer files (inconsistent — match the file you're editing)
- React components: PascalCase files (`MessageInput.tsx`), functional components, HeroUI + Tailwind
- Hooks: `useThing.ts`
- Tests colocated: `Thing.test.tsx` / `thing.test.ts`
- Client ESLint enforces React hook rules; prefix unused params with `_`
- Commits: short present-tense subjects, prefixed (`fix:`, `stickers:`, etc.)
- Codebase has Chinese comments throughout — this is intentional, keep the language of existing comments when editing nearby code
