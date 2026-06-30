import { createCocoAccessControl } from '../services/cocoAccessControl';
import { CodeWorkspaceAssetError } from '../services/codeWorkspaceAssetAccess';
import { CocoSandboxHandle, CocoWorkspaceChanges, CocoWorkspaceDiff, CocoWorkspaceEntry, CocoWorkspaceFile } from '../services/cocoSandboxService';
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

type WorkspaceDiffAck = {
  success: boolean;
  diff?: CocoWorkspaceDiff;
  error?: string;
};

type WorkspaceEntryAck = {
  success: boolean;
  entry?: CocoWorkspaceEntry;
  error?: string;
};

type WorkspaceAssetUrlAck = {
  success: boolean;
  asset?: {
    relativeUrl: string;
    expiresAt: string;
  };
  error?: string;
};

type WorkspaceMutationAck = {
  success: boolean;
  error?: string;
};

const WORKSPACE_ENTRY_LIMIT = 25000;
const WORKSPACE_ENTRY_DEPTH = 24;
const parsePositiveIntegerEnv = (name: string, fallback: number) => {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const WORKSPACE_FILE_MAX_BYTES = parsePositiveIntegerEnv('COCO_WORKSPACE_FILE_READ_MAX_BYTES', 10 * 1024 * 1024);
const WORKSPACE_DIFF_MAX_BYTES = parsePositiveIntegerEnv('COCO_WORKSPACE_DIFF_READ_MAX_BYTES', 10 * 1024 * 1024);
const unavailableWorkspaceChanges: CocoWorkspaceChanges = {
  available: false,
  changedFiles: [],
  diffSummary: null,
};

const firstHeaderValue = (value: string | string[] | undefined) => (
  Array.isArray(value) ? value[0] : value
);

const getSocketOrigin = (socket: SocketConnectionContext['socket']) => (
  firstHeaderValue(socket.handshake?.headers?.origin)
);

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

const parseWorkspaceString = (payload: unknown, key: string): string | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const parseWorkspaceOptionalString = (payload: unknown, key: string): string | undefined => {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
};

export function registerCodeAgentWorkspaceHandlers({
  socket,
  store,
  socketLogger,
  cocoAccess = createCocoAccessControl({ enabled: false }),
  cocoSandboxService,
  codeWorkspaceAssetAccess,
  publishedStaticSiteService,
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

  const loadWorkspaceChanges = async (room: Room): Promise<CocoWorkspaceChanges> => {
    if (!cocoSandboxService?.getWorkspaceChanges || !room.sandboxId || room.sandboxStatus !== 'ready') {
      return unavailableWorkspaceChanges;
    }
    try {
      const workspace = await connectReadyWorkspace(room);
      if (!workspace.success) {
        return unavailableWorkspaceChanges;
      }
      return await cocoSandboxService.getWorkspaceChanges(workspace.handle);
    } catch (error) {
      socketLogger.warn('Failed to load code workspace changes', { error, roomId: room.id, socketId: socket.id });
      return unavailableWorkspaceChanges;
    }
  };

  const loadPublishedArtifacts = async (room: Room) => {
    if (!publishedStaticSiteService?.listSitesForRoom) {
      return [];
    }
    try {
      return await publishedStaticSiteService.listSitesForRoom(
        room.id,
        publishedStaticSiteService.publicBaseUrlForRequest(getSocketOrigin(socket))
      );
    } catch (error) {
      socketLogger.warn('Failed to load code workspace artifacts', { error, roomId: room.id, socketId: socket.id });
      return [];
    }
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
      const changes = await loadWorkspaceChanges(access.room);
      const artifacts = await loadPublishedArtifacts(access.room);

      callback?.({
        success: true,
        snapshot: buildCodeAgentWorkspaceSnapshot(access.room, messages, new Date(), changes, artifacts),
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

  socket.on('read_code_workspace_diff', async (payload: unknown, callback?: (response: WorkspaceDiffAck) => void) => {
    const roomId = parseRoomId(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'read code workspace diff');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!cocoSandboxService?.getWorkspaceDiff) {
        callback?.({ success: false, error: 'Workspace diff viewing is unavailable' });
        return;
      }
      const workspace = await connectReadyWorkspace(access.room);
      if (!workspace.success) {
        callback?.({ success: false, error: workspace.error });
        return;
      }

      callback?.({
        success: true,
        diff: await cocoSandboxService.getWorkspaceDiff(workspace.handle, {
          maxBytes: WORKSPACE_DIFF_MAX_BYTES,
        }),
      });
    } catch (error) {
      socketLogger.error('Failed to read code workspace diff', { error, clientId, roomId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to read workspace diff' });
    }
  });

  socket.on('create_code_workspace_asset_url', async (payload: unknown, callback?: (response: WorkspaceAssetUrlAck) => void) => {
    const roomId = parseRoomId(payload);
    const path = parseWorkspacePath(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'create code workspace asset URL');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!path) {
        callback?.({ success: false, error: 'File path is required' });
        return;
      }
      if (!codeWorkspaceAssetAccess) {
        callback?.({ success: false, error: 'Workspace file preview is unavailable' });
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

      await cocoSandboxService.readWorkspaceFile(workspace.handle, path, { maxBytes: 1 });
      callback?.({
        success: true,
        asset: codeWorkspaceAssetAccess.issueAssetUrl({
          roomId: access.room.id,
          sandboxId: access.room.sandboxId!,
          path,
        }),
      });
    } catch (error) {
      if (error instanceof CodeWorkspaceAssetError) {
        callback?.({ success: false, error: error.message });
        return;
      }
      socketLogger.error('Failed to create code workspace asset URL', { error, clientId, roomId, path, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to create workspace file preview URL' });
    }
  });

  socket.on('write_code_workspace_file', async (payload: unknown, callback?: (response: WorkspaceEntryAck) => void) => {
    const roomId = parseRoomId(payload);
    const path = parseWorkspacePath(payload);
    const content = parseWorkspaceOptionalString(payload, 'content');
    const encoding = parseWorkspaceOptionalString(payload, 'encoding');
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'write code workspace file');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!path) {
        callback?.({ success: false, error: 'File path is required' });
        return;
      }
      if (content === undefined) {
        callback?.({ success: false, error: 'File content is required' });
        return;
      }
      if (encoding !== undefined && encoding !== 'utf-8' && encoding !== 'base64') {
        callback?.({ success: false, error: 'File encoding is invalid' });
        return;
      }
      if (!cocoSandboxService?.writeWorkspaceFile) {
        callback?.({ success: false, error: 'Workspace file writing is unavailable' });
        return;
      }
      const workspace = await connectReadyWorkspace(access.room);
      if (!workspace.success) {
        callback?.({ success: false, error: workspace.error });
        return;
      }

      callback?.({
        success: true,
        entry: await cocoSandboxService.writeWorkspaceFile(workspace.handle, {
          path,
          content,
          encoding: encoding === 'base64' ? 'base64' : 'utf-8',
        }),
      });
    } catch (error) {
      socketLogger.error('Failed to write code workspace file', { error, clientId, roomId, path, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to write workspace file' });
    }
  });

  socket.on('create_code_workspace_directory', async (payload: unknown, callback?: (response: WorkspaceEntryAck) => void) => {
    const roomId = parseRoomId(payload);
    const path = parseWorkspacePath(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'create code workspace directory');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!path) {
        callback?.({ success: false, error: 'Directory path is required' });
        return;
      }
      if (!cocoSandboxService?.createWorkspaceDirectory) {
        callback?.({ success: false, error: 'Workspace directory creation is unavailable' });
        return;
      }
      const workspace = await connectReadyWorkspace(access.room);
      if (!workspace.success) {
        callback?.({ success: false, error: workspace.error });
        return;
      }

      callback?.({
        success: true,
        entry: await cocoSandboxService.createWorkspaceDirectory(workspace.handle, path),
      });
    } catch (error) {
      socketLogger.error('Failed to create code workspace directory', { error, clientId, roomId, path, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to create workspace directory' });
    }
  });

  socket.on('rename_code_workspace_entry', async (payload: unknown, callback?: (response: WorkspaceEntryAck) => void) => {
    const roomId = parseRoomId(payload);
    const fromPath = parseWorkspaceString(payload, 'fromPath');
    const toPath = parseWorkspaceString(payload, 'toPath');
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'rename code workspace entry');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!fromPath || !toPath) {
        callback?.({ success: false, error: 'Source and destination paths are required' });
        return;
      }
      if (!cocoSandboxService?.renameWorkspaceEntry) {
        callback?.({ success: false, error: 'Workspace entry rename is unavailable' });
        return;
      }
      const workspace = await connectReadyWorkspace(access.room);
      if (!workspace.success) {
        callback?.({ success: false, error: workspace.error });
        return;
      }

      callback?.({
        success: true,
        entry: await cocoSandboxService.renameWorkspaceEntry(workspace.handle, { fromPath, toPath }),
      });
    } catch (error) {
      socketLogger.error('Failed to rename code workspace entry', { error, clientId, roomId, fromPath, toPath, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to rename workspace entry' });
    }
  });

  socket.on('delete_code_workspace_entry', async (payload: unknown, callback?: (response: WorkspaceMutationAck) => void) => {
    const roomId = parseRoomId(payload);
    const path = parseWorkspacePath(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'delete code workspace entry');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!path) {
        callback?.({ success: false, error: 'Workspace path is required' });
        return;
      }
      if (!cocoSandboxService?.deleteWorkspaceEntry) {
        callback?.({ success: false, error: 'Workspace entry deletion is unavailable' });
        return;
      }
      const workspace = await connectReadyWorkspace(access.room);
      if (!workspace.success) {
        callback?.({ success: false, error: workspace.error });
        return;
      }

      await cocoSandboxService.deleteWorkspaceEntry(workspace.handle, path);
      callback?.({ success: true });
    } catch (error) {
      socketLogger.error('Failed to delete code workspace entry', { error, clientId, roomId, path, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to delete workspace entry' });
    }
  });
}
