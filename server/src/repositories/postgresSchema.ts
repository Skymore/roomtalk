export const POSTGRES_COCO_SCHEMA_MIGRATION_VERSION = '20260516_coco_room_schema';

export const POSTGRES_BASE_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    last_activity_at TIMESTAMPTZ NOT NULL,
    creator_id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'chat' CHECK (type IN ('chat', 'coco')),
    sandbox_id TEXT,
    sandbox_status TEXT CHECK (sandbox_status IS NULL OR sandbox_status IN ('none', 'creating', 'ready', 'expired', 'error')),
    sandbox_updated_at TIMESTAMPTZ,
    coco_session_id TEXT,
    coco_status TEXT CHECK (coco_status IS NULL OR coco_status IN ('idle', 'running', 'error'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rooms_creator_activity
    ON rooms (creator_id, last_activity_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_rooms_coco_recovery
    ON rooms (type, sandbox_status, coco_status)`,
  `CREATE TABLE IF NOT EXISTS room_messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    message_type TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'ai', 'tool_call', 'tool_result', 'sandbox_status')),
    username TEXT,
    avatar JSONB,
    mime_type TEXT,
    status TEXT CHECK (status IS NULL OR status IN ('streaming', 'complete', 'error')),
    turn_id TEXT,
    tool_call_id TEXT,
    tool_name TEXT,
    tool_args JSONB,
    tool_output_preview TEXT,
    exit_code INTEGER,
    is_error BOOLEAN,
    ai_model JSONB,
    usage JSONB,
    cost JSONB,
    position INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_room_messages_room_position
    ON room_messages (room_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_room_messages_room_timestamp
    ON room_messages (room_id, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_room_messages_type_tool_call
    ON room_messages (message_type, room_id, tool_call_id)`,
  `CREATE TABLE IF NOT EXISTS room_ai_cost_totals (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    total_usd NUMERIC(18, 9) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

export const POSTGRES_COCO_SCHEMA_MIGRATION_SQL = [
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'chat'`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS sandbox_id TEXT`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS sandbox_status TEXT`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS sandbox_updated_at TIMESTAMPTZ`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS coco_session_id TEXT`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS coco_status TEXT`,
  `ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_type_check`,
  `ALTER TABLE rooms ADD CONSTRAINT rooms_type_check CHECK (type IN ('chat', 'coco'))`,
  `ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_sandbox_status_check`,
  `ALTER TABLE rooms ADD CONSTRAINT rooms_sandbox_status_check CHECK (sandbox_status IS NULL OR sandbox_status IN ('none', 'creating', 'ready', 'expired', 'error'))`,
  `ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_coco_status_check`,
  `ALTER TABLE rooms ADD CONSTRAINT rooms_coco_status_check CHECK (coco_status IS NULL OR coco_status IN ('idle', 'running', 'error'))`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS turn_id TEXT`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS tool_call_id TEXT`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS tool_name TEXT`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS tool_args JSONB`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS tool_output_preview TEXT`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS exit_code INTEGER`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS is_error BOOLEAN`,
  `ALTER TABLE room_messages DROP CONSTRAINT IF EXISTS room_messages_message_type_check`,
  `ALTER TABLE room_messages ADD CONSTRAINT room_messages_message_type_check CHECK (message_type IN ('text', 'image', 'ai', 'tool_call', 'tool_result', 'sandbox_status'))`,
  `INSERT INTO schema_migrations (version) VALUES ('${POSTGRES_COCO_SCHEMA_MIGRATION_VERSION}') ON CONFLICT (version) DO NOTHING`,
];

export const POSTGRES_SCHEMA_SQL = [
  ...POSTGRES_BASE_SCHEMA_SQL,
  ...POSTGRES_COCO_SCHEMA_MIGRATION_SQL,
];
