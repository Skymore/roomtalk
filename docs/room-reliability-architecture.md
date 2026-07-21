# Room Reliability Architecture

[中文](room-reliability-architecture.zh.md)

Status: implemented runtime architecture

Updated: 2026-07-20

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
rooms / room_messages / room_agent_turns
  canonical materialized state
          │ same PostgreSQL transaction, captured by triggers
          ▼
room_event_streams + room_events
  bounded replay window
          │ commit-time NOTIFY; app reads/hydrates exact seq
          ▼
Socket.IO + Redis adapter
  bounded canonical event fast path or head-only hint
          │
          ▼
client reducer + IndexedDB v4 cursor/window
```

Redis holds presence, the Socket.IO adapter, and a short-lived recent-message cache. It is not a durable business-data store. PostgreSQL is mandatory at server startup.

## Snapshot and replay

On a cold room open, or after a reset, `get_room_snapshot` reads the room, bounded recent messages, relevant agent turns, and event head in one repeatable-read transaction. The returned boundary is `snapshotSeq`.

If an IndexedDB/memory window already exists, the client paints it immediately. A `room_event_available` notification normally includes the committed hydrated event. When its event list ends at `headSeq` and starts exactly at `lastAppliedSeq + 1`, the reducer applies it and advances without another request. Missing, oversized, duplicate, or non-contiguous payloads remain safe because `headSeq` still drives `get_room_events(afterSeq=lastAppliedSeq)`.

Small gaps use pages of 100 events and 256 KiB by default. When a retained gap exceeds 500 events, the client stops replaying intermediate state and loads a new repeatable-read snapshot, then drains only events committed after `snapshotSeq`. Older history remains independently lazy through `beforeMessageId`.

The reducer accepts only a contiguous prefix:

- `seq <= lastAppliedSeq`: duplicate, ignore;
- `seq === lastAppliedSeq + 1`: apply and advance;
- a gap: discard the page and load a new bounded snapshot;
- a retained gap over 500 events: skip page-by-page replay and load a new bounded snapshot;
- `CURSOR_EXPIRED`: retained history is gone, load a snapshot;
- `CURSOR_AHEAD`: the database was restored behind the browser cache, load a snapshot.

Older chat history still uses `beforeMessageId`. Prepending an old page never moves the live event cursor.

## Event semantics

The log is a state-transfer changelog, not an audit log and not full event sourcing. Stored payloads contain bounded entity IDs; reads hydrate upserts from current canonical rows.

| Event | Client action |
| --- | --- |
| `messages.upserted` | Upsert hydrated messages by ID and canonical order |
| `messages.deleted` | Remove the listed IDs; clear associated media cache entries |
| `agent_turns.upserted` | Upsert hydrated durable turn metadata |
| `agent_turns.deleted` | Remove turn IDs |
| `room.updated` | Apply the hydrated complete room through the normal room commit guard |
| `room.deleted` | Clear the local room/message caches |

Clear, truncate, retry, and edit-and-ask operations are represented by one or more ordered batched upsert/delete events. A business operation is therefore not required to map to exactly one event. What is required is that every committed visible row change and its events share the same transaction, while a rollback leaves neither.

AI chunks and incremental UI updates remain transient Socket fast paths. The durable placeholder and final/error message are room-event fast paths after commit and remain replayable after missed delivery.

## Delete authorization and retention

Before deleting a room, PostgreSQL records the current authorized reader IDs on the independent stream row and writes a `room.deleted` tombstone. Former authorized members can read the deletion replay after room/member rows cascade away; unrelated users cannot.

The hourly maintenance task keeps seven days and at most 10,000 events per room by default. It removes only an old contiguous prefix, advances `minAvailableSeq`, and eventually removes an expired deleted-room stream after its events are gone. Events are never merged back into messages because materialized state was already updated in the original transaction.

## Multi-instance delivery

Every app instance listens to PostgreSQL `NOTIFY room_event_committed`, reads and hydrates the exact committed sequence from PostgreSQL, and emits `room_event_available {roomId, headSeq, events?}` through Socket.IO. The event payload is included only when the complete serialized notification fits `ROOM_EVENT_FAST_PATH_MAX_BYTES` (256 KiB by default); failures and oversized events fall back to a head-only hint. Per-room hydration is serialized so one instance emits in sequence order. With multiple instances, the Redis adapter may deliver duplicates, but `seq <= lastAppliedSeq` is idempotent and any gap falls back to durable replay.

## Required evidence

The implementation is guarded by:

- store and socket unit/contract tests;
- broadcaster/reducer tests for committed payload hydration, size fallback, per-room ordering, fast-path application without replay, large-gap snapshots, cache resume, expiry, restore-behind, deletes, turns, metadata, and transient AI events;
- real PostgreSQL tests for schema, snapshot boundaries, idempotency, rollback, concurrent writers, monotonic room metadata, retention, and deletion authorization;
- Playwright PostgreSQL tests for reload/fresh-context persistence, media/AI/share flows, two clients, and offline replay;
- Compose health, restart persistence, and backup/restore checks.

Deployment and portability details live in [Room Event Sync and Portable Deployment](room-event-sync-portable-deployment.md).
