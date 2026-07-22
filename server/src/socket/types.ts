import type { Server, Socket } from 'socket.io';
import type { Logger } from '../logger';
import type { RoomStore } from '../repositories/store';
import type { AIModelOption } from '../types';
import type { AIClientWrapper } from '../services/aiClients';
import type { CodeAgentAccessControl } from '../services/codeAgentAccessControl';
import type { CodeAgentSandboxLifecycleService } from '../services/codeAgentSandboxLifecycle';
import type { CodeAgentSandboxService } from '../services/codeAgentSandboxService';
import type { CodeAgentSessionService } from '../services/codeAgentSessionService';
import type { CodeWorkspaceAssetAccess } from '../services/codeWorkspaceAssetAccess';
import type { PublishedStaticSiteService } from '../services/publishedStaticSite';
import type { AITerminalPersistReconciler } from '../services/aiTerminalPersistReconciler';

export interface SocketHandlerDeps {
  io: Server;
  store: RoomStore;
  socketLogger: Logger;
  openaiLogger: Logger;
  normalizeAIModel: (requestedModel?: string) => AIModelOption;
  getAIClientForModel: (model: AIModelOption) => AIClientWrapper;
  aiStreamOwnerId?: string;
  aiTerminalPersistReconciler?: Pick<AITerminalPersistReconciler, 'enqueue'>;
  assemblyAIApiKey?: string;
  codeAgentSessionService?: CodeAgentSessionService;
  codeAgentAccess?: CodeAgentAccessControl;
  codeAgentSandboxLifecycle?: Pick<CodeAgentSandboxLifecycleService, 'ensureReadySandbox'>;
  codeAgentSandboxService?: CodeAgentSandboxService;
  codeWorkspaceAssetAccess?: CodeWorkspaceAssetAccess;
  publishedStaticSiteService?: PublishedStaticSiteService;
}

export interface SocketConnectionContext extends SocketHandlerDeps {
  socket: Socket;
  resolveClientId: () => Promise<string | null>;
}
