export type RoomType = 'chat' | 'coco';
export type RoomSandboxStatus = 'none' | 'creating' | 'ready' | 'expired' | 'error';
export type RoomCocoStatus = 'idle' | 'running' | 'error';
export type MessageType = 'text' | 'image' | 'ai' | 'tool_call' | 'tool_result' | 'sandbox_status';
export type AIModelProvider = 'openai' | 'openrouter' | 'deepseek' | 'anthropic';

export interface Message {
  id: string;
  clientId: string;
  content: string;
  timestamp: string;
  roomId: string;
  messageType: MessageType;
  username?: string;
  avatar?: {
    text: string;
    color: string;
  };
  mimeType?: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/jpg';
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
