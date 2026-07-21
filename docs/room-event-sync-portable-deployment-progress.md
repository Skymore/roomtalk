# Room Event Sync and Portable Deployment Progress

[中文](room-event-sync-portable-deployment-progress.zh.md)

Status: Immutable-event source implementation complete; production migration not executed

Original infrastructure cutover: 2026-07-20. Immutable-event implementation verified: 2026-07-21.

Design authority: [target architecture](room-event-sync-portable-deployment.md)

## Cutover rules used

- Keep the direct-cutover series local until production evidence is complete, then publish the verified series to `origin/master`.
- Replace the old protocol directly; do not add a `messageVersion` compatibility layer.
- Use one application image across local Compose, Fly, and a future AWS target.
- Record real PostgreSQL, browser, container, restart, and restore evidence.

## Baseline and evidence commits

Work started from clean local `master` at `d94d2cd0`. The old client recovered by comparing `baseMessageVersion`; writes advanced `message_version` and `room_version`; Redis cache generations used `messageVersion`; and the repository had no Compose runtime.

| Stage | Scope | Status | Evidence commit(s) |
| --- | --- | --- | --- |
| 1 | Architecture decision, progress ledger, initial Compose runtime | Complete | `ec0ac9af` |
| 2 | PostgreSQL event stream, direct socket/client cutover, version retirement, integration/E2E coverage | Complete | `d2c051ab` |
| 3 | Operational rehearsal, current-doc cleanup, final evidence | Complete | `63ef29bc` |
| 4 | Completion audit: persistent local media, signed URLs, env interpolation, paired restore | Complete | `77a5826c` |
| 5 | Mac production runtime, SeaweedFS S3 target, source-data rehearsal, tunnel, backup/restore drill | Complete | `bdad6d2f`, `94d7feed`, `f878752d` |
| 6 | Final write freeze, log archive, data restore, DNS route, public HTTP/WebSocket/S3 smoke, explicit credentials | Complete | `a554554c`, `56871060` |
| 7 | Committed-event Socket fast path, bounded payload fallback, and large-gap snapshot recovery | Complete | Current release; focused evidence below |
| 8 | Immutable after-image events, local-only listener fan-out, listener reconnect anti-entropy, and one-time legacy-event boundary | Source complete; not deployed | Current working release; verification below |
| 9 | Public-member privacy, strict payload rejection, and bounded pre-placeholder AI buffering | Source complete; not deployed | Current working release; verification below |

The scheduled Fly workflow is disabled and the Fly app is scaled to zero. Supabase and Tigris remain intact as rollback sources. `room.ruit.me`, the compatibility hostname `roomtalk.ruit.me`, and `roomtalk-objects.ruit.me` now route to the Mac through a dedicated Cloudflare Tunnel. `ai-chat.wenlin.dev` is accepted by the runtime and can be routed separately through its existing DNS zone.

## Delivered architecture

- PostgreSQL is the only durable serving authority; Redis is rebuildable realtime/cache state.
- Canonical tables remain the source of truth. `room_events` is a bounded immutable `schemaVersion: 1` after-image changelog, not full Event Sourcing.
- PostgreSQL row triggers collect room/message/agent-turn/media mutations and a deferred writer appends complete safe after-images in the original transaction. Membership mutations append only an empty public `members.changed` signal; IDs and roles remain behind `get_room_role_members`. Delta reads decode stored payloads and do not hydrate current canonical rows.
- Clients use `snapshotSeq`, `afterSeq`, and `lastAppliedSeq`. PostgreSQL `NOTIFY` is only a post-commit hint; every app reads the exact sequence and emits it to local sockets with `io.local`.
- A client applies a Socket payload only when it is exactly contiguous with `lastAppliedSeq`. Missing, oversized, duplicate, or gapped payloads remain safe because `headSeq` drives durable replay.
- After a PG listener successfully re-LISTENs, the instance sends local `room_sync_required`; clients replay from the current cursor without clearing UI.
- Gaps of at most 500 events replay in pages of 100 / 256 KiB. A larger retained gap switches directly to a repeatable-read snapshot, then drains only the post-snapshot tail.
- `CURSOR_EXPIRED`, irreconcilable gaps, and `CURSOR_AHEAD` all resnapshot safely. Strict V1 decoding rejects missing, mistyped, or unexpected payload fields with `EVENT_PAYLOAD_INVALID`; the client does not acknowledge that sequence and replaces state from a canonical snapshot.
- The old history socket returns `UPGRADE_REQUIRED`; runtime `messageVersion`/`roomVersion` fields and database columns are gone.
- Complete-room ack/broadcast ordering uses a database-stamped, strictly monotonic `updatedAt`; it is a last-write guard, not another synchronization version.
- Hourly retention removes old contiguous prefixes. There is no periodic event-to-message merge because canonical state is already updated in the original transaction.
- AI execution continues to use a separate claim/retry outbox; room replay events are not worker jobs.
- Early `ai_chunk`, `a2ui_update`, and `ai_stream_end` traffic is buffered by `messageId` until the durable placeholder appears, with a 60-second TTL and 64-message / 512-event / 512-KiB caps. A final durable after-image is authoritative over older buffered data.
- Legacy `new_message`, `message_edited`, `message_deleted`, and `messages_cleared` durable broadcasts are removed. User-scoped `room_updated` remains for room lists and permission invalidation.
- Migration `0003_room_events_immutable_after_images` serializes concurrent startup, installs the writer, preserves stream heads, expires active legacy history, and appends an authorized V1 tombstone for deleted streams. Migration `0004_public_member_change_events` scrubs any pre-production member after-images and installs the empty public signal. Both run successfully in disposable PostgreSQL; this work did not run them against production or deploy the application.
- Production must use a maintenance window: stop every old app instance, take paired database/media backups, then start only the new image so `0003`/`0004` cannot overlap old decoders or writers. Future AWS multi-instance deployment needs a two-phase compatibility migration or the same stop-the-world cutover; source push alone does not migrate the database.
- Local production Compose runs SeaweedFS 4.29 behind the existing S3 adapter and expiring SigV4 URLs. Tigris and future AWS S3 use the same object keys and SDK boundary. `/api/status` reports media readiness.
- Compose commands require `--env-file .env.compose`, so the app and PostgreSQL receive the same configured credentials instead of unrelated defaults.

## Verification evidence

| Boundary | Result |
| --- | --- |
| Server full suite | 763/763 |
| Client full suite | 1,000/1,000 |
| Event hook + pending-AI-buffer focused suites | 30/30 |
| Broadcaster and listener focused suites | 7/7 |
| Socket message handlers | 30/30 |
| Real PostgreSQL event integration | 15/15 in a fresh disposable database |
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

Automation covers immutable A-then-B message history after later deletion, distinct room and agent-turn after-images, stable media metadata, empty public member-change signals and legacy member-payload scrubbing, strict rejection of malformed payloads, database-independent valid/invalid coverage for every V1 event contract, valid empty-content AI/media messages, bounded early transient buffering, durable-final precedence, preservation of dynamically added optimistic sends during chunk/A2UI/end updates, explicit DTO allowlisting against a future internal column, secret and expiring-URL exclusion, deletion tombstones after canonical rows disappear, rollback without sequence advancement, concurrent unique sequences, two stores concurrently applying the active/deleted legacy cutover exactly once, exact fast-path reads, oversized head-only fallback, three-instance local-only fan-out, listener re-LISTEN anti-entropy, simultaneous reconnect replay and duplicate fast path, cursor expiry, restored-database rollback, and the existing snapshot/replay flows. Media coverage also exercises explicit local and S3 selection, production signed-URL rejection/acceptance, browser upload/reload under `NODE_ENV=production`, app-restart persistence, and paired database/media restore.

The completion audit also rendered Compose with a custom `.env.compose` password and proved that the PostgreSQL service password and application `DATABASE_URL` matched. A fresh isolated stack used separate ports and volumes; after verification it was removed. Current Fly secrets were imported into macOS Keychain, and local production values were rewritten for `room.ruit.me`, PostgreSQL/Redis Compose services, and SeaweedFS without writing credentials into tracked files.

The production-data rehearsal restored `backups/roomtalk-supabase-public-precutover-20260720T1958Z.dump`; the frozen cutover restored `backups/roomtalk-supabase-public-final-20260720T2019Z.dump`. Both matched 98 rooms, 7,939 messages, 179 members, 404 media assets, 6,361 observability events, 28 outbox events, and 60 room-agent turns. Startup removed the retired version columns, created 98 room streams, and installed all room-event triggers. Historical rows intentionally remain snapshot state; new writes create events after cutover.

The full Tigris pre-copy matched 2,857 objects and 1,302,853,579 bytes across private room media, published sites, and stickers. `node scripts/backup-local-production.mjs` then stopped edge/app/object storage, produced one timestamp-paired PostgreSQL archive and SeaweedFS snapshot, and restarted the healthy stack. Both artifacts were restored into isolated targets; the restored S3 inventory matched exactly and the temporary targets were removed.

During the restart rehearsal, node-postgres initially surfaced an idle-client disconnect through the global `uncaughtException` handler. A pool-level error handler was added and tested; a second real PostgreSQL restart produced only the expected handled warning and re-established `LISTEN room_event_committed` within one second.

## Rollback and ongoing operations

Fly operational logs were archived before shutdown; database-backed observability/outbox/turn logs migrated with the final dump. Keep Fly, Supabase, and Tigris intact through the rollback window. A rollback after local writes begin requires reconciling those writes first; changing DNS alone is lossy. Run paired maintenance backups regularly, copy them off-host, and keep the Mac on AC power with Docker Desktop running.
