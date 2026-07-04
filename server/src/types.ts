export type AIModelProvider = 'openai' | 'openrouter' | 'deepseek' | 'anthropic';

export interface AIModelPricing {
  currency: 'USD';
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
}

export interface AIModelOption {
  id: string;
  apiModel: string;
  provider: AIModelProvider;
  label: string;
  description: string;
  pricing?: AIModelPricing;
  isPremium?: boolean;
  isDefault?: boolean;
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

export interface RoomAICostTotal {
  roomId: string;
  currency: 'USD';
  totalUsd: number;
}

export interface MessageReplyReference {
  messageId: string;
  username?: string;
  messageType: MessageType;
  mediaKind?: MediaKind;
  /** For sticker replies: the referenced stickerId (message.content). */
  stickerId?: string;
  mediaAsset?: MessageMediaAsset;
  preview: string;
}

export type MediaKind = 'image' | 'video' | 'audio' | 'file';
export type RoomType = 'chat' | 'coco';
export type RoomSandboxStatus = 'none' | 'creating' | 'ready' | 'expired' | 'error';
export type RoomCocoStatus = 'idle' | 'running' | 'error';
export type CocoAccessLevel = 'owner' | 'admin' | 'member';
export type CodeAgentMode = 'plan' | 'acceptEdits';
export type CodeAgentBackend = 'coco' | 'codex' | 'codex-app-server';
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type CodexPermissionMode = 'plan' | 'edit' | 'approveForMe' | 'fullAccess';
export type MessageType = 'text' | 'ai' | 'media' | 'sticker' | 'tool_call' | 'tool_result' | 'sandbox_status';

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

export interface MediaAsset extends MessageMediaAsset {
  roomId: string;
  messageId?: string;
  objectKey: string;
  uploadedByClientId?: string;
  createdAt: string;
}

export interface Message {
  id: string;
  clientId: string;
  content: string;
  roomId: string;
  timestamp: string;
  updatedAt?: string;
  messageType: MessageType;
  username?: string;
  avatar?: {
    text: string;
    color: string;
  };
  mimeType?: string;
  status?: 'streaming' | 'complete' | 'error';
  clientMessageId?: string;
  turnId?: string;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolOutputPreview?: string;
  exitCode?: number;
  isError?: boolean;
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
  replyTo?: MessageReplyReference;
  mediaAsset?: MessageMediaAsset;
  uiPayload?: A2UIPayload;
}

export interface Room {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  lastActivityAt?: string;
  creatorId: string;
  messageVersion?: number;
  hasPassword?: boolean;
  postingSchedule?: RoomPostingSchedule;
  type?: RoomType;
  sandboxId?: string;
  sandboxStatus?: RoomSandboxStatus;
  sandboxUpdatedAt?: string;
  cocoSessionId?: string;
  cocoStatus?: RoomCocoStatus;
  cocoAccess?: CocoAccessLevel;
  codeAgentMode?: CodeAgentMode;
  codeAgentBackend?: CodeAgentBackend;
  // 行级单调版本号:每次房间写入 +1,客户端 last-write-wins 的主比较键
  // (updatedAt 退为展示/兼容用途)。版本相等 ⟺ 同一次写入。
  roomVersion?: number;
  updatedAt?: string;
}

export interface RoomMessagePage {
  roomId: string;
  messages: Message[];
  historyVersion: number;
  hasMore: boolean;
  oldestMessageId?: string;
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

export interface RoomMember {
  roomId: string;
  clientId: string;
  role: RoomMemberRole;
  joinedAt: string;
}

export interface RoomRoleMember extends RoomMember {
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

export interface UserInfo {
  id: string;
}

export interface RoomOnlineMember {
  clientId: string;
  nickname?: string;
  displayId?: string;
}

export interface RoomMemberEvent {
  roomId: string;
  user: UserInfo;
  count: number;
  action: 'join' | 'leave';
  timestamp: string;
}
