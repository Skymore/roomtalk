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
  `CREATE TABLE IF NOT EXISTS room_messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    message_type TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'ai')),
    username TEXT,
    avatar JSONB,
    mime_type TEXT,
    status TEXT CHECK (status IS NULL OR status IN ('streaming', 'complete', 'error')),
    ai_model JSONB,
    usage JSONB,
    cost JSONB,
    reply_to JSONB,
    position INTEGER NOT NULL
  )`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS reply_to JSONB`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_room_messages_room_position
    ON room_messages (room_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_room_messages_room_timestamp
    ON room_messages (room_id, timestamp)`,
  `CREATE TABLE IF NOT EXISTS room_ai_cost_totals (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    total_usd NUMERIC(18, 9) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];
