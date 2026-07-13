# Room session controller design

## Problem

The client currently has two independent room-session state machines:

- `utils/socket.ts` owns socket registration, join intents, late acknowledgements, and membership repair.
- `pages/MessagePage.tsx` owns restore generations, background suppression, reconnect indicators, and a second ready/unavailable state.

Message and media components then interpret the page's temporary `ready` flag as both authorization and content visibility. A short transport transition can therefore clear messages and media that were already safely rendered, and every browser lifecycle signal can accidentally create another join generation.

The server already serializes `register`, `join_room`, `leave_room`, re-registration, and disconnect membership mutations on one per-socket queue. Socket.IO also preserves packet order on a connection. The client should rely on that protocol invariant instead of maintaining a second acknowledgement-order repair algorithm.

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

## Migration

1. Add and test the pure controller.
2. Make `socket.ts` the transport adapter and route all registration/join/leave APIs through the controller.
3. Replace `MessagePage`'s session generations and repair callbacks with one controller subscription.
4. Rename membership-ack revision props to `roomResyncRevision` and decouple cache hydration/listeners from readiness.
5. Preserve displayed media while pausing new access-controlled media requests.
6. Remove obsolete repair tests and replace them with controller event-sequence coverage.

## Implementation outcome

The migration is complete on the client. The backend membership implementation
was retained because its per-socket mutation queue already provides the required
ordering contract; the server contract test for overlapping joins verifies that
the final acknowledgement reflects the final serialized membership. Rewriting
that layer would have duplicated an invariant that is already explicit and
tested.
