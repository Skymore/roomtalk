# Assistant Runs and BullMQ: Design and Progress

[中文](assistant-run-bullmq-design-progress.zh.md)

Status: implementation, full validation, and production cutover complete
Baseline: `b7941513`
Updated: 2026-07-22

This record explains why RoomTalk introduced BullMQ without moving business truth out of PostgreSQL. It also records the cutover contract and the evidence required before production can use the new Worker.

## Outcome

Ordinary chat AI now has three deliberately different layers:

1. PostgreSQL stores the accepted request and every business fact.
2. A narrow transactional dispatch row bridges the database commit into Redis.
3. BullMQ schedules a dedicated Node/TypeScript Worker.

`assistant_runs` is the only business aggregate. A support page, recovery job, or audit query determines `queued`, `running`, `finalizing`, `complete`, `error`, or `cancelled` from PostgreSQL. It never interprets a BullMQ job state as the user-visible result and does not use BullMQ's result backend.

BullMQ owns operational mechanics that are awkward to rebuild in each App process: waiting jobs, bounded concurrency, delayed backoff, stalled-job recovery, and completed/failed job retention. App and Worker use the same image and TypeScript provider/A2UI implementation, but start as separate processes so HTTP/Socket capacity and AI capacity can scale independently.

## Data and process boundaries

```text
Browser
  -> App Socket handler
       -> one PostgreSQL transaction
            user message / streaming placeholder
            assistant_runs
            room_events after-image
            task_dispatch_outbox(run_id, pending)

App dispatch relay
  -> BullMQ job { schemaVersion: 1, runId }

Dedicated ai-worker
  -> claim exact assistant_run generation
  -> read durable request snapshot
  -> call Provider
  -> stage immutable terminal payload
  -> project Message + run + room cost atomically
```

The queue payload does not copy prompts, room history, provider credentials, terminal messages, or billing values. A retry always re-reads the validated run aggregate from PostgreSQL.

The App and Worker initially use one Redis deployment through separate connection and namespace boundaries. `REDIS_URL` serves realtime/cache and transient events. `QUEUE_REDIS_URL` defaults to the same endpoint for BullMQ, but can later move to a dedicated Redis without a code or database migration. Production enables AOF `everysec` and `noeviction` because active jobs are no longer disposable cache entries.

## Why the dispatch table remains

PostgreSQL and Redis cannot participate in one atomic transaction. Writing PostgreSQL first and then calling Redis can crash between the two operations; enqueueing first can let a Worker run before the database commit exists.

RoomTalk therefore commits a minimal dispatch intent with the run. The relay claims a bounded batch with a fenced token, enqueues the deterministic BullMQ `jobId=runId`, and only then marks the exact claim dispatched. If Redis is down or the App dies mid-relay, the claim expires or is released to pending. Re-enqueueing is safe because the job ID deduplicates the same active request.

Acknowledgement is not the end of recovery. A periodic App-side reconciler acquires a PostgreSQL advisory lock, reads only active runs whose dispatch is already marked `dispatched`, and checks the corresponding BullMQ job after a short grace period. A missing job is recreated with the same `runId`; an exhausted failed job or a completed job whose run is still non-terminal is returned to waiting. Active, waiting, and delayed jobs are left untouched. A rotating cursor bounds each pass without permanently starving later run IDs. This closes the practical Redis-loss/restore gap while keeping BullMQ as the scheduler and PostgreSQL as business truth.

The dispatch table is not a second task ledger. It does not own provider results, terminal status, cost, or user-visible errors. It answers one question only: has the committed run been handed to the scheduler?

## Execution and fencing

The Worker receives `runId` and asks PostgreSQL to claim that exact run. Claiming returns a higher generation and a time-bounded owner lease. Provider chunks and terminal writes carry that run/generation identity.

- A lower generation is stale and cannot update the client or database.
- A higher generation replaces an older transient stream.
- Lease renewal failure aborts owned Provider work where possible.
- A terminal update applies only to the existing streaming placeholder owned by that run and generation.
- A deleted, already-terminal, or replacement-owned placeholder makes the job obsolete; it is never inserted again.

`chunkSeq` may be included for observability, but RoomTalk does not build a chunk replay protocol around it. Socket.IO preserves order from one sender, generation removes takeover mixing, and the final durable Message repairs lost transient chunks.

## Terminal consistency

Provider completion is split into two recoverable facts:

1. stage one immutable terminal payload in `assistant_runs` and move the run to `finalizing`;
2. in one transaction, project that payload into the Message, run terminal status, and room cost.

If the Worker crashes after step 1, a BullMQ retry detects `finalizing` and performs step 2 only. It does not pay for a second Provider call. Once the locked run transition leaves `finalizing`, repeating the projection is a no-op, so cost cannot be accumulated twice.

No separate `assistant_run_usage` table is required for correctness. Usage and cost remain in the immutable terminal payload after a Message is deleted, and the one locked terminal transition is already the idempotency key. A future auditable billing ledger can be added for a product requirement, not as accidental duplicate state.

The boundary must be stated precisely. RoomTalk guarantees one accepted terminal projection and one internal cost settlement. It cannot universally guarantee one external Provider invocation: if the Provider accepted a request but the Worker died before terminal staging, takeover may send the request again. Providers with a reliable idempotency-key API can tighten that one integration, but the portable contract remains at-least-once Provider invocation with generation-fenced results. This is preferable to claiming an exactly-once property the system cannot observe.

## Transient delivery

The Worker has no Socket.IO server. It publishes a bounded, versioned transient envelope to Redis. Each App receives it, verifies its schema and size, resolves currently authenticated local sockets, rechecks room membership, and emits with `io.local`.

This is a latency path, not a correctness source. The browser buffers a transient event that beats its placeholder, ignores older generations, and preserves optimistic messages already present only in React state. Lost chunks converge through the final `messages.upserted` room event and the existing replay/snapshot state machine.

## Failure semantics

| Failure | Expected behavior |
| --- | --- |
| Queue Redis is unavailable after send | PostgreSQL commit remains valid, dispatch returns to pending, App reports degraded/deferred dispatch, and relay retries. |
| Relay crashes after enqueue | Deterministic `jobId` deduplicates the retry; the exact fenced dispatch claim is acknowledged later. |
| An acknowledged job is absent after Redis loss/restore | Reconciliation sees an active PostgreSQL run and recreates the deterministic job. |
| BullMQ attempts are exhausted while the run remains active | Reconciliation returns the failed job to waiting; the domain attempt cap still terminalizes repeated execution failures. |
| Worker crashes before Provider terminal payload | BullMQ retry/stalled recovery claims the durable run with a new generation; the external Provider may be called again. |
| Worker crashes after terminal payload | Retry performs projection only; Provider is not called again. |
| Placeholder is deleted or replaced | Conditional projection is obsolete and cannot resurrect or overwrite it. |
| App restarts | The Worker continues; transient delivery resumes when Apps resubscribe, and durable room replay repairs loss. |
| Worker restarts | Browser/App sessions continue; queued/active jobs recover through BullMQ and PostgreSQL leases. |

Failed BullMQ jobs remain an operational signal with bounded retention. The reconciler automatically retries one only while PostgreSQL still says the run is active; durable Provider errors are normal terminal business outcomes and are not kept in an infinite retry loop.

## Health and portability

App readiness continues to protect serving dependencies. Queue-only failure is `degraded` but ready because PostgreSQL can accept and defer a request without losing it. Every Worker renews a shared queue-Redis TTL heartbeat. Public status becomes degraded when that heartbeat expires even if Redis still responds, and reports PostgreSQL pending/processing dispatch plus BullMQ waiting/active/delayed/failed counts and oldest queued time. The Worker also retains its separate health endpoint for PostgreSQL, queue Redis, transient Redis, and local Worker state.

The Mac Compose topology runs App and Worker from the same image with PostgreSQL, Redis, SeaweedFS, and Cloudflare Tunnel. On AWS, the same boundary maps to two ECS services or two EKS deployments, RDS/Aurora PostgreSQL, ElastiCache for Redis OSS, and S3. A future queue split changes `QUEUE_REDIS_URL`; it does not change `assistant_runs` or the Socket protocol.

## Validation contract

The release must prove user-relevant failures, not only isolated helpers:

- an accepted request survives queue unavailability;
- duplicate dispatch creates one active BullMQ job;
- a processor failure is retried and completes;
- a dispatched job deleted from Redis is rebuilt from the active PostgreSQL run;
- an exhausted failed job is returned to waiting while its run remains active;
- an expired Worker heartbeat degrades status without taking the durable HTTP App out of rotation;
- a terminal or cancelled run does not call the Provider;
- a `finalizing` run projects without re-running the Provider;
- failure releases only the exact generation before retry;
- PostgreSQL creates placeholder, run, room event, and dispatch atomically;
- the real migration backfills active runs and preserves terminal runs;
- App and Worker build from the production image and expose correct health;
- public RoomTalk status reports a live Worker and queue metrics after the maintenance cutover.

The first production deployment is a stop-the-world protocol cutover: stop the old embedded polling Worker, make a paired PostgreSQL/object backup, apply migration `0010`, restart Redis with its durable queue configuration, then start the new App and dedicated Worker together. Mixed old and new executors are not supported across this boundary.

## Production evidence

The 2026-07-22 maintenance cutover created the paired backup `roomtalk-20260722T124306Z.dump` and `roomtalk-object-storage-20260722T124306Z.tar.gz`, stopped the old App and edge, applied migration `0010_assistant_run_bullmq_dispatch`, recreated Redis with its named AOF volume, and started the App and dedicated Worker from the same production image.

All six services were running after the cutover. The Worker health endpoint reported a running Worker plus ready queue and transient Redis connections. Redis reported AOF enabled, `appendfsync everysec`, `noeviction`, and successful AOF writes. PostgreSQL recorded eleven migrations, ten historical runs were terminal, no active run lacked dispatch intent, and the dispatch backlog was empty. Loopback, `room.ruit.me`, and `roomtalk.ruit.me` all returned `online`, `ready=true`, and `assistantQueue=ready`; a public Socket.IO handshake also succeeded. No paid Provider request was generated during deployment verification.

The post-cutover reliability closure was deployed from commit `46b4d48a` on 2026-07-22 local time, after creating and validating the paired backup `roomtalk-20260723T004010Z.dump` and `roomtalk-object-storage-20260723T004010Z.tar.gz`. The release added PostgreSQL-to-BullMQ reconciliation for acknowledged missing or exhausted jobs and a queue-Redis Worker heartbeat. The full Server suite passed 862 tests in 114 suites, the real PostgreSQL 17 run/migration suite passed 34 tests without skips, the real Redis/BullMQ recovery suite passed 3 tests, and GitHub CI passed for both Server and Client.

The production image SHA is `79b1e87ada299f8d1125bb6d756d5b38a9a2f91b6fda515dc2a53ac5ad1797b6`. After deployment, all six Compose services were running; all ten historical runs were terminal, no active run lacked dispatch intent, and pending, processing, waiting, active, delayed, and failed queue counts were all zero. Loopback and both public domains returned `online`, `ready=true`, `assistantQueue=ready`, and `assistantWorker=ready` with a live heartbeat. No paid Provider request was made.
