# RoomTalk Room Event Sync and Portable Deployment

[中文](room-event-sync-portable-deployment.zh.md)

Status: Target architecture under implementation

Updated: 2026-07-20

## Decision

RoomTalk will directly replace message-version snapshot reconciliation with a durable per-room event stream. There is no compatibility layer for the old `baseMessageVersion` protocol.

```text
rooms / room_messages     materialized current state and history source
room_event_streams        per-room headSeq and minAvailableSeq
room_events               replayable application change log
outbox_events             claim/retry queue for one-time background work
```

The same application image must run in both environments:

- local: Docker Compose with RoomTalk, PostgreSQL 17, and Redis 7;
- cloud: the existing root `Dockerfile` and `fly.toml`, with managed PostgreSQL and Redis URLs;
- later AWS: the image on ECS/EKS, PostgreSQL on RDS, Redis on ElastiCache, and objects on S3.

Kubernetes is not required on the single Mac. Data portability comes from PostgreSQL backup/WAL contracts, not from copying a local container volume.

## Core invariants

Every user-visible durable room mutation must atomically:

1. lock and advance the room stream head;
2. update normalized `rooms` / `room_messages` state;
3. insert one semantic event at the allocated sequence;
4. insert an outbox task in the same transaction when background work is required;
5. broadcast only after commit.

The first protocol events are `messages.upserted`, `messages.deleted`, `history.truncated`, `history.cleared`, `room.updated`, and `room.deleted`. AI token chunks remain transient; the persisted final/error message is replayable.

Event payloads are bounded. Large tool output is referenced or fetched through the canonical entity path instead of copied into every event.

## Snapshot and delta protocol

`get_room_snapshot` returns a consistent bounded room/message snapshot with `snapshotSeq`. Older history continues to use `beforeMessageId` pagination.

`get_room_events` accepts `afterSeq`, an event limit, and a byte limit. It returns ordered events, `headSeq`, `minAvailableSeq`, and `hasMore`. A cursor below the retained prefix receives `CURSOR_EXPIRED` and must reset through a new snapshot.

The client persists `lastAppliedSeq`. Duplicate events are ignored, contiguous events are reduced, gaps pause live application and trigger a delta read, and events received during a snapshot are buffered and replayed only when their sequence exceeds `snapshotSeq`.

Socket.IO is a low-latency wake-up path; the durable event table is the recovery authority.

## Retention, not event sourcing

The event log is not the sole source of truth, so events are never periodically merged into messages. A maintenance job only removes a contiguous old prefix, advances `minAvailableSeq`, and lets expired clients reset from materialized state. Events are never renumbered or removed from the middle.

The initial retention target is seven days or 10,000 events per room, with the older prefix pruned when either configured bound is exceeded. Production metrics will tune the limits.

## Direct replacement

The server and client switch together to `snapshotSeq/afterSeq`; the browser message-cache database name changes; stale bundles receive `UPGRADE_REQUIRED`; runtime reads and writes of `messageVersion` and ordering use of `roomVersion` are removed; the obsolete database columns are dropped by the final migration rather than dual-written.

Local Compose and Fly must run the same protocol revision. A production cutover may be a single maintenance-window switch, but it must first be rehearsed against a restored production copy.

## Portable runtime

The root `compose.yaml` is the local runtime source. PostgreSQL uses a named volume; Redis is rebuildable realtime/cache state when `PERSISTENCE_STORE=postgres`; `.env.compose` is local-only. The root Dockerfile remains the cloud build source and does not depend on Compose.

An on-demand custom-format backup is available with:

```bash
docker compose --profile ops run --rm postgres-backup
```

A local volume is not a backup. Production requires an off-host copy and a tested restore procedure.

See the [Chinese design](room-event-sync-portable-deployment.zh.md) for the complete event matrix, cutover boundary, and acceptance checklist. Actual implementation evidence is tracked in the [progress record](room-event-sync-portable-deployment-progress.md).
