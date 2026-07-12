# PostgreSQL Migration Engineering Retrospective

[中文](postgres-migration-development-summary.zh.md)

Status: Important historical engineering retrospective
Reviewed: 2026-07-12

The counts, machine sizes, and room/message/cost scope below describe the original production cutover, not the current operating contract. Since 2026-07-12, `migrate:redis-to-postgres` has become a full `R` to `R+P` durable-data bootstrap covering current room, auth/account, media/AI/outbox, and Codex/GitHub connection records. Use the [current rollout runbook](postgres-rollout-runbook.md) for operations.

## Goal and Production Strategy

RoomTalk originally stored rooms, message history, and AI cost data only in Redis. The migration introduced PostgreSQL as the durable source of truth while keeping Redis for realtime/session/cache responsibilities.

The actual production cutover used a final maintenance window:

1. support Redis and PostgreSQL implementations behind one store contract;
2. provision and test PostgreSQL;
3. dry-run and backfill Redis history;
4. stop serving writes;
5. run the final complete sync;
6. set `PERSISTENCE_STORE=postgres`;
7. start service and verify real rooms, including the largest history.

This was not a true zero-downtime migration. That distinction matters because the migration replaced room message histories from a Redis snapshot and there was no complete dual-write path.

## Architectural Split

- PostgreSQL owns durable facts: rooms, message history/status, cost totals, and later members, auth/accounts, media metadata, AI/outbox records, Code Agent turns/leases, and user connections.
- Redis owns Socket.IO adapter state, socket/client mappings, online members, pub/sub, counters/locks, and a bounded recent-message cache.
- The composite store makes this boundary explicit and invalidates cache only after successful durable mutations.
- In-progress AI work is represented durably by streaming/pending records, not inferred from whether a user is online.

## Implementation Stages

### Shared contract

Socket/API code stopped depending directly on `RedisStore`. Redis and PostgreSQL implemented the same durable behaviors, and the same contract suite ran against both. The composite store routed durable calls and realtime/cache calls to their owners.

### PostgreSQL schema and writes

The first scope added rooms, messages, AI status, and exact cost totals with idempotent startup DDL. Later schema work expanded to the current durable model. Writes commit durable state before cache invalidation and socket broadcast; Redis cache failure cannot roll back PostgreSQL.

### Read cache

Recent message cache entries are guarded by `messageVersion`. On a miss, RoomTalk reads PostgreSQL and only writes the cache if the version is still unchanged. Mutations invalidate after durable success. TTL limits stale-cache duration but is not the consistency mechanism.

### Migration script

The initial script:

- supported dry-run without initializing PostgreSQL;
- upserted rooms;
- replaced complete message history per room;
- set exact cost totals instead of incrementing;
- continued to later rooms while recording per-room failures;
- could be rerun without duplicate messages or inflated cost.

The current script now covers every known durable Redis category and fails closed on malformed durable JSON or missing room-save timestamps.

## Real Production Problems

### Provider response-size limit

A large Redis message list exceeded the managed Redis single-response limit when read with `LRANGE 0 -1`. The migration added an index-by-index `LLEN`/`LINDEX` fallback so one large response was not required. The lesson is that an apparently valid database command can still violate a provider transport limit.

### Memory pressure

The original migration period encountered OOM risk on a 256 MB serving machine and moved the historical deployment to 512 MB. Those numbers are historical; current `fly.toml` declares 1024 MB. The durable lesson is to run heavy conversion/migration work on a dedicated host and size from the largest real record, not average traffic.

### Real largest-room verification

The recorded cutover reconciled 66 rooms, 732 messages, and 66 room-cost totals with no migration failures. A large room (`QLqLVGMgII`) returned roughly 12.5 MB across 117 messages. These numbers are evidence for that event, not current production inventory.

### Race between send and Ask AI

PostgreSQL made an existing client race visible: `Ask AI` could run before the user message durable acknowledgement completed, so history read an empty prompt. The fix made `send_message` acknowledge persistence and had the client wait before `ask_ai`, with timeout/error handling. A slower durable store exposed a protocol ordering bug rather than creating it.

## Cutover Safety

The final migration runs under a write freeze because room-history replacement can overwrite newer PostgreSQL writes if traffic continues. Keeping the original Redis data creates a configuration rollback window only until PostgreSQL accepts unique writes. After traffic resumes, switching back to Redis is lossy.

Backup, source inventory, target counts, largest-record checks, application smoke, logs, and explicit rollback ownership are all part of the migration—not optional operational polish.

## What True Zero Downtime Would Require

A production-grade no-freeze design would use expand-migrate-contract:

1. introduce PostgreSQL schema and idempotent message-level upserts;
2. dual-write through a durable outbox or change log;
3. backfill with high-water marks instead of replacing whole room histories;
4. retry and reconcile failed writes;
5. shadow-read and measure Redis/PostgreSQL mismatches;
6. switch reads gradually;
7. stop Redis durable writes only after divergence is zero and rollback semantics are explicit.

Without these mechanisms, calling a snapshot migration “zero downtime” hides the exact consistency window that operators need to understand.

## Lasting Lessons

- Separate durable and realtime ownership instead of treating two stores as co-equal truth.
- Test both implementations with the same behavioral contract.
- Make write ordering and acknowledgement visible across the client/server boundary.
- Use versions and post-commit invalidation for caches; TTL alone is insufficient.
- Design migration reads for provider and largest-record limits.
- Idempotency is necessary for retry but does not remove the need for a write freeze.
- Rollback is a data-consistency decision, not merely an environment-variable change.
