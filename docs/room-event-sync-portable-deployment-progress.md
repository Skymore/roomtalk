# Room Event Sync and Portable Deployment Progress

[中文](room-event-sync-portable-deployment-progress.zh.md)

Status: Production self-host cutover complete at `roomtalk.ruit.me`

Started/completed locally: 2026-07-20

Design authority: [target architecture](room-event-sync-portable-deployment.md)

## Working rules

- Keep every change local; do not push.
- Replace the old protocol directly; do not add a `messageVersion` compatibility layer.
- Use one application image across local Compose, Fly, and a future AWS target.
- Record real PostgreSQL, browser, container, restart, and restore evidence.

## Baseline and local commits

Work started from clean local `master` at `d94d2cd0`. The old client recovered by comparing `baseMessageVersion`; writes advanced `message_version` and `room_version`; Redis cache generations used `messageVersion`; and the repository had no Compose runtime.

| Stage | Scope | Status | Local commit |
| --- | --- | --- | --- |
| 1 | Architecture decision, progress ledger, initial Compose runtime | Complete | `ec0ac9af` |
| 2 | PostgreSQL event stream, direct socket/client cutover, version retirement, integration/E2E coverage | Complete | `d2c051ab` |
| 3 | Operational rehearsal, current-doc cleanup, final evidence | Complete | This documentation commit |
| 4 | Completion audit: persistent local media, signed URLs, env interpolation, paired restore | Complete | This completion commit |
| 5 | Mac production runtime, SeaweedFS S3 target, source-data rehearsal, tunnel, backup/restore drill | Complete | This self-host commit |
| 6 | Final write freeze, log archive, data restore, DNS route, public HTTP/WebSocket/S3 smoke | Complete | This cutover commit |

No commit was pushed. The scheduled Fly workflow is disabled and the Fly app is scaled to zero. Supabase and Tigris remain intact as rollback sources. `roomtalk.ruit.me` and `roomtalk-objects.ruit.me` now route to the Mac through a dedicated Cloudflare Tunnel.

## Delivered architecture

- PostgreSQL is the only durable serving authority; Redis is rebuildable realtime/cache state.
- Canonical tables remain the source of truth. `room_events` is a bounded state-transfer changelog, not full Event Sourcing.
- PostgreSQL triggers append committed room events atomically with room, message, and agent-turn writes.
- Clients use `snapshotSeq`, `afterSeq`, and `lastAppliedSeq`; Socket.IO/`NOTIFY` are wake-up hints only.
- `CURSOR_EXPIRED`, gaps, and `CURSOR_AHEAD` all resnapshot safely.
- The old history socket returns `UPGRADE_REQUIRED`; runtime `messageVersion`/`roomVersion` fields and database columns are gone.
- Complete-room ack/broadcast ordering uses a database-stamped, strictly monotonic `updatedAt`; it is a last-write guard, not another synchronization version.
- Hourly retention removes old contiguous prefixes. There is no periodic event-to-message merge because canonical state is already updated in the original transaction.
- AI execution continues to use a separate claim/retry outbox; room replay events are not worker jobs.
- Local production Compose runs SeaweedFS 4.29 behind the existing S3 adapter and expiring SigV4 URLs. Tigris and future AWS S3 use the same object keys and SDK boundary. `/api/status` reports media readiness.
- Compose commands require `--env-file .env.compose`, so the app and PostgreSQL receive the same configured credentials instead of unrelated defaults.

## Verification evidence

| Boundary | Result |
| --- | --- |
| Server full suite | 749/749 |
| Client full suite | 985/985 |
| Event hook focused suite | 15/15 |
| Socket message handlers | 29/29 |
| Real PostgreSQL event integration | 6/6 |
| PostgreSQL Playwright | 4/4 |
| Production builds and client lint | Passed |
| Standalone root Dockerfile build | Passed without Compose-specific build inputs |
| PostgreSQL persistence smoke | PostgreSQL API path passed; unavailable database failed closed before listen |
| Compose | Fresh and standard stacks healthy; `/api/status` reported PostgreSQL, Redis, and configured media |
| PostgreSQL restart | Marker and event head survived; pool and LISTEN reconnected without an uncaught exception |
| Backup/restore | Matching PostgreSQL 17 custom archive (170 TOC entries) and media tarball both restored fresh |
| Production PostgreSQL rehearsal | Supabase `public` dump restored into an isolated PostgreSQL 17 database; current migrations and event schema started successfully |
| Production S3 rehearsal | 2,857 Tigris objects / 1,302,853,579 bytes copied and verified in SeaweedFS |
| SeaweedFS maintenance restore | Matching database dump restored fresh; raw object snapshot started as an isolated S3 service with all 2,857 objects and bytes readable |
| Public edge | TLS and page/status HTTP passed; Socket.IO polling and WebSocket upgrade returned a valid session / `101 Switching Protocols` |
| End-to-end production smoke | Register/create/join, text snapshot, room-event delta, presigned public S3 PUT/GET byte match, delete tombstone, and cleanup passed |

The event-schema restore contained one room, member, message, stream, and two ordered events (`headSeq=2`). All nine event triggers plus the monotonic room timestamp trigger were present, and retired version-column count was zero. A later paired rehearsal restored `backups/roomtalk-20260720T123725Z.dump` into a fresh database and `backups/roomtalk-media-20260720T123725Z.tar.gz` into a fresh volume. The restored room/media/message relationship matched, and the restored object SHA-256 was byte-identical. Temporary databases, volumes, markers, and the isolated Compose project were removed.

## Covered common cases

Automation covers a repeatable snapshot boundary, online delivery, offline replay without refresh, duplicate wake-ups/events, sequence gaps, cursor retention expiry, restored-database cursor rollback, concurrent writers, monotonic complete-room metadata, idempotent retries, transaction rollback, edit/delete/clear/truncate flows, AI final/error recovery, media completion, two-client realtime, authorization, and deleted-room tombstone replay. Media coverage now also exercises explicit local and S3 selection, production signed-URL rejection/acceptance, browser upload/reload under `NODE_ENV=production`, app-restart persistence, and paired database/media restore.

The completion audit also rendered Compose with a custom `.env.compose` password and proved that the PostgreSQL service password and application `DATABASE_URL` matched. A fresh isolated stack used separate ports and volumes; after verification it was removed. Current Fly secrets were imported into macOS Keychain, and local production values were rewritten for `roomtalk.ruit.me`, PostgreSQL/Redis Compose services, and SeaweedFS without writing credentials into tracked files.

The production-data rehearsal restored `backups/roomtalk-supabase-public-precutover-20260720T1958Z.dump`; the frozen cutover restored `backups/roomtalk-supabase-public-final-20260720T2019Z.dump`. Both matched 98 rooms, 7,939 messages, 179 members, 404 media assets, 6,361 observability events, 28 outbox events, and 60 room-agent turns. Startup removed the retired version columns, created 98 room streams, and installed all room-event triggers. Historical rows intentionally remain snapshot state; new writes create events after cutover.

The full Tigris pre-copy matched 2,857 objects and 1,302,853,579 bytes across private room media, published sites, and stickers. `node scripts/backup-local-production.mjs` then stopped edge/app/object storage, produced one timestamp-paired PostgreSQL archive and SeaweedFS snapshot, and restarted the healthy stack. Both artifacts were restored into isolated targets; the restored S3 inventory matched exactly and the temporary targets were removed.

During the restart rehearsal, node-postgres initially surfaced an idle-client disconnect through the global `uncaughtException` handler. A pool-level error handler was added and tested; a second real PostgreSQL restart produced only the expected handled warning and re-established `LISTEN room_event_committed` within one second.

## Rollback and ongoing operations

Fly operational logs were archived before shutdown; database-backed observability/outbox/turn logs migrated with the final dump. Keep Fly, Supabase, and Tigris intact through the rollback window. A rollback after local writes begin requires reconciling those writes first; changing DNS alone is lossy. Run paired maintenance backups regularly, copy them off-host, and keep the Mac on AC power with Docker Desktop running.
