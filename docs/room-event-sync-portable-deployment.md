# Room Event Sync and Portable Deployment

[中文](room-event-sync-portable-deployment.zh.md)

Status: implemented locally; production data/DNS cutover not performed

Updated: 2026-07-20

## Final decision

RoomTalk uses materialized PostgreSQL state plus a bounded per-room change log:

```text
rooms / room_messages / room_agent_turns  canonical current state
room_event_streams                       headSeq, retention floor, delete readers
room_events                              bounded replay log
outbox_events                            one-worker claim/retry jobs
Redis                                    presence, Socket.IO adapter, short cache only
object storage                           media and off-host backups
```

This is similar to consuming a MySQL binlog in that clients advance a monotonic cursor, but it is deliberately an application protocol rather than a database replication log. Browsers receive stable room/message semantics and never depend on WAL/binlog formats.

It is not full event sourcing. Normalized tables remain the source of truth, and the change log may be pruned.

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

PostgreSQL statement transition-table triggers capture message and agent-turn inserts, updates, and deletes. Room inserts/updates are captured as room events; a row-level before-delete trigger records authorized readers and writes the deletion tombstone before cascades.

`append_room_event` locks one stream row by updating it, allocates the next sequence, inserts the event, and calls `pg_notify`. Because triggers execute inside the domain transaction:

- rollback removes both state and event;
- concurrent writers to one room serialize at the stream/room boundary;
- an idempotent request that performs no second write performs no second event;
- clear/truncate/edit-and-ask may produce multiple ordered batched events, which is expected.

Stored event payloads contain bounded IDs. The delta read hydrates upserts from current canonical rows, so this is a state-transfer changelog rather than a historical audit trail.

Implemented event types are:

- `messages.upserted`, `messages.deleted`;
- `agent_turns.upserted`, `agent_turns.deleted`;
- `room.updated`, `room.deleted`.

## Snapshot and replay

`get_room_snapshot` uses a repeatable-read transaction and returns a complete room, a bounded recent message/turn window, pagination metadata, and `snapshotSeq`.

`get_room_events` accepts `afterSeq`, count limit, and byte limit. It returns ordered events, `headSeq`, `minAvailableSeq`, and `hasMore`.

- A cursor behind retention receives `CURSOR_EXPIRED` and resnapshots.
- A browser cursor ahead of a restored database receives `CURSOR_AHEAD` and resnapshots.
- A non-contiguous page is never partially applied.
- IndexedDB v4 stores the message window and `lastAppliedSeq`.
- `beforeMessageId` pagination prepends old history without moving the live cursor.

PostgreSQL `NOTIFY` and Socket.IO only wake readers. Every app instance may emit duplicate wake-ups through the Redis adapter; clients treat them as idempotent hints and read durable events.

## Retention, not periodic merge

There is no merge/compaction back into messages: the normalized state was already changed in the original transaction. The hourly job removes only an old contiguous event prefix and advances `minAvailableSeq`.

Defaults are seven days and at most 10,000 events per room. Once a deleted room's events age out, its independent stream/auth tombstone is also removed.

## Event log versus AI outbox

These tables have different consumers and must remain separate:

| | `room_events` | `outbox_events` |
| --- | --- | --- |
| Consumer | Every authorized client | One claiming worker |
| Delivery | Repeatable cursor read | Claim, lease, retry |
| Purpose | Reconstruct visible state | Reliably execute a side effect |
| Cleanup | Retained prefix | Processed/failed policy |

For example, a request can commit a user message, its room event, an assistant-run record, and an AI job outbox row together. The worker later commits the final AI message, which creates another room event.

## Portable runtime

The same root `Dockerfile` runs locally, on Fly, and later on AWS. Platform differences are environment variables:

| Local Compose | Current cloud | AWS target |
| --- | --- | --- |
| app container | Fly Machine | ECS Fargate or EKS |
| PostgreSQL 17 volume | managed PostgreSQL/Supabase | RDS PostgreSQL |
| Redis 7, rebuildable | managed Redis | ElastiCache |
| persistent local media volume | Tigris/S3-compatible | S3 |

Kubernetes is optional. On one MacBook, Compose is the smaller operational surface; Kubernetes does not make one physical host highly available. Portability comes from the image, PostgreSQL schema/dump/WAL contracts, Redis's disposable role, and the media-storage boundary. Compose selects the persistent filesystem implementation explicitly; Fly/AWS select S3-compatible storage with environment variables.

Local start and backup:

```bash
cp .env.compose.example .env.compose
docker compose --env-file .env.compose up -d --build
docker compose --env-file .env.compose --profile ops run --rm postgres-backup
```

`--env-file` is required so Compose interpolation uses the configured ports and PostgreSQL credentials. The backup job writes a PostgreSQL custom archive and a matching local-media tarball. PostgreSQL and Redis maintenance ports bind to loopback only. Named volumes and the local `backups/` directory are not off-host backups; production needs encrypted external copies and restore drills.

Production-style local media URLs are HMAC-signed over method, object key, and expiry. Unsigned, expired, cross-method, or tampered URLs are rejected. `LOCAL_MEDIA_SIGNING_SECRET` is preferred; Compose can derive a separate signing key from a sufficiently long local PostgreSQL password when it is omitted.

## Direct production cutover boundary

A one-window cutover is technically possible, but “direct” must still include a rehearsal:

1. restore a current production dump into an isolated local database;
2. run schema migration plus full PostgreSQL integration/Playwright tests;
3. stop cloud writes and workers;
4. create and verify the final custom-format dump;
5. restore locally, migrate, compare counts/invariants, and smoke the temporary origin;
6. switch the Cloudflare/DNS route, then reopen writes;
7. retain the cloud database read-only until the rollback window closes.

After local writes open, DNS-only rollback is unsafe: new local data must first be reconciled back to the cloud target.

Implementation evidence is recorded in [the progress ledger](room-event-sync-portable-deployment-progress.md). The detailed runtime recovery model is in [Room Reliability Architecture](room-reliability-architecture.md).
