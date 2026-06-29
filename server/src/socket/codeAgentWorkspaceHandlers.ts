import { createCocoAccessControl } from '../services/cocoAccessControl';
import { CocoSandboxHandle } from '../services/cocoSandboxService';
import { buildCodeAgentWorkspaceSnapshot, CodeAgentWorkspaceSnapshot } from '../services/codeAgentWorkspace';
import { hasRoomAccess } from './roomAccess';
import { SocketConnectionContext } from './types';

type WorkspaceSnapshotAck = {
  success: boolean;
  snapshot?: CodeAgentWorkspaceSnapshot;
  error?: string;
};

const parseRoomId = (payload: unknown): string | null => {
  if (typeof payload === 'string') {
    return payload.trim() || null;
  }

  if (payload && typeof payload === 'object') {
    const roomId = (payload as { roomId?: unknown }).roomId;
    return typeof roomId === 'string' && roomId.trim() ? roomId.trim() : null;
  }

  return null;
};

export function registerCodeAgentWorkspaceHandlers({
  socket,
  store,
  socketLogger,
  cocoAccess = createCocoAccessControl({ enabled: false }),
  cocoSandboxService,
}: SocketConnectionContext) {
  socket.on('get_code_workspace_snapshot', async (payload: unknown, callback?: (response: WorkspaceSnapshotAck) => void) => {
    const roomId = parseRoomId(payload);
    let clientId: string | null = null;

    try {
      clientId = await store.getClientId(socket.id);

      if (!clientId) {
        socketLogger.warn('Unregistered client tried to refresh code workspace', { socketId: socket.id, roomId });
        callback?.({ success: false, error: 'You are not registered' });
        return;
      }

      if (!roomId) {
        callback?.({ success: false, error: 'Room ID is required' });
        return;
      }

      if (!(await hasRoomAccess(store, roomId, clientId))) {
        socketLogger.warn('Unauthorized code workspace refresh', { socketId: socket.id, clientId, roomId });
        callback?.({ success: false, error: 'You are not authorized to access this room' });
        return;
      }

      const access = cocoAccess.canUse(clientId);
      if (!access.allowed) {
        socketLogger.warn('Code workspace refresh rejected by rollout controls', {
          socketId: socket.id,
          clientId,
          roomId,
          reason: access.reason,
        });
        callback?.({ success: false, error: access.message || 'Coco is unavailable' });
        return;
      }

      const room = await store.getRoomById(roomId);
      if (!room) {
        callback?.({ success: false, error: 'Room not found' });
        return;
      }

      if (room.type !== 'coco') {
        callback?.({ success: false, error: 'Workspace snapshots are only available for Coco rooms' });
        return;
      }

      const messages = await store.readMessagesByRoom(roomId);
      let workspaceFiles: string[] = [];
      if (room.sandboxId && room.sandboxStatus === 'ready') {
        if (!cocoSandboxService?.listWorkspaceFiles) {
          callback?.({ success: false, error: 'Workspace file listing is unavailable' });
          return;
        }
        const handle: CocoSandboxHandle = await cocoSandboxService.connect(room.sandboxId);
        workspaceFiles = await cocoSandboxService.listWorkspaceFiles(handle, {
          maxDepth: 6,
          maxFiles: 200,
        });
      }

      callback?.({
        success: true,
        snapshot: buildCodeAgentWorkspaceSnapshot(room, messages, new Date(), workspaceFiles),
      });
    } catch (error) {
      socketLogger.error('Failed to build code workspace snapshot', { error, clientId, roomId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to load workspace snapshot' });
    }
  });
}
