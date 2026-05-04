import type { Server, Socket } from 'socket.io';
import type { Logger } from '../logger';
import type { RedisStore } from '../repositories/redisStore';
import type { AIModelOption } from '../types';
import type { AIClientWrapper } from '../services/aiClients';

export interface SocketHandlerDeps {
  io: Server;
  store: RedisStore;
  socketLogger: Logger;
  openaiLogger: Logger;
  normalizeAIModel: (requestedModel?: string) => AIModelOption;
  getAIClientForModel: (model: AIModelOption) => AIClientWrapper;
}

export interface SocketConnectionContext extends SocketHandlerDeps {
  socket: Socket;
}
