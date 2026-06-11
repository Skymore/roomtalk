export const POSTGRES_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    last_activity_at TIMESTAMPTZ NOT NULL,
    creator_id TEXT NOT NULL,
    message_version BIGINT NOT NULL DEFAULT 0,
    password_hash TEXT,
    posting_schedule JSONB
  )`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS message_version BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS password_hash TEXT`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS posting_schedule JSONB`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS room_version BIGINT NOT NULL DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS idx_rooms_creator_activity
    ON rooms (creator_id, last_activity_at DESC)`,
  `CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (room_id, client_id)
  )`,
  `ALTER TABLE room_members DROP CONSTRAINT IF EXISTS room_members_role_check`,
  `ALTER TABLE room_members ADD CONSTRAINT room_members_role_check
    CHECK (role IN ('owner', 'admin', 'member'))`,
  `CREATE INDEX IF NOT EXISTS idx_room_members_client_joined
    ON room_members (client_id, joined_at DESC)`,
  `CREATE TABLE IF NOT EXISTS room_saves (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (room_id, client_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_room_saves_client_saved
    ON room_saves (client_id, saved_at DESC)`,
  `CREATE TABLE IF NOT EXISTS room_messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    message_type TEXT NOT NULL CHECK (message_type IN ('text', 'ai', 'media')),
    username TEXT,
    avatar JSONB,
    mime_type TEXT,
    status TEXT CHECK (status IS NULL OR status IN ('streaming', 'complete', 'error')),
    ai_model JSONB,
    usage JSONB,
    cost JSONB,
    reply_to JSONB,
    updated_at TIMESTAMPTZ,
    position INTEGER NOT NULL
  )`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS reply_to JSONB`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`,
  // Legacy 'image'/'voice' rows were migrated to the unified 'media' type; the
  // constraint now only allows the current set. Drop-then-add keeps it idempotent.
  `ALTER TABLE room_messages DROP CONSTRAINT IF EXISTS room_messages_message_type_check`,
  `ALTER TABLE room_messages ADD CONSTRAINT room_messages_message_type_check
    CHECK (message_type IN ('text', 'ai', 'media'))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_room_messages_room_position
    ON room_messages (room_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_room_messages_room_timestamp
    ON room_messages (room_id, timestamp)`,
  `CREATE TABLE IF NOT EXISTS image_assets (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    message_id TEXT UNIQUE REFERENCES room_messages(id) ON DELETE SET NULL,
    object_key TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_image_assets_room
    ON image_assets (room_id, created_at ASC)`,
  `CREATE TABLE IF NOT EXISTS media_assets (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    message_id TEXT UNIQUE REFERENCES room_messages(id) ON DELETE SET NULL,
    object_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio')),
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    duration_ms INTEGER,
    uploaded_by_client_id TEXT,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_media_assets_room
    ON media_assets (room_id, created_at ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_media_assets_history
    ON media_assets (room_id, kind, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_media_assets_message
    ON media_assets (message_id)`,
  `CREATE TABLE IF NOT EXISTS pending_media_uploads (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio')),
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    uploaded_by_client_id TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pending_media_uploads_expires
    ON pending_media_uploads (expires_at ASC)`,
  `CREATE TABLE IF NOT EXISTS room_ai_cost_totals (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    total_usd NUMERIC(18, 9) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  // Global per-client profile data (currently just the display nickname),
  // keyed by the persistent clientId rather than a room.
  `CREATE TABLE IF NOT EXISTS client_profiles (
    client_id TEXT PRIMARY KEY,
    nickname TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

// One-time data migrations, applied at most once and recorded in the
// schema_migrations table. Unlike POSTGRES_SCHEMA_SQL (idempotent DDL that is
// safe to re-run every boot), these scan/rewrite rows, so re-running them on
// every cold start is pure wasted memory/IO on a busy database. Append new
// migrations with a fresh, never-reused id; never edit an applied migration in
// place (change its effect with a new migration instead).
export interface PostgresMigration {
  id: string;
  sql: string;
}

export const POSTGRES_MIGRATIONS: PostgresMigration[] = [
  {
    // Backfill an 'owner' membership row for every existing room's creator, so
    // rooms created before room_members existed still have an owner record.
    id: '0001_backfill_room_member_owners',
    sql: `INSERT INTO room_members (room_id, client_id, role, joined_at)
      SELECT id, creator_id, 'owner', created_at
      FROM rooms
      ON CONFLICT (room_id, client_id) DO UPDATE SET
        role = CASE
          WHEN room_members.role = 'owner' THEN 'owner'
          ELSE EXCLUDED.role
        END`,
  },
];
