# PostgreSQL Post-Migration Test Coverage Plan

[中文原文](postgres-test-coverage-plan.zh.md)

Status: Completed historical plan
Reviewed: 2026-07-12

> The original “current coverage” and “gaps” described the pre-implementation state on 2026-05-11. This English edition records the same test strategy and completed acceptance areas. Active commands remain authoritative in package scripts.

## Goal

Cover the high-risk gaps introduced by the PostgreSQL migration: contract parity, migration idempotency, large payloads, failure paths, persistence-mode switching, realtime multi-client behavior, and rollback safety.

The test pyramid has distinct jobs:

1. unit/contract tests verify mapping, transactions, failures, and store parity;
2. API/socket tests verify protocol, authorization, ordering, and broadcast boundaries;
3. browser E2E verifies that a real user can complete critical flows;
4. smoke scripts verify a configured external Redis/PostgreSQL instance without replacing the earlier layers.

## Initial Coverage and Gaps

Redis already covered room/message/cost/cache/socket membership and streaming recovery. PostgreSQL covered schema setup, core room/message writes, usage/cost, and rollback. Existing E2E focused mainly on the Redis path.

The main missing risks were full durable-store parity, migration retry/conflict behavior, large content, PostgreSQL-backed Playwright flows, multiple clients observing the same order, and an executable cutover/rollback smoke procedure.

## Phase 0: Plan and Review

Inventory every `DurableRoomStore` method, map each production user flow to a layer, identify destructive external-test prerequisites, and require review before expanding CI scope.

## Phase 1: Store Contract and Migration

- Run one shared store-contract suite against Redis and PostgreSQL.
- Cover create/join/leave, roles, settings, saves, message append/edit/delete, reactions, pagination, usage/cost, auth, push, and media metadata.
- Assert transaction rollback and uniqueness/conflict behavior.
- Test Redis-to-PostgreSQL dry run, execution gate, repeat execution, partial prior data, count/checksum validation, and unsupported records.
- Use disposable PostgreSQL databases/schemas; never infer a safe target from production-like environment variables.

## Phase 2: API/Socket Payload and Failure Regression

- Large messages and metadata near configured limits;
- malformed IDs, missing room, forbidden member action, and stale write;
- database unavailable/timeout/constraint failures mapped to bounded client errors;
- no success broadcast before durable commit;
- no duplicate message on retry or reconnect;
- interrupted AI streaming becomes an explicit recoverable/terminal state.

## Phase 3: PostgreSQL E2E

Add a guarded Playwright command that starts RoomTalk with `PERSISTENCE_STORE=postgres`, a disposable PostgreSQL URL, and isolated Redis realtime state. Reuse core user flows: create/join room, message/reply/reaction, settings/member management, saved rooms, reload/reconnect, media metadata, and controlled AI streaming.

The command must refuse ambiguous or non-test database names and clean only its own generated data.

## Phase 4: Multi-Client Realtime

Use at least two browser contexts to validate member presence, message order, edits/deletes/reactions, role changes, reconnect reconciliation, and absence of duplicate optimistic messages. Durable order is authoritative after reload; Socket.IO order alone is not the assertion source.

## Phase 5: Switch, Rollback, and Smoke Automation

- Run persistence smoke against local Redis DB 15 by default.
- Run the same smoke against an explicitly supplied test PostgreSQL URL.
- Validate startup/schema/app-user permissions before cutover.
- Exercise the migration in dry-run and execute modes on disposable data.
- Switch config to PostgreSQL, verify health and user flows, then prove config rollback to Redis durable mode.
- Treat PostgreSQL-written data after cutover as requiring an explicit reverse-data plan; changing config alone does not copy it back.

## Completed Acceptance Matrix

The completed line covers shared store behavior, schema/transaction failures, migration safety and idempotency, API/socket large and failure paths, PostgreSQL Playwright execution, multi-client realtime reconciliation, and persistence smoke commands.

Current commands:

```bash
cd server
npm test
npm run smoke:persistence
TEST_DATABASE_URL="postgres://localhost/message_system_test" npm run smoke:persistence

cd ../client-heroui
npm test
npm run test:e2e
npm run test:e2e:postgres
```

Use the [PostgreSQL rollout runbook](postgres-rollout-runbook.md) for production prerequisites and rollback boundaries.
