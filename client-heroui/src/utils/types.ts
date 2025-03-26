export interface Message {
  id: string;
  clientId: string;
  content: string;
  timestamp: string;
  roomId: string;
}

export interface Room {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  creatorId: string;
} 