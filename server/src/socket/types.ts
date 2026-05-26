import type { Server, Socket } from 'socket.io';
import type { Logger } from '../logger';
import type { RoomStore } from '../repositories/store';
import type { AIModelOption } from '../types';
import type { AIClientWrapper } from '../services/aiClients';
import type { CocoAccessControl } from '../services/cocoAccessControl';
import type { CocoSessionService } from '../services/cocoSessionService';

export interface SocketHandlerDeps {
  io: Server;
  store: RoomStore;
  socketLogger: Logger;
  openaiLogger: Logger;
  normalizeAIModel: (requestedModel?: string) => AIModelOption;
  getAIClientForModel: (model: AIModelOption) => AIClientWrapper;
  cocoSessionService?: CocoSessionService;
  cocoAccess?: CocoAccessControl;
}

export interface SocketConnectionContext extends SocketHandlerDeps {
  socket: Socket;
}
