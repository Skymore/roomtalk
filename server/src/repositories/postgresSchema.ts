export const POSTGRES_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    last_activity_at TIMESTAMPTZ NOT NULL,
    creator_id TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rooms_creator_activity
    ON rooms (creator_id, last_activity_at DESC)`,
  `CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (room_id, client_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_room_members_client_joined
    ON room_members (client_id, joined_at DESC)`,
  `INSERT INTO room_members (room_id, client_id, role, joined_at)
    SELECT id, creator_id, 'owner', created_at
    FROM rooms
    ON CONFLICT (room_id, client_id) DO UPDATE SET
      role = CASE
        WHEN room_members.role = 'owner' THEN 'owner'
        ELSE EXCLUDED.role
      END`,
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
    message_type TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'ai', 'voice')),
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
  // Widen the message_type check to allow 'voice' on tables created before voice
  // messages existed. Drop-then-add keeps this idempotent across restarts.
  `ALTER TABLE room_messages DROP CONSTRAINT IF EXISTS room_messages_message_type_check`,
  `ALTER TABLE room_messages ADD CONSTRAINT room_messages_message_type_check
    CHECK (message_type IN ('text', 'image', 'ai', 'voice'))`,
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
  `CREATE TABLE IF NOT EXISTS room_ai_cost_totals (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    total_usd NUMERIC(18, 9) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];
