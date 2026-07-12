import { customAlphabet } from 'nanoid';
import { Logger } from '../logger';
import { AICost, CodeAgentQueueState, MediaAsset, Message, MessageMediaAsset, Room, RoomAgentTurn, RoomAICostTotal, RoomCodeAgentStatus, RoomMember, RoomMemberRole, RoomPostingSchedule, RoomSandboxStatus, RoomType } from '../types';
import { getAIStreamOwnerId, InterruptedStreamingMessageRecoveryOptions } from '../services/aiStreamRecovery';
import { AssistantRunRecord, AssistantRunUpdate, AudioTranscriptionRecord, AudioTranscriptionUpdate, ClientAccount, ClientAuthTokenRecord, CodeAgentQueueMessageUpdate, CreateGoogleAccountInput, DEFAULT_ROOM_MESSAGE_PAGE_LIMIT, DurableRoomStore, GoogleAccountProfile, IdempotentMessageAppendResult, MediaHistoryPage, MediaHistoryPageOptions, MediaMessageAppendResult, OutboxClaimOptions, OutboxEventRecord, OutboxFailOptions, PendingMediaUpload, PushSubscriptionRecord, RoomMessagePageOptions, RoomSandboxReplacement, RoomSettingsUpdate, SavePushSubscriptionInput } from './store';
import { POSTGRES_MIGRATIONS, POSTGRES_SCHEMA_SQL } from './postgresSchema';
import { MediaObjectStorage } from '../services/mediaObjectStorage';

const nanoid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 10);

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
  end?(): Promise<void>;
}

type RoomRow = {
  id: string;
  name: string;
  description: string | null;
  created_at: string | Date;
  last_activity_at: string | Date;
  creator_id: string;
  message_version?: number | string | null;
  password_hash?: string | null;
  posting_schedule?: unknown;
  type?: RoomType | null;
  sandbox_id?: string | null;
  sandbox_status?: RoomSandboxStatus | null;
  sandbox_updated_at?: string | Date | null;
  sandbox_artifact_version?: string | null;
  sandbox_code_agent_source_ref?: string | null;
  code_agent_session_id?: string | null;
  code_agent_status?: RoomCodeAgentStatus | null;
  code_agent_access?: string | null;
  code_agent_mode?: string | null;
  code_agent_backend?: string | null;
  room_version?: number | string | null;
  updated_at?: string | Date | null;
};

type MessageRow = {
  id: string;
  room_id: string;
  client_id: string;
  client_message_id?: string | null;
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
  provider: 'google';
  provider_subject: string;
  email: string | null;
  email_verified: boolean | null;
};

const ROOM_COLUMNS = 'id, name, description, created_at, last_activity_at, creator_id, message_version, password_hash, posting_schedule, type, sandbox_id, sandbox_status, sandbox_updated_at, sandbox_artifact_version, sandbox_code_agent_source_ref, code_agent_session_id, code_agent_status, code_agent_access, code_agent_mode, code_agent_backend, room_version, updated_at';
const MESSAGE_COLUMNS = 'id, room_id, client_id, client_message_id, content, timestamp, updated_at, message_type, username, avatar, mime_type, status, turn_id, tool_call_id, tool_name, tool_args, tool_output_preview, exit_code, is_error, ai_model, usage, cost, reply_to, ai_stream_owner_id, ui_payload, code_agent_mode, code_agent_queued_input, code_agent_image_message_ids, model_step_id, model_step_sequence';
const ROOM_MEMBER_COLUMNS = 'room_id, client_id, role, joined_at';
const MEDIA_ASSET_COLUMNS = 'id, room_id, message_id, object_key, kind, mime_type, byte_size, filename, width, height, duration_ms, uploaded_by_client_id, created_at';
const PENDING_MEDIA_UPLOAD_COLUMNS = 'id, room_id, object_key, kind, mime_type, byte_size, filename, uploaded_by_client_id, expires_at, created_at';
const AUDIO_TRANSCRIPTION_COLUMNS = 'asset_id, room_id, message_id, requested_by_client_id, status, transcript, language_code, provider, provider_transcript_id, error, created_at, updated_at, completed_at';
const ASSISTANT_RUN_COLUMNS = 'id, room_id, requested_by_client_id, user_message_id, ai_message_id, status, model_id, api_model, provider, role_name, system_prompt, max_context_messages, retry_for_message_id, edited_message_id, error, metadata, created_at, queued_at, started_at, completed_at, updated_at';
const ROOM_AGENT_TURN_COLUMNS = 'id, room_id, status, started_at, completed_at, final_message_id, backend, assistant_name, phase, phase_message, last_heartbeat_at, updated_at';
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
  ai.provider,
  ai.provider_subject,
  ai.email,
  ai.email_verified`;

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
  const messageVersion = Number(row.message_version || 0);
  if (messageVersion > 0) room.messageVersion = messageVersion;
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
  if (row.code_agent_status) room.codeAgentStatus = row.code_agent_status;
  if (row.code_agent_access) room.codeAgentAccess = row.code_agent_access as Room['codeAgentAccess'];
  if (row.code_agent_mode) room.codeAgentMode = row.code_agent_mode as Room['codeAgentMode'];
  if (row.code_agent_backend) room.codeAgentBackend = row.code_agent_backend as Room['codeAgentBackend'];
  const roomVersion = Number(row.room_version || 0);
  if (roomVersion > 0) room.roomVersion = roomVersion;
  if (row.updated_at) room.updatedAt = toIsoString(row.updated_at);
  return room;
};

const mapRoomMember = (row: RoomMemberRow): RoomMember => ({
  roomId: row.room_id,
  clientId: row.client_id,
  role: row.role,
  joinedAt: toIsoString(row.joined_at),
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
  return run;
};

const mapRoomAgentTurn = (row: RoomAgentTurnRow): RoomAgentTurn => ({
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
  updatedAt: toIsoString(row.updated_at),
});

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
  message.codeAgentMode || null,
  toJsonb(message.codeAgentQueuedInput),
  toJsonb(message.codeAgentImageMessageIds),
  position,
  message.modelStepId || null,
  message.modelStepSequence ?? null,
  message.clientMessageId || null,
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

const INSERT_MESSAGE_SQL = `INSERT INTO room_messages (
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
  code_agent_mode,
  code_agent_queued_input,
  code_agent_image_message_ids,
  position,
  model_step_id,
  model_step_sequence,
  client_message_id
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18, $19::jsonb, $20::jsonb, $21::jsonb, $22::jsonb, $23::jsonb, $24, $25, $26::jsonb, $27::jsonb, $28, $29, $30, $31
) ON CONFLICT (id) DO UPDATE SET
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
  code_agent_mode = EXCLUDED.code_agent_mode,
  code_agent_queued_input = EXCLUDED.code_agent_queued_input,
  code_agent_image_message_ids = EXCLUDED.code_agent_image_message_ids,
  client_message_id = EXCLUDED.client_message_id,
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
  updated_at
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19, $20, $21
) ON CONFLICT (id) DO UPDATE SET
  status = EXCLUDED.status,
  error = EXCLUDED.error,
  metadata = EXCLUDED.metadata,
  started_at = EXCLUDED.started_at,
  completed_at = EXCLUDED.completed_at,
  updated_at = EXCLUDED.updated_at
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
      try {
        await this.mediaObjectStorage.deleteMediaObject(objectKey);
      } catch (error) {
        this.logger.error('Failed to delete orphaned media object', { error, objectKey });
      }
    }
  }

  async initializeSchema(): Promise<void> {
    for (const sql of POSTGRES_SCHEMA_SQL) {
      await this.pool.query(sql);
    }
    await this.runMigrations();
    this.logger.info('PostgreSQL schema initialized');
  }

  private async runMigrations(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );

    for (const migration of POSTGRES_MIGRATIONS) {
      const applied = await this.pool.query(
        'SELECT 1 FROM schema_migrations WHERE id = $1 LIMIT 1',
        [migration.id]
      );
      if (applied.rows.length > 0) {
        continue;
      }

      // Apply the migration and record it atomically, so a crash mid-migration
      // never leaves it marked as applied without its effect (or vice versa).
      await this.transaction(async client => {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
          [migration.id]
        );
      });
      this.logger.info('Applied PostgreSQL migration', { id: migration.id });
    }
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
        await client.query(INSERT_MESSAGE_SQL, messageParams(message, position));

        const updatedRoom = await client.query<RoomRow>(
          `UPDATE rooms
          SET last_activity_at = GREATEST(last_activity_at, $2::timestamptz),
            message_version = message_version + 1,
            room_version = room_version + 1, updated_at = NOW()
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
        await client.query(INSERT_MESSAGE_SQL, messageParams(mediaMessage, position));

        const savedAsset = await this.saveMediaAssetWithClient(client, mediaAsset);
        if (!savedAsset) {
          throw new Error('Failed to save media asset');
        }

        const updatedRoom = await client.query<RoomRow>(
          `UPDATE rooms
          SET last_activity_at = GREATEST(last_activity_at, $2::timestamptz),
            message_version = message_version + 1,
            room_version = room_version + 1, updated_at = NOW()
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
        await client.query(INSERT_MESSAGE_SQL, messageParams(message, position));

        const updatedRoom = await client.query<RoomRow>(
          `UPDATE rooms
          SET last_activity_at = GREATEST(last_activity_at, $2::timestamptz),
            message_version = message_version + 1,
            room_version = room_version + 1, updated_at = NOW()
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

        const updatedRoom = await this.updateRoomLastActivityFromMessages(client, roomId, toIsoString(room.rows[0].created_at), true);
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

        const updatedRoom = await this.updateRoomLastActivityFromMessages(client, roomId, toIsoString(room.rows[0].created_at), true);
        return updatedRoom
          ? { room: updatedRoom, found: true, updatedMessage: mapMessage(updated.rows[0]) }
          : null;
      });
    } catch (error) {
      this.logger.error('Error transitioning PostgreSQL queued code-agent message', { error, roomId, messageId, expectedState: update.expectedState });
      return null;
    }
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
        const updatedRoom = await this.updateRoomLastActivityFromMessages(client, roomId, toIsoString(room.rows[0].created_at), true);
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
        const updatedRoom = await this.updateRoomLastActivityFromMessages(client, roomId, toIsoString(room.rows[0].created_at), true);
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
      return [];
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

        const updatedRoom = await this.updateRoomLastActivityFromMessages(client, roomId, toIsoString(room.rows[0].created_at), true);
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

        const updatedRoom = await this.updateRoomLastActivityFromMessages(client, roomId, toIsoString(room.rows[0].created_at), true);
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

        const updatedRoom = await this.updateRoomLastActivityFromMessages(client, roomId, toIsoString(room.rows[0].created_at), true);
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
          await client.query(INSERT_MESSAGE_SQL, messageParams({ ...message, roomId }, index));
        }

        const lastActivityAt = getLatestMessageTimestamp(messages) || toIsoString(room.rows[0].created_at);
        const updatedRoom = await client.query<RoomRow>(
          `UPDATE rooms
          SET last_activity_at = $2,
            message_version = message_version + 1,
            room_version = room_version + 1, updated_at = NOW()
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
    try {
      const deleted = await this.transaction(async client => {
        // Clearing removes every message, so every asset in the room is orphaned.
        const orphaned = await client.query<{ object_key: string }>(
          'DELETE FROM media_assets WHERE room_id = $1 RETURNING object_key',
          [roomId]
        );
        orphanedObjectKeys = orphaned.rows.map(row => row.object_key);

        await client.query('DELETE FROM room_agent_turns WHERE room_id = $1', [roomId]);
        const result = await client.query('DELETE FROM room_messages WHERE room_id = $1', [roomId]);
        const removed = result.rowCount || 0;
        if (removed > 0) {
          await client.query(
            `UPDATE rooms
            SET message_version = message_version + 1,
              last_activity_at = created_at,
              room_version = room_version + 1, updated_at = NOW()
            WHERE id = $1`,
            [roomId]
          );
        }
        return removed;
      });

      await this.deleteOrphanedMediaObjects(orphanedObjectKeys);
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
      return this.attachMediaAssets(roomId, result.rows.map(mapMessage));
    } catch (error) {
      this.logger.error('Error reading PostgreSQL room messages', { error, roomId });
      return [];
    }
  }

  async readMessagePageByRoom(roomId: string, options: RoomMessagePageOptions = {}) {
    const limit = normalizeMessagePageLimit(options.limit);

    try {
      const room = await this.pool.query<RoomRow>(
        `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1`,
        [roomId]
      );
      const historyVersion = Number(room.rows[0]?.message_version || 0);
      if (room.rows.length === 0) {
        return { roomId, messages: [], historyVersion, hasMore: false };
      }

      let boundaryPosition: number | undefined;
      if (options.beforeMessageId) {
        const target = await this.pool.query<{ position: number | string; turn_id: string | null }>(
          'SELECT position, turn_id FROM room_messages WHERE room_id = $1 AND id = $2',
          [roomId, options.beforeMessageId]
        );
        if (target.rows.length === 0) {
          return { roomId, messages: [], historyVersion, hasMore: false };
        }
        boundaryPosition = Number(target.rows[0].position);
        if (target.rows[0].turn_id) {
          const turnStart = await this.pool.query<{ position: number | string }>(
            'SELECT MIN(position) AS position FROM room_messages WHERE room_id = $1 AND turn_id = $2',
            [roomId, target.rows[0].turn_id]
          );
          boundaryPosition = Number(turnStart.rows[0]?.position ?? boundaryPosition);
        }
      }

      const units = await this.pool.query<{ unit_key: string; max_position: number | string }>(
        `SELECT CASE WHEN turn_id IS NULL THEN 'message:' || id ELSE 'turn:' || turn_id END AS unit_key,
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
        const start = await this.pool.query<{ position: number | string }>(
          `SELECT MIN(position) AS position
          FROM room_messages
          WHERE room_id = $1
            AND CASE WHEN turn_id IS NULL THEN 'message:' || id ELSE 'turn:' || turn_id END = ANY($2::text[])`,
          [roomId, selectedUnitKeys]
        );
        const pageStartPosition = Number(start.rows[0]?.position);
        const page = await this.pool.query<MessageRow>(
          `SELECT ${MESSAGE_COLUMNS}, position
          FROM room_messages
          WHERE room_id = $1 AND position >= $2 AND ($3::bigint IS NULL OR position < $3)
          ORDER BY position ASC, timestamp ASC`,
          [roomId, pageStartPosition, boundaryPosition ?? null]
        );
        rows = page.rows;
        const older = await this.pool.query<{ exists: boolean }>(
          'SELECT EXISTS(SELECT 1 FROM room_messages WHERE room_id = $1 AND position < $2) AS exists',
          [roomId, pageStartPosition]
        );
        hasMore = Boolean(older.rows[0]?.exists);
      }
      const messages = await this.attachMediaAssets(roomId, rows.map(mapMessage));
      const turns = await this.readRoomAgentTurns(roomId, Array.from(new Set(messages.map(message => message.turnId).filter((id): id is string => Boolean(id)))));
      return {
        roomId,
        messages,
        turns,
        historyVersion,
        hasMore,
        oldestMessageId: messages[0]?.id,
      };
    } catch (error) {
      this.logger.error('Error reading PostgreSQL room message page', { error, roomId, options });
      return { roomId, messages: [], historyVersion: 0, hasMore: false };
    }
  }

  async upsertRoomAgentTurn(turn: RoomAgentTurn): Promise<RoomAgentTurn | null> {
    try {
      const result = await this.pool.query<RoomAgentTurnRow>(
        `INSERT INTO room_agent_turns (${ROOM_AGENT_TURN_COLUMNS})
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
      return null;
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

  async failInterruptedRoomAgentTurns(completedAt = new Date().toISOString()): Promise<number> {
    try {
      const result = await this.pool.query(
        `UPDATE room_agent_turns SET status = 'error', completed_at = $1, phase = NULL, phase_message = NULL, last_heartbeat_at = $1, updated_at = $1 WHERE status = 'running'`,
        [completedAt]
      );
      return result.rowCount || 0;
    } catch (error) {
      this.logger.error('Error recovering interrupted PostgreSQL room agent turns', { error });
      return 0;
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
      return { roomId, currency: 'USD', totalUsd: 0 };
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
      return this.readRoomAICost(roomId);
    }
  }

  async setRoomAICostTotal(roomId: string, totalUsd: number): Promise<RoomAICostTotal> {
    if (!Number.isFinite(totalUsd) || totalUsd <= 0) {
      try {
        await this.pool.query('DELETE FROM room_ai_cost_totals WHERE room_id = $1', [roomId]);
      } catch (error) {
        this.logger.error('Error clearing PostgreSQL room AI cost total', { error, roomId, totalUsd });
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
      return this.readRoomAICost(roomId);
    }
  }

  async createAssistantRun(run: AssistantRunRecord): Promise<AssistantRunRecord | null> {
    try {
      const result = await this.pool.query<AssistantRunRow>(INSERT_ASSISTANT_RUN_SQL, assistantRunParams(run));
      return result.rows[0] ? mapAssistantRun(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error creating PostgreSQL assistant run', { error, runId: run.id, roomId: run.roomId });
      return null;
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
      return null;
    }
  }

  async updateAssistantRun(runId: string, updates: AssistantRunUpdate): Promise<AssistantRunRecord | null> {
    const now = updates.updatedAt || new Date().toISOString();
    try {
      const result = await this.pool.query<AssistantRunRow>(
        `UPDATE assistant_runs
        SET status = COALESCE($2, status),
          error = CASE WHEN $3::boolean THEN $4 ELSE error END,
          started_at = CASE WHEN $5::boolean THEN $6::timestamptz ELSE started_at END,
          completed_at = CASE WHEN $7::boolean THEN $8::timestamptz ELSE completed_at END,
          metadata = CASE WHEN $9::boolean THEN $10::jsonb ELSE metadata END,
          updated_at = $11::timestamptz
        WHERE id = $1
        RETURNING ${ASSISTANT_RUN_COLUMNS}`,
        [
          runId,
          updates.status || null,
          Object.prototype.hasOwnProperty.call(updates, 'error'),
          updates.error ?? null,
          Object.prototype.hasOwnProperty.call(updates, 'startedAt'),
          updates.startedAt ?? null,
          Object.prototype.hasOwnProperty.call(updates, 'completedAt'),
          updates.completedAt ?? null,
          Object.prototype.hasOwnProperty.call(updates, 'metadata'),
          toJsonb(updates.metadata ?? null),
          now,
        ]
      );
      return result.rows[0] ? mapAssistantRun(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error updating PostgreSQL assistant run', { error, runId, updates });
      return null;
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

  async createAssistantRunWithOutbox(run: AssistantRunRecord, event: OutboxEventRecord): Promise<{ run: AssistantRunRecord; event: OutboxEventRecord } | null> {
    try {
      return await this.transaction(async client => {
        const runResult = await client.query<AssistantRunRow>(INSERT_ASSISTANT_RUN_SQL, assistantRunParams(run));
        const eventResult = await client.query<OutboxEventRow>(INSERT_OUTBOX_EVENT_SQL, outboxEventParams(event));
        if (!runResult.rows[0] || !eventResult.rows[0]) {
          return null;
        }
        return {
          run: mapAssistantRun(runResult.rows[0]),
          event: mapOutboxEvent(eventResult.rows[0]),
        };
      });
    } catch (error) {
      this.logger.error('Error creating PostgreSQL assistant run with outbox event', { error, runId: run.id, eventId: event.id });
      return null;
    }
  }

  async claimOutboxEvents(options: OutboxClaimOptions): Promise<OutboxEventRecord[]> {
    const now = options.now || new Date().toISOString();
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
          `WITH candidates AS (
            SELECT id
            FROM outbox_events
            WHERE (
              status = 'pending'
              OR (
                status = 'processing'
                AND locked_at < ($1::timestamptz - (($4::int || ' milliseconds')::interval))
              )
            )
            AND available_at <= $1::timestamptz
            ${eventTypeClause}
            ORDER BY created_at ASC
            LIMIT $3
            FOR UPDATE SKIP LOCKED
          )
          UPDATE outbox_events e
          SET status = 'processing',
            attempts = e.attempts + 1,
            locked_at = $1::timestamptz,
            locked_by = $2,
            updated_at = $1::timestamptz
          FROM candidates
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

  async markOutboxEventProcessed(eventId: string, processedAt = new Date().toISOString()): Promise<OutboxEventRecord | null> {
    try {
      const result = await this.pool.query<OutboxEventRow>(
        `UPDATE outbox_events
        SET status = 'processed',
          processed_at = $2::timestamptz,
          locked_at = NULL,
          locked_by = NULL,
          last_error = NULL,
          updated_at = $2::timestamptz
        WHERE id = $1
        RETURNING ${OUTBOX_EVENT_COLUMNS}`,
        [eventId, processedAt]
      );
      return result.rows[0] ? mapOutboxEvent(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error marking PostgreSQL outbox event processed', { error, eventId });
      return null;
    }
  }

  async markOutboxEventFailed(eventId: string, errorMessage: string, options: OutboxFailOptions = {}): Promise<OutboxEventRecord | null> {
    const now = options.now || new Date().toISOString();
    const retryDelayMs = Math.max(0, options.retryDelayMs || 30_000);
    const maxAttempts = Math.max(1, options.maxAttempts || 10);

    try {
      const result = await this.pool.query<OutboxEventRow>(
        `UPDATE outbox_events
        SET status = CASE WHEN attempts >= $5 THEN 'failed' ELSE 'pending' END,
          available_at = CASE WHEN attempts >= $5 THEN available_at ELSE ($2::timestamptz + (($4::int || ' milliseconds')::interval)) END,
          locked_at = NULL,
          locked_by = NULL,
          last_error = $3,
          updated_at = $2::timestamptz
        WHERE id = $1
        RETURNING ${OUTBOX_EVENT_COLUMNS}`,
        [eventId, now, errorMessage, retryDelayMs, maxAttempts]
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
            room_version,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 1, NOW())
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
            room_version = rooms.room_version + 1, updated_at = NOW()
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
        INNER JOIN account_identities ai ON ai.account_id = a.id AND ai.provider = 'google'
        WHERE cal.client_id = $1
        LIMIT 1`,
        [clientId]
      );
      return result.rows[0] ? mapClientAccount(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL account by client ID', { error, clientId });
      return null;
    }
  }

  async getAccountByGoogleSubject(providerSubject: string): Promise<ClientAccount | null> {
    try {
      const result = await this.pool.query<ClientAccountRow>(
        `SELECT ${ACCOUNT_SELECT_COLUMNS}
        FROM account_identities ai
        INNER JOIN accounts a ON a.id = ai.account_id
        WHERE ai.provider = 'google' AND ai.provider_subject = $1
        LIMIT 1`,
        [providerSubject]
      );
      return result.rows[0] ? mapClientAccount(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL account by Google subject', { error });
      return null;
    }
  }

  async createGoogleAccountForClient(input: CreateGoogleAccountInput): Promise<ClientAccount | null> {
    const now = input.now || new Date().toISOString();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO accounts (id, primary_client_id, display_name, avatar_url, created_at, updated_at, last_login_at)
        VALUES ($1, $2, $3, $4, $5, $5, $5)`,
        [
          input.accountId,
          input.clientId,
          input.displayName || null,
          input.avatarUrl || null,
          now,
        ]
      );
      await client.query(
        `INSERT INTO account_identities (account_id, provider, provider_subject, email, email_verified, created_at, updated_at)
        VALUES ($1, 'google', $2, $3, $4, $5, $5)`,
        [
          input.accountId,
          input.providerSubject,
          input.email || null,
          Boolean(input.emailVerified),
          now,
        ]
      );
      await client.query(
        `INSERT INTO client_account_links (client_id, account_id, linked_at)
        VALUES ($1, $2, $3)`,
        [input.clientId, input.accountId, now]
      );
      await client.query('COMMIT');
      return this.getAccountByClientId(input.clientId);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.logger.error('Error creating PostgreSQL Google account', { error, clientId: input.clientId });
      return null;
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
        INNER JOIN account_identities ai ON ai.account_id = a.id AND ai.provider = 'google'
        WHERE a.id = $1
        LIMIT 1`,
        [accountId]
      );
      return result.rows[0] ? mapClientAccount(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error updating PostgreSQL Google account login', { error, accountId });
      return null;
    }
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
      return null;
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
      return false;
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
      return false;
    }
  }

  async deleteClientAuthTokens(clientId: string): Promise<void> {
    try {
      await this.pool.query('DELETE FROM client_auth_tokens WHERE client_id = $1', [clientId]);
    } catch (error) {
      this.logger.error('Error deleting PostgreSQL client auth tokens', { error, clientId });
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
          room_version = room_version + 1, updated_at = NOW()
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
          SET creator_id = $2, room_version = room_version + 1, updated_at = NOW()
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
        SET name = $3, room_version = room_version + 1, updated_at = NOW()
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

  async deleteRoom(roomId: string, creatorId: string): Promise<void> {
    let orphanedObjectKeys: string[] = [];
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

        await client.query('DELETE FROM rooms WHERE id = $1 AND creator_id = $2', [roomId, creatorId]);
      });

      await this.deleteOrphanedMediaObjects(orphanedObjectKeys);
      this.logger.debug('Room deleted from PostgreSQL', { roomId, creatorId });
    } catch (error) {
      this.logger.error('Error deleting PostgreSQL room', { error, roomId, creatorId });
    }
  }

  async countRooms(): Promise<number> {
    try {
      const result = await this.pool.query<{ count: string | number }>('SELECT COUNT(*) AS count FROM rooms');
      const count = Number.parseInt(String(result.rows[0]?.count || '0'), 10);
      return Number.isFinite(count) ? count : 0;
    } catch (error) {
      this.logger.error('Error counting PostgreSQL rooms', { error });
      return 0;
    }
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
          room_version = room_version + 1,
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
          room_version = room_version + 1,
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

  async findInterruptedCodeAgentRooms(): Promise<Room[]> {
    try {
      const result = await this.pool.query<RoomRow>(
        `SELECT ${ROOM_COLUMNS}
        FROM rooms
        WHERE type = 'codeAgent'
          AND (sandbox_status = 'creating' OR code_agent_status = 'running')`
      );
      return result.rows.map(mapRoom);
    } catch (error) {
      this.logger.error('Error finding interrupted PostgreSQL code-agent rooms', { error });
      return [];
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
    await this.pool.query('TRUNCATE github_connections, codex_connections, outbox_events, assistant_runs, room_ai_cost_totals, audio_transcriptions, pending_media_uploads, media_assets, room_messages, room_saves, room_members, rooms, client_auth_tokens, client_passwords, client_account_links, account_identities, accounts, client_profiles RESTART IDENTITY CASCADE');
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

  private async updateRoomLastActivityFromMessages(client: PostgresClient, roomId: string, fallbackTimestamp: string, incrementMessageVersion = false): Promise<Room | null> {
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
        message_version = message_version + $3,
        room_version = room_version + 1, updated_at = NOW()
      WHERE id = $1
      RETURNING ${ROOM_COLUMNS}`,
      [roomId, lastActivityAt, incrementMessageVersion ? 1 : 0]
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
