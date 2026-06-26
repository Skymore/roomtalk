# Migration Completion Audit

Date: 2026-06-26

This audit records the current migration completion evidence after the Coco/code-agent merge and legacy media migration restoration.

## Current Git State

- `origin/master` and `origin/codex/coco-merge-master` were both advanced to `98233c32 media: restore legacy object storage migration`.
- GitHub Actions `CI/CD` for `98233c32` completed successfully.
- `.claude/settings.local.json` remains a local-only uncommitted file and is intentionally excluded from migration commits.

## Migration Lines

| Migration area | Current status | Evidence |
| --- | --- | --- |
| Redis durable store to PostgreSQL durable store | Implemented and previously executed for production cutover | `server/src/scripts/migrateRedisToPostgres.ts`, `server/src/scripts/migrateRedisToPostgres.test.ts`, `docs/postgres-rollout-runbook.md`, `docs/postgres-migration-development-summary.zh.md` |
| PostgreSQL schema migrations | Implemented as startup DDL plus versioned one-time migrations | `server/src/repositories/postgresSchema.ts`, `server/src/repositories/postgresStore.ts`, `schema_migrations` tests in `server/src/repositories/postgresStore.test.ts` |
| PostgreSQL app user provisioning | Implemented | `server/src/scripts/provisionPostgresAppUser.ts`, `docs/postgres-app-user-runbook.md` |
| Legacy base64 image messages to object storage | Implemented in this audit cycle | `server/src/scripts/migrateLegacyMediaMessagesToObjectStorage.ts`, `server/src/scripts/migrateLegacyMediaMessagesToObjectStorage.test.ts`, `docs/image-object-storage-migration-runbook.md` |
| Coco/code-agent room and sandbox migration | Implemented and merged to `master` | `docs/code-agent-sandbox.md`, `docs/coco-phase6-real-runner-plan.md`, `server/src/services/coco*`, `client-heroui/src/components/CodeAgent*` |

## Verification Completed

Commands run locally:

```bash
cd server && npm run build
cd server && npm test
cd server && npm run migrate:media-to-object-storage -- --help
cd server && npm run smoke:coco:e2b
cd server && RUN_COCO_E2B_SMOKE=true npm run smoke:coco:e2b
cd client-heroui && npm run lint
cd client-heroui && CI=1 NODE_ENV=test E2E_CLIENT_PORT=3511 E2E_SERVER_PORT=3512 ./node_modules/.bin/playwright test e2e/ai-media-sharing.spec.ts --project=chromium
```

Observed results:

- Server build passed.
- Server tests passed: 392/392.
- Media migration CLI help printed the real command usage, proving the npm entrypoint is no longer a placeholder failure.
- Coco E2B smoke skipped safely without `RUN_COCO_E2B_SMOKE=true`.
- Real Coco E2B smoke passed with a remote sandbox, JSONL runner events, `deepseek-v4-pro`, and sandbox cleanup.
- Client lint passed.
- Playwright `ai-media-sharing.spec.ts` passed 6/6, including browser image upload/send/render through local media storage.
- GitHub Actions `CI/CD` for `98233c32` completed successfully.

## Remaining External Gates

These are not code gaps in the current repository, but they are still not locally verifiable from this machine:

1. **Claude Code review gate**
   - Required by the earlier workflow rule.
   - Current CLI state: `claude -p ...` returns `401 Invalid authentication credentials`.
   - `claude auth status` previously reported a logged-in Claude Max account, so this is an external Claude CLI auth/session problem rather than a repository test failure.

2. **Live PostgreSQL execute smoke for `migrate:media-to-object-storage`**
   - Unit tests cover execute-mode upload, replacement, idempotent skip, and cleanup behavior.
   - Store contract tests cover Redis/PostgreSQL `replaceMessageMediaAsset`.
   - Browser E2E covers asset-backed image send/render.
   - This machine currently lacks a safe disposable PostgreSQL target:
     - no `TEST_DATABASE_URL`, `E2E_DATABASE_URL`, or `DATABASE_URL` in the process environment;
     - no `DATABASE_URL` in `server/.env`;
     - no Docker/Podman/Postgres/psql/brew binaries available;
     - `127.0.0.1:55432` is not listening.
   - Execute smoke should be run on a workstation or migration host with a disposable database and local media storage:

```bash
cd server
npm run build
DATABASE_URL="postgres://.../message_system_e2e" \
LOCAL_MEDIA_DIR="/tmp/roomtalk-media-migration-smoke" \
DISABLE_LOCAL_MEDIA_STORAGE=false \
ROOMTALK_DB_BACKUP_FILE="/absolute/path/to/disposable-backup.dump" \
npm run migrate:media-to-object-storage -- --execute --room-id=<seeded-room-id>
```

The database name should clearly identify a disposable test/e2e database. Do not run execute mode against production until the runbook's backup and verification steps are complete.
