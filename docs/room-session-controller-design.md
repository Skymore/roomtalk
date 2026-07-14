# Room Session Controller Architecture

[中文](room-session-controller-design.zh.md)

Status: Current architecture
Updated: 2026-07-13

This document is the current client room-session contract. Source code and tests
remain authoritative; the older mobile-restore strategy and review plan under
`docs/room-reliability/` are historical records of the implementation that this
controller replaced.

## Historical problem

Before `RoomSessionController`, the client had two independent room-session
state machines:

- `utils/socket.ts` owned socket registration, join intents, late acknowledgements, and membership repair.
- `pages/MessagePage.tsx` owned restore generations, background suppression, reconnect indicators, and a second ready/unavailable state.

Message and media components then interpreted the page's temporary `ready` flag
as both authorization and content visibility. A short transport transition
could therefore clear messages and media that were already safely rendered,
and every browser lifecycle signal could accidentally create another join
generation.

The server already serialized `register`, `join_room`, `leave_room`,
re-registration, and disconnect membership mutations on one per-socket queue.
Socket.IO also preserves packet order on a connection. The refactor kept that
backend contract and removed the client's second acknowledgement-order repair
algorithm.

## Source-of-truth map

| Boundary | Current owner |
| --- | --- |
| Session state machine | `client-heroui/src/utils/roomSessionController.ts` |
| Socket.IO transport adapter and diagnostics | `client-heroui/src/utils/socket.ts` |
| React snapshot projection and browser lifecycle events | `client-heroui/src/pages/MessagePage.tsx` and `client-heroui/src/hooks/useRoomSession.ts` |
| Message listeners, cache hydration, and history reconciliation | `client-heroui/src/hooks/useRoomMessageEvents.ts` and `client-heroui/src/components/MessageList.tsx` |
| Per-socket membership serialization | `server/src/socket/roomHandlers.ts` |

No other client layer may own a room membership generation or emit `register`
or `join_room` directly.

## Ownership

`RoomSessionController` is the only client owner of:

- transport connection readiness;
- registration for the current Socket.IO socket ID;
- the desired room and password for that browser tab;
- join/rejoin attempts and retry budgets;
- the room-session epoch;
- the message resync revision;
- the public session phase and last error.

Browser lifecycle handlers, React pages, and ordinary socket helpers may send events or subscribe to snapshots. They must not emit `register` or `join_room` directly and must not maintain a parallel membership generation.

## Public state

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

React derives `isRoomSessionReady` from one condition only: the snapshot is `ready` for the currently displayed room.

## Epoch and revision rules

`sessionEpoch` advances only when:

1. the desired room changes, including leaving a room; or
2. a connection is established with a different Socket.IO socket ID while a room is desired.

It does **not** advance for list/chat navigation, `visibilitychange`, `pageshow`, `online`, retries, duplicate calls, registration acknowledgements, or join acknowledgements.

`resyncRevision` is a separate stream. It advances when:

1. a session epoch first reaches `ready`; or
2. a foreground/BFCache event requests reconciliation while the same session remains ready.

Resume signals are coalesced so `pageshow`, `visibilitychange`, and `online` arriving together produce at most one history request. They never emit a duplicate join for an already-ready socket/room pair.

## State transitions

```text
idle
  -- select room, disconnected --> connecting
  -- select room, connected ----> registering

connecting
  -- connect(new socket ID) ----> registering       [epoch + 1 if a room was already desired]
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

## Concurrency rules

- Registration is coalesced per socket ID. Every acknowledged socket operation awaits the same registration promise.
- Selecting the same room while its request is in flight returns the same completion promise.
- A new room supersedes the previous completion immediately. Late results cannot update the snapshot.
- The controller may emit the newer join while an older join is still awaiting its callback. The server's per-socket mutation queue guarantees that the newer join commits last.
- A stale successful join is followed by `leave_room` for that stale room as defensive cleanup, but it does not open a repair epoch or replay the current room.
- A timed-out current join is safe to retry: server serialization makes the repeated desired join the final membership mutation.

## Content and authorization

Session readiness controls new privileged work:

- sending/editing/deleting messages;
- requesting signed media URLs;
- room settings, workspace reads, and other member-only operations.

Session readiness does not erase already rendered state:

- in-memory and IndexedDB message windows remain visible during `connecting`, `registering`, `joining`, and `retrying`;
- existing object URLs and signed URLs remain attached to media elements;
- media hooks pause new lookups/fetches while unverified instead of clearing their current URL.

Definitive access loss is different from a transient reconnect. `room_removed`, `Room not found`, and access removal invalidate the room cache and navigate away through the page's room-domain handling.

## Message synchronization

Message listeners and cache hydration are keyed by `roomId`, not by readiness. They stay mounted across a transient reconnect. A separate effect emits `get_room_messages` only when the controller is ready and `resyncRevision` changes.

`historyVersion` continues to order server and local message windows. It is not used as a membership epoch, and join acknowledgements no longer directly drive history requests.

## Test model

Controller tests use event sequences instead of component timing:

1. disconnected -> select -> connect -> register -> join -> ready;
2. disconnect before register ack -> new socket -> register -> join;
3. disconnect during join -> new socket -> register -> join;
4. same-room navigation while ready -> no register/join/epoch/revision change;
5. `pageshow` + `visibility` while ready -> one resync revision and no join;
6. room A join pending -> select room B -> stale A result ignored, B becomes ready;
7. join timeout -> bounded retry -> ready or unavailable;
8. leave while join pending -> late success receives stale-room cleanup;
9. message/media content remains rendered while readiness is false, while new privileged requests remain blocked.

## Lifecycle event contract

`visibilitychange`, BFCache `pageshow`, and `online` only call the controller's
`resume` method. They do not maintain timers, generations, or join promises in
React. When the current room is already ready, the controller coalesces these
signals into one `resyncRevision`. If the transport is not ready, they reuse the
same room completion and drive instead of replacing it.

The page owns presentation only: it delays the reconnect indicator for a brief
transient recovery, applies each acknowledged result object once, and renders a
terminal `unavailable` error. That UI timer is not a recovery scheduler.

## Diagnostics

Production browser logs intentionally expose the state machine without secrets:

- `[room-session]` records transport, registration, join, epoch, phase, retry,
  readiness, and resync transitions;
- `[room-messages]` records persistent-cache hydration and versioned history
  request/response reconciliation.

For an incident, correlate `roomId`, `socketId`, `sessionEpoch`, and
`resyncRevision`. A join acknowledgement should lead to one `room-ready`
transition for that epoch. Foreground lifecycle signals on an already-ready
session may advance `resyncRevision`, but must not emit another join.

## Completed migration

The client migration is complete:

1. the pure controller owns the state machine and retry budgets;
2. for room-session registration/join/leave, `socket.ts` is the transport adapter;
3. `MessagePage` subscribes to one controller snapshot instead of maintaining
   restore generations and repair callbacks;
4. `roomResyncRevision` is independent from join attempt/ack counting;
5. rendered messages and media survive transient unready phases while new
   privileged work remains gated;
6. controller event-sequence tests replaced the obsolete socket repair model.

The backend membership implementation was intentionally retained because its
per-socket mutation queue already provides the required ordering contract. The
server contract tests for overlapping joins and join-then-leave verify that the
final acknowledgement/membership reflects the final serialized mutation.

## Superseded documents

These files preserve the investigation and intermediate scheduler design; they
are not current implementation instructions:

- `docs/room-reliability/mobile-room-restore-strategy.md`;
- `docs/room-reliability/room-restore-review-fix-plan.md`.

The room-object replacement, monotonic `roomVersion`, read-your-write ack, and
posting-boundary conclusions in the rest of the room-reliability series remain
current and are independent from this session-controller replacement.
