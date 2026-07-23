# RoomTalk Deployment Guide

[中文](部署指南.md)

Status: Current production runbook
Updated: 2026-07-23
Production: [https://room.ruit.me/](https://room.ruit.me/)

## Production Shape

RoomTalk production currently runs on a MacBook as seven long-lived Docker Compose services:

- `app`: the root multi-stage application image, binding Node/Express/Socket.IO to loopback port `3012`;
- `ai-worker`: the same image running the BullMQ consumer and ordinary chat AI providers, with a private health endpoint on `3013`;
- `postgres`: PostgreSQL 17, the only durable serving authority, using the `postgres_data` Docker volume;
- `redis`: Redis 7 for Socket.IO, presence, sessions, bounded caches, transient Worker events, and BullMQ; a named volume plus AOF `everysec` and `noeviction` protect active jobs;
- `object-storage`: SeaweedFS 4.29 exposing an S3-compatible API, persisted under `runtime/object-storage`;
- `cloudflared`: the outbound connector for the primary `ruit.me` Cloudflare Tunnel;
- `cloudflared-wenlin`: a token-authenticated connector for the separately managed `ai-chat.wenlin.dev` Tunnel.

`room.ruit.me` is canonical, `roomtalk.ruit.me` is a compatibility hostname, `roomtalk-objects.ruit.me` carries presigned browser object transfers, and `ai-chat.wenlin.dev` reaches the same App through its dedicated Tunnel. Both connectors are outbound, so the host exposes no inbound application port. E2B remains the external execution plane for room-scoped code-agent sandboxes.

The former Fly app, Supabase database, Tigris bucket, and Upstash Redis remain rollback sources only. Fly is suspended and its scheduled GitHub Actions workflow is manually disabled; none of those services receives production writes.

## Release Ownership

`master` is the source release branch, but a Git push does not deploy the Mac. The production checkout and `scripts/local-production.mjs` own the application rollout. The script loads the application environment from the macOS Keychain item `roomtalk-production-env`, creates a mode-`0600` temporary env file for Compose, and removes it after the command.

The application image and the pinned E2B artifact are separate releases. A normal app rollout does not rebuild existing E2B templates.

## Routine Application Release

1. Validate the change according to its real failure modes.
2. Commit and push the completed change to `origin/master`.
3. Confirm the production checkout is on the intended commit and has no unrelated tracked changes:

   ```bash
   git fetch origin master
   git status --short --branch
   test "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)"
   ```

4. Build and reconcile the production stack:

   ```bash
   node scripts/local-production.mjs --profile edge up -d --build
   ```

5. Verify containers and both local/public health:

   ```bash
   node scripts/local-production.mjs --profile edge ps
   curl -fsS http://127.0.0.1:3012/api/status
   curl -fsS https://room.ruit.me/api/status
   curl -fsS https://ai-chat.wenlin.dev/api/status
   ```

   `/api/health/live` is process liveness and intentionally ignores downstream failures. Compose and Kubernetes readiness use `/api/health/ready`: it verifies PostgreSQL, realtime Redis, object storage, and the Socket adapter. A serving failure returns `503 degraded` with `rooms: null`; queue-only failure remains ready but reports deferred dispatch because PostgreSQL can retain the request. The Worker separately checks PostgreSQL, queue Redis, transient Redis, and its processing loop. After a detached `up`, `local-production.mjs` waits for the five local App/Worker/stateful services plus both Cloudflare connectors, checks loopback and both public readiness endpoints, and reports host free space plus allocated `Docker.raw` space.

6. Run a risk-based user smoke. Room-event, media, OAuth/connection, and E2B changes require checks at those actual boundaries.

Documentation-only commits do not require a production rebuild.

An incompatible room-event migration is not a routine rolling release. Take a paired backup, stop both Cloudflare connectors and every old app process, then start only the new image. Production used this procedure for migrations `0003` and `0004` on 2026-07-21.

## First-Time Host Provisioning

1. Install Docker Desktop and keep the Mac on AC power with automatic sleep disabled for the production session.
2. Copy `.env.compose.example` to ignored `.env.compose`; generate independent PostgreSQL and local S3 credentials.
3. Store the complete application environment as a JSON object in the macOS Keychain item `roomtalk-production-env`. Never commit or print it.
4. Create ignored `runtime/cloudflared/config.yml` and `runtime/cloudflared/credentials.json` for the primary Tunnel, and store `CLOUDFLARE_WENLIN_TUNNEL_TOKEN` in the same Keychain JSON for the separately managed Wenlin Tunnel.
5. Restore a paired PostgreSQL custom archive and SeaweedFS snapshot, or initialize an empty environment.
6. Verify the pinned E2B template/artifact/source-ref set before enabling code-agent rooms.
7. Start with `node scripts/local-production.mjs --profile edge up -d --build` and complete the verification checklist below.

The full operator-facing variable inventory is in [docs/configuration.md](docs/configuration.md).

## Durable State and Room Event Sync

PostgreSQL owns canonical rooms, messages, members, turns, auth/account data, media metadata, `room_event_streams`, `room_events`, `assistant_runs`, and `task_dispatch_outbox`. Redis is not the business authority, but it cannot be flushed while BullMQ jobs are active; realtime/cache keys remain rebuildable.

`room_events` is a bounded per-room replay changelog used by every authorized client. It is not full event sourcing and it is not a worker queue. After commit, an app with local subscribers reads the exact immutable event from PostgreSQL and pushes it directly when the complete Socket payload is at most 256 KiB; an oversized event or read failure falls back to a head-only hint. Clients replay smaller gaps and use a repeatable-read snapshot for large/oversized gaps. Ordinary chat AI commits placeholder, run, room event, and dispatch intent together; the App relays a minimal deterministic job to BullMQ, while `assistant_runs` remains the only business status/result source. See [Room Event Sync and Portable Deployment](docs/room-event-sync-portable-deployment.md) and [Assistant Runs and BullMQ](docs/assistant-run-bullmq-design-progress.md).

Every App process owns only its Redis presence through a unique runtime ID and TTL heartbeat. Periodic recovery cleans expired owners and excludes Code Agent work protected by a live fenced lease. The dedicated AI Worker claims exact assistant-run generations and renews PostgreSQL leases. Terminal payload is staged before projection, so a retry after a partial failure does not call the Provider again. Recovery and retention use PostgreSQL advisory locks. Migration `0010` is a maintenance cutover because the old embedded polling executor and the new BullMQ Worker must never claim the same active run.

AI text chunks remain transient. An AI error is persisted as a complete Message before `ai_stream_error` carries that same Message as a fast path. This keeps Socket-first, room-event-first, and error-before-placeholder delivery deterministic.

The event log repairs client synchronization after missed Socket.IO notifications. It does not replace PostgreSQL backup, WAL/CDC, or database replication.

## Backup and Restore

Run the paired maintenance backup only in an announced maintenance window:

```bash
node scripts/backup-local-production.mjs
```

This command has no help or dry-run mode. Invoking it immediately stops both Cloudflare connectors, `app`, `ai-worker`, and `object-storage`, writes a PostgreSQL custom archive plus a matching SeaweedFS tarball under `backups/`, and then restarts those services in a `finally` path.

After every backup:

- confirm all seven services are healthy and both public `/api/status` endpoints are online;
- keep the database dump and object snapshot as one timestamped pair;
- copy encrypted artifacts off the Mac;
- periodically restore both artifacts into isolated targets and compare database/object counts.

Local `backups/` alone is not disaster recovery.

## Code-Agent / E2B Release Contract

Runner, daemon, tool, prompt, sandbox Dockerfile/dependency-lock, or pinned code-agent-engine changes require:

1. committed and pushed source changes;
2. updated runner/artifact version and source ref as applicable;
3. a newly built and published E2B template;
4. matching production `CODE_AGENT_E2B_TEMPLATE_ID`, `CODE_AGENT_ARTIFACT_VERSION`, and `CODE_AGENT_SOURCE_REF` values in the Keychain environment;
5. a real E2B smoke or equivalent direct verification;
6. an app restart only when the control-plane configuration or source also changed.

See [the artifact contract](docs/code-agent-sandbox-artifact.md).

## Verification Checklist

### Control plane

- All seven Compose services report healthy/running, including the dedicated `ai-worker` and both Cloudflare connectors.
- Loopback and both public `/api/status` endpoints return `status: "online"`, `ready: true`, `persistenceStore: "postgres"`, ready PostgreSQL/Redis/media dependencies, and a ready socket adapter.
- `room.ruit.me`, `roomtalk.ruit.me`, and `ai-chat.wenlin.dev` serve the intended application; the object hostname accepts only signed object operations.
- No startup errors appear for PostgreSQL schema/event listeners, Redis, object storage, workers, or Socket.IO.

### User and synchronization flow

- Open or join a room, send text, reload, and verify the message remains.
- Verify a second client applies a contiguous `room_event_available.events` payload without a replay request, while a head-only or gapped notification still converges through `get_room_events`.
- Verify a retained gap above 500 events replaces from `get_room_snapshot` and then drains only the post-snapshot tail.
- When relevant, exercise offline replay, `CURSOR_EXPIRED`, database-restore `CURSOR_AHEAD`, edit/delete/clear, and deleted-room tombstones.
- Verify presigned media PUT/GET when storage or edge configuration changed.
- Verify Google/GitHub/Codex connections and E2B turns when those boundaries changed.

## Rollback

### Application image

Move the production checkout to a known-good commit, rebuild with `scripts/local-production.mjs`, and repeat health/user-flow checks. Preserve the failing commit and logs for investigation.

### Configuration

Restore the previous known-good Keychain JSON object, reconcile the stack, and repeat health checks. Do not print the environment while diagnosing.

### Database and objects

Restore PostgreSQL and SeaweedFS from the same timestamped maintenance pair. Restoring only one side can leave media metadata and object bytes inconsistent.

### Former cloud target

Do not re-enable Fly or change DNS as a standalone rollback after the Mac has accepted writes. First reconcile the PostgreSQL and S3 deltas to the target, stop or gate the current writer, verify the restored target, and only then switch traffic.

## Operations

Read-only checks:

```bash
node scripts/local-production.mjs --profile edge ps
node scripts/local-production.mjs --profile edge logs --tail=200 app
node scripts/local-production.mjs --profile edge logs --tail=200 ai-worker
node scripts/local-production.mjs --profile edge logs --tail=200 cloudflared
node scripts/local-production.mjs --profile edge logs --tail=200 cloudflared-wenlin
curl -fsS https://room.ruit.me/api/status
curl -fsS https://ai-chat.wenlin.dev/api/status
```

Long-running containers use Docker JSON log rotation of 10 MB per file and five files. Database-backed observability, turn, event, run, and dispatch records are not affected by that process-log limit.

For AWS migration, run the same image as separate App and Worker ECS services or EKS deployments, PostgreSQL on RDS/Aurora, BullMQ/realtime on ElastiCache for Redis OSS, and SeaweedFS objects on S3. `QUEUE_REDIS_URL` can split scheduling from realtime later. Follow the controlled cutover in [the top-level AWS portability section](README.md#aws-portability).
