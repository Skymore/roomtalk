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

Older chat history still uses `beforeMessageId`. Prepending an old page never moves the live event cursor.

## Event semantics

The log is a bounded immutable after-image changelog, not an audit log and not full Event Sourcing. Canonical tables remain the source of truth, but each retained event is deterministic by itself: `readRoomEvents()` strictly decodes its stored `schemaVersion: 1` discriminated payload and never replaces old content with current `room_messages`, `room_agent_turns`, or `rooms` rows. Missing, mistyped, or unexpected fields raise `EVENT_PAYLOAD_INVALID`; the client does not advance that cursor and replaces state from a canonical snapshot. Stable media asset IDs and metadata are stored with message after-images; internal object keys, uploader IDs, stream owners, password hashes, and expiring signed URLs are excluded.

| Event | Client action |
| --- | --- |
| `messages.upserted` | Upsert stored Message after-images by ID and canonical order |
| `messages.deleted` | Remove the listed IDs; clear associated media cache entries |
| `agent_turns.upserted` | Upsert stored durable RoomAgentTurn after-images |
| `agent_turns.deleted` | Remove turn IDs |
| `members.changed` | No member data is exposed; privileged member views reload through `room.manageMembers` authorization |
| `room.updated` | Apply the stored complete SafeRoom after-image through the normal room commit guard |
| `room.deleted` | Clear the local room/message caches |

Clear, truncate, retry, and edit-and-ask operations are represented by one or more ordered batched upsert/delete events. A business operation is therefore not required to map to exactly one event. What is required is that every committed visible row change and its events share the same transaction, while a rollback leaves neither.

AI chunks and incremental UI updates remain transient Socket fast paths. They can arrive before the placeholder's independent PostgreSQL notification, so the browser buffers unmatched `ai_chunk`, `a2ui_update`, and `ai_stream_end` events by `messageId`, then drains them in arrival order when the placeholder appears. The buffer is bounded to 64 message IDs, 512 events, 512 KiB, and a 60-second TTL. Once the placeholder exists, each transient handler updates the canonical projection and applies the same reducer to the current React state instead of replacing it, so a concurrently added pending/failed optimistic send remains visible.

Errors use a deterministic variant of that fast path. The server first persists the complete user-visible `status: error` Message. It then emits `ai_stream_error` with that exact Message. If the error arrives before the placeholder, the browser buffers it by `messageId`; if a replay page already contains the final error after-image, the durable row wins and the buffered copy is discarded. The client never appends a Socket-only warning to canonical content. Therefore `ai_stream_error -> messages.upserted`, `messages.upserted -> ai_stream_error`, and error-before-placeholder all converge to the same state.

Typing, presence, voice levels, and WebRTC signalling are also transient and do not consume a durable room sequence. If reactions become a durable product model, their `reactions.upserted` / `reactions.deleted` after-images must join this sequence rather than introducing a second version counter.

## Delete authorization and retention

Before deleting a room, PostgreSQL records the current authorized reader IDs on the independent stream row and writes a `room.deleted` tombstone. Former authorized members can read the deletion replay after room/member rows cascade away; unrelated users cannot.

The hourly maintenance task keeps seven days and at most 10,000 events per room by default. It removes only an old contiguous prefix, advances `minAvailableSeq`, and eventually removes an expired deleted-room stream after its events are gone. Events are never merged back into messages because materialized state was already updated in the original transaction.

## Multi-instance delivery

Every app instance listens to PostgreSQL `NOTIFY room_event_committed`, reads the exact committed `(roomId, seq)` from PostgreSQL, and emits `room_event_available {roomId, headSeq, events?}` with `io.local.to(roomId)`. The event payload is included only when the complete serialized notification fits `ROOM_EVENT_FAST_PATH_MAX_BYTES` (256 KiB by default); read failures and oversized events fall back to a head-only hint. Per-room reads are serialized so one instance emits in sequence order.

PostgreSQL performs the cross-instance fan-out; each listener informs only sockets attached to that instance. The Redis adapter remains for events that truly originate once and need cross-instance delivery, including transient/user-scoped paths. This avoids the old N-listener × global Redis-broadcast amplification without leader election. Client sequence checks remain a final idempotency guard.

`NOTIFY` is not durable. After an instance successfully re-establishes `LISTEN`, and only after that point, it emits local `room_sync_required {reason: "postgres_listener_reconnected"}`. Active clients replay from their existing `lastAppliedSeq` without clearing rendered state. Socket reconnect, `focus`, and `pageshow` checks provide another anti-entropy layer.

## Protocol cutover boundary

Migration `0003_room_events_immutable_after_images` installs the deferred after-image writer and removes the old ID-only triggers while holding table locks. The migration runner serializes concurrent app startup with a PostgreSQL transaction advisory lock. In that same migration transaction it discards nondeterministic legacy events without resetting stream heads. Active streams advance `minAvailableSeq` to `headSeq + 1`, so old cursors receive `CURSOR_EXPIRED` and snapshot. Deleted streams receive a new V1 `room.deleted` tombstone and retain `deleted_reader_ids`. The server returns that terminal event even to a cursor older than the discarded prefix, and the client permits this one terminal sequence jump, so former members converge without an impossible deleted-room snapshot loop.

Migration `0004_public_member_change_events` removes the pre-production member privacy leak by rewriting retained member after-images to empty `members.changed` signals and replacing the member writer. The public event stream never contains offline-member IDs, roles, or join times. Production applied `0003` and `0004` on 2026-07-21 after a paired PostgreSQL/SeaweedFS backup and a full stop of old app processes. A future rolling AWS release still needs an explicit two-phase compatibility protocol.

This direct boundary intentionally has no long-lived dual decoder. It also needs no realtime outbox: an outbox solves competing-worker side effects and retries, while room replay is fan-out state transfer already persisted with the canonical mutation. Likewise, `messageVersion` would duplicate the room sequence without identifying missing committed changes.

## Required evidence

The implementation is guarded by:

- store and socket unit/contract tests;
- broadcaster/reducer tests for exact committed payloads, local-only fan-out, listener reconnect anti-entropy, size fallback, per-room ordering, fast-path application without replay, large-gap snapshots, cache resume, expiry, restore-behind target reset, notifications during a reset snapshot, invalid-payload snapshots, deletes, turns, metadata, early transient AI event buffering, deterministic AI error arrival order, and optimistic-send preservation during transient AI updates;
- database-independent strict V1 payload unit tests for every event type, empty AI/media content, missing/extra fields, room binding, duplicate IDs, and retired ID-only payloads;
- real PostgreSQL tests for immutable message/room/turn/media after-images, empty public membership signals, member-event privacy repair, strict payload rejection, secret exclusion, migration cutover, snapshot boundaries, idempotency, rollback, concurrent writers, monotonic room metadata, retention, and deletion authorization;
- Playwright PostgreSQL tests for reload/fresh-context persistence, media/AI/share flows, two clients, and offline replay;
- Compose health, restart persistence, and backup/restore checks.

Deployment and portability details live in [Room Event Sync and Portable Deployment](room-event-sync-portable-deployment.md).
