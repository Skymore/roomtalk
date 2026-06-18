# PostgreSQL Rollout Runbook

## Goal

Move durable room data from Redis to PostgreSQL while keeping Redis available for Socket.IO scaling, realtime session state, online membership, and short TTL message cache.

Redis-only mode remains the rollback path. Do not delete Redis room/message data until PostgreSQL mode has been verified in production.

## Required Inputs

- `REDIS_URL`: existing production Redis URL.
- `DATABASE_URL`: PostgreSQL database URL.
- `POSTGRES_SSL=true` for managed PostgreSQL providers that require TLS.
- `POSTGRES_SSL_REJECT_UNAUTHORIZED=true` by default. Set `false` only for intentionally self-signed TLS.
- Optional managed-provider CA: `POSTGRES_SSL_CA_BASE64` preferred, or `POSTGRES_SSL_CA`.

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
- `failures` is empty. If not empty, inspect and fix before continuing.

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

- Rooms are upserted.
- Message history is replaced per room, so repeated runs do not duplicate messages.
- AI cost totals are set to the exact Redis total, not incremented.

```bash
cd server
REDIS_URL="redis://..." DATABASE_URL="postgres://..." npm run migrate:redis-to-postgres
```

Expected checks:

- `roomsWritten` equals `roomsRead` unless failures were reported.
- `messagesWritten` equals `messagesRead`.
- `failures` is empty.
- If the command is run a second time, the same counts should appear without duplicate messages or increased cost totals.

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

Rollback is configuration-only as long as Redis data has not been deleted:

```bash
fly secrets set PERSISTENCE_STORE="redis"
```

Then restart/redeploy if the platform does not restart automatically.

After rollback:

- Confirm `/api/status` reports `persistenceStore: "redis"`.
- Confirm existing rooms and messages load from Redis.
- Keep PostgreSQL data for analysis; do not truncate it during incident response.

## Cleanup Window

Only consider Redis durable-data cleanup after:

- PostgreSQL mode has been stable through at least one normal production traffic window.
- Migration statistics and `/api/status` room counts have been reconciled.
- A rollback decision has been explicitly closed.

Even after cleanup, Redis is still required for Socket.IO adapter state and realtime room membership.
