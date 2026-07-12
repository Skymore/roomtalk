# RoomTalk Deployment Guide

[中文](部署指南.md)

Status: Current production runbook
Updated: 2026-07-12
Production: [https://room.ruit.me/](https://room.ruit.me/)

## Production Shape

RoomTalk production currently uses:

- Fly.io app `message-system` in `dfw` for the Node control plane;
- one shared 1-vCPU, 1024 MB machine as declared in `fly.toml`;
- Supabase PostgreSQL as the durable source of truth;
- Upstash Redis for Socket.IO, presence, sessions, pub/sub, counters, and bounded message caching;
- Tigris/S3-compatible object storage for private media and published static artifacts;
- E2B for room-scoped code-agent execution sandboxes;
- a pinned E2B artifact with the reusable daemon and Codex app-server backend.

The application can auto-stop at zero traffic and auto-start through Fly Proxy. Treat first-request cold-start latency separately from application health.

## Release Ownership

`master` is the release branch. `.github/workflows/fly-deploy.yml` owns application deployment.

The workflow:

1. runs every two hours at minute 23 or by manual dispatch;
2. compares `master` with the latest successful workflow run;
3. skips when nothing relevant changed;
4. builds conservatively when the comparison is incomplete or non-linear;
5. validates required secrets, translations, client and server production builds;
6. builds the root multi-stage Docker image;
7. deploys to Fly and verifies the application.

Do not run `fly deploy` manually. A Git push does not by itself prove that production was deployed because the workflow is not push-triggered.

## Routine Release

1. Validate the change according to its risk.
2. Commit and push the finished change to `origin/master`.
3. Decide whether the scheduled workflow is sufficient or an immediate rollout is required.
4. For an immediate rollout, dispatch `fly-deploy.yml` from GitHub Actions.
5. Verify the workflow conclusion and deployed commit/image.
6. Verify Fly machine state and the public status endpoint.

Useful read-only checks:

```bash
gh run list --repo Skymore/roomtalk --workflow fly-deploy.yml --branch master --limit 5
fly status -a message-system
curl -fsS https://room.ruit.me/api/status
```

The status response should report `status: "online"`, the intended `persistenceStore`, and a plausible room count.

## First-Time Environment Provisioning

The routine workflow assumes the Fly app and external services already exist. For a new environment:

1. Create the Fly app and configure `fly.toml` for the target app/region.
2. Provision PostgreSQL, Redis, and S3-compatible object storage.
3. Create the dedicated PostgreSQL application role.
4. Add GitHub Actions/Fly credentials required by the deployment workflow.
5. Add application secrets through the platform secret manager.
6. Build and publish the pinned E2B template before enabling production code-agent rooms.
7. Dispatch the workflow and complete the verification checklist below.

Do not use a production serving machine as a general migration host.

## Configuration Groups

The complete operator-facing inventory is in [docs/configuration.md](docs/configuration.md). Important production groups are:

| Area | Representative variables |
| --- | --- |
| HTTP/origins | `NODE_ENV`, `PORT`, `CLIENT_URL`, `CLIENT_URLS` |
| Stores | `REDIS_URL`, `PERSISTENCE_STORE`, `DATABASE_URL`, PostgreSQL TLS/CA, message-cache limits |
| Media | bucket, endpoint, region, S3 credentials |
| Chat AI | provider keys, default model, context limits |
| Optional product services | Google OAuth, AssemblyAI, Web Push |
| Code Agent | enablement/allowlists, modes, daemon/backend, E2B pins, scoped capability secrets |
| User-owned connections | Codex/GitHub enablement and encryption keys |

Use `CLIENT_URL` for the canonical RoomTalk browser address. `CLIENT_URLS` is a comma-separated allowlist for deployments that accept additional browser origins. Repository documentation and generated examples use the canonical RoomTalk address.

Changing a Fly secret rolls or restarts machines. Verify health after every change.

## Storage Models and PostgreSQL Cutover

RoomTalk supports:

- `PERSISTENCE_STORE=redis`: Redis durable + realtime (`R`);
- `PERSISTENCE_STORE=postgres`: PostgreSQL durable + Redis realtime/cache (`R+P`).

PostgreSQL-only operation is unsupported. A future `R` to `R+P` cutover must follow [the PostgreSQL rollout runbook](docs/postgres-rollout-runbook.md), including dry-run inventory, a write freeze, the idempotent migration, verification, and the limited rollback window.

Do not treat switching `PERSISTENCE_STORE` back to Redis as a safe rollback after PostgreSQL has accepted unique writes.

## Code-Agent / E2B Release Contract

Fly deploys the control plane; it does not rebuild existing E2B templates. Runner, daemon, tool, prompt, sandbox Dockerfile, dependency-lock, or code-agent-engine changes require:

1. committed and pushed source changes;
2. updated runner version/lock/source ref as applicable;
3. a new artifact version and E2B template;
4. updated production `CODE_AGENT_E2B_TEMPLATE_ID`, `CODE_AGENT_ARTIFACT_VERSION`, and `CODE_AGENT_SOURCE_REF`;
5. a real E2B smoke or equivalent direct verification.

See [the artifact contract](docs/code-agent-sandbox-artifact.md).

## Verification Checklist

### Control plane

- GitHub Actions completed successfully for the intended `master` commit.
- Fly reports the expected machine image/version and `started` state.
- `/api/status` is online and reports the intended persistence mode.
- No startup errors appear for PostgreSQL, Redis, object storage, or socket adapter initialization.

### User flow

- Load the canonical application URL.
- Register/join a room and reload it.
- Send a text message and confirm it survives refresh.
- Confirm private media upload/read when media configuration changed.
- Confirm AI streaming finalizes one durable response when AI configuration changed.
- Confirm mobile/reconnect behavior when socket or client state changed.

### Code Agent

When the change affects this boundary:

- create or open an authorized code-agent room;
- verify sandbox creation/reconnect and artifact metadata;
- run the affected Coco/Codex backend and mode;
- verify ordered text/tool events, usage, terminal/preview/workspace access as applicable;
- verify pause/resume or replacement behavior if lifecycle changed.

## Rollback

### Application rollout

Prefer redeploying a known-good application image through the controlled Fly/GitHub workflow. Preserve logs and the failing image/commit for investigation. Do not combine application rollback with database-mode rollback unless data divergence has been measured.

### Secret/configuration change

Restore the previous known-good secret value through Fly, wait for the rolling update, and repeat health checks.

### E2B artifact

Point production pins back to the last verified template/artifact/source-ref set, then verify new sandbox creation. Existing sandboxes may still carry old workspace/runtime state and can require explicit lifecycle handling.

### Database

Follow the PostgreSQL runbook. Configuration-only rollback is safe only during the frozen cutover window before PostgreSQL-only writes exist.

## Operations

```bash
fly status -a message-system
fly logs -a message-system
fly machine list -a message-system
```

Use `fly ssh console -C 'sh -lc "..."'` when shell syntax is required. Never print or copy secret values into issues, logs, or documentation.

Scaling changes must be committed in `fly.toml` so the repository remains the source of truth. The current declaration is one shared CPU and 1024 MB; do not document ad-hoc console scaling as the desired production state.
