# Room Restore Review and Fix Record

[中文](room-restore-review-fix-plan.zh.md)

Status: Historical fix plan and adversarial review record; its scheduler has been superseded
Reviewed: 2026-07-13

> This file preserves the failures and review reasoning that led to the final
> architecture. Its per-room suppression and shared in-flight scheduler are not
> current implementation instructions. Use the [Room Session Controller architecture](../room-session-controller-design.md)
> for the implemented state machine and source-of-truth boundaries.

## Purpose

This record challenged the first mobile room-recovery design and converted broad ideas into reviewable implementation steps. It is valuable because it records which seemingly reasonable fixes were still unsafe.

## Review Findings

### Too many owners

Visibility, focus, online, socket reconnect, URL restore, and manual selection each initiated their own register/join/fetch sequence. Debouncing one listener did not prevent another listener from duplicating the same work.

**Decision:** one scheduler owns all recovery work and receives trigger reasons.

### In-flight work was not reused

A boolean guard could skip a second caller without giving it the result of the active operation. UI layers then made inconsistent assumptions about success.

**Decision:** store and return the in-flight promise, keyed by intended room/client.

### Suppression could block legitimate retry

A timer-only debounce remained active after a failed attempt, so an immediate reconnect signal could be ignored.

**Decision:** failure/disconnect clears suppression immediately; successful bursts retain the short window.

### Recovery cleared useful state too early

Member counts or room state were reset before the replacement request completed, creating visible empty intermediate UI and duplicate spinners.

**Decision:** preserve/guard last known state until authoritative replacement arrives.

### Errors were intentionally ignored

Callbacks named `_error` hid room-not-found, permission, registration, and network failures.

**Decision:** classify expected background/transient outcomes, but surface failures that block active foreground intent.

### Password behavior was underspecified

Blind rejoin could prompt repeatedly or leave a valid current room before discovering that the new join failed.

**Decision:** reuse active password only in-session, validate before leaving current room, and serialize the final room intent.

### Stale async commits

An earlier join could complete after the user selected another room or another socket deleted the target.

**Decision:** compare desired room/client/version before applying results and make deletion win over stale snapshots.

## Implementation Sequence

### PR1: Scheduler foundation

- Introduce trigger reasons, desired-room identity, in-flight promise reuse, and per-room suppression.
- Route existing recovery triggers through one entry point without changing product behavior first.
- Add deterministic scheduler tests.

### PR2: Registration and idempotent join

- Separate transport connection, RoomTalk registration, and room join state.
- Make rejoin of the current room idempotent.
- Serialize overlapping join/leave operations and protect against stale commit.

### PR3: Password and feedback

- Reuse active password within the session.
- Add foreground/background recovery policy and delayed progress UI.
- Keep last known member state until replacement.
- Surface actionable errors.

### PR4: Lifecycle and race completion

- Cover BFCache/pageshow, visibility, online, focus, socket reconnect, deletion, room switching, and disconnect cleanup.
- Ensure listeners/timers/in-flight state are cleaned and do not survive stale component instances.

## Review Invariants

- One trigger burst produces one register/join sequence.
- Every caller can await the same result.
- Failure never suppresses the next legitimate retry.
- User intent that changes while awaiting network work wins.
- Rejoin cannot double-count presence.
- A failed password-protected target does not destroy the current valid room state.
- Recovery feedback reflects user impact, not merely network activity.
- Authoritative server room state replaces local state under a monotonic version.

## Remaining Debt

Some room socket acknowledgements still expose string errors, and the client retains a `/room not found/i` compatibility match. Stable error codes such as `ROOM_NOT_FOUND`, `ROOM_ACCESS_DENIED`, and `AUTH_REQUIRED` would make recovery classification less fragile.

## Lesson

The adversarial review mattered because each isolated fix—debounce, reconnect, retry, spinner—looked plausible. Reliability came from defining one owner, one desired state, explicit commit guards, and observable failure semantics across the full chain.
