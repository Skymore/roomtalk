# Redis/PostgreSQL Persistence Refactor Plan

[中文原文](postgres-persistence-plan.md)

Status: Completed historical plan
Reviewed: 2026-07-12

> This document preserves migration reasoning and phase acceptance. For current operations use the [PostgreSQL rollout runbook](postgres-rollout-runbook.md), `server/.env.example`, and `server/src/repositories/postgresSchema.ts`. The current schema also covers room members/saves, accounts/auth, push subscriptions, media assets, pending uploads, and audio transcription state.
>
> 2026-07-20 update: the Redis durable fallback and message-version cache described below belong to the historical migration phase. The [room-event sync design](room-event-sync-portable-deployment.md) supersedes them; runtime now requires PostgreSQL and uses `snapshotSeq/afterSeq` plus the room-event head as sync/cache boundaries.

## Goal

Split the original single-Redis persistence model into explicit responsibilities:

- PostgreSQL owns durable business facts: rooms, messages, membership, usage/cost, authentication, media metadata, and recoverable state.
- Redis owns realtime collaboration: Socket.IO/session state, presence, ephemeral counts, and optional short-TTL read cache.

The Redis durable path had to remain usable during rollout. PostgreSQL was enabled by configuration so production could canary and roll back without rewriting application behavior.

## Core Principles

1. Durable business data has one selected authority. When PostgreSQL mode is enabled, Redis is not a second writable copy of rooms/messages.
2. An in-progress AI response has a durable placeholder/status. Redis may accelerate chunks but cannot be its only record.
3. Socket delivery is an optimization. Reconnecting clients reconcile from durable history.
4. Writes commit to the durable store before cache invalidation and broadcast.
5. Cache invalidation failure must not corrupt the authority; TTL bounds stale-read duration.
6. Store selection is explicit and testable through a shared contract.

## Storage Models

RoomTalk supports two operating models, not three independent authorities:

- `redis`: Redis is both durable room/message store and realtime store.
- `postgres`: PostgreSQL is the durable store; Redis remains the realtime store and may be a read cache.

There is no supported “PostgreSQL without Redis realtime” mode, and no dual-write Redis+PostgreSQL durable mode. The second model is often described operationally as PostgreSQL + Redis because both services are present, but their ownership differs.

## In-Progress State

A message with `status=streaming` represents accepted work whose final content is not yet durable. Completion atomically records final content, usage/cost, and terminal status where possible. Startup/recovery logic identifies abandoned streaming records and converts them to an explicit failure instead of leaving an endless spinner.

## Cache Consistency

The optional message-history cache is read-through and TTL-bound. A successful durable write invalidates affected room/history keys before realtime notification. Cache misses and cache failures fall back to PostgreSQL. Cache content is never migrated as durable data and can be flushed during rollback or incident response.

## Historical Phases

### Phase 1: Interfaces and Plan

Created `DurableRoomStore`, `RealtimeRoomStore`, optional cache boundaries, and `CompositeRoomStore`. Existing Redis behavior became one implementation of the durable contract.

### Phase 2: PostgreSQL Durable Store

Added schema initialization, transactions, row mapping, room/message/member operations, usage accounting, and contract parity tests.

### Phase 3: Streaming Persistence Boundary

Made AI placeholders and terminal transitions durable, defined startup recovery, and kept transient chunk delivery outside the durable schema.

### Phase 4: Cache and Recovery

Introduced bounded read cache, invalidation, degraded-cache behavior, and recovery tests.

### Phase 5: Migration and Deployment

Built the Redis-to-PostgreSQL migration with dry run, validation, idempotency, conflict handling, backups, counts/checksums, and explicit execution gates. Added configuration canary and rollback steps.

### Phase 6: Production Runbook

Documented prerequisites, application-role permissions, smoke tests, observability, cutover, rollback, and removal of obsolete migration assumptions.

## Result

The repository now implements the composite pattern described in `CLAUDE.md`: `PERSISTENCE_STORE=redis|postgres` selects the durable authority; Redis always supplies realtime state; PostgreSQL mode can enable Redis message caching. The production migration and broader schema expansion are recorded in the [migration retrospective](postgres-migration-development-summary.md).
