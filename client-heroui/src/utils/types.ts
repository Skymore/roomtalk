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
export type RoomType = 'chat' | 'coco';
export type RoomSandboxStatus = 'none' | 'creating' | 'ready' | 'expired' | 'error';
export type RoomCocoStatus = 'idle' | 'running' | 'error';
export type CocoAccessLevel = 'owner' | 'admin' | 'member';
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
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolOutputPreview?: string;
  exitCode?: number;
  isError?: boolean;
  clientMessageId?: string;
  deliveryStatus?: 'pending' | 'sent' | 'failed';
  deliveryError?: string;
  aiModel?: {
    id: string;
    apiModel: string;
    provider: AIModelProvider;
    label: string;
    isPremium?: boolean;
  };
  usage?: AIUsage;
  cost?: AICost;
  codeAgentMode?: 'plan' | 'acceptEdits';
  replyTo?: MessageReplyReference;
  mediaAsset?: MessageMediaAsset;
  uiPayload?: A2UIPayload;
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
  cocoSessionId?: string;
  cocoStatus?: RoomCocoStatus;
  cocoAccess?: CocoAccessLevel;
  codeAgentMode?: 'plan' | 'acceptEdits';
  messageVersion?: number;
  hasPassword?: boolean;
  postingSchedule?: RoomPostingSchedule;
  // 行级单调版本号:每次房间写入 +1,客户端 last-write-wins 的主比较键
  // (updatedAt 退为展示/兼容用途)。版本相等 ⟺ 同一次写入。
  roomVersion?: number;
  updatedAt?: string;
}

export type RoomMemberRole = 'owner' | 'admin' | 'member';

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
  canUseCoco: boolean;
  postingRestrictionReason?: string;
}

export interface RoomMessageHistoryPayload {
  roomId: string;
  messages: Message[];
  historyVersion: number;
  hasMore: boolean;
  oldestMessageId?: string;
  mode?: 'replace' | 'prepend';
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
export interface AIChunkEvent {
  messageId: string;
  chunk: string;
  roomId: string;
}

export interface AIStreamEndEvent {
  messageId: string;
  roomId: string;
  content: string;
  uiPayload?: Message['uiPayload'];
  aiModel?: Message['aiModel'];
  usage?: AIUsage;
  cost?: AICost;
  sessionCost?: AICostTotalEvent;
}

export interface A2UIUpdateEvent {
  messageId: string;
  roomId: string;
  uiPayload: Message['uiPayload'];
}

export interface AIStreamErrorEvent {
  messageId: string;
  error: string;
  roomId: string;
}

export interface AIUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens?: number;
  cacheHitRate?: number;
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
