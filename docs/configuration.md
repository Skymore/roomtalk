# RoomTalk Configuration Reference

[中文](configuration.zh.md)

Status: Current
Updated: 2026-07-21
Source of truth: `server/.env.example`, `.env.compose.example`, `compose.yaml`, runtime config loaders, and `scripts/local-production.mjs`

This document groups operator-facing configuration. Test-only variables and turn-scoped `ROOMTALK_*` variables injected into sandboxes are intentionally omitted.

## HTTP and Browser Origins

| Variable | Purpose | Notes |
| --- | --- | --- |
| `PORT` | Server listen port | Default/local port is `3012`. |
| `NODE_ENV` | Runtime mode | Production enables fail-closed origin and artifact checks. |
| `CLIENT_URL` | Primary browser origin | Also used by some public callback defaults. |
| `CLIENT_URLS` | Comma-separated browser-origin allowlist | Use for deployments with multiple accepted browser origins. |

The client is a Vite application. Only values safe to expose publicly may use a `VITE_*` prefix.

## Storage

| Variable | Purpose |
| --- | --- |
| `REDIS_URL` | Required Redis connection for rebuildable realtime and cache state. |
| `PERSISTENCE_STORE` | Must be `postgres`; other values fail startup. |
| `DATABASE_URL` | Required PostgreSQL durable-store URL. |
| `MIGRATION_DATABASE_URL` | Optional owner/DDL URL used only by `migrate:schema`; defaults to `DATABASE_URL` for local Compose. |
| `POSTGRES_SSL` | Enables PostgreSQL TLS. |
| `POSTGRES_SSL_REJECT_UNAUTHORIZED` | Keeps certificate validation enabled by default. |
| `POSTGRES_SSL_CA_BASE64` / `POSTGRES_SSL_CA` | Optional managed-provider CA. Prefer base64 in secret managers. |
| `ROOM_MESSAGES_CACHE_TTL_SECONDS` | Redis recent-message cache TTL in PostgreSQL mode; `0` disables writes. |
| `ROOM_MESSAGES_CACHE_MAX_BYTES` | Maximum serialized cache payload. |
| `ROOM_EVENT_RETENTION_DAYS` | Retained age of the bounded per-room replay log; default `7`. |
| `ROOM_EVENT_MAX_PER_ROOM` | Maximum retained events per room; default `10000`. |
| `ROOM_EVENT_PRUNE_INTERVAL_MS` | Event-prefix pruning interval; default `3600000` (one hour). |
| `ROOM_EVENT_FAST_PATH_MAX_BYTES` | Maximum serialized committed RoomEvent included in a Socket notification; default `262144`. Oversized events fall back to a head-only hint. |
| `ROOMTALK_INSTANCE_LEASE_TTL_MS` | Redis/PostgreSQL runtime-owner lease duration; default `30000`. Expired owners become eligible for presence/task recovery. |
| `ROOMTALK_INSTANCE_HEARTBEAT_MS` | Runtime-owner heartbeat interval; default `10000` and clamped below half the lease TTL. |
| `ROOMTALK_RECOVERY_INTERVAL_MS` | Singleton expired-owner/turn/sandbox reconciliation interval; default `5000`. |
| `ROOMTALK_INSTANCE_ID` | Optional explicit per-process identity. It must be unique for every simultaneously running replica; normally leave it unset so RoomTalk derives a unique process identity. |
| `AI_STREAM_OWNER_ID` | Optional deployment namespace for AI stream owners. The runtime instance identity is still included, so replicas do not share one owner lease. |

The only supported serving model is PostgreSQL durable state plus Redis realtime/cache state. Redis remains operationally required but may be flushed and rebuilt; it is not a durable fallback. The legacy Redis store exists only for import and contract coverage.

`room_event_streams` and `room_events` are the client synchronization boundary. A canonical mutation and its safe `schemaVersion: 1` after-image commit together. `NOTIFY` is only a hint: each app skips rooms without local sockets, reads the exact immutable event, batch-reauthorizes local subscribers, and emits with `io.local`. Authorization unavailability produces a head-only hint without evicting sockets. A client applies payloads only when contiguous and otherwise replays from `lastAppliedSeq`; individually oversized events and retained gaps above 500 events switch to a repeatable-read snapshot. Deleted streams return their terminal tombstone directly. Runtime instance heartbeats scope Redis presence cleanup, Code Agent recovery respects fenced leases, AI terminal writes use in-process retry plus PostgreSQL owner leases, and named advisory locks serialize recovery/retention maintenance across replicas. The log remains bounded and is not Event Sourcing or an AI job queue. `outbox_events` remains a separate claim/retry mechanism for one worker; transient Socket events do not consume room sequence numbers.

Production applied immutable-event migrations `0003` and `0004` on 2026-07-21 in a maintenance window with all old app processes stopped.

## Media and Artifacts

| Variable | Purpose |
| --- | --- |
| `MEDIA_STORAGE_MODE` | Explicit storage mode. Current production Compose, the retained Fly rollback target, and AWS use `s3`; `local` is a filesystem development/recovery fallback. Explicit `s3` fails startup without a bucket. |
| `MEDIA_BUCKET_NAME` | S3-compatible bucket. |
| `MEDIA_STORAGE_REGION` | Storage region; current SeaweedFS uses `us-east-1`, while Tigris commonly uses `auto`. |
| `MEDIA_STORAGE_ENDPOINT` | S3-compatible endpoint. |
| `MEDIA_STORAGE_PUBLIC_ENDPOINT` | Optional browser-facing S3 endpoint used only when generating presigned URLs; server-side object operations continue to use `MEDIA_STORAGE_ENDPOINT`. |
| `MEDIA_STORAGE_FORCE_PATH_STYLE` | Optional path-style addressing. |
| `MEDIA_STORAGE_CONNECTION_TIMEOUT_MS` | Object-storage connection timeout; defaults to `3000`. |
| `MEDIA_STORAGE_REQUEST_TIMEOUT_MS` | Per-attempt object-storage request timeout; defaults to `15000`. |
| `MEDIA_STORAGE_SOCKET_TIMEOUT_MS` | Object-storage socket inactivity timeout; defaults to `10000`. |
| `MEDIA_STORAGE_MAX_ATTEMPTS` | Maximum object-storage attempts, including the initial request; defaults to `2`. |
| `MEDIA_STORAGE_SLOW_REQUEST_MS` | Log object-storage operations slower than this threshold; defaults to `2000`. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Storage credentials. |
| `LOCAL_MEDIA_DIR` | Filesystem root for explicit/local-development media storage. |
| `LOCAL_MEDIA_SIGNING_SECRET` | Optional dedicated HMAC key for expiring local-media URLs. Production local mode may derive it from a 16+ character `POSTGRES_PASSWORD` when omitted. |
| `DISABLE_LOCAL_MEDIA_STORAGE` | Disables the implicit development fallback; conflicts with explicit `local` mode. |
| `CODE_AGENT_STATIC_PUBLISH_PUBLIC_URL` | Public static-publish base fallback. |
| `CODE_AGENT_STATIC_PUBLISH_TOKEN_SECRET` | Signs room/client/turn/mode-scoped publish tokens. |
| `CODE_AGENT_STATIC_PUBLISH_TOKEN_TTL_SECONDS` | Publish-token lifetime. |

Private media and published static-site files share the object-storage abstraction but use separate authorization and object layouts. Current production Compose points `s3` at the bundled SeaweedFS service with path-style addressing; the retained Fly rollback target points it at Tigris, and AWS maps it to S3.

## Chat AI and Optional Services

| Group | Variables |
| --- | --- |
| Model selection/context | `AI_MODEL`, `AI_MAX_CONTEXT_MESSAGES`, `AI_MAX_CONTEXT_TOKENS` |
| OpenRouter | `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `OPENROUTER_HTTP_REFERER`, `OPENROUTER_APP_NAME` |
| DeepSeek | `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` |
| Anthropic | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MAX_TOKENS` |
| OpenAI-compatible | `OPENAI_API_KEY`, `OPENAI_BASE_URL` |
| Transcription | `ASSEMBLYAI_API_KEY` |
| Google sign-in | `GOOGLE_CLIENT_ID`, optional `GOOGLE_CLIENT_IDS` |
| Web Push | `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_SUBJECT` |

Provider keys remain server-side. They are never forwarded to the browser or copied wholesale into a sandbox.

## Code-Agent Runtime

Core selection:

| Variable | Purpose |
| --- | --- |
| `CODE_AGENT_ENABLED` | Enables code-agent product entry points. |
| `CODE_AGENT_ALLOWED_USER_IDS` | Optional rollout allowlist. |
| `CODE_AGENT_ALLOWED_RUN_MODES` / `CODE_AGENT_DEFAULT_MODE` | Available and default Plan/Ask/Auto/Full modes. |
| `CODE_AGENT_SANDBOX_PROVIDER` | Production uses `e2b`. |
| `CODE_AGENT_RUNNER_CLIENT` | Production uses the reusable `daemon`. |
| `CODE_AGENT_BACKEND` | Default backend; production uses `codex-app-server`. |
| `CODE_AGENT_DAEMON_COMMAND` | Optional daemon command override. |

Pinned artifact and E2B:

| Variable | Purpose |
| --- | --- |
| `E2B_API_KEY` / `E2B_ACCESS_TOKEN` | E2B credential. |
| `E2B_TEAM_ID` | Optional E2B team. |
| `CODE_AGENT_E2B_TEMPLATE_ID` | Pinned production template. |
| `CODE_AGENT_ARTIFACT_VERSION` | Expected artifact version. |
| `CODE_AGENT_SOURCE_REF` | Expected code-agent-engine source ref. |
| `CODE_AGENT_ARTIFACT_MODE` | Pinned production or explicit development mode. |
| `CODE_AGENT_E2B_AUTO_RESUME` / `CODE_AGENT_E2B_ON_TIMEOUT` | Pause/resume lifecycle. |
| `CODE_AGENT_IDLE_SANDBOX_TTL_MS` / `CODE_AGENT_ACTIVE_SANDBOX_TTL_MS` | Idle and running-turn sandbox TTLs. |
| `CODE_AGENT_SANDBOX_TTL_MS` | Legacy fallback for the idle TTL. |

Scoped capabilities:

| Variable group | Purpose |
| --- | --- |
| `CODE_AGENT_MODEL_GATEWAY_*` | Turn-scoped model proxy, body limits, budgets, and signing. |
| `CODE_AGENT_ROOM_CONTEXT_*` | Read-only room history/search token and lifetime. |
| `CODE_AGENT_WORKSPACE_ASSET_*` | Signed workspace asset access. |
| `CODE_AGENT_STATIC_PUBLISH_*` | Scoped durable static publishing. |

## User-Owned Codex and GitHub Connections

| Variable | Purpose |
| --- | --- |
| `CODEX_CONNECTIONS_ENABLED` | Enables Codex subscription connection routes. |
| `CODEX_AUTH_ENCRYPTION_KEY` | Encrypts stored Codex auth. |
| `CODEX_AUTH_LOGIN_TIMEOUT_MS` | Device-auth session timeout. |
| `CODEX_AUTH_REFRESH_LOCK_TTL_MS` / `CODEX_AUTH_REFRESH_WAIT_MS` | Refresh serialization. |
| `GITHUB_CONNECTIONS_ENABLED` | Enables GitHub PAT connection routes. |
| `GITHUB_AUTH_ENCRYPTION_KEY` | Encrypts stored GitHub tokens; may be independently rotated. |

Do not add new product behavior to the deprecated Codex CLI path. `codex-app-server` is the supported backend.

## Workers and Observability

`OUTBOX_WORKER_ENABLED` selects the durable AI-run outbox path. `OUTBOX_WORKER_BATCH_SIZE` defaults to `1`: the executor is serial and only the task currently executing renews its lease, so pre-claiming a larger batch could let queued claims expire and be executed twice. Future concurrency must renew every claimed item from claim time. Poll interval, lock duration, retry delay, and maximum attempts use the remaining `OUTBOX_WORKER_*` variables. `LOG_FILE_ENABLED` controls optional file logging; production logs should remain structured and secret-safe.

## PostgreSQL Schema Lifecycle

- `npm run migrate:schema` is the only supported schema writer. The compiled container command is `npm run migrate:schema:compiled`.
- Compose runs the one-shot `migrate` service before `app`; Kubernetes/AWS should map it to a pre-deploy Job rather than an App init path.
- `schema_migrations` records every immutable migration with a SHA-256 checksum. A missing or changed migration fails the deployment.
- `POSTGRES_SCHEMA_SQL` is the frozen `0000` bootstrap. Add later changes as new `POSTGRES_MIGRATIONS` entries; never edit an applied entry.
- App startup calls read-only `verifySchema()` and refuses readiness when the migration job was skipped.

## Production Configuration Rules

- The production Mac stores the application environment as a JSON object in the macOS Keychain item `roomtalk-production-env`; `scripts/local-production.mjs` writes a mode-`0600` temporary env file only for the Compose invocation and removes it afterward.
- Keep non-secret Compose interpolation in ignored `.env.compose`; never commit real PostgreSQL, S3, provider, OAuth, E2B, Codex, or GitHub credentials.
- Keep `server/.env` ignored and local.
- Production E2B must use matching template, artifact version, source ref, runner dependencies, and smoke evidence.
- Apply application/configuration changes with `node scripts/local-production.mjs --profile edge up -d --build`. This runs the migration job before replacing the App; then verify Compose health and both the loopback and public `/api/status` endpoints.
- Use `/api/health/live` only for process liveness. `/api/health/ready` and `/api/status` verify PostgreSQL schema reads, Redis `PING`, object-storage bucket access, and the Socket adapter; they return `503 degraded` with `rooms: null` when a dependency is unavailable.
- `local-production.mjs` automatically verifies all five production services after detached startup and reports host/Docker disk use. `ROOMTALK_MIN_HOST_FREE_GB`, `ROOMTALK_DOCKER_RAW_WARN_GB`, `ROOMTALK_DOCKER_RAW_PATH`, and `ROOMTALK_PUBLIC_STATUS_URL` tune that local operator check.
- The former Fly GitHub Actions workflow is manually disabled. It is rollback history, not the current deployment owner.
