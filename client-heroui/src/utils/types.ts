export interface MessageReplyReference {
  messageId: string;
  username?: string;
  messageType: 'text' | 'ai' | 'media';
  mediaKind?: MediaKind;
  preview: string;
}

export type MediaKind = 'image' | 'video' | 'audio';

export interface MessageMediaAsset {
  id: string;
  kind: MediaKind;
  mimeType: string;
  byteSize: number;
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface Message {
  id: string;
  clientId: string;
  content: string;
  timestamp: string;
  updatedAt?: string;
  roomId: string;
  messageType: 'text' | 'ai' | 'media';
  username?: string;
  avatar?: {
    text: string;
    color: string;
  };
  mimeType?: string;
  status?: 'streaming' | 'complete' | 'error';
  clientMessageId?: string;
  deliveryStatus?: 'pending' | 'sent' | 'failed';
  deliveryError?: string;
  aiModel?: {
    id: string;
    apiModel: string;
    provider: 'openai' | 'openrouter';
    label: string;
    isPremium?: boolean;
  };
  usage?: AIUsage;
  cost?: AICost;
  replyTo?: MessageReplyReference;
  mediaAsset?: MessageMediaAsset;
}

export interface Room {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  lastActivityAt?: string;
  creatorId: string;
  messageVersion?: number;
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
  aiModel?: Message['aiModel'];
  usage?: AIUsage;
  cost?: AICost;
  sessionCost?: AICostTotalEvent;
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
