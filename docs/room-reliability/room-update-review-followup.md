# Room Update Fix: Second Review and Follow-Up

[中文](room-update-review-followup.zh.md)

Status: Completed historical follow-up; later monotonic `roomVersion` supersedes the earlier timestamp-only LWW step
Reviewed: 2026-07-12

## Context

The first stale-room fix moved the client toward whole-object replacement and used `updatedAt` as a last-write-wins signal. A second review found that replacement was correct but timestamp ordering and mutation acknowledgement behavior were still not strong enough for multiple clients and overlapping reads.

## Second-Review Findings

### Timestamp LWW was ambiguous

Two writes can share timestamp precision, clocks and serialization may differ, and a late response may have a plausible timestamp. The client needed a server-owned monotonic sequence rather than a wall-clock comparison.

### Initiating client needed authoritative ack data

Relying only on broadcast means the writer can observe a gap or miss its own update during reconnect. A success acknowledgement that contains only `{ ok: true }` does not close read-your-write.

### Every room ingress must share one rule

Room list fetches, join acknowledgements, settings acknowledgements, rename results, saved-room reads, and socket broadcasts can all introduce a room object. If one path spread-merges or ignores version, stale state returns.

## Follow-Up Changes

1. Add durable `room_version` and increment it for every canonical room mutation.
2. Implement equivalent atomic increment semantics in Redis Lua paths.
3. Return the complete saved room from mutation acknowledgements.
4. Route ack/broadcast/list/join/storage updates through the same `applyServerRoom` replacement/version guard.
5. Treat equal versions as idempotent duplicate delivery.
6. Keep `updatedAt` only for legacy records without a version.
7. Add multi-client and out-of-order regression tests.

## Third-Round Result

The final rule is:

```text
incoming roomVersion > local -> replace
incoming roomVersion == local -> same write / no-op or safe replace
incoming roomVersion < local -> ignore
missing version -> legacy updatedAt fallback
```

Optional fields are removed because accepted objects replace the prior object. Local persistence stores only the accepted result.

## Acknowledgement Contract

The mutation is successful only when durable storage returns the canonical updated room. The server then both acknowledges the caller with that room and broadcasts it to other members. If persistence rejects/fails, neither path emits a ghost update.

## Remaining Protocol Debt

Room errors still need stable machine-readable codes. String-only errors make recovery, permission, deletion, and password cases harder to classify consistently across languages and clients.

## Lesson

Whole-object replacement fixes deletion semantics; monotonic versions fix ordering; authoritative acknowledgements fix read-your-write. All three are required for a reliable multi-client room model.
