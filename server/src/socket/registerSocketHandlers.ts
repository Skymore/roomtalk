import { Socket } from 'socket.io';
import { registerAIHandlers } from './aiHandlers';
import { registerMediaHandlers } from './mediaHandlers';
import { registerMessageHandlers } from './messageHandlers';
import { registerRoomHandlers } from './roomHandlers';
import { SocketHandlerDeps } from './types';

export function registerSocketHandlers(deps: SocketHandlerDeps) {
  deps.io.on('connection', (socket: Socket) => {
    deps.socketLogger.info('Socket connected', { socketId: socket.id });

    const context = { ...deps, socket };
    registerRoomHandlers(context);
    registerMessageHandlers(context);
    registerMediaHandlers(context);
    registerAIHandlers(context);
  });
}
