# Migration Completion Audit

Original audit: 2026-06-26. Storage-migration scope reverified: 2026-07-12.

This audit records the current migration completion evidence after the Code Agent merge and legacy media migration restoration.

## Current Git State

- `origin/master` and `origin/codex/code-agent-merge-master` were both advanced past the Code Agent merge and legacy media migration restoration.
- The implementation and verification evidence has been committed and pushed to both `origin/master` and `origin/codex/code-agent-merge-master`.
- GitHub Actions `CI/CD` completed successfully for the pushed migration audit commits.
- `.claude/settings.local.json` remains a local-only uncommitted file and is intentionally excluded from migration commits.

## Migration Lines

| Migration area | Current status | Evidence |
| --- | --- | --- |
| Redis durable store to PostgreSQL durable store | Production was previously cut over with the historical room/message/cost scope; the reusable command now covers the full current `R` durable model for a future `R` to `R+P` cutover | `server/src/scripts/migrateRedisToPostgres.ts`, `server/src/scripts/migrateRedisToPostgres.test.ts`, `docs/postgres-rollout-runbook.md`, `docs/postgres-migration-development-summary.zh.md` |
| PostgreSQL schema migrations | Implemented as startup DDL plus versioned one-time migrations | `server/src/repositories/postgresSchema.ts`, `server/src/repositories/postgresStore.ts`, `schema_migrations` tests in `server/src/repositories/postgresStore.test.ts` |
| PostgreSQL app user provisioning | Implemented | `server/src/scripts/provisionPostgresAppUser.ts`, `docs/postgres-app-user-runbook.md` |
| Legacy base64 image messages to object storage | Implemented in this audit cycle | `server/src/scripts/migrateLegacyMediaMessagesToObjectStorage.ts`, `server/src/scripts/migrateLegacyMediaMessagesToObjectStorage.test.ts`, `docs/image-object-storage-migration-runbook.md` |
| Code Agent room and sandbox migration | Implemented and merged to `master` | `docs/code-agent-sandbox.md`, `docs/code-agent-phase6-real-runner-plan.md`, `server/src/services/codeAgent*`, `client-heroui/src/components/CodeAgent*` |

## Verification Completed

Commands run locally:

```bash
cd server && npm run build
cd server && npm test
cd server && npm run migrate:media-to-object-storage -- --help
cd server && npm run smoke:code-agent:e2b
cd server && RUN_CODE_AGENT_E2B_SMOKE=true npm run smoke:code-agent:e2b
cd client-heroui && npm run lint
cd client-heroui && CI=1 NODE_ENV=test E2E_CLIENT_PORT=3511 E2E_SERVER_PORT=3512 ./node_modules/.bin/playwright test e2e/ai-media-sharing.spec.ts --project=chromium
cd client-heroui && npm test -- src/components/CodeAgentRoomView.test.tsx src/components/CodeAgentToolMessage.test.tsx src/utils/codeAgent.test.ts
python3 -m venv /tmp/roomtalk-code-agent-pytest-venv
/tmp/roomtalk-code-agent-pytest-venv/bin/python -m pip install --upgrade pip pytest
/tmp/roomtalk-code-agent-pytest-venv/bin/python -m pytest server/roomtalk_code_agent_runner/tests
cd client-heroui && CI=1 E2E_CLIENT_PORT=3611 E2E_SERVER_PORT=3612 ./node_modules/.bin/playwright test e2e/code-agent-flows.spec.ts e2e/code-agent-mobile.mobile.spec.ts
embedded-postgres execute smoke for migrate:media-to-object-storage
```

Observed results:

- Server build passed.
- Server tests passed: 392/392.
- Media migration CLI help printed the real command usage, proving the npm entrypoint is no longer a placeholder failure.
- Code Agent E2B smoke skipped safely without `RUN_CODE_AGENT_E2B_SMOKE=true`.
- Real Code Agent E2B smoke passed with a remote sandbox, JSONL runner events, `deepseek-v4-pro`, and sandbox cleanup.
- Client lint passed.
- Playwright `ai-media-sharing.spec.ts` passed 6/6, including browser image upload/send/render through local media storage.
- Code Agent component tests passed 8/8.
- Python JSONL runner tests passed 16/16 in a temporary pytest environment.
- Playwright Code Agent E2E passed 3/3, including fake-runner tool history restore, running-turn locks, and mobile workspace/composer layout.
- Embedded PostgreSQL execute smoke for `migrate:media-to-object-storage` passed:
  - started a disposable PostgreSQL server from the `embedded-postgres` npm package;
  - seeded a room with one legacy `data:image/png;base64,...` media message;
  - ran `npm run migrate:media-to-object-storage -- --execute --room-id=<seeded-room-id>` against local media storage;
  - verified the message content was cleared, message and asset MIME types became `image/webp`, one `media_assets` row was created, and the local object plus metadata file existed;
  - reran execute mode and verified it skipped the already asset-backed message without creating duplicate assets.
- GitHub Actions `CI/CD` completed successfully for the pushed migration audit commits.

## External Review Gate

The earlier workflow required Claude Code review after implementation rounds. That external review gate is no longer required for this audit because the user explicitly waived it on 2026-06-26 after repeated Claude CLI authentication failures.

Historical context: `claude auth status` reported a logged-in Claude Max account, but `claude -p ...` returned `401 Invalid authentication credentials` even in safe mode and with project settings removed. This was treated as an external Claude CLI auth/session issue rather than a repository test failure.

## Audit Conclusion

All repository migration lines listed above have implementation, documentation, local verification, targeted unit or component tests, relevant E2E coverage, manual smoke validation, and successful CI evidence. No remaining repository migration gate is open.
