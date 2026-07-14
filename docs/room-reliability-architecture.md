# Room Reliability Architecture

[中文](room-reliability-architecture.zh.md)

Status: Current architecture
Updated: 2026-07-13

This is the single current documentation source for client room-session recovery,
room-object convergence, message reconciliation, media continuity, and
time-based room authorization. Source code and tests remain authoritative.

## Reliability model

Room reliability is split into four explicit authorities:

1. `RoomSessionController` owns transport registration and desired-room
   membership for the current browser tab.
2. The server-owned room object and monotonic `roomVersion` own room metadata
   convergence across acknowledgements, broadcasts, lists, joins, and storage.
3. Durable message history plus `historyVersion` owns message reconciliation;
   Socket.IO and local caches accelerate delivery but are not durable truth.
4. Server authorization owns posting permission. The client only schedules the
   next time boundary and asks the server for a fresh decision.

These authorities are related, but their revisions are not interchangeable. A
join acknowledgement is not a room-object version, a message history version is
not a membership epoch, and a reconnect indicator is not a recovery scheduler.

## Source-of-truth map

| Boundary | Current owner |
| --- | --- |
| Room-session state machine | `client-heroui/src/utils/roomSessionController.ts` |
| Socket.IO transport adapter and diagnostics | `client-heroui/src/utils/socket.ts` |
| React projection and browser lifecycle events | `client-heroui/src/pages/MessagePage.tsx` and `client-heroui/src/hooks/useRoomSession.ts` |
| Message listeners, cache hydration, and history reconciliation | `client-heroui/src/hooks/useRoomMessageEvents.ts` and `client-heroui/src/components/MessageList.tsx` |
| Room-object ordering and replacement | `client-heroui/src/utils/roomState.ts` and `client-heroui/src/pages/MessagePage.tsx` |
| Posting-boundary scheduling | `client-heroui/src/utils/postingSchedule.ts` |
| Per-socket membership serialization and canonical room acknowledgements | `server/src/socket/roomHandlers.ts` |
| Durable room versions | `server/src/repositories/postgresStore.ts` and `server/src/repositories/redisStore.ts` |

## Room Session Controller

`RoomSessionController` is the only client owner of:

- transport connection readiness;
- registration for the current Socket.IO socket ID;
- the desired room and password for the current browser tab;
- join/rejoin attempts and retry budgets;
- the room-session epoch;
- the message resync revision;
- the public session phase and terminal error.

Browser lifecycle handlers, React pages, and ordinary socket helpers may submit
intent or subscribe to snapshots. They must not emit `register` or `join_room`
directly and must not maintain a parallel membership generation.

### Public state

The controller publishes an immutable snapshot:

| Field | Meaning |
| --- | --- |
| `phase` | `idle`, `connecting`, `registering`, `joining`, `ready`, `retrying`, or `unavailable` |
| `roomId` | Current desired room, not a component's current view |
| `socketId` | Socket ID for which the snapshot was produced |
| `sessionEpoch` | Identity of the desired-room/socket pair |
| `resyncRevision` | Independent trigger for message history reconciliation |
| `result` | Last verified room, permissions, and member count |
| `source` | Event that initiated the current transition |
| `attempt` | Attempt within the current epoch; it is not an epoch |
| `error` | Terminal error for `unavailable`; transient retry errors stay internal |

React derives `isRoomSessionReady` from one condition: the snapshot is `ready`
for the currently displayed room.

### Epoch and revision rules

`sessionEpoch` advances only when:

1. the desired room changes, including leaving a room; or
2. a connection is established with a different Socket.IO socket ID while a
   room is desired.

It does not advance for list/chat navigation, `visibilitychange`, `pageshow`,
`online`, retries, duplicate calls, registration acknowledgements, or join
acknowledgements.

`resyncRevision` is independent. It advances when:

1. a session epoch first reaches `ready`; or
2. a foreground/BFCache event requests reconciliation while the same session
   remains ready.

Together, `pageshow`, `visibilitychange`, and `online` are coalesced into at
most one resync revision. They never emit another join for an already-ready
socket/room pair.

### State transitions

```text
idle
  -- select room, disconnected --> connecting
  -- select room, connected ----> registering

connecting
  -- connect -------------------> registering
  -- connection deadline -------> unavailable

registering
  -- register ack --------------> joining
  -- disconnect ----------------> retrying
  -- transient timeout ---------> retrying -> registering
  -- definitive rejection ------> unavailable

joining
  -- join ack ------------------> ready             [resyncRevision + 1]
  -- disconnect ----------------> retrying
  -- transient timeout ---------> retrying -> joining
  -- definitive rejection ------> unavailable

ready
  -- same-room navigation ------> ready             [no join, no epoch]
  -- foreground resync ---------> ready             [resyncRevision + 1, no join]
  -- disconnect ----------------> retrying           [keep rendered data]
  -- select another room -------> joining/registering [epoch + 1]

retrying
  -- connect/register/join -----> ready
  -- retry budget exhausted ----> unavailable

unavailable
  -- explicit retry ------------> connecting/registering/joining [same epoch]
  -- select another room -------> connecting/registering/joining [epoch + 1]
```

### Concurrency and lifecycle rules

- Registration is coalesced per socket ID. Acknowledged socket operations await
  the same registration promise.
- Selecting the same room while its request is in flight returns the same
  completion promise and preserves the initiating source.
- A new room supersedes the previous completion. Late results cannot update the
  snapshot; a stale successful join receives defensive `leave_room` cleanup.
- A timed-out current join may retry within the same epoch. Retry attempts do
  not advance `sessionEpoch` or `resyncRevision`.
- `visibilitychange`, BFCache `pageshow`, and `online` only call `resume`.
  React owns no membership timer, generation, or join promise.
- The page may delay a reconnect indicator to avoid visual flicker, but that UI
  timer does not drive recovery.

## Message and media continuity

Session readiness controls new privileged work:

- sending, editing, or deleting messages;
- requesting new signed media URLs;
- room settings, workspace reads, and other member-only operations.

Session readiness does not erase already rendered state:

- in-memory and IndexedDB message windows remain visible during `connecting`,
  `registering`, `joining`, and `retrying`;
- existing object URLs and signed URLs remain attached to media elements;
- media hooks pause new access-controlled lookup/fetch work instead of clearing
  the current URL.

Message listeners and persistent-cache hydration are keyed by `roomId`, not by
readiness, so they remain mounted through a transient reconnect. A separate
effect emits `get_room_messages` only when the controller is ready and
`resyncRevision` changes.

`historyVersion` orders server and local message windows. It is neither a room
session epoch nor a room metadata version. If a response shows that the local
window is stale, the message layer reconciles from durable history without
creating another join.

## Room-object convergence

Server room objects are complete values, not patches. Every accepted room
object replaces the previous object wholesale, so omitted optional fields such
as a disabled `postingSchedule` or cleared `hasPassword` actually disappear.

All room ingress paths use the same ordering rule:

```text
incoming roomVersion > local -> replace
incoming roomVersion == local -> same write; safe no-op or replacement
incoming roomVersion < local -> ignore
missing roomVersion -> legacy updatedAt fallback
```

`roomVersion` is a server-owned, per-room monotonic sequence. PostgreSQL bumps
it while holding the canonical row mutation boundary; Redis Lua scripts derive
the next value from the stored record atomically. Versions are comparable only
within the same room. `updatedAt` is retained for display and legacy fallback,
not as the normal ordering authority.

`MessagePage` advances its synchronous `currentRoomRef` before enqueuing the
guarded React update. This makes acknowledgements and broadcasts observe the
same newest room even when both arrive within one React commit window. Local
persistence stores only the accepted canonical object.

## Acknowledgements, broadcasts, and membership

Room metadata mutations consumed by the client return the canonical saved room
in their acknowledgements and broadcast the same authoritative state to other
clients where applicable. Both paths converge through the same
full-object/version guard. If persistence fails, neither path may emit a ghost
update.

The initiating client therefore gets read-your-write immediately from the ack;
it does not depend on receiving its own broadcast. Equal `roomVersion` values
make ack/broadcast duplicate delivery idempotent.

On the server, every operation that changes one socket's registration or room
presence is serialized on a per-socket mutation queue. `register`, overlapping
joins, `leave_room`, re-registration, and disconnect therefore cannot commit
out of order after asynchronous store work. A join verifies durable access at
commit time before leaving the previous healthy room.

Realtime presence and durable membership are different. Leaving or
disconnecting removes realtime presence; durable membership remains the access
grant for password-protected rooms and room roles.

## Posting-window revalidation

The server is the source of truth for whether an actor may post. A permission
snapshot can become stale when time crosses a schedule boundary even if no
socket event occurs.

The client mirrors only the timezone/overnight boundary calculation, schedules
the next relevant boundary, and then requests fresh room permissions from the
server. It never flips `canPost` locally. Client and server use shared scenario
vectors for ordinary windows, overnight windows, timezones, disabled/empty
schedules, and boundary instants.

## Failure handling

Transient transport loss keeps the desired room and rendered content while the
controller retries. Definitive access loss is different: `room_removed`,
`Room not found`, and explicit access removal invalidate the room cache and
navigate away through the page's room-domain handling.

Password and access rejection are terminal for that attempt. The current room
is not discarded before a different room has successfully committed, so a
rejected room switch can return to the previous healthy room.

The remaining protocol debt is stable machine-readable room error codes.
Several paths still classify string errors such as `/room not found/i`; new
protocol work should replace this with shared codes without changing the state
ownership described here.

## Production diagnostics

Browser logs intentionally expose the state machine without logging passwords,
tokens, or message content:

- `[room-session]` records transport, registration, join, phase, retry, epoch,
  readiness, and resync transitions;
- `[room-messages]` records persistent-cache hydration and versioned history
  request/response reconciliation.

Correlate `roomId`, `socketId`, `sessionEpoch`, `resyncRevision`, and
`historyVersion`.

A normal cold restore is:

```text
room-selected -> connection-waiting -> socket-connected
-> registration-attempt -> registration-ready
-> join-attempt -> room-ready
-> history-request -> history-response
```

For one epoch, a successful join should produce one `room-ready`. Foreground
lifecycle signals on an already-ready session may produce `resync-requested`
and another history request, but must not produce `join-attempt`. A new socket
ID while a room is desired creates a new epoch and repeats registration/join.

## Verification contract

Current automated coverage includes:

- `roomSessionController.test.ts`: connection/register/join state sequences,
  same-room coalescing, socket replacement, timeouts, supersession, and late
  acknowledgement cleanup;
- `MessagePage.test.tsx`: current-room projection, content continuity,
  whole-object replacement, stale-version rejection, ack read-your-write, and
  posting-boundary permission refresh;
- `useRoomMessageEvents.test.tsx` and `MessageList.test.tsx`: cache hydration,
  resync/history reconciliation, and preserved content while unready;
- `roomState.test.ts`: `roomVersion` ordering and legacy timestamp fallback;
- `postingSchedule.test.ts` and `roomAuthorization.test.ts`: shared schedule
  scenarios on both sides;
- `roomHandlers.test.ts`: registration, idempotent rejoin, overlapping join
  serialization, join-then-leave ordering, and canonical room acknowledgements;
- store contract tests: monotonic `roomVersion` across mixed room/message
  mutations for PostgreSQL and Redis behavior.

Any change to room recovery or room-object synchronization must add an event
sequence or convergence test at the owning layer instead of introducing a new
component-local generation, timer, or repair state machine.
