# Room Update Does Not Refresh: End-to-End Analysis

[中文](room-update-stale-analysis.zh.md)

Status: Historical root-cause analysis; the described pre-fix bugs are implemented/fixed
Reviewed: 2026-07-12

## Symptoms

- Disabling a posting schedule left old schedule fields visible.
- Refreshing could preserve the stale value because local persistence rehydrated it.
- Leaving/rejoining or clearing storage appeared to fix the UI.
- A posting input did not automatically unlock when the configured time boundary passed.

## End-to-End Chain

```text
room mutation
  -> durable store update
  -> acknowledgement + room_updated broadcast
  -> client room reducer
  -> localStorage persistence
  -> selectors/forms/posting availability
```

The database update itself was not the whole problem. The client merged server objects into old local objects:

```ts
nextRoom = { ...oldRoom, ...serverRoom }
```

When the server intentionally omitted or cleared an optional field, the old client key could survive. The merged stale object was then persisted to localStorage and returned after refresh, making a transient reducer bug durable.

## Root Causes

### Partial-merge assumption

The server emitted a complete room representation, but the client treated it as a patch. Optional-field deletion cannot be represented reliably by ordinary spread merge when absence has semantic meaning.

### No monotonic ordering

Timestamp comparison was not a sufficient conflict rule: clocks/serialization precision can collide, and an older response can arrive after a newer broadcast.

### Read-your-write gap

Some mutation flows updated optimistically or waited for a later broadcast rather than applying the authoritative room returned in the acknowledgement. The initiating client could remain stale even while other clients updated correctly.

### Time-derived permission snapshot

`canPost` was computed at request time. No event necessarily occurs at the next schedule boundary, so the UI could remain locked/unlocked past the real transition.

## Final Design

### Whole-object replacement

`applyServerRoom` treats a validated server room object as complete truth. It replaces the local object rather than spreading into it, allowing removed optional fields to disappear.

### Monotonic `roomVersion`

Every durable room mutation increments one server-side version (`room_version` in PostgreSQL and atomic Lua behavior in Redis). Clients apply only newer versions; equal versions are the same write. `updatedAt` is a legacy fallback, not the primary ordering key.

### Acknowledgement read-your-write

Mutation acknowledgements return the complete saved room. The initiating client applies it immediately; `room_updated` converges other clients. Both paths use the same versioned replacement function, so duplicate delivery is harmless.

### Local persistence follows authority

Only the accepted canonical room object is written to local storage. Rehydrated data is considered a cache and is replaced when current server state arrives.

### Posting-boundary revalidation

Client and server share timezone/overnight schedule vectors. The client calculates the next boundary, schedules a refresh, and asks the server again rather than locally changing authorization without confirmation.

## Multi-Client Cases

- Two admins update settings concurrently: the higher durable version wins everywhere.
- Ack and broadcast arrive in either order: duplicate/equal version is idempotent.
- An old room-list request returns late: lower version cannot overwrite a newer mutation.
- Optional field is cleared: whole replacement removes it locally and from persistence.
- Boundary passes with no socket event: scheduled revalidation obtains current server permission.

## Verification

Tests cover complete replacement, field removal, local persistence, monotonic ordering, equal-version idempotency, acknowledgement application, out-of-order broadcast/list responses, Redis/PostgreSQL version increments, schedule timezones/overnight windows, and next-boundary refresh.

## Lesson

The bug looked like “React did not refresh,” but the real issue was an undefined state-transfer contract. Decide whether server payloads are patches or complete objects, give them a monotonic version, and close the initiating client's read-your-write gap.
