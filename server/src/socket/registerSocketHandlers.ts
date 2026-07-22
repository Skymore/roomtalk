import { Socket } from 'socket.io';
import { registerAIHandlers } from './aiHandlers';
import { registerCodeAgentWorkspaceHandlers } from './codeAgentWorkspaceHandlers';
import { registerMessageHandlers } from './messageHandlers';
import { registerRoomHandlers } from './roomHandlers';
import { registerTranscriptionHandlers } from './transcriptionHandlers';
import { SocketHandlerDeps } from './types';
import { resolveAuthenticatedSocketIdentity } from './socketIdentity';

export function registerSocketHandlers(deps: SocketHandlerDeps) {
  deps.io.on('connection', (socket: Socket) => {
    deps.socketLogger.info('Socket connected', { socketId: socket.id });

    const context = {
      ...deps,
      socket,
      resolveClientId: () => resolveAuthenticatedSocketIdentity({
        socket,
        store: deps.store,
        logger: deps.socketLogger,
      }),
    };
    registerRoomHandlers(context);
    registerMessageHandlers(context);
    registerCodeAgentWorkspaceHandlers(context);
    registerAIHandlers(context);
    registerTranscriptionHandlers(context);
  });
}
