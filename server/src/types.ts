export type AIModelProvider = 'openai' | 'openrouter' | 'deepseek' | 'anthropic';
export type RoomType = 'chat' | 'coco';
export type RoomSandboxStatus = 'none' | 'creating' | 'ready' | 'expired' | 'error';
export type RoomCocoStatus = 'idle' | 'running' | 'error';
export type MessageType = 'text' | 'image' | 'ai' | 'tool_call' | 'tool_result' | 'sandbox_status';

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

export interface Message {
  id: string;
  clientId: string;
  content: string;
  roomId: string;
  timestamp: string;
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
  aiModel?: {
    id: string;
    apiModel: string;
    provider: AIModelProvider;
    label: string;
    isPremium?: boolean;
  };
  usage?: AIUsage;
  cost?: AICost;
}

export interface Room {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  lastActivityAt?: string;
  creatorId: string;
  type?: RoomType;
  sandboxId?: string;
  sandboxStatus?: RoomSandboxStatus;
  sandboxUpdatedAt?: string;
  cocoSessionId?: string;
  cocoStatus?: RoomCocoStatus;
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
