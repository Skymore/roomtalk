# Room Event Sync and Portable Deployment Progress

[中文](room-event-sync-portable-deployment-progress.zh.md)

Status: In progress

Started: 2026-07-20

Design authority: [target architecture](room-event-sync-portable-deployment.md)

## Working rules

- Keep every change local; do not push.
- Do not add an old `messageVersion` sync compatibility layer.
- Local Compose and Fly run the same application code with environment-only differences.
- Use roughly three stage commits rather than one commit per small edit.
- Record concrete test, build, Compose, and runtime evidence before marking work complete.

## Baseline

Implementation started from local `master` at `d94d2cd0` with a clean worktree. The repository had a production Dockerfile and Fly configuration but no Compose runtime. Message recovery still sent `baseMessageVersion`, message writes advanced both durable version fields, and the Redis message cache used `messageVersion` as its generation.

## Stages

| Stage | Scope | Status | Local commit | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Final design, progress ledger, local Compose runtime | Verified, commit pending | Pending | Compose 2.23 config/build, PostgreSQL health/restart persistence, custom dump |
| 2 | Server event stream, atomic writes, snapshot/delta protocol, retention | Not started | Pending | Store, PostgreSQL/Redis, and socket tests |
| 3 | Client cursor/reducer/cache cutover and end-to-end verification | Not started | Pending | Hook tests, builds, PostgreSQL E2E, Compose smoke |

Stage 1 now has a real local image and healthy PostgreSQL/Redis/app stack. `/api/status` reports PostgreSQL persistence, a marker room survived a PostgreSQL restart, and the operations profile produced a custom archive readable by `pg_restore --list`.

The complete mutation checklist, integration/E2E scenario matrix, validation evidence, and dated activity log are maintained in the [Chinese progress record](room-event-sync-portable-deployment-progress.zh.md).
