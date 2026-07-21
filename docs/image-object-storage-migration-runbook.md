# Legacy Image Media Object Storage Migration Runbook

[中文](image-object-storage-migration-runbook.zh.md)

Status: Current legacy-data migration runbook
Updated: 2026-07-20

> Status: active runbook. The current migration entrypoint is
> `cd server && npm run migrate:media-to-object-storage`.
> Do not run stale `dist/...migrateImageMessagesToObjectStorage.js` commands
> from older docs.

This runbook covers the one-time migration from legacy base64 image messages in PostgreSQL to private S3-compatible media object storage. Current production targets SeaweedFS; the retained rollback environment targets Tigris, and AWS targets S3 through the same adapter. PostgreSQL now uses the unified `media_assets` table; the old `image_assets` table has been removed.

## Decision

Run the migration from a local workstation or a dedicated migration container, never inside the serving RoomTalk app container.

The migration reads image payloads and runs `sharp` conversion, so it can compete with the live Node server for memory and CPU. The script still refuses to run on a Fly app VM by default as a legacy safety guard.

If a dedicated non-serving Fly migration machine is intentionally provisioned, set `ALLOW_FLY_APP_VM_IMAGE_MIGRATION=true` for that machine only. Do not set it on the serving app VM.

The intended migration converts legacy images to lossless WebP with `sharp`. The objective is:

- remove large base64 payloads from `room_messages.content`;
- store image bytes in private object storage;
- keep only asset metadata in PostgreSQL;
- preserve visual quality during this one-time cleanup.

## Prerequisites

- A verified PostgreSQL backup exists before execute mode.
- Local environment can reach the production PostgreSQL database.
- The migration environment has credentials and network access for the selected S3-compatible target. Current local production uses the loopback SeaweedFS S3 endpoint with path-style addressing.
- The deployed server already supports asset-backed image messages and signed read URLs.
- The migration script is present at `server/src/scripts/migrateLegacyMediaMessagesToObjectStorage.ts` and its npm entrypoint works.

Required environment variables:

```bash
DATABASE_URL="postgres://..."
POSTGRES_SSL="true"
MEDIA_BUCKET_NAME="message-system-media"
MEDIA_STORAGE_REGION="us-east-1"
MEDIA_STORAGE_ENDPOINT="http://127.0.0.1:8333"
MEDIA_STORAGE_FORCE_PATH_STYLE="true"
AWS_ACCESS_KEY_ID="..."
AWS_SECRET_ACCESS_KEY="..."
ROOMTALK_DB_BACKUP_FILE="/absolute/path/to/verified-backup.dump"
```

Do not commit these values.

## Dry Run

Run from the local `server` directory:

```bash
cd server
npm run build
npm run migrate:media-to-object-storage -- --room-id=<ROOM_ID>
```

Dry-run reads the selected room, decodes legacy image payloads, converts them to WebP in memory, and reports stats. It does not upload objects or update PostgreSQL.

For all rooms, omit `--room-id`.

## Execute

Start with the room that has known legacy image payloads:

```bash
cd server
npm run migrate:media-to-object-storage -- \
  --execute \
  --room-id=<ROOM_ID> \
  --backup-file="$ROOMTALK_DB_BACKUP_FILE"
```

The script is idempotent:

- messages that already have an image asset are skipped;
- uploaded objects are deleted best-effort if PostgreSQL replacement fails;
- repeated runs should not duplicate message rows or image assets.

Execute mode safety checks:

- `DATABASE_URL` is required.
- `--backup-file` or `ROOMTALK_DB_BACKUP_FILE` is required.
- The backup file path must be absolute and must point to an existing file.
- The script refuses to run on a Fly app VM unless `ALLOW_FLY_APP_VM_IMAGE_MIGRATION=true` is set for a dedicated legacy migration machine; never use that override in a serving container.
- Media object storage must be configured; development-only local media storage is acceptable only for local smoke tests against disposable databases.

## Verification

Before migration, the target room should show legacy image payloads:

```sql
SELECT
  COUNT(*) FILTER (WHERE m.message_type = 'media') AS media_messages,
  COUNT(*) FILTER (
    WHERE m.message_type = 'media'
      AND (a.id IS NULL OR a.kind IS DISTINCT FROM 'image')
      AND m.content LIKE 'data:image/%'
  ) AS legacy_base64_images,
  COUNT(*) FILTER (
    WHERE m.message_type = 'media'
      AND a.kind = 'image'
  ) AS asset_images,
  COALESCE(SUM(length(m.content)) FILTER (
    WHERE m.message_type = 'media'
      AND (a.id IS NULL OR a.kind IS DISTINCT FROM 'image')
      AND m.content LIKE 'data:image/%'
  ), 0) AS legacy_content_bytes
FROM room_messages m
LEFT JOIN media_assets a ON a.message_id = m.id
WHERE m.room_id = '<ROOM_ID>';
```

After migration:

- `legacy_base64_images` should be `0`;
- `asset_images` should match the previous image count;
- `legacy_content_bytes` should be near `0`;
- `media_assets` should contain one `kind = 'image'` row per migrated image message;
- room history loading should no longer transfer base64 image payloads.

## Rollback

The database backup is the rollback source of truth. If execute mode partially fails, rerun after fixing the issue; the script skips already asset-backed messages. If a completed migration must be undone, restore the verified backup and delete orphaned objects from the bucket.

## Test Coverage

- `server/src/scripts/migrateLegacyMediaMessagesToObjectStorage.test.ts` covers data URL parsing, dry-run behavior, execute-mode upload/replacement, idempotent asset-backed skips, failed replacement object cleanup, and CLI safety guards.
- Store contract tests cover `replaceMessageMediaAsset` behavior for Redis and PostgreSQL durable stores.
- `client-heroui/e2e/ai-media-sharing.spec.ts` covers the browser image upload/send/render path with local media storage, so asset-backed image messages remain end-to-end visible after the migration.
