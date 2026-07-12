# PostgreSQL Rollout Runbook

[中文](postgres-rollout-runbook.zh.md)

Status: Current runbook
Verified against `master` and `https://room.ruit.me/api/status`: 2026-07-12

Current production status: `PERSISTENCE_STORE=postgres`; Redis remains connected for Socket.IO, realtime membership/session state, pub/sub, model-gateway counters, and the bounded recent-message cache.

## Supported Storage Models

RoomTalk supports two deployment models, not three:

| `PERSISTENCE_STORE` | Durable source of truth | Realtime coordination/cache | Shorthand |
| --- | --- | --- | --- |
| `redis` | Redis | Redis | `R` |
| `postgres` | PostgreSQL | Redis | `R+P` |

There is no supported PostgreSQL-only (`P`) model: Socket.IO scaling, presence, socket sessions, pub/sub, counters, and the bounded recent-message cache still require Redis.

## Goal

`migrate:redis-to-postgres` performs the one-way durable-data bootstrap from `R` to `R+P`. It migrates the current Redis durable model:

- rooms, full message histories, members, saves, password hashes, AI-cost totals;
- Code Agent turns and media metadata;
- pending media uploads, audio transcriptions, assistant runs, and outbox events;
- push subscriptions, client accounts/links, passwords, auth tokens, and nicknames;
- Codex and GitHub connection records.

It intentionally does not copy realtime/cache state: presence, socket sessions, Socket.IO pub/sub, recent-message cache entries, idempotency indexes, expiry indexes, or live Code Agent room leases/fence counters. Those records are rebuilt or reacquired after cutover. Codex auth-refresh lease fields are cleared while copying the durable connection record.

This is a cutover tool, not a general Redis backup/restore utility or a reverse `R+P` to `R` synchronizer.

## Required Inputs

- `REDIS_URL`: existing production Redis URL.
- `DATABASE_URL`: PostgreSQL database URL.
- `POSTGRES_SSL=true` for managed PostgreSQL providers that require TLS.
- `POSTGRES_SSL_REJECT_UNAUTHORIZED=true` by default. Set `false` only for intentionally self-signed TLS.
- Optional managed-provider CA: `POSTGRES_SSL_CA_BASE64` preferred, or `POSTGRES_SSL_CA`.
- A dedicated non-superuser application role. `npm run provision:postgres-app-user` can create/update it and grant the current RoomTalk tables and sequences when run with an administrative `DATABASE_URL` plus `APP_DATABASE_USER` / `APP_DATABASE_PASSWORD`.

## Preflight

1. Confirm the current deployment is healthy:
   ```bash
   curl https://your-app.example.com/api/status
   ```
2. Confirm Redis is reachable from the migration environment:
   ```bash
   redis-cli -u "$REDIS_URL" ping
   ```
3. Confirm the new build has been deployed or can be run locally:
   ```bash
   cd server
   npm run build
   npm test
   ```

## Dry Run

Dry-run reads Redis and prints migration statistics. It must not initialize or write PostgreSQL.

```bash
cd server
REDIS_URL="redis://..." npm run migrate:redis-to-postgres -- --dry-run
```

Expected checks:

- `roomsRead` matches the expected Redis room count.
- `messagesRead` is plausible for current production traffic.
- room-related counts and every `globalRecordsRead` category match an independent Redis inventory.
- `failures` is empty. If not empty, inspect and fix before continuing.

Dry-run parses every supported durable Redis record and does not initialize PostgreSQL. Invalid JSON or a room save missing its `savedAt` counterpart fails closed instead of fabricating data.

## Migration

The final migration must run during a write freeze or maintenance window. The
script replaces each room's message history in PostgreSQL from the Redis source
of truth; writes accepted after migration but before cutover can be missing from
PostgreSQL. For a no-downtime migration, add a dual-write/outbox path first.

Recommended final-sync sequence for Fly:

1. Announce a maintenance window.
2. Cordon or stop serving machines so users cannot create new Redis writes.
3. Run the migration command below from a trusted migration host.
4. Set `PERSISTENCE_STORE=postgres` and related secrets.
5. Restart/uncordon serving machines and verify.

The migration is idempotent:

- Rooms and related durable records are upserted by their stable keys.
- Message history is replaced per room, so repeated runs do not duplicate messages.
- AI cost totals are set to the exact Redis total, not incremented.
- Auth-token `lastUsedAt` is preserved; live lease ownership is not.

```bash
cd server
REDIS_URL="redis://..." DATABASE_URL="postgres://..." npm run migrate:redis-to-postgres
```

Expected checks:

- `roomsWritten` equals `roomsRead` unless failures were reported.
- `messagesWritten` equals `messagesRead`.
- every room-related and `globalRecordsWritten` count equals its corresponding read count.
- `failures` is empty.
- If the command is run a second time, the same counts should appear without duplicates or increased cost totals.

## Cutover

Set production secrets and restart/redeploy:

```bash
fly secrets set PERSISTENCE_STORE="postgres"
fly secrets set DATABASE_URL="postgres://..."
fly secrets set POSTGRES_SSL="true"
fly secrets set POSTGRES_SSL_CA_BASE64="..."
fly secrets set ROOM_MESSAGES_CACHE_TTL_SECONDS="30"
```

For non-Fly deployments, set the same environment variables in the platform secret manager.

The app initializes additive PostgreSQL schema on startup, but production credentials should use the dedicated application role rather than an owner/superuser account.

## Verification

1. Check status:
   ```bash
   curl https://your-app.example.com/api/status
   ```
   Confirm `persistenceStore` is `postgres` and `rooms` is expected.
2. Open the app and verify:
   - Existing room cards load.
   - Existing message history loads.
   - Sending a text message works.
   - Editing and deleting a message works.
   - AI response creates one streaming placeholder and one final message.
   - Refreshing the page after AI completion preserves the final response.
3. Watch server logs for PostgreSQL connection errors, Redis cache errors, and `ai_persistence_error`.

## Rollback

Configuration-only rollback is safe only inside the frozen cutover window, before PostgreSQL has accepted writes that Redis did not receive. The application does not dual-write durable data after cutover. Once production traffic resumes, switching back to Redis can discard every PostgreSQL-only durable record.

For an immediate cutover failure while writes are still frozen:

```bash
fly secrets set PERSISTENCE_STORE="redis"
```

Then restart/redeploy if the platform does not restart automatically.

After rollback:

- Confirm `/api/status` reports `persistenceStore: "redis"`.
- Confirm existing rooms and messages load from Redis.
- Keep PostgreSQL data for analysis; do not truncate it during incident response.

For a later incident, prefer restoring PostgreSQL or running a separately designed reverse/full migration. Do not flip `PERSISTENCE_STORE=redis` until data divergence has been measured and explicitly accepted.

## Cleanup Window

Only consider legacy Redis durable-data cleanup after:

- PostgreSQL mode has been stable through at least one normal production traffic window.
- Migration statistics and `/api/status` room counts have been reconciled.
- The configuration-only rollback window has been explicitly closed and PostgreSQL backup/restore has become the durable recovery path.

Even after cleanup, Redis is still required for Socket.IO adapter state and realtime room membership.
