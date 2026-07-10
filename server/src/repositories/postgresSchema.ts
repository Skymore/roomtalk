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
    type TEXT NOT NULL DEFAULT 'chat' CHECK (type IN ('chat', 'codeAgent')),
    sandbox_id TEXT,
    sandbox_status TEXT CHECK (sandbox_status IS NULL OR sandbox_status IN ('none', 'creating', 'ready', 'expired', 'error')),
    sandbox_updated_at TIMESTAMPTZ,
    sandbox_artifact_version TEXT,
    sandbox_code_agent_source_ref TEXT,
    code_agent_session_id TEXT,
    code_agent_status TEXT CHECK (code_agent_status IS NULL OR code_agent_status IN ('idle', 'running', 'error'))
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
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS sandbox_artifact_version TEXT`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS sandbox_code_agent_source_ref TEXT`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS code_agent_session_id TEXT`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS code_agent_status TEXT`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS code_agent_access TEXT`,
  `ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_code_agent_access_check`,
  `ALTER TABLE rooms ADD CONSTRAINT rooms_code_agent_access_check
    CHECK (code_agent_access IS NULL OR code_agent_access IN ('owner', 'admin', 'member'))`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS code_agent_mode TEXT`,
  `ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_code_agent_mode_check`,
  `ALTER TABLE rooms ADD CONSTRAINT rooms_code_agent_mode_check
    CHECK (code_agent_mode IS NULL OR code_agent_mode IN ('plan', 'acceptEdits', 'edit', 'approveForMe', 'fullAccess'))`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS code_agent_backend TEXT`,
  `ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_code_agent_backend_check`,
  `ALTER TABLE rooms ADD CONSTRAINT rooms_code_agent_backend_check
    CHECK (code_agent_backend IS NULL OR code_agent_backend IN ('code-agent', 'codex', 'codex-app-server'))`,
  `ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_type_check`,
  `ALTER TABLE rooms ADD CONSTRAINT rooms_type_check
    CHECK (type IN ('chat', 'codeAgent'))`,
  `ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_sandbox_status_check`,
  `ALTER TABLE rooms ADD CONSTRAINT rooms_sandbox_status_check
    CHECK (sandbox_status IS NULL OR sandbox_status IN ('none', 'creating', 'ready', 'expired', 'error'))`,
  `ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_code_agent_status_check`,
  `ALTER TABLE rooms ADD CONSTRAINT rooms_code_agent_status_check
    CHECK (code_agent_status IS NULL OR code_agent_status IN ('idle', 'running', 'error'))`,
  `CREATE INDEX IF NOT EXISTS idx_rooms_creator_activity
    ON rooms (creator_id, last_activity_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_rooms_code_agent_recovery
    ON rooms (type, sandbox_status, code_agent_status)`,
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
    model_step_id TEXT,
    model_step_sequence INTEGER,
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
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS model_step_id TEXT`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS model_step_sequence INTEGER`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS tool_call_id TEXT`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS tool_name TEXT`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS tool_args JSONB`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS tool_output_preview TEXT`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS exit_code INTEGER`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS is_error BOOLEAN`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS code_agent_mode TEXT`,
  `ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS code_agent_queued_input JSONB`,
  `CREATE INDEX IF NOT EXISTS idx_room_messages_code_agent_queue
    ON room_messages (room_id, position)
    WHERE code_agent_queued_input->>'state' = 'queued'`,
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
  `CREATE INDEX IF NOT EXISTS idx_room_messages_turn_model_step
    ON room_messages (room_id, turn_id, model_step_sequence)`,
  `CREATE TABLE IF NOT EXISTS room_agent_turns (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'error', 'cancelled')),
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    final_message_id TEXT REFERENCES room_messages(id) ON DELETE SET NULL,
    backend TEXT NOT NULL CHECK (backend IN ('code-agent', 'codex', 'codex-app-server')),
    assistant_name TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_room_agent_turns_room_started
    ON room_agent_turns (room_id, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_room_agent_turns_status_updated
    ON room_agent_turns (status, updated_at)`,
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
  `CREATE TABLE IF NOT EXISTS observability_events (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
    event TEXT NOT NULL,
    room_id TEXT,
    turn_id TEXT,
    session_id TEXT,
    client_id TEXT,
    provider TEXT,
    model TEXT,
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    cost_usd NUMERIC(18, 9),
    error_code TEXT,
    error_message TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb
  )`,
  `ALTER TABLE observability_events ADD COLUMN IF NOT EXISTS session_id TEXT`,
  `ALTER TABLE observability_events ADD COLUMN IF NOT EXISTS provider TEXT`,
  `ALTER TABLE observability_events ADD COLUMN IF NOT EXISTS model TEXT`,
  `ALTER TABLE observability_events ADD COLUMN IF NOT EXISTS duration_ms INTEGER`,
  `ALTER TABLE observability_events ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(18, 9)`,
  `ALTER TABLE observability_events ADD COLUMN IF NOT EXISTS error_code TEXT`,
  `ALTER TABLE observability_events ADD COLUMN IF NOT EXISTS error_message TEXT`,
  `ALTER TABLE observability_events ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb`,
  `ALTER TABLE observability_events DROP CONSTRAINT IF EXISTS observability_events_level_check`,
  `ALTER TABLE observability_events ADD CONSTRAINT observability_events_level_check
    CHECK (level IN ('debug', 'info', 'warn', 'error'))`,
  `ALTER TABLE observability_events DROP CONSTRAINT IF EXISTS observability_events_duration_ms_check`,
  `ALTER TABLE observability_events ADD CONSTRAINT observability_events_duration_ms_check
    CHECK (duration_ms IS NULL OR duration_ms >= 0)`,
  `CREATE INDEX IF NOT EXISTS idx_observability_events_turn_created
    ON observability_events (turn_id, created_at ASC)
    WHERE turn_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_observability_events_room_created
    ON observability_events (room_id, created_at ASC)
    WHERE room_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_observability_events_session_created
    ON observability_events (session_id, created_at ASC)
    WHERE session_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_observability_events_event_created
    ON observability_events (event, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_observability_events_level_created
    ON observability_events (level, created_at DESC)`,
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
  `CREATE TABLE IF NOT EXISTS codex_connections (
    client_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'codex' CHECK (provider = 'codex'),
    status TEXT NOT NULL CHECK (status IN ('pending', 'connected', 'reauth_required', 'disconnected')),
    encrypted_auth_json JSONB,
    auth_version INTEGER NOT NULL DEFAULT 0,
    key_version TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    last_validated_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    active_run_id TEXT,
    locked_until TIMESTAMPTZ,
    last_error TEXT
  )`,
  `ALTER TABLE codex_connections ADD COLUMN IF NOT EXISTS encrypted_auth_json JSONB`,
  `ALTER TABLE codex_connections ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE codex_connections ADD COLUMN IF NOT EXISTS key_version TEXT NOT NULL DEFAULT 'v1'`,
  `ALTER TABLE codex_connections ADD COLUMN IF NOT EXISTS last_validated_at TIMESTAMPTZ`,
  `ALTER TABLE codex_connections ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ`,
  `ALTER TABLE codex_connections ADD COLUMN IF NOT EXISTS active_run_id TEXT`,
  `ALTER TABLE codex_connections ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ`,
  `ALTER TABLE codex_connections ADD COLUMN IF NOT EXISTS last_error TEXT`,
  `ALTER TABLE codex_connections DROP CONSTRAINT IF EXISTS codex_connections_provider_check`,
  `ALTER TABLE codex_connections ADD CONSTRAINT codex_connections_provider_check
    CHECK (provider = 'codex')`,
  `ALTER TABLE codex_connections DROP CONSTRAINT IF EXISTS codex_connections_status_check`,
  `ALTER TABLE codex_connections ADD CONSTRAINT codex_connections_status_check
    CHECK (status IN ('pending', 'connected', 'reauth_required', 'disconnected'))`,
  `CREATE INDEX IF NOT EXISTS idx_codex_connections_status_updated
    ON codex_connections (status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_codex_connections_locked_until
    ON codex_connections (locked_until)
    WHERE locked_until IS NOT NULL`,
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
