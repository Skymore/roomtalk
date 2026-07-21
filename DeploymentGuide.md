# RoomTalk Deployment Guide

[中文](部署指南.md)

Status: Current production runbook
Updated: 2026-07-20
Production: [https://room.ruit.me/](https://room.ruit.me/)

## Production Shape

RoomTalk production currently runs on a MacBook as five long-lived Docker Compose services:

- `app`: the root multi-stage application image, binding Node/Express/Socket.IO to loopback port `3012`;
- `postgres`: PostgreSQL 17, the only durable serving authority, using the `postgres_data` Docker volume;
- `redis`: Redis 7 for Socket.IO, presence, sessions, and bounded caches; persistence is intentionally disabled;
- `object-storage`: SeaweedFS 4.29 exposing an S3-compatible API, persisted under `runtime/object-storage`;
- `cloudflared`: the outbound Cloudflare Tunnel that provides public DNS/TLS without exposing inbound host ports.

`room.ruit.me` is canonical, `roomtalk.ruit.me` is a compatibility hostname, and `roomtalk-objects.ruit.me` carries presigned browser object transfers. E2B remains the external execution plane for room-scoped code-agent sandboxes.

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
   ```

6. Run a risk-based user smoke. Room-event, media, OAuth/connection, and E2B changes require checks at those actual boundaries.

Documentation-only commits do not require a production rebuild.

## First-Time Host Provisioning

1. Install Docker Desktop and keep the Mac on AC power with automatic sleep disabled for the production session.
2. Copy `.env.compose.example` to ignored `.env.compose`; generate independent PostgreSQL and local S3 credentials.
3. Store the complete application environment as a JSON object in the macOS Keychain item `roomtalk-production-env`. Never commit or print it.
4. Create ignored `runtime/cloudflared/config.yml` and `runtime/cloudflared/credentials.json` for the dedicated tunnel.
5. Restore a paired PostgreSQL custom archive and SeaweedFS snapshot, or initialize an empty environment.
6. Verify the pinned E2B template/artifact/source-ref set before enabling code-agent rooms.
7. Start with `node scripts/local-production.mjs --profile edge up -d --build` and complete the verification checklist below.

The full operator-facing variable inventory is in [docs/configuration.md](docs/configuration.md).

## Durable State and Room Event Sync

PostgreSQL owns canonical rooms, messages, members, turns, auth/account data, media metadata, `room_event_streams`, `room_events`, and `outbox_events`. Redis may be flushed and warmed again without losing business state.

`room_events` is a bounded per-room replay changelog used by every authorized client. It is not full event sourcing and it is not a worker queue. `outbox_events` is a separate claim/lease/retry mechanism for one worker. The defaults retain seven days and at most 10,000 events per room, with hourly prefix pruning; see [Room Event Sync and Portable Deployment](docs/room-event-sync-portable-deployment.md).

The event log repairs client synchronization after missed Socket.IO notifications. It does not replace PostgreSQL backup, WAL/CDC, or database replication.

## Backup and Restore

Run the paired maintenance backup only in an announced maintenance window:

```bash
node scripts/backup-local-production.mjs
```

This command has no help or dry-run mode. Invoking it immediately stops `cloudflared`, `app`, and `object-storage`, writes a PostgreSQL custom archive plus a matching SeaweedFS tarball under `backups/`, and then restarts the services in a `finally` path.

After every backup:

- confirm all five services are healthy and public `/api/status` is online;
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

- All five Compose services report healthy/running.
- Loopback and public `/api/status` return `status: "online"`, `persistenceStore: "postgres"`, connected Redis, configured media, and a ready socket adapter.
- `room.ruit.me` and `roomtalk.ruit.me` serve the intended application; the object hostname accepts only signed object operations.
- No startup errors appear for PostgreSQL schema/event listeners, Redis, object storage, workers, or Socket.IO.

### User and synchronization flow

- Open or join a room, send text, reload, and verify the message remains.
- Verify a second client receives a wake-up and converges through `get_room_events`.
- When relevant, exercise offline replay, `CURSOR_EXPIRED`/resnapshot, edit/delete/clear, and deleted-room tombstones.
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
node scripts/local-production.mjs --profile edge logs --tail=200 cloudflared
curl -fsS https://room.ruit.me/api/status
```

Long-running containers use Docker JSON log rotation of 10 MB per file and five files. Database-backed observability, turn, event, and outbox records are not affected by that process-log limit.

For AWS migration, keep the same image and contracts: app to ECS Fargate or EKS, PostgreSQL to RDS/Aurora, Redis to ElastiCache, and SeaweedFS objects to S3. Follow the controlled cutover in [the top-level AWS portability section](README.md#aws-portability); a true zero-downtime move additionally needs PostgreSQL logical replication/CDC or AWS DMS.
