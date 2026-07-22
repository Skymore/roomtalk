# Room Reliability Architecture

[中文](room-reliability-architecture.zh.md)

Status: implemented and deployed at `room.ruit.me`

Updated: 2026-07-21

## One durable synchronization boundary

RoomTalk uses one PostgreSQL-owned sequence per room. The retired room/message version counters are not part of the runtime model.

| Value | Meaning | Lifetime |
| --- | --- | --- |
| `snapshotSeq` | Event head captured with a repeatable-read room snapshot | One snapshot response |
| `afterSeq` | Last durable room event requested by the client | One delta request |
| `lastAppliedSeq` | Last contiguous event reduced into the local window | Memory and IndexedDB v4 |
| `headSeq` | Current committed stream head | PostgreSQL |
| `minAvailableSeq` | First retained event | PostgreSQL |
| `sessionEpoch`, `messageSyncRequestId` | Browser control tokens, not data versions | Current tab/session |

Room metadata acknowledgements and broadcasts still use the canonical complete `Room` plus `updatedAt` for last-write-wins. This timestamp is not another synchronization version: a PostgreSQL row trigger makes it strictly monotonic for serialized room writes, including a transaction that starts earlier but writes later. The room snapshot and `room.updated` stream event feed that same commit path, so a missed broadcast is recoverable.

## Source-of-truth layers

```text
rooms / room_messages / room_agent_turns / room_members / media_assets
  canonical materialized state
          │ same PostgreSQL transaction; deferred writer builds safe after-images
          ▼
room_event_streams + room_events
  bounded immutable schemaVersion=1 replay window
          │ commit-time NOTIFY hint; every app reads exact seq
          ▼
each app's Socket.IO local adapter
  io.local event fast path or head-only hint
          │
          ▼
client reducer + IndexedDB v4 cursor/window
```

Redis holds presence, the Socket.IO adapter, and a short-lived recent-message cache. It is not a durable business-data store. PostgreSQL is mandatory at server startup.

## Snapshot and replay

On a cold room open, or after a reset, `get_room_snapshot` reads the room, bounded recent messages, relevant agent turns, and event head in one repeatable-read transaction. The returned boundary is `snapshotSeq`.

If an IndexedDB/memory window already exists, the client paints it immediately. A `room_event_available` notification normally includes the exact committed immutable event. When its event list ends at `headSeq` and starts exactly at `lastAppliedSeq + 1`, the reducer applies it and advances without another request. Missing, oversized, duplicate, or non-contiguous payloads remain safe because `headSeq` still drives `get_room_events(afterSeq=lastAppliedSeq)`.

Small gaps use pages of 100 events and 256 KiB by default. After one bounded delta probe (needed to recognize a terminal deleted-room tombstone), a retained gap above 500 events loads a new repeatable-read snapshot without applying the intermediate page, then drains only events committed after `snapshotSeq`. Older history remains independently lazy through `beforeMessageId`.

The reducer accepts only a contiguous prefix:

- `seq <= lastAppliedSeq`: duplicate, ignore;
- `seq === lastAppliedSeq + 1`: apply and advance;
- a gap: discard the page and load a new bounded snapshot;
- a retained terminal `room.deleted` tombstone may jump a pruned prefix, because deletion supersedes intermediate state and the room has no snapshot to load;
- a retained gap over 500 events: skip page-by-page replay and load a new bounded snapshot;
- `CURSOR_EXPIRED`: retained history is gone, load a snapshot;
- `CURSOR_AHEAD`: the database was restored behind the browser cache. Clear the old `desiredHeadSeq`, load a snapshot, and retain only new notifications received while that request is in flight. This prevents an old high-water mark from causing repeated empty-page reads after the database head moves backward.

Older chat history still uses `beforeMessageId`. Prepending an old page never moves the live event cursor. A live replay or contiguous Socket fast path immediately invalidates an in-flight prepend token, so a late historical response cannot reinsert a message that was just deleted. If the boundary message disappears before PostgreSQL serves the page, `PAGINATION_BOUNDARY_EXPIRED` starts a replacement snapshot instead of treating an empty page as the end of history.

The browser coordinates these paths through one per-room state machine with `idle`, `replay`, `replace`, and `prepend` phases. Live replay and replacement recovery have priority over optional history pagination: a prepend cannot cancel an active replacement, and a replacement invalidates an older prepend response. `CURSOR_AHEAD` resets both the obsolete target head and `lastGapSnapshotTarget`. If deletion empties the visible window while `hasMore` was true, or `message_history_invalidated` reports a truncation, the controller replaces the window instead of treating an empty array as proof that no older history exists.

## Event semantics

The log is a bounded immutable after-image changelog, not an audit log and not full Event Sourcing. Canonical tables remain the source of truth, but each retained event is deterministic by itself: `readRoomEvents()` strictly decodes its stored `schemaVersion: 1` discriminated payload and never replaces old content with current `room_messages`, `room_agent_turns`, or `rooms` rows. Missing, mistyped, or unexpected fields raise `EVENT_PAYLOAD_INVALID`; the client does not advance that cursor and replaces state from a canonical snapshot. Stable media asset IDs and metadata are stored with message after-images; internal object keys, uploader IDs, stream owners, password hashes, and expiring signed URLs are excluded.

| Event | Client action |
| --- | --- |
| `messages.upserted` | Upsert stored Message after-images by ID and canonical order |
| `messages.deleted` | Remove the listed IDs; clear the room media cache even when the deleted asset was outside the loaded window |
| `agent_turns.upserted` | Upsert stored durable RoomAgentTurn after-images |
| `agent_turns.deleted` | Remove turn IDs |
| `members.changed` | No member data is exposed; refresh current permissions and reload privileged member views through `room.manageMembers` authorization |
| `room.updated` | Apply the stored complete SafeRoom after-image through the normal room commit guard |
| `room.deleted` | Clear caches, remove the room from page lists, leave the stale Socket room, and return to the room list |

Clear, truncate, retry, and edit-and-ask operations are represented by one or more ordered batched upsert/delete events. A business operation is therefore not required to map to exactly one event. What is required is that every committed visible row change and its events share the same transaction, while a rollback leaves neither.

AI chunks and incremental UI updates remain transient Socket fast paths. They can arrive before the placeholder's independent PostgreSQL notification, so the browser buffers unmatched `ai_chunk`, `a2ui_update`, and `ai_stream_end` events by `messageId`, then drains them in arrival order when the placeholder appears. The buffer is bounded to 64 message IDs, 512 events, 512 KiB, and a 60-second TTL. Once the placeholder exists, each transient handler updates the canonical projection and applies the same reducer to the current React state instead of replacing it, so a concurrently added pending/failed optimistic send remains visible.

Errors use a deterministic variant of that fast path. `ai_stream_error` always includes `messageId`, `error`, and `persisted`. In the normal path, the server first persists the complete user-visible `status: error` Message and emits `{ persisted: true, message }` with that exact safe Message. If the request path exhausts its immediate persistence attempts, it emits `{ persisted: false }`; the browser immediately marks an existing placeholder terminal and keeps that local error overlay across replacement snapshots instead of leaving the UI at `streaming`.

The failure is not left for a future restart. An in-process terminal-persist reconciler retains the exact terminal Message and retries with bounded exponential backoff until PostgreSQL accepts it and creates the normal `messages.upserted` event. Every stream owner also heartbeats a PostgreSQL lease. Periodic singleton recovery changes a `streaming` placeholder to `error` only when its owner lease is absent or expired, so a new process cannot terminate a stream still owned by another live instance. If an error arrives before the placeholder, it is buffered by `messageId`; a later durable terminal after-image clears the local overlay and remains authoritative. Internal fields such as `aiStreamOwnerId` are stripped before any fast-path Message leaves the server.

Message identity also has a database-level invariant: once a message ID is created, its `room_id` cannot change. PostgreSQL rejects a conflicting cross-room upsert, so a message move cannot leave a ghost after-image in the source room. A future product feature that truly moves messages must model an explicit source delete and target upsert instead of weakening this constraint.

Typing, presence, voice levels, and WebRTC signalling are also transient and do not consume a durable room sequence. If reactions become a durable product model, their `reactions.upserted` / `reactions.deleted` after-images must join this sequence rather than introducing a second version counter.

## Delete authorization and retention

Before deleting a room, PostgreSQL records the current authorized reader IDs on the independent stream row and writes a `room.deleted` tombstone. Former authorized members can read the deletion replay after room/member rows cascade away; unrelated users cannot.

The hourly maintenance task keeps seven days and at most 10,000 events per room by default. `room_events.created_at` uses `clock_timestamp()`, so retention measures event materialization time rather than the start of a long transaction. The task removes only an old contiguous prefix, advances `minAvailableSeq`, and eventually removes an expired deleted-room stream after its events are gone. A PostgreSQL advisory lock makes retention singleton across app replicas. Events are never merged back into messages because materialized state was already updated in the original transaction.

## Multi-instance delivery

Every app instance listens to PostgreSQL `NOTIFY room_event_committed` and emits `room_event_available {roomId, headSeq, events?}` with `io.local.to(roomId)`. It first checks whether that instance has local subscribers; an instance with none does not read the event payload. Same-room notifications coalesce into fixed per-room min/max state, so a burst does not allocate one waiter, database read, and broadcast promise per notification. A complete contiguous range is sent only when the serialized notification fits `ROOM_EVENT_FAST_PATH_MAX_BYTES` (256 KiB by default); incomplete, failed, or oversized reads fall back to one head-only high-water hint. `get_room_events` applies its byte budget to the first event too: `EVENT_TOO_LARGE` sends the client to a bounded snapshot instead of silently exceeding the caller's memory contract.

Before emitting any complete durable payload, the instance resolves local socket client IDs from Redis or authenticated server-owned `socket.data`, then queries PostgreSQL membership once for the unique clients. The result has three meanings. Authorized sockets receive the payload. Explicitly unauthorized sockets get `room_removed` and leave before the payload is emitted. An unresolved or conflicting identity and unavailable PostgreSQL authorization remove no socket: that delivery becomes head-only, the client retries through the authorized request path, and the broadcaster records an authorization-unavailable metric. This is the authorization barrier for `members.changed` without turning an infrastructure outage into a false revocation.

PostgreSQL performs the cross-instance fan-out; each listener informs only sockets attached to that instance. The Redis adapter remains for events that truly originate once and need cross-instance delivery, including transient/user-scoped paths. This avoids the old N-listener × global Redis-broadcast amplification without leader election. Client sequence checks remain a final idempotency guard.

`NOTIFY` is not durable. A failed listener generation is explicitly closed and can no longer deliver notifications. After a new instance successfully re-establishes `LISTEN`, and only after that point, it emits local `room_sync_required {reason: "postgres_listener_reconnected"}`. Active clients replay from their existing `lastAppliedSeq` without clearing rendered state. Socket reconnect, `focus`, and `pageshow` checks provide another anti-entropy layer.

Realtime and task recovery are also instance-aware. Each process uses a unique runtime instance ID, heartbeats a Redis TTL key, and records which sockets it owns. A rolling start does not clear global presence. Singleton recovery removes only socket/session/room presence belonging to an expired instance. Code Agent turns and sandbox recovery queries exclude rows protected by an unexpired fenced room lease. Recovery and retention loops use PostgreSQL advisory locks, so replicas can all run the same image while only one performs each maintenance pass. A process paused beyond its lease is treated as having lost ownership; the durable lease, not process memory or hostname, is the authority.

## Protocol cutover boundary

Migration `0003_room_events_immutable_after_images` installs the deferred after-image writer and removes the old ID-only triggers while holding table locks. The migration runner serializes concurrent app startup with a PostgreSQL transaction advisory lock. In that same migration transaction it discards nondeterministic legacy events without resetting stream heads. Active streams advance `minAvailableSeq` to `headSeq + 1`, so old cursors receive `CURSOR_EXPIRED` and snapshot. Deleted streams receive a new V1 `room.deleted` tombstone and retain `deleted_reader_ids`. The server returns that terminal event even to a cursor older than the discarded prefix, and the client permits this one terminal sequence jump, so former members converge without an impossible deleted-room snapshot loop.

Migration `0004_public_member_change_events` removes the pre-production member privacy leak by rewriting retained member after-images to empty `members.changed` signals and replacing the member writer. The public event stream never contains offline-member IDs, roles, or join times. Production applied `0003` and `0004` on 2026-07-21 after a paired PostgreSQL/SeaweedFS backup and a full stop of old app processes. A future rolling AWS release still needs an explicit two-phase compatibility protocol.

Migration `0005_message_room_immutability_and_event_clock` rejects changes to `room_messages.room_id` and switches room-event timestamps to wall-clock materialization time. It changes no V1 payload shape, so it can be applied by the current reader without a dual decoder.

Migration `0006_ai_stream_owner_leases` adds the PostgreSQL owner/instance heartbeat table used by terminal AI recovery. It does not change room-event payloads, but its first deployment is not rolling-compatible with pre-`0006` binaries: an old process never writes the new lease, so a new process could misclassify its active placeholder as orphaned. Stop every old App before introducing `0006`. Once every replica writes the lease, subsequent protocol-compatible releases may roll normally.

This direct boundary intentionally has no long-lived dual decoder. It also needs no realtime outbox: an outbox solves competing-worker side effects and retries, while room replay is fan-out state transfer already persisted with the canonical mutation. Likewise, `messageVersion` would duplicate the room sequence without identifying missing committed changes.

## Required evidence

The implementation is guarded by:

- store and socket unit/contract tests;
- broadcaster/reducer/state-machine tests for exact committed payloads, local-subscriber short-circuit, local-only fan-out, three-state membership authorization, bounded burst coalescing, listener generation replacement, first-event byte rejection, fast-path application without replay, live-replay-versus-prepend races, expired pagination boundaries, emptied-window recovery without caching an invalid window, large-gap snapshots, cache resume, restore-behind target reset, lifecycle callbacks, deletion, turns, metadata, early transient AI event buffering, persisted and unpersisted AI terminal states, multi-second terminal retry, and optimistic-send preservation during transient AI updates;
- database-independent strict V1 payload unit tests for every event type, empty AI/media content, missing/extra fields, room binding, duplicate IDs, and retired ID-only payloads;
- real PostgreSQL tests for immutable message/room/turn/media after-images, message room immutability, wall-clock event timestamps, empty public membership signals, member-event privacy repair, strict payload rejection, secret exclusion, migration cutover, snapshot boundaries, idempotency, rollback, concurrent writers, retention, direct tombstone convergence across 600 earlier events, first-event byte limits, active/expired Code Agent and AI-owner leases, and singleton advisory locks. GitHub CI provisions PostgreSQL 17 under Node 24.18 and always supplies `ROOM_EVENT_TEST_DATABASE_URL`, so this suite cannot silently skip there;
- Playwright PostgreSQL tests for reload/fresh-context persistence, media/AI/share flows, two clients, and offline replay;
- Compose health, restart persistence, and backup/restore checks.

Health evidence distinguishes process liveness from serving readiness. `/api/health/live` has no downstream dependency and answers only whether the Node process can handle HTTP. `/api/status` and `/api/health/ready` execute a real RoomTalk table query, Redis `PING`, S3-compatible bucket probe, and Socket adapter check. A failed dependency produces HTTP 503, `status: "degraded"`, a named dependency state, and `rooms: null`; database failure can no longer collapse into the valid business state `rooms: 0`. Compose uses the readiness endpoint, while Kubernetes should use the two endpoints for their corresponding probe types.

Deployment and portability details live in [Room Event Sync and Portable Deployment](room-event-sync-portable-deployment.md).
