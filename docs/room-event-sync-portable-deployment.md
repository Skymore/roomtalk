# Room Event Sync and Portable Deployment

[中文](room-event-sync-portable-deployment.zh.md)

Status: production cutover completed at `room.ruit.me`

Updated: 2026-07-21

## Final decision

RoomTalk uses materialized PostgreSQL state plus a bounded per-room change log:

```text
rooms / room_messages / room_agent_turns  canonical current state
room_event_streams                       headSeq, retention floor, delete readers
room_events                              bounded immutable after-image replay log
outbox_events                            one-worker claim/retry jobs
Redis                                    presence, Socket.IO adapter, short cache only
object storage                           media and off-host backups
```

This is similar to consuming a MySQL binlog in that clients advance a monotonic cursor, but it is deliberately an application protocol rather than a database replication log. Browsers receive stable room/message semantics and never depend on WAL/binlog formats.

It is not full Event Sourcing. Normalized tables remain the source of truth, each retained event is an immutable state-transfer after-image, and old prefixes may be pruned.

## Why this replaces version comparison

The former design could tell a client that its message window was stale, but the repair was another snapshot comparison. The event stream says exactly which committed range is missing and lets the client read only that range.

The runtime protocol now has one durable ordering boundary:

- snapshot: `snapshotSeq`;
- delta request: `afterSeq`;
- client state: `lastAppliedSeq`;
- server range: `minAvailableSeq..headSeq`.

The retired room/message counters are dropped from PostgreSQL and removed from TypeScript/runtime payloads. Room metadata still carries `updatedAt` only for the existing complete-object ack/broadcast guard; it is not a second sync cursor. PostgreSQL stamps it with a row trigger using `clock_timestamp()` and at least one microsecond beyond the previous value, so serialized writes remain strictly monotonic even when an older transaction writes last. `room.updated` also travels through the durable cursor and repairs missed broadcasts.

The old history socket is rejected with `UPGRADE_REQUIRED`; it is not served by a dual-read compatibility layer.

## Database mechanics

Row triggers enqueue room, message, agent-turn, membership, and media changes inside the domain transaction. A deferred writer runs only after all statements in that transaction have assembled the aggregate, so a media event observes both `room_messages` and the subsequently inserted `media_assets`. A room before-delete trigger also captures authorized readers before cascades.

The deferred writer constructs bounded, safe `schemaVersion: 1` after-images, then `append_room_event` locks one stream row, allocates the next sequence, inserts the immutable event, and calls `pg_notify`. Because this happens inside the domain transaction:

- rollback removes both state and event;
- concurrent writers to one room serialize at the stream/room boundary;
- an idempotent request that performs no second write performs no second event;
- clear/truncate/edit-and-ask may produce multiple ordered batched events, which is expected.

`readRoomEvents()` directly decodes stored payloads. It never hydrates an old event from current canonical rows, so editing B cannot rewrite the earlier event that recorded A. Message after-images include stable media IDs and metadata but no internal object key, uploader/stream owner, or expiring signed URL. `room.updated` stores a SafeRoom and never stores `password_hash`.

Implemented event types are:

- `messages.upserted`, `messages.deleted`;
- `agent_turns.upserted`, `agent_turns.deleted`;
- `members.upserted`, `members.deleted`;
- `room.updated`, `room.deleted`.

Typing, presence, `ai_chunk`, voice levels, and WebRTC signalling remain transient. Future durable reaction mutations should add `reactions.upserted` / `reactions.deleted` to the same room sequence; this cutover does not invent a reaction model.

## Snapshot and replay

`get_room_snapshot` uses a repeatable-read transaction and returns a complete room, a bounded recent message/turn window, pagination metadata, and `snapshotSeq`.

`get_room_events` accepts `afterSeq`, count limit, and byte limit. It returns ordered events, `headSeq`, `minAvailableSeq`, and `hasMore`.

- After `NOTIFY`, each app reads the exact immutable committed sequence from PostgreSQL. Socket.IO includes it as `events` when the complete notification is within `ROOM_EVENT_FAST_PATH_MAX_BYTES` (default 256 KiB); otherwise it sends only `headSeq`.
- A client applies the fast path only when it forms the next contiguous prefix and ends at `headSeq`; a successful fast path advances `lastAppliedSeq` without `get_room_events`.
- A cursor behind retention receives `CURSOR_EXPIRED` and resnapshots.
- A browser cursor ahead of a restored database receives `CURSOR_AHEAD` and resnapshots.
- A non-contiguous page is never partially applied.
- After one bounded probe for a possible terminal deletion tombstone, a retained gap above 500 events resnapshots instead of applying/replaying up to 100 default pages; the client then drains only the post-`snapshotSeq` tail.
- IndexedDB v4 stores the message window and `lastAppliedSeq`.
- `beforeMessageId` pagination prepends old history without moving the live cursor.

The fast path changes latency, not the correctness boundary. PostgreSQL fans the hint out to every app listener, and every listener emits only to its own sockets with `io.local`; the Redis adapter does not multiply this durable notification. Clients still ignore already-applied sequences and replay any gap. Exact-event read failure and oversized events automatically fall back to the same durable head-only path.

Because `NOTIFY` is ephemeral, a successful listener re-LISTEN is followed by local `room_sync_required {reason: "postgres_listener_reconnected"}`. Clients keep their rendered window and replay from `lastAppliedSeq`; simultaneous fast-path events remain safe through the same sequence idempotency.

## One-time immutable-event boundary

Migration `0003_room_events_immutable_after_images` takes table locks so no business write can land between replacing the writer and deleting legacy ID-only events. Concurrent app startup is serialized by a transaction-scoped advisory lock and a second migration-record check. The migration preserves every stream `head_seq`, clears nondeterministic history, and sets active `min_available_seq = head_seq + 1`; an old cursor therefore snapshots once and resumes without a sequence reset.

Deleted rooms cannot be snapshotted. For those streams, the migration appends a new V1 `room.deleted` tombstone and preserves `deleted_reader_ids`, with the retention floor pointing at that tombstone. Even a cursor older than the discarded prefix receives this terminal event, and the client allows this single deletion-only sequence jump. This avoids a `CURSOR_EXPIRED` → impossible snapshot loop. There is no permanent dual-format decoder.

## Retention, not periodic merge

There is no merge/compaction back into messages: the normalized state was already changed in the original transaction. The hourly job removes only an old contiguous event prefix and advances `minAvailableSeq`.

Defaults are seven days and at most 10,000 events per room. Operators can override them with `ROOM_EVENT_RETENTION_DAYS`, `ROOM_EVENT_MAX_PER_ROOM`, and `ROOM_EVENT_PRUNE_INTERVAL_MS`; `ROOM_EVENT_FAST_PATH_MAX_BYTES` independently controls the Socket fast-path ceiling. The Compose examples expose all four. Once a deleted room's events age out, its independent stream/auth tombstone is also removed.

## Event log versus AI outbox

These tables have different consumers and must remain separate:

| | `room_events` | `outbox_events` |
| --- | --- | --- |
| Consumer | Every authorized client | One claiming worker |
| Delivery | Repeatable cursor read | Claim, lease, retry |
| Purpose | Reconstruct visible state | Reliably execute a side effect |
| Cleanup | Retained prefix | Processed/failed policy |

For example, a request can commit a user message, its room event, an assistant-run record, and an AI job outbox row together. The worker later commits the final AI message, which creates another room event.

This is why Socket delivery itself has no durable outbox: room data is already recoverable by cursor, and every authorized client is a fan-out reader rather than a competing worker. Retrying Socket notifications would duplicate the log's job. A `messageVersion` is likewise unnecessary because the room sequence already identifies both order and the exact missing range.

## Portable runtime

The same root `Dockerfile` runs on the current Mac production host, the retained Fly rollback target, and later on AWS. Platform differences are environment variables:

| Current Mac production | Retained rollback cloud | AWS target |
| --- | --- | --- |
| app container | Fly Machine | ECS Fargate or EKS |
| PostgreSQL 17 volume | managed PostgreSQL/Supabase | RDS PostgreSQL |
| Redis 7, rebuildable | managed Redis | ElastiCache |
| SeaweedFS 4.29 S3-compatible store | Tigris/S3-compatible | S3 |

Kubernetes is optional. On one MacBook, Compose is the smaller operational surface; Kubernetes does not make one physical host highly available. Portability comes from the image, PostgreSQL schema/dump/WAL contracts, Redis's disposable role, and the S3 boundary. Current production uses SeaweedFS, the rollback deployment uses Tigris, and AWS will use S3 without changing application object keys or APIs.

Local start and backup:

```bash
cp .env.compose.example .env.compose
docker compose --env-file .env.compose up -d --build
docker compose --env-file .env.compose --profile ops run --rm postgres-backup
```

`--env-file` is required so Compose interpolation uses the configured ports and PostgreSQL credentials. Local S3 credentials are injected from macOS Keychain by `scripts/local-production.mjs`; they are not committed. SeaweedFS and its S3 port bind only to the private Compose network and loopback. `MEDIA_STORAGE_ENDPOINT` keeps server traffic on the Compose network while `MEDIA_STORAGE_PUBLIC_ENDPOINT` signs browser uploads/downloads for the edge hostname.

Run `node scripts/backup-local-production.mjs` for a consistent maintenance backup. It briefly stops the edge, app, and object store, then writes a matching PostgreSQL custom archive and SeaweedFS data snapshot before restarting the stack. Local backups are not off-host backups; production still needs encrypted external copies and restore drills.

Long-running Compose services use bounded JSON log rotation (10 MB per file, five files). Database-backed observability, outbox, and turn records remain durable PostgreSQL data; the Docker limit applies only to process stdout/stderr.

## Executed production cutover

A single maintenance-window cutover was completed on 2026-07-20:

1. restored a Supabase `public` dump into an isolated PostgreSQL 17 database and applied current migrations;
2. copied and verified all 2,857 Tigris objects into SeaweedFS, then restored a paired maintenance backup;
3. disabled the scheduled Fly workflow, archived Fly logs, and scaled Fly writers/workers to zero;
4. took the final dump, reran the idempotent S3 copy, and restored the local production database;
5. compared table counts, removed the retired version columns, and initialized 98 event streams;
6. routed `room.ruit.me`, compatibility hostname `roomtalk.ruit.me`, and `roomtalk-objects.ruit.me` through Cloudflare Tunnel;
7. verified TLS, HTTP, Socket.IO/WebSocket, snapshot/delta events, public presigned PUT/GET, and deletion tombstones.

Fly, Supabase, and Tigris remain intact through the rollback window. After local writes open, DNS-only rollback is unsafe: new local data must first be reconciled back to the cloud target.

Implementation evidence is recorded in [the progress ledger](room-event-sync-portable-deployment-progress.md). The detailed runtime recovery model is in [Room Reliability Architecture](room-reliability-architecture.md).
