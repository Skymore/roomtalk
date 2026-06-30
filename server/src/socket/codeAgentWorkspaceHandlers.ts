import { createCocoAccessControl } from '../services/cocoAccessControl';
import { CocoSandboxHandle, CocoWorkspaceEntry, CocoWorkspaceFile } from '../services/cocoSandboxService';
import { buildCodeAgentWorkspaceSnapshot, CodeAgentWorkspaceSnapshot } from '../services/codeAgentWorkspace';
import { Room } from '../types';
import { hasRoomAccess } from './roomAccess';
import { SocketConnectionContext } from './types';

type WorkspaceSnapshotAck = {
  success: boolean;
  snapshot?: CodeAgentWorkspaceSnapshot;
  error?: string;
};

type WorkspaceEntriesAck = {
  success: boolean;
  entries?: CocoWorkspaceEntry[];
  truncated?: boolean;
  error?: string;
};

type WorkspaceFileAck = {
  success: boolean;
  file?: CocoWorkspaceFile;
  error?: string;
};

const WORKSPACE_ENTRY_LIMIT = 25000;
const WORKSPACE_ENTRY_DEPTH = 24;
const WORKSPACE_FILE_MAX_BYTES = 1024 * 1024;

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

const parseWorkspacePath = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const path = (payload as { path?: unknown }).path;
  return typeof path === 'string' && path.trim() ? path.trim() : null;
};

export function registerCodeAgentWorkspaceHandlers({
  socket,
  store,
  socketLogger,
  cocoAccess = createCocoAccessControl({ enabled: false }),
  cocoSandboxService,
}: SocketConnectionContext) {
  const loadAuthorizedCocoRoom = async (
    roomId: string | null,
    action: string
  ): Promise<{ success: true; clientId: string; room: Room } | { success: false; error: string; clientId?: string | null }> => {
    const clientId = await store.getClientId(socket.id);

    if (!clientId) {
      socketLogger.warn(`Unregistered client tried to ${action}`, { socketId: socket.id, roomId });
      return { success: false, error: 'You are not registered', clientId };
    }

    if (!roomId) {
      return { success: false, error: 'Room ID is required', clientId };
    }

    if (!(await hasRoomAccess(store, roomId, clientId))) {
      socketLogger.warn(`Unauthorized ${action}`, { socketId: socket.id, clientId, roomId });
      return { success: false, error: 'You are not authorized to access this room', clientId };
    }

    const access = cocoAccess.canUse(clientId);
    if (!access.allowed) {
      socketLogger.warn(`Code workspace ${action} rejected by rollout controls`, {
        socketId: socket.id,
        clientId,
        roomId,
        reason: access.reason,
      });
      return { success: false, error: access.message || 'Coco is unavailable', clientId };
    }

    const room = await store.getRoomById(roomId);
    if (!room) {
      return { success: false, error: 'Room not found', clientId };
    }

    if (room.type !== 'coco') {
      return { success: false, error: 'Code workspaces are only available for Coco rooms', clientId };
    }

    return { success: true, clientId, room };
  };

  const connectReadyWorkspace = async (
    room: Room
  ): Promise<{ success: true; handle: CocoSandboxHandle } | { success: false; error: string }> => {
    if (!room.sandboxId || room.sandboxStatus !== 'ready') {
      return { success: false, error: 'Workspace sandbox is not ready' };
    }
    if (!cocoSandboxService) {
      return { success: false, error: 'Workspace sandbox service is unavailable' };
    }
    return { success: true, handle: await cocoSandboxService.connect(room.sandboxId) };
  };

  socket.on('get_code_workspace_snapshot', async (payload: unknown, callback?: (response: WorkspaceSnapshotAck) => void) => {
    const roomId = parseRoomId(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'refresh code workspace');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      const messages = await store.readMessagesByRoom(access.room.id);

      callback?.({
        success: true,
        snapshot: buildCodeAgentWorkspaceSnapshot(access.room, messages, new Date()),
      });
    } catch (error) {
      socketLogger.error('Failed to build code workspace snapshot', { error, clientId, roomId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to load workspace snapshot' });
    }
  });

  socket.on('list_code_workspace_entries', async (payload: unknown, callback?: (response: WorkspaceEntriesAck) => void) => {
    const roomId = parseRoomId(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'browse code workspace');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!cocoSandboxService?.listWorkspaceEntries) {
        callback?.({ success: false, error: 'Workspace file browsing is unavailable' });
        return;
      }
      const workspace = await connectReadyWorkspace(access.room);
      if (!workspace.success) {
        callback?.({ success: false, error: workspace.error });
        return;
      }

      const entries = await cocoSandboxService.listWorkspaceEntries(workspace.handle, {
        maxDepth: WORKSPACE_ENTRY_DEPTH,
        maxEntries: WORKSPACE_ENTRY_LIMIT + 1,
      });
      callback?.({
        success: true,
        entries: entries.slice(0, WORKSPACE_ENTRY_LIMIT),
        truncated: entries.length > WORKSPACE_ENTRY_LIMIT,
      });
    } catch (error) {
      socketLogger.error('Failed to list code workspace entries', { error, clientId, roomId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to load workspace files' });
    }
  });

  socket.on('read_code_workspace_file', async (payload: unknown, callback?: (response: WorkspaceFileAck) => void) => {
    const roomId = parseRoomId(payload);
    const path = parseWorkspacePath(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'read code workspace file');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!path) {
        callback?.({ success: false, error: 'File path is required' });
        return;
      }
      if (!cocoSandboxService?.readWorkspaceFile) {
        callback?.({ success: false, error: 'Workspace file reading is unavailable' });
        return;
      }
      const workspace = await connectReadyWorkspace(access.room);
      if (!workspace.success) {
        callback?.({ success: false, error: workspace.error });
        return;
      }

      callback?.({
        success: true,
        file: await cocoSandboxService.readWorkspaceFile(workspace.handle, path, {
          maxBytes: WORKSPACE_FILE_MAX_BYTES,
        }),
      });
    } catch (error) {
      socketLogger.error('Failed to read code workspace file', { error, clientId, roomId, path, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to read workspace file' });
    }
  });
}
