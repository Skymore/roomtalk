import { customAlphabet } from 'nanoid';
import { createHash } from 'node:crypto';
import { Logger } from '../logger';
import { AICost, CodeAgentQueueState, MediaAsset, Message, MessageMediaAsset, Room, RoomAgentTurn, RoomAICostTotal, RoomCodeAgentStatus, RoomEvent, RoomEventPage, RoomEventType, RoomMember, RoomMemberRole, RoomPostingSchedule, RoomSandboxStatus, RoomSnapshot, RoomType } from '../types';
import { getAIStreamFence, getAIStreamOwnerId, InterruptedStreamingMessageRecoveryOptions, withAIStreamRecoveryMetadata } from '../services/aiStreamRecovery';
import { AccountAIUsageInput, AccountAIUsageSettlement, AccountCreditGrantInput, AccountMembershipChangeInput, AccountRole, ActiveTaskDispatchQueryOptions, AIStreamClaimResult, AIStreamOwnership, AITerminalTransitionResult, AssistantRunClaim, AssistantRunClaimOptions, AssistantRunClaimToken, AssistantRunProjectionResult, AssistantRunRecord, AssistantRunTerminalPayloadV1, AudioTranscriptionRecord, AudioTranscriptionUpdate, ClientAccount, ClientAuthTokenRecord, CodeAgentCheckpointBoundary, CodeAgentCheckpointRestoreCommitInput, CodeAgentCheckpointRestoreCommitResult, CodeAgentCheckpointRestorePlan, CodeAgentCheckpointRestoreStep, CodeAgentMessageMutationResult, CodeAgentQueueMessageUpdate, CodeAgentRoomLease, CodeAgentTurnClaim, CodeAgentTurnStartInput, CodeAgentTurnStartResult, CodeAgentTurnTerminalInput, CodeAgentTurnTerminalResult, CodeAgentWorkspaceCheckpointRecord, CodeAgentWorkspaceRevisionRecord, CreateGoogleAccountInput, CreatePasswordAccountInput, DEFAULT_ROOM_MESSAGE_PAGE_LIMIT, DurableRoomStore, GoogleAccountProfile, GrantAccountRoleInput, IdempotentMessageAppendResult, MediaHistoryPage, MediaHistoryPageOptions, MediaMessageAppendResult, MessageUpdateResult, OutboxClaimOptions, OutboxClaimToken, OutboxEventRecord, OutboxFailOptions, PendingMediaUpload, PushSubscriptionRecord, RoomEventCursorAheadError, RoomEventCursorExpiredError, RoomEventPageOptions, RoomEventPayloadInvalidError, RoomEventRetentionOptions, RoomEventTooLargeError, RoomMessagePageOptions, RoomPaginationBoundaryExpiredError, RoomSandboxReplacement, RoomSettingsUpdate, SavePushSubscriptionInput, SetPasswordAccountCredentialsInput, TaskDispatchClaimOptions, TaskDispatchClaimToken, TaskDispatchMetrics, TaskDispatchRecord, UpdateAccountMembershipInput } from './store';
import { POSTGRES_MIGRATIONS, POSTGRES_SCHEMA_SQL } from './postgresSchema';
import { MediaObjectStorage } from '../services/mediaObjectStorage';
import { getMediaThumbnailObjectKey } from '../services/mediaThumbnail';
import { orderMessageBatches } from '../services/messageDomain';
import { validateStoredRoomEventPayload } from './roomEventPayload';
import { decodeAssistantRunRequestPayload, decodeAssistantRunTerminalPayload } from './assistantRunPayload';
import {
  AccountEntitlement,
  MembershipStatus,
  MembershipTier,
  resolveAssistantRunScheduling,
  resolveEffectiveMembershipTier,
} from '../services/accountEntitlements';

const nanoid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 10);

const checksumStatements = (statements: string[]) => createHash('sha256')
  .update(statements.join('\u0000'))
  .digest('hex');

const fingerprintAccountMembershipChange = (input: AccountMembershipChangeInput) => (
  createHash('sha256')
    .update(JSON.stringify({
      accountId: input.accountId,
      tier: input.tier,
      status: input.status,
      priorityOverride: input.priorityOverride ?? null,
      currentPeriodStart: input.currentPeriodStart ?? null,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
      externalProvider: input.externalProvider ?? null,
      externalCustomerId: input.externalCustomerId ?? null,
      externalSubscriptionId: input.externalSubscriptionId ?? null,
      creditGrantUsd: input.creditGrantUsd ?? 0,
      creditNote: input.creditNote ?? null,
    }))
    .digest('hex')
);

const REQUIRED_POSTGRES_MIGRATIONS = [
  {
    id: '0000_roomtalk_schema',
    statements: POSTGRES_SCHEMA_SQL,
    checksum: checksumStatements(POSTGRES_SCHEMA_SQL),
  },
  ...POSTGRES_MIGRATIONS.map(migration => ({
    id: migration.id,
    statements: [migration.sql],
    checksum: checksumStatements([migration.sql]),
  })),
];

export interface PostgresQueryResult<T = any> {
  rows: T[];
  rowCount: number | null;
}

export interface PostgresClient {
  query<T = any>(sql: string, params?: unknown[]): Promise<PostgresQueryResult<T>>;
  release(): void;
}

export interface PostgresPool {
  query<T = any>(sql: string, params?: unknown[]): Promise<PostgresQueryResult<T>>;
  connect(): Promise<PostgresClient>;
  on?(event: 'error', listener: (error: Error) => void): this;
  end?(): Promise<void>;
}

type PostgresQueryable = Pick<PostgresPool, 'query'>;

type RoomRow = {
  id: string;
  name: string;
  description: string | null;
  created_at: string | Date;
  last_activity_at: string | Date;
  creator_id: string;
  password_hash?: string | null;
  posting_schedule?: unknown;
  type?: RoomType | null;
  sandbox_id?: string | null;
  sandbox_status?: RoomSandboxStatus | null;
  sandbox_updated_at?: string | Date | null;
  sandbox_artifact_version?: string | null;
  sandbox_code_agent_source_ref?: string | null;
  code_agent_session_id?: string | null;
  code_agent_last_turn_id?: string | null;
  code_agent_workspace_revision_id?: string | null;
  code_agent_status?: RoomCodeAgentStatus | null;
  code_agent_access?: string | null;
  code_agent_mode?: string | null;
  code_agent_backend?: string | null;
  updated_at?: string | Date | null;
};

type RoomEventRow = {
  room_id: string;
  seq: number | string;
  event_type: RoomEventType;
  schema_version: number | string;
  payload: unknown;
  created_at: string | Date;
};

type StoredMediaAssetSnapshotRow = {
  id: string;
  message_id: string;
  kind: MediaAsset['kind'];
  mime_type: string;
  byte_size: number | string;
  filename?: string | null;
  width?: number | string | null;
  height?: number | string | null;
  duration_ms?: number | string | null;
};

type MessageRow = {
  id: string;
  room_id: string;
  client_id: string;
  client_message_id?: string | null;
  client_batch_id?: string | null;
  client_batch_index?: number | string | null;
  content: string;
  timestamp: string | Date;
  updated_at?: string | Date | null;
  message_type: Message['messageType'];
  username: string | null;
  avatar: unknown;
  mime_type: string | null;
  status: Message['status'] | null;
  turn_id?: string | null;
  model_step_id?: string | null;
  model_step_sequence?: number | string | null;
  tool_call_id?: string | null;
  tool_name?: string | null;
  tool_args?: unknown;
  tool_output_preview?: string | null;
  exit_code?: number | string | null;
  is_error?: boolean | null;
  ai_model: unknown;
  usage: unknown;
  cost: unknown;
  reply_to: unknown;
  ui_payload?: unknown;
  ai_stream_owner_id?: string | null;
  ai_stream_fence?: number | string;
  code_agent_mode?: string | null;
  code_agent_queued_input?: unknown;
  code_agent_image_message_ids?: unknown;
  position?: number | string;
};

type RoomMemberRow = {
  room_id: string;
  client_id: string;
  role: RoomMemberRole;
  joined_at: string | Date;
};

type CodeAgentRoomLeaseRow = {
  room_id: string;
  turn_id: string;
  owner_id: string;
  fence: number | string;
  expires_at: string | Date;
};

type MediaAssetRow = {
  id: string;
  room_id: string;
  message_id: string | null;
  object_key: string;
  kind: MediaAsset['kind'];
  mime_type: string;
  byte_size: number | string;
  filename: string | null;
  width: number | string | null;
  height: number | string | null;
  duration_ms: number | string | null;
  uploaded_by_client_id: string | null;
  created_at: string | Date;
};

type PendingMediaUploadRow = {
  id: string;
  room_id: string;
  object_key: string;
  kind: MediaAsset['kind'];
  mime_type: string;
  byte_size: number | string;
  filename: string | null;
  uploaded_by_client_id: string;
  expires_at: string | Date;
  created_at: string | Date;
};

type AudioTranscriptionRow = {
  asset_id: string;
  room_id: string;
  message_id: string;
  requested_by_client_id: string;
  status: AudioTranscriptionRecord['status'];
  transcript: string | null;
  language_code: string | null;
  provider: AudioTranscriptionRecord['provider'];
  provider_transcript_id: string | null;
  error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  completed_at: string | Date | null;
};

type AssistantRunRow = {
  id: string;
  room_id: string;
  requested_by_client_id: string;
  user_message_id: string | null;
  ai_message_id: string;
  status: AssistantRunRecord['status'];
  model_id: string;
  api_model: string;
  provider: AssistantRunRecord['provider'];
  role_name: string | null;
  system_prompt: string | null;
  max_context_messages: number | string | null;
  retry_for_message_id: string | null;
  edited_message_id: string | null;
  error: string | null;
  metadata: unknown;
  created_at: string | Date;
  queued_at: string | Date;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  updated_at: string | Date;
  request_payload: unknown;
  terminal_payload: unknown;
  generation: number | string;
  attempt: number | string;
  available_at: string | Date;
  lease_owner: string | null;
  lease_expires_at: string | Date | null;
  billing_account_id: string | null;
  membership_tier: AssistantRunRecord['membershipTier'];
  credit_state: AssistantRunRecord['creditState'];
  queue_priority: number | string;
  charged_cost_usd: number | string;
  credit_applied_usd: number | string;
};

type RoomAgentTurnRow = {
  id: string;
  room_id: string;
  status: RoomAgentTurn['status'];
  started_at: string | Date;
  completed_at: string | Date | null;
  final_message_id: string | null;
  backend: RoomAgentTurn['backend'];
  assistant_name: string;
  phase: RoomAgentTurn['phase'] | null;
  phase_message: string | null;
  last_heartbeat_at: string | Date | null;
  updated_at: string | Date;
  lease_owner?: string | null;
  lease_fence?: number | string | null;
  backend_session_id_before?: string | null;
  backend_last_turn_id_before?: string | null;
  backend_session_id_after?: string | null;
  backend_turn_id_after?: string | null;
  workspace_checkpoint?: unknown;
  workspace_parent_revision_id?: string | null;
  workspace_revision_id?: string | null;
};

type CodeAgentWorkspaceRevisionRow = {
  id: string;
  room_id: string;
  parent_revision_id: string | null;
  kind: CodeAgentWorkspaceRevisionRecord['kind'];
  turn_id: string | null;
  restore_id: string | null;
  restored_from_revision_id: string | null;
  restore_target_revision_id: string | null;
  backend_session_id: string | null;
  backend_last_turn_id: string | null;
  traversable: boolean;
  created_at: string | Date;
};

type OutboxEventRow = {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  room_id: string | null;
  payload: unknown;
  status: OutboxEventRecord['status'];
  attempts: number | string;
  available_at: string | Date;
  locked_at: string | Date | null;
  locked_by: string | null;
  processed_at: string | Date | null;
  last_error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type TaskDispatchRow = {
  run_id: string;
  status: TaskDispatchRecord['status'];
  attempts: number | string;
  available_at: string | Date;
  locked_at: string | Date | null;
  locked_by: string | null;
  dispatched_at: string | Date | null;
  last_error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  queue_priority: number | string;
};

type PushSubscriptionRow = {
  endpoint: string;
  client_id: string;
  browser_instance_id: string | null;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type ClientAccountRow = {
  account_id: string;
  primary_client_id: string;
  display_name: string | null;
  avatar_url: string | null;
  account_created_at: string | Date;
  account_updated_at: string | Date;
  last_login_at: string | Date | null;
  provider: 'google' | 'password';
  provider_subject: string;
  google_linked: boolean;
  email: string | null;
  email_verified: boolean | null;
};

type AccountEntitlementRow = {
  account_id: string;
  tier: MembershipTier;
  status: MembershipStatus;
  priority_override: number | string | null;
  current_period_start: string | Date | null;
  current_period_end: string | Date | null;
  external_provider: string | null;
  available_usd: number | string;
  lifetime_usage_usd: number | string;
  updated_at: string | Date;
};

const ROOM_COLUMNS = 'id, name, description, created_at, last_activity_at, creator_id, password_hash, posting_schedule, type, sandbox_id, sandbox_status, sandbox_updated_at, sandbox_artifact_version, sandbox_code_agent_source_ref, code_agent_session_id, code_agent_last_turn_id, code_agent_workspace_revision_id, code_agent_status, code_agent_access, code_agent_mode, code_agent_backend, updated_at';
const MESSAGE_COLUMNS = 'id, room_id, client_id, client_message_id, client_batch_id, client_batch_index, content, timestamp, updated_at, message_type, username, avatar, mime_type, status, turn_id, tool_call_id, tool_name, tool_args, tool_output_preview, exit_code, is_error, ai_model, usage, cost, reply_to, ai_stream_owner_id, ai_stream_fence, ui_payload, code_agent_mode, code_agent_queued_input, code_agent_image_message_ids, model_step_id, model_step_sequence';
const ROOM_MEMBER_COLUMNS = 'room_id, client_id, role, joined_at';
const MEDIA_ASSET_COLUMNS = 'id, room_id, message_id, object_key, kind, mime_type, byte_size, filename, width, height, duration_ms, uploaded_by_client_id, created_at';
const PENDING_MEDIA_UPLOAD_COLUMNS = 'id, room_id, object_key, kind, mime_type, byte_size, filename, uploaded_by_client_id, expires_at, created_at';
const AUDIO_TRANSCRIPTION_COLUMNS = 'asset_id, room_id, message_id, requested_by_client_id, status, transcript, language_code, provider, provider_transcript_id, error, created_at, updated_at, completed_at';
const ASSISTANT_RUN_COLUMNS = 'id, room_id, requested_by_client_id, user_message_id, ai_message_id, status, model_id, api_model, provider, role_name, system_prompt, max_context_messages, retry_for_message_id, edited_message_id, error, metadata, created_at, queued_at, started_at, completed_at, updated_at, request_payload, terminal_payload, generation, attempt, available_at, lease_owner, lease_expires_at, billing_account_id, membership_tier, credit_state, queue_priority, charged_cost_usd, credit_applied_usd';
const CLAIMED_ASSISTANT_RUN_COLUMNS = ASSISTANT_RUN_COLUMNS
  .split(', ')
  .map(column => `run.${column}`)
  .join(', ');
const ROOM_AGENT_TURN_COLUMNS = 'id, room_id, status, started_at, completed_at, final_message_id, backend, assistant_name, phase, phase_message, last_heartbeat_at, updated_at, backend_session_id_before, backend_last_turn_id_before, backend_session_id_after, backend_turn_id_after, workspace_checkpoint, workspace_parent_revision_id, workspace_revision_id';
const CODE_AGENT_WORKSPACE_REVISION_COLUMNS = 'id, room_id, parent_revision_id, kind, turn_id, restore_id, restored_from_revision_id, restore_target_revision_id, backend_session_id, backend_last_turn_id, traversable, created_at';
const OUTBOX_EVENT_COLUMNS = 'id, event_type, aggregate_type, aggregate_id, room_id, payload, status, attempts, available_at, locked_at, locked_by, processed_at, last_error, created_at, updated_at';
const CLAIMED_OUTBOX_EVENT_COLUMNS = 'e.id, e.event_type, e.aggregate_type, e.aggregate_id, e.room_id, e.payload, e.status, e.attempts, e.available_at, e.locked_at, e.locked_by, e.processed_at, e.last_error, e.created_at, e.updated_at';
const PUSH_SUBSCRIPTION_COLUMNS = 'endpoint, client_id, browser_instance_id, p256dh, auth, user_agent, created_at, updated_at';
const ACCOUNT_SELECT_COLUMNS = `
  a.id AS account_id,
  a.primary_client_id,
  a.display_name,
  a.avatar_url,
  a.created_at AS account_created_at,
  a.updated_at AS account_updated_at,
  a.last_login_at,
  CASE WHEN google_identity.provider_subject IS NULL THEN 'password' ELSE 'google' END AS provider,
  COALESCE(google_identity.provider_subject, a.primary_client_id) AS provider_subject,
  (google_identity.provider_subject IS NOT NULL) AS google_linked,
  google_identity.email,
  google_identity.email_verified`;

const parseTime = (timestamp?: string): number => {
  const time = Date.parse(timestamp || '');
  return Number.isFinite(time) ? time : 0;
};

const getLatestMessageTimestamp = (messages: Message[]): string | undefined => {
  return messages.reduce<string | undefined>((latest, message) => {
    if (!latest || parseTime(message.timestamp) > parseTime(latest)) {
      return message.timestamp;
    }

    return latest;
  }, undefined);
};

const toIsoString = (value: string | Date): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
};

const normalizeMessagePageLimit = (limit?: number): number => {
  if (!Number.isFinite(limit)) {
    return DEFAULT_ROOM_MESSAGE_PAGE_LIMIT;
  }

  return Math.min(200, Math.max(1, Math.floor(limit || DEFAULT_ROOM_MESSAGE_PAGE_LIMIT)));
};

const normalizeMediaHistoryPageLimit = (limit?: number): number => {
  if (!Number.isFinite(limit)) {
    return 40;
  }

  return Math.min(200, Math.max(1, Math.floor(limit || 40)));
};

const parseJsonValue = <T>(value: unknown): T | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }

  return value as T;
};

const toJsonb = (value: unknown) => value === undefined ? null : JSON.stringify(value);

const mapRoom = (row: RoomRow): Room => {
  const room: Room = {
    id: row.id,
    name: row.name,
    description: row.description || '',
    createdAt: toIsoString(row.created_at),
    lastActivityAt: toIsoString(row.last_activity_at || row.created_at),
    creatorId: row.creator_id,
  };
  if (row.password_hash) room.hasPassword = true;
  const postingSchedule = parseJsonValue<RoomPostingSchedule>(row.posting_schedule);
  if (postingSchedule) room.postingSchedule = postingSchedule;
  if (row.type && row.type !== 'chat') room.type = row.type;
  if (row.sandbox_id) room.sandboxId = row.sandbox_id;
  if (row.sandbox_status) room.sandboxStatus = row.sandbox_status;
  if (row.sandbox_updated_at) room.sandboxUpdatedAt = toIsoString(row.sandbox_updated_at);
  if (row.sandbox_artifact_version) room.sandboxArtifactVersion = row.sandbox_artifact_version;
  if (row.sandbox_code_agent_source_ref) room.sandboxCodeAgentSourceRef = row.sandbox_code_agent_source_ref;
  if (row.code_agent_session_id) room.codeAgentSessionId = row.code_agent_session_id;
  if (row.code_agent_last_turn_id) room.codeAgentLastTurnId = row.code_agent_last_turn_id;
  if (row.code_agent_status) room.codeAgentStatus = row.code_agent_status;
  if (row.code_agent_access) room.codeAgentAccess = row.code_agent_access as Room['codeAgentAccess'];
  if (row.code_agent_mode) room.codeAgentMode = row.code_agent_mode as Room['codeAgentMode'];
  if (row.code_agent_backend) room.codeAgentBackend = row.code_agent_backend as Room['codeAgentBackend'];
  if (row.updated_at) room.updatedAt = toIsoString(row.updated_at);
  return room;
};

const mapRoomMember = (row: RoomMemberRow): RoomMember => ({
  roomId: row.room_id,
  clientId: row.client_id,
  role: row.role,
  joinedAt: toIsoString(row.joined_at),
});

const mapCodeAgentRoomLease = (row: CodeAgentRoomLeaseRow): CodeAgentRoomLease => ({
  roomId: row.room_id,
  turnId: row.turn_id,
  ownerId: row.owner_id,
  fence: Number(row.fence),
  expiresAt: toIsoString(row.expires_at),
});

const mapCodeAgentWorkspaceRevision = (
  row: CodeAgentWorkspaceRevisionRow,
): CodeAgentWorkspaceRevisionRecord => ({
  id: row.id,
  roomId: row.room_id,
  ...(row.parent_revision_id ? { parentRevisionId: row.parent_revision_id } : {}),
  kind: row.kind,
  ...(row.turn_id ? { turnId: row.turn_id } : {}),
  ...(row.restore_id ? { restoreId: row.restore_id } : {}),
  ...(row.restored_from_revision_id ? { restoredFromRevisionId: row.restored_from_revision_id } : {}),
  ...(row.restore_target_revision_id ? { restoreTargetRevisionId: row.restore_target_revision_id } : {}),
  ...(row.backend_session_id ? { backendSessionId: row.backend_session_id } : {}),
  ...(row.backend_last_turn_id ? { backendLastTurnId: row.backend_last_turn_id } : {}),
  traversable: row.traversable,
  createdAt: toIsoString(row.created_at),
});

const toOptionalNumber = (value: number | string | null): number | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const mapMediaAsset = (row: MediaAssetRow): MediaAsset => {
  const asset: MediaAsset = {
    id: row.id,
    roomId: row.room_id,
    objectKey: row.object_key,
    kind: row.kind,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size) || 0,
    createdAt: toIsoString(row.created_at),
  };

  if (row.message_id) asset.messageId = row.message_id;
  if (row.filename) asset.filename = row.filename;
  if (row.uploaded_by_client_id) asset.uploadedByClientId = row.uploaded_by_client_id;
  const width = toOptionalNumber(row.width);
  const height = toOptionalNumber(row.height);
  const durationMs = toOptionalNumber(row.duration_ms);
  if (width !== undefined) asset.width = width;
  if (height !== undefined) asset.height = height;
  if (durationMs !== undefined) asset.durationMs = durationMs;
  return asset;
};

const mapPendingMediaUpload = (row: PendingMediaUploadRow): PendingMediaUpload => {
  const upload: PendingMediaUpload = {
    assetId: row.id,
    roomId: row.room_id,
    objectKey: row.object_key,
    kind: row.kind,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size) || 0,
    uploadedByClientId: row.uploaded_by_client_id,
    expiresAt: toIsoString(row.expires_at),
    createdAt: toIsoString(row.created_at),
  };
  if (row.filename) upload.filename = row.filename;
  return upload;
};

const mapAudioTranscription = (row: AudioTranscriptionRow): AudioTranscriptionRecord => {
  const record: AudioTranscriptionRecord = {
    assetId: row.asset_id,
    roomId: row.room_id,
    messageId: row.message_id,
    requestedByClientId: row.requested_by_client_id,
    status: row.status,
    provider: row.provider,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
  if (row.transcript) record.transcript = row.transcript;
  if (row.language_code) record.languageCode = row.language_code;
  if (row.provider_transcript_id) record.providerTranscriptId = row.provider_transcript_id;
  if (row.error) record.error = row.error;
  if (row.completed_at) record.completedAt = toIsoString(row.completed_at);
  return record;
};

const decodeAssistantRunRequestRow = (row: AssistantRunRow) => (
  decodeAssistantRunRequestPayload(row.request_payload, {
    roomId: row.room_id,
    modelId: row.model_id,
    apiModel: row.api_model,
    provider: row.provider,
  })
);

const decodeAssistantRunTerminalRow = (
  row: AssistantRunRow,
  value: unknown,
): AssistantRunTerminalPayloadV1 | null => {
  const request = decodeAssistantRunRequestRow(row);
  if (request) {
    return decodeAssistantRunTerminalPayload(value, {
      roomId: row.room_id,
      messageId: row.ai_message_id,
      model: request.model,
    });
  }

  const recovery = decodeAssistantRunTerminalPayload(value, {
    roomId: row.room_id,
    messageId: row.ai_message_id,
  });
  if (
    (row.status === 'complete' || row.status === 'error')
    && recovery?.outcome === row.status
  ) return recovery;
  if (
    recovery?.outcome !== 'error'
    || recovery.metadata?.invalidRequestPayload !== true
    || recovery.message.usage !== undefined
    || recovery.message.cost !== undefined
    || recovery.message.aiModel?.id !== row.model_id
    || recovery.message.aiModel.apiModel !== row.api_model
    || recovery.message.aiModel.provider !== row.provider
  ) return null;
  return recovery;
};

const mapAssistantRun = (row: AssistantRunRow): AssistantRunRecord => {
  const run: AssistantRunRecord = {
    id: row.id,
    roomId: row.room_id,
    requestedByClientId: row.requested_by_client_id,
    aiMessageId: row.ai_message_id,
    status: row.status,
    modelId: row.model_id,
    apiModel: row.api_model,
    provider: row.provider,
    createdAt: toIsoString(row.created_at),
    queuedAt: toIsoString(row.queued_at),
    updatedAt: toIsoString(row.updated_at),
    generation: Number(row.generation) || 0,
    attempt: Number(row.attempt) || 0,
    availableAt: toIsoString(row.available_at),
    membershipTier: row.membership_tier || 'guest',
    creditState: row.credit_state || 'none',
    queuePriority: Number(row.queue_priority) || 100,
    chargedCostUsd: Number(row.charged_cost_usd) || 0,
    creditAppliedUsd: Number(row.credit_applied_usd) || 0,
  };

  if (row.user_message_id) run.userMessageId = row.user_message_id;
  if (row.role_name) run.roleName = row.role_name;
  if (row.system_prompt) run.systemPrompt = row.system_prompt;
  const maxContextMessages = toOptionalNumber(row.max_context_messages);
  if (maxContextMessages !== undefined) run.maxContextMessages = maxContextMessages;
  if (row.retry_for_message_id) run.retryForMessageId = row.retry_for_message_id;
  if (row.edited_message_id) run.editedMessageId = row.edited_message_id;
  if (row.error) run.error = row.error;
  if (row.started_at) run.startedAt = toIsoString(row.started_at);
  if (row.completed_at) run.completedAt = toIsoString(row.completed_at);
  const metadata = parseJsonValue<Record<string, unknown>>(row.metadata);
  if (metadata) run.metadata = metadata;
  const requestPayload = decodeAssistantRunRequestRow(row);
  if (requestPayload) run.requestPayload = requestPayload;
  const terminalPayload = decodeAssistantRunTerminalRow(row, row.terminal_payload);
  if (terminalPayload) run.terminalPayload = terminalPayload;
  if (row.lease_owner) run.leaseOwner = row.lease_owner;
  if (row.lease_expires_at) run.leaseExpiresAt = toIsoString(row.lease_expires_at);
  if (row.billing_account_id) run.billingAccountId = row.billing_account_id;
  return run;
};

const mapRoomAgentTurn = (row: RoomAgentTurnRow): RoomAgentTurn => {
  const checkpoint = parseJsonValue<CodeAgentWorkspaceCheckpointRecord>(row.workspace_checkpoint);
  return {
    id: row.id,
    roomId: row.room_id,
    status: row.status,
    startedAt: toIsoString(row.started_at),
    ...(row.completed_at ? { completedAt: toIsoString(row.completed_at) } : {}),
    ...(row.final_message_id ? { finalMessageId: row.final_message_id } : {}),
    backend: row.backend,
    assistantName: row.assistant_name,
    ...(row.phase ? { phase: row.phase } : {}),
    ...(row.phase_message ? { phaseMessage: row.phase_message } : {}),
    ...(row.last_heartbeat_at ? { lastHeartbeatAt: toIsoString(row.last_heartbeat_at) } : {}),
    ...(checkpoint ? {
      workspaceCheckpoint: {
        status: checkpoint.status,
        fileCount: checkpoint.manifest?.files.length || 0,
        restorableFileCount: checkpoint.manifest?.files.filter(file => file.restorable).length || 0,
      },
    } : {}),
    updatedAt: toIsoString(row.updated_at),
  };
};

const mapOutboxEvent = (row: OutboxEventRow): OutboxEventRecord => {
  const event: OutboxEventRecord = {
    id: row.id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: parseJsonValue<Record<string, unknown>>(row.payload) || {},
    status: row.status,
    attempts: Number(row.attempts) || 0,
    availableAt: toIsoString(row.available_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };

  if (row.room_id) event.roomId = row.room_id;
  if (row.locked_at) event.lockedAt = toIsoString(row.locked_at);
  if (row.locked_by) event.lockedBy = row.locked_by;
  if (row.processed_at) event.processedAt = toIsoString(row.processed_at);
  if (row.last_error) event.lastError = row.last_error;
  return event;
};

const mapTaskDispatch = (row: TaskDispatchRow): TaskDispatchRecord => ({
  runId: row.run_id,
  status: row.status,
  attempts: Number(row.attempts) || 0,
  availableAt: toIsoString(row.available_at),
  createdAt: toIsoString(row.created_at),
  updatedAt: toIsoString(row.updated_at),
  ...(row.locked_at ? { lockedAt: toIsoString(row.locked_at) } : {}),
  ...(row.locked_by ? { lockedBy: row.locked_by } : {}),
  ...(row.dispatched_at ? { dispatchedAt: toIsoString(row.dispatched_at) } : {}),
  ...(row.last_error ? { lastError: row.last_error } : {}),
  queuePriority: Number(row.queue_priority) || 100,
});

const mapPushSubscription = (row: PushSubscriptionRow): PushSubscriptionRecord => ({
  clientId: row.client_id,
  browserInstanceId: row.browser_instance_id || undefined,
  endpoint: row.endpoint,
  p256dh: row.p256dh,
  auth: row.auth,
  userAgent: row.user_agent || undefined,
  createdAt: toIsoString(row.created_at),
  updatedAt: toIsoString(row.updated_at),
});

const mapClientAccount = (row: ClientAccountRow): ClientAccount => {
  const account: ClientAccount = {
    accountId: row.account_id,
    primaryClientId: row.primary_client_id,
    provider: row.provider,
    providerSubject: row.provider_subject,
    googleLinked: row.google_linked,
    emailVerified: Boolean(row.email_verified),
    createdAt: toIsoString(row.account_created_at),
    updatedAt: toIsoString(row.account_updated_at),
  };
  if (row.email) account.email = row.email;
  if (row.display_name) account.displayName = row.display_name;
  if (row.avatar_url) account.avatarUrl = row.avatar_url;
  if (row.last_login_at) account.lastLoginAt = toIsoString(row.last_login_at);
  return account;
};

const mapAccountEntitlement = (row: AccountEntitlementRow): AccountEntitlement => {
  const creditBalanceUsd = Number(row.available_usd) || 0;
  const priorityOverride = toOptionalNumber(row.priority_override);
  const effectiveTier = resolveEffectiveMembershipTier(row.tier, row.status);
  const scheduling = resolveAssistantRunScheduling({
    accountId: row.account_id,
    tier: row.tier,
    status: row.status,
    creditBalanceUsd,
    ...(priorityOverride !== undefined ? { priorityOverride } : {}),
  });
  return {
    accountId: row.account_id,
    tier: row.tier,
    status: row.status,
    effectiveTier,
    creditBalanceUsd,
    lifetimeUsageUsd: Number(row.lifetime_usage_usd) || 0,
    creditState: creditBalanceUsd > 0 ? 'available' : 'exhausted',
    queuePriority: scheduling.queuePriority,
    ...(priorityOverride !== undefined ? { priorityOverride } : {}),
    ...(row.current_period_start ? { currentPeriodStart: toIsoString(row.current_period_start) } : {}),
    ...(row.current_period_end ? { currentPeriodEnd: toIsoString(row.current_period_end) } : {}),
    ...(row.external_provider ? { externalProvider: row.external_provider } : {}),
    updatedAt: toIsoString(row.updated_at),
  };
};

const toMessageMediaAsset = (asset: MediaAsset): MessageMediaAsset => {
  const messageAsset: MessageMediaAsset = {
    id: asset.id,
    kind: asset.kind,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
  };
  if (asset.filename !== undefined) messageAsset.filename = asset.filename;
  if (asset.width !== undefined) messageAsset.width = asset.width;
  if (asset.height !== undefined) messageAsset.height = asset.height;
  if (asset.durationMs !== undefined) messageAsset.durationMs = asset.durationMs;
  return messageAsset;
};

const mapMessage = (row: MessageRow): Message => {
  const avatar = parseJsonValue<Message['avatar']>(row.avatar);
  const aiModel = parseJsonValue<Message['aiModel']>(row.ai_model);
  const usage = parseJsonValue<Message['usage']>(row.usage);
  const cost = parseJsonValue<Message['cost']>(row.cost);
  const replyTo = parseJsonValue<Message['replyTo']>(row.reply_to);
  const uiPayload = parseJsonValue<Message['uiPayload']>(row.ui_payload);
  const codeAgentQueuedInput = parseJsonValue<Message['codeAgentQueuedInput']>(row.code_agent_queued_input);
  const codeAgentImageMessageIds = parseJsonValue<Message['codeAgentImageMessageIds']>(row.code_agent_image_message_ids);

  const message: Message = {
    id: row.id,
    clientId: row.client_id,
    content: row.content,
    roomId: row.room_id,
    timestamp: toIsoString(row.timestamp),
    messageType: row.message_type,
  };

  if (row.client_message_id) message.clientMessageId = row.client_message_id;
  if (row.client_batch_id) message.clientBatchId = row.client_batch_id;
  const clientBatchIndex = toOptionalNumber(row.client_batch_index ?? null);
  if (clientBatchIndex !== undefined) message.clientBatchIndex = clientBatchIndex;
  if (row.updated_at) message.updatedAt = toIsoString(row.updated_at);
  if (row.username) message.username = row.username;
  if (avatar) message.avatar = avatar;
  if (row.mime_type) message.mimeType = row.mime_type;
  if (row.status) message.status = row.status;
  if (row.turn_id) message.turnId = row.turn_id;
  if (row.model_step_id) message.modelStepId = row.model_step_id;
  const modelStepSequence = toOptionalNumber(row.model_step_sequence ?? null);
  if (modelStepSequence !== undefined) message.modelStepSequence = modelStepSequence;
  if (row.tool_call_id) message.toolCallId = row.tool_call_id;
  if (row.tool_name) message.toolName = row.tool_name;
  const toolArgs = parseJsonValue<Record<string, unknown>>(row.tool_args);
  if (toolArgs) message.toolArgs = toolArgs;
  if (row.tool_output_preview) message.toolOutputPreview = row.tool_output_preview;
  const exitCode = toOptionalNumber(row.exit_code ?? null);
  if (exitCode !== undefined) message.exitCode = exitCode;
  if (typeof row.is_error === 'boolean') message.isError = row.is_error;
  if (aiModel) message.aiModel = aiModel;
  if (usage) message.usage = usage;
  if (cost) message.cost = cost;
  if (row.code_agent_mode) message.codeAgentMode = row.code_agent_mode as Message['codeAgentMode'];
  if (codeAgentQueuedInput) message.codeAgentQueuedInput = codeAgentQueuedInput;
  if (codeAgentImageMessageIds?.length) message.codeAgentImageMessageIds = codeAgentImageMessageIds;
  if (replyTo) message.replyTo = replyTo;
  if (uiPayload) message.uiPayload = uiPayload;

  return message;
};

const messageParams = (message: Message, position: number): unknown[] => [
  message.id,
  message.roomId,
  message.clientId,
  message.content,
  message.timestamp,
  message.updatedAt || null,
  message.messageType,
  message.username || null,
  toJsonb(message.avatar),
  message.mimeType || null,
  message.status || null,
  message.turnId || null,
  message.toolCallId || null,
  message.toolName || null,
  toJsonb(message.toolArgs),
  message.toolOutputPreview || null,
  message.exitCode ?? null,
  message.isError ?? null,
  toJsonb(message.aiModel),
  toJsonb(message.usage),
  toJsonb(message.cost),
  toJsonb(message.replyTo),
  toJsonb(message.uiPayload),
  getAIStreamOwnerId(message) || null,
  getAIStreamFence(message),
  message.codeAgentMode || null,
  toJsonb(message.codeAgentQueuedInput),
  toJsonb(message.codeAgentImageMessageIds),
  position,
  message.modelStepId || null,
  message.modelStepSequence ?? null,
  message.clientMessageId || null,
  message.clientBatchId || null,
  message.clientBatchIndex ?? null,
];

const assistantRunParams = (run: AssistantRunRecord): unknown[] => [
  run.id,
  run.roomId,
  run.requestedByClientId,
  run.userMessageId || null,
  run.aiMessageId,
  run.status,
  run.modelId,
  run.apiModel,
  run.provider,
  run.roleName || null,
  run.systemPrompt || null,
  run.maxContextMessages ?? null,
  run.retryForMessageId || null,
  run.editedMessageId || null,
  run.error || null,
  toJsonb(run.metadata),
  run.createdAt,
  run.queuedAt,
  run.startedAt || null,
  run.completedAt || null,
  run.updatedAt,
  toJsonb(run.requestPayload),
  toJsonb(run.terminalPayload),
  run.generation ?? 0,
  run.attempt ?? 0,
  run.availableAt || run.queuedAt,
  run.leaseOwner || null,
  run.leaseExpiresAt || null,
  run.billingAccountId || null,
  run.membershipTier || 'guest',
  run.creditState || 'none',
  run.queuePriority || 100,
  run.chargedCostUsd || 0,
  run.creditAppliedUsd || 0,
];

const outboxEventParams = (event: OutboxEventRecord): unknown[] => [
  event.id,
  event.eventType,
  event.aggregateType,
  event.aggregateId,
  event.roomId || null,
  toJsonb(event.payload),
  event.status,
  event.attempts,
  event.availableAt,
  event.lockedAt || null,
  event.lockedBy || null,
  event.processedAt || null,
  event.lastError || null,
  event.createdAt,
  event.updatedAt,
];

const INSERT_MESSAGE_ROW_SQL = `INSERT INTO room_messages (
  id,
  room_id,
  client_id,
  content,
  timestamp,
  updated_at,
  message_type,
  username,
  avatar,
  mime_type,
  status,
  turn_id,
  tool_call_id,
  tool_name,
  tool_args,
  tool_output_preview,
  exit_code,
  is_error,
  ai_model,
  usage,
  cost,
  reply_to,
  ui_payload,
  ai_stream_owner_id,
  ai_stream_fence,
  code_agent_mode,
  code_agent_queued_input,
  code_agent_image_message_ids,
  position,
  model_step_id,
  model_step_sequence,
  client_message_id,
  client_batch_id,
  client_batch_index
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18, $19::jsonb, $20::jsonb, $21::jsonb, $22::jsonb, $23::jsonb, $24, $25, $26, $27::jsonb, $28::jsonb, $29, $30, $31, $32, $33, $34
)`;

const UPSERT_MESSAGE_SQL = `${INSERT_MESSAGE_ROW_SQL} ON CONFLICT (id) DO UPDATE SET
  room_id = EXCLUDED.room_id,
  client_id = EXCLUDED.client_id,
  content = EXCLUDED.content,
  timestamp = EXCLUDED.timestamp,
  updated_at = EXCLUDED.updated_at,
  message_type = EXCLUDED.message_type,
  username = EXCLUDED.username,
  avatar = EXCLUDED.avatar,
  mime_type = EXCLUDED.mime_type,
  status = EXCLUDED.status,
  turn_id = EXCLUDED.turn_id,
  model_step_id = EXCLUDED.model_step_id,
  model_step_sequence = EXCLUDED.model_step_sequence,
  tool_call_id = EXCLUDED.tool_call_id,
  tool_name = EXCLUDED.tool_name,
  tool_args = EXCLUDED.tool_args,
  tool_output_preview = EXCLUDED.tool_output_preview,
  exit_code = EXCLUDED.exit_code,
  is_error = EXCLUDED.is_error,
  ai_model = EXCLUDED.ai_model,
  usage = EXCLUDED.usage,
  cost = EXCLUDED.cost,
  reply_to = EXCLUDED.reply_to,
  ui_payload = EXCLUDED.ui_payload,
  ai_stream_owner_id = EXCLUDED.ai_stream_owner_id,
  ai_stream_fence = EXCLUDED.ai_stream_fence,
  code_agent_mode = EXCLUDED.code_agent_mode,
  code_agent_queued_input = EXCLUDED.code_agent_queued_input,
  code_agent_image_message_ids = EXCLUDED.code_agent_image_message_ids,
  client_message_id = EXCLUDED.client_message_id,
  client_batch_id = EXCLUDED.client_batch_id,
  client_batch_index = EXCLUDED.client_batch_index,
  position = room_messages.position`;

const INSERT_ASSISTANT_RUN_SQL = `INSERT INTO assistant_runs (
  id,
  room_id,
  requested_by_client_id,
  user_message_id,
  ai_message_id,
  status,
  model_id,
  api_model,
  provider,
  role_name,
  system_prompt,
  max_context_messages,
  retry_for_message_id,
  edited_message_id,
  error,
  metadata,
  created_at,
  queued_at,
  started_at,
  completed_at,
  updated_at,
  request_payload,
  terminal_payload,
  generation,
  attempt,
  available_at,
  lease_owner,
  lease_expires_at,
  billing_account_id,
  membership_tier,
  credit_state,
  queue_priority,
  charged_cost_usd,
  credit_applied_usd
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19, $20, $21,
  $22::jsonb, $23::jsonb, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34
) ON CONFLICT (id) DO NOTHING
RETURNING ${ASSISTANT_RUN_COLUMNS}`;

const INSERT_OUTBOX_EVENT_SQL = `INSERT INTO outbox_events (
  id,
  event_type,
  aggregate_type,
  aggregate_id,
  room_id,
  payload,
  status,
  attempts,
  available_at,
  locked_at,
  locked_by,
  processed_at,
  last_error,
  created_at,
  updated_at
) VALUES (
  $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15
) ON CONFLICT (id) DO UPDATE SET
  payload = EXCLUDED.payload,
  status = EXCLUDED.status,
  attempts = EXCLUDED.attempts,
  available_at = EXCLUDED.available_at,
  locked_at = EXCLUDED.locked_at,
  locked_by = EXCLUDED.locked_by,
  processed_at = EXCLUDED.processed_at,
  last_error = EXCLUDED.last_error,
  updated_at = EXCLUDED.updated_at
RETURNING ${OUTBOX_EVENT_COLUMNS}`;

export class PostgresStore implements DurableRoomStore {
  constructor(
    private readonly pool: PostgresPool,
    private readonly logger: Logger,
    private readonly mediaObjectStorage?: MediaObjectStorage
  ) {}

  // Best-effort removal of S3 objects whose media_assets rows were already
  // deleted in a committed transaction. Runs AFTER commit so a storage failure
  // never rolls back the durable delete; orphaned objects are logged, not fatal.
  private async deleteOrphanedMediaObjects(objectKeys: string[]): Promise<void> {
    if (objectKeys.length === 0 || !this.mediaObjectStorage?.deleteMediaObject) {
      return;
    }

    for (const objectKey of objectKeys) {
      for (const derivedObjectKey of [objectKey, getMediaThumbnailObjectKey(objectKey)]) {
        try {
          await this.mediaObjectStorage.deleteMediaObject(derivedObjectKey);
        } catch (error) {
          this.logger.error('Failed to delete orphaned media object', { error, objectKey: derivedObjectKey });
        }
      }
    }
  }

  private async deleteOrphanedCheckpointObjects(objectKeys: string[]): Promise<void> {
    if (objectKeys.length === 0 || !this.mediaObjectStorage?.deleteMediaObject) {
      return;
    }

    for (const objectKey of Array.from(new Set(objectKeys))) {
      try {
        await this.mediaObjectStorage.deleteMediaObject(objectKey);
      } catch (error) {
        this.logger.error('Failed to delete orphaned workspace checkpoint object', { error, objectKey });
      }
    }
  }

  async initializeSchema(): Promise<void> {
    await this.migrateSchema();
  }

  async migrateSchema(): Promise<void> {
    const appliedMigrations = await this.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('roomtalk_schema_initialization'))");
      return this.runMigrations(client);
    });
    for (const id of appliedMigrations) {
      this.logger.info('Applied PostgreSQL migration', { id });
    }
    this.logger.info('PostgreSQL schema migrations complete');
  }

  async verifySchema(): Promise<void> {
    const ledger = await this.pool.query<{ id: string; checksum: string | null }>(
      `SELECT id, checksum
      FROM schema_migrations
      WHERE id = ANY($1::text[])`,
      [REQUIRED_POSTGRES_MIGRATIONS.map(migration => migration.id)],
    );
    const applied = new Map(ledger.rows.map(row => [row.id, row.checksum]));
    for (const migration of REQUIRED_POSTGRES_MIGRATIONS) {
      const checksum = applied.get(migration.id);
      if (!checksum) {
        throw new Error(`PostgreSQL schema migration ${migration.id} is missing; run npm run migrate:schema before starting the app`);
      }
      if (checksum !== migration.checksum) {
        throw new Error(`PostgreSQL schema migration checksum mismatch for ${migration.id}`);
      }
    }
    this.logger.info('PostgreSQL schema verified', { migrations: REQUIRED_POSTGRES_MIGRATIONS.length });
  }

  private async runMigrations(client: PostgresQueryable): Promise<string[]> {
    const appliedMigrations: string[] = [];
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        checksum TEXT,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');

    for (const migration of REQUIRED_POSTGRES_MIGRATIONS) {
      const applied = await client.query<{ checksum: string | null }>(
        'SELECT checksum FROM schema_migrations WHERE id = $1 LIMIT 1',
        [migration.id]
      );
      if (applied.rows.length > 0) {
        const checksum = applied.rows[0].checksum;
        if (checksum && checksum !== migration.checksum) {
          throw new Error(`PostgreSQL schema migration checksum mismatch for ${migration.id}`);
        }
        if (!checksum) {
          await client.query('UPDATE schema_migrations SET checksum = $2 WHERE id = $1', [migration.id, migration.checksum]);
        }
        continue;
      }

      for (const sql of migration.statements) await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)',
        [migration.id, migration.checksum]
      );
      appliedMigrations.push(migration.id);
    }
    return appliedMigrations;
  }

  async generateUniqueRoomId(): Promise<string> {
    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
      const id = nanoid();
      const exists = await this.pool.query('SELECT 1 FROM rooms WHERE id = $1 LIMIT 1', [id]);
      if (exists.rows.length === 0) {
        return id;
      }
      attempts++;
      this.logger.debug('PostgreSQL room ID collision detected, retrying', { attempt: attempts, maxAttempts });
    }

    attempts = 0;
    while (attempts < maxAttempts) {
      const id = nanoid(12);
      const exists = await this.pool.query('SELECT 1 FROM rooms WHERE id = $1 LIMIT 1', [id]);
      if (exists.rows.length === 0) {
        return id;
      }
      attempts++;
      this.logger.debug('PostgreSQL long room ID collision detected, retrying', { attempt: attempts, maxAttempts });
    }

    return nanoid(16);
  }

  async appendMessage(message: Message): Promise<Room | null> {
    const result = await this.appendMessageIdempotent(message);
    return result?.room || null;
  }

  async appendMessageIdempotent(message: Message): Promise<IdempotentMessageAppendResult | null> {
    try {
      return await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [message.roomId]
        );
        if (room.rows.length === 0) {
          this.logger.warn('Cannot append message to missing PostgreSQL room', { roomId: message.roomId, messageId: message.id });
          return null;
        }

        if (message.clientMessageId) {
          const existing = await client.query<MessageRow>(
            `SELECT ${MESSAGE_COLUMNS}
            FROM room_messages
            WHERE room_id = $1 AND client_id = $2 AND client_message_id = $3
            LIMIT 1`,
            [message.roomId, message.clientId, message.clientMessageId]
          );
          if (existing.rows[0]) {
            return {
              room: mapRoom(room.rows[0]),
              message: mapMessage(existing.rows[0]),
              inserted: false,
            };
          }
        }

        const nextPosition = await client.query<{ position: number | string }>(
          'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM room_messages WHERE room_id = $1',
          [message.roomId]
        );
        const position = Number(nextPosition.rows[0]?.position || 0);
        await client.query(UPSERT_MESSAGE_SQL, messageParams(message, position));

        const updatedRoom = await client.query<RoomRow>(
          `UPDATE rooms
          SET last_activity_at = GREATEST(last_activity_at, $2::timestamptz),
            updated_at = NOW()
          WHERE id = $1
          RETURNING ${ROOM_COLUMNS}`,
          [message.roomId, message.timestamp]
        );
        this.logger.debug('Message appended to PostgreSQL', { roomId: message.roomId, messageId: message.id });
        return updatedRoom.rows[0]
          ? { room: mapRoom(updatedRoom.rows[0]), message, inserted: true }
          : null;
      });
    } catch (error) {
      this.logger.error('Error appending message to PostgreSQL', { error, roomId: message.roomId, messageId: message.id });
      return null;
    }
  }

  async appendMessageWithAtomicPosition(message: Message): Promise<Room | null> {
    return this.appendMessage(message);
  }

  async appendMediaMessageWithAsset(message: Message, asset: MediaAsset): Promise<MediaMessageAppendResult | null> {
    const mediaMessage: Message = {
      ...message,
      messageType: 'media',
    };
    const mediaAsset: MediaAsset = {
      ...asset,
      roomId: mediaMessage.roomId,
      messageId: mediaMessage.id,
    };

    try {
      return await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [mediaMessage.roomId]
        );
        if (room.rows.length === 0) {
          this.logger.warn('Cannot append media message to missing PostgreSQL room', { roomId: mediaMessage.roomId, messageId: mediaMessage.id, assetId: mediaAsset.id });
          return null;
        }

        const nextPosition = await client.query<{ position: number | string }>(
          'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM room_messages WHERE room_id = $1',
          [mediaMessage.roomId]
        );
        const position = Number(nextPosition.rows[0]?.position || 0);
        await client.query(UPSERT_MESSAGE_SQL, messageParams(mediaMessage, position));

        const savedAsset = await this.saveMediaAssetWithClient(client, mediaAsset);
        if (!savedAsset) {
          throw new Error('Failed to save media asset');
        }

        const updatedRoom = await client.query<RoomRow>(
          `UPDATE rooms
          SET last_activity_at = GREATEST(last_activity_at, $2::timestamptz),
            updated_at = NOW()
          WHERE id = $1
          RETURNING ${ROOM_COLUMNS}`,
          [mediaMessage.roomId, mediaMessage.timestamp]
        );
        const roomResult = updatedRoom.rows[0] ? mapRoom(updatedRoom.rows[0]) : null;
        if (!roomResult) {
          throw new Error('Failed to update room after media message append');
        }

        const savedMessage = this.attachMediaAssetsFromAssets([mediaMessage], [savedAsset])[0];
        this.logger.debug('Media message and asset appended to PostgreSQL', { roomId: mediaMessage.roomId, messageId: mediaMessage.id, assetId: savedAsset.id, kind: savedAsset.kind });
        return { room: roomResult, message: savedMessage, asset: savedAsset };
      });
    } catch (error) {
      this.logger.error('Error appending PostgreSQL media message and asset', { error, roomId: mediaMessage.roomId, messageId: mediaMessage.id, assetId: mediaAsset.id });
      return null;
    }
  }

  async upsertMessage(message: Message): Promise<Room | null> {
    try {
      return await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [message.roomId]
        );
        if (room.rows.length === 0) {
          this.logger.warn('Cannot upsert message for missing PostgreSQL room', { roomId: message.roomId, messageId: message.id });
          return null;
        }

        const nextPosition = await client.query<{ position: number | string }>(
          'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM room_messages WHERE room_id = $1',
          [message.roomId]
        );
        const position = Number(nextPosition.rows[0]?.position || 0);
        await client.query(UPSERT_MESSAGE_SQL, messageParams(message, position));

        const updatedRoom = await client.query<RoomRow>(
          `UPDATE rooms
          SET last_activity_at = GREATEST(last_activity_at, $2::timestamptz),
            updated_at = NOW()
          WHERE id = $1
          RETURNING ${ROOM_COLUMNS}`,
          [message.roomId, message.timestamp]
        );
        this.logger.debug('Message upserted in PostgreSQL', { roomId: message.roomId, messageId: message.id });
        return updatedRoom.rows[0] ? mapRoom(updatedRoom.rows[0]) : null;
      });
    } catch (error) {
      this.logger.error('Error upserting message in PostgreSQL', { error, roomId: message.roomId, messageId: message.id });
      return null;
    }
  }

  async claimAIMessageStream(
    roomId: string,
    messageId: string,
    ownership: AIStreamOwnership,
  ): Promise<AIStreamClaimResult> {
    if (!Number.isSafeInteger(ownership.fence) || ownership.fence <= 0 || !ownership.ownerId) {
      throw new Error('AI worker claim requires a positive fence and owner ID');
    }
    return this.transaction(async client => {
      const claimed = await client.query(
        `UPDATE room_messages
        SET ai_stream_owner_id = $3,
          ai_stream_fence = $4
        WHERE id = $1
          AND room_id = $2
          AND status = 'streaming'
          AND (
            ai_stream_fence < $4
            OR (ai_stream_fence = $4 AND ai_stream_owner_id = $3)
          )
        RETURNING id`,
        [messageId, roomId, ownership.ownerId, ownership.fence],
      );
      if (!claimed.rows[0]) return { outcome: 'obsolete' };

      const room = await client.query<RoomRow>(
        `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1`,
        [roomId],
      );
      if (!room.rows[0]) return { outcome: 'obsolete' };
      return { outcome: 'claimed', room: mapRoom(room.rows[0]) };
    });
  }

  async finalizeAIMessage(
    message: Message,
    expectedOwnership: AIStreamOwnership,
  ): Promise<AITerminalTransitionResult> {
    if (message.status !== 'complete' && message.status !== 'error') {
      throw new Error('AI terminal transition requires complete or error status');
    }
    if (!Number.isSafeInteger(expectedOwnership.fence) || expectedOwnership.fence < 0) {
      throw new Error('AI terminal transition requires a non-negative ownership fence');
    }

    return this.transaction(async client => {
      const updated = await client.query<MessageRow>(
        `UPDATE room_messages
        SET content = $4,
          timestamp = $5::timestamptz,
          updated_at = COALESCE($6::timestamptz, $5::timestamptz),
          status = $7,
          is_error = $8,
          ai_model = $9::jsonb,
          usage = $10::jsonb,
          cost = $11::jsonb,
          ui_payload = $12::jsonb,
          model_step_id = $13,
          model_step_sequence = $14,
          ai_stream_owner_id = NULL
        WHERE id = $1
          AND room_id = $2
          AND status = 'streaming'
          AND ai_stream_owner_id IS NOT DISTINCT FROM $3
          AND ai_stream_fence = $15
        RETURNING ${MESSAGE_COLUMNS}`,
        [
          message.id,
          message.roomId,
          expectedOwnership.ownerId,
          message.content,
          message.timestamp,
          message.updatedAt || null,
          message.status,
          message.isError ?? null,
          toJsonb(message.aiModel),
          toJsonb(message.usage),
          toJsonb(message.cost),
          toJsonb(message.uiPayload),
          message.modelStepId || null,
          message.modelStepSequence ?? null,
          expectedOwnership.fence,
        ],
      );
      if (!updated.rows[0]) {
        return { outcome: 'obsolete' };
      }

      const room = await client.query<RoomRow>(
        `UPDATE rooms
        SET last_activity_at = GREATEST(last_activity_at, $2::timestamptz),
          updated_at = NOW()
        WHERE id = $1
        RETURNING ${ROOM_COLUMNS}`,
        [message.roomId, message.timestamp],
      );
      if (!room.rows[0]) {
        throw new Error(`AI terminal transition lost room ${message.roomId}`);
      }
      return {
        outcome: 'applied',
        room: mapRoom(room.rows[0]),
        message: mapMessage(updated.rows[0]),
      };
    });
  }

  async updateMessageContent(roomId: string, messageId: string, updatedContent: string, updatedAt = new Date().toISOString()) {
    try {
      return await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [roomId]
        );
        if (room.rows.length === 0) {
          this.logger.warn('Cannot update message for missing PostgreSQL room', { roomId, messageId });
          return null;
        }

        const updated = await client.query<MessageRow>(
          `UPDATE room_messages
          SET content = $3,
            updated_at = $4,
            ui_payload = NULL
          WHERE room_id = $1 AND id = $2
          RETURNING ${MESSAGE_COLUMNS}`,
          [roomId, messageId, updatedContent, updatedAt]
        );
        if (updated.rows.length === 0) {
          return { room: mapRoom(room.rows[0]), found: false };
        }

        const updatedRoom = await this.updateRoomLastActivityFromMessages(client, roomId, toIsoString(room.rows[0].created_at));
        if (!updatedRoom) {
          return null;
        }

        this.logger.debug('Message updated in PostgreSQL', { roomId, messageId });
        return { room: updatedRoom, found: true, updatedMessage: mapMessage(updated.rows[0]) };
      });
    } catch (error) {
      this.logger.error('Error updating message in PostgreSQL', { error, roomId, messageId });
      return null;
    }
  }

  async updateCodeAgentQueuedMessage(
    roomId: string,
    messageId: string,
    update: CodeAgentQueueMessageUpdate
  ) {
    const updatedAt = update.updatedAt || new Date().toISOString();
    try {
      return await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [roomId]
        );
        if (room.rows.length === 0) {
          return null;
        }

        const updated = await client.query<MessageRow>(
          `UPDATE room_messages
          SET code_agent_queued_input = $5::jsonb,
            updated_at = $4,
            content = CASE WHEN $6::boolean THEN $7 ELSE content END
          WHERE room_id = $1
            AND id = $2
            AND code_agent_queued_input->>'state' = $3
          RETURNING ${MESSAGE_COLUMNS}`,
          [
            roomId,
            messageId,
            update.expectedState,
            updatedAt,
            toJsonb(update.queuedInput),
            update.content !== undefined,
            update.content || '',
          ]
        );
        if (updated.rows.length === 0) {
          return { room: mapRoom(room.rows[0]), found: false };
        }

        const updatedRoom = await this.updateRoomLastActivityFromMessages(client, roomId, toIsoString(room.rows[0].created_at));
        return updatedRoom
          ? { room: updatedRoom, found: true, updatedMessage: mapMessage(updated.rows[0]) }
          : null;
      });
    } catch (error) {
      this.logger.error('Error transitioning PostgreSQL queued code-agent message', { error, roomId, messageId, expectedState: update.expectedState });
      return null;
    }
  }

  async materializeCodeAgentQueuedMessage(
    roomId: string,
    messageId: string,
    expectedState: CodeAgentQueueState,
    turnId?: string,
    insertedAt = new Date().toISOString()
  ) {
    try {
      return await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [roomId]
        );
        if (room.rows.length === 0) {
          return null;
        }

        const updated = await client.query<MessageRow>(
          `WITH next_position AS (
            SELECT COALESCE(MAX(position), -1) + 1 AS position
            FROM room_messages
            WHERE room_id = $1
          )
          UPDATE room_messages
          SET position = next_position.position,
            timestamp = $5,
            updated_at = $5,
            turn_id = $4,
            code_agent_queued_input = NULL
          FROM next_position
          WHERE room_id = $1
            AND id = $2
            AND code_agent_queued_input->>'state' = $3
          RETURNING ${MESSAGE_COLUMNS}`,
          [roomId, messageId, expectedState, turnId || null, insertedAt]
        );
        if (updated.rows.length === 0) {
          return { room: mapRoom(room.rows[0]), found: false };
        }

        const updatedRoom = await this.updateRoomLastActivityFromMessages(client, roomId, toIsoString(room.rows[0].created_at));
        return updatedRoom
          ? { room: updatedRoom, found: true, updatedMessage: mapMessage(updated.rows[0]) }
          : null;
      });
    } catch (error) {
      this.logger.error('Error materializing PostgreSQL queued code-agent message', { error, roomId, messageId, expectedState, turnId });
      return null;
    }
  }

  async materializeCodeAgentQueuedMessageForTurn(
    roomId: string,
    messageId: string,
    expectedState: CodeAgentQueueState,
    claim: CodeAgentTurnClaim,
    insertedAt = new Date().toISOString(),
  ): Promise<MessageUpdateResult | null> {
    if (roomId !== claim.roomId) {
      throw new Error('Queued code-agent message does not match its turn claim');
    }
    return this.transaction(async client => {
      const room = await client.query<RoomRow>(
        `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
        [roomId],
      );
      if (!room.rows[0]) return null;
      if (!await this.lockCodeAgentTurnClaim(client, claim)) {
        return { room: mapRoom(room.rows[0]), found: false };
      }

      const nextPosition = await client.query<{ position: number | string }>(
        'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM room_messages WHERE room_id = $1',
        [roomId],
      );
      const updated = await client.query<MessageRow>(
        `UPDATE room_messages
        SET position = $5,
          timestamp = $6::timestamptz,
          updated_at = $6::timestamptz,
          turn_id = $4,
          code_agent_queued_input = NULL
        WHERE room_id = $1
          AND id = $2
          AND code_agent_queued_input->>'state' = $3
        RETURNING ${MESSAGE_COLUMNS}`,
        [
          roomId,
          messageId,
          expectedState,
          claim.turnId,
          Number(nextPosition.rows[0]?.position || 0),
          insertedAt,
        ],
      );
      if (!updated.rows[0]) {
        return { room: mapRoom(room.rows[0]), found: false };
      }
      const updatedRoom = await this.updateRoomLastActivityFromMessages(
        client,
        roomId,
        toIsoString(room.rows[0].created_at),
      );
      return updatedRoom
        ? { room: updatedRoom, found: true, updatedMessage: mapMessage(updated.rows[0]) }
        : null;
    });
  }

  async claimNextCodeAgentQueuedMessage(roomId: string, updatedAt = new Date().toISOString()) {
    try {
      return await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [roomId]
        );
        if (room.rows.length === 0) {
          return null;
        }

        const queued = await client.query<MessageRow>(
          `SELECT ${MESSAGE_COLUMNS}
          FROM room_messages
          WHERE room_id = $1 AND code_agent_queued_input->>'state' = 'queued'
          ORDER BY position ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
          [roomId]
        );
        if (queued.rows.length === 0) {
          return null;
        }
        const message = mapMessage(queued.rows[0]);
        if (!message.codeAgentQueuedInput) {
          return null;
        }
        const claimedInput = {
          ...message.codeAgentQueuedInput,
          state: 'starting' as const,
          updatedAt,
          lastError: undefined,
        };
        const claimed = await client.query<MessageRow>(
          `UPDATE room_messages
          SET code_agent_queued_input = $3::jsonb, updated_at = $4
          WHERE room_id = $1 AND id = $2 AND code_agent_queued_input->>'state' = 'queued'
          RETURNING ${MESSAGE_COLUMNS}`,
          [roomId, message.id, toJsonb(claimedInput), updatedAt]
        );
        if (claimed.rows.length === 0) {
          return null;
        }
        const updatedRoom = await this.updateRoomLastActivityFromMessages(client, roomId, toIsoString(room.rows[0].created_at));
        return updatedRoom ? { room: updatedRoom, message: mapMessage(claimed.rows[0]) } : null;
      });
    } catch (error) {
      this.logger.error('Error claiming PostgreSQL queued code-agent message', { error, roomId });
      return null;
    }
  }

  async deleteCodeAgentQueuedMessage(
    roomId: string,
    messageId: string,
    expectedState: CodeAgentQueueState = 'queued'
  ) {
    try {
      return await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [roomId]
        );
        if (room.rows.length === 0) {
          return null;
        }
        const deleted = await client.query<{ id: string }>(
          `DELETE FROM room_messages
          WHERE room_id = $1 AND id = $2 AND code_agent_queued_input->>'state' = $3
          RETURNING id`,
          [roomId, messageId, expectedState]
        );
        if (deleted.rows.length === 0) {
          return { room: mapRoom(room.rows[0]), deleted: false };
        }
        const updatedRoom = await this.updateRoomLastActivityFromMessages(client, roomId, toIsoString(room.rows[0].created_at));
        return updatedRoom ? { room: updatedRoom, deleted: true } : null;
      });
    } catch (error) {
      this.logger.error('Error deleting PostgreSQL queued code-agent message', { error, roomId, messageId, expectedState });
      return null;
    }
  }

  async findRoomsWithQueuedCodeAgentMessages(): Promise<string[]> {
    try {
      const result = await this.pool.query<{ room_id: string }>(
        `SELECT DISTINCT room_id
        FROM room_messages
        WHERE code_agent_queued_input->>'state' = 'queued'`
      );
      return result.rows.map(row => row.room_id);
    } catch (error) {
      this.logger.error('Error finding PostgreSQL rooms with queued code-agent messages', { error });
      throw error;
    }
  }

  async recoverStaleCodeAgentQueuedMessages(
    staleBefore: string,
    updatedAt = new Date().toISOString(),
  ): Promise<number> {
    try {
      const result = await this.pool.query(
        `UPDATE room_messages AS message
        SET code_agent_queued_input =
            jsonb_set(
              jsonb_set(
                jsonb_set(
                  message.code_agent_queued_input,
                  '{state}',
                  to_jsonb('queued'::text),
                  true
                ),
                '{updatedAt}',
                to_jsonb($2::text),
                true
              ),
              '{lastError}',
              to_jsonb(
                CASE message.code_agent_queued_input->>'state'
                  WHEN 'steering' THEN 'The active turn ended before the steer input was inserted'
                  ELSE 'The queued turn did not finish starting and was restored'
                END
              ),
              true
            ),
          updated_at = $2::timestamptz
        WHERE message.code_agent_queued_input->>'state' IN ('starting', 'steering')
          AND message.updated_at <= $1::timestamptz
          AND NOT EXISTS (
            SELECT 1
            FROM code_agent_room_leases AS lease
            WHERE lease.room_id = message.room_id
              AND lease.expires_at > clock_timestamp()
          )`,
        [staleBefore, updatedAt],
      );
      return result.rowCount || 0;
    } catch (error) {
      this.logger.error('Error recovering stale PostgreSQL code-agent queue states', {
        error,
        staleBefore,
      });
      throw error;
    }
  }

  async deleteMessageById(roomId: string, messageId: string) {
    let orphanedObjectKeys: string[] = [];
    try {
      const result = await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [roomId]
        );
        if (room.rows.length === 0) {
          this.logger.warn('Cannot delete message for missing PostgreSQL room', { roomId, messageId });
          return null;
        }

        // Remove the asset row first, while message_id still links it; the
        // room_messages FK would otherwise SET NULL and strand both the row and
        // its S3 object.
        const orphaned = await client.query<{ object_key: string }>(
          'DELETE FROM media_assets WHERE room_id = $1 AND message_id = $2 RETURNING object_key',
          [roomId, messageId]
        );

        const deleted = await client.query<{ id: string }>(
          'DELETE FROM room_messages WHERE room_id = $1 AND id = $2 RETURNING id',
          [roomId, messageId]
        );
        if (deleted.rows.length === 0) {
          return { room: mapRoom(room.rows[0]), deleted: false };
        }

        orphanedObjectKeys = orphaned.rows.map(row => row.object_key);

        const updatedRoom = await this.updateRoomLastActivityFromMessages(client, roomId, toIsoString(room.rows[0].created_at));
        if (!updatedRoom) {
          return null;
        }

        this.logger.debug('Message deleted from PostgreSQL', { roomId, messageId });
        return { room: updatedRoom, deleted: true };
      });

      await this.deleteOrphanedMediaObjects(orphanedObjectKeys);
      return result;
    } catch (error) {
      this.logger.error('Error deleting message from PostgreSQL', { error, roomId, messageId });
      return null;
    }
  }

  private async truncateMessages(roomId: string, messageId: string, mode: 'before' | 'after') {
    let orphanedObjectKeys: string[] = [];
    try {
      const result = await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [roomId]
        );
        if (room.rows.length === 0) {
          this.logger.warn('Cannot truncate messages for missing PostgreSQL room', { roomId, messageId, mode });
          return null;
        }

        const target = await client.query<{ position: number | string }>(
          'SELECT position FROM room_messages WHERE room_id = $1 AND id = $2',
          [roomId, messageId]
        );
        if (target.rows.length === 0) {
          const messages = await this.readMessagesByRoomInTransaction(client, roomId);
          return { room: mapRoom(room.rows[0]), messages, targetFound: false };
        }

        const operator = mode === 'before' ? '>=' : '>';
        // Strand-free order: drop the asset rows for the doomed messages before
        // the messages themselves are removed.
        const orphaned = await client.query<{ object_key: string }>(
          `DELETE FROM media_assets
          WHERE room_id = $1 AND message_id IN (
            SELECT id FROM room_messages WHERE room_id = $1 AND position ${operator} $2
          )
          RETURNING object_key`,
          [roomId, Number(target.rows[0].position)]
        );
        orphanedObjectKeys = orphaned.rows.map(row => row.object_key);

        await client.query(
          `DELETE FROM room_messages WHERE room_id = $1 AND position ${operator} $2`,
          [roomId, Number(target.rows[0].position)]
        );

        const updatedRoom = await this.updateRoomLastActivityFromMessages(client, roomId, toIsoString(room.rows[0].created_at));
        if (!updatedRoom) {
          return null;
        }

        const messages = await this.readMessagesByRoomInTransaction(client, roomId);
        this.logger.debug('Messages truncated in PostgreSQL', { roomId, messageId, mode, count: messages.length });
        return { room: updatedRoom, messages, targetFound: true };
      });

      await this.deleteOrphanedMediaObjects(orphanedObjectKeys);
      return result;
    } catch (error) {
      this.logger.error('Error truncating messages in PostgreSQL', { error, roomId, messageId, mode });
      return null;
    }
  }

  truncateBeforeMessage(roomId: string, messageId: string) {
    return this.truncateMessages(roomId, messageId, 'before');
  }

  truncateAfterMessage(roomId: string, messageId: string) {
    return this.truncateMessages(roomId, messageId, 'after');
  }

  async updateMessageAndTruncateAfter(roomId: string, messageId: string, updatedContent: string, updatedAt = new Date().toISOString()) {
    let orphanedObjectKeys: string[] = [];
    try {
      const result = await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [roomId]
        );
        if (room.rows.length === 0) {
          this.logger.warn('Cannot update and truncate message for missing PostgreSQL room', { roomId, messageId });
          return null;
        }

        const target = await client.query<{ position: number | string }>(
          'SELECT position FROM room_messages WHERE room_id = $1 AND id = $2',
          [roomId, messageId]
        );
        if (target.rows.length === 0) {
          const messages = await this.readMessagesByRoomInTransaction(client, roomId);
          return { room: mapRoom(room.rows[0]), messages, targetFound: false };
        }

        const updated = await client.query<MessageRow>(
          `UPDATE room_messages
          SET content = $3,
            updated_at = $4,
            ui_payload = NULL
          WHERE room_id = $1 AND id = $2
          RETURNING ${MESSAGE_COLUMNS}`,
          [roomId, messageId, updatedContent, updatedAt]
        );
        if (updated.rows.length === 0) {
          return null;
        }

        // Drop asset rows for the truncated tail before deleting those messages.
        const orphaned = await client.query<{ object_key: string }>(
          `DELETE FROM media_assets
          WHERE room_id = $1 AND message_id IN (
            SELECT id FROM room_messages WHERE room_id = $1 AND position > $2
          )
          RETURNING object_key`,
          [roomId, Number(target.rows[0].position)]
        );
        orphanedObjectKeys = orphaned.rows.map(row => row.object_key);

        await client.query(
          'DELETE FROM room_messages WHERE room_id = $1 AND position > $2',
          [roomId, Number(target.rows[0].position)]
        );

        const updatedRoom = await this.updateRoomLastActivityFromMessages(client, roomId, toIsoString(room.rows[0].created_at));
        if (!updatedRoom) {
          return null;
        }

        const messages = await this.readMessagesByRoomInTransaction(client, roomId);
        this.logger.debug('Message updated and history truncated in PostgreSQL', { roomId, messageId, count: messages.length });
        return {
          room: updatedRoom,
          messages,
          targetFound: true,
          updatedMessage: mapMessage(updated.rows[0]),
        };
      });

      await this.deleteOrphanedMediaObjects(orphanedObjectKeys);
      return result;
    } catch (error) {
      this.logger.error('Error updating and truncating message in PostgreSQL', { error, roomId, messageId });
      return null;
    }
  }

  async saveMessageHistory(roomId: string, messages: Message[]): Promise<Room | null> {
    try {
      return await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [roomId]
        );
        if (room.rows.length === 0) {
          this.logger.warn('Cannot save message history for missing PostgreSQL room', { roomId });
          return null;
        }

        await client.query('DELETE FROM room_messages WHERE room_id = $1', [roomId]);
        for (const [index, message] of messages.entries()) {
          await client.query(UPSERT_MESSAGE_SQL, messageParams({ ...message, roomId }, index));
        }

        const lastActivityAt = getLatestMessageTimestamp(messages) || toIsoString(room.rows[0].created_at);
        const updatedRoom = await client.query<RoomRow>(
          `UPDATE rooms
          SET last_activity_at = $2,
            updated_at = NOW()
          WHERE id = $1
          RETURNING ${ROOM_COLUMNS}`,
          [roomId, lastActivityAt]
        );
        this.logger.debug('Message history saved to PostgreSQL', { roomId, count: messages.length });
        return updatedRoom.rows[0] ? mapRoom(updatedRoom.rows[0]) : null;
      });
    } catch (error) {
      this.logger.error('Error saving message history to PostgreSQL', { error, roomId });
      return null;
    }
  }

  async clearRoomMessages(roomId: string): Promise<number> {
    let orphanedObjectKeys: string[] = [];
    let orphanedCheckpointObjectKeys: string[] = [];
    try {
      const deleted = await this.transaction(async client => {
        // Clearing removes every message, so every asset in the room is orphaned.
        const orphaned = await client.query<{ object_key: string }>(
          'DELETE FROM media_assets WHERE room_id = $1 RETURNING object_key',
          [roomId]
        );
        orphanedObjectKeys = orphaned.rows.map(row => row.object_key);
        const checkpoints = await client.query<{ object_key: string }>(
          `SELECT DISTINCT workspace_checkpoint->>'objectKey' AS object_key
          FROM room_agent_turns
          WHERE room_id = $1
            AND workspace_checkpoint->>'objectKey' IS NOT NULL`,
          [roomId],
        );
        orphanedCheckpointObjectKeys = checkpoints.rows.map(row => row.object_key);

        await client.query(
          'UPDATE rooms SET code_agent_workspace_revision_id = NULL WHERE id = $1',
          [roomId],
        );
        await client.query('DELETE FROM code_agent_workspace_revisions WHERE room_id = $1', [roomId]);
        await client.query('DELETE FROM room_agent_turns WHERE room_id = $1', [roomId]);
        const result = await client.query('DELETE FROM room_messages WHERE room_id = $1', [roomId]);
        const removed = result.rowCount || 0;
        if (removed > 0) {
          await client.query(
            `UPDATE rooms
            SET last_activity_at = created_at,
              updated_at = NOW()
            WHERE id = $1`,
            [roomId]
          );
        }
        return removed;
      });

      await this.deleteOrphanedMediaObjects(orphanedObjectKeys);
      await this.deleteOrphanedCheckpointObjects(orphanedCheckpointObjectKeys);
      return deleted;
    } catch (error) {
      this.logger.error('Error clearing PostgreSQL room messages', { error, roomId });
      return 0;
    }
  }

  async readMessagesByRoom(roomId: string): Promise<Message[]> {
    try {
      const result = await this.pool.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS}
        FROM room_messages
        WHERE room_id = $1
        ORDER BY position ASC, timestamp ASC`,
        [roomId]
      );
      return orderMessageBatches(await this.attachMediaAssets(roomId, result.rows.map(mapMessage)));
    } catch (error) {
      this.logger.error('Error reading PostgreSQL room messages', { error, roomId });
      return [];
    }
  }

  async readMessagePageByRoom(roomId: string, options: RoomMessagePageOptions = {}) {
    try {
      return await this.readMessagePageWithQueryable(this.pool, roomId, options);
    } catch (error) {
      if (error instanceof RoomPaginationBoundaryExpiredError) throw error;
      this.logger.error('Error reading PostgreSQL room message page', { error, roomId, options });
      return { roomId, messages: [], hasMore: false };
    }
  }

  async readRoomSnapshot(roomId: string, options: RoomMessagePageOptions = {}): Promise<RoomSnapshot> {
    return this.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const page = await this.readMessagePageWithQueryable(client, roomId, options);
      const stream = await client.query<{ head_seq: number | string }>(
        'SELECT head_seq FROM room_event_streams WHERE room_id = $1',
        [roomId]
      );
      if (!page.room) {
        throw new Error(`Cannot read a snapshot for missing room ${roomId}`);
      }
      return {
        roomId,
        room: page.room,
        messages: page.messages,
        turns: page.turns,
        hasMore: page.hasMore,
        oldestMessageId: page.oldestMessageId,
        snapshotSeq: Number(stream.rows[0]?.head_seq || 0),
      };
    });
  }

  async readRoomEventHead(roomId: string): Promise<number> {
    const result = await this.pool.query<{ head_seq: number | string }>(
      'SELECT head_seq FROM room_event_streams WHERE room_id = $1',
      [roomId]
    );
    return Number(result.rows[0]?.head_seq || 0);
  }

  async canReadRoomEvents(roomId: string, clientId: string): Promise<boolean> {
    const result = await this.pool.query<{ allowed: boolean }>(
      `SELECT (
        EXISTS (
          SELECT 1 FROM room_members
          WHERE room_id = $1 AND client_id = $2
        )
        OR EXISTS (
          SELECT 1 FROM room_event_streams
          WHERE room_id = $1 AND $2 = ANY(deleted_reader_ids)
        )
      ) AS allowed`,
      [roomId, clientId],
    );
    return Boolean(result.rows[0]?.allowed);
  }

  async readRoomMemberClientIds(roomId: string, clientIds: string[]): Promise<Set<string>> {
    if (clientIds.length === 0) return new Set();
    const result = await this.pool.query<{ client_id: string }>(
      `SELECT client_id FROM room_members
      WHERE room_id = $1 AND client_id = ANY($2::text[])`,
      [roomId, clientIds],
    );
    return new Set(result.rows.map(row => row.client_id));
  }

  async readRoomEvents(roomId: string, options: RoomEventPageOptions): Promise<RoomEventPage> {
    const afterSeq = Number(options.afterSeq);
    const limit = Math.min(500, Math.max(1, Math.floor(options.limit || 100)));
    const maxBytes = Math.min(1024 * 1024, Math.max(16 * 1024, Math.floor(options.maxBytes || 256 * 1024)));
    const stream = await this.pool.query<{
      head_seq: number | string;
      min_available_seq: number | string;
      deleted_at: string | Date | null;
    }>(
      'SELECT head_seq, min_available_seq, deleted_at FROM room_event_streams WHERE room_id = $1',
      [roomId]
    );
    const headSeq = Number(stream.rows[0]?.head_seq || 0);
    const minAvailableSeq = Number(stream.rows[0]?.min_available_seq || 1);
    let queryAfterSeq = afterSeq;
    if (stream.rows[0]?.deleted_at && afterSeq < headSeq) {
      // A deleted aggregate has no snapshot. Intermediate state is irrelevant:
      // return its terminal tombstone directly even when the retained prefix is
      // still large enough to tempt the client into snapshot recovery.
      queryAfterSeq = headSeq - 1;
    }
    if (afterSeq < minAvailableSeq - 1 && !stream.rows[0]?.deleted_at) {
      throw new RoomEventCursorExpiredError(roomId, afterSeq, minAvailableSeq);
    }
    if (afterSeq > headSeq) {
      throw new RoomEventCursorAheadError(roomId, afterSeq, headSeq);
    }

    const result = await this.pool.query<RoomEventRow>(
      `SELECT room_id, seq, event_type, schema_version, payload, created_at
      FROM room_events
      WHERE room_id = $1 AND seq > $2
      ORDER BY seq ASC
      LIMIT $3`,
      [roomId, queryAfterSeq, limit + 1]
    );
    const decoded = this.decodeRoomEvents(result.rows.slice(0, limit));
    const events: RoomEvent[] = [];
    let usedBytes = 0;
    for (const event of decoded) {
      const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
      if (events.length === 0 && eventBytes > maxBytes) {
        throw new RoomEventTooLargeError(roomId, event.seq, eventBytes, maxBytes);
      }
      if (usedBytes + eventBytes > maxBytes) break;
      events.push(event);
      usedBytes += eventBytes;
    }
    const lastSeq = events.length > 0 ? events[events.length - 1].seq : afterSeq;
    return {
      roomId,
      events,
      headSeq,
      minAvailableSeq,
      hasMore: lastSeq < headSeq,
    };
  }

  async readRoomEvent(roomId: string, seq: number): Promise<RoomEvent | null> {
    if (!Number.isSafeInteger(seq) || seq <= 0) return null;
    const result = await this.pool.query<RoomEventRow>(
      `SELECT room_id, seq, event_type, schema_version, payload, created_at
      FROM room_events
      WHERE room_id = $1 AND seq = $2
      LIMIT 1`,
      [roomId, seq]
    );
    return result.rows[0] ? this.decodeRoomEvents([result.rows[0]])[0] : null;
  }

  async pruneRoomEvents(options: RoomEventRetentionOptions): Promise<number> {
    return this.transaction(async client => {
      const deleted = await client.query<{ room_id: string }>(
        `WITH ranked AS (
          SELECT room_id,
            seq,
            created_at,
            ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY seq DESC) AS reverse_rank
          FROM room_events
        ), cutoffs AS (
          SELECT room_id, MAX(seq) AS delete_through
          FROM ranked
          WHERE created_at < $1::timestamptz OR reverse_rank > $2
          GROUP BY room_id
        )
        DELETE FROM room_events AS event
        USING cutoffs
        WHERE event.room_id = cutoffs.room_id
          AND event.seq <= cutoffs.delete_through
        RETURNING event.room_id`,
        [options.olderThan, Math.max(1, Math.floor(options.maxEventsPerRoom))]
      );
      await client.query(
        `UPDATE room_event_streams AS stream
        SET min_available_seq = COALESCE(
            (SELECT MIN(event.seq) FROM room_events AS event WHERE event.room_id = stream.room_id),
            stream.head_seq + 1
          ),
          updated_at = NOW()`
      );
      await client.query(
        `DELETE FROM room_event_streams AS stream
        WHERE stream.deleted_at IS NOT NULL
          AND stream.deleted_at < $1::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM room_events AS event WHERE event.room_id = stream.room_id
          )`,
        [options.olderThan],
      );
      return deleted.rowCount || 0;
    });
  }

  async beginCodeAgentTurn(input: CodeAgentTurnStartInput): Promise<CodeAgentTurnStartResult> {
    if (
      input.turn.id !== input.placeholder.turnId
      || input.turn.roomId !== input.roomId
      || input.placeholder.roomId !== input.roomId
      || input.turn.status !== 'running'
      || input.placeholder.status !== 'streaming'
      || !input.ownerId
      || !Number.isFinite(input.leaseTtlMs)
      || input.leaseTtlMs <= 0
    ) {
      throw new Error('Invalid atomic code-agent turn start');
    }

    try {
      return await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [input.roomId],
        );
        if (!room.rows[0]) return { outcome: 'missing_room' as const };

        let workspaceParentRevisionId: string | null = null;
        if (input.turn.backend === 'codex-app-server') {
          const rootRevisionId = `root:${input.roomId}`;
          await client.query(
            `INSERT INTO code_agent_workspace_revisions (
              id, room_id, kind, traversable, created_at
            ) VALUES ($1, $2, 'root', TRUE, $3::timestamptz)
            ON CONFLICT (id) DO NOTHING`,
            [rootRevisionId, input.roomId, room.rows[0].created_at],
          );
          workspaceParentRevisionId = room.rows[0].code_agent_workspace_revision_id || rootRevisionId;
        }

        let queuedMessage: MessageRow | undefined;
        if (input.queuedMessageId) {
          const queued = await client.query<MessageRow>(
            `SELECT ${MESSAGE_COLUMNS}
            FROM room_messages
            WHERE room_id = $1
              AND id = $2
              AND code_agent_queued_input->>'state' = 'starting'
            FOR UPDATE`,
            [input.roomId, input.queuedMessageId],
          );
          queuedMessage = queued.rows[0];
          if (!queuedMessage) return { outcome: 'queue_conflict' as const };
        }

        const lease = await client.query<CodeAgentRoomLeaseRow>(
          `INSERT INTO code_agent_room_leases (room_id, turn_id, owner_id, fence, expires_at)
          VALUES ($1, $2, $3, 1, $4::timestamptz + ($5::bigint * interval '1 millisecond'))
          ON CONFLICT (room_id) DO UPDATE SET
            turn_id = EXCLUDED.turn_id,
            owner_id = EXCLUDED.owner_id,
            fence = code_agent_room_leases.fence + 1,
            expires_at = EXCLUDED.expires_at
          WHERE code_agent_room_leases.expires_at <= $4::timestamptz
          RETURNING room_id, turn_id, owner_id, fence, expires_at`,
          [input.roomId, input.turn.id, input.ownerId, input.now, Math.floor(input.leaseTtlMs)],
        );
        const leaseRow = lease.rows[0];
        if (!leaseRow) return { outcome: 'busy' as const };

        let materializedPrompt: Message | undefined;
        if (queuedMessage && input.queuedMessageId) {
          const nextPosition = await client.query<{ position: number | string }>(
            `SELECT COALESCE(MAX(position), -1) + 1 AS position
            FROM room_messages
            WHERE room_id = $1`,
            [input.roomId],
          );
          const materialized = await client.query<MessageRow>(
            `UPDATE room_messages
            SET position = $3,
              timestamp = $4::timestamptz,
              updated_at = $4::timestamptz,
              turn_id = $5,
              code_agent_queued_input = NULL
            WHERE room_id = $1
              AND id = $2
              AND code_agent_queued_input->>'state' = 'starting'
            RETURNING ${MESSAGE_COLUMNS}`,
            [
              input.roomId,
              input.queuedMessageId,
              Number(nextPosition.rows[0]?.position || 0),
              input.now,
              input.turn.id,
            ],
          );
          if (!materialized.rows[0]) {
            throw new Error(`Queued code-agent input ${input.queuedMessageId} lost its start claim`);
          }
          materializedPrompt = mapMessage(materialized.rows[0]);
        }

        const nextPosition = await client.query<{ position: number | string }>(
          'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM room_messages WHERE room_id = $1',
          [input.roomId],
        );
        const placeholder = await client.query<MessageRow>(
          `${INSERT_MESSAGE_ROW_SQL} RETURNING ${MESSAGE_COLUMNS}`,
          messageParams(input.placeholder, Number(nextPosition.rows[0]?.position || 0)),
        );
        if (!placeholder.rows[0]) throw new Error('Failed to insert code-agent placeholder');

        const turn = await client.query<RoomAgentTurnRow>(
          `INSERT INTO room_agent_turns (
            ${ROOM_AGENT_TURN_COLUMNS},
            lease_owner,
            lease_fence
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
          )
          RETURNING ${ROOM_AGENT_TURN_COLUMNS}`,
          [
            input.turn.id,
            input.turn.roomId,
            input.turn.status,
            input.turn.startedAt,
            input.turn.completedAt || null,
            input.turn.finalMessageId || null,
            input.turn.backend,
            input.turn.assistantName,
            input.turn.phase || null,
            input.turn.phaseMessage || null,
            input.turn.lastHeartbeatAt || null,
            input.turn.updatedAt,
            input.backendSessionIdBefore || null,
            input.backendLastTurnIdBefore || null,
            null,
            null,
            null,
            workspaceParentRevisionId,
            null,
            input.ownerId,
            Number(leaseRow.fence),
          ],
        );
        if (!turn.rows[0]) throw new Error('Failed to insert code-agent turn');

        const updatedRoom = await client.query<RoomRow>(
          `UPDATE rooms
          SET code_agent_status = 'running',
            code_agent_workspace_revision_id = COALESCE(code_agent_workspace_revision_id, $3),
            last_activity_at = GREATEST(last_activity_at, $2::timestamptz),
            updated_at = clock_timestamp()
          WHERE id = $1
          RETURNING ${ROOM_COLUMNS}`,
          [input.roomId, input.now, workspaceParentRevisionId],
        );
        if (!updatedRoom.rows[0]) throw new Error('Failed to mark code-agent room running');

        return {
          outcome: 'started' as const,
          room: mapRoom(updatedRoom.rows[0]),
          turn: mapRoomAgentTurn(turn.rows[0]),
          placeholder: withAIStreamRecoveryMetadata(
            mapMessage(placeholder.rows[0]),
            placeholder.rows[0].ai_stream_owner_id || undefined,
            Number(placeholder.rows[0].ai_stream_fence),
          ),
          lease: mapCodeAgentRoomLease(leaseRow),
          ...(materializedPrompt ? { materializedPrompt } : {}),
        };
      });
    } catch (error) {
      this.logger.error('Error starting atomic PostgreSQL code-agent turn', {
        error,
        roomId: input.roomId,
        turnId: input.turn.id,
        messageId: input.placeholder.id,
      });
      throw error;
    }
  }

  async updateCodeAgentTurn(turn: RoomAgentTurn, claim: CodeAgentTurnClaim): Promise<RoomAgentTurn | null> {
    if (
      turn.id !== claim.turnId
      || turn.roomId !== claim.roomId
      || turn.status !== 'running'
      || !claim.ownerId
      || !Number.isSafeInteger(claim.fence)
      || claim.fence <= 0
    ) {
      throw new Error('Invalid fenced code-agent turn update');
    }

    const result = await this.pool.query<RoomAgentTurnRow>(
      `UPDATE room_agent_turns AS turn
      SET phase = $5,
        phase_message = $6,
        last_heartbeat_at = $7::timestamptz,
        updated_at = $8::timestamptz
      WHERE turn.id = $1
        AND turn.room_id = $2
        AND turn.status = 'running'
        AND turn.lease_owner = $3
        AND turn.lease_fence = $4
        AND EXISTS (
          SELECT 1
          FROM code_agent_room_leases AS lease
          WHERE lease.room_id = turn.room_id
            AND lease.turn_id = turn.id
            AND lease.owner_id = $3
            AND lease.fence = $4
            AND lease.expires_at > clock_timestamp()
        )
      RETURNING ${ROOM_AGENT_TURN_COLUMNS}`,
      [
        turn.id,
        turn.roomId,
        claim.ownerId,
        claim.fence,
        turn.phase || null,
        turn.phaseMessage || null,
        turn.lastHeartbeatAt || null,
        turn.updatedAt,
      ],
    );
    return result.rows[0] ? mapRoomAgentTurn(result.rows[0]) : null;
  }

  async appendCodeAgentMessage(
    message: Message,
    claim: CodeAgentTurnClaim,
    cost?: AICost | null,
  ): Promise<CodeAgentMessageMutationResult> {
    if (message.roomId !== claim.roomId || message.turnId !== claim.turnId) {
      throw new Error('Code-agent message does not match its turn claim');
    }

    return this.transaction(async client => {
      const room = await client.query<RoomRow>(
        `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
        [claim.roomId],
      );
      if (!room.rows[0] || !await this.lockCodeAgentTurnClaim(client, claim)) {
        return { outcome: 'stale' as const };
      }

      const nextPosition = await client.query<{ position: number | string }>(
        'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM room_messages WHERE room_id = $1',
        [message.roomId],
      );
      const inserted = await client.query<MessageRow>(
        `${INSERT_MESSAGE_ROW_SQL} RETURNING ${MESSAGE_COLUMNS}`,
        messageParams(message, Number(nextPosition.rows[0]?.position || 0)),
      );
      if (!inserted.rows[0]) throw new Error(`Failed to append code-agent message ${message.id}`);

      const roomCostTotal = await this.incrementRoomAICostWithClient(client, message.roomId, cost);
      const updatedRoom = await client.query<RoomRow>(
        `UPDATE rooms
        SET last_activity_at = GREATEST(last_activity_at, $2::timestamptz),
          updated_at = clock_timestamp()
        WHERE id = $1
        RETURNING ${ROOM_COLUMNS}`,
        [message.roomId, message.timestamp],
      );
      if (!updatedRoom.rows[0]) throw new Error(`Code-agent append lost room ${message.roomId}`);
      return {
        outcome: 'applied' as const,
        room: mapRoom(updatedRoom.rows[0]),
        message: mapMessage(inserted.rows[0]),
        roomCostTotal,
      };
    });
  }

  async finalizeCodeAgentMessage(
    message: Message,
    expectedOwnership: AIStreamOwnership,
    claim: CodeAgentTurnClaim,
    cost?: AICost | null,
  ): Promise<CodeAgentMessageMutationResult> {
    if (
      message.roomId !== claim.roomId
      || message.turnId !== claim.turnId
      || (message.status !== 'complete' && message.status !== 'error')
    ) {
      throw new Error('Invalid fenced code-agent message finalization');
    }

    return this.transaction(async client => {
      const room = await client.query<RoomRow>(
        `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
        [claim.roomId],
      );
      if (!room.rows[0] || !await this.lockCodeAgentTurnClaim(client, claim)) {
        return { outcome: 'stale' as const };
      }

      const updated = await this.finalizeAIMessageWithClient(client, message, expectedOwnership);
      if (!updated) return { outcome: 'obsolete' as const };

      const roomCostTotal = await this.incrementRoomAICostWithClient(client, message.roomId, cost);
      const updatedRoom = await client.query<RoomRow>(
        `UPDATE rooms
        SET last_activity_at = GREATEST(last_activity_at, $2::timestamptz),
          updated_at = clock_timestamp()
        WHERE id = $1
        RETURNING ${ROOM_COLUMNS}`,
        [message.roomId, message.timestamp],
      );
      if (!updatedRoom.rows[0]) throw new Error(`Code-agent finalization lost room ${message.roomId}`);
      return {
        outcome: 'applied' as const,
        room: mapRoom(updatedRoom.rows[0]),
        message: mapMessage(updated),
        roomCostTotal,
      };
    });
  }

  async finishCodeAgentTurn(input: CodeAgentTurnTerminalInput): Promise<CodeAgentTurnTerminalResult> {
    const { claim } = input;
    if (
      !claim.ownerId
      || !Number.isSafeInteger(claim.fence)
      || claim.fence <= 0
      || (input.message && (
        input.message.roomId !== claim.roomId
        || input.message.turnId !== claim.turnId
        || (input.message.status !== 'complete' && input.message.status !== 'error')
        || !input.expectedMessageOwnership
      ))
    ) {
      throw new Error('Invalid atomic code-agent terminal transition');
    }

    return this.transaction(async client => {
      const roomLock = await client.query<RoomRow>(
        `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
        [claim.roomId],
      );
      if (!roomLock.rows[0] || !await this.lockCodeAgentTurnClaim(client, claim)) {
        return { outcome: 'stale' as const };
      }

      let savedMessage: Message | undefined;
      let actualOutcome = input.outcome;
      if (input.message && input.expectedMessageOwnership) {
        const updated = await this.finalizeAIMessageWithClient(
          client,
          input.message,
          input.expectedMessageOwnership,
        );
        if (!updated) {
          actualOutcome = 'cancelled';
        } else {
          savedMessage = mapMessage(updated);
        }
      }

      const deleteMessageIds = Array.from(new Set(input.deleteMessageIds || []))
        .filter(messageId => messageId && messageId !== savedMessage?.id);
      if (deleteMessageIds.length > 0) {
        await client.query(
          `DELETE FROM room_messages
          WHERE room_id = $1
            AND turn_id = $2
            AND id = ANY($3::text[])`,
          [claim.roomId, claim.turnId, deleteMessageIds],
        );
      }

      const shouldSettleCost = actualOutcome === 'complete';
      const roomCostTotal = await this.incrementRoomAICostWithClient(
        client,
        claim.roomId,
        shouldSettleCost ? input.cost : null,
      );
      const roomStatus = actualOutcome === 'complete' || actualOutcome === 'cancelled'
        ? 'idle'
        : 'error';
      let room = await client.query<RoomRow>(
        `UPDATE rooms
        SET code_agent_status = $2,
          code_agent_session_id = CASE
            WHEN $2 = 'idle' AND $3::text IS NOT NULL THEN $3
            ELSE code_agent_session_id
          END,
          code_agent_last_turn_id = CASE
            WHEN $2 = 'idle' AND $3::text IS NOT NULL THEN $4
            ELSE code_agent_last_turn_id
          END,
          last_activity_at = GREATEST(last_activity_at, $5::timestamptz),
          updated_at = clock_timestamp()
        WHERE id = $1
        RETURNING ${ROOM_COLUMNS}`,
        [claim.roomId, roomStatus, input.sessionId || null, input.backendTurnId || null, input.completedAt],
      );
      if (!room.rows[0]) throw new Error(`Code-agent terminal transition lost room ${claim.roomId}`);

      const finalMessageId = actualOutcome === 'cancelled'
        ? null
        : (savedMessage?.id || input.finalMessageId || null);
      let turn = await client.query<RoomAgentTurnRow>(
        `UPDATE room_agent_turns
        SET status = $5,
          completed_at = $6::timestamptz,
          final_message_id = $7,
          phase = NULL,
          phase_message = NULL,
          last_heartbeat_at = $6::timestamptz,
          updated_at = $6::timestamptz,
          backend_session_id_after = $8,
          backend_turn_id_after = $9,
          workspace_checkpoint = $10::jsonb
        WHERE id = $1
          AND room_id = $2
          AND status = 'running'
          AND lease_owner = $3
          AND lease_fence = $4
        RETURNING ${ROOM_AGENT_TURN_COLUMNS}`,
        [
          claim.turnId,
          claim.roomId,
          claim.ownerId,
          claim.fence,
          actualOutcome,
          input.completedAt,
          finalMessageId,
          input.sessionId || null,
          input.backendTurnId || null,
          toJsonb(input.workspaceCheckpoint),
        ],
      );
      if (!turn.rows[0]) throw new Error(`Code-agent turn ${claim.turnId} lost its terminal fence`);

      if (turn.rows[0].backend === 'codex-app-server') {
        const parentRevisionId = turn.rows[0].workspace_parent_revision_id;
        if (!parentRevisionId) {
          throw new Error(`Code-agent turn ${claim.turnId} has no workspace parent revision`);
        }
        const revisionId = `turn:${claim.turnId}`;
        const checkpoint = input.workspaceCheckpoint;
        const traversable = Boolean(
          checkpoint?.status === 'ready'
          && checkpoint.manifest
          && checkpoint.manifest.files.every(file => file.restorable)
          && (checkpoint.manifest.files.length === 0 || Boolean(checkpoint.objectKey))
        );
        await client.query(
          `INSERT INTO code_agent_workspace_revisions (
            id, room_id, parent_revision_id, kind, turn_id,
            backend_session_id, backend_last_turn_id, traversable, created_at
          ) VALUES ($1, $2, $3, 'turn', $4, $5, $6, $7, $8::timestamptz)
          ON CONFLICT (id) DO NOTHING`,
          [
            revisionId,
            claim.roomId,
            parentRevisionId,
            claim.turnId,
            input.sessionId || null,
            input.backendTurnId || null,
            traversable,
            input.completedAt,
          ],
        );
        turn = await client.query<RoomAgentTurnRow>(
          `UPDATE room_agent_turns
          SET workspace_revision_id = $3
          WHERE id = $1 AND room_id = $2
          RETURNING ${ROOM_AGENT_TURN_COLUMNS}`,
          [claim.turnId, claim.roomId, revisionId],
        );
        if (!turn.rows[0]) throw new Error(`Code-agent turn ${claim.turnId} lost its workspace revision`);
        room = await client.query<RoomRow>(
          `UPDATE rooms
          SET code_agent_workspace_revision_id = $3,
            updated_at = clock_timestamp()
          WHERE id = $1
            AND code_agent_workspace_revision_id = $2
          RETURNING ${ROOM_COLUMNS}`,
          [claim.roomId, parentRevisionId, revisionId],
        );
        if (!room.rows[0]) {
          throw new Error(`Code-agent turn ${claim.turnId} lost the workspace revision head`);
        }
      }

      await client.query(
        `DELETE FROM code_agent_room_leases
        WHERE room_id = $1
          AND turn_id = $2
          AND owner_id = $3
          AND fence = $4`,
        [claim.roomId, claim.turnId, claim.ownerId, claim.fence],
      );

      return {
        outcome: actualOutcome === 'cancelled' ? 'obsolete' as const : 'applied' as const,
        room: mapRoom(room.rows[0]),
        turn: mapRoomAgentTurn(turn.rows[0]),
        ...(savedMessage ? { message: savedMessage } : {}),
        roomCostTotal,
      };
    });
  }

  async upsertRoomAgentTurn(turn: RoomAgentTurn): Promise<RoomAgentTurn | null> {
    try {
      const result = await this.pool.query<RoomAgentTurnRow>(
        `INSERT INTO room_agent_turns (${ROOM_AGENT_TURN_COLUMNS})
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          completed_at = EXCLUDED.completed_at,
          final_message_id = EXCLUDED.final_message_id,
          backend = EXCLUDED.backend,
          assistant_name = EXCLUDED.assistant_name,
          phase = EXCLUDED.phase,
          phase_message = EXCLUDED.phase_message,
          last_heartbeat_at = EXCLUDED.last_heartbeat_at,
          updated_at = EXCLUDED.updated_at
        RETURNING ${ROOM_AGENT_TURN_COLUMNS}`,
        [turn.id, turn.roomId, turn.status, turn.startedAt, turn.completedAt || null, turn.finalMessageId || null, turn.backend, turn.assistantName, turn.phase || null, turn.phaseMessage || null, turn.lastHeartbeatAt || null, turn.updatedAt]
      );
      return result.rows[0] ? mapRoomAgentTurn(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error upserting PostgreSQL room agent turn', { error, roomId: turn.roomId, turnId: turn.id });
      throw error;
    }
  }

  async readRoomAgentTurns(roomId: string, turnIds?: string[]): Promise<RoomAgentTurn[]> {
    if (turnIds && turnIds.length === 0) return [];
    try {
      const result = turnIds
        ? await this.pool.query<RoomAgentTurnRow>(
          `SELECT ${ROOM_AGENT_TURN_COLUMNS} FROM room_agent_turns WHERE room_id = $1 AND id = ANY($2::text[]) ORDER BY started_at ASC`,
          [roomId, turnIds]
        )
        : await this.pool.query<RoomAgentTurnRow>(
          `SELECT ${ROOM_AGENT_TURN_COLUMNS} FROM room_agent_turns WHERE room_id = $1 ORDER BY started_at ASC`,
          [roomId]
        );
      return result.rows.map(mapRoomAgentTurn);
    } catch (error) {
      this.logger.error('Error reading PostgreSQL room agent turns', { error, roomId });
      return [];
    }
  }

  async readCodeAgentWorkspaceCheckpoint(roomId: string, turnId: string): Promise<{
    turn: RoomAgentTurn;
    backendSessionIdBefore?: string;
    backendLastTurnIdBefore?: string;
    checkpoint: CodeAgentWorkspaceCheckpointRecord;
  } | null> {
    const result = await this.pool.query<RoomAgentTurnRow>(
      `SELECT ${ROOM_AGENT_TURN_COLUMNS}
      FROM room_agent_turns
      WHERE room_id = $1 AND id = $2
      LIMIT 1`,
      [roomId, turnId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const checkpoint = parseJsonValue<CodeAgentWorkspaceCheckpointRecord>(row.workspace_checkpoint);
    if (!checkpoint || checkpoint.schemaVersion !== 1) return null;
    return {
      turn: mapRoomAgentTurn(row),
      ...(row.backend_session_id_before ? { backendSessionIdBefore: row.backend_session_id_before } : {}),
      ...(row.backend_last_turn_id_before ? { backendLastTurnIdBefore: row.backend_last_turn_id_before } : {}),
      checkpoint,
    };
  }

  async readCodeAgentCheckpointRestorePlan(
    roomId: string,
    turnId: string,
    targetBoundary: CodeAgentCheckpointBoundary = 'before',
  ): Promise<CodeAgentCheckpointRestorePlan | null> {
    const [roomResult, turnResult, revisionResult, checkpointResult] = await Promise.all([
      this.pool.query<Pick<RoomRow, 'code_agent_workspace_revision_id'>>(
        `SELECT code_agent_workspace_revision_id FROM rooms WHERE id = $1 LIMIT 1`,
        [roomId],
      ),
      this.pool.query<RoomAgentTurnRow>(
        `SELECT ${ROOM_AGENT_TURN_COLUMNS}
        FROM room_agent_turns
        WHERE room_id = $1 AND id = $2
        LIMIT 1`,
        [roomId, turnId],
      ),
      this.pool.query<CodeAgentWorkspaceRevisionRow>(
        `SELECT ${CODE_AGENT_WORKSPACE_REVISION_COLUMNS}
        FROM code_agent_workspace_revisions
        WHERE room_id = $1`,
        [roomId],
      ),
      this.pool.query<Pick<RoomAgentTurnRow, 'id' | 'workspace_checkpoint'>>(
        `SELECT id, workspace_checkpoint
        FROM room_agent_turns
        WHERE room_id = $1 AND backend = 'codex-app-server'`,
        [roomId],
      ),
    ]);
    const selectedTurn = turnResult.rows[0];
    const currentRevisionId = roomResult.rows[0]?.code_agent_workspace_revision_id;
    if (!selectedTurn || !currentRevisionId || !selectedTurn.workspace_revision_id) return null;

    const revisions = new Map(
      revisionResult.rows.map(row => [row.id, row] as const),
    );
    const selectedRevision = revisions.get(selectedTurn.workspace_revision_id);
    const targetRevisionId = targetBoundary === 'after'
      ? selectedRevision?.id
      : selectedRevision?.parent_revision_id;
    if (!selectedRevision || selectedRevision.turn_id !== turnId || !targetRevisionId) return null;
    if (!revisions.has(currentRevisionId) || !revisions.has(targetRevisionId)) {
      throw new Error('Workspace revision graph is incomplete');
    }

    const sourcePath: CodeAgentWorkspaceRevisionRow[] = [];
    const sourceIndex = new Map<string, number>();
    const sourceVisited = new Set<string>();
    let cursor: string | null = currentRevisionId;
    while (cursor) {
      if (sourceVisited.has(cursor)) throw new Error('Workspace revision graph contains a cycle');
      sourceVisited.add(cursor);
      const revision = revisions.get(cursor);
      if (!revision) throw new Error(`Workspace revision ${cursor} is missing`);
      sourceIndex.set(cursor, sourcePath.length);
      sourcePath.push(revision);
      cursor = revision.parent_revision_id;
    }

    const targetBranch: CodeAgentWorkspaceRevisionRow[] = [];
    const targetVisited = new Set<string>();
    cursor = targetRevisionId;
    while (cursor && !sourceIndex.has(cursor)) {
      if (targetVisited.has(cursor)) throw new Error('Workspace revision graph contains a cycle');
      targetVisited.add(cursor);
      const revision = revisions.get(cursor);
      if (!revision) throw new Error(`Workspace revision ${cursor} is missing`);
      targetBranch.push(revision);
      cursor = revision.parent_revision_id;
    }
    if (!cursor) throw new Error('Workspace revision branches do not share a root');

    const commonAncestorIndex = sourceIndex.get(cursor);
    if (commonAncestorIndex === undefined) throw new Error('Workspace revision common ancestor is missing');
    const undoRevisions = sourcePath.slice(0, commonAncestorIndex);
    const redoRevisions = targetBranch.reverse();
    const traversedRevisions = [...undoRevisions, ...redoRevisions];
    const blockedRevision = traversedRevisions.find(revision => !revision.traversable);
    if (blockedRevision) {
      throw new Error(`Workspace history crosses incomplete revision ${blockedRevision.id}`);
    }

    const checkpointByTurnId = new Map<string, CodeAgentWorkspaceCheckpointRecord>();
    checkpointResult.rows.forEach(row => {
      const checkpoint = parseJsonValue<CodeAgentWorkspaceCheckpointRecord>(row.workspace_checkpoint);
      if (checkpoint?.schemaVersion === 1) checkpointByTurnId.set(row.id, checkpoint);
    });
    const toStep = (
      revision: CodeAgentWorkspaceRevisionRow,
      direction: CodeAgentCheckpointRestoreStep['direction'],
    ): CodeAgentCheckpointRestoreStep | null => {
      if (revision.kind !== 'turn') return null;
      if (!revision.turn_id) throw new Error(`Workspace revision ${revision.id} has no turn`);
      const checkpoint = checkpointByTurnId.get(revision.turn_id);
      if (
        !checkpoint
        || checkpoint.status !== 'ready'
        || !checkpoint.manifest
        || checkpoint.manifest.files.some(file => !file.restorable)
      ) {
        throw new Error(`Workspace revision ${revision.id} has no complete checkpoint`);
      }
      return {
        revisionId: revision.id,
        turnId: revision.turn_id,
        direction,
        checkpoint,
      };
    };
    const steps = [
      ...undoRevisions.map(revision => toStep(revision, 'before')),
      ...redoRevisions.map(revision => toStep(revision, 'after')),
    ].filter((step): step is CodeAgentCheckpointRestoreStep => Boolean(step));

    return {
      roomId,
      checkpointTurnId: turnId,
      targetBoundary,
      currentRevisionId,
      targetRevisionId,
      alreadyAtTarget: traversedRevisions.every(revision => revision.kind === 'restore'),
      ...((targetBoundary === 'before' ? selectedTurn.backend_session_id_before : selectedRevision.backend_session_id)
        ? { targetBackendSessionId: (targetBoundary === 'before' ? selectedTurn.backend_session_id_before : selectedRevision.backend_session_id)! }
        : {}),
      ...((targetBoundary === 'before' ? selectedTurn.backend_last_turn_id_before : selectedRevision.backend_last_turn_id)
        ? { targetBackendLastTurnId: (targetBoundary === 'before' ? selectedTurn.backend_last_turn_id_before : selectedRevision.backend_last_turn_id)! }
        : {}),
      steps,
    };
  }

  async commitCodeAgentCheckpointRestore(
    input: CodeAgentCheckpointRestoreCommitInput
  ): Promise<CodeAgentCheckpointRestoreCommitResult | null> {
    return this.transaction(async client => {
      const room = await client.query<RoomRow>(
        `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
        [input.roomId],
      );
      if (
        !room.rows[0]
        || room.rows[0].code_agent_status === 'running'
        || room.rows[0].code_agent_workspace_revision_id !== input.sourceRevisionId
      ) return null;
      const lease = await client.query<CodeAgentRoomLeaseRow>(
        `SELECT room_id, turn_id, owner_id, fence, expires_at
        FROM code_agent_room_leases
        WHERE room_id = $1
          AND turn_id = $2
          AND owner_id = $3
          AND fence = $4
          AND expires_at > clock_timestamp()
        FOR UPDATE`,
        [input.roomId, input.lease.turnId, input.lease.ownerId, input.lease.fence],
      );
      if (!lease.rows[0]) return null;
      const turn = await client.query<RoomAgentTurnRow>(
        `SELECT ${ROOM_AGENT_TURN_COLUMNS}
        FROM room_agent_turns
        WHERE room_id = $1
          AND id = $2
          AND workspace_checkpoint->>'status' = 'ready'
          AND (
            ($4 = 'before' AND workspace_parent_revision_id = $3)
            OR ($4 = 'after' AND workspace_revision_id = $3)
          )
        FOR UPDATE`,
        [input.roomId, input.checkpointTurnId, input.targetRevisionId, input.targetBoundary],
      );
      if (!turn.rows[0]) return null;

      const revision = await client.query<CodeAgentWorkspaceRevisionRow>(
        `INSERT INTO code_agent_workspace_revisions (
          id, room_id, parent_revision_id, kind, restore_id,
          restored_from_revision_id, restore_target_revision_id,
          backend_session_id, backend_last_turn_id, traversable, created_at
        ) VALUES ($1, $2, $3, 'restore', $4, $5, $3, $6, $7, TRUE, $8::timestamptz)
        RETURNING ${CODE_AGENT_WORKSPACE_REVISION_COLUMNS}`,
        [
          input.resultRevisionId,
          input.roomId,
          input.targetRevisionId,
          input.restoreId,
          input.sourceRevisionId,
          input.sessionId || null,
          input.lastTurnId || null,
          input.restoredAt,
        ],
      );
      if (!revision.rows[0]) throw new Error(`Checkpoint restore lost revision ${input.resultRevisionId}`);

      const updatedRoom = await client.query<RoomRow>(
        `UPDATE rooms
        SET code_agent_session_id = $2,
          code_agent_last_turn_id = $3,
          code_agent_workspace_revision_id = $4,
          code_agent_status = 'idle',
          updated_at = clock_timestamp()
        WHERE id = $1
        RETURNING ${ROOM_COLUMNS}`,
        [input.roomId, input.sessionId || null, input.lastTurnId || null, input.resultRevisionId],
      );
      if (!updatedRoom.rows[0]) throw new Error(`Checkpoint restore lost room ${input.roomId}`);
      await client.query(
        `INSERT INTO code_agent_checkpoint_restores (
          id, room_id, checkpoint_turn_id, restored_by_client_id,
          backend_session_id_after, backend_last_turn_id_after,
          restored_paths, conflict_paths, unavailable_paths, restored_at,
          source_revision_id, target_revision_id, result_revision_id, target_boundary
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::timestamptz, $11, $12, $13, $14)`,
        [
          input.restoreId,
          input.roomId,
          input.checkpointTurnId,
          input.restoredByClientId,
          input.sessionId || null,
          input.lastTurnId || null,
          JSON.stringify(input.restoredPaths),
          JSON.stringify(input.conflictPaths),
          JSON.stringify(input.unavailablePaths),
          input.restoredAt,
          input.sourceRevisionId,
          input.targetRevisionId,
          input.resultRevisionId,
          input.targetBoundary,
        ],
      );
      await client.query(
        `DELETE FROM code_agent_room_leases
        WHERE room_id = $1 AND turn_id = $2 AND owner_id = $3 AND fence = $4`,
        [input.roomId, input.lease.turnId, input.lease.ownerId, input.lease.fence],
      );
      return {
        room: mapRoom(updatedRoom.rows[0]),
        turn: mapRoomAgentTurn(turn.rows[0]),
        revision: mapCodeAgentWorkspaceRevision(revision.rows[0]),
      };
    });
  }

  async failInterruptedRoomAgentTurns(completedAt = new Date().toISOString()): Promise<number> {
    try {
      return await this.transaction(async client => {
        const candidates = await client.query<{
          id: string;
          room_id: string;
          lease_owner: string | null;
          lease_fence: number | string | null;
        }>(
          `SELECT id, room_id, lease_owner, lease_fence
          FROM room_agent_turns
          WHERE status = 'running'
          ORDER BY room_id, id
          FOR UPDATE SKIP LOCKED`,
        );
        const turnIds: string[] = [];
        for (const candidate of candidates.rows) {
          const lease = await client.query<{ live: boolean }>(
            `SELECT expires_at > $5::timestamptz AS live
            FROM code_agent_room_leases
            WHERE room_id = $1
              AND turn_id = $2
              AND ($3::text IS NULL OR owner_id = $3)
              AND ($4::bigint IS NULL OR fence = $4)
            FOR UPDATE`,
            [
              candidate.room_id,
              candidate.id,
              candidate.lease_owner,
              candidate.lease_fence === null ? null : Number(candidate.lease_fence),
              completedAt,
            ],
          );
          if (lease.rows[0]?.live) continue;

          await client.query(
            `DELETE FROM code_agent_room_leases
            WHERE room_id = $1
              AND turn_id = $2
              AND ($3::text IS NULL OR owner_id = $3)
              AND ($4::bigint IS NULL OR fence = $4)`,
            [
              candidate.room_id,
              candidate.id,
              candidate.lease_owner,
              candidate.lease_fence === null ? null : Number(candidate.lease_fence),
            ],
          );
          const recovered = await client.query<{ id: string }>(
            `UPDATE room_agent_turns
            SET status = 'error',
              completed_at = $2::timestamptz,
              phase = NULL,
              phase_message = NULL,
              last_heartbeat_at = $2::timestamptz,
              updated_at = $2::timestamptz
            WHERE id = $1
              AND status = 'running'
            RETURNING id`,
            [candidate.id, completedAt],
          );
          if (recovered.rows[0]) turnIds.push(recovered.rows[0].id);
        }
        if (turnIds.length > 0) {
          await client.query(
            `UPDATE room_messages
            SET content = CASE
                  WHEN btrim(content) = '' THEN 'Response interrupted.'
                  ELSE content
                END,
              status = 'error',
              is_error = true,
              ai_stream_owner_id = NULL,
              updated_at = $2::timestamptz
            WHERE turn_id = ANY($1::text[])
              AND message_type = 'ai'
              AND status = 'streaming'`,
            [turnIds, completedAt],
          );
        }
        return turnIds.length;
      });
    } catch (error) {
      this.logger.error('Error recovering interrupted PostgreSQL room agent turns', { error });
      throw error;
    }
  }

  async acquireCodeAgentRoomLease(
    roomId: string,
    turnId: string,
    ownerId: string,
    now: string,
    ttlMs: number
  ): Promise<CodeAgentRoomLease | null> {
    try {
      const result = await this.pool.query<CodeAgentRoomLeaseRow>(
        `INSERT INTO code_agent_room_leases (room_id, turn_id, owner_id, fence, expires_at)
        VALUES ($1, $2, $3, 1, $4::timestamptz + ($5::bigint * interval '1 millisecond'))
        ON CONFLICT (room_id) DO UPDATE SET
          turn_id = EXCLUDED.turn_id,
          owner_id = EXCLUDED.owner_id,
          fence = code_agent_room_leases.fence + 1,
          expires_at = EXCLUDED.expires_at
        WHERE code_agent_room_leases.expires_at <= $4::timestamptz
        RETURNING room_id, turn_id, owner_id, fence, expires_at`,
        [roomId, turnId, ownerId, now, ttlMs]
      );
      return result.rows[0] ? mapCodeAgentRoomLease(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error acquiring PostgreSQL code-agent room lease', { error, roomId, turnId, ownerId });
      return null;
    }
  }

  async hasActiveCodeAgentRoomLease(roomId: string, now: string): Promise<boolean> {
    const result = await this.pool.query<{ active: boolean }>(
      `SELECT EXISTS (
        SELECT 1
        FROM code_agent_room_leases
        WHERE room_id = $1
          AND expires_at > $2::timestamptz
      ) AS active`,
      [roomId, now],
    );
    return result.rows[0]?.active === true;
  }

  async renewCodeAgentRoomLease(
    roomId: string,
    turnId: string,
    ownerId: string,
    now: string,
    ttlMs: number,
    fence?: number,
  ): Promise<CodeAgentRoomLease | null> {
    try {
      const result = await this.pool.query<CodeAgentRoomLeaseRow>(
        `UPDATE code_agent_room_leases
        SET expires_at = $4::timestamptz + ($5::bigint * interval '1 millisecond')
        WHERE room_id = $1 AND turn_id = $2 AND owner_id = $3
          AND expires_at > $4::timestamptz
          AND ($6::bigint IS NULL OR fence = $6)
        RETURNING room_id, turn_id, owner_id, fence, expires_at`,
        [roomId, turnId, ownerId, now, ttlMs, fence ?? null]
      );
      return result.rows[0] ? mapCodeAgentRoomLease(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error renewing PostgreSQL code-agent room lease', { error, roomId, turnId, ownerId, fence });
      return null;
    }
  }

  async releaseCodeAgentRoomLease(
    roomId: string,
    turnId: string,
    ownerId: string,
    fence?: number,
  ): Promise<boolean> {
    try {
      const result = await this.pool.query(
        `DELETE FROM code_agent_room_leases
        WHERE room_id = $1
          AND turn_id = $2
          AND owner_id = $3
          AND ($4::bigint IS NULL OR fence = $4)`,
        [roomId, turnId, ownerId, fence ?? null]
      );
      return (result.rowCount || 0) > 0;
    } catch (error) {
      this.logger.error('Error releasing PostgreSQL code-agent room lease', { error, roomId, turnId, ownerId, fence });
      return false;
    }
  }

  async saveMediaAsset(asset: MediaAsset): Promise<MediaAsset | null> {
    try {
      return await this.saveMediaAssetWithClient(this.pool, asset);
    } catch (error) {
      this.logger.error('Error saving PostgreSQL media asset', { error, assetId: asset.id, roomId: asset.roomId, kind: asset.kind });
      return null;
    }
  }

  async replaceMessageMediaAsset(roomId: string, messageId: string, asset: MediaAsset) {
    const mediaAsset: MediaAsset = {
      ...asset,
      roomId,
      messageId,
    };

    try {
      return await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [roomId]
        );
        if (room.rows.length === 0) {
          this.logger.warn('Cannot replace media asset for missing PostgreSQL room', { roomId, messageId, assetId: asset.id });
          return null;
        }

        const updated = await client.query<MessageRow>(
          `UPDATE room_messages
          SET content = $3,
            message_type = 'media',
            mime_type = $4
          WHERE room_id = $1 AND id = $2
            AND message_type = 'media'
          RETURNING ${MESSAGE_COLUMNS}`,
          [roomId, messageId, '', mediaAsset.mimeType]
        );
        if (updated.rows.length === 0) {
          return { room: mapRoom(room.rows[0]), found: false };
        }

        const savedAsset = await this.saveMediaAssetWithClient(client, mediaAsset);
        if (!savedAsset) {
          return null;
        }

        const updatedMessage = this.attachMediaAssetsFromAssets([mapMessage(updated.rows[0])], [savedAsset])[0];
        this.logger.debug('Media message asset replaced in PostgreSQL', { roomId, messageId, assetId: mediaAsset.id, kind: mediaAsset.kind });
        return { room: mapRoom(room.rows[0]), found: true, updatedMessage };
      });
    } catch (error) {
      this.logger.error('Error replacing PostgreSQL media message asset', { error, roomId, messageId, assetId: asset.id });
      return null;
    }
  }

  async getMediaAsset(assetId: string): Promise<MediaAsset | null> {
    try {
      const result = await this.pool.query<MediaAssetRow>(
        `SELECT ${MEDIA_ASSET_COLUMNS}
        FROM media_assets
        WHERE id = $1`,
        [assetId]
      );
      return result.rows[0] ? mapMediaAsset(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL media asset', { error, assetId });
      return null;
    }
  }

  async getMediaAssetByMessageId(messageId: string): Promise<MediaAsset | null> {
    try {
      const result = await this.pool.query<MediaAssetRow>(
        `SELECT ${MEDIA_ASSET_COLUMNS}
        FROM media_assets
        WHERE message_id = $1`,
        [messageId]
      );
      return result.rows[0] ? mapMediaAsset(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL media asset by message id', { error, messageId });
      return null;
    }
  }

  async readMediaAssetsByRoom(roomId: string): Promise<MediaAsset[]> {
    try {
      const result = await this.pool.query<MediaAssetRow>(
        `SELECT ${MEDIA_ASSET_COLUMNS}
        FROM media_assets
        WHERE room_id = $1
        ORDER BY created_at ASC`,
        [roomId]
      );
      return result.rows.map(mapMediaAsset);
    } catch (error) {
      this.logger.error('Error reading PostgreSQL media assets by room', { error, roomId });
      return [];
    }
  }

  async readMediaHistoryPageByRoom(roomId: string, options: MediaHistoryPageOptions = {}): Promise<MediaHistoryPage> {
    const limit = normalizeMediaHistoryPageLimit(options.limit);
    const kinds = options.kinds?.length ? options.kinds : ['image', 'video', 'audio'];
    const params: unknown[] = [roomId, kinds];
    const conditions = ['room_id = $1', 'kind = ANY($2::text[])'];
    const sinceTime = Date.parse(options.since || '');
    const beforeTime = Date.parse(options.before?.createdAt || '');

    if (Number.isFinite(sinceTime)) {
      params.push(options.since);
      conditions.push(`created_at >= $${params.length}`);
    }

    if (options.before && Number.isFinite(beforeTime)) {
      params.push(options.before.createdAt, options.before.assetId);
      const createdAtParam = params.length - 1;
      const assetIdParam = params.length;
      conditions.push(`(created_at < $${createdAtParam} OR (created_at = $${createdAtParam} AND id < $${assetIdParam}))`);
    }

    params.push(limit + 1);

    try {
      const result = await this.pool.query<MediaAssetRow>(
        `SELECT ${MEDIA_ASSET_COLUMNS}
        FROM media_assets
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length}`,
        params
      );
      return {
        assets: result.rows.slice(0, limit).map(mapMediaAsset),
        hasMore: result.rows.length > limit,
      };
    } catch (error) {
      this.logger.error('Error reading PostgreSQL media history page by room', { error, roomId, options });
      return { assets: [], hasMore: false };
    }
  }

  async deleteMediaAsset(assetId: string): Promise<void> {
    try {
      await this.pool.query('DELETE FROM media_assets WHERE id = $1', [assetId]);
    } catch (error) {
      this.logger.error('Error deleting PostgreSQL media asset', { error, assetId });
    }
  }

  async savePendingMediaUpload(upload: PendingMediaUpload): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO pending_media_uploads (
          id,
          room_id,
          object_key,
          kind,
          mime_type,
          byte_size,
          filename,
          uploaded_by_client_id,
          expires_at,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO UPDATE SET
          room_id = EXCLUDED.room_id,
          object_key = EXCLUDED.object_key,
          kind = EXCLUDED.kind,
          mime_type = EXCLUDED.mime_type,
          byte_size = EXCLUDED.byte_size,
          filename = EXCLUDED.filename,
          uploaded_by_client_id = EXCLUDED.uploaded_by_client_id,
          expires_at = EXCLUDED.expires_at`,
        [
          upload.assetId,
          upload.roomId,
          upload.objectKey,
          upload.kind,
          upload.mimeType,
          upload.byteSize,
          upload.filename || null,
          upload.uploadedByClientId,
          upload.expiresAt,
          upload.createdAt,
        ]
      );
    } catch (error) {
      this.logger.error('Error saving PostgreSQL pending media upload', { error, assetId: upload.assetId, roomId: upload.roomId });
      throw error;
    }
  }

  async getPendingMediaUpload(assetId: string): Promise<PendingMediaUpload | null> {
    try {
      const result = await this.pool.query<PendingMediaUploadRow>(
        `SELECT ${PENDING_MEDIA_UPLOAD_COLUMNS}
        FROM pending_media_uploads
        WHERE id = $1`,
        [assetId]
      );
      return result.rows[0] ? mapPendingMediaUpload(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL pending media upload', { error, assetId });
      return null;
    }
  }

  async deletePendingMediaUpload(assetId: string): Promise<void> {
    try {
      await this.pool.query('DELETE FROM pending_media_uploads WHERE id = $1', [assetId]);
    } catch (error) {
      this.logger.error('Error deleting PostgreSQL pending media upload', { error, assetId });
    }
  }

  async claimExpiredPendingMediaUploads(now: string, limit = 50): Promise<PendingMediaUpload[]> {
    const safeLimit = Math.min(200, Math.max(1, Math.floor(limit)));
    try {
      const result = await this.pool.query<PendingMediaUploadRow>(
        `DELETE FROM pending_media_uploads
        WHERE id IN (
          SELECT id
          FROM pending_media_uploads
          WHERE expires_at <= $1
          ORDER BY expires_at ASC
          LIMIT $2
        )
        RETURNING ${PENDING_MEDIA_UPLOAD_COLUMNS}`,
        [now, safeLimit]
      );
      return result.rows.map(mapPendingMediaUpload);
    } catch (error) {
      this.logger.error('Error claiming expired PostgreSQL pending media uploads', { error, now, limit: safeLimit });
      return [];
    }
  }

  async getAudioTranscription(assetId: string): Promise<AudioTranscriptionRecord | null> {
    try {
      const result = await this.pool.query<AudioTranscriptionRow>(
        `SELECT ${AUDIO_TRANSCRIPTION_COLUMNS}
        FROM audio_transcriptions
        WHERE asset_id = $1`,
        [assetId]
      );
      return result.rows[0] ? mapAudioTranscription(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL audio transcription', { error, assetId });
      return null;
    }
  }

  async createAudioTranscription(record: AudioTranscriptionRecord): Promise<AudioTranscriptionRecord> {
    try {
      const result = await this.pool.query<AudioTranscriptionRow>(
        `INSERT INTO audio_transcriptions (
          asset_id,
          room_id,
          message_id,
          requested_by_client_id,
          status,
          transcript,
          language_code,
          provider,
          provider_transcript_id,
          error,
          created_at,
          updated_at,
          completed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (asset_id) DO NOTHING
        RETURNING ${AUDIO_TRANSCRIPTION_COLUMNS}`,
        [
          record.assetId,
          record.roomId,
          record.messageId,
          record.requestedByClientId,
          record.status,
          record.transcript ?? null,
          record.languageCode ?? null,
          record.provider,
          record.providerTranscriptId ?? null,
          record.error ?? null,
          record.createdAt,
          record.updatedAt,
          record.completedAt ?? null,
        ]
      );
      if (result.rows[0]) {
        return mapAudioTranscription(result.rows[0]);
      }

      const existing = await this.getAudioTranscription(record.assetId);
      if (existing) {
        return existing;
      }
      throw new Error('Audio transcription insert conflicted but no existing row was found');
    } catch (error) {
      this.logger.error('Error creating PostgreSQL audio transcription', { error, assetId: record.assetId, roomId: record.roomId, messageId: record.messageId });
      throw error;
    }
  }

  async updateAudioTranscription(assetId: string, updates: AudioTranscriptionUpdate): Promise<AudioTranscriptionRecord | null> {
    const assignments: string[] = [];
    const values: unknown[] = [assetId];
    const addAssignment = (column: string, value: unknown) => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };

    if (updates.status !== undefined) addAssignment('status', updates.status);
    if (updates.transcript !== undefined) addAssignment('transcript', updates.transcript);
    if (updates.languageCode !== undefined) addAssignment('language_code', updates.languageCode);
    if (updates.providerTranscriptId !== undefined) addAssignment('provider_transcript_id', updates.providerTranscriptId);
    if (updates.error !== undefined) addAssignment('error', updates.error);
    if (updates.completedAt !== undefined) addAssignment('completed_at', updates.completedAt);
    addAssignment('updated_at', updates.updatedAt || new Date().toISOString());

    try {
      const result = await this.pool.query<AudioTranscriptionRow>(
        `UPDATE audio_transcriptions
        SET ${assignments.join(', ')}
        WHERE asset_id = $1
        RETURNING ${AUDIO_TRANSCRIPTION_COLUMNS}`,
        values
      );
      return result.rows[0] ? mapAudioTranscription(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error updating PostgreSQL audio transcription', { error, assetId, updates });
      throw error;
    }
  }

  async readRoomAICost(roomId: string): Promise<RoomAICostTotal> {
    try {
      const result = await this.pool.query<{ total_usd: string | number }>(
        'SELECT total_usd FROM room_ai_cost_totals WHERE room_id = $1',
        [roomId]
      );
      const totalUsd = Number.parseFloat(String(result.rows[0]?.total_usd || '0'));
      return {
        roomId,
        currency: 'USD',
        totalUsd: Number.isFinite(totalUsd) ? totalUsd : 0,
      };
    } catch (error) {
      this.logger.error('Error reading PostgreSQL room AI cost total', { error, roomId });
      throw error;
    }
  }

  async incrementRoomAICost(roomId: string, cost: AICost | null): Promise<RoomAICostTotal> {
    if (!cost || !Number.isFinite(cost.totalUsd) || cost.totalUsd <= 0) {
      return this.readRoomAICost(roomId);
    }

    try {
      const result = await this.pool.query<{ total_usd: string | number }>(
        `INSERT INTO room_ai_cost_totals (room_id, total_usd)
        VALUES ($1, $2)
        ON CONFLICT (room_id) DO UPDATE SET
          total_usd = room_ai_cost_totals.total_usd + EXCLUDED.total_usd,
          updated_at = NOW()
        RETURNING total_usd`,
        [roomId, cost.totalUsd]
      );
      const totalUsd = Number.parseFloat(String(result.rows[0]?.total_usd || cost.totalUsd));
      return {
        roomId,
        currency: 'USD',
        totalUsd: Number.isFinite(totalUsd) ? totalUsd : cost.totalUsd,
      };
    } catch (error) {
      this.logger.error('Error incrementing PostgreSQL room AI cost total', { error, roomId, cost });
      throw error;
    }
  }

  async setRoomAICostTotal(roomId: string, totalUsd: number): Promise<RoomAICostTotal> {
    if (!Number.isFinite(totalUsd) || totalUsd <= 0) {
      try {
        await this.pool.query('DELETE FROM room_ai_cost_totals WHERE room_id = $1', [roomId]);
      } catch (error) {
        this.logger.error('Error clearing PostgreSQL room AI cost total', { error, roomId, totalUsd });
        throw error;
      }
      return { roomId, currency: 'USD', totalUsd: 0 };
    }

    try {
      const result = await this.pool.query<{ total_usd: string | number }>(
        `INSERT INTO room_ai_cost_totals (room_id, total_usd)
        VALUES ($1, $2)
        ON CONFLICT (room_id) DO UPDATE SET
          total_usd = EXCLUDED.total_usd,
          updated_at = NOW()
        RETURNING total_usd`,
        [roomId, totalUsd]
      );
      const savedTotalUsd = Number.parseFloat(String(result.rows[0]?.total_usd || totalUsd));
      return {
        roomId,
        currency: 'USD',
        totalUsd: Number.isFinite(savedTotalUsd) ? savedTotalUsd : totalUsd,
      };
    } catch (error) {
      this.logger.error('Error setting PostgreSQL room AI cost total', { error, roomId, totalUsd });
      throw error;
    }
  }

  async getAssistantRun(runId: string): Promise<AssistantRunRecord | null> {
    try {
      const result = await this.pool.query<AssistantRunRow>(
        `SELECT ${ASSISTANT_RUN_COLUMNS} FROM assistant_runs WHERE id = $1`,
        [runId]
      );
      return result.rows[0] ? mapAssistantRun(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL assistant run', { error, runId });
      throw error;
    }
  }

  async createOutboxEvent(event: OutboxEventRecord): Promise<OutboxEventRecord | null> {
    try {
      const result = await this.pool.query<OutboxEventRow>(INSERT_OUTBOX_EVENT_SQL, outboxEventParams(event));
      return result.rows[0] ? mapOutboxEvent(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error creating PostgreSQL outbox event', { error, eventId: event.id, eventType: event.eventType });
      return null;
    }
  }

  async createAssistantRunWithMessage(message: Message, run: AssistantRunRecord) {
    if (
      message.roomId !== run.roomId
      || message.id !== run.aiMessageId
      || message.messageType !== 'ai'
      || message.clientId !== 'ai_assistant'
      || message.status !== 'streaming'
      || run.status !== 'queued'
      || !decodeAssistantRunRequestPayload(run.requestPayload, {
        roomId: run.roomId,
        modelId: run.modelId,
        apiModel: run.apiModel,
        provider: run.provider,
      })
    ) {
      throw new Error('Assistant run creation requires one queued run and its streaming placeholder');
    }

    try {
      return await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [message.roomId],
        );
        if (!room.rows[0]) return null;

        const nextPosition = await client.query<{ position: number | string }>(
          'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM room_messages WHERE room_id = $1',
          [message.roomId],
        );
        const entitlementResult = await client.query<AccountEntitlementRow>(
          `SELECT membership.account_id,
            membership.tier,
            membership.status,
            membership.priority_override,
            membership.current_period_start,
            membership.current_period_end,
            membership.external_provider,
            balance.available_usd,
            balance.lifetime_usage_usd,
            GREATEST(membership.updated_at, balance.updated_at) AS updated_at
          FROM client_account_links AS link
          JOIN account_memberships AS membership
            ON membership.account_id = link.account_id
          JOIN account_credit_balances AS balance
            ON balance.account_id = link.account_id
          WHERE link.client_id = $1
          LIMIT 1
          FOR SHARE OF membership, balance`,
          [run.requestedByClientId],
        );
        const entitlement = entitlementResult.rows[0]
          ? mapAccountEntitlement(entitlementResult.rows[0])
          : null;
        const scheduling = resolveAssistantRunScheduling(entitlement ? {
          accountId: entitlement.accountId,
          tier: entitlement.tier,
          status: entitlement.status,
          creditBalanceUsd: entitlement.creditBalanceUsd,
          ...(entitlement.priorityOverride !== undefined
            ? { priorityOverride: entitlement.priorityOverride }
            : {}),
        } : null);
        const scheduledRun: AssistantRunRecord = {
          ...run,
          billingAccountId: scheduling.accountId,
          membershipTier: scheduling.membershipTier,
          creditState: scheduling.creditState,
          queuePriority: scheduling.queuePriority,
          chargedCostUsd: 0,
          creditAppliedUsd: 0,
        };
        const position = Number(nextPosition.rows[0]?.position || 0);
        const insertedMessage = await client.query<MessageRow>(
          `${INSERT_MESSAGE_ROW_SQL} RETURNING ${MESSAGE_COLUMNS}`,
          messageParams(message, position),
        );
        const runResult = await client.query<AssistantRunRow>(
          INSERT_ASSISTANT_RUN_SQL,
          assistantRunParams(scheduledRun),
        );
        if (!insertedMessage.rows[0] || !runResult.rows[0]) {
          throw new Error('Failed to create assistant run and placeholder');
        }
        await client.query(
          `INSERT INTO task_dispatch_outbox (
            run_id, status, available_at, queue_priority
          ) VALUES ($1, 'pending', $2::timestamptz, $3)`,
          [run.id, run.availableAt, scheduling.queuePriority],
        );

        const updatedRoom = await client.query<RoomRow>(
          `UPDATE rooms
          SET last_activity_at = GREATEST(last_activity_at, $2::timestamptz),
            updated_at = clock_timestamp()
          WHERE id = $1
          RETURNING ${ROOM_COLUMNS}`,
          [message.roomId, message.timestamp],
        );
        if (!updatedRoom.rows[0]) throw new Error('Failed to update room for assistant run creation');

        return {
          room: mapRoom(updatedRoom.rows[0]),
          message: mapMessage(insertedMessage.rows[0]),
          run: mapAssistantRun(runResult.rows[0]),
        };
      });
    } catch (error) {
      this.logger.error('Error creating PostgreSQL assistant run with placeholder', {
        error,
        runId: run.id,
        messageId: message.id,
        roomId: message.roomId,
      });
      return null;
    }
  }

  async claimAssistantRun(options: AssistantRunClaimOptions): Promise<AssistantRunClaim | null> {
    const lockMs = Math.max(1_000, options.leaseMs || 60_000);
    try {
      const result = await this.transaction(async client => client.query<AssistantRunRow & { claimed_status: AssistantRunRecord['status'] }>(
        `WITH runtime_clock AS (
          SELECT COALESCE($1::timestamptz, clock_timestamp()) AS now
        ), candidate AS (
          SELECT id, status AS claimed_status
          FROM assistant_runs, runtime_clock
          WHERE (
            (status = 'queued' AND available_at <= runtime_clock.now)
            OR (
              status IN ('running', 'finalizing')
              AND available_at <= runtime_clock.now
              AND (lease_expires_at IS NULL OR lease_expires_at <= runtime_clock.now)
            )
          )
          ORDER BY CASE WHEN status = 'finalizing' THEN 0 ELSE 1 END,
            available_at ASC,
            created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE assistant_runs AS run
        SET status = CASE WHEN candidate.claimed_status = 'finalizing' THEN 'finalizing' ELSE 'running' END,
          generation = run.generation + 1,
          attempt = run.attempt + CASE WHEN candidate.claimed_status = 'finalizing' THEN 0 ELSE 1 END,
          started_at = COALESCE(run.started_at, runtime_clock.now),
          lease_owner = $2,
          lease_expires_at = runtime_clock.now + ($3::bigint * interval '1 millisecond'),
          error = CASE WHEN candidate.claimed_status = 'finalizing' THEN run.error ELSE NULL END,
          updated_at = runtime_clock.now
        FROM candidate, runtime_clock
        WHERE run.id = candidate.id
        RETURNING ${CLAIMED_ASSISTANT_RUN_COLUMNS}, candidate.claimed_status`,
        [options.now || null, options.workerId, lockMs],
      ));
      const row = result.rows[0];
      if (!row) return null;
      const run = mapAssistantRun(row);
      return {
        run,
        token: { workerId: options.workerId, generation: run.generation },
        phase: row.claimed_status === 'finalizing' ? 'project' : 'execute',
      };
    } catch (error) {
      this.logger.error('Error claiming PostgreSQL assistant run', { error, options });
      throw error;
    }
  }

  async claimAssistantRunById(
    runId: string,
    options: AssistantRunClaimOptions,
  ): Promise<AssistantRunClaim | null> {
    const lockMs = Math.max(1_000, options.leaseMs || 60_000);
    try {
      const result = await this.transaction(async client => client.query<AssistantRunRow & { claimed_status: AssistantRunRecord['status'] }>(
        `WITH runtime_clock AS (
          SELECT COALESCE($1::timestamptz, clock_timestamp()) AS now
        ), candidate AS (
          SELECT id, status AS claimed_status
          FROM assistant_runs, runtime_clock
          WHERE id = $2
            AND (
              status = 'queued'
              OR (
                status IN ('running', 'finalizing')
                AND (lease_expires_at IS NULL OR lease_expires_at <= runtime_clock.now)
              )
            )
          FOR UPDATE
        )
        UPDATE assistant_runs AS run
        SET status = CASE WHEN candidate.claimed_status = 'finalizing' THEN 'finalizing' ELSE 'running' END,
          generation = run.generation + 1,
          attempt = run.attempt + CASE WHEN candidate.claimed_status = 'finalizing' THEN 0 ELSE 1 END,
          started_at = COALESCE(run.started_at, runtime_clock.now),
          lease_owner = $3,
          lease_expires_at = runtime_clock.now + ($4::bigint * interval '1 millisecond'),
          error = CASE WHEN candidate.claimed_status = 'finalizing' THEN run.error ELSE NULL END,
          updated_at = runtime_clock.now
        FROM candidate, runtime_clock
        WHERE run.id = candidate.id
        RETURNING ${CLAIMED_ASSISTANT_RUN_COLUMNS}, candidate.claimed_status`,
        [options.now || null, runId, options.workerId, lockMs],
      ));
      const row = result.rows[0];
      if (!row) return null;
      const run = mapAssistantRun(row);
      return {
        run,
        token: { workerId: options.workerId, generation: run.generation },
        phase: row.claimed_status === 'finalizing' ? 'project' : 'execute',
      };
    } catch (error) {
      this.logger.error('Error claiming PostgreSQL assistant run by id', { error, runId, options });
      throw error;
    }
  }

  async renewAssistantRunLease(
    runId: string,
    claim: AssistantRunClaimToken,
    leaseMs: number,
    now?: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE assistant_runs
      SET lease_expires_at = COALESCE($4::timestamptz, clock_timestamp()) + ($5::bigint * interval '1 millisecond'),
        updated_at = COALESCE($4::timestamptz, clock_timestamp())
      WHERE id = $1
        AND status IN ('running', 'finalizing')
        AND lease_owner = $2
        AND generation = $3`,
      [runId, claim.workerId, claim.generation, now || null, Math.max(1_000, leaseMs)],
    );
    return (result.rowCount || 0) === 1;
  }

  async stageAssistantRunTerminal(
    runId: string,
    claim: AssistantRunClaimToken,
    terminal: AssistantRunTerminalPayloadV1,
  ): Promise<AssistantRunRecord | null> {
    return this.transaction(async client => {
      const locked = await client.query<AssistantRunRow>(
        `SELECT ${ASSISTANT_RUN_COLUMNS}
        FROM assistant_runs
        WHERE id = $1
          AND status = 'running'
          AND lease_owner = $2
          AND generation = $3
        FOR UPDATE`,
        [runId, claim.workerId, claim.generation],
      );
      const runRow = locked.rows[0];
      if (!runRow) return null;

      if (!decodeAssistantRunTerminalRow(runRow, terminal)) {
        throw new Error(`Assistant run ${runId} produced an invalid terminal payload`);
      }

      const result = await client.query<AssistantRunRow>(
        `UPDATE assistant_runs
        SET status = 'finalizing',
          terminal_payload = $4::jsonb,
          error = $5,
          available_at = clock_timestamp(),
          updated_at = clock_timestamp()
        WHERE id = $1
          AND status = 'running'
          AND lease_owner = $2
          AND generation = $3
        RETURNING ${ASSISTANT_RUN_COLUMNS}`,
        [runId, claim.workerId, claim.generation, toJsonb(terminal), terminal.error || null],
      );
      if (!result.rows[0]) throw new Error(`Assistant run ${runId} lost its terminal staging fence`);
      return mapAssistantRun(result.rows[0]);
    });
  }

  async projectAssistantRunTerminal(
    runId: string,
    claim: AssistantRunClaimToken,
  ): Promise<AssistantRunProjectionResult> {
    return this.transaction(async client => {
      const locked = await client.query<AssistantRunRow>(
        `SELECT ${ASSISTANT_RUN_COLUMNS}
        FROM assistant_runs
        WHERE id = $1
        FOR UPDATE`,
        [runId],
      );
      const runRow = locked.rows[0];
      if (
        !runRow
        || runRow.status !== 'finalizing'
        || runRow.lease_owner !== claim.workerId
        || Number(runRow.generation) !== claim.generation
      ) {
        return { outcome: 'stale' as const };
      }

      const terminal = decodeAssistantRunTerminalRow(runRow, runRow.terminal_payload);
      if (!terminal) throw new Error(`Assistant run ${runId} has an invalid staged terminal payload`);

      const message = terminal.message;
      const updatedMessage = await client.query<MessageRow>(
        `UPDATE room_messages
        SET content = $3,
          timestamp = $4::timestamptz,
          updated_at = COALESCE($5::timestamptz, $4::timestamptz),
          status = $6,
          is_error = $7,
          ai_model = $8::jsonb,
          usage = $9::jsonb,
          cost = $10::jsonb,
          ui_payload = $11::jsonb,
          model_step_id = $12,
          model_step_sequence = $13,
          ai_stream_owner_id = NULL
        WHERE id = $1
          AND room_id = $2
          AND status = 'streaming'
        RETURNING ${MESSAGE_COLUMNS}`,
        [
          message.id,
          message.roomId,
          message.content,
          message.timestamp,
          message.updatedAt || null,
          message.status,
          message.isError ?? (message.status === 'error'),
          toJsonb(message.aiModel),
          toJsonb(message.usage),
          toJsonb(message.cost),
          toJsonb(message.uiPayload),
          message.modelStepId || null,
          message.modelStepSequence ?? null,
        ],
      );

      if (!updatedMessage.rows[0]) {
        const cancelled = await client.query<AssistantRunRow>(
          `UPDATE assistant_runs
          SET status = 'cancelled',
            error = 'AI placeholder was deleted or superseded before terminal projection',
            completed_at = clock_timestamp(),
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = clock_timestamp()
          WHERE id = $1
            AND status = 'finalizing'
            AND lease_owner = $2
            AND generation = $3
          RETURNING ${ASSISTANT_RUN_COLUMNS}`,
          [runId, claim.workerId, claim.generation],
        );
        if (!cancelled.rows[0]) return { outcome: 'stale' as const };
        return { outcome: 'obsolete' as const, run: mapAssistantRun(cancelled.rows[0]) };
      }

      const totalUsd = Number.isFinite(message.cost?.totalUsd) && Number(message.cost?.totalUsd) > 0
        ? Number(message.cost!.totalUsd)
        : 0;
      let creditAppliedUsd = 0;
      if (totalUsd > 0) {
        await client.query(
          `INSERT INTO room_ai_cost_totals (room_id, total_usd, updated_at)
          VALUES ($1, $2, clock_timestamp())
          ON CONFLICT (room_id) DO UPDATE SET
            total_usd = room_ai_cost_totals.total_usd + EXCLUDED.total_usd,
            updated_at = clock_timestamp()`,
          [message.roomId, totalUsd],
        );
      }

      if (
        totalUsd > 0
        && runRow.billing_account_id
        && runRow.membership_tier
        && runRow.membership_tier !== 'guest'
      ) {
        const existingUsage = await client.query<{ assistant_run_id: string }>(
          `SELECT assistant_run_id
          FROM account_ai_usage_events
          WHERE assistant_run_id = $1
          LIMIT 1`,
          [runId],
        );
        if (!existingUsage.rows[0]) {
          const balance = await client.query<{ available_usd: number | string }>(
            `SELECT available_usd
            FROM account_credit_balances
            WHERE account_id = $1
            FOR UPDATE`,
            [runRow.billing_account_id],
          );
          if (!balance.rows[0]) {
            throw new Error(`Assistant run ${runId} billing account has no credit balance`);
          }
          const availableUsd = Number(balance.rows[0].available_usd) || 0;
          creditAppliedUsd = Math.min(availableUsd, totalUsd);
          const usage = await client.query(
            `INSERT INTO account_ai_usage_events (
              assistant_run_id,
              account_id,
              cost_usd,
              credit_applied_usd,
              membership_tier,
              provider,
              model_id,
              source,
              room_id,
              message_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'assistant_run', $8, $9)
            ON CONFLICT (assistant_run_id) DO NOTHING`,
            [
              runId,
              runRow.billing_account_id,
              totalUsd,
              creditAppliedUsd,
              runRow.membership_tier,
              runRow.provider,
              runRow.model_id,
              runRow.room_id,
              runRow.ai_message_id,
            ],
          );
          if ((usage.rowCount || 0) === 1) {
            const updatedBalance = await client.query(
              `UPDATE account_credit_balances
              SET available_usd = GREATEST(0, available_usd - $2),
                lifetime_usage_usd = lifetime_usage_usd + $3,
                updated_at = clock_timestamp()
              WHERE account_id = $1`,
              [runRow.billing_account_id, creditAppliedUsd, totalUsd],
            );
            if ((updatedBalance.rowCount || 0) !== 1) {
              throw new Error(`Assistant run ${runId} lost its billing account balance`);
            }
          }
        } else {
          const previousUsage = await client.query<{ credit_applied_usd: number | string }>(
            `SELECT credit_applied_usd
            FROM account_ai_usage_events
            WHERE assistant_run_id = $1`,
            [runId],
          );
          creditAppliedUsd = Number(previousUsage.rows[0]?.credit_applied_usd) || 0;
        }
      }

      const costTotal = await client.query<{ total_usd: number | string }>(
        'SELECT total_usd FROM room_ai_cost_totals WHERE room_id = $1',
        [message.roomId],
      );
      const parsedTotal = Number.parseFloat(String(costTotal.rows[0]?.total_usd || '0'));

      const room = await client.query<RoomRow>(
        `UPDATE rooms
        SET last_activity_at = GREATEST(last_activity_at, $2::timestamptz),
          updated_at = clock_timestamp()
        WHERE id = $1
        RETURNING ${ROOM_COLUMNS}`,
        [message.roomId, message.timestamp],
      );
      if (!room.rows[0]) throw new Error(`Assistant run projection lost room ${message.roomId}`);

      const completed = await client.query<AssistantRunRow>(
        `UPDATE assistant_runs
        SET status = $4,
          error = $5,
          charged_cost_usd = $6,
          credit_applied_usd = $7,
          completed_at = clock_timestamp(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = clock_timestamp()
        WHERE id = $1
          AND status = 'finalizing'
          AND lease_owner = $2
          AND generation = $3
        RETURNING ${ASSISTANT_RUN_COLUMNS}`,
        [
          runId,
          claim.workerId,
          claim.generation,
          terminal.outcome,
          terminal.error || null,
          totalUsd,
          creditAppliedUsd,
        ],
      );
      if (!completed.rows[0]) throw new Error(`Assistant run ${runId} lost its terminal projection fence`);

      return {
        outcome: 'applied' as const,
        room: mapRoom(room.rows[0]),
        message: mapMessage(updatedMessage.rows[0]),
        run: mapAssistantRun(completed.rows[0]),
        roomCostTotal: {
          roomId: message.roomId,
          currency: 'USD' as const,
          totalUsd: Number.isFinite(parsedTotal) ? parsedTotal : 0,
        },
      };
    });
  }

  async releaseAssistantRunClaim(
    runId: string,
    claim: AssistantRunClaimToken,
    errorMessage: string,
    retryDelayMs: number,
    now?: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE assistant_runs
      SET status = CASE WHEN status = 'running' THEN 'queued' ELSE status END,
        lease_owner = NULL,
        lease_expires_at = NULL,
        available_at = COALESCE($4::timestamptz, clock_timestamp()) + ($5::bigint * interval '1 millisecond'),
        error = $6,
        updated_at = COALESCE($4::timestamptz, clock_timestamp())
      WHERE id = $1
        AND status IN ('running', 'finalizing')
        AND lease_owner = $2
        AND generation = $3`,
      [runId, claim.workerId, claim.generation, now || null, Math.max(0, retryDelayMs), errorMessage],
    );
    return (result.rowCount || 0) === 1;
  }

  async claimTaskDispatches(options: TaskDispatchClaimOptions): Promise<TaskDispatchRecord[]> {
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit || 20)));
    const lockMs = Math.max(1_000, options.lockMs || 60_000);
    const result = await this.transaction(async client => client.query<TaskDispatchRow>(
      `WITH runtime_clock AS (
        SELECT COALESCE($1::timestamptz, clock_timestamp()) AS now
      ), candidates AS (
        SELECT dispatch.run_id
        FROM task_dispatch_outbox AS dispatch
        JOIN assistant_runs AS run ON run.id = dispatch.run_id
        CROSS JOIN runtime_clock
        WHERE run.status IN ('queued', 'running', 'finalizing')
          AND dispatch.available_at <= runtime_clock.now
          AND (
            dispatch.status = 'pending'
            OR (
              dispatch.status = 'processing'
              AND dispatch.locked_at <= runtime_clock.now - ($4::bigint * interval '1 millisecond')
            )
          )
        ORDER BY dispatch.queue_priority ASC, dispatch.created_at ASC
        LIMIT $3
        FOR UPDATE OF dispatch SKIP LOCKED
      )
      UPDATE task_dispatch_outbox AS dispatch
      SET status = 'processing',
        attempts = dispatch.attempts + 1,
        locked_at = runtime_clock.now,
        locked_by = $2,
        last_error = NULL,
        updated_at = runtime_clock.now
      FROM candidates, runtime_clock
      WHERE dispatch.run_id = candidates.run_id
      RETURNING dispatch.*`,
      [options.now || null, options.workerId, limit, lockMs],
    ));
    return result.rows.map(mapTaskDispatch);
  }

  async markTaskDispatchDispatched(
    runId: string,
    claim: TaskDispatchClaimToken,
    now?: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE task_dispatch_outbox
      SET status = 'dispatched',
        locked_at = NULL,
        locked_by = NULL,
        dispatched_at = COALESCE($4::timestamptz, clock_timestamp()),
        last_error = NULL,
        updated_at = COALESCE($4::timestamptz, clock_timestamp())
      WHERE run_id = $1
        AND status = 'processing'
        AND locked_by = $2
        AND attempts = $3`,
      [runId, claim.workerId, claim.attempt, now || null],
    );
    return (result.rowCount || 0) === 1;
  }

  async releaseTaskDispatch(
    runId: string,
    claim: TaskDispatchClaimToken,
    errorMessage: string,
    retryDelayMs: number,
    now?: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE task_dispatch_outbox
      SET status = 'pending',
        available_at = COALESCE($4::timestamptz, clock_timestamp()) + ($5::bigint * interval '1 millisecond'),
        locked_at = NULL,
        locked_by = NULL,
        last_error = $6,
        updated_at = COALESCE($4::timestamptz, clock_timestamp())
      WHERE run_id = $1
        AND status = 'processing'
        AND locked_by = $2
        AND attempts = $3`,
      [runId, claim.workerId, claim.attempt, now || null, Math.max(0, retryDelayMs), errorMessage],
    );
    return (result.rowCount || 0) === 1;
  }

  async readActiveDispatchedTaskDispatches(
    options: ActiveTaskDispatchQueryOptions = {},
  ): Promise<TaskDispatchRecord[]> {
    const limit = Math.min(1_000, Math.max(1, Math.floor(options.limit || 200)));
    const graceMs = Math.max(0, options.graceMs ?? 30_000);
    const result = await this.pool.query<TaskDispatchRow>(
      `WITH runtime_clock AS (
        SELECT COALESCE($1::timestamptz, clock_timestamp()) AS now
      )
      SELECT dispatch.*
      FROM task_dispatch_outbox AS dispatch
      JOIN assistant_runs AS run ON run.id = dispatch.run_id
      CROSS JOIN runtime_clock
      WHERE run.status IN ('queued', 'running', 'finalizing')
        AND dispatch.status = 'dispatched'
        AND dispatch.dispatched_at <= runtime_clock.now - ($3::bigint * interval '1 millisecond')
        AND ($4::text IS NULL OR dispatch.run_id > $4)
      ORDER BY dispatch.run_id ASC
      LIMIT $2`,
      [options.now || null, limit, graceMs, options.afterRunId || null],
    );
    return result.rows.map(mapTaskDispatch);
  }

  async readTaskDispatchMetrics(): Promise<TaskDispatchMetrics> {
    const result = await this.pool.query<{
      pending_count: number | string;
      processing_count: number | string;
      oldest_pending_at: string | Date | null;
    }>(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
        COUNT(*) FILTER (WHERE status = 'processing') AS processing_count,
        MIN(created_at) FILTER (WHERE status IN ('pending', 'processing')) AS oldest_pending_at
      FROM task_dispatch_outbox`,
    );
    const row = result.rows[0];
    return {
      pendingCount: Number(row?.pending_count) || 0,
      processingCount: Number(row?.processing_count) || 0,
      ...(row?.oldest_pending_at ? { oldestPendingAt: toIsoString(row.oldest_pending_at) } : {}),
    };
  }

  async claimOutboxEvents(options: OutboxClaimOptions): Promise<OutboxEventRecord[]> {
    const now = options.now || null;
    const lockMs = Math.max(1000, options.lockMs || 60_000);
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit || 10)));
    const eventTypes = options.eventTypes?.filter(Boolean);

    try {
      const result = await this.transaction(async client => {
        const params: unknown[] = [now, options.workerId, limit, lockMs];
        const eventTypeClause = eventTypes && eventTypes.length > 0
          ? `AND event_type = ANY($5::text[])`
          : '';
        if (eventTypes && eventTypes.length > 0) {
          params.push(eventTypes);
        }

        return client.query<OutboxEventRow>(
          `WITH runtime_clock AS (
            SELECT COALESCE($1::timestamptz, clock_timestamp()) AS now
          ), candidates AS (
            SELECT outbox_events.id
            FROM outbox_events, runtime_clock
            WHERE (
              status = 'pending'
              OR (
                status = 'processing'
                AND locked_at < (runtime_clock.now - (($4::int || ' milliseconds')::interval))
              )
            )
            AND available_at <= runtime_clock.now
            ${eventTypeClause}
            ORDER BY created_at ASC
            LIMIT $3
            FOR UPDATE SKIP LOCKED
          )
          UPDATE outbox_events e
          SET status = 'processing',
            attempts = e.attempts + 1,
            locked_at = runtime_clock.now,
            locked_by = $2,
            updated_at = runtime_clock.now
          FROM candidates, runtime_clock
          WHERE e.id = candidates.id
          RETURNING ${CLAIMED_OUTBOX_EVENT_COLUMNS}`,
          params
        );
      });
      return result.rows.map(mapOutboxEvent);
    } catch (error) {
      this.logger.error('Error claiming PostgreSQL outbox events', { error, options });
      return [];
    }
  }

  async renewOutboxEventLease(
    eventId: string,
    claim: OutboxClaimToken,
    now?: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE outbox_events
      SET locked_at = COALESCE($4::timestamptz, clock_timestamp()),
        updated_at = COALESCE($4::timestamptz, clock_timestamp())
      WHERE id = $1
        AND status = 'processing'
        AND locked_by = $2
        AND attempts = $3`,
      [eventId, claim.workerId, claim.attempt, now],
    );
    return (result.rowCount || 0) === 1;
  }

  async markOutboxEventProcessed(
    eventId: string,
    claim: OutboxClaimToken,
    processedAt?: string,
  ): Promise<OutboxEventRecord | null> {
    try {
      const result = await this.pool.query<OutboxEventRow>(
        `UPDATE outbox_events
        SET status = 'processed',
          processed_at = COALESCE($2::timestamptz, clock_timestamp()),
          locked_at = NULL,
          locked_by = NULL,
          last_error = NULL,
          updated_at = COALESCE($2::timestamptz, clock_timestamp())
        WHERE id = $1
          AND status = 'processing'
          AND locked_by = $3
          AND attempts = $4
        RETURNING ${OUTBOX_EVENT_COLUMNS}`,
        [eventId, processedAt, claim.workerId, claim.attempt]
      );
      return result.rows[0] ? mapOutboxEvent(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error marking PostgreSQL outbox event processed', { error, eventId });
      return null;
    }
  }

  async markOutboxEventFailed(
    eventId: string,
    errorMessage: string,
    claim: OutboxClaimToken,
    options: OutboxFailOptions = {},
  ): Promise<OutboxEventRecord | null> {
    const now = options.now || null;
    const retryDelayMs = Math.max(0, options.retryDelayMs || 30_000);
    const maxAttempts = Math.max(1, options.maxAttempts || 10);

    try {
      const result = await this.pool.query<OutboxEventRow>(
        `UPDATE outbox_events
        SET status = CASE WHEN attempts >= $5 THEN 'failed' ELSE 'pending' END,
          available_at = CASE WHEN attempts >= $5 THEN available_at ELSE (COALESCE($2::timestamptz, clock_timestamp()) + (($4::int || ' milliseconds')::interval)) END,
          locked_at = NULL,
          locked_by = NULL,
          last_error = $3,
          updated_at = COALESCE($2::timestamptz, clock_timestamp())
        WHERE id = $1
          AND status = 'processing'
          AND locked_by = $6
          AND attempts = $7
        RETURNING ${OUTBOX_EVENT_COLUMNS}`,
        [eventId, now, errorMessage, retryDelayMs, maxAttempts, claim.workerId, claim.attempt]
      );
      return result.rows[0] ? mapOutboxEvent(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error marking PostgreSQL outbox event failed', { error, eventId, errorMessage });
      return null;
    }
  }

  async saveRoom(room: Room): Promise<Room | null> {
    try {
      return await this.transaction(async client => {
        const result = await client.query<RoomRow>(
          `INSERT INTO rooms (
            id,
            name,
            description,
            created_at,
            last_activity_at,
            creator_id,
            type,
            sandbox_id,
            sandbox_status,
            sandbox_updated_at,
            sandbox_artifact_version,
            sandbox_code_agent_source_ref,
            code_agent_session_id,
            code_agent_status,
            code_agent_access,
            code_agent_mode,
            code_agent_backend,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            last_activity_at = GREATEST(rooms.last_activity_at, EXCLUDED.last_activity_at),
            type = CASE WHEN $18::boolean THEN EXCLUDED.type ELSE rooms.type END,
            sandbox_id = COALESCE(EXCLUDED.sandbox_id, rooms.sandbox_id),
            sandbox_status = COALESCE(EXCLUDED.sandbox_status, rooms.sandbox_status),
            sandbox_updated_at = COALESCE(EXCLUDED.sandbox_updated_at, rooms.sandbox_updated_at),
            sandbox_artifact_version = COALESCE(EXCLUDED.sandbox_artifact_version, rooms.sandbox_artifact_version),
            sandbox_code_agent_source_ref = COALESCE(EXCLUDED.sandbox_code_agent_source_ref, rooms.sandbox_code_agent_source_ref),
            code_agent_session_id = COALESCE(EXCLUDED.code_agent_session_id, rooms.code_agent_session_id),
            code_agent_status = COALESCE(EXCLUDED.code_agent_status, rooms.code_agent_status),
            code_agent_access = COALESCE(EXCLUDED.code_agent_access, rooms.code_agent_access),
            code_agent_mode = COALESCE(EXCLUDED.code_agent_mode, rooms.code_agent_mode),
            code_agent_backend = COALESCE(EXCLUDED.code_agent_backend, rooms.code_agent_backend),
            updated_at = NOW()
          RETURNING ${ROOM_COLUMNS}`,
          [
            room.id,
            room.name,
            room.description || '',
            room.createdAt,
            room.lastActivityAt || room.createdAt,
            room.creatorId,
            room.type || 'chat',
            room.sandboxId || null,
            room.sandboxStatus || null,
            room.sandboxUpdatedAt || null,
            room.sandboxArtifactVersion || null,
            room.sandboxCodeAgentSourceRef || null,
            room.codeAgentSessionId || null,
            room.codeAgentStatus || null,
            room.codeAgentAccess || null,
            room.codeAgentMode || null,
            room.codeAgentBackend || null,
            room.type !== undefined,
          ]
        );

        if (result.rows[0]) {
          await client.query(
            `INSERT INTO room_members (room_id, client_id, role, joined_at)
            VALUES ($1, $2, 'owner', $3)
            ON CONFLICT (room_id, client_id) DO UPDATE SET
              role = 'owner'`,
            [room.id, room.creatorId, room.createdAt]
          );
        }

        this.logger.debug('Room saved to PostgreSQL', { roomId: room.id, creatorId: room.creatorId });
        return result.rows[0] ? mapRoom(result.rows[0]) : null;
      });
    } catch (error) {
      this.logger.error('Error saving room to PostgreSQL', { error, roomId: room.id, creatorId: room.creatorId });
      return null;
    }
  }

  async addRoomMember(roomId: string, clientId: string, role: RoomMemberRole, joinedAt = new Date().toISOString()): Promise<RoomMember | null> {
    try {
      const result = await this.pool.query<RoomMemberRow>(
        `INSERT INTO room_members (room_id, client_id, role, joined_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (room_id, client_id) DO UPDATE SET
          role = CASE
            WHEN room_members.role = 'owner' THEN 'owner'
            WHEN EXCLUDED.role = 'owner' THEN 'owner'
            ELSE room_members.role
          END
        RETURNING ${ROOM_MEMBER_COLUMNS}`,
        [roomId, clientId, role, joinedAt]
      );
      return result.rows[0] ? mapRoomMember(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error adding PostgreSQL room member', { error, roomId, clientId, role });
      return null;
    }
  }

  async removeRoomMember(roomId: string, clientId: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        `DELETE FROM room_members
        WHERE room_id = $1 AND client_id = $2 AND role <> 'owner'`,
        [roomId, clientId]
      );
      return (result.rowCount || 0) > 0;
    } catch (error) {
      this.logger.error('Error removing PostgreSQL room member', { error, roomId, clientId });
      return false;
    }
  }

  async getRoomMember(roomId: string, clientId: string): Promise<RoomMember | null> {
    try {
      const result = await this.pool.query<RoomMemberRow>(
        `SELECT ${ROOM_MEMBER_COLUMNS}
        FROM room_members
        WHERE room_id = $1 AND client_id = $2`,
        [roomId, clientId]
      );
      return result.rows[0] ? mapRoomMember(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL room member', { error, roomId, clientId });
      return null;
    }
  }

  async isRoomMember(roomId: string, clientId: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        'SELECT 1 FROM room_members WHERE room_id = $1 AND client_id = $2 LIMIT 1',
        [roomId, clientId]
      );
      return result.rows.length > 0;
    } catch (error) {
      this.logger.error('Error checking PostgreSQL room membership', { error, roomId, clientId });
      return false;
    }
  }

  async readRoomMembers(roomId: string): Promise<RoomMember[]> {
    try {
      const result = await this.pool.query<RoomMemberRow>(
        `SELECT ${ROOM_MEMBER_COLUMNS}
        FROM room_members
        WHERE room_id = $1
        ORDER BY joined_at ASC`,
        [roomId]
      );
      return result.rows.map(mapRoomMember);
    } catch (error) {
      this.logger.error('Error reading PostgreSQL room members', { error, roomId });
      return [];
    }
  }

  async savePushSubscription(subscription: SavePushSubscriptionInput): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO push_subscriptions (endpoint, client_id, browser_instance_id, p256dh, auth, user_agent, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
        ON CONFLICT (endpoint) DO UPDATE SET
          client_id = EXCLUDED.client_id,
          browser_instance_id = EXCLUDED.browser_instance_id,
          p256dh = EXCLUDED.p256dh,
          auth = EXCLUDED.auth,
          user_agent = EXCLUDED.user_agent,
          updated_at = EXCLUDED.updated_at`,
        [
          subscription.endpoint,
          subscription.clientId,
          subscription.browserInstanceId || null,
          subscription.p256dh,
          subscription.auth,
          subscription.userAgent || null,
        ]
      );
    } catch (error) {
      this.logger.error('Error saving PostgreSQL push subscription', { error, clientId: subscription.clientId });
    }
  }

  async deletePushSubscription(clientId: string, endpoint: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        'DELETE FROM push_subscriptions WHERE client_id = $1 AND endpoint = $2',
        [clientId, endpoint]
      );
      return (result.rowCount || 0) > 0;
    } catch (error) {
      this.logger.error('Error deleting PostgreSQL push subscription', { error, clientId });
      return false;
    }
  }

  async readPushSubscriptionsByRoom(roomId: string): Promise<PushSubscriptionRecord[]> {
    try {
      const result = await this.pool.query<PushSubscriptionRow>(
        `SELECT ps.${PUSH_SUBSCRIPTION_COLUMNS.replace(/, /g, ', ps.')}
        FROM push_subscriptions ps
        INNER JOIN room_members rm ON rm.client_id = ps.client_id
        WHERE rm.room_id = $1
        ORDER BY ps.updated_at DESC`,
        [roomId]
      );
      return result.rows.map(mapPushSubscription);
    } catch (error) {
      this.logger.error('Error reading PostgreSQL room push subscriptions', { error, roomId });
      return [];
    }
  }

  async getAccountByClientId(clientId: string): Promise<ClientAccount | null> {
    try {
      const result = await this.pool.query<ClientAccountRow>(
        `SELECT ${ACCOUNT_SELECT_COLUMNS}
        FROM client_account_links cal
        INNER JOIN accounts a ON a.id = cal.account_id
        LEFT JOIN account_identities google_identity
          ON google_identity.account_id = a.id
          AND google_identity.provider = 'google'
        WHERE cal.client_id = $1
        LIMIT 1`,
        [clientId]
      );
      return result.rows[0] ? mapClientAccount(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL account by client ID', { error, clientId });
      throw error;
    }
  }

  async getAccountByGoogleSubject(providerSubject: string): Promise<ClientAccount | null> {
    try {
      const result = await this.pool.query<ClientAccountRow>(
        `SELECT ${ACCOUNT_SELECT_COLUMNS}
        FROM account_identities matched_identity
        INNER JOIN accounts a ON a.id = matched_identity.account_id
        LEFT JOIN account_identities google_identity
          ON google_identity.account_id = a.id
          AND google_identity.provider = 'google'
        WHERE matched_identity.provider = 'google'
          AND matched_identity.provider_subject = $1
        LIMIT 1`,
        [providerSubject]
      );
      return result.rows[0] ? mapClientAccount(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL account by Google subject', { error });
      throw error;
    }
  }

  async getAccountRoles(accountId: string): Promise<AccountRole[]> {
    try {
      const result = await this.pool.query<{ role: AccountRole }>(
        `SELECT role
        FROM account_roles
        WHERE account_id = $1
        ORDER BY role`,
        [accountId],
      );
      return result.rows.map(row => row.role);
    } catch (error) {
      this.logger.error('Error reading PostgreSQL account roles', { error, accountId });
      throw error;
    }
  }

  async grantAccountRole(input: GrantAccountRoleInput): Promise<boolean | null> {
    const now = input.now || new Date().toISOString();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const account = await client.query(
        'SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE',
        [input.accountId],
      );
      if (account.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      const inserted = await client.query(
        `INSERT INTO account_roles (
          account_id, role, granted_by_account_id, granted_at
        ) VALUES ($1, $2, $3, $4)
        ON CONFLICT (account_id, role) DO NOTHING
        RETURNING account_id`,
        [input.accountId, input.role, input.grantedByAccountId || null, now],
      );
      if (inserted.rows.length > 0) {
        await client.query(
          `INSERT INTO account_role_events (
            id, account_id, role, action, actor_account_id, metadata, created_at
          ) VALUES ($1, $2, $3, 'grant', $4, $5::jsonb, $6)`,
          [
            input.id,
            input.accountId,
            input.role,
            input.grantedByAccountId || null,
            JSON.stringify(input.metadata || {}),
            now,
          ],
        );
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.logger.error('Error granting PostgreSQL account role', {
        error,
        accountId: input.accountId,
        role: input.role,
      });
      throw error;
    } finally {
      client.release();
    }
  }

  async createPasswordAccountForClient(input: CreatePasswordAccountInput): Promise<ClientAccount | null> {
    const now = input.now || new Date().toISOString();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<{ account_id: string }>(
        `SELECT account_id
        FROM client_account_links
        WHERE client_id = $1
        FOR UPDATE`,
        [input.clientId],
      );
      const accountId = existing.rows[0]?.account_id || input.accountId;
      if (!existing.rows[0]) {
        await client.query(
          `INSERT INTO accounts (
            id, primary_client_id, created_at, updated_at, last_login_at
          ) VALUES ($1, $2, $3, $3, $3)`,
          [accountId, input.clientId, now],
        );
        await client.query(
          `INSERT INTO client_account_links (client_id, account_id, linked_at)
          VALUES ($1, $2, $3)`,
          [input.clientId, accountId, now],
        );
      }
      await client.query(
        `INSERT INTO account_identities (
          account_id, provider, provider_subject, created_at, updated_at
        ) VALUES ($1, 'password', $2, $3, $3)
        ON CONFLICT (provider, provider_subject) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          updated_at = EXCLUDED.updated_at`,
        [accountId, input.clientId, now],
      );
      await client.query(
        `INSERT INTO account_memberships (account_id, created_at, updated_at)
        VALUES ($1, $2, $2)
        ON CONFLICT (account_id) DO NOTHING`,
        [accountId, now],
      );
      await client.query(
        `INSERT INTO account_credit_balances (account_id, updated_at)
        VALUES ($1, $2)
        ON CONFLICT (account_id) DO NOTHING`,
        [accountId, now],
      );
      await client.query('COMMIT');
      return this.getAccountByClientId(input.clientId);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.logger.error('Error creating PostgreSQL password account', { error, clientId: input.clientId });
      return null;
    } finally {
      client.release();
    }
  }

  async setPasswordAccountCredentials(
    input: SetPasswordAccountCredentialsInput,
  ): Promise<ClientAccount | null> {
    if (
      !input.passwordHash
      || input.authToken.clientId !== input.clientId
      || input.authToken.accountId !== input.accountId
      || input.authToken.authMethod !== 'password'
    ) {
      throw new Error('Password account credentials do not match their account and client');
    }
    const now = input.now || input.authToken.createdAt;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<{ account_id: string }>(
        `SELECT account_id
        FROM client_account_links
        WHERE client_id = $1
        FOR UPDATE`,
        [input.clientId],
      );
      const accountId = existing.rows[0]?.account_id || input.accountId;
      if (existing.rows[0] && accountId !== input.accountId) {
        throw new Error('Password credential update targeted a different account');
      }
      if (!existing.rows[0]) {
        await client.query(
          `INSERT INTO accounts (
            id, primary_client_id, created_at, updated_at, last_login_at
          ) VALUES ($1, $2, $3, $3, $3)`,
          [accountId, input.clientId, now],
        );
        await client.query(
          `INSERT INTO client_account_links (client_id, account_id, linked_at)
          VALUES ($1, $2, $3)`,
          [input.clientId, accountId, now],
        );
      } else {
        await client.query(
          `UPDATE accounts
          SET updated_at = $2::timestamptz,
            last_login_at = $2::timestamptz
          WHERE id = $1`,
          [accountId, now],
        );
      }
      await client.query(
        `INSERT INTO account_identities (
          account_id, provider, provider_subject, created_at, updated_at
        ) VALUES ($1, 'password', $2, $3, $3)
        ON CONFLICT (provider, provider_subject) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          updated_at = EXCLUDED.updated_at`,
        [accountId, input.clientId, now],
      );
      await client.query(
        `INSERT INTO account_memberships (account_id, created_at, updated_at)
        VALUES ($1, $2, $2)
        ON CONFLICT (account_id) DO NOTHING`,
        [accountId, now],
      );
      await client.query(
        `INSERT INTO account_credit_balances (account_id, updated_at)
        VALUES ($1, $2)
        ON CONFLICT (account_id) DO NOTHING`,
        [accountId, now],
      );
      await client.query(
        `INSERT INTO client_passwords (client_id, password_hash, created_at, updated_at)
        VALUES ($1, $2, $3, $3)
        ON CONFLICT (client_id) DO UPDATE SET
          password_hash = EXCLUDED.password_hash,
          updated_at = EXCLUDED.updated_at`,
        [input.clientId, input.passwordHash, now],
      );
      await client.query(
        'DELETE FROM client_auth_tokens WHERE client_id = $1',
        [input.clientId],
      );
      await client.query(
        `INSERT INTO client_auth_tokens (
          token_hash, client_id, account_id, auth_method,
          created_at, last_used_at, expires_at
        ) VALUES ($1, $2, $3, 'password', $4, $4, $5)`,
        [
          input.authToken.tokenHash,
          input.clientId,
          accountId,
          input.authToken.createdAt,
          input.authToken.expiresAt || null,
        ],
      );
      await client.query('COMMIT');
      return this.getAccountByClientId(input.clientId);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.logger.error('Error setting atomic PostgreSQL password account credentials', {
        error,
        clientId: input.clientId,
        accountId: input.accountId,
      });
      throw error;
    } finally {
      client.release();
    }
  }

  async createGoogleAccountForClient(input: CreateGoogleAccountInput): Promise<ClientAccount | null> {
    const now = input.now || new Date().toISOString();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<{ account_id: string }>(
        `SELECT account_id
        FROM client_account_links
        WHERE client_id = $1
        FOR UPDATE`,
        [input.clientId],
      );
      const accountId = existing.rows[0]?.account_id || input.accountId;
      if (!existing.rows[0]) {
        await client.query(
          `INSERT INTO accounts (id, primary_client_id, display_name, avatar_url, created_at, updated_at, last_login_at)
          VALUES ($1, $2, $3, $4, $5, $5, $5)`,
          [
            accountId,
            input.clientId,
            input.displayName || null,
            input.avatarUrl || null,
            now,
          ],
        );
        await client.query(
          `INSERT INTO client_account_links (client_id, account_id, linked_at)
          VALUES ($1, $2, $3)`,
          [input.clientId, accountId, now],
        );
      } else {
        await client.query(
          `UPDATE accounts
          SET display_name = COALESCE($2, display_name),
            avatar_url = COALESCE($3, avatar_url),
            updated_at = $4,
            last_login_at = $4
          WHERE id = $1`,
          [accountId, input.displayName || null, input.avatarUrl || null, now],
        );
      }
      await client.query(
        `INSERT INTO account_identities (account_id, provider, provider_subject, email, email_verified, created_at, updated_at)
        VALUES ($1, 'google', $2, $3, $4, $5, $5)`,
        [
          accountId,
          input.providerSubject,
          input.email || null,
          Boolean(input.emailVerified),
          now,
        ]
      );
      await client.query(
        `INSERT INTO account_memberships (account_id, created_at, updated_at)
        VALUES ($1, $2, $2)
        ON CONFLICT (account_id) DO NOTHING`,
        [accountId, now],
      );
      await client.query(
        `INSERT INTO account_credit_balances (account_id, updated_at)
        VALUES ($1, $2)
        ON CONFLICT (account_id) DO NOTHING`,
        [accountId, now],
      );
      await client.query('COMMIT');
      return this.getAccountByClientId(input.clientId);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.logger.error('Error creating PostgreSQL Google account', { error, clientId: input.clientId });
      if ((error as { code?: string })?.code === '23505') {
        const racedAccount = await this.getAccountByGoogleSubject(input.providerSubject);
        if (racedAccount) return racedAccount;
        return null;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateGoogleAccountLogin(accountId: string, profile: GoogleAccountProfile, now = new Date().toISOString()): Promise<ClientAccount | null> {
    try {
      await this.pool.query(
        `UPDATE accounts
        SET display_name = COALESCE($2, display_name),
            avatar_url = COALESCE($3, avatar_url),
            updated_at = $4,
            last_login_at = $4
        WHERE id = $1`,
        [accountId, profile.displayName || null, profile.avatarUrl || null, now]
      );
      await this.pool.query(
        `UPDATE account_identities
        SET email = COALESCE($2, email),
            email_verified = $3,
            updated_at = $4
        WHERE account_id = $1 AND provider = 'google' AND provider_subject = $5`,
        [
          accountId,
          profile.email || null,
          Boolean(profile.emailVerified),
          now,
          profile.providerSubject,
        ]
      );
      const result = await this.pool.query<ClientAccountRow>(
        `SELECT ${ACCOUNT_SELECT_COLUMNS}
        FROM accounts a
        LEFT JOIN account_identities google_identity
          ON google_identity.account_id = a.id
          AND google_identity.provider = 'google'
        WHERE a.id = $1
        LIMIT 1`,
        [accountId]
      );
      return result.rows[0] ? mapClientAccount(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error updating PostgreSQL Google account login', { error, accountId });
      throw error;
    }
  }

  private async getAccountEntitlementByAccountId(accountId: string): Promise<AccountEntitlement | null> {
    const result = await this.pool.query<AccountEntitlementRow>(
      `SELECT membership.account_id,
        membership.tier,
        membership.status,
        membership.priority_override,
        membership.current_period_start,
        membership.current_period_end,
        membership.external_provider,
        balance.available_usd,
        balance.lifetime_usage_usd,
        GREATEST(membership.updated_at, balance.updated_at) AS updated_at
      FROM account_memberships AS membership
      JOIN account_credit_balances AS balance
        ON balance.account_id = membership.account_id
      WHERE membership.account_id = $1
      LIMIT 1`,
      [accountId],
    );
    return result.rows[0] ? mapAccountEntitlement(result.rows[0]) : null;
  }

  async getAccountEntitlementByClientId(clientId: string): Promise<AccountEntitlement | null> {
    try {
      const result = await this.pool.query<AccountEntitlementRow>(
        `SELECT membership.account_id,
          membership.tier,
          membership.status,
          membership.priority_override,
          membership.current_period_start,
          membership.current_period_end,
          membership.external_provider,
          balance.available_usd,
          balance.lifetime_usage_usd,
          GREATEST(membership.updated_at, balance.updated_at) AS updated_at
        FROM client_account_links AS link
        JOIN account_memberships AS membership
          ON membership.account_id = link.account_id
        JOIN account_credit_balances AS balance
          ON balance.account_id = link.account_id
        WHERE link.client_id = $1
        LIMIT 1`,
        [clientId],
      );
      return result.rows[0] ? mapAccountEntitlement(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL account entitlement', { error, clientId });
      throw error;
    }
  }

  async updateAccountMembership(input: UpdateAccountMembershipInput): Promise<AccountEntitlement | null> {
    const now = input.now || new Date().toISOString();
    try {
      const updated = await this.transaction(async client => {
        const result = await client.query(
          `INSERT INTO account_memberships (
            account_id,
            tier,
            status,
            priority_override,
            current_period_start,
            current_period_end,
            external_provider,
            external_customer_id,
            external_subscription_id,
            created_at,
            updated_at
          )
          SELECT
            account.id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10
          FROM accounts AS account
          WHERE account.id = $1
          ON CONFLICT (account_id) DO UPDATE SET
            tier = EXCLUDED.tier,
            status = EXCLUDED.status,
            priority_override = EXCLUDED.priority_override,
            current_period_start = EXCLUDED.current_period_start,
            current_period_end = EXCLUDED.current_period_end,
            external_provider = EXCLUDED.external_provider,
            external_customer_id = EXCLUDED.external_customer_id,
            external_subscription_id = EXCLUDED.external_subscription_id,
            updated_at = EXCLUDED.updated_at`,
          [
            input.accountId,
            input.tier,
            input.status,
            input.priorityOverride ?? null,
            input.currentPeriodStart ?? null,
            input.currentPeriodEnd ?? null,
            input.externalProvider ?? null,
            input.externalCustomerId ?? null,
            input.externalSubscriptionId ?? null,
            now,
          ],
        );
        if ((result.rowCount || 0) === 0) return false;
        await client.query(
          `INSERT INTO account_credit_balances (account_id, updated_at)
          VALUES ($1, $2)
          ON CONFLICT (account_id) DO NOTHING`,
          [input.accountId, now],
        );
        return true;
      });
      if (!updated) return null;
      return this.getAccountEntitlementByAccountId(input.accountId);
    } catch (error) {
      this.logger.error('Error updating PostgreSQL account membership', { error, accountId: input.accountId });
      throw error;
    }
  }

  async applyAccountMembershipChange(
    input: AccountMembershipChangeInput,
  ): Promise<AccountEntitlement | null> {
    if (!input.id || !input.idempotencyKey) {
      throw new Error('Membership change requires an id and idempotency key');
    }
    if (
      input.creditGrantUsd !== undefined
      && (
        !Number.isFinite(input.creditGrantUsd)
        || input.creditGrantUsd <= 0
        || input.creditGrantUsd > 999_999_999
      )
    ) {
      throw new Error('Membership credit grant must be a positive bounded USD value');
    }
    const now = input.now || new Date().toISOString();
    const requestFingerprint = fingerprintAccountMembershipChange(input);
    try {
      return await this.transaction(async client => {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          [`membership:${input.idempotencyKey}`],
        );
        const existingEvent = await client.query<{
          request_fingerprint: string;
          entitlement_snapshot: AccountEntitlement;
        }>(
          `SELECT request_fingerprint, entitlement_snapshot
          FROM account_membership_events
          WHERE idempotency_key = $1
          LIMIT 1`,
          [input.idempotencyKey],
        );
        if (existingEvent.rows[0]) {
          if (existingEvent.rows[0].request_fingerprint !== requestFingerprint) {
            throw new Error('Membership idempotency key is already bound to a different change');
          }
          return existingEvent.rows[0].entitlement_snapshot;
        }

        const membershipResult = await client.query(
          `INSERT INTO account_memberships (
            account_id,
            tier,
            status,
            priority_override,
            current_period_start,
            current_period_end,
            external_provider,
            external_customer_id,
            external_subscription_id,
            created_at,
            updated_at
          )
          SELECT
            account.id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10
          FROM accounts AS account
          WHERE account.id = $1
          ON CONFLICT (account_id) DO UPDATE SET
            tier = EXCLUDED.tier,
            status = EXCLUDED.status,
            priority_override = EXCLUDED.priority_override,
            current_period_start = EXCLUDED.current_period_start,
            current_period_end = EXCLUDED.current_period_end,
            external_provider = EXCLUDED.external_provider,
            external_customer_id = EXCLUDED.external_customer_id,
            external_subscription_id = EXCLUDED.external_subscription_id,
            updated_at = EXCLUDED.updated_at`,
          [
            input.accountId,
            input.tier,
            input.status,
            input.priorityOverride ?? null,
            input.currentPeriodStart ?? null,
            input.currentPeriodEnd ?? null,
            input.externalProvider ?? null,
            input.externalCustomerId ?? null,
            input.externalSubscriptionId ?? null,
            now,
          ],
        );
        if ((membershipResult.rowCount || 0) === 0) return null;

        await client.query(
          `INSERT INTO account_credit_balances (account_id, updated_at)
          VALUES ($1, $2)
          ON CONFLICT (account_id) DO NOTHING`,
          [input.accountId, now],
        );
        const balanceResult = await client.query<{ available_usd: string | number }>(
          `SELECT available_usd
          FROM account_credit_balances
          WHERE account_id = $1
          FOR UPDATE`,
          [input.accountId],
        );
        if (!balanceResult.rows[0]) {
          throw new Error(`Account ${input.accountId} has no credit balance`);
        }

        if (input.creditGrantUsd !== undefined) {
          const existingCredit = await client.query<{
            account_id: string;
            amount_usd: string | number;
          }>(
            `SELECT account_id, amount_usd
            FROM account_credit_ledger
            WHERE idempotency_key = $1
            LIMIT 1`,
            [input.idempotencyKey],
          );
          if (existingCredit.rows[0]) {
            if (
              existingCredit.rows[0].account_id !== input.accountId
              || Math.abs(Number(existingCredit.rows[0].amount_usd) - input.creditGrantUsd) >= 0.0000000005
            ) {
              throw new Error('Membership credit idempotency key is already bound to a different grant');
            }
          } else {
            const currentBalance = Number(balanceResult.rows[0].available_usd) || 0;
            const nextBalance = currentBalance + input.creditGrantUsd;
            await client.query(
              `INSERT INTO account_credit_ledger (
                id,
                account_id,
                kind,
                amount_usd,
                balance_after_usd,
                idempotency_key,
                note,
                metadata,
                created_at
              ) VALUES ($1, $2, 'grant', $3, $4, $5, $6, $7::jsonb, $8)`,
              [
                `membership-credit:${input.id}`,
                input.accountId,
                input.creditGrantUsd,
                nextBalance,
                input.idempotencyKey,
                input.creditNote || null,
                toJsonb(input.metadata || {}),
                now,
              ],
            );
            await client.query(
              `UPDATE account_credit_balances
              SET available_usd = $2,
                updated_at = $3
              WHERE account_id = $1`,
              [input.accountId, nextBalance, now],
            );
          }
        }

        const entitlementResult = await client.query<AccountEntitlementRow>(
          `SELECT membership.account_id,
            membership.tier,
            membership.status,
            membership.priority_override,
            membership.current_period_start,
            membership.current_period_end,
            membership.external_provider,
            balance.available_usd,
            balance.lifetime_usage_usd,
            GREATEST(membership.updated_at, balance.updated_at) AS updated_at
          FROM account_memberships AS membership
          JOIN account_credit_balances AS balance
            ON balance.account_id = membership.account_id
          WHERE membership.account_id = $1
          LIMIT 1`,
          [input.accountId],
        );
        if (!entitlementResult.rows[0]) {
          throw new Error('Membership change did not produce an entitlement');
        }
        const entitlement = mapAccountEntitlement(entitlementResult.rows[0]);
        await client.query(
          `INSERT INTO account_membership_events (
            id,
            account_id,
            idempotency_key,
            request_fingerprint,
            tier,
            status,
            credit_grant_usd,
            entitlement_snapshot,
            metadata,
            created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
          [
            input.id,
            input.accountId,
            input.idempotencyKey,
            requestFingerprint,
            input.tier,
            input.status,
            input.creditGrantUsd || 0,
            toJsonb(entitlement),
            toJsonb(input.metadata || {}),
            now,
          ],
        );
        return entitlement;
      });
    } catch (error) {
      this.logger.error('Error applying atomic PostgreSQL account membership change', {
        error,
        accountId: input.accountId,
        idempotencyKey: input.idempotencyKey,
      });
      throw error;
    }
  }

  async grantAccountCredits(input: AccountCreditGrantInput): Promise<AccountEntitlement | null> {
    if (!Number.isFinite(input.amountUsd) || input.amountUsd <= 0) {
      throw new Error('Credit grant amount must be a positive USD value');
    }
    const now = input.now || new Date().toISOString();
    await this.transaction(async client => {
      // Serialize concurrent webhook retries for the same idempotency key so
      // every caller observes the first committed grant instead of racing the
      // unique index and receiving a spurious failure.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [input.idempotencyKey],
      );
      const existing = await client.query<{ account_id: string; amount_usd: number | string }>(
        `SELECT account_id, amount_usd
        FROM account_credit_ledger
        WHERE idempotency_key = $1
        LIMIT 1`,
        [input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].account_id !== input.accountId) {
          throw new Error('Credit idempotency key is already bound to another account');
        }
        if (Math.abs(Number(existing.rows[0].amount_usd) - input.amountUsd) >= 0.0000000005) {
          throw new Error('Credit idempotency key is already bound to another amount');
        }
        return;
      }

      const balance = await client.query<{ available_usd: number | string }>(
        `SELECT available_usd
        FROM account_credit_balances
        WHERE account_id = $1
        FOR UPDATE`,
        [input.accountId],
      );
      if (!balance.rows[0]) {
        throw new Error(`Account ${input.accountId} has no credit balance`);
      }
      const currentBalance = Number(balance.rows[0].available_usd) || 0;
      const nextBalance = currentBalance + input.amountUsd;
      await client.query(
        `INSERT INTO account_credit_ledger (
          id,
          account_id,
          kind,
          amount_usd,
          balance_after_usd,
          idempotency_key,
          note,
          metadata,
          created_at
        ) VALUES ($1, $2, 'grant', $3, $4, $5, $6, $7::jsonb, $8)`,
        [
          input.id,
          input.accountId,
          input.amountUsd,
          nextBalance,
          input.idempotencyKey,
          input.note || null,
          toJsonb(input.metadata || {}),
          now,
        ],
      );
      await client.query(
        `UPDATE account_credit_balances
        SET available_usd = $2,
          updated_at = $3
        WHERE account_id = $1`,
        [input.accountId, nextBalance, now],
      );
    });
    return this.getAccountEntitlementByAccountId(input.accountId);
  }

  async settleAccountAIUsage(input: AccountAIUsageInput): Promise<AccountAIUsageSettlement | null> {
    if (!Number.isFinite(input.costUsd) || input.costUsd <= 0 || input.costUsd > 999_999_999) {
      throw new Error('Account AI usage cost must be a positive bounded USD value');
    }
    if (!input.id || !input.clientId || !input.provider || !input.modelId) {
      throw new Error('Account AI usage requires an id, client, provider, and model');
    }
    const now = input.now || new Date().toISOString();
    return this.transaction(async client => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [input.id],
      );
      const accountLink = await client.query<{ account_id: string }>(
        `SELECT account_id
        FROM client_account_links
        WHERE client_id = $1
        LIMIT 1`,
        [input.clientId],
      );
      const accountId = accountLink.rows[0]?.account_id;
      if (!accountId) return null;

      const existing = await client.query<{
        account_id: string;
        source: AccountAIUsageInput['source'];
        cost_usd: number | string;
        credit_applied_usd: number | string;
        membership_tier: MembershipTier;
        provider: string;
        model_id: string;
      }>(
        `SELECT account_id, source, cost_usd, credit_applied_usd,
          membership_tier, provider, model_id
        FROM account_ai_usage_events
        WHERE assistant_run_id = $1
        LIMIT 1`,
        [input.id],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (
          row.account_id !== accountId
          || row.source !== input.source
          || row.provider !== input.provider
          || row.model_id !== input.modelId
          || Math.abs(Number(row.cost_usd) - input.costUsd) >= 0.0000000005
        ) {
          throw new Error('Account AI usage id is already bound to different usage');
        }
        const balance = await client.query<{ available_usd: number | string }>(
          `SELECT available_usd
          FROM account_credit_balances
          WHERE account_id = $1`,
          [accountId],
        );
        if (!balance.rows[0]) {
          throw new Error(`Account ${accountId} has no credit balance`);
        }
        return {
          accountId,
          membershipTier: row.membership_tier,
          costUsd: Number(row.cost_usd),
          creditAppliedUsd: Number(row.credit_applied_usd),
          creditBalanceUsd: Number(balance.rows[0].available_usd),
          duplicate: true,
        };
      }

      const entitlement = await client.query<{
        tier: MembershipTier;
        status: MembershipStatus;
        available_usd: number | string;
      }>(
        `SELECT membership.tier, membership.status, balance.available_usd
        FROM account_memberships AS membership
        JOIN account_credit_balances AS balance
          ON balance.account_id = membership.account_id
        WHERE membership.account_id = $1
        FOR UPDATE OF membership, balance`,
        [accountId],
      );
      if (!entitlement.rows[0]) {
        throw new Error(`Account ${accountId} has no membership or credit balance`);
      }
      const membershipTier = resolveEffectiveMembershipTier(
        entitlement.rows[0].tier,
        entitlement.rows[0].status,
      );
      const availableUsd = Number(entitlement.rows[0].available_usd) || 0;
      const creditAppliedUsd = Math.min(availableUsd, input.costUsd);
      await client.query(
        `INSERT INTO account_ai_usage_events (
          assistant_run_id,
          account_id,
          cost_usd,
          credit_applied_usd,
          membership_tier,
          provider,
          model_id,
          source,
          room_id,
          turn_id,
          message_id,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz)`,
        [
          input.id,
          accountId,
          input.costUsd,
          creditAppliedUsd,
          membershipTier,
          input.provider,
          input.modelId,
          input.source,
          input.roomId || null,
          input.turnId || null,
          input.messageId || null,
          now,
        ],
      );
      const updatedBalance = await client.query<{ available_usd: number | string }>(
        `UPDATE account_credit_balances
        SET available_usd = GREATEST(0, available_usd - $2),
          lifetime_usage_usd = lifetime_usage_usd + $3,
          updated_at = $4::timestamptz
        WHERE account_id = $1
        RETURNING available_usd`,
        [accountId, creditAppliedUsd, input.costUsd, now],
      );
      if (!updatedBalance.rows[0]) {
        throw new Error(`Account ${accountId} lost its credit balance during usage settlement`);
      }
      return {
        accountId,
        membershipTier,
        costUsd: input.costUsd,
        creditAppliedUsd,
        creditBalanceUsd: Number(updatedBalance.rows[0].available_usd),
        duplicate: false,
      };
    });
  }

  async setClientPasswordHash(clientId: string, passwordHash: string): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO client_passwords (client_id, password_hash, created_at, updated_at)
        VALUES ($1, $2, NOW(), NOW())
        ON CONFLICT (client_id) DO UPDATE SET
          password_hash = EXCLUDED.password_hash,
          updated_at = EXCLUDED.updated_at`,
        [clientId, passwordHash]
      );
    } catch (error) {
      this.logger.error('Error setting PostgreSQL client password hash', { error, clientId });
      throw error;
    }
  }

  async getClientPasswordHash(clientId: string): Promise<string | null> {
    try {
      const result = await this.pool.query<{ password_hash: string }>(
        'SELECT password_hash FROM client_passwords WHERE client_id = $1',
        [clientId]
      );
      return result.rows[0]?.password_hash || null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL client password hash', { error, clientId });
      throw error;
    }
  }

  async saveClientAuthToken(token: ClientAuthTokenRecord): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO client_auth_tokens (token_hash, client_id, account_id, auth_method, created_at, last_used_at, expires_at)
        VALUES ($1, $2, $3, $4, $5, $5, $6)
        ON CONFLICT (token_hash) DO UPDATE SET
          client_id = EXCLUDED.client_id,
          account_id = EXCLUDED.account_id,
          auth_method = EXCLUDED.auth_method,
          last_used_at = EXCLUDED.last_used_at,
          expires_at = EXCLUDED.expires_at`,
        [
          token.tokenHash,
          token.clientId,
          token.accountId || null,
          token.authMethod || null,
          token.createdAt,
          token.expiresAt || null,
        ]
      );
    } catch (error) {
      this.logger.error('Error saving PostgreSQL client auth token', { error, clientId: token.clientId });
      throw error;
    }
  }

  async isClientAuthTokenValid(clientId: string, tokenHash: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        `UPDATE client_auth_tokens
        SET last_used_at = NOW()
        WHERE client_id = $1
          AND token_hash = $2
          AND (expires_at IS NULL OR expires_at > NOW())`,
        [clientId, tokenHash]
      );
      return (result.rowCount || 0) > 0;
    } catch (error) {
      this.logger.error('Error checking PostgreSQL client auth token', { error, clientId });
      throw error;
    }
  }

  async deleteClientAuthToken(clientId: string, tokenHash: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        'DELETE FROM client_auth_tokens WHERE client_id = $1 AND token_hash = $2',
        [clientId, tokenHash]
      );
      return (result.rowCount || 0) > 0;
    } catch (error) {
      this.logger.error('Error deleting PostgreSQL client auth token', { error, clientId });
      throw error;
    }
  }

  async deleteClientAuthTokens(clientId: string): Promise<void> {
    try {
      await this.pool.query('DELETE FROM client_auth_tokens WHERE client_id = $1', [clientId]);
    } catch (error) {
      this.logger.error('Error deleting PostgreSQL client auth tokens', { error, clientId });
      throw error;
    }
  }

  async readRoomPasswordHash(roomId: string): Promise<string | null> {
    try {
      const result = await this.pool.query<{ password_hash: string | null }>(
        'SELECT password_hash FROM rooms WHERE id = $1',
        [roomId]
      );
      return result.rows[0]?.password_hash || null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL room password hash', { error, roomId });
      return null;
    }
  }

  async updateRoomSettings(roomId: string, updates: RoomSettingsUpdate): Promise<Room | null> {
    const hasPasswordHashUpdate = Object.prototype.hasOwnProperty.call(updates, 'passwordHash');
    const hasPostingScheduleUpdate = Object.prototype.hasOwnProperty.call(updates, 'postingSchedule');
    const hasCodeAgentAccessUpdate = Object.prototype.hasOwnProperty.call(updates, 'codeAgentAccess');
    const hasCodeAgentModeUpdate = Object.prototype.hasOwnProperty.call(updates, 'codeAgentMode');
    const hasCodeAgentBackendUpdate = Object.prototype.hasOwnProperty.call(updates, 'codeAgentBackend');

    try {
      const result = await this.pool.query<RoomRow>(
        `UPDATE rooms
        SET password_hash = CASE WHEN $2::boolean THEN $3 ELSE password_hash END,
          posting_schedule = CASE WHEN $4::boolean THEN $5::jsonb ELSE posting_schedule END,
          code_agent_access = CASE WHEN $6::boolean THEN $7 ELSE code_agent_access END,
          code_agent_mode = CASE WHEN $8::boolean THEN $9 ELSE code_agent_mode END,
          code_agent_backend = CASE WHEN $10::boolean THEN $11 ELSE code_agent_backend END,
          updated_at = NOW()
        WHERE id = $1
        RETURNING ${ROOM_COLUMNS}`,
        [
          roomId,
          hasPasswordHashUpdate,
          updates.passwordHash ?? null,
          hasPostingScheduleUpdate,
          toJsonb(updates.postingSchedule ?? null),
          hasCodeAgentAccessUpdate,
          updates.codeAgentAccess ?? null,
          hasCodeAgentModeUpdate,
          updates.codeAgentMode ?? null,
          hasCodeAgentBackendUpdate,
          updates.codeAgentBackend ?? null,
        ]
      );
      return result.rows[0] ? mapRoom(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error updating PostgreSQL room settings', { error, roomId });
      return null;
    }
  }

  async updateRoomMemberRole(roomId: string, clientId: string, role: RoomMemberRole, joinedAt = new Date().toISOString()): Promise<RoomMember | null> {
    try {
      const result = await this.pool.query<RoomMemberRow>(
        `INSERT INTO room_members (room_id, client_id, role, joined_at)
        SELECT id, $2, $3, $4
        FROM rooms
        WHERE id = $1
        ON CONFLICT (room_id, client_id) DO UPDATE SET
          role = EXCLUDED.role
        RETURNING ${ROOM_MEMBER_COLUMNS}`,
        [roomId, clientId, role, joinedAt]
      );
      return result.rows[0] ? mapRoomMember(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error updating PostgreSQL room member role', { error, roomId, clientId, role });
      return null;
    }
  }

  async transferRoomOwnership(
    roomId: string,
    newOwnerClientId: string,
    previousOwnerRole: Exclude<RoomMemberRole, 'owner'> = 'admin',
  ): Promise<Room | null> {
    try {
      return await this.transaction(async client => {
        const roomResult = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [roomId]
        );
        if (roomResult.rows.length === 0) {
          return null;
        }

        const previousOwnerId = roomResult.rows[0].creator_id;

        await client.query(
          `UPDATE room_members
          SET role = $3
          WHERE room_id = $1 AND client_id = $2`,
          [roomId, previousOwnerId, previousOwnerRole]
        );

        await client.query(
          `INSERT INTO room_members (room_id, client_id, role, joined_at)
          VALUES ($1, $2, 'owner', NOW())
          ON CONFLICT (room_id, client_id) DO UPDATE SET
            role = 'owner'`,
          [roomId, newOwnerClientId]
        );

        const updated = await client.query<RoomRow>(
          `UPDATE rooms
          SET creator_id = $2, updated_at = NOW()
          WHERE id = $1
          RETURNING ${ROOM_COLUMNS}`,
          [roomId, newOwnerClientId]
        );
        return updated.rows[0] ? mapRoom(updated.rows[0]) : null;
      });
    } catch (error) {
      this.logger.error('Error transferring PostgreSQL room ownership', { error, roomId, newOwnerClientId });
      return null;
    }
  }

  async setClientNickname(clientId: string, nickname: string): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO client_profiles (client_id, nickname, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (client_id) DO UPDATE SET
          nickname = EXCLUDED.nickname,
          updated_at = EXCLUDED.updated_at`,
        [clientId, nickname]
      );
    } catch (error) {
      this.logger.error('Error setting PostgreSQL client nickname', { error, clientId });
    }
  }

  async getClientNicknames(clientIds: string[]): Promise<Record<string, string>> {
    if (clientIds.length === 0) {
      return {};
    }
    try {
      const result = await this.pool.query<{ client_id: string; nickname: string }>(
        'SELECT client_id, nickname FROM client_profiles WHERE client_id = ANY($1)',
        [clientIds]
      );
      const nicknames: Record<string, string> = {};
      for (const row of result.rows) {
        nicknames[row.client_id] = row.nickname;
      }
      return nicknames;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL client nicknames', { error });
      return {};
    }
  }

  async readRoomsByUser(clientId: string): Promise<Room[]> {
    try {
      const result = await this.pool.query<RoomRow>(
        `SELECT ${ROOM_COLUMNS}
        FROM rooms
        WHERE creator_id = $1
        ORDER BY last_activity_at DESC, created_at DESC`,
        [clientId]
      );
      return result.rows.map(mapRoom);
    } catch (error) {
      this.logger.error('Error reading PostgreSQL rooms for user', { error, clientId });
      return [];
    }
  }

  async saveRoomForUser(roomId: string, clientId: string, savedAt = new Date().toISOString()): Promise<Room | null> {
    try {
      const result = await this.pool.query<{ room_id: string }>(
        `INSERT INTO room_saves (room_id, client_id, saved_at)
        SELECT id, $2, $3
        FROM rooms
        WHERE id = $1
        ON CONFLICT (room_id, client_id) DO UPDATE SET
          saved_at = EXCLUDED.saved_at
        RETURNING room_id`,
        [roomId, clientId, savedAt]
      );

      if (!result.rows[0]) {
        return null;
      }

      return this.getRoomById(roomId);
    } catch (error) {
      this.logger.error('Error saving PostgreSQL room for user', { error, roomId, clientId });
      return null;
    }
  }

  async removeSavedRoomForUser(roomId: string, clientId: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        `DELETE FROM room_saves
        WHERE room_id = $1 AND client_id = $2`,
        [roomId, clientId]
      );
      return (result.rowCount || 0) > 0;
    } catch (error) {
      this.logger.error('Error removing PostgreSQL saved room for user', { error, roomId, clientId });
      return false;
    }
  }

  async readSavedRoomsByUser(clientId: string): Promise<Room[]> {
    try {
      const result = await this.pool.query<RoomRow>(
        `SELECT r.${ROOM_COLUMNS.replace(/, /g, ', r.')}
        FROM rooms r
        INNER JOIN room_saves rs ON rs.room_id = r.id
        WHERE rs.client_id = $1
        ORDER BY rs.saved_at DESC, r.last_activity_at DESC, r.created_at DESC`,
        [clientId]
      );
      return result.rows.map(mapRoom);
    } catch (error) {
      this.logger.error('Error reading PostgreSQL saved rooms for user', { error, clientId });
      return [];
    }
  }

  async getRoomById(roomId: string): Promise<Room | null> {
    try {
      const result = await this.pool.query<RoomRow>(
        `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1`,
        [roomId]
      );
      return result.rows[0] ? mapRoom(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL room by id', { error, roomId });
      return null;
    }
  }

  async updateRoomName(roomId: string, creatorId: string, name: string): Promise<Room | null> {
    try {
      const result = await this.pool.query<RoomRow>(
        `UPDATE rooms
        SET name = $3, updated_at = NOW()
        WHERE id = $1 AND creator_id = $2
        RETURNING ${ROOM_COLUMNS}`,
        [roomId, creatorId, name]
      );
      const updatedRoom = result.rows[0] ? mapRoom(result.rows[0]) : null;
      if (!updatedRoom) {
        this.logger.warn('PostgreSQL room rename skipped because room was missing or unauthorized', { roomId, creatorId });
      }
      return updatedRoom;
    } catch (error) {
      this.logger.error('Error renaming PostgreSQL room', { error, roomId, creatorId });
      return null;
    }
  }

  async deleteRoom(roomId: string, creatorId: string): Promise<boolean> {
    let orphanedObjectKeys: string[] = [];
    let orphanedCheckpointObjectKeys: string[] = [];
    let deleted = false;
    try {
      await this.transaction(async client => {
        // Only the owner may delete; gate the media cleanup on the same check so
        // we never strand objects for a room that wasn't actually removed.
        const owned = await client.query(
          'SELECT 1 FROM rooms WHERE id = $1 AND creator_id = $2',
          [roomId, creatorId]
        );
        if (owned.rows.length === 0) {
          return;
        }

        // Capture keys before deleting the room: the media_assets rows cascade
        // away with it, so we cannot read them afterward.
        const orphaned = await client.query<{ object_key: string }>(
          'DELETE FROM media_assets WHERE room_id = $1 RETURNING object_key',
          [roomId]
        );
        orphanedObjectKeys = orphaned.rows.map(row => row.object_key);
        const checkpoints = await client.query<{ object_key: string }>(
          `SELECT DISTINCT workspace_checkpoint->>'objectKey' AS object_key
          FROM room_agent_turns
          WHERE room_id = $1
            AND workspace_checkpoint->>'objectKey' IS NOT NULL`,
          [roomId],
        );
        orphanedCheckpointObjectKeys = checkpoints.rows.map(row => row.object_key);

        const removed = await client.query('DELETE FROM rooms WHERE id = $1 AND creator_id = $2', [roomId, creatorId]);
        deleted = (removed.rowCount || 0) > 0;
      });

      if (!deleted) {
        return false;
      }
      await this.deleteOrphanedMediaObjects(orphanedObjectKeys);
      await this.deleteOrphanedCheckpointObjects(orphanedCheckpointObjectKeys);
      this.logger.debug('Room deleted from PostgreSQL', { roomId, creatorId });
      return true;
    } catch (error) {
      this.logger.error('Error deleting PostgreSQL room', { error, roomId, creatorId });
      return false;
    }
  }

  async countRooms(): Promise<number> {
    const result = await this.pool.query<{ count: string | number }>('SELECT COUNT(*) AS count FROM rooms');
    const rawCount = result.rows[0]?.count;
    const count = Number.parseInt(String(rawCount), 10);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`PostgreSQL returned an invalid room count: ${String(rawCount)}`);
    }
    return count;
  }

  async compareAndSetRoomSandboxStatus(
    roomId: string,
    expectedStatuses: RoomSandboxStatus[],
    nextStatus: RoomSandboxStatus,
    updatedAt = new Date().toISOString()
  ): Promise<Room | null> {
    if (expectedStatuses.length === 0) {
      return null;
    }

    try {
      const result = await this.pool.query<RoomRow>(
        `UPDATE rooms
        SET sandbox_status = $3,
          sandbox_updated_at = $4::timestamptz,
          updated_at = NOW()
        WHERE id = $1
          AND COALESCE(sandbox_status, 'none') = ANY($2::text[])
        RETURNING ${ROOM_COLUMNS}`,
        [roomId, expectedStatuses, nextStatus, updatedAt]
      );
      return result.rows[0] ? mapRoom(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error comparing and setting PostgreSQL room sandbox status', { error, roomId, expectedStatuses, nextStatus });
      return null;
    }
  }

  async replaceRoomSandbox(
    roomId: string,
    expectedSandboxId: string,
    next: RoomSandboxReplacement
  ): Promise<Room | null> {
    try {
      const result = await this.pool.query<RoomRow>(
        `UPDATE rooms
        SET sandbox_id = $3,
          sandbox_status = $4,
          sandbox_updated_at = $5::timestamptz,
          sandbox_artifact_version = $6,
          sandbox_code_agent_source_ref = $7,
          updated_at = NOW()
        WHERE id = $1
          AND sandbox_id = $2
        RETURNING ${ROOM_COLUMNS}`,
        [
          roomId,
          expectedSandboxId,
          next.sandboxId,
          next.sandboxStatus,
          next.sandboxUpdatedAt,
          next.sandboxArtifactVersion || null,
          next.sandboxCodeAgentSourceRef || null,
        ]
      );
      return result.rows[0] ? mapRoom(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error replacing PostgreSQL room sandbox', { error, roomId, expectedSandboxId, nextSandboxId: next.sandboxId });
      return null;
    }
  }

  async findInterruptedCodeAgentRooms(now = new Date().toISOString()): Promise<Room[]> {
    try {
      const result = await this.pool.query<RoomRow>(
        `SELECT ${ROOM_COLUMNS}
        FROM rooms
        WHERE type = 'codeAgent'
          AND (sandbox_status = 'creating' OR code_agent_status = 'running')
          AND NOT EXISTS (
            SELECT 1 FROM code_agent_room_leases AS lease
            WHERE lease.room_id = rooms.id
              AND lease.expires_at > $1::timestamptz
          )`,
        [now]
      );
      return result.rows.map(mapRoom);
    } catch (error) {
      this.logger.error('Error finding interrupted PostgreSQL code-agent rooms', { error });
      throw error;
    }
  }

  async recoverInterruptedCodeAgentRoomStates(now = new Date().toISOString()): Promise<number> {
    try {
      return await this.transaction(async client => {
        const candidates = await client.query<{ id: string }>(
          `SELECT id
          FROM rooms
          WHERE type = 'codeAgent'
            AND (sandbox_status = 'creating' OR code_agent_status = 'running')
          ORDER BY id
          FOR UPDATE SKIP LOCKED`,
        );
        let recovered = 0;
        for (const candidate of candidates.rows) {
          const lease = await client.query<{ live: boolean }>(
            `SELECT expires_at > $2::timestamptz AS live
            FROM code_agent_room_leases
            WHERE room_id = $1
            FOR UPDATE`,
            [candidate.id, now],
          );
          if (lease.rows[0]?.live) continue;

          await client.query(
            `DELETE FROM code_agent_room_leases
            WHERE room_id = $1
              AND expires_at <= $2::timestamptz`,
            [candidate.id, now],
          );
          const updated = await client.query(
            `UPDATE rooms
            SET sandbox_status = CASE
                  WHEN sandbox_status = 'creating' THEN 'error'
                  ELSE sandbox_status
                END,
              code_agent_status = CASE
                  WHEN code_agent_status = 'running' THEN 'error'
                  ELSE code_agent_status
                END,
              sandbox_updated_at = CASE
                  WHEN sandbox_status = 'creating' THEN $2::timestamptz
                  ELSE sandbox_updated_at
                END,
              updated_at = clock_timestamp()
            WHERE id = $1
              AND (sandbox_status = 'creating' OR code_agent_status = 'running')`,
            [candidate.id, now],
          );
          recovered += updated.rowCount || 0;
        }
        return recovered;
      });
    } catch (error) {
      this.logger.error('Error atomically recovering interrupted PostgreSQL code-agent room states', { error });
      throw error;
    }
  }

  async findDanglingToolCalls(): Promise<Message[]> {
    try {
      const result = await this.pool.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS}
        FROM room_messages call
        WHERE call.message_type = 'tool_call'
          AND call.tool_call_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM room_messages result
            WHERE result.room_id = call.room_id
              AND result.message_type = 'tool_result'
              AND result.tool_call_id = call.tool_call_id
          )
        ORDER BY call.timestamp ASC`
      );
      return result.rows.map(mapMessage);
    } catch (error) {
      this.logger.error('Error finding dangling PostgreSQL tool calls', { error });
      return [];
    }
  }

  async resetAllDataForTests(): Promise<void> {
    await this.pool.query('TRUNCATE ai_stream_owner_leases, github_connections, codex_connections, outbox_events, room_event_pending_changes, room_events, room_event_streams, account_ai_usage_events, assistant_runs, room_ai_cost_totals, audio_transcriptions, pending_media_uploads, media_assets, room_messages, room_saves, room_members, rooms, client_auth_tokens, client_passwords, account_membership_events, account_credit_ledger, account_credit_balances, account_memberships, client_account_links, account_identities, accounts, client_profiles RESTART IDENTITY CASCADE');
  }

  async failInterruptedStreamingMessages(content: string, options: InterruptedStreamingMessageRecoveryOptions = {}): Promise<number> {
    try {
      const result = await this.pool.query(
        `UPDATE room_messages
        SET status = 'error',
          content = $1,
          timestamp = NOW()
        WHERE status = 'streaming'
          AND ($2::text IS NULL OR ai_stream_owner_id = $2)`,
        [content, options.aiStreamOwnerId || null]
      );
      const updatedCount = result.rowCount || 0;
      if (updatedCount > 0) {
        this.logger.warn('Marked interrupted PostgreSQL streaming messages as error', { count: updatedCount, aiStreamOwnerId: options.aiStreamOwnerId });
      }
      return updatedCount;
    } catch (error) {
      this.logger.error('Error marking interrupted PostgreSQL streaming messages', { error });
      return 0;
    }
  }

  async heartbeatAIStreamOwner(ownerId: string, instanceId: string, now: string | undefined, ttlMs: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO ai_stream_owner_leases (owner_id, instance_id, last_heartbeat_at, expires_at)
      VALUES (
        $1,
        $2,
        COALESCE($3::timestamptz, clock_timestamp()),
        COALESCE($3::timestamptz, clock_timestamp()) + ($4::bigint * interval '1 millisecond')
      )
      ON CONFLICT (owner_id) DO UPDATE SET
        instance_id = EXCLUDED.instance_id,
        last_heartbeat_at = EXCLUDED.last_heartbeat_at,
        expires_at = EXCLUDED.expires_at`,
      [ownerId, instanceId, now, ttlMs],
    );
  }

  async releaseAIStreamOwner(ownerId: string): Promise<void> {
    await this.pool.query('DELETE FROM ai_stream_owner_leases WHERE owner_id = $1', [ownerId]);
  }

  async failOrphanedStreamingMessages(content: string, now?: string): Promise<number> {
    const result = await this.pool.query(
      `WITH recovery_clock AS (
        SELECT COALESCE($2::timestamptz, clock_timestamp()) AS now
      )
      UPDATE room_messages AS message
      SET status = 'error',
        content = $1,
        timestamp = recovery_clock.now,
        updated_at = recovery_clock.now,
        is_error = TRUE,
        ai_stream_owner_id = NULL
      FROM recovery_clock
      WHERE message.status = 'streaming'
        AND NOT EXISTS (
          SELECT 1
          FROM assistant_runs AS run
          WHERE run.room_id = message.room_id
            AND run.ai_message_id = message.id
            AND run.status IN ('queued', 'running', 'finalizing')
        )
        AND (
          message.ai_stream_owner_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM ai_stream_owner_leases AS owner
            WHERE owner.owner_id = message.ai_stream_owner_id
              AND owner.expires_at > recovery_clock.now
          )
        )`,
      [content, now],
    );
    await this.pool.query(
      `DELETE FROM ai_stream_owner_leases
      WHERE expires_at <= COALESCE($1::timestamptz, clock_timestamp())
        AND NOT EXISTS (
          SELECT 1 FROM room_messages
          WHERE room_messages.ai_stream_owner_id = ai_stream_owner_leases.owner_id
            AND room_messages.status = 'streaming'
        )`,
      [now],
    );
    return result.rowCount || 0;
  }

  async withMaintenanceLock<T>(lockName: string, operation: () => Promise<T>): Promise<{ acquired: boolean; result?: T }> {
    const client = await this.pool.connect();
    try {
      const lock = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
        [lockName],
      );
      if (!lock.rows[0]?.acquired) return { acquired: false };
      try {
        return { acquired: true, result: await operation() };
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
      }
    } finally {
      client.release();
    }
  }

  private async lockCodeAgentTurnClaim(
    client: PostgresClient,
    claim: CodeAgentTurnClaim,
  ): Promise<boolean> {
    const result = await client.query<{ id: string }>(
      `SELECT turn.id
      FROM room_agent_turns AS turn
      JOIN code_agent_room_leases AS lease
        ON lease.room_id = turn.room_id
        AND lease.turn_id = turn.id
      WHERE turn.id = $1
        AND turn.room_id = $2
        AND turn.status = 'running'
        AND turn.lease_owner = $3
        AND turn.lease_fence = $4
        AND lease.owner_id = $3
        AND lease.fence = $4
        AND lease.expires_at > clock_timestamp()
      FOR UPDATE OF turn, lease`,
      [claim.turnId, claim.roomId, claim.ownerId, claim.fence],
    );
    return Boolean(result.rows[0]);
  }

  private async finalizeAIMessageWithClient(
    client: PostgresClient,
    message: Message,
    expectedOwnership: AIStreamOwnership,
  ): Promise<MessageRow | null> {
    const updated = await client.query<MessageRow>(
      `UPDATE room_messages
      SET content = $4,
        timestamp = $5::timestamptz,
        updated_at = COALESCE($6::timestamptz, $5::timestamptz),
        status = $7,
        is_error = $8,
        ai_model = $9::jsonb,
        usage = $10::jsonb,
        cost = $11::jsonb,
        ui_payload = $12::jsonb,
        model_step_id = $13,
        model_step_sequence = $14,
        ai_stream_owner_id = NULL
      WHERE id = $1
        AND room_id = $2
        AND status = 'streaming'
        AND ai_stream_owner_id IS NOT DISTINCT FROM $3
        AND ai_stream_fence = $15
      RETURNING ${MESSAGE_COLUMNS}`,
      [
        message.id,
        message.roomId,
        expectedOwnership.ownerId,
        message.content,
        message.timestamp,
        message.updatedAt || null,
        message.status,
        message.isError ?? (message.status === 'error'),
        toJsonb(message.aiModel),
        toJsonb(message.usage),
        toJsonb(message.cost),
        toJsonb(message.uiPayload),
        message.modelStepId || null,
        message.modelStepSequence ?? null,
        expectedOwnership.fence,
      ],
    );
    return updated.rows[0] || null;
  }

  private async incrementRoomAICostWithClient(
    client: PostgresClient,
    roomId: string,
    cost?: AICost | null,
  ): Promise<RoomAICostTotal> {
    const totalUsd = Number.isFinite(cost?.totalUsd) && Number(cost?.totalUsd) > 0
      ? Number(cost!.totalUsd)
      : 0;
    if (totalUsd > 0) {
      await client.query(
        `INSERT INTO room_ai_cost_totals (room_id, total_usd, updated_at)
        VALUES ($1, $2, clock_timestamp())
        ON CONFLICT (room_id) DO UPDATE SET
          total_usd = room_ai_cost_totals.total_usd + EXCLUDED.total_usd,
          updated_at = clock_timestamp()`,
        [roomId, totalUsd],
      );
    }
    const result = await client.query<{ total_usd: number | string }>(
      'SELECT total_usd FROM room_ai_cost_totals WHERE room_id = $1',
      [roomId],
    );
    const parsedTotal = Number.parseFloat(String(result.rows[0]?.total_usd || '0'));
    return {
      roomId,
      currency: 'USD',
      totalUsd: Number.isFinite(parsedTotal) ? parsedTotal : 0,
    };
  }

  private async transaction<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async updateRoomLastActivityFromMessages(client: PostgresClient, roomId: string, fallbackTimestamp: string): Promise<Room | null> {
    const latestMessage = await client.query<{ timestamp: string | Date }>(
      'SELECT timestamp FROM room_messages WHERE room_id = $1 ORDER BY timestamp DESC LIMIT 1',
      [roomId]
    );
    const lastActivityAt = latestMessage.rows[0]?.timestamp
      ? toIsoString(latestMessage.rows[0].timestamp)
      : fallbackTimestamp;

    const updatedRoom = await client.query<RoomRow>(
      `UPDATE rooms
      SET last_activity_at = $2,
        updated_at = NOW()
      WHERE id = $1
      RETURNING ${ROOM_COLUMNS}`,
      [roomId, lastActivityAt]
    );
    return updatedRoom.rows[0] ? mapRoom(updatedRoom.rows[0]) : null;
  }

  private async saveMediaAssetWithClient(client: Pick<PostgresPool, 'query'>, asset: MediaAsset): Promise<MediaAsset | null> {
    const result = await client.query<MediaAssetRow>(
      `INSERT INTO media_assets (
        id,
        room_id,
        message_id,
        object_key,
        kind,
        mime_type,
        byte_size,
        filename,
        width,
        height,
        duration_ms,
        uploaded_by_client_id,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (id) DO UPDATE SET
        message_id = EXCLUDED.message_id,
        object_key = EXCLUDED.object_key,
        kind = EXCLUDED.kind,
        mime_type = EXCLUDED.mime_type,
        byte_size = EXCLUDED.byte_size,
        filename = EXCLUDED.filename,
        width = EXCLUDED.width,
        height = EXCLUDED.height,
        duration_ms = EXCLUDED.duration_ms,
        uploaded_by_client_id = EXCLUDED.uploaded_by_client_id
      RETURNING ${MEDIA_ASSET_COLUMNS}`,
      [
        asset.id,
        asset.roomId,
        asset.messageId || null,
        asset.objectKey,
        asset.kind,
        asset.mimeType,
        asset.byteSize,
        asset.filename || null,
        asset.width ?? null,
        asset.height ?? null,
        asset.durationMs ?? null,
        asset.uploadedByClientId || null,
        asset.createdAt,
      ]
    );
    return result.rows[0] ? mapMediaAsset(result.rows[0]) : null;
  }

  private async attachMediaAssets(roomId: string, messages: Message[]): Promise<Message[]> {
    if (!messages.some(message => message.messageType === 'media')) {
      return messages;
    }

    const assets = await this.readMediaAssetsByRoom(roomId);
    if (assets.length === 0) {
      return messages;
    }

    return this.attachMediaAssetsFromAssets(messages, assets);
  }

  private attachMediaAssetsFromAssets(messages: Message[], assets: MediaAsset[]): Message[] {
    const assetsByMessageId = new Map(assets.filter(asset => asset.messageId).map(asset => [asset.messageId!, asset]));
    const assetsById = new Map(assets.map(asset => [asset.id, asset]));

    return messages.map(message => {
      if (message.messageType !== 'media') {
        return message;
      }

      const asset = assetsByMessageId.get(message.id) || assetsById.get(message.content);
      if (!asset) {
        return message;
      }

      return {
        ...message,
        content: message.content || '',
        mimeType: asset.mimeType,
        mediaAsset: toMessageMediaAsset(asset),
      };
    });
  }

  private async readMessagePageWithQueryable(
    queryable: PostgresQueryable,
    roomId: string,
    options: RoomMessagePageOptions,
  ) {
    const limit = normalizeMessagePageLimit(options.limit);
    const room = await queryable.query<RoomRow>(
      `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1`,
      [roomId]
    );
    if (room.rows.length === 0) {
      return { roomId, messages: [], turns: [], hasMore: false };
    }

    let boundaryPosition: number | undefined;
    if (options.beforeMessageId) {
      const target = await queryable.query<{ position: number | string; turn_id: string | null; client_id: string; client_batch_id: string | null }>(
        'SELECT position, turn_id, client_id, client_batch_id FROM room_messages WHERE room_id = $1 AND id = $2',
        [roomId, options.beforeMessageId]
      );
      if (target.rows.length === 0) {
        throw new RoomPaginationBoundaryExpiredError(roomId, options.beforeMessageId);
      }
      boundaryPosition = Number(target.rows[0].position);
      if (target.rows[0].turn_id) {
        const turnStart = await queryable.query<{ position: number | string }>(
          'SELECT MIN(position) AS position FROM room_messages WHERE room_id = $1 AND turn_id = $2',
          [roomId, target.rows[0].turn_id]
        );
        boundaryPosition = Number(turnStart.rows[0]?.position ?? boundaryPosition);
      } else if (target.rows[0].client_batch_id) {
        const batchStart = await queryable.query<{ position: number | string }>(
          'SELECT MIN(position) AS position FROM room_messages WHERE room_id = $1 AND client_id = $2 AND client_batch_id = $3',
          [roomId, target.rows[0].client_id, target.rows[0].client_batch_id]
        );
        boundaryPosition = Number(batchStart.rows[0]?.position ?? boundaryPosition);
      }
    }

    const units = await queryable.query<{ unit_key: string; max_position: number | string }>(
      `SELECT CASE
          WHEN turn_id IS NOT NULL THEN 'turn:' || turn_id
          WHEN client_batch_id IS NOT NULL THEN 'batch:' || client_id || ':' || client_batch_id
          ELSE 'message:' || id
        END AS unit_key,
        MAX(position) AS max_position
      FROM room_messages
      WHERE room_id = $1 AND ($2::bigint IS NULL OR position < $2)
      GROUP BY unit_key
      ORDER BY max_position DESC
      LIMIT $3`,
      [roomId, boundaryPosition ?? null, limit + 1]
    );
    const selectedUnitKeys = units.rows.slice(0, limit).map(row => row.unit_key);
    let rows: MessageRow[] = [];
    let hasMore = false;
    if (selectedUnitKeys.length > 0) {
      const start = await queryable.query<{ position: number | string }>(
        `SELECT MIN(position) AS position
        FROM room_messages
        WHERE room_id = $1
          AND CASE
            WHEN turn_id IS NOT NULL THEN 'turn:' || turn_id
            WHEN client_batch_id IS NOT NULL THEN 'batch:' || client_id || ':' || client_batch_id
            ELSE 'message:' || id
          END = ANY($2::text[])`,
        [roomId, selectedUnitKeys]
      );
      const pageStartPosition = Number(start.rows[0]?.position);
      const page = await queryable.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS}, position
        FROM room_messages
        WHERE room_id = $1 AND position >= $2 AND ($3::bigint IS NULL OR position < $3)
        ORDER BY position ASC, timestamp ASC`,
        [roomId, pageStartPosition, boundaryPosition ?? null]
      );
      rows = page.rows;
      const older = await queryable.query<{ exists: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM room_messages WHERE room_id = $1 AND position < $2) AS exists',
        [roomId, pageStartPosition]
      );
      hasMore = Boolean(older.rows[0]?.exists);
    }

    const messages = orderMessageBatches(await this.attachMediaAssetsWithQueryable(queryable, roomId, rows.map(mapMessage)));
    const turnIds = Array.from(new Set(messages.map(message => message.turnId).filter((id): id is string => Boolean(id))));
    const turns = await this.readRoomAgentTurnsWithQueryable(queryable, roomId, turnIds);
    return {
      roomId,
      messages,
      turns,
      hasMore,
      oldestMessageId: messages[0]?.id,
      room: mapRoom(room.rows[0]),
    };
  }

  private decodeRoomEvents(rows: RoomEventRow[]): RoomEvent[] {
    return rows.map(row => {
      const schemaVersion = Number(row.schema_version);
      if (schemaVersion !== 1) {
        throw new RoomEventPayloadInvalidError(
          row.room_id,
          Number(row.seq),
          `unsupported schema version ${schemaVersion}`,
        );
      }
      const seq = Number(row.seq);
      const parsedPayload = parseJsonValue<unknown>(row.payload);
      const invalidReason = validateStoredRoomEventPayload(row.event_type, parsedPayload, row.room_id);
      if (invalidReason) {
        throw new RoomEventPayloadInvalidError(row.room_id, seq, invalidReason);
      }
      const rawPayload = parsedPayload as Record<string, unknown>;
      const payload: RoomEvent['payload'] = {};
      switch (row.event_type) {
        case 'messages.upserted': {
          const messages = orderMessageBatches((rawPayload.messageRows as MessageRow[]).map(mapMessage));
          const mediaByMessageId = new Map(
            (rawPayload.mediaAssets as StoredMediaAssetSnapshotRow[]).map(asset => {
              const media: MessageMediaAsset = {
                id: asset.id,
                kind: asset.kind,
                mimeType: asset.mime_type,
                byteSize: Number(asset.byte_size) || 0,
              };
              if (asset.filename) media.filename = asset.filename;
              const width = toOptionalNumber(asset.width ?? null);
              const height = toOptionalNumber(asset.height ?? null);
              const durationMs = toOptionalNumber(asset.duration_ms ?? null);
              if (width !== undefined) media.width = width;
              if (height !== undefined) media.height = height;
              if (durationMs !== undefined) media.durationMs = durationMs;
              return [asset.message_id, media] as const;
            })
          );
          payload.messages = messages.map(message => {
            const mediaAsset = mediaByMessageId.get(message.id);
            return mediaAsset ? { ...message, mediaAsset } : message;
          });
          payload.messageIds = payload.messages.map(message => message.id);
          break;
        }
        case 'messages.deleted':
          payload.messageIds = rawPayload.messageIds as string[];
          break;
        case 'agent_turns.upserted':
          payload.turns = (rawPayload.turnRows as RoomAgentTurnRow[]).map(mapRoomAgentTurn);
          payload.turnIds = payload.turns.map(turn => turn.id);
          break;
        case 'agent_turns.deleted':
          payload.turnIds = rawPayload.turnIds as string[];
          break;
        case 'members.changed':
          break;
        case 'room.updated': {
          payload.roomId = row.room_id;
          const roomRow = rawPayload.roomRow;
          if (roomRow && typeof roomRow === 'object') {
            const storedRoom = roomRow as RoomRow & { has_password?: boolean };
            payload.room = mapRoom({
              ...storedRoom,
              password_hash: storedRoom.has_password ? '__event_has_password__' : null,
            });
          }
          break;
        }
        case 'room.deleted':
          payload.roomId = row.room_id;
          break;
      }
      if (typeof rawPayload.deletedAt === 'string') payload.deletedAt = rawPayload.deletedAt;
      return {
        id: `${row.room_id}:${seq}`,
        roomId: row.room_id,
        seq,
        schemaVersion: 1,
        type: row.event_type,
        payload,
        createdAt: toIsoString(row.created_at),
      };
    });
  }

  private async readRoomAgentTurnsWithQueryable(
    queryable: PostgresQueryable,
    roomId: string,
    turnIds?: string[],
  ): Promise<RoomAgentTurn[]> {
    if (turnIds && turnIds.length === 0) return [];
    const result = turnIds
      ? await queryable.query<RoomAgentTurnRow>(
        `SELECT ${ROOM_AGENT_TURN_COLUMNS} FROM room_agent_turns WHERE room_id = $1 AND id = ANY($2::text[]) ORDER BY started_at ASC`,
        [roomId, turnIds]
      )
      : await queryable.query<RoomAgentTurnRow>(
        `SELECT ${ROOM_AGENT_TURN_COLUMNS} FROM room_agent_turns WHERE room_id = $1 ORDER BY started_at ASC`,
        [roomId]
      );
    return result.rows.map(mapRoomAgentTurn);
  }

  private async attachMediaAssetsWithQueryable(
    queryable: PostgresQueryable,
    roomId: string,
    messages: Message[],
  ): Promise<Message[]> {
    if (!messages.some(message => message.messageType === 'media')) return messages;
    const assets = await queryable.query<MediaAssetRow>(
      `SELECT ${MEDIA_ASSET_COLUMNS}
      FROM media_assets
      WHERE room_id = $1
      ORDER BY created_at ASC`,
      [roomId]
    );
    return this.attachMediaAssetsFromAssets(messages, assets.rows.map(mapMediaAsset));
  }

  private async readMessagesByRoomInTransaction(client: PostgresClient, roomId: string): Promise<Message[]> {
    const result = await client.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
      FROM room_messages
      WHERE room_id = $1
      ORDER BY position ASC, timestamp ASC`,
      [roomId]
    );
    const messages = result.rows.map(mapMessage);
    if (!messages.some(message => message.messageType === 'media')) {
      return messages;
    }

    const assets = await client.query<MediaAssetRow>(
      `SELECT ${MEDIA_ASSET_COLUMNS}
      FROM media_assets
      WHERE room_id = $1
      ORDER BY created_at ASC`,
      [roomId]
    );
    return this.attachMediaAssetsFromAssets(messages, assets.rows.map(mapMediaAsset));
  }
}
