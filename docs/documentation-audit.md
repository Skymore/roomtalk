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
- PostgreSQL `NOTIFY` is a committed wake-up hint. Every listening app reads the exact event row and uses `io.local` for its attached clients. Redis adapter fan-out remains for genuinely single-origin transient or global events.
- A contiguous Socket payload is a latency fast path. Missing or oversized payloads replay from PostgreSQL; gaps over 500 events or an expired cursor use a repeatable-read snapshot. A deleted-room tombstone is the exception because a deleted room has no snapshot.
- `CURSOR_AHEAD` clears the stale pre-restore target before loading a snapshot. Notifications that arrive while the snapshot is in flight establish a fresh target, so recovery neither discards new work nor polls the restored head forever.
- Public membership events reveal only `members.changed`. IDs and roles remain behind `get_room_role_members`. Strict payload validation stops cursor advancement on malformed stored data.
- `ai_chunk` and A2UI updates are bounded transient fast paths. Early events wait by `messageId` for the durable placeholder, and their reducers update canonical and visible React state separately so optimistic messages survive.
- A user-visible AI failure is persisted as a complete Message first. `ai_stream_error` may carry that exact Message as a fast path; it does not invent Socket-only canonical text. Arrival order therefore cannot change the final UI.

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

## Remaining product follow-ups

- Replace room Socket string and regex error handling with stable error codes, especially `ROOM_NOT_FOUND`.
- Complete automated media-viewer coverage for pinch, zoomed-image swipe suppression, edge resistance, velocity-only commits, keyboard controls, and single-tap delay.

These are implementation follow-ups, not unresolved documentation ambiguity.

## Validation

A documentation change is complete when:

- index links resolve;
- every human-facing Markdown document has its expected language counterpart, or is explicitly bilingual;
- commands, environment names, protocol limits, migration state, and deployment claims match the repository and current runtime;
- Markdown and HTML remain parseable; and
- `git diff --check` passes.
