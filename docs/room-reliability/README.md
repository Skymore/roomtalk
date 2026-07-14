# Room Reliability Series: Index and Overview

[中文](README.zh.md)

Status: Engineering retrospective with a current-architecture pointer
Reviewed: 2026-07-13

This series records the 2026-06-08 through 2026-06-10 engineering line that began with three user-visible symptoms. Its room-object, ordering, acknowledgement, and posting-window conclusions remain current. Its intermediate reconnect scheduler was replaced on 2026-07-13 by the [Room Session Controller architecture](../room-session-controller-design.md). Detailed file lines and test counts are historical snapshots; source and current tests remain authoritative.

The main remaining protocol debt is stable socket error codes: some client recovery still recognizes `/room not found/i`, while many room acknowledgements still return only string errors.

## Symptom to Root Cause to Fix

| Symptom | Root cause | Fix |
| --- | --- | --- |
| Room restore spun twice and the first pass showed no members | Multiple lifecycle/socket owners issued overlapping work; failures were hidden; recovery cleared useful state too early | The historical scheduler first reduced duplication; the current controller gives connect/register/join/retry one owner, separates session epochs from history resync, and preserves rendered content |
| Disabling a posting schedule remained stale even after refresh | Client spread-merged a server room object, so fields omitted by the server could never disappear and stale values survived in local storage | Treat server room objects as complete truth, replace wholesale, and use acknowledgement read-your-write |
| Posting input did not unlock when a schedule boundary passed | `canPost` was a server-time snapshot and nothing recalculated it at the next boundary | Mirror timezone/overnight math, schedule the next boundary, then refetch authorization instead of flipping locally |

## Current Invariants

- **Session ownership:** `RoomSessionController` alone owns connect, registration, desired room, join/rejoin, retry budget, phase, epoch, and resync revision. React and browser lifecycle handlers only submit intent or subscribe.
- **Epoch and resync:** `sessionEpoch` changes only for a room change or replacement socket ID. Join acknowledgements do not advance it. Ready transitions and coalesced foreground lifecycle signals advance the separate `resyncRevision`; already-ready sessions do not join again.
- **Content continuity:** transient `connecting`/`registering`/`joining`/`retrying` phases block new privileged work but keep cached messages and already resolved media visible.
- **Feedback:** user-initiated/storage/URL restore shows progress. A brief reconnect is visually delayed to avoid flicker; that UI delay is not a recovery scheduler.
- **Room state:** the server object is complete truth and is replaced wholesale. `roomVersion` is monotonic; equal versions represent the same write. `updatedAt` is only a legacy fallback.
- **Password rooms:** the controller retains the desired-room password inside the browser session; full-page restoration relies on durable membership.
- **Posting windows:** client and server share timezone/overnight test vectors; the client asks the server again at the next boundary.
- **Protocol debt:** replace string errors and regex matching with stable error codes.

## Documents

| Document | Use it for |
| --- | --- |
| [Room Session Controller architecture](../room-session-controller-design.md) | **Current** ownership, phase/epoch/revision rules, content continuity, diagnostics, and source-of-truth paths |
| [Mobile restore strategy](mobile-room-restore-strategy.md) | **Historical** trigger inventory, intermediate scheduler design, password-room reasoning, and acceptance flows |
| [Restore review and fix plan](room-restore-review-fix-plan.md) | **Historical** adversarial review and the failure modes that motivated the controller |
| [Stale room update analysis](room-update-stale-analysis.md) | Whole-object replacement, version ordering, local persistence, and schedule state |
| [Room-update review follow-up](room-update-review-followup.md) | Read-your-write acknowledgements and residual protocol concerns |

## Interview Summary

The key lesson is to stop treating a WebSocket connection or locally cached room object as truth. One controller owns the room-session state machine; server room objects replace local state under a monotonic version; acknowledgements close the read-your-write gap; and time-based permissions are revalidated at their real boundary.
