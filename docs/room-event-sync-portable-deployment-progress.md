# Room event and self-hosted cutover record

[中文](room-event-sync-portable-deployment-progress.zh.md)

Status: completed source, infrastructure, data, immutable-event, and ownership-model production cutovers

Verified: 2026-07-22

This is the evidence ledger for the RoomTalk migration from Fly/Supabase/Tigris to MacBook Compose and for the later room-event protocol replacement. It records what changed, when production crossed each boundary, and which checks passed. Runtime semantics belong in [Room Reliability Architecture](room-reliability-architecture.md); topology and future migration guidance belong in [Room Event Sync and Portable Deployment](room-event-sync-portable-deployment.md).

## Two cutovers, not one

The work reached production in two maintenance windows:

1. On 2026-07-20, the application, PostgreSQL data, Redis realtime state, and S3-compatible objects moved from Fly/Supabase/Upstash/Tigris to Docker Compose on the MacBook. Cloudflare Tunnel became the public edge for `room.ruit.me`, `roomtalk.ruit.me`, and `roomtalk-objects.ruit.me`.
2. On 2026-07-21, production replaced the retained ID-only room-event history with strict immutable after-images. Migration `0004` also removed member IDs and roles from the public stream. This second boundary required another backup and a complete stop of old app processes.

Keeping these dates separate prevents an easy documentation mistake: the database host moved before the final event payload protocol was deployed.

## Change ledger

Implementation started from local `master` at `d94d2cd0`.

| Stage | Result | Evidence commit |
| --- | --- | --- |
| 1 | Architecture decision, evidence ledger, initial Compose runtime | `ec0ac9af` |
| 2 | PostgreSQL event stream, snapshot/replay client, retired version fields, integration/E2E coverage | `d2c051ab` |
| 3 | Operations rehearsal and first documentation consolidation | `63ef29bc` |
| 4 | Persistent local media, signed URLs, Compose env checks, paired restore rehearsal | `77a5826c` |
| 5 | Mac production runtime, SeaweedFS target, source-data rehearsal, tunnel, backup/restore | `bdad6d2f`, `94d7feed`, `f878752d` |
| 6 | Final write freeze, log archive, data restore, DNS routes, public edge smoke, explicit credentials | `a554554c`, `56871060` |
| 7 | Committed-event Socket fast path, byte-bounded fallback, large-gap snapshot | `1201ba88` |
| 8 | Immutable after-images, `io.local` fan-out, listener anti-entropy, one-time legacy boundary | `c3650de8` |
| 9 | Public member privacy, strict payload validation, early AI transient buffer | `609c5e3c` |
| 10 | Optimistic-send preservation and database-independent payload tests | `a8afcf49` |
| 11 | `CURSOR_AHEAD` stale-watermark reset and deterministic persisted AI error fast path | `fbfd908b` |
| 12 | Per-room sync state machine, authorization barrier, coalesced broadcaster, immutable message room, mandatory PostgreSQL CI | `b607ad7a` |
| 13 | AI and outbox fencing, converged Socket identity, atomic Redis leases, strict readiness | `a3b90e0c` |
| 14 | Transactionally serialized PostgreSQL schema initialization for multi-instance DDL safety | `81b2b74e` |
| 15 | Recoverable AI startup, atomic run start, one-at-a-time claims, isolated invalid sockets, migrate/verify schema lifecycle | `f389bdce` |

The scheduled Fly workflow remains disabled and Fly machines remain at zero. Supabase, Tigris, and Upstash are rollback sources, not live writers. `ai-chat.wenlin.dev` is still an allowed origin whose DNS is managed separately.

## Production evidence

### Infrastructure and data, 2026-07-20

The final Supabase dump restored 98 rooms, 7,939 messages, 179 members, 404 media assets, 6,361 observability events, 28 outbox events, and 60 room-agent turns into PostgreSQL 17. The Tigris copy verified 2,857 objects and 1,302,853,579 bytes across private media, published sites, and stickers. A paired PostgreSQL archive and SeaweedFS snapshot were restored into isolated targets, and sampled object SHA-256 values matched.

Public verification covered TLS, HTTP, Socket.IO polling and WebSocket upgrade, snapshot and delta reads, presigned PUT/GET byte equality, and deletion cleanup. A real PostgreSQL restart preserved the marker and event head; the pool handled the disconnect and re-established `LISTEN room_event_committed` without an uncaught exception.

### Immutable event protocol, 2026-07-21

The release created:

- `backups/roomtalk-20260721T110310Z.dump`
- `backups/roomtalk-object-storage-20260721T110310Z.tar.gz`

It then stopped `cloudflared` and the old app, built commit `fbfd908b`, and started only the new image. Startup logs recorded `0003_room_events_immutable_after_images` and `0004_public_member_change_events` before the listener, Redis adapter, outbox worker, and HTTP server became ready.

A read-only production query confirmed migrations `0001` through `0004`, zero non-V1 retained events, and only authorized `room.deleted` cutover tombstones from legacy streams. The public status endpoint reported PostgreSQL, Redis, media storage, and Socket adapter ready with 98 rooms.

The public WSS smoke used a temporary room and proved this sequence:

```text
register -> create -> join -> send
  -> committed messages.upserted Socket payload
  -> repeatable-read snapshot contains the same message
  -> replay from seq 0 contains the same after-image
  -> delete -> authorized room.deleted replay
  -> cleanup complete
```

The smoke used WebSocket transport, reached `snapshotSeq=3`, replayed three events, and removed the temporary room.

### Convergence hardening, 2026-07-21

Commit `b607ad7a` reduced the remaining concurrency state space instead of adding independent recovery flags. The browser now coordinates replay, replacement recovery, and historical prepend through one per-room `idle/replay/replace/prepend` controller. An unpersisted AI terminal error can no longer leave a placeholder streaming; deleting the current window no longer proves that older history is absent; and `CURSOR_AHEAD` clears both obsolete high-water state and the previous large-gap target.

On the server, same-room PostgreSQL notifications coalesce into sequence ranges. Before a complete after-image payload is emitted, each instance rechecks PostgreSQL membership and removes unauthorized local sockets. Listener generations close and ignore stale clients. Migration `0005_message_room_immutability_and_event_clock` rejects moving an existing message ID into another room and changes retained-event time to wall-clock `clock_timestamp()`.

Production rebuilt and restarted from `b607ad7a`. Startup logs recorded migration `0005`, `LISTEN room_event_committed`, Redis adapter initialization, outbox worker startup, and zero pending broadcaster work. PostgreSQL, Redis, SeaweedFS, and the app were healthy; Cloudflare Tunnel was running. Loopback and both `room.ruit.me` and `roomtalk.ruit.me` reported `online`, PostgreSQL persistence, connected Redis, configured media storage, a ready Socket adapter, and 98 rooms.

## Verification for the convergence hardening release

| Check | Result |
| --- | --- |
| Full Client suite | 1,012 passed in 96 files |
| Full Server suite | 766 passed in 101 suites |
| Real PostgreSQL 17 room-event integration | 17 passed |
| State-machine and room-event race regressions | Passed |
| Server TypeScript build | Passed |
| Client production build and i18n check | Passed |
| Production Docker image build | Passed |
| Compose health | Five services healthy/running |
| Loopback `/api/status` | Online |
| `room.ruit.me` and `roomtalk.ruit.me` `/api/status` | Online |
| GitHub CI with mandatory PostgreSQL 17 service | Added; room-event integration can no longer silently skip |

The regression suite covers recovery competing with prepend pagination, an emptied current window with older history, modal cleanup only for deletion events, unpersisted AI errors before and after their placeholder, a 1,000-notification broadcaster burst, stale PostgreSQL listener generations, cross-room message rejection, and wall-clock event creation. The real PostgreSQL suite ran against PostgreSQL 17 rather than a mock; the new GitHub workflow provisions the same database service for every `master` push and pull request.

Earlier full Server, Client, PostgreSQL integration, PostgreSQL Playwright, persistence, Compose restart, and paired restore results remain in Git history with the commits that produced them. This ledger avoids copying every test case because the current architecture document already explains the protocol-level coverage.

### Ownership-model convergence, 2026-07-22

Commit `a3b90e0c` reduced the remaining races to explicit ownership rules. AI streams use `(ownerId, fence)` and outbox claims use `(workerId, attempt)`; renewals, terminal writes, and acknowledgements require the original claim token, so an obsolete worker cannot complete or overwrite the replacement owner's work. Ownership-only AI updates no longer enter the public room-event stream. Production applied migrations `0007_ai_stream_fencing` and `0008_ai_stream_internal_event_filter`.

An authenticated `socket.data.roomtalkClientId` is authoritative for that live Socket connection, while Redis remains a rebuildable index. A missing Redis record is repaired only after PostgreSQL room-membership authorization; a non-empty identity conflict fails closed. Heartbeat, instance-lease reacquisition, and expired-instance cleanup use atomic Lua and recheck both the lease and socket owner before cleanup. Socket.IO readiness now requires both Redis pub/sub clients to be ready, and the browser recovers transient authorization failures through one bounded exponential-backoff timer.

The release respected the stop-the-world compatibility boundary: the old app was stopped before the image containing the new fence/lease protocol started, with no mixed rolling window. Compose built from `a3b90e0c`; startup logs confirmed both new migrations, the PostgreSQL listener, and the Redis Socket.IO adapter.

The first GitHub CI run then reproduced a remaining base-DDL race: two initializers could both drop one check constraint and concurrently add it, causing the second PostgreSQL session to fail with `42710 duplicate constraint`. Commit `81b2b74e` fixes the model rather than that single constraint by putting all always-rerun DDL, migration effects, and migration-ledger writes behind one transaction-scoped advisory lock. The same guarantee now covers every DROP/ADD constraint and trigger-replacement sequence. The real PostgreSQL concurrent-initialization case passed 10 consecutive runs, and the full Server suite passed all 820 tests with only the disposable database URL injected. Production then rebuilt from `81b2b74e`; schema initialization, the listener, and the Redis adapter all became ready normally.

| Check | Result |
| --- | --- |
| Full Client suite | 1,020 passed in 96 files |
| Full Server suite including PostgreSQL integration | 820 passed in 105 suites |
| PostgreSQL 17 upgrade-path integration | 25 passed |
| PostgreSQL 17 fresh-schema integration | 25 passed |
| Server and Client production builds | Passed |
| Compose health | Five services healthy/running |
| Migration ledger | `0006`, `0007`, and `0008` recorded |
| Loopback, `room.ruit.me`, and `roomtalk.ruit.me` | `online`, `ready=true`, 98 rooms |
| Dependency status | PostgreSQL, Redis, media storage, and Socket adapter all ready |

Post-release logs contained no fatal, panic, uncaught, unhandled, or error entries. The deployment worktree retained no production env/runtime symlinks after cleanup; production data remains in the original Compose volumes and `runtime/` directory.

### Durable-AI and schema-lifecycle hardening, 2026-07-22

Commit `f389bdce` closed the two active worker-mode restart windows found after the ownership release. Startup recovery now preserves a streaming placeholder while its `assistant_run` and `ai.run_requested` outbox row still describe recoverable queued/running work. Worker-mode start creates the placeholder, run, and outbox row in one PostgreSQL transaction. The serial worker defaults to `claim one, execute one`, so no waiting claim can expire behind a long Provider call. Lease timestamps come from PostgreSQL wall-clock time. Local authenticated Socket identity is the only authority; an invalid/conflicting socket is individually asked to register and removed, while verified peers keep the complete fast path.

Schema changes no longer run inside every App cold start. A one-shot Compose `migrate` service applies only missing immutable migrations under the advisory transaction lock and records SHA-256 checksums; App startup performs read-only `verifySchema()` and refuses to serve an unknown schema. The same boundary maps to a Kubernetes/AWS pre-deploy Job and a DML-only runtime role. Production adopted checksums for all nine ledger rows, including the frozen `0000_roomtalk_schema` bootstrap, before the App listener and worker started.

The release created the paired backup `roomtalk-20260722T101006Z.dump` and `roomtalk-object-storage-20260722T101006Z.tar.gz`. The backup exposed one operational edge: its recovery path used `compose up`, which could reconcile a new Compose command against the previous application image before the real build. The script now uses `compose start` to restore the exact stopped containers; backup is no longer an implicit deployment step.

| Check | Result |
| --- | --- |
| Full Server suite | 799 passed in 105 suites |
| Real PostgreSQL 17 room-event integration | 26 passed, no skip |
| Authorization/broadcaster/identity focused tests | 22 passed |
| Server and Client production builds | Passed |
| Migration ledger | 9/9 rows checksummed; `0000` through `0008` verified |
| Durable AI invariants | 0 streaming messages, 0 active runs/outbox rows, 0 orphan runs after deploy |
| Compose health | App, PostgreSQL, Redis, SeaweedFS, and Cloudflare Tunnel running; stateful services healthy |
| Loopback and `room.ruit.me` | `online`, `ready=true`, 99 rooms |

This is a safer intermediate worker model, not the final AI aggregate. Durable terminal truth is still split across `assistant_runs`, messages, the AI-specific outbox, usage projection, owner leases, and the process-local terminal reconciler. The next architectural phase is still to make `assistant_runs` the sole durable execution aggregate, add run generation/chunk sequence to transient events, persist terminal payload and usage idempotently in one transaction, and then retire the AI-specific outbox and in-memory terminal retry. The stable `room_events` client changefeed does not need to change for that work.

### BullMQ Assistant Worker cutover, 2026-07-22

This phase completes the AI aggregate that the previous section described as future work. Ordinary chat AI no longer runs in an App-local PostgreSQL polling worker. The App accepts Socket requests and relays minimal dispatch intent; a dedicated Node/TypeScript `ai-worker` is scheduled by BullMQ, loads the full request from PostgreSQL `assistant_runs`, executes the Provider under a generation lease, and converges the immutable terminal payload, Message, run state, and room cost through controlled transaction boundaries. BullMQ owns waiting, concurrency, backoff, stalled recovery, and operational retention only. PostgreSQL remains the sole business authority, with no duplicate `assistant_run_usage` ledger.

The first release respected a stop-the-world protocol boundary. The maintenance window created the paired backup `roomtalk-20260722T124306Z.dump` and `roomtalk-object-storage-20260722T124306Z.tar.gz`, then stopped the old App and edge. After confirming the database still ended at `0009`, Compose applied `0010_assistant_run_bullmq_dispatch`, recreated Redis with a named volume, AOF `everysec`, and `noeviction`, and started the new App and dedicated Worker together. The old polling executor and BullMQ executor never overlapped.

| Check | Result |
| --- | --- |
| Full Server suite | 851 passed in 111 suites; real PostgreSQL 17 migration/transactions ran without skips |
| Full Client suite | 1,025 passed in 97 files |
| BullMQ + Redis integration | Duplicate relay dedupe, simulated Worker crash retry, and single completion passed |
| Server / Client production build | Passed |
| Production image | `roomtalk-local:dev`, image SHA `128708f3280f` |
| Migration ledger | 11/11; `0010_assistant_run_bullmq_dispatch` recorded |
| Durable-run invariants | All 10 historical runs terminal; zero active runs missing dispatch |
| Dispatch backlog | pending=0, processing=0 |
| Redis queue durability | AOF enabled, `everysec`, `noeviction`, latest write successful |
| Worker health | Worker running; queue Redis and transient Redis ready |
| Compose health | App, AI Worker, PostgreSQL, Redis, SeaweedFS, and Cloudflare Tunnel running |
| Loopback, `room.ruit.me`, and `roomtalk.ruit.me` | `online`, `ready=true`, `assistantQueue=ready`, 100 rooms |
| Public Socket.IO handshake | Succeeded with WebSocket upgrade available |

Deployment verification did not call a paid Provider. Recent App, Worker, and migration logs contained no fatal, panic, uncaught, unhandled, or error record. CI now provisions real PostgreSQL 17 and Redis 7 services. The important regressions cover deferred dispatch during queue outage, deterministic job deduplication, Worker crash recovery, terminal/finalizing runs avoiding a second Provider call, exact generation release, and database atomicity across placeholder, run, room event, and dispatch intent.

## Rollback and ongoing operations

Rollback after either production boundary is a data operation. Do not re-enable Fly or change DNS by itself after the Mac has accepted writes. Stop or gate the current writer, reconcile PostgreSQL and object deltas, restore a matching database/object pair, verify the target, and only then switch traffic.

Run paired maintenance backups regularly, copy encrypted copies off the Mac, and rehearse restores. The Mac must remain powered and Docker Desktop must remain running. Future AWS migration can reuse the image, PostgreSQL schema, Redis rebuildable boundary, S3 object keys, and E2B execution plane, but a rolling migration that changes event payload compatibility still needs a two-phase protocol.
