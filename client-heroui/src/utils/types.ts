export interface Message {
  id: string;
  clientId: string;
  content: string;
  timestamp: string;
  roomId: string;
  messageType: 'text' | 'image' | 'ai';
  username?: string;
  avatar?: {
    text: string;
    color: string;
  };
  mimeType?: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/jpg';
  status?: 'streaming' | 'complete' | 'error';
  aiModel?: {
    id: string;
    apiModel: string;
    provider: 'openai' | 'openrouter';
    label: string;
  };
  usage?: AIUsage;
  cost?: AICost;
}

export interface Room {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  creatorId: string;
}

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
