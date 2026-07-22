# Documentation Audit

[中文](documentation-audit.zh.md)

Status: Current documentation contract
Audited: 2026-07-21

This document explains where each kind of truth belongs and records the facts checked in the latest audit. It is not another architecture guide or deployment runbook.

## Source ownership

| Source | What it owns |
| --- | --- |
| Source code and tests | Final authority for runtime behavior and protocol details. |
| `README.md` / `README.zh.md` | Product overview, current topology, the main technical decisions, and navigation. |
| `docs/room-reliability-architecture*.md` | The room synchronization protocol: immutable events, fast path, replay, snapshot, AI transient delivery, ordering, and recovery. |
| `docs/room-event-sync-portable-deployment*.md` | Deployment topology, storage boundaries, production cutover, rollback, and AWS mapping. |
| `docs/room-event-sync-portable-deployment-progress*.md` | A compact evidence ledger of completed stages, commits, tests, migrations, and production checks. |
| `DeploymentGuide.md` / `部署指南.md` | The operator runbook for backup, maintenance-window release, verification, and rollback. |
| `docs/configuration*.md` | Environment-variable groups and configuration ownership. |
| `docs/interview-preparation.html` | A detailed bilingual narrative for explaining the project and answering follow-up questions. |
| `docs/README*.md` | The complete categorized documentation index. |

Subsystem references, retrospectives, completed plans, and review reports stay in the index because they preserve useful reasoning or evidence. They must not present old configuration as the current runtime.

## Writing contract

- Current documents carry an `Updated`, `Verified`, or audit date.
- English and Chinese current documents agree on dates, commands, limits, names, and architecture facts. The interview guide is one bilingual HTML file.
- The README gives the reader the whole system shape. Deeper documents add mechanism, evidence, or procedure instead of repeating the same introduction.
- Architecture documents explain why the system works. The progress ledger records what shipped. The runbook tells an operator what to do.
- Historical numbers, branch names, machine sizes, and commit IDs are labeled as snapshots.
- `CLAUDE.md` and `AGENTS.md` contain agent instructions. Human contribution rules live in `CONTRIBUTING`.

## Facts verified in this pass

### Room synchronization and AI delivery

- PostgreSQL canonical tables and the bounded per-room `room_events` log are the only durable synchronization boundary. Each event stores a strict immutable V1 after-image in the same business transaction; replay never hydrates an old sequence from a current row.
- PostgreSQL `NOTIFY` is a committed wake-up hint. Every listening app coalesces same-room watermarks in fixed state, skips payload reads without local subscribers, batch-reauthorizes local sockets before complete payloads, and uses `io.local` for its attached clients. Authorization unavailability degrades to head-only without falsely removing users.
- A contiguous Socket payload is a latency fast path. Missing payloads replay from PostgreSQL; an individually oversized event, a gap over 500 events, or an expired cursor uses a repeatable-read snapshot. A deleted stream returns its final tombstone directly because it has no snapshot.
- The per-room `idle/replay/replace/prepend` state machine gives recovery priority over pagination and invalidates prepend on live mutation. `CURSOR_AHEAD` clears stale pre-restore head and gap targets; a stale `beforeMessageId` causes a replacement snapshot.
- Public membership events reveal only `members.changed`. IDs and roles remain behind `get_room_role_members`. Strict payload validation stops cursor advancement on malformed stored data.
- `ai_chunk` and A2UI updates are bounded transient fast paths. Early events wait by `messageId` for the durable placeholder, and their reducers update canonical and visible React state separately so optimistic messages survive.
- `ai_stream_error` declares `persisted`. The normal path carries the exact persisted safe Message; a failed immediate write uses `persisted: false`, terminalizes the local placeholder, and enters in-process exponential retry. PostgreSQL owner leases allow takeover only after the live stream owner expires.
- Redis presence is owned by a unique runtime instance with TTL heartbeats; Code Agent recovery respects unexpired fenced leases; recovery and retention use PostgreSQL advisory locks. Rolling startup no longer clears another live instance's users or tasks.
- Health has three explicit meanings: process liveness, dependency-backed readiness, and degraded. Readiness performs real PostgreSQL, Redis, object-storage, and Socket-adapter checks; a failed database reports `rooms: null`, never `rooms: 0`.
- PostgreSQL rejects a message ID changing rooms, event retention uses wall-clock materialization timestamps, and deletion clears room media cache even for assets outside the loaded window.
- GitHub CI uses Node 24.18, provisions PostgreSQL 17, and forces the real trigger/transaction/lease/advisory-lock suite to run instead of silently skipping.

### Deployment and portability

- The infrastructure and data cutover to MacBook Compose, PostgreSQL, Redis, SeaweedFS, and Cloudflare Tunnel completed on 2026-07-20.
- The immutable event protocol reached production on 2026-07-21 under a maintenance window. The old app was stopped before migrations `0003` and `0004`; paired PostgreSQL and object-store backups were taken first.
- Production verification covered container health, migration records, public status, forced WebSocket transport, committed fast-path payloads, snapshot, replay, deleted-room tombstones, and cleanup.
- AWS migration is a controlled mapping, not a one-click claim: the image maps to ECS/Fargate or EKS, PostgreSQL to RDS/Aurora, Redis to ElastiCache, and unchanged object keys to S3. A short write pause can use dump/restore plus a final object delta; zero downtime requires logical replication, CDC, or DMS.

### Interview guide corrections

- Durable room-event fan-out uses PostgreSQL plus `io.local`; not every Socket.IO event crosses the Redis adapter.
- Presigned object transfer removes large byte streams from the app, but signing and metadata still pass through it. SeaweedFS is described by the actual private S3-compatible boundary rather than AWS-specific bucket controls.
- Browser media cache capacity is 20% of the reported storage quota, capped at 1 GiB, with a 300 MB fallback when quota information is unavailable.
- `setTimeout(..., 0)` schedules a later task, not a microtask. History examples use the current `beforeMessageId` request path.
- The CJK heuristic counts roughly one token per CJK character and one per four non-CJK characters.
- Public HTTPS/WSS terminates TLS at the edge. PostgreSQL and Redis currently communicate on the private Compose network without TLS.
- Object storage still has throughput, request-rate, latency, lifecycle, and cost limits. Test-database name guards reduce accidental production access; they do not make it impossible.
- The current sticker catalog contains 2,149 entries. The picker renders the active page and one page on either side, and caps each nearby-image preload set at 48.
- The media viewer supports downward return at both 1x and zoomed states. A zoomed image consumes horizontal movement as pan first, then hands continued outward movement to carousel paging at the image boundary.
- RAF batching is the implemented 60fps optimization. The 30fps-before and 60fps-after figures are retained as manual target-device profile observations, not presented as an automated repository benchmark.
- AI role drafting currently allows 5 requests per source IP per 10 minutes on each app instance. A multi-instance global limit would require shared rate-limit state.
- SSE remains a valid one-way AI streaming transport. RoomTalk reuses Socket.IO because room acknowledgments, identity context, and reconnect recovery already live there, not because AI data must use one channel.
- The project-metrics card says `180+` test/spec files; the 2026-07-21 repository snapshot contains 184 files named `*.test.*` or `*.spec.*`.

## Remaining product follow-ups

- Replace room Socket string and regex error handling with stable error codes, especially `ROOM_NOT_FOUND`.
- Complete automated media-viewer coverage for pinch, edge resistance, velocity-only commits, keyboard controls, and single-tap delay.
- Move the in-memory AI role-draft limiter to shared state before horizontal app scaling if the limit must be global.

These are implementation follow-ups, not unresolved documentation ambiguity.

## Validation

A documentation change is complete when:

- index links resolve;
- every human-facing Markdown document has its expected language counterpart, or is explicitly bilingual;
- commands, environment names, protocol limits, migration state, and deployment claims match the repository and current runtime;
- Markdown and HTML remain parseable; and
- `git diff --check` passes.
