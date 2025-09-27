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
}

export interface AIStreamEndEvent {
  messageId: string;
}

export interface AIStreamErrorEvent {
  messageId: string;
  error: string;
} 