# Room reliability architecture

[中文](room-reliability-architecture.zh.md)

Status: current architecture. Updated: 2026-07-14.

This document describes the current room recovery and consistency model across the browser, Socket.IO, React, the message cache, and durable storage. It is the main design reference for this part of RoomTalk. Source code and tests remain the final authority when the document and implementation differ.

## What room readiness means

A room is ready when the current Socket.IO connection has been registered and the server has acknowledged membership in the room selected by the current session epoch. React may show a stored room shell and cached messages before that point, but member-only actions stay locked until the controller reports `ready` for the same room ID.

Four authorities cooperate during recovery:

| Concern | Authority |
| --- | --- |
| Connection, registration, and room membership | `RoomSessionController` in the browser tab |
| Room metadata | The canonical server `Room`, ordered by `roomVersion` |
| Message history | Durable message storage, ordered by `messageVersion` |
| Permission to perform an action | Server authorization at the time of the action |

Four named values cross module boundaries. The two data versions are `roomVersion`, which orders room objects, and `messageVersion`, which orders durable message history. `sessionEpoch` and `messageSyncRequestId` are control tokens local to the current tab. The first rejects asynchronous work from an old socket session. The second wakes the message synchronization effect.

The message hook also keeps a private `mutationRevision`. It is only a counter inside one mounted hook: every live message change advances it so a history response can tell whether the rendered window moved while the request was in flight. It is never sent to the server or persisted, and it does not claim to be a durable version.

When investigating stale data, compare values with the same name. `roomVersion` is never compared with `messageVersion`, and neither control token is stored with durable data. This framing lets each value answer one concrete question instead of presenting several interchangeable versions.

## Runtime ownership

The recovery path is intentionally concentrated in a few modules:

| Responsibility | Implementation |
| --- | --- |
| Session state machine | [`roomSessionController.ts`](../client-heroui/src/utils/roomSessionController.ts) |
| Socket transport, registration payload, API helpers, and session diagnostics | [`socket.ts`](../client-heroui/src/utils/socket.ts) |
| React projection, stored-room restore, lifecycle events, and room convergence | [`MessagePage.tsx`](../client-heroui/src/pages/MessagePage.tsx) |
| React subscription to controller snapshots | [`useRoomSession.ts`](../client-heroui/src/hooks/useRoomSession.ts) |
| Message listeners and history reconciliation | [`useRoomMessageEvents.ts`](../client-heroui/src/hooks/useRoomMessageEvents.ts) |
| Message rendering and privileged interaction boundary | [`MessageList.tsx`](../client-heroui/src/components/MessageList.tsx) |
| Inline media loading and full-screen viewer lifecycle | [`MessageItem.tsx`](../client-heroui/src/components/MessageItem.tsx), [`useCachedMedia.ts`](../client-heroui/src/hooks/useCachedMedia.ts), and [`MediaViewerModal.tsx`](../client-heroui/src/components/MediaViewerModal.tsx) |
| Message and media caches | [`messageHistoryCache.ts`](../client-heroui/src/utils/messageHistoryCache.ts) and [`mediaCache.ts`](../client-heroui/src/utils/mediaCache.ts) |
| Room ordering | [`roomState.ts`](../client-heroui/src/utils/roomState.ts) |
| Posting boundary timer | [`postingSchedule.ts`](../client-heroui/src/utils/postingSchedule.ts) |
| Registration, join, leave, and membership ordering | [`roomHandlers.ts`](../server/src/socket/roomHandlers.ts) |
| Message authorization, mutation, and history invalidation | [`messageHandlers.ts`](../server/src/socket/messageHandlers.ts), [`aiHandlers.ts`](../server/src/socket/aiHandlers.ts), and [`roomAuthorization.ts`](../server/src/socket/roomAuthorization.ts) |
| Media authorization | [`apiRoutes.ts`](../server/src/routes/apiRoutes.ts) |
| Durable room and message versions | [`postgresStore.ts`](../server/src/repositories/postgresStore.ts) and [`redisStore.ts`](../server/src/repositories/redisStore.ts) |

`MessagePage` submits room intent and renders controller state. All join scheduling stays in the controller. Lifecycle handlers call `resume`, socket helpers await controller registration, and message code reacts to `messageSyncRequestId` after the session becomes ready.

Events therefore move through one direction. For example, `visibilitychange` reaches `MessagePage`, which calls `roomSessionController.resume("visibility")`. The controller either returns the active room completion or schedules a message synchronization. React observes the snapshot, and the message hook decides whether a history request is due. The lifecycle handler never emits `register`, `join_room`, or `get_room_messages` itself.

## Room session lifecycle

`RoomSessionController` owns one desired room for the tab. The easiest way to understand its job is to follow one restore from the first React render to the first authoritative history response.

### 1. The page paints a room shell

Suppose the user last viewed room `nZDcDhQEcu`, closes the app, and opens it again later. `MessagePage` reads the saved `Room` and view from localStorage. It can immediately draw the room name, header, and message area. `useRoomMessageEvents` also starts looking for the room's in-memory or IndexedDB message window.

At this point the browser has presentation data, not verified membership on the current socket. The stored room may also be older than the server copy. The page therefore keeps sending, editing, settings, workspace reads, and new media requests locked. Showing the shell early removes a blank loading screen without granting access from stale local state.

### 2. The page records one room intent

The page calls `selectRoom({ roomId, source: "storage" })`. The controller stores that room as the tab's desired room and creates a completion promise for the request. If the desired room changed, it advances `sessionEpoch`. That epoch now identifies every registration and join result that may complete this request.

Lifecycle events can arrive almost immediately after mount. A visible page, a BFCache restore, and an `online` event may all ask for recovery while the first request is still running. They call `resume`, which returns the same completion promise for the same room. The original drive keeps ownership of the request.

### 3. The current socket is registered

If Socket.IO is disconnected, the controller starts the transport and waits for a socket ID. Socket IDs are temporary. A reconnect produces a new one even though the browser still has the same `clientId` and `browserInstanceId`.

Registration binds those persistent browser identities to the current socket. Every operation that requires registration waits on the controller's shared registration promise. Registration does not load room lists. The page requests owned and saved room snapshots separately after registration, so list storage can never hold the registration acknowledgement open and trigger `Timed out while registering client`.

### 4. The server commits the join

After registration, the controller emits `join_room`. The server checks the room, password or durable membership, current role, and rollout restrictions. It adds provisional Socket.IO presence, then checks the durable room and membership again at the commit boundary. Only a successful target commit allows the socket to leave its previous healthy room.

That last ordering matters during a room switch. If the target password is wrong, access was removed, or the room was deleted during the request, the old room remains usable. A provisional target join is cleaned up before the server returns the error.

### 5. The acknowledgement makes the page ready

A successful join acknowledgement contains the canonical `Room`, current `RoomPermissions`, and member count. The controller verifies that the acknowledgement still belongs to the desired room, epoch, and socket. It then publishes `phase: "ready"`, stores the result, and advances `messageSyncRequestId`.

`MessagePage` consumes each result object once. It applies the canonical room through the `roomVersion` guard, installs the returned permissions, updates the member count, and unlocks member operations. The stored room shell has now become a verified room session.

### 6. Message history is reconciled

Readiness does not replace the message window by itself. The message hook waits for cache hydration, records the current canonical `messageVersion` and private `mutationRevision`, then sends `get_room_messages` with a unique `requestId`. The server returns that page through the acknowledgement for this request. The client accepts it only if it is still the latest replacement request and neither boundary changed while the request was in flight.

This separation is why a join acknowledgement advances `messageSyncRequestId` instead of pretending to be a message version. Membership is ready first. Message history then performs its own comparison.

### 7. A later disconnect repeats only the necessary work

If socket A disconnects, the controller moves to `retrying`. The page locks new member operations but keeps the room shell, messages, scroll position, and loaded media. When socket B connects, the controller advances `sessionEpoch`, registers socket B, rejoins the same desired room, and advances `messageSyncRequestId` after the new join succeeds.

The sequence diagram is a compact index of those two paths. Retry budgets, supersession, and foreground-only message reconciliation are covered in the sections that follow.

```mermaid
sequenceDiagram
    participant Page as MessagePage
    participant Session as RoomSessionController
    participant Server as Socket.IO and room server
    participant Messages as Message sync

    Note over Page,Messages: Cold restore
    Page->>Page: Render stored room shell and cached messages
    Page->>Session: selectRoom(roomId, source=storage)
    Session->>Server: Connect transport
    Server-->>Session: connected(socket A)
    Session->>Server: register(clientId, browserInstanceId)
    Server-->>Session: register acknowledgement
    Session->>Server: join_room(roomId)
    Server->>Server: Recheck access and commit membership
    Server-->>Session: join acknowledgement(Room, permissions, memberCount)
    Session-->>Page: ready, messageSyncRequestId + 1
    Page->>Messages: Session is ready
    Messages->>Server: get_room_messages(requestId, baseMessageVersion)
    Server-->>Messages: Ack(requestId, versioned history page)
    Messages-->>Page: Reconcile the visible window

    Note over Page,Messages: Later socket replacement
    Server-->>Session: disconnect(socket A)
    Session-->>Page: retrying, lock new member operations
    Note over Page,Messages: Keep the room shell, messages, scroll position, and loaded media
    Session->>Server: Reconnect transport
    Server-->>Session: connected(socket B)
    Note right of Session: sessionEpoch + 1
    Session->>Server: register(clientId, browserInstanceId)
    Server-->>Session: register acknowledgement
    Session->>Server: join_room(roomId)
    Server->>Server: Recheck access and commit membership
    Server-->>Session: join acknowledgement
    Session-->>Page: ready, messageSyncRequestId + 1
    Page->>Messages: Reconcile history again
```

The phase names describe protocol progress, while the page decides how to present each phase:

| Phase | Controller meaning | Page behavior |
| --- | --- | --- |
| `idle` | No desired room is being driven | Show a non-room view or wait for room intent |
| `connecting` | A room is desired and no usable socket ID exists | Keep any room shell visible and lock member operations |
| `registering` | The transport is connected and identity binding is pending | Keep the shell and cached content visible; wait for register ack |
| `joining` | The socket is registered and target membership is pending | Keep the target shell locked until the join commits |
| `ready` | The current socket has verified membership in the desired room | Apply permissions and allow the operations they authorize |
| `retrying` | A recoverable timeout, disconnect, or transport change interrupted the drive | Preserve rendered content, lock new privileged work, and continue recovery |
| `unavailable` | A definitive rejection occurred or the retry budget ended | Offer retry or run the room-removal/password handling for that error |

The snapshot contains the current `phase`, desired `roomId`, `socketId`, `sessionEpoch`, `messageSyncRequestId`, last verified result, initiating source, current attempt, and terminal error. The verified result may include the canonical room, current permissions, and member count returned by the join acknowledgement.

### Two control tokens and two data versions

| Kind | Value | Changes when | Question it answers |
| --- | --- | --- | --- |
| Session control | `sessionEpoch` | The desired room changes, the room is left, or a different socket ID connects while a room is desired | Does this asynchronous result still belong to the current room session? |
| Sync control | `messageSyncRequestId` | An epoch first becomes ready, or a ready session receives a coalesced foreground resume | Should the message synchronization effect run again? |
| Data version | `roomVersion` | The server commits a canonical room write, including room-affecting message mutations | Which complete `Room` object is newer? |
| Data version | `messageVersion` | Durable message history changes | Which message window is newer? |

A registration acknowledgement and a join acknowledgement leave `sessionEpoch` unchanged. Retries also stay in the same epoch. A successful join advances `messageSyncRequestId` once when that epoch first reaches `ready`.

`mutationRevision` is deliberately absent from this table because it is not shared state. It starts at zero when the room message hook mounts and only answers whether a live event changed this particular rendered window during one request.

When the session is already ready, `visibilitychange`, BFCache `pageshow`, and `online` are coalesced for 150 ms into one message synchronization request. The controller keeps the existing membership and sends no new `join_room`. During initial page load, `MessagePage` ignores the ordinary non-BFCache `pageshow` event.

### Coalescing and supersession

Registration is shared per socket ID through one promise. Any socket operation that needs registration waits for that promise instead of emitting its own `register` request.

Selecting the same room while registration or join is pending returns the existing completion promise. Selecting the same room after readiness returns the verified result immediately. Selecting a different room advances the epoch and supersedes the old completion. If the old room later reports a successful join, the controller sends a defensive `leave_room` and keeps the new room as the desired target.

A replacement socket ID advances the epoch because registration and membership belong to the old transport. The pending user intent is carried into the new epoch, so callers continue waiting for recovery instead of receiving a false navigation failure.

The production defaults allow 45 seconds for a connection, 15 seconds for each registration or join acknowledgement, and up to three registration and three join attempts. Retry delays are 0, 250, and 1000 ms. A timeout remains inside the current epoch. Exhausting the budget moves the snapshot to `unavailable`.

## Server membership commit

Registration and room membership are separate server decisions. Registration associates a persistent client identity with one temporary socket and joins that socket to its private client channel. It grants no room access. `join_room` performs the room-specific checks and creates live presence.

The server serializes registration, join, leave, re-registration, and disconnect cleanup for each socket. This queue prevents an earlier asynchronous operation from committing after a later one on the same socket. Access-changing membership operations also use a per-room queue and a Redis lease. The local queue orders work inside one process; the Redis lease extends the same critical section across Socket.IO workers. Join, deletion, member removal, administrator changes, and ownership transfer therefore cannot commit from mutually stale room or membership snapshots.

Without the socket queue, a slow join for room A could finish after a later join for room B and make A the server's final membership by accident. The queue makes the final state follow request order. The room lock handles a different race: an administrator can remove a member on worker A while that member is joining through worker B. The join rechecks membership after provisional presence, so the serialized removal takes effect before a successful acknowledgement can escape. The Redis lock has a short renewable lease and token-checked release, which lets a crashed owner expire without letting an old owner release a newer lock.

A join performs the following commit sequence:

1. Read the registered client identity and target room.
2. Check rollout rules, password requirements, and durable membership.
3. Create durable membership when the join is allowed and the member does not exist.
4. Provisionally join the Socket.IO room and update client and browser presence.
5. Re-read the durable room and membership at the commit boundary.
6. Remove the provisional presence if access disappeared; otherwise leave previous healthy rooms and acknowledge the target room.

The acknowledgement carries the canonical `Room`, current `RoomPermissions`, and member count. Rejoining the same room is idempotent. Registration has no eager room-list read; owned and saved room snapshots use their own acknowledgement requests.

Durable membership and live presence have separate lifetimes. `leave_room` and disconnect cleanup remove socket presence while preserving the durable room role. Presence uses socket sets under both `clientId` and `browserInstanceId`, which makes multiple tabs or sockets for one identity safe to add and remove independently.

### Client and browser identity

The browser creates `clientId` and `browserInstanceId` independently and stores both in localStorage. Google login links an account to a client ID, while the browser instance ID remains local to the available storage partition. Chrome, an installed web app, or another browser surface will share that value only when the platform gives them the same origin storage partition.

The server counts online room members by unique client ID and tracks active browser instances separately. Two sockets that present the same client or browser ID are retained in per-identity socket sets, so closing one socket does not remove the other socket's presence.

## What the page preserves during recovery

The controller owns the recovery protocol, while `MessagePage` decides what the user can see and do during each phase. A stored room can be rendered as a shell during `connecting`, `registering`, and `joining`. The page derives readiness by checking that the controller is `ready` for the exact room currently on screen.

The successful join result replaces the shell with an accepted canonical room and supplies current permissions. If the controller instead reports `unavailable`, the shell remains visible with its operations locked and a retry action. A confirmed missing room or access removal follows the room-removal path and clears the shell.

Transport loss keeps the desired room, current room shell, messages, scroll position, and already loaded media. New privileged work is locked while the controller registers and joins the replacement socket. The reconnect indicator has a 400 ms grace period to avoid flashing during a fast recovery; it only reflects controller state and never starts recovery itself.

`visibilitychange`, BFCache restore, and network recovery all enter through `resume`. A ready session schedules history reconciliation. A session that is still connecting, registering, joining, or retrying shares the active drive. This keeps lifecycle events from duplicating registration or join work.

These two resume cases often look similar in the UI but produce different logs. Returning to a tab with the same ready socket only advances `messageSyncRequestId`. Returning after the mobile OS suspended the socket produces a new socket ID, a new epoch, registration, and join. The 400 ms reconnect indicator appears only when the second path lasts long enough to be visible.

## Message reconciliation

Message subscriptions are keyed by `roomId` and remain mounted while session readiness changes. Reopening a room paints the in-memory window synchronously. A cold tab hydrates the latest window from IndexedDB. The cache stores up to 100 recent messages per room. A per-room generation guards clear and replacement races, while a persistent tombstone prevents an inaccessible or deleted room from being revived by a late cache read in this tab or another tab.

The message cache does not own durable data. A cache format change uses a new database name, deletes the old database, and reloads messages from the server. The current window is stored in `roomtalk-message-cache-v3`. Same-tick writes for one room are coalesced, so a burst of stream or metadata updates persists only the newest window. Trimming is throttled rather than scanning every write. A queued write is also bound to the client that created it and is discarded if the active client changes before persistence.

The history request is a separate effect. It runs only when the room session is ready and either `messageSyncRequestId` or the reconciliation retry nonce changes. Each request sends a unique `requestId`, the canonical local `messageVersion` as `baseMessageVersion`, and asks for the latest 80-message page. The response comes through that request's Socket.IO acknowledgement rather than a shared `message_history` event, so two overlapping requests cannot consume each other's payload.

Consider the race that originally made a restored room look healthy while new messages disappeared. The client sends a history request with canonical version 3462 and records `mutationRevision: 0`. Before the response returns, `new_message` arrives and changes the visible window, so the private revision becomes 1. The delayed response may still describe a snapshot taken before that message. Replacing the page would erase the live message that just appeared.

Live events update the visible window and advance `mutationRevision`; they do not invent a new canonical `messageVersion`. When a history response arrives, the client checks its `requestId`, the echoed `requestedMessageVersion`, the recorded mutation revision, and the server `messageVersion`. A newer replacement request, a changed canonical boundary, a changed local window, or an older server version makes the response stale. The client keeps the displayed data and schedules another comparison, with a limit of three reconciliation retries.

In the example, `[room-messages] history-response` records `requestedMessageVersion: 3462`, `requestedMutationRevision: 0`, `currentMutationRevision: 1`, and `decision: "ignored"`. The retry records the new local revision while keeping 3462 as the last accepted canonical server boundary. Once a response survives both checks, its server `messageVersion` becomes the new canonical boundary.

Some mutations replace or truncate a whole suffix rather than producing one usable message delta. AI retry and edit-and-ask are examples. The server broadcasts `message_history_invalidated` after the durable mutation. Every room client then requests its own canonical page through the acknowledgement protocol. The invalidation event tells peers that reconciliation is needed; it does not carry a competing full history payload.

An accepted replacement keeps server position order. If its message IDs, update stamps, and statuses match the displayed window, the client updates cache metadata without replacing the rendered list or forcing another scroll. Older-page responses prepend messages by ID and cannot overwrite a window invalidated by a later mutation.

Cache hydration has a similar ordering guard. A slow IndexedDB read can finish after server history has already loaded. The hook marks that cache result as skipped. When a room is cleared, deleted, or loses access, its cache generation advances or its tombstone is persisted before later callbacks can write. A successful verified rejoin can reactivate the room for new writes, while work started under the old generation remains stale.

## Media continuity

Media access follows the same readiness boundary as other privileged reads. A message can request a signed download URL only while the room session is verified. The server checks the client auth token, current durable room access, room ID, and the asset's room association each time it issues a URL.

During temporary recovery, a displayed media URL remains attached to the element. `useCachedMedia` pauses cache and network work while access is unverified and retains its current object URL or signed URL. Media state resets when the asset identity changes or the user retries a failed load. Clicking an image opens the viewer from the URL that is actually rendered, including a cached blob URL.

For example, an image may already be visible from an IndexedDB-backed blob URL when the socket disconnects. The session becomes unready, so the component stops asking for a fresh signed URL. The blob URL stays on the image, and clicking it passes that same URL to the viewer. The user can keep reading the room while membership is repaired.

If the message has no usable local or signed URL yet, it may remain in a loading state until the session is ready. At that point the component asks the server for a new 15-minute read URL. A 403 here means durable room access failed at request time; repeated join attempts in the UI would not make the media endpoint authorize the request.

The viewer marks the application root inert only after the dialog and its source are ready. This keeps an unresolved media source from freezing the whole application before the viewer can render or close.

The inert boundary fixes a specific failure mode. An earlier viewer path could disable the application before it had a renderable source. If source preparation then stalled, no visible dialog existed and the rest of the app was already unclickable. Waiting for `isDialogReady` keeps the close path available.

## Room object convergence

Server room payloads are complete values. Applying one replaces the previous `Room` instead of merging fields. This matters when the server clears an optional value such as `postingSchedule` or `hasPassword`; absence in the new object must remove the old field.

Take a room with an active posting schedule. The local object contains `postingSchedule`. An owner disables the schedule, and the saved room returned by the server omits that property. `{ ...oldRoom, ...newRoom }` would keep the old property because there is no new key to overwrite it. Whole-object replacement removes it immediately.

For two payloads with the same room ID, [`isNewerRoom`](../client-heroui/src/utils/roomState.ts) uses this rule:

```text
both roomVersion values are present:
  incoming >= current  -> accept
  incoming < current   -> ignore

either roomVersion is missing:
  compare updatedAt
  accept when either timestamp is missing or invalid
```

Equal versions represent duplicate delivery of the same canonical write and are safe to accept. The permissive legacy fallback prevents an old or corrupted localStorage timestamp from permanently blocking good server data. Versions from different room IDs are never compared.

`MessagePage` advances `currentRoomRef` synchronously before it queues the guarded React state update. An acknowledgement and a broadcast that arrive within the same React commit window therefore see the same latest room. Incremental room updates pass through the same guard for the active room, owned-room list, and saved-room list.

Owned and saved room lists use one snapshot followed by deltas. `get_rooms` and `get_saved_rooms` return initial snapshots through acknowledgements. `new_room`, `room_updated`, `room_removed`, `saved_room_added`, and `saved_room_removed` maintain them afterward. If a delta arrives while a snapshot is in flight, the page records it and replays it over the returned snapshot, so a late snapshot cannot resurrect a removed room or lose a new one. A replacement socket triggers fresh snapshots to cover events missed while offline.

The synchronous ref closes a small but important React timing gap. Suppose `room_updated` with version 52 arrives, followed immediately by an older join acknowledgement with version 51. React may not have committed the first state update yet. `currentRoomRef` already holds version 52, so the second payload is rejected before it can be queued. Reading only React state would let both callbacks compare against version 50.

PostgreSQL increments `roomVersion` at the canonical row mutation boundary. Redis uses Lua scripts that read the stored record and write the next version atomically. Message mutations increment both `messageVersion` and `roomVersion`; room metadata mutations increment `roomVersion`. `updatedAt` remains available for display and migration compatibility.

Message changes also affect room metadata such as `lastActivityAt`, which is why they advance `roomVersion` as well as the message-specific version. The room list can then order activity from a canonical room object while the message layer continues to reconcile its own window with `messageVersion`.

## Mutation acknowledgements and broadcasts

Room metadata mutations that keep the room active, including rename and settings updates, return the canonical saved room in their acknowledgement. The initiating client applies that room immediately, which provides read-your-write behavior even when it does not receive its own broadcast. Other clients receive `room_updated` where the operation requires fan-out. Both paths use full-object replacement and the same version guard.

For a rename, the initiating client might receive an acknowledgement carrying `roomVersion: 61` and update its header at once. A `room_updated` event with the same version can arrive later through the broadcast path. Accepting an equal version is safe because both payloads describe the same durable write. Another client that still has version 60 accepts the broadcast and reaches the same room object.

The server broadcasts only after persistence succeeds. A failed write cannot publish a room state that durable storage does not contain. Duplicate acknowledgement and broadcast delivery converges because equal `roomVersion` values and repeated removal deltas are idempotent. Save, unsave, and delete acknowledgements also update the initiating page immediately; private-channel deltas converge its other tabs.

Message delivery follows the same division of labor. A send acknowledgement returns the canonical stored message to the sender, while `new_message` broadcasts it to the room, including other participants. History reads are private request/ack exchanges. A mutation that invalidates an entire window broadcasts only `message_history_invalidated`, prompting each participant to fetch a versioned snapshot.

The acknowledgement also removes a hidden dependency on Socket.IO fan-out. The initiating socket no longer has to hear its own broadcast before the UI reflects a successful change. If persistence fails, the handler returns an error and has no canonical room to acknowledge or broadcast.

Permission payloads have their own request generation. A newer `room_permissions` event invalidates an older fetch, and permission responses for a room that is no longer active are ignored.

## Posting boundaries and operation authorization

The server evaluates permissions when an operation is attempted. This covers message posting, media upload initialization and completion, message edits and deletes, room management, and code-agent access. A previously received permission snapshot cannot authorize a later operation by itself.

Posting schedules create time-based changes without a socket event. The client computes the next opening or closing boundary in the room timezone and schedules a permission refresh just after that instant. The server evaluates the current clock, and its response supplies the new `canPost` value.

Suppose a room allows posting on Monday from 09:00 through 17:00. At 08:59, the UI may correctly show posting as closed. The client schedules a refresh just after 09:00. It asks the server for permissions again and enables the composer only from that response. At 17:00, the same process closes it. If a sleeping tab runs the timer late, the server still evaluates the actual current time.

There is a second check at the posting boundary itself: `message.post` authorization runs when the message reaches the server. A stale open composer can therefore show an optimistic action briefly, but the server rejects the write after the window closes. Media upload initialization and completion perform the same current access and posting checks.

Client and server tests share the same schedule scenarios: inclusive starts, exclusive ends, overnight windows, room timezones, disabled schedules, empty schedules, and exact boundary instants.

## Failure handling

Disconnects, transport changes, and acknowledgement timeouts are treated as recoverable until their retry budget is exhausted. The room shell and cached content stay visible while controls remain locked. `unavailable` exposes a retry action without discarding the desired room.

A registration timeout and a join rejection lead to different recovery paths. A timeout may belong to a slow acknowledgement or a socket that changed mid-request, so the controller retries within its budget. A wrong password or confirmed access removal will not improve with another automatic attempt. That request becomes unavailable immediately and the page can ask the user for a password or navigate away.

Access rejection, a missing room, a rejected password, and disabled code-agent access end the current attempt. When a switch to another room fails, `MessagePage` selects the previous verified room again and can reopen password entry for the rejected target. The previous room is not abandoned until the server commits the new join.

Late results are handled by the same ownership rules. If room A is joining and the user selects room B, room A's completion is superseded. A later successful acknowledgement for A cannot change the controller snapshot. The controller sends `leave_room(A)` to clean any presence that the server may have committed, then continues waiting for B.

`room_removed` and confirmed access removal invalidate the persistent room cache, clear the active shell when applicable, remove the URL room parameter, and return the user to the room list. A late acknowledgement for the removed target cannot revive it.

The invalidation happens before navigation completes. This ordering prevents a delayed IndexedDB read, history payload, or join callback from repainting the removed room after the list view is already visible.

Register and join failures carry stable machine-readable codes such as `CLIENT_LOGIN_REQUIRED`, `ROOM_NOT_FOUND`, `ROOM_ACCESS_REMOVED`, and `ROOM_PASSWORD_REQUIRED_OR_INCORRECT`. The controller uses those codes to decide whether retrying can help, and `MessagePage` uses them for removal and password flows. Human-readable text is only presentation; changing or translating it cannot change recovery behavior.

## Production diagnostics

Production browser logs keep room recovery observable without recording passwords, auth tokens, or message content.

- `[room-session]` covers transport events, registration, join, phase changes, retries, epochs, readiness, and message synchronization requests.
- `[room-messages]` covers memory and persistent cache hydration, history requests, history responses, version decisions, reconciliation retries, and live messages.

For one investigation, correlate `roomId`, `socketId`, `sessionEpoch`, `messageSyncRequestId`, `requestId`, `requestedMessageVersion`, `mutationRevision`, and `messageVersion`. A normal stored-room restore usually follows this order:

```text
room-selected
connection-waiting
transport-connected / socket-connected
registration-attempt / registration-ready
join-attempt / join-acknowledged / room-ready
history-request / history-response
```

The following checks narrow common failures quickly:

| Symptom | What to inspect |
| --- | --- |
| `Timed out while registering client` | Confirm a transport connection, compare socket IDs around `registration-emitted`, and look for a late acknowledgement or socket replacement |
| `Failed to reconnect to the previously joined room` | Follow the epoch from disconnect through registration and join; check the terminal join error and whether a newer room intent superseded it |
| Room shell recovers but new messages are missing | Compare `messageSyncRequestId`, `baseMessageVersion`, `requestedMessageVersion`, and the response decision in `[room-messages]` |
| Media stays on `Loading media` | Confirm session readiness, signed URL authorization, the asset and room IDs, and whether an existing cached URL was retained |
| Foregrounding causes another join | A ready resume should log `message-sync-requested` without `join-attempt`; repeated join events indicate that readiness or socket identity changed |
| A stale room setting reappears | Compare `roomVersion` on the acknowledgement, broadcast, stored shell, and active room commit |

Within one epoch, the first successful membership commit should produce one `room-ready`. Foreground message synchronization may produce another history request. A different socket ID starts a new epoch and repeats registration and join.

Read the log as one story rather than as independent lines. `room-selected` identifies the desired room and epoch. `transport-connected` supplies the socket ID. `registration-ready` proves that identity is bound to that socket. `room-ready` proves that membership committed. The following `history-response` explains whether durable messages were accepted or rejected because the local window moved.

For example, a normal foreground resume on an already-ready socket changes `messageSyncRequestId` and produces another `history-request`. It should retain the same `sessionEpoch` and socket ID, with no `registration-attempt` or `join-attempt`. A join in that trace means the controller no longer considered the old membership valid, usually because the socket ID changed or the previous session had never reached ready.

## Change and verification contract

Recovery changes should be made at the layer that owns the affected state. A new lifecycle source belongs in the controller input path. A message race belongs in versioned reconciliation. A metadata race belongs in full-room convergence. Component-local join generations, repair timers, or parallel membership state reintroduce competing authorities.

The main automated contracts are:

- [`roomSessionController.test.ts`](../client-heroui/src/utils/roomSessionController.test.ts) covers state transitions, same-room coalescing, socket replacement, retries, supersession, message synchronization, and late acknowledgement cleanup.
- [`MessagePage.test.tsx`](../client-heroui/src/pages/MessagePage.test.tsx) covers restore, URL and manual room races, lifecycle resume, reconnect locking, rollback, whole-object replacement, list snapshot/delta replay, room versions, acknowledgement convergence, and posting refresh.
- [`useRoomMessageEvents.test.tsx`](../client-heroui/src/hooks/useRoomMessageEvents.test.tsx), [`MessageList.test.tsx`](../client-heroui/src/components/MessageList.test.tsx), and [`messageHistoryCache.test.ts`](../client-heroui/src/utils/messageHistoryCache.test.ts) cover cache hydration, live/history races, invalidation-driven reconciliation, pagination, batched persistence, preserved content, and interaction locking.
- [`roomState.test.ts`](../client-heroui/src/utils/roomState.test.ts) covers `roomVersion` ordering and legacy timestamp fallback.
- [`postingSchedule.test.ts`](../client-heroui/src/utils/postingSchedule.test.ts) and [`roomAuthorization.test.ts`](../server/src/socket/roomAuthorization.test.ts) keep client boundary timing aligned with server authorization.
- [`roomHandlers.test.ts`](../server/src/socket/roomHandlers.test.ts) covers independent registration and list requests, overlapping membership mutations, idempotent rejoin, access revocation, deletion, delta broadcasts, and disconnect cleanup.
- [`messageHandlers.test.ts`](../server/src/socket/messageHandlers.test.ts) covers history authorization and message mutation acknowledgement and broadcast behavior.
- [`storeContract.test.ts`](../server/src/repositories/storeContract.test.ts) and [`redisStore.test.ts`](../server/src/repositories/redisStore.test.ts) cover monotonic room and message versions, membership persistence, cross-instance room access locking, presence, cache validity, and media history.

Any fix for a new race should add an event-sequence or convergence test at the owning layer. The test should reproduce the ordering that caused the failure, including late acknowledgements or lifecycle events when they are part of the path.
