# Room Reliability Series: Index and Overview

[中文](README.zh.md)

Status: Important engineering retrospective with reverified current invariants
Reviewed: 2026-07-12

This series records the 2026-06-08 through 2026-06-10 engineering line that began with three user-visible symptoms and ended in the current room restoration and synchronization architecture. Detailed file lines and test counts are historical snapshots; source and current tests remain authoritative.

The main remaining protocol debt is stable socket error codes: some client recovery still recognizes `/room not found/i`, while many room acknowledgements still return only string errors.

## Symptom to Root Cause to Fix

| Symptom | Root cause | Fix |
| --- | --- | --- |
| Room restore spun twice and the first pass showed no members | Four recovery triggers issued overlapping work; first failures were hidden; recovery cleared member cache too early | One recovery scheduler, per-room suppression, in-flight reuse, visible foreground failures, and guarded member state |
| Disabling a posting schedule remained stale even after refresh | Client spread-merged a server room object, so fields omitted by the server could never disappear and stale values survived in local storage | Treat server room objects as complete truth, replace wholesale, and use acknowledgement read-your-write |
| Posting input did not unlock when a schedule boundary passed | `canPost` was a server-time snapshot and nothing recalculated it at the next boundary | Mirror timezone/overnight math, schedule the next boundary, then refetch authorization instead of flipping locally |

## Current Invariants

- **Recovery scheduling:** foreground triggers plus a 250 ms per-room suppression window and shared in-flight work; failures/disconnects clear suppression so retry remains possible.
- **Feedback:** user-initiated/storage/URL restore shows progress; background restore stays quiet unless it exceeds 400 ms.
- **Room state:** the server object is complete truth and is replaced wholesale. `roomVersion` is monotonic; equal versions represent the same write. `updatedAt` is only a legacy fallback.
- **Password rooms:** an active password can be reused inside the browser session; full-page restoration relies on durable membership.
- **Posting windows:** client and server share timezone/overnight test vectors; the client asks the server again at the next boundary.
- **Protocol debt:** replace string errors and regex matching with stable error codes.

## Documents

| Document | Use it for |
| --- | --- |
| [Mobile restore strategy](mobile-room-restore-strategy.md) | Trigger model, scheduler, feedback, password-room behavior, and acceptance flows |
| [Restore review and fix plan](room-restore-review-fix-plan.md) | Adversarial review findings and why the final recovery guards exist |
| [Stale room update analysis](room-update-stale-analysis.md) | Whole-object replacement, version ordering, local persistence, and schedule state |
| [Room-update review follow-up](room-update-review-followup.md) | Read-your-write acknowledgements and residual protocol concerns |

## Interview Summary

The key lesson is to stop treating a WebSocket connection or locally cached room object as truth. Recovery work is deduplicated and idempotent; server room objects replace local state under a monotonic version; acknowledgements close the read-your-write gap; and time-based permissions are revalidated at their real boundary.
