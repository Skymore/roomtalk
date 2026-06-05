import type { Server, Socket } from 'socket.io';
import type { Logger } from '../logger';
import type { RoomStore } from '../repositories/store';
import type { AIModelOption } from '../types';
import type { AIClientWrapper } from '../services/aiClients';

export interface SocketHandlerDeps {
  io: Server;
  store: RoomStore;
  socketLogger: Logger;
  openaiLogger: Logger;
  normalizeAIModel: (requestedModel?: string) => AIModelOption;
  getAIClientForModel: (model: AIModelOption) => AIClientWrapper;
  assemblyAIApiKey?: string;
}

export interface SocketConnectionContext extends SocketHandlerDeps {
  socket: Socket;
}
