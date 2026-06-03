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
  messageType: 'text' | 'image' | 'ai' | 'voice';
  preview: string;
}

export interface MessageImageAsset {
  id: string;
  mimeType: string;
  byteSize: number;
  width?: number;
  height?: number;
}

export interface ImageAsset extends MessageImageAsset {
  roomId: string;
  messageId?: string;
  objectKey: string;
  createdAt: string;
}

export interface Message {
  id: string;
  clientId: string;
  content: string;
  roomId: string;
  timestamp: string;
  messageType: 'text' | 'image' | 'ai' | 'voice';
  username?: string;
  avatar?: {
    text: string;
    color: string;
  };
  mimeType?: string;
  status?: 'streaming' | 'complete' | 'error';
  clientMessageId?: string;
  aiModel?: {
    id: string;
    apiModel: string;
    provider: AIModelProvider;
    label: string;
    isPremium?: boolean;
  };
  usage?: AIUsage;
  cost?: AICost;
  replyTo?: MessageReplyReference;
  imageAsset?: MessageImageAsset;
}

export interface Room {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  lastActivityAt?: string;
  creatorId: string;
}

export type RoomMemberRole = 'owner' | 'member';

export interface RoomMember {
  roomId: string;
  clientId: string;
  role: RoomMemberRole;
  joinedAt: string;
}

export interface UserInfo {
  id: string;
}

export interface RoomMemberEvent {
  roomId: string;
  user: UserInfo;
  count: number;
  action: 'join' | 'leave';
  timestamp: string;
}
