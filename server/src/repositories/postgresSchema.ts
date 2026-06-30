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
    posting_schedule JSONB,
    type TEXT NOT NULL DEFAULT 'chat' CHECK (type IN ('chat', 'coco')),
    sandbox_id TEXT,
    sandbox_status TEXT CHECK (sandbox_status IS NULL OR sandbox_status IN ('none', 'creating', 'ready', 'expired', 'error')),
    sandbox_updated_at TIMESTAMPTZ,
    coco_session_id TEXT,
    coco_status TEXT CHECK (coco_status IS NULL OR coco_status IN ('idle', 'running', 'error'))
  )`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS message_version BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS password_hash TEXT`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS posting_schedule JSONB`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS room_version BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'chat'`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS sandbox_id TEXT`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS sandbox_status TEXT`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS sandbox_updated_at TIMESTAMPTZ`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS coco_session_id TEXT`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS coco_status TEXT`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS coco_access TEXT`,
  `ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_coco_access_check`,
  `ALTER TABLE rooms ADD CONSTRAINT rooms_coco_access_check
    CHECK (coco_access IS NULL OR coco_access IN ('owner', 'admin', 'member'))`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS code_agent_mode TEXT`,
  `ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_code_agent_mode_check`,
  `ALTER TABLE rooms ADD CONSTRAINT rooms_code_agent_mode_check
    CHECK (code_agent_mode IS NULL OR code_agent_mode IN ('plan', 'acceptEdits'))`,
  `ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_type_check`,
  `ALTER TABLE rooms ADD CONSTRAINT rooms_type_check
    CHECK (type IN ('chat', 'coco'))`,
  `ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_sandbox_status_check`,
  `ALTER TABLE rooms ADD CONSTRAINT rooms_sandbox_status_check
    CHECK (sandbox_status IS NULL OR sandbox_status IN ('none', 'creating', 'ready', 'expired', 'error'))`,
  `ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_coco_status_check`,
  `ALTER TABLE rooms ADD CONSTRAINT rooms_coco_status_check
    CHECK (coco_status IS NULL OR coco_status IN ('idle', 'running', 'error'))`,
  `CREATE INDEX IF NOT EXISTS idx_rooms_creator_activity
    ON rooms (creator_id, last_activity_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_rooms_coco_recovery
    ON rooms (type, sandbox_status, coco_status)`,
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
    message_type TEXT NOT NULL CHECK (message_type IN ('text', 'ai', 'media', 'sticker', 'tool_call', 'tool_result', 'sandbox_status')),
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
    reply_to JSONB,
    ui_payload JSONB,
    ai_stream_owner_id TEXT,
    updated_at TIMESTAMPTZ,
    position INTEGER NOT NULL
  )`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS reply_to JSONB`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS ui_payload JSONB`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS ai_stream_owner_id TEXT`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS turn_id TEXT`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS tool_call_id TEXT`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS tool_name TEXT`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS tool_args JSONB`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS tool_output_preview TEXT`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS exit_code INTEGER`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS is_error BOOLEAN`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS code_agent_mode TEXT`,
  // Legacy media rows can predate the unified 'media' message type. Normalize
  // them after dropping older checks so the narrower constraint is startup-safe.
  `ALTER TABLE room_messages DROP CONSTRAINT IF EXISTS room_messages_message_type_check`,
  `UPDATE room_messages
    SET message_type = 'media'
    WHERE message_type IN ('image', 'voice', 'audio', 'video')`,
  `ALTER TABLE room_messages ADD CONSTRAINT room_messages_message_type_check
    CHECK (message_type IN ('text', 'ai', 'media', 'sticker', 'tool_call', 'tool_result', 'sandbox_status'))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_room_messages_room_position
    ON room_messages (room_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_room_messages_room_timestamp
    ON room_messages (room_id, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_room_messages_type_tool_call
    ON room_messages (message_type, room_id, tool_call_id)`,
  `CREATE TABLE IF NOT EXISTS media_assets (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    message_id TEXT UNIQUE REFERENCES room_messages(id) ON DELETE SET NULL,
    object_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'file')),
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    filename TEXT,
    width INTEGER,
    height INTEGER,
    duration_ms INTEGER,
    uploaded_by_client_id TEXT,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS filename TEXT`,
  `ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_kind_check`,
  `ALTER TABLE media_assets ADD CONSTRAINT media_assets_kind_check
    CHECK (kind IN ('image', 'video', 'audio', 'file'))`,
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
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'file')),
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    filename TEXT,
    uploaded_by_client_id TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `ALTER TABLE pending_media_uploads ADD COLUMN IF NOT EXISTS filename TEXT`,
  `ALTER TABLE pending_media_uploads DROP CONSTRAINT IF EXISTS pending_media_uploads_kind_check`,
  `ALTER TABLE pending_media_uploads ADD CONSTRAINT pending_media_uploads_kind_check
    CHECK (kind IN ('image', 'video', 'audio', 'file'))`,
  `CREATE INDEX IF NOT EXISTS idx_pending_media_uploads_expires
    ON pending_media_uploads (expires_at ASC)`,
  `CREATE TABLE IF NOT EXISTS audio_transcriptions (
    asset_id TEXT PRIMARY KEY REFERENCES media_assets(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    requested_by_client_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    transcript TEXT,
    language_code TEXT,
    provider TEXT NOT NULL CHECK (provider IN ('assemblyai')),
    provider_transcript_id TEXT,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audio_transcriptions_room_message
    ON audio_transcriptions (room_id, message_id)`,
  `CREATE TABLE IF NOT EXISTS room_ai_cost_totals (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    total_usd NUMERIC(18, 9) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS assistant_runs (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    requested_by_client_id TEXT NOT NULL,
    user_message_id TEXT,
    ai_message_id TEXT NOT NULL REFERENCES room_messages(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'error', 'cancelled')),
    model_id TEXT NOT NULL,
    api_model TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('openai', 'openrouter', 'deepseek', 'anthropic')),
    role_name TEXT,
    system_prompt TEXT,
    max_context_messages INTEGER,
    retry_for_message_id TEXT,
    edited_message_id TEXT,
    error TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL,
    queued_at TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_assistant_runs_room_created
    ON assistant_runs (room_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_assistant_runs_status_updated
    ON assistant_runs (status, updated_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_runs_ai_message
    ON assistant_runs (ai_message_id)`,
  `CREATE TABLE IF NOT EXISTS outbox_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    room_id TEXT,
    payload JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at TIMESTAMPTZ NOT NULL,
    locked_at TIMESTAMPTZ,
    locked_by TEXT,
    processed_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_outbox_events_claim
    ON outbox_events (status, available_at, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_outbox_events_aggregate
    ON outbox_events (aggregate_type, aggregate_id, created_at)`,
  // Global per-client profile data (currently just the display nickname),
  // keyed by the persistent clientId rather than a room.
  `CREATE TABLE IF NOT EXISTS client_profiles (
    client_id TEXT PRIMARY KEY,
    nickname TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    primary_client_id TEXT NOT NULL UNIQUE,
    display_name TEXT,
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    last_login_at TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS account_identities (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('google')),
    provider_subject TEXT NOT NULL,
    email TEXT,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (provider, provider_subject)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_account_identities_account_id
    ON account_identities (account_id)`,
  `CREATE TABLE IF NOT EXISTS client_account_links (
    client_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
    linked_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_client_account_links_account_id
    ON client_account_links (account_id)`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    browser_instance_id TEXT,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS browser_instance_id TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_push_subscriptions_client_id
    ON push_subscriptions (client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_push_subscriptions_browser_instance_id
    ON push_subscriptions (browser_instance_id)`,
  `CREATE TABLE IF NOT EXISTS client_passwords (
    client_id TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS client_auth_tokens (
    token_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    account_id TEXT,
    auth_method TEXT CHECK (auth_method IS NULL OR auth_method IN ('password', 'google')),
    created_at TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ
  )`,
  `ALTER TABLE client_auth_tokens ADD COLUMN IF NOT EXISTS account_id TEXT`,
  `ALTER TABLE client_auth_tokens ADD COLUMN IF NOT EXISTS auth_method TEXT`,
  `ALTER TABLE client_auth_tokens DROP CONSTRAINT IF EXISTS client_auth_tokens_auth_method_check`,
  `ALTER TABLE client_auth_tokens ADD CONSTRAINT client_auth_tokens_auth_method_check
    CHECK (auth_method IS NULL OR auth_method IN ('password', 'google'))`,
  `ALTER TABLE client_auth_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
  `CREATE INDEX IF NOT EXISTS idx_client_auth_tokens_client_id
    ON client_auth_tokens (client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_client_auth_tokens_account_id
    ON client_auth_tokens (account_id)`,
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
