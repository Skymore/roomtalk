# Restoring Mobile Browser Room Sessions: Engineering Strategy

[中文](mobile-room-restore-strategy.zh.md)

Status: Historical design record; its recovery scheduler has been superseded
Reviewed: 2026-07-13

> The trigger inventory and failure analysis remain useful, but the scheduler,
> suppression-window, and in-flight model below are not the current
> implementation. Use the [Room Session Controller architecture](../room-session-controller-design.md)
> for current ownership, epoch/revision rules, retry behavior, and diagnostics.

## Problem

Mobile browsers frequently suspend JavaScript, close network sockets, restore pages from BFCache, change networks, or keep a stale Socket.IO object that still appears connected. Users returned to a room and saw missing messages/member counts, duplicate restore spinners, password prompts, or a UI that required manual refresh.

The original code had several independent recovery triggers. Each could register, rejoin, fetch rooms, or clear state, creating duplicate work and races. A boolean “connected” check was not enough to prove that the server still associated this socket/client with the desired room.

## Design Principle

Treat browser connection state as untrusted. Recovery is an idempotent reconciliation toward a desired room, not a one-shot reconnect callback.

```text
foreground/pageshow/online/focus/socket reconnect/manual/url restore
  -> one recovery scheduler
  -> suppress duplicate per-room triggers briefly
  -> reuse in-flight register/join work
  -> verify client registration
  -> ensure desired room joined
  -> refetch authoritative room/history/member state
  -> apply whole server objects by monotonic version
```

## Trigger Model

Potential signals include:

- Socket.IO `connect`/`reconnect`;
- `visibilitychange` to visible;
- `pageshow`, including BFCache restoration;
- browser `online`;
- window focus;
- explicit room selection or URL restore;
- password submission/manual retry.

Signals do not each own recovery. They enqueue the same operation with a reason and foreground/background feedback policy.

## Scheduler

- Key work by desired room/client rather than raw event.
- Reuse the current in-flight promise so overlapping triggers observe one result.
- Apply a short (then-current value: 250 ms) per-room suppression window to collapse bursts after foregrounding.
- Clear suppression immediately on failure or disconnect so a legitimate retry is not blocked.
- Let explicit user actions supersede stale background intent.
- Before committing results, verify that the desired room/client has not changed.

The scheduler separates “a trigger arrived” from “network work must start.”

## Registration and Join

Socket transport connection does not guarantee RoomTalk registration or room membership. Recovery first ensures the client identity/token registration is accepted, then calls an idempotent `ensureRoomJoined` for the current desired room.

Rejoining the same room must not double-count presence. Switching rooms serializes leave/join intent. Deletion or permission changes observed during an in-flight join prevent the stale room snapshot from committing.

## Password Rooms

Within the active browser session, recovery can reuse the accepted room password rather than prompting after every mobile suspend. A full page reload does not persist raw passwords; restoration then depends on durable membership or explicit re-entry. This is an accepted security/product boundary.

## Feedback

- User-initiated, storage, manual, or URL restore displays progress.
- Background health recovery stays quiet when fast.
- A delayed indicator appears only if background recovery exceeds roughly 400 ms.
- Failures that affect the active foreground intent are visible; they are not swallowed by callback variables such as `_error`.
- Member counts and last known room state remain guarded during recovery rather than being cleared before replacement data arrives.

## State Reconciliation

After join, RoomTalk reads authoritative room/message/member state. Server room objects replace local objects wholesale under monotonic `roomVersion`; spreading partial updates is not allowed because removed optional fields would remain stale. Message history and realtime events converge through durable IDs/positions and current room intent.

## Failure Cases Covered

- Socket claims connected but server registration was lost.
- Four foreground signals fire together.
- BFCache restores stale closures/local state.
- The desired room changes while recovery awaits an acknowledgement.
- Password-protected rejoin fails without leaving the current valid room.
- A room is deleted during join.
- First recovery attempt fails, then network reconnects immediately.
- Member count request returns before/after room acknowledgement in a different order.

## Verification

At the time, automated coverage exercised scheduler deduplication, suppression reset, in-flight reuse, desired-room races, password reuse, foreground/background indicators, whole-object application, and socket join/leave serialization. The current controller coverage is listed in the current architecture document. Real-device checks still matter for suspension duration, BFCache, network switching, and browser lifecycle behavior.

## Future Option

Redis presence TTL/heartbeat can improve server-side cleanup of abandoned mobile sockets, but it is not a substitute for client reconciliation and durable room membership.

## Lasting Lesson

Recovery becomes reliable when all triggers converge on one idempotent state machine and the browser stops treating transport flags or cached room objects as authority.
