import type { Server, Socket } from 'socket.io';
import type { Logger } from '../logger';
import type { RoomStore } from '../repositories/store';
import type { AIModelOption } from '../types';
import type { AIClientWrapper } from '../services/aiClients';
import type { CocoAccessControl } from '../services/cocoAccessControl';
import type { CocoSandboxService } from '../services/cocoSandboxService';
import type { CocoSessionService } from '../services/cocoSessionService';
import type { PublishedStaticSiteService } from '../services/publishedStaticSite';

export interface SocketHandlerDeps {
  io: Server;
  store: RoomStore;
  socketLogger: Logger;
  openaiLogger: Logger;
  normalizeAIModel: (requestedModel?: string) => AIModelOption;
  getAIClientForModel: (model: AIModelOption) => AIClientWrapper;
  aiStreamOwnerId?: string;
  assemblyAIApiKey?: string;
  cocoSessionService?: CocoSessionService;
  cocoAccess?: CocoAccessControl;
  cocoSandboxService?: CocoSandboxService;
  publishedStaticSiteService?: PublishedStaticSiteService;
}

export interface SocketConnectionContext extends SocketHandlerDeps {
  socket: Socket;
}
