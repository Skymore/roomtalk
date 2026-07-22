# Room Event Sync and Portable Deployment

[中文](room-event-sync-portable-deployment.zh.md)

Status: infrastructure and immutable-event production cutovers completed at `room.ruit.me`

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

A message ID is permanently bound to its original `room_id`. A PostgreSQL trigger rejects cross-room conflict updates, preventing the source room from retaining a ghost message when only the target room would otherwise receive an upsert event. `room_events.created_at` is stamped with `clock_timestamp()` when the deferred writer materializes the event, so retention is not skewed by a long transaction's start time.

`readRoomEvents()` directly decodes stored payloads. It never hydrates an old event from current canonical rows, so editing B cannot rewrite the earlier event that recorded A. Every V1 event type has a strict discriminated payload schema: missing, mistyped, or unexpected fields raise `EVENT_PAYLOAD_INVALID` instead of becoming an empty acknowledged event. The client then replaces state from a canonical snapshot and resumes after `snapshotSeq`. Message after-images include stable media IDs and metadata but no internal object key, uploader/stream owner, or expiring signed URL. `room.updated` stores a SafeRoom and never stores `password_hash`.

Implemented event types are:

- `messages.upserted`, `messages.deleted`;
- `agent_turns.upserted`, `agent_turns.deleted`;
- `members.changed`, with an empty payload only;
- `room.updated`, `room.deleted`.

The public stream never contains member IDs, offline-member lists, join timestamps, or owner/admin roles. `members.changed` only invalidates the fact of membership; privileged member projections remain behind the existing `room.manageMembers` authorization and `get_room_role_members` request.

Typing, presence, `ai_chunk`, voice levels, and WebRTC signalling remain transient. Because an AI chunk/A2UI update/stream end can race ahead of its durable placeholder notification, the browser temporarily buffers unmatched AI events by `messageId` and drains them in arrival order when the placeholder appears. The buffer is capped at 64 message IDs, 512 events, 512 KiB, and a 60-second TTL. When the placeholder already exists, the transient reducer updates the canonical projection and the current React state separately, preserving UI-only pending or failed optimistic sends.

`ai_stream_error` is not allowed to invent canonical text. It carries an explicit `persisted` flag. A normal error includes the exact persisted safe Message; if immediate terminal persistence fails, `{ persisted: false }` terminalizes the browser placeholder while an in-process reconciler retries the same terminal after-image with exponential backoff. PostgreSQL owner leases protect live streams and allow another process to recover an orphan only after its owner expires. The local terminal overlay remains until a durable final after-image supersedes it. Future durable reaction mutations should add `reactions.upserted` / `reactions.deleted` to the same room sequence; this cutover does not invent a reaction model.

## Snapshot and replay

`get_room_snapshot` uses a repeatable-read transaction and returns a complete room, a bounded recent message/turn window, pagination metadata, and `snapshotSeq`.

`get_room_events` accepts `afterSeq`, count limit, and byte limit. It returns ordered events, `headSeq`, `minAvailableSeq`, and `hasMore`.

- After `NOTIFY`, each app coalesces same-room watermarks and reads a committed contiguous range. Socket.IO includes it as `events` when the complete notification is within `ROOM_EVENT_FAST_PATH_MAX_BYTES` (default 256 KiB); otherwise it sends only the highest `headSeq`.
- A client applies the fast path only when it forms the next contiguous prefix and ends at `headSeq`; a successful fast path advances `lastAppliedSeq` without `get_room_events`.
- A cursor behind retention receives `CURSOR_EXPIRED` and resnapshots. A deleted stream is the exception: for any `afterSeq < headSeq`, the server returns its final `room.deleted` directly because no canonical snapshot exists.
- A browser cursor ahead of a restored database receives `CURSOR_AHEAD`. It clears the stale target head and gap-snapshot target before requesting the snapshot, while notifications arriving during that request establish a new target. This avoids an infinite empty-page loop against the restored head.
- A strict decoder failure returns `EVENT_PAYLOAD_INVALID`; the client does not advance across that event and resnapshots from canonical state. If the very first event exceeds `maxBytes`, `EVENT_TOO_LARGE` also selects the bounded snapshot path instead of exceeding the requested memory budget.
- A non-contiguous page is never partially applied.
- After one bounded probe for a possible terminal deletion tombstone, a retained gap above 500 events resnapshots instead of paging through the backlog in batches of up to 100 events; the client then drains only the post-`snapshotSeq` tail.
- IndexedDB v4 stores the message window and `lastAppliedSeq`.
- `beforeMessageId` pagination prepends old history without moving the live cursor. Live replay/fast-path mutation invalidates an in-flight prepend, and a missing boundary returns `PAGINATION_BOUNDARY_EXPIRED` so the browser replaces its window.

One per-room state machine owns `idle`, `replay`, `replace`, and `prepend`. Replay/replacement recovery outranks optional pagination, so a prepend cannot invalidate a recovery response and its late response cannot reinsert live-deleted state. If deletion empties a loaded window that still had older history, or the server sends `message_history_invalidated` after truncation, the controller clears the invalid cache and replaces the window rather than persisting an empty projection with a stale boundary. Durable `members.changed`, `room.deleted`, and `ROOM_ACCESS_DENIED` use the same page-level permission/removal paths as transient Socket notifications.

The fast path changes latency, not the correctness boundary. PostgreSQL fans the hint out to every app listener, and every listener emits only to its own sockets with `io.local`; the Redis adapter does not multiply this durable notification. An instance with no local subscribers skips the PostgreSQL payload read. Before a complete payload is emitted, Redis socket identities and PostgreSQL memberships are queried in batches. Explicitly revoked members leave; an unavailable authorization dependency keeps sockets joined and degrades that delivery to head-only. Clients still ignore already-applied sequences and replay any gap. Incomplete range reads and oversized notifications automatically fall back to the same durable head-only path.

Because `NOTIFY` is ephemeral, a failed listener generation is closed and ignored. A successful replacement re-LISTEN is followed by local `room_sync_required {reason: "postgres_listener_reconnected"}`. Clients keep their rendered window and replay from `lastAppliedSeq`; simultaneous fast-path events remain safe through the same sequence idempotency.

## Multi-instance runtime ownership

Rolling app releases require ownership rules beyond room-event delivery. RoomTalk now assigns each process a unique runtime instance ID. Redis stores an instance TTL heartbeat, the socket IDs owned by that instance, and each socket's room/browser presence. Startup never clears global presence. A singleton reconciliation pass removes only records owned by an instance whose heartbeat expired, so starting instance B cannot erase instance A's online users.

The same rule protects work. Code Agent turns and sandboxes are recoverable only when no matching unexpired fenced room lease exists. AI placeholders carry a per-instance stream owner whose PostgreSQL lease is renewed with the runtime heartbeat. If a terminal write fails for several seconds but the process remains alive, the in-process terminal reconciler keeps retrying without a restart. If the process dies, another instance waits for owner expiry before writing the recovery error after-image.

Recovery and retention loops run in every replica but acquire named PostgreSQL advisory locks; one replica performs each pass and the others skip it. The event broadcaster keeps fixed per-room min/max pending state rather than one waiter per notification. Together with the no-local-subscriber short circuit, this bounds both cross-instance reads and burst memory. Tests cover two RedisStore instances sharing one Redis model, live-versus-expired Code Agent and AI leases in PostgreSQL 17, and advisory-lock exclusion.

The lease schema has its own cutover rule. A pre-`0006` App does not heartbeat `ai_stream_owner_leases`, so it cannot safely overlap the first `0006`-aware process: the new process could recover the old process's active placeholder. Stop every old App for the release that introduces `0006`. After every replica speaks the lease protocol, later compatible image releases may roll; changing the lease protocol again requires either another maintenance boundary or a two-phase migration.

## One-time immutable-event boundary

Migration `0003_room_events_immutable_after_images` takes table locks so no business write can land between replacing the writer and deleting legacy ID-only events. Concurrent app startup is serialized by a transaction-scoped advisory lock and a second migration-record check. The migration preserves every stream `head_seq`, clears nondeterministic history, and sets active `min_available_seq = head_seq + 1`; an old cursor therefore snapshots once and resumes without a sequence reset.

Migration `0004_public_member_change_events` repaired databases that had run the pre-production V1 member after-image writer: retained `members.upserted` / `members.deleted` rows were rewritten in place to `members.changed {}`, the public type constraint was tightened, and later member mutations emit only the empty signal. Production applied this one-time privacy repair during the 2026-07-21 maintenance window.

Migration `0005_message_room_immutability_and_event_clock` enforces the message-room invariant and wall-clock event timestamps without changing the V1 payload format.

Migration `0006_ai_stream_owner_leases` adds the PostgreSQL heartbeat/expiry table used for stream-owner takeover. It is additive and does not change the V1 room-event format.

Deleted rooms cannot be snapshotted. For those streams, the migration appends a new V1 `room.deleted` tombstone and preserves `deleted_reader_ids`, with the retention floor pointing at that tombstone. Even a cursor older than the discarded prefix receives this terminal event, and the client allows this single deletion-only sequence jump. This avoids a `CURSOR_EXPIRED` → impossible snapshot loop. There is no permanent dual-format decoder.

## Retention, not periodic merge

There is no merge/compaction back into messages: the normalized state was already changed in the original transaction. The hourly job removes only an old contiguous event prefix and advances `minAvailableSeq`; a named PostgreSQL advisory lock makes it singleton across replicas.

Defaults are seven days and at most 10,000 events per room. Operators can override them with `ROOM_EVENT_RETENTION_DAYS`, `ROOM_EVENT_MAX_PER_ROOM`, and `ROOM_EVENT_PRUNE_INTERVAL_MS`; `ROOM_EVENT_FAST_PATH_MAX_BYTES` independently controls the Socket fast-path ceiling. The Compose examples expose all four. Once a deleted room's events age out, its independent stream/auth tombstone is also removed. The hourly maintenance log reports broadcaster pending/active rooms, coalesced notifications, batch count, fast-path event bytes, head-only fallbacks, no-local-subscriber skips, authorization-unavailable fallbacks, and maximum pending sequence span. Before AWS scale-out, alert on sustained queue span, head-only/auth-unavailable growth, expired-instance cleanup, and lease-recovery counts; also add PostgreSQL table/index size, dead tuples, event bytes per room, and prune duration to the platform dashboard.

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

Health is not one optimistic boolean. `/api/health/live` is a dependency-free process probe. `/api/status` and `/api/health/ready` perform a real RoomTalk table query, Redis `PING`, S3-compatible bucket probe, and Socket adapter check; they return HTTP 503 and `rooms: null` on dependency failure rather than reporting a false empty database. Compose uses readiness for the App container. AWS should map liveness and readiness separately, and alert on host filesystem/Docker disk-image capacity in addition to container state because every durable local service can be running while the Mac has no space left to commit writes.

GitHub CI uses Node 24.18, starts PostgreSQL 17, and always sets `ROOM_EVENT_TEST_DATABASE_URL` for the server suite. Trigger, transaction, lease, advisory-lock, tombstone, byte-boundary, retention-clock, and cross-room message-invariant tests therefore fail the job instead of silently skipping when no database is available.

## Immutable-event production migration

Production crossed the `0003` / `0004` protocol boundary on 2026-07-21. The release created the paired backup `roomtalk-20260721T110310Z.dump` and `roomtalk-object-storage-20260721T110310Z.tar.gz`, stopped `cloudflared` and every old app process, then started only commit `fbfd908b`. Startup logs recorded both migrations before the PostgreSQL listener, Redis adapter, outbox worker, and public edge became ready.

A read-only database check found migrations `0001` through `0004`, no non-V1 retained events, and only authorized `room.deleted` legacy cutover tombstones. A public WebSocket smoke then created a temporary room, observed a committed `messages.upserted` Socket payload, read the same message through snapshot and replay, deleted the room, replayed its terminal tombstone, and cleaned up the room.

Future AWS multi-instance deployment must either use the same maintenance-window boundary or introduce a deliberate two-phase compatible protocol before attempting a rolling release. An old image must not run after a new incompatible payload writer is active, and rollback across that boundary means restoring the matching database and object-storage backup rather than merely restarting an old binary.

## Executed production cutover

The infrastructure and data-host cutover was completed on 2026-07-20:

1. restored a Supabase `public` dump into an isolated PostgreSQL 17 database and applied current migrations;
2. copied and verified all 2,857 Tigris objects into SeaweedFS, then restored a paired maintenance backup;
3. disabled the scheduled Fly workflow, archived Fly logs, and scaled Fly writers/workers to zero;
4. took the final dump, reran the idempotent S3 copy, and restored the local production database;
5. compared table counts, removed the retired version columns, and initialized 98 event streams;
6. routed `room.ruit.me`, compatibility hostname `roomtalk.ruit.me`, and `roomtalk-objects.ruit.me` through Cloudflare Tunnel;
7. verified TLS, HTTP, Socket.IO/WebSocket, snapshot/delta events, public presigned PUT/GET, and deletion tombstones.

The immutable after-image protocol was deployed in the separate 2026-07-21 maintenance window described above. Keeping these dates separate matters: the first cutover moved PostgreSQL and objects onto the Mac; the second changed the retained room-event payload contract.

Fly, Supabase, and Tigris remain intact through the rollback window. After local writes open, DNS-only rollback is unsafe: new local data must first be reconciled back to the cloud target.

Implementation evidence is recorded in [the progress ledger](room-event-sync-portable-deployment-progress.md). The detailed runtime recovery model is in [Room Reliability Architecture](room-reliability-architecture.md).
