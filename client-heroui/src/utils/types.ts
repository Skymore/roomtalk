export interface MessageReplyReference {
  messageId: string;
  username?: string;
  messageType: MessageType;
  mediaKind?: MediaKind;
  mediaAsset?: MessageMediaAsset;
  /** For sticker replies: the referenced stickerId (message.content). */
  stickerId?: string;
  preview: string;
}

export type MediaKind = 'image' | 'video' | 'audio' | 'file';
export type RoomType = 'chat' | 'codeAgent';
export type RoomSandboxStatus = 'none' | 'creating' | 'ready' | 'expired' | 'error';
export type RoomCodeAgentStatus = 'idle' | 'running' | 'error';
export type CodeAgentAccessLevel = 'owner' | 'admin' | 'member';
export type CodeAgentMode = 'plan' | 'edit' | 'approveForMe' | 'fullAccess' | 'acceptEdits';
export type CodeAgentBackend = 'code-agent' | 'codex' | 'codex-app-server';
export type MessageType = 'text' | 'ai' | 'media' | 'sticker' | 'tool_call' | 'tool_result' | 'sandbox_status';
export type AIModelProvider = 'openai' | 'openrouter' | 'deepseek' | 'anthropic';

export interface MessageMediaAsset {
  id: string;
  kind: MediaKind;
  mimeType: string;
  byteSize: number;
  filename?: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

export type A2UIVersion = 'v0.9';

export interface A2UIActionEvent {
  name: string;
  surfaceId: string;
  sourceComponentId: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

export interface A2UIPayload {
  format: 'a2ui';
  version: A2UIVersion;
  messages: unknown[];
}

export interface RoomMediaHistoryItem {
  assetId: string;
  messageId?: string;
  kind: 'image' | 'video';
  mimeType: string;
  byteSize: number;
  width?: number;
  height?: number;
  durationMs?: number;
  createdAt: string;
  url: string;
  expiresAt?: string;
}

export interface RoomMediaHistoryPage {
  roomId: string;
  items: RoomMediaHistoryItem[];
  hasMore: boolean;
  nextCursor?: string | null;
  windowMonths: number;
}

export type RoomMediaHistoryKindFilter = 'image' | 'video';

export type AudioTranscriptionStatus = 'not_requested' | 'pending' | 'processing' | 'completed' | 'failed';

export interface AudioTranscription {
  assetId: string;
  roomId: string;
  messageId: string;
  status: AudioTranscriptionStatus;
  transcript?: string;
  languageCode?: string;
  error?: string;
  updatedAt?: string;
  completedAt?: string;
}

export type CodeAgentQueueState = 'queued' | 'steering' | 'starting' | 'started';

export interface CodeAgentQueuedInput {
  state: CodeAgentQueueState;
  queuedAt: string;
  updatedAt: string;
  turnId?: string;
  lastError?: string;
}

export interface Message {
  id: string;
  clientId: string;
  content: string;
  timestamp: string;
  updatedAt?: string;
  roomId: string;
  messageType: MessageType;
  username?: string;
  avatar?: {
    text: string;
    color: string;
  };
  mimeType?: string;
  status?: 'streaming' | 'complete' | 'error';
  turnId?: string;
  modelStepId?: string;
  modelStepSequence?: number;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolOutputPreview?: string;
  exitCode?: number;
  isError?: boolean;
  clientMessageId?: string;
  clientBatchId?: string;
  clientBatchIndex?: number;
  deliveryStatus?: 'pending' | 'sent' | 'failed';
  deliveryError?: string;
  deliveryAction?: 'send' | 'ask-ai';
  aiModel?: {
    id: string;
    apiModel: string;
    provider: AIModelProvider;
    label: string;
    isPremium?: boolean;
  };
  usage?: AIUsage;
  cost?: AICost;
  codeAgentMode?: CodeAgentMode;
  codeAgentQueuedInput?: CodeAgentQueuedInput;
  codeAgentImageMessageIds?: string[];
  replyTo?: MessageReplyReference;
  mediaAsset?: MessageMediaAsset;
  /** Browser-local preview used while an optimistic media message is being uploaded. */
  localMediaPreviewUrl?: string;
  /** Client-only marker preventing signed-URL loading before the media asset exists. */
  localMediaPending?: boolean;
  uiPayload?: A2UIPayload;
}

export type RoomAgentTurnStatus = 'running' | 'complete' | 'error' | 'cancelled';
export type RoomAgentTurnPhase =
  | 'preparing_context'
  | 'preparing_sandbox'
  | 'starting_agent'
  | 'running'
  | 'waiting_approval'
  | 'completing';

export interface RoomAgentTurn {
  id: string;
  roomId: string;
  status: RoomAgentTurnStatus;
  startedAt: string;
  completedAt?: string;
  finalMessageId?: string;
  backend: CodeAgentBackend;
  assistantName: string;
  phase?: RoomAgentTurnPhase;
  phaseMessage?: string;
  lastHeartbeatAt?: string;
  updatedAt: string;
}

export interface Room {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  lastActivityAt?: string;
  creatorId: string;
  type?: RoomType;
  sandboxId?: string;
  sandboxStatus?: RoomSandboxStatus;
  sandboxUpdatedAt?: string;
  codeAgentSessionId?: string;
  codeAgentStatus?: RoomCodeAgentStatus;
  codeAgentAccess?: CodeAgentAccessLevel;
  codeAgentMode?: CodeAgentMode;
  codeAgentBackend?: CodeAgentBackend;
  hasPassword?: boolean;
  postingSchedule?: RoomPostingSchedule;
  updatedAt?: string;
}

export type RoomMemberRole = 'owner' | 'admin' | 'member';

export interface RoomMember {
  roomId: string;
  clientId: string;
  role: RoomMemberRole;
  joinedAt: string;
}

export interface RoomPostingWindow {
  days: number[];
  start: string;
  end: string;
}

export interface RoomPostingSchedule {
  enabled: boolean;
  timezone: string;
  windows: RoomPostingWindow[];
}

export interface RoomPermissions {
  roomId: string;
  clientId: string;
  role: RoomMemberRole | null;
  canPost: boolean;
  canEditAnyMessage: boolean;
  canDeleteAnyMessage: boolean;
  canClearHistory: boolean;
  canManageRoom: boolean;
  canManageAdmins: boolean;
  canManageMembers: boolean;
  canTransferOwnership: boolean;
  canUseCodeAgent: boolean;
  postingRestrictionReason?: string;
}

export type RoomEventType =
  | 'messages.upserted'
  | 'messages.deleted'
  | 'agent_turns.upserted'
  | 'agent_turns.deleted'
  | 'members.changed'
  | 'room.updated'
  | 'room.deleted';

export interface RoomEvent {
  id: string;
  roomId: string;
  seq: number;
  schemaVersion: 1;
  type: RoomEventType;
  payload: {
    messages?: Message[];
    messageIds?: string[];
    turns?: RoomAgentTurn[];
    turnIds?: string[];
    room?: Room;
    roomId?: string;
    deletedAt?: string;
  };
  createdAt: string;
}

export interface RoomSnapshotPayload {
  requestId: string;
  roomId: string;
  room: Room;
  messages: Message[];
  turns?: RoomAgentTurn[];
  snapshotSeq: number;
  hasMore: boolean;
  oldestMessageId?: string;
  mode?: 'replace' | 'prepend';
}

export interface RoomEventPagePayload {
  requestId: string;
  roomId: string;
  events: RoomEvent[];
  headSeq: number;
  minAvailableSeq: number;
  hasMore: boolean;
}

export interface RoomEventAvailable {
  roomId: string;
  headSeq: number;
  events?: RoomEvent[];
}

export interface RoomSyncRequired {
  reason: 'postgres_listener_reconnected';
}

export type RoomRenameHandler = (roomId: string, name: string) => Promise<void>;

export interface UserInfo {
  id: string;
  // 可以根据需要扩展更多用户信息
}

export interface RoomMemberEvent {
  roomId: string;
  user: UserInfo;
  count: number; // 房间当前成员数
  action: 'join' | 'leave'; // 加入或离开
  timestamp: string;
}

export interface RoomMemberCount {
  roomId: string;
  count: number;
}

export interface RoomOnlineMember {
  clientId: string;
  nickname?: string;
  displayId?: string;
}

export interface RoomRoleMember {
  roomId: string;
  clientId: string;
  role: RoomMemberRole;
  joinedAt: string;
  nickname?: string;
  displayId?: string;
}

export interface RoomClientLookup {
  clientId: string;
  exists: boolean;
  nickname?: string;
  displayId?: string;
  memberRole?: RoomMemberRole | null;
}
export interface AITransientStreamIdentity {
  runId?: string;
  generation?: number;
  chunkSeq?: number;
}

export interface AIChunkEvent extends AITransientStreamIdentity {
  messageId: string;
  chunk: string;
  roomId: string;
}

export interface AIStreamEndEvent extends AITransientStreamIdentity {
  messageId: string;
  roomId: string;
  content: string;
  uiPayload?: Message['uiPayload'];
  aiModel?: Message['aiModel'];
  usage?: AIUsage;
  cost?: AICost;
  sessionCost?: AICostTotalEvent;
}

export interface AIUsageUpdateEvent {
  messageId: string;
  roomId: string;
  usage: AIUsage;
}

export interface A2UIUpdateEvent extends AITransientStreamIdentity {
  messageId: string;
  roomId: string;
  uiPayload: Message['uiPayload'];
}

export interface AIStreamErrorEvent extends AITransientStreamIdentity {
  messageId: string;
  error: string;
  roomId: string;
  persisted: boolean;
  message?: Message;
  partial?: boolean;
}

export interface AIUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens?: number;
  cacheHitRate?: number;
  modelContextWindow?: number;
  source: 'reported' | 'estimated';
}

export interface AICost {
  currency: 'USD';
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
  estimated: boolean;
}

export interface AICostTotalEvent {
  roomId: string;
  currency: 'USD';
  totalUsd: number;
}
