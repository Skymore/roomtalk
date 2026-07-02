import { createCocoAccessControl } from '../services/cocoAccessControl';
import { CodeWorkspaceAssetError } from '../services/codeWorkspaceAssetAccess';
import {
  CocoSandboxHandle,
  CocoWorkspaceChanges,
  CocoWorkspaceDiff,
  CocoWorkspaceDiffScope,
  CocoWorkspaceEntry,
  CocoWorkspaceFile,
  CocoWorkspacePreviewTargetResolution,
  CocoWorkspaceRefs,
  ResolveCocoWorkspacePreviewTargetInput,
} from '../services/cocoSandboxService';
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

type WorkspaceRefsAck = {
  success: boolean;
  refs?: CocoWorkspaceRefs;
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

type WorkspacePreviewViewportSetting =
  | { _tag: 'fill' }
  | { _tag: 'freeform'; width: number; height: number }
  | { _tag: 'preset'; width: number; height: number; presetId: string };

type WorkspacePreviewNavStatus =
  | { _tag: 'Idle' }
  | { _tag: 'Loading'; url: string; title: string }
  | { _tag: 'Success'; url: string; title: string }
  | { _tag: 'LoadFailed'; url: string; title: string; code: number; description: string };

type WorkspacePreviewSessionSnapshot = {
  roomId: string;
  tabId: string;
  navStatus: WorkspacePreviewNavStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  viewport: WorkspacePreviewViewportSetting;
  renderedViewport?: { width: number; height: number };
  updatedAt: string;
};

type WorkspacePreviewSessionAck = {
  success: boolean;
  session?: WorkspacePreviewSessionSnapshot;
  sessions?: WorkspacePreviewSessionSnapshot[];
  error?: string;
};

type WorkspacePreviewTarget =
  | { kind: 'url'; url: string }
  | ResolveCocoWorkspacePreviewTargetInput;

type WorkspacePreviewTargetResolution =
  | { requestedUrl: string; resolvedUrl: string; resolutionKind: 'direct' }
  | CocoWorkspacePreviewTargetResolution;

type WorkspacePreviewTargetAck = {
  success: boolean;
  target?: WorkspacePreviewTargetResolution;
  error?: string;
};

type WorkspacePreviewEvent = {
  type: 'opened' | 'navigated' | 'resized' | 'status' | 'refreshed' | 'closed';
  roomId: string;
  tabId: string;
  createdAt: string;
  snapshot?: WorkspacePreviewSessionSnapshot;
};

type WorkspacePreviewAutomationOperation =
  | 'status'
  | 'open'
  | 'navigate'
  | 'snapshot'
  | 'click'
  | 'type'
  | 'press'
  | 'scroll'
  | 'evaluate'
  | 'waitFor'
  | 'recordingStart'
  | 'recordingStop'
  | 'resize';

type WorkspacePreviewAutomationHostSnapshot = {
  roomId: string;
  clientId: string;
  connectionId: string;
  socketId: string;
  focused: boolean;
  supportedOperations: WorkspacePreviewAutomationOperation[];
  connectedAt: string;
  updatedAt: string;
};

type WorkspacePreviewAutomationHostRecord = WorkspacePreviewAutomationHostSnapshot & {
  emit: (event: string, payload: unknown) => void;
};

type WorkspacePreviewAutomationRequest = {
  requestId: string;
  roomId: string;
  tabId?: string;
  tabIdExplicit?: boolean;
  operation: WorkspacePreviewAutomationOperation;
  input: unknown;
  timeoutMs: number;
};

type WorkspacePreviewAutomationResponse = {
  clientId: string;
  connectionId: string;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: {
    _tag: string;
    message: string;
    detail?: unknown;
  };
};

type WorkspacePreviewAutomationAck = {
  success: boolean;
  connectionId?: string;
  host?: WorkspacePreviewAutomationHostSnapshot;
  hosts?: WorkspacePreviewAutomationHostSnapshot[];
  request?: WorkspacePreviewAutomationRequest;
  response?: WorkspacePreviewAutomationResponse;
  error?: string;
};

const WORKSPACE_ENTRY_LIMIT = 25000;
const WORKSPACE_ENTRY_DEPTH = 24;
const WORKSPACE_ENTRY_SEARCH_LIMIT = 200;
const WORKSPACE_REF_LIMIT = 200;
const PREVIEW_TAB_ID_MAX_LENGTH = 256;
const PREVIEW_TITLE_MAX_LENGTH = 512;
const PREVIEW_URL_MAX_LENGTH = 2048;
const PREVIEW_VIEWPORT_MIN_DIMENSION = 240;
const PREVIEW_VIEWPORT_MAX_DIMENSION = 3840;
const PREVIEW_VIEWPORT_MAX_AREA = 3840 * 2160;
const FILL_PREVIEW_VIEWPORT: WorkspacePreviewViewportSetting = { _tag: 'fill' };
const PREVIEW_AUTOMATION_CONNECTION_ID_MAX_LENGTH = 128;
const PREVIEW_AUTOMATION_REQUEST_ID_MAX_LENGTH = 128;
const PREVIEW_AUTOMATION_TIMEOUT_FALLBACK_MS = 15000;
const PREVIEW_AUTOMATION_TIMEOUT_MAX_MS = 60000;
const PREVIEW_AUTOMATION_OPERATIONS: WorkspacePreviewAutomationOperation[] = [
  'status',
  'open',
  'navigate',
  'snapshot',
  'click',
  'type',
  'press',
  'scroll',
  'evaluate',
  'waitFor',
  'recordingStart',
  'recordingStop',
  'resize',
];
const previewAutomationOperationSet = new Set<string>(PREVIEW_AUTOMATION_OPERATIONS);
const workspacePreviewSessionsByRoomId = new Map<string, Map<string, WorkspacePreviewSessionSnapshot>>();
const workspacePreviewHistoryByRoomAndTabId = new Map<string, string[]>();
const workspacePreviewAutomationHostsByRoomId = new Map<string, Map<string, WorkspacePreviewAutomationHostRecord>>();
const workspacePreviewAutomationPendingByRoomAndRequestId = new Map<string, {
  hostConnectionId: string;
  timeout: ReturnType<typeof setTimeout>;
  callback: (response: WorkspacePreviewAutomationAck) => void;
}>();
const parsePositiveIntegerEnv = (name: string, fallback: number) => {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const WORKSPACE_FILE_MAX_BYTES = parsePositiveIntegerEnv('COCO_WORKSPACE_FILE_READ_MAX_BYTES', 10 * 1024 * 1024);
const WORKSPACE_DIFF_MAX_BYTES = parsePositiveIntegerEnv('COCO_WORKSPACE_DIFF_READ_MAX_BYTES', 10 * 1024 * 1024);
const unavailableWorkspaceChanges: CocoWorkspaceChanges = {
  available: false,
  changedFiles: [],
  changedFileStats: [],
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

const parseWorkspaceBoolean = (payload: unknown, key: string): boolean => {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  return (payload as Record<string, unknown>)[key] === true;
};

const parsePreviewTabId = (payload: unknown): string | null => {
  const tabId = parseWorkspaceString(payload, 'tabId');
  return tabId && tabId.length <= PREVIEW_TAB_ID_MAX_LENGTH ? tabId : null;
};

const parsePreviewAutomationConnectionId = (payload: unknown): string | null => {
  const connectionId = parseWorkspaceString(payload, 'connectionId');
  return connectionId && connectionId.length <= PREVIEW_AUTOMATION_CONNECTION_ID_MAX_LENGTH ? connectionId : null;
};

const parsePreviewAutomationRequestId = (payload: unknown): string | null => {
  const requestId = parseWorkspaceString(payload, 'requestId');
  return requestId && requestId.length <= PREVIEW_AUTOMATION_REQUEST_ID_MAX_LENGTH ? requestId : null;
};

const parsePreviewAutomationOperation = (payload: unknown): WorkspacePreviewAutomationOperation | null => {
  const operation = parseWorkspaceString(payload, 'operation');
  return operation && previewAutomationOperationSet.has(operation)
    ? operation as WorkspacePreviewAutomationOperation
    : null;
};

const parsePreviewAutomationSupportedOperations = (payload: unknown): WorkspacePreviewAutomationOperation[] => {
  if (!payload || typeof payload !== 'object') {
    return [...PREVIEW_AUTOMATION_OPERATIONS];
  }
  const value = (payload as { supportedOperations?: unknown }).supportedOperations;
  if (!Array.isArray(value)) {
    return [...PREVIEW_AUTOMATION_OPERATIONS];
  }
  const operations = value
    .filter((operation): operation is WorkspacePreviewAutomationOperation => (
      typeof operation === 'string' && previewAutomationOperationSet.has(operation)
    ));
  return operations.length > 0 ? [...new Set(operations)] : [...PREVIEW_AUTOMATION_OPERATIONS];
};

const parsePreviewAutomationTimeout = (payload: unknown): number => {
  if (!payload || typeof payload !== 'object') {
    return PREVIEW_AUTOMATION_TIMEOUT_FALLBACK_MS;
  }
  const value = Number((payload as { timeoutMs?: unknown }).timeoutMs);
  if (!Number.isFinite(value) || value <= 0) {
    return PREVIEW_AUTOMATION_TIMEOUT_FALLBACK_MS;
  }
  return Math.min(PREVIEW_AUTOMATION_TIMEOUT_MAX_MS, Math.max(1, Math.round(value)));
};

const parsePreviewAutomationInput = (payload: unknown): unknown => (
  payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'input')
    ? (payload as { input?: unknown }).input
    : {}
);

const parsePreviewTitle = (payload: unknown): string => {
  const title = parseWorkspaceOptionalString(payload, 'title')?.trim() || '';
  return title.slice(0, PREVIEW_TITLE_MAX_LENGTH);
};

const parsePreviewUrl = (payload: unknown): string | null => {
  const value = parseWorkspaceOptionalString(payload, 'url')?.trim() || '';
  if (!value || value.length > PREVIEW_URL_MAX_LENGTH) {
    return null;
  }
  if (value.startsWith('/api/coco/workspace-assets/')) {
    return value;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};

const parsePreviewTargetPath = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= PREVIEW_URL_MAX_LENGTH ? trimmed : undefined;
};

const parsePreviewNavigationTarget = (payload: unknown): WorkspacePreviewTarget | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const target = (payload as { target?: unknown }).target;
  if (!target || typeof target !== 'object') {
    return null;
  }
  const kind = (target as { kind?: unknown }).kind;
  if (kind === 'url') {
    const url = parsePreviewUrl(target);
    return url ? { kind: 'url', url } : null;
  }
  if (kind !== 'environment-port') {
    return null;
  }
  const port = Number((target as { port?: unknown }).port);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    return null;
  }
  const rawProtocol = (target as { protocol?: unknown }).protocol;
  const protocol = rawProtocol === 'https' ? 'https' : rawProtocol === 'http' ? 'http' : undefined;
  return {
    kind: 'environment-port',
    port,
    ...(protocol ? { protocol } : {}),
    ...(Object.prototype.hasOwnProperty.call(target, 'path') ? { path: parsePreviewTargetPath((target as { path?: unknown }).path) ?? '/' } : {}),
  };
};

const parsePreviewNavStatus = (payload: unknown): WorkspacePreviewNavStatus | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const navStatus = (payload as { navStatus?: unknown }).navStatus;
  if (!navStatus || typeof navStatus !== 'object') {
    return null;
  }
  const status = navStatus as Record<string, unknown>;
  if (status._tag === 'Idle') {
    return { _tag: 'Idle' };
  }
  if (status._tag === 'Loading' || status._tag === 'Success' || status._tag === 'LoadFailed') {
    const url = parsePreviewUrl({ url: status.url });
    if (!url) {
      return null;
    }
    const title = typeof status.title === 'string'
      ? status.title.trim().slice(0, PREVIEW_TITLE_MAX_LENGTH)
      : '';
    if (status._tag === 'LoadFailed') {
      const rawCode = Number(status.code);
      return {
        _tag: 'LoadFailed',
        url,
        title,
        code: Number.isFinite(rawCode) ? Math.trunc(rawCode) : 0,
        description: typeof status.description === 'string'
          ? status.description.trim().slice(0, 1024)
          : 'Preview failed',
      };
    }
    return { _tag: status._tag, url, title };
  }
  return null;
};

const parsePreviewRenderedViewport = (
  payload: unknown,
): { width: number; height: number } | undefined => {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const renderedViewport = (payload as { renderedViewport?: unknown }).renderedViewport;
  if (!renderedViewport || typeof renderedViewport !== 'object') {
    return undefined;
  }
  const width = Number((renderedViewport as { width?: unknown }).width);
  const height = Number((renderedViewport as { height?: unknown }).height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  return { width: Math.round(width), height: Math.round(height) };
};

const clampPreviewViewportDimension = (value: unknown): number | null => {
  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    return null;
  }
  const rounded = Math.round(numberValue);
  return Math.min(
    PREVIEW_VIEWPORT_MAX_DIMENSION,
    Math.max(PREVIEW_VIEWPORT_MIN_DIMENSION, rounded)
  );
};

const parsePreviewViewport = (payload: unknown): WorkspacePreviewViewportSetting => {
  if (!payload || typeof payload !== 'object') {
    return FILL_PREVIEW_VIEWPORT;
  }
  const viewport = (payload as { viewport?: unknown }).viewport;
  if (!viewport || typeof viewport !== 'object') {
    return FILL_PREVIEW_VIEWPORT;
  }
  const candidate = viewport as Record<string, unknown>;
  if (candidate._tag === 'fill') {
    return FILL_PREVIEW_VIEWPORT;
  }
  const width = clampPreviewViewportDimension(candidate.width);
  const height = clampPreviewViewportDimension(candidate.height);
  if (width === null || height === null) {
    return FILL_PREVIEW_VIEWPORT;
  }
  const normalized = width * height <= PREVIEW_VIEWPORT_MAX_AREA
    ? { width, height }
    : width >= height
      ? {
        width: Math.max(PREVIEW_VIEWPORT_MIN_DIMENSION, Math.floor(PREVIEW_VIEWPORT_MAX_AREA / height)),
        height,
      }
      : {
        width,
        height: Math.max(PREVIEW_VIEWPORT_MIN_DIMENSION, Math.floor(PREVIEW_VIEWPORT_MAX_AREA / width)),
      };
  if (candidate._tag === 'preset' && typeof candidate.presetId === 'string' && candidate.presetId.trim()) {
    return {
      _tag: 'preset',
      presetId: candidate.presetId.trim().slice(0, 128),
      ...normalized,
    };
  }
  if (candidate._tag === 'freeform') {
    return { _tag: 'freeform', ...normalized };
  }
  return FILL_PREVIEW_VIEWPORT;
};

const previewHistoryKey = (roomId: string, tabId: string): string => `${roomId}\u0000${tabId}`;

const previewAutomationRequestKey = (roomId: string, requestId: string): string => `${roomId}\u0000${requestId}`;

const previewUrlFromStatus = (status: WorkspacePreviewNavStatus): string | null => (
  status._tag === 'Idle' ? null : status.url
);

const snapshotWithHistoryState = (
  snapshot: WorkspacePreviewSessionSnapshot,
): WorkspacePreviewSessionSnapshot => {
  const key = previewHistoryKey(snapshot.roomId, snapshot.tabId);
  const history = workspacePreviewHistoryByRoomAndTabId.get(key) || [];
  const currentUrl = previewUrlFromStatus(snapshot.navStatus);
  const currentIndex = currentUrl ? history.lastIndexOf(currentUrl) : -1;
  return {
    ...snapshot,
    canGoBack: currentIndex > 0,
    canGoForward: currentIndex >= 0 && currentIndex < history.length - 1,
  };
};

const rememberPreviewHistory = (
  roomId: string,
  tabId: string,
  url: string | null,
  mode: 'replace' | 'push' = 'push',
) => {
  if (!url) {
    return;
  }
  const key = previewHistoryKey(roomId, tabId);
  const current = workspacePreviewHistoryByRoomAndTabId.get(key) || [];
  if (mode === 'replace' && current.length > 0) {
    workspacePreviewHistoryByRoomAndTabId.set(key, [...current.slice(0, -1), url]);
    return;
  }
  if (current[current.length - 1] === url) {
    return;
  }
  workspacePreviewHistoryByRoomAndTabId.set(key, [...current, url]);
};

const parseWorkspaceDiffScope = (payload: unknown): CocoWorkspaceDiffScope => {
  if (!payload || typeof payload !== 'object') {
    return 'branch';
  }
  return (payload as Record<string, unknown>).scope === 'unstaged' ? 'unstaged' : 'branch';
};

const parseWorkspacePositiveInteger = (payload: unknown, key: string, fallback: number, max: number): number => {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }
  const value = Number.parseInt(String((payload as Record<string, unknown>)[key] ?? ''), 10);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(max, value);
};

export function registerCodeAgentWorkspaceHandlers({
  io,
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

  const loadWorkspaceSnapshotState = async (room: Room): Promise<{
    changes: CocoWorkspaceChanges;
    workspaceRoot: string | null;
  }> => {
    if (!cocoSandboxService || !room.sandboxId || room.sandboxStatus !== 'ready') {
      return { changes: unavailableWorkspaceChanges, workspaceRoot: null };
    }
    try {
      const workspace = await connectReadyWorkspace(room);
      if (!workspace.success) {
        return { changes: unavailableWorkspaceChanges, workspaceRoot: null };
      }
      const workspaceRoot = workspace.handle.workspace || null;
      if (!cocoSandboxService.getWorkspaceChanges) {
        return { changes: unavailableWorkspaceChanges, workspaceRoot };
      }
      try {
        return {
          changes: await cocoSandboxService.getWorkspaceChanges(workspace.handle),
          workspaceRoot,
        };
      } catch (error) {
        socketLogger.warn('Failed to load code workspace changes', { error, roomId: room.id, socketId: socket.id });
        return { changes: unavailableWorkspaceChanges, workspaceRoot };
      }
    } catch (error) {
      socketLogger.warn('Failed to connect code workspace for snapshot', { error, roomId: room.id, socketId: socket.id });
      return { changes: unavailableWorkspaceChanges, workspaceRoot: null };
    }
  };

  const resolveWorkspacePreviewTarget = async (
    room: Room,
    target: WorkspacePreviewTarget
  ): Promise<WorkspacePreviewTargetResolution> => {
    if (target.kind === 'url') {
      return {
        requestedUrl: target.url,
        resolvedUrl: target.url,
        resolutionKind: 'direct',
      };
    }
    if (!cocoSandboxService?.resolveWorkspacePreviewTarget) {
      throw new Error('Workspace preview port targets are unavailable for this sandbox');
    }
    const workspace = await connectReadyWorkspace(room);
    if (!workspace.success) {
      throw new Error(workspace.error);
    }
    return cocoSandboxService.resolveWorkspacePreviewTarget(workspace.handle, target);
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

  const getPreviewSessionsForRoom = (roomId: string): Map<string, WorkspacePreviewSessionSnapshot> => {
    const existing = workspacePreviewSessionsByRoomId.get(roomId);
    if (existing) {
      return existing;
    }
    const sessions = new Map<string, WorkspacePreviewSessionSnapshot>();
    workspacePreviewSessionsByRoomId.set(roomId, sessions);
    return sessions;
  };

  const getPreviewAutomationHostsForRoom = (roomId: string): Map<string, WorkspacePreviewAutomationHostRecord> => {
    const existing = workspacePreviewAutomationHostsByRoomId.get(roomId);
    if (existing) {
      return existing;
    }
    const hosts = new Map<string, WorkspacePreviewAutomationHostRecord>();
    workspacePreviewAutomationHostsByRoomId.set(roomId, hosts);
    return hosts;
  };

  const publicPreviewAutomationHost = (
    host: WorkspacePreviewAutomationHostRecord,
  ): WorkspacePreviewAutomationHostSnapshot => ({
    roomId: host.roomId,
    clientId: host.clientId,
    connectionId: host.connectionId,
    socketId: host.socketId,
    focused: host.focused,
    supportedOperations: host.supportedOperations,
    connectedAt: host.connectedAt,
    updatedAt: host.updatedAt,
  });

  const listPreviewAutomationHosts = (roomId: string): WorkspacePreviewAutomationHostSnapshot[] => (
    [...getPreviewAutomationHostsForRoom(roomId).values()].map(publicPreviewAutomationHost)
  );

  const emitPreviewAutomationEvent = (
    host: WorkspacePreviewAutomationHostRecord,
    event: unknown,
  ) => {
    host.emit('code_workspace_preview_automation_event', event);
  };

  const selectPreviewAutomationHost = (
    roomId: string,
    operation: WorkspacePreviewAutomationOperation,
  ): WorkspacePreviewAutomationHostRecord | null => {
    const candidates = [...getPreviewAutomationHostsForRoom(roomId).values()]
      .filter((host) => host.supportedOperations.includes(operation));
    if (candidates.length === 0) {
      return null;
    }
    return candidates.sort((left, right) => {
      if (left.focused !== right.focused) {
        return left.focused ? -1 : 1;
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    })[0] || null;
  };

  const cleanupPreviewAutomationSocket = (socketId: string) => {
    const removedConnections = new Set<string>();
    for (const [roomId, hosts] of workspacePreviewAutomationHostsByRoomId.entries()) {
      for (const [connectionId, host] of hosts.entries()) {
        if (host.socketId !== socketId) {
          continue;
        }
        hosts.delete(connectionId);
        removedConnections.add(connectionId);
        io.to(roomId).emit('code_workspace_preview_automation_host_event', {
          type: 'disconnected',
          roomId,
          connectionId,
          createdAt: new Date().toISOString(),
        });
      }
      if (hosts.size === 0) {
        workspacePreviewAutomationHostsByRoomId.delete(roomId);
      }
    }
    if (removedConnections.size === 0) {
      return;
    }
    for (const [key, pending] of workspacePreviewAutomationPendingByRoomAndRequestId.entries()) {
      if (!removedConnections.has(pending.hostConnectionId)) {
        continue;
      }
      clearTimeout(pending.timeout);
      workspacePreviewAutomationPendingByRoomAndRequestId.delete(key);
      pending.callback({
        success: false,
        error: 'Preview automation host disconnected',
      });
    }
  };

  const emitPreviewEvent = (event: WorkspacePreviewEvent) => {
    io.to(event.roomId).emit('code_workspace_preview_event', event);
  };

  const putPreviewSession = (
    roomId: string,
    tabId: string,
    snapshot: WorkspacePreviewSessionSnapshot,
    eventType: WorkspacePreviewEvent['type'],
  ) => {
    const sessions = getPreviewSessionsForRoom(roomId);
    const nextSnapshot = snapshotWithHistoryState(snapshot);
    sessions.set(tabId, nextSnapshot);
    emitPreviewEvent({
      type: eventType,
      roomId,
      tabId,
      createdAt: nextSnapshot.updatedAt,
      snapshot: nextSnapshot,
    });
    return nextSnapshot;
  };

  const buildPreviewSnapshot = (input: {
    roomId: string;
    tabId: string;
    navStatus: WorkspacePreviewNavStatus;
    viewport?: WorkspacePreviewViewportSetting;
    renderedViewport?: { width: number; height: number };
  }): WorkspacePreviewSessionSnapshot => ({
    roomId: input.roomId,
    tabId: input.tabId,
    navStatus: input.navStatus,
    canGoBack: false,
    canGoForward: false,
    viewport: input.viewport ?? FILL_PREVIEW_VIEWPORT,
    ...(input.renderedViewport ? { renderedViewport: input.renderedViewport } : {}),
    updatedAt: new Date().toISOString(),
  });

  socket.on('open_code_workspace_preview_session', async (payload: unknown, callback?: (response: WorkspacePreviewSessionAck) => void) => {
    const roomId = parseRoomId(payload);
    const tabId = parsePreviewTabId(payload) || `browser:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
    const url = parsePreviewUrl(payload);
    const title = parsePreviewTitle(payload);
    const viewport = parsePreviewViewport(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'open code workspace preview');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (parseWorkspaceOptionalString(payload, 'url') && !url) {
        callback?.({ success: false, error: 'Preview URL is invalid' });
        return;
      }
      rememberPreviewHistory(access.room.id, tabId, url);
      const session = putPreviewSession(access.room.id, tabId, buildPreviewSnapshot({
        roomId: access.room.id,
        tabId,
        navStatus: url ? { _tag: 'Loading', url, title } : { _tag: 'Idle' },
        viewport,
      }), 'opened');
      callback?.({ success: true, session });
    } catch (error) {
      socketLogger.error('Failed to open code workspace preview session', { error, clientId, roomId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to open workspace preview' });
    }
  });

  socket.on('navigate_code_workspace_preview_session', async (payload: unknown, callback?: (response: WorkspacePreviewSessionAck) => void) => {
    const roomId = parseRoomId(payload);
    const tabId = parsePreviewTabId(payload);
    const url = parsePreviewUrl(payload);
    const title = parsePreviewTitle(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'navigate code workspace preview');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!tabId) {
        callback?.({ success: false, error: 'Preview tab ID is required' });
        return;
      }
      if (!url) {
        callback?.({ success: false, error: 'Preview URL is invalid' });
        return;
      }
      const existing = getPreviewSessionsForRoom(access.room.id).get(tabId);
      rememberPreviewHistory(access.room.id, tabId, url);
      const session = putPreviewSession(access.room.id, tabId, buildPreviewSnapshot({
        roomId: access.room.id,
        tabId,
        navStatus: { _tag: 'Loading', url, title },
        viewport: existing?.viewport ?? FILL_PREVIEW_VIEWPORT,
        renderedViewport: existing?.renderedViewport,
      }), 'navigated');
      callback?.({ success: true, session });
    } catch (error) {
      socketLogger.error('Failed to navigate code workspace preview session', { error, clientId, roomId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to navigate workspace preview' });
    }
  });

  socket.on('resize_code_workspace_preview_session', async (payload: unknown, callback?: (response: WorkspacePreviewSessionAck) => void) => {
    const roomId = parseRoomId(payload);
    const tabId = parsePreviewTabId(payload);
    const viewport = parsePreviewViewport(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'resize code workspace preview');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!tabId) {
        callback?.({ success: false, error: 'Preview tab ID is required' });
        return;
      }
      const existing = getPreviewSessionsForRoom(access.room.id).get(tabId);
      const session = putPreviewSession(access.room.id, tabId, {
        ...(existing ?? buildPreviewSnapshot({
          roomId: access.room.id,
          tabId,
          navStatus: { _tag: 'Idle' },
        })),
        viewport,
        updatedAt: new Date().toISOString(),
      }, 'resized');
      callback?.({ success: true, session });
    } catch (error) {
      socketLogger.error('Failed to resize code workspace preview session', { error, clientId, roomId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to resize workspace preview' });
    }
  });

  socket.on('report_code_workspace_preview_session', async (payload: unknown, callback?: (response: WorkspacePreviewSessionAck) => void) => {
    const roomId = parseRoomId(payload);
    const tabId = parsePreviewTabId(payload);
    const navStatus = parsePreviewNavStatus(payload);
    const renderedViewport = parsePreviewRenderedViewport(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'report code workspace preview status');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!tabId) {
        callback?.({ success: false, error: 'Preview tab ID is required' });
        return;
      }
      if (!navStatus) {
        callback?.({ success: false, error: 'Preview status is invalid' });
        return;
      }
      const existing = getPreviewSessionsForRoom(access.room.id).get(tabId);
      rememberPreviewHistory(access.room.id, tabId, previewUrlFromStatus(navStatus), 'replace');
      const session = putPreviewSession(access.room.id, tabId, {
        ...(existing ?? buildPreviewSnapshot({
          roomId: access.room.id,
          tabId,
          navStatus: { _tag: 'Idle' },
        })),
        navStatus,
        ...(renderedViewport ? { renderedViewport } : {}),
        updatedAt: new Date().toISOString(),
      }, 'status');
      callback?.({ success: true, session });
    } catch (error) {
      socketLogger.error('Failed to report code workspace preview session', { error, clientId, roomId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to report workspace preview status' });
    }
  });

  socket.on('refresh_code_workspace_preview_session', async (payload: unknown, callback?: (response: WorkspacePreviewSessionAck) => void) => {
    const roomId = parseRoomId(payload);
    const tabId = parsePreviewTabId(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'refresh code workspace preview');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!tabId) {
        callback?.({ success: false, error: 'Preview tab ID is required' });
        return;
      }
      const existing = getPreviewSessionsForRoom(access.room.id).get(tabId);
      if (!existing) {
        callback?.({ success: false, error: 'Preview session not found' });
        return;
      }
      const refreshedUrl = previewUrlFromStatus(existing.navStatus);
      const session = putPreviewSession(access.room.id, tabId, {
        ...existing,
        navStatus: refreshedUrl
          ? { _tag: 'Loading', url: refreshedUrl, title: existing.navStatus._tag === 'Idle' ? '' : existing.navStatus.title }
          : existing.navStatus,
        updatedAt: new Date().toISOString(),
      }, 'refreshed');
      callback?.({ success: true, session });
    } catch (error) {
      socketLogger.error('Failed to refresh code workspace preview session', { error, clientId, roomId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to refresh workspace preview' });
    }
  });

  socket.on('list_code_workspace_preview_sessions', async (payload: unknown, callback?: (response: WorkspacePreviewSessionAck) => void) => {
    const roomId = parseRoomId(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'list code workspace previews');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      callback?.({
        success: true,
        sessions: [...getPreviewSessionsForRoom(access.room.id).values()],
      });
    } catch (error) {
      socketLogger.error('Failed to list code workspace preview sessions', { error, clientId, roomId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to list workspace previews' });
    }
  });

  socket.on('close_code_workspace_preview_session', async (payload: unknown, callback?: (response: WorkspacePreviewSessionAck) => void) => {
    const roomId = parseRoomId(payload);
    const tabId = parsePreviewTabId(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'close code workspace preview');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      const sessions = getPreviewSessionsForRoom(access.room.id);
      if (tabId) {
        sessions.delete(tabId);
        workspacePreviewHistoryByRoomAndTabId.delete(previewHistoryKey(access.room.id, tabId));
        emitPreviewEvent({
          type: 'closed',
          roomId: access.room.id,
          tabId,
          createdAt: new Date().toISOString(),
        });
      } else {
        for (const sessionTabId of sessions.keys()) {
          workspacePreviewHistoryByRoomAndTabId.delete(previewHistoryKey(access.room.id, sessionTabId));
          emitPreviewEvent({
            type: 'closed',
            roomId: access.room.id,
            tabId: sessionTabId,
            createdAt: new Date().toISOString(),
          });
        }
        sessions.clear();
      }
      callback?.({ success: true, sessions: [...sessions.values()] });
    } catch (error) {
      socketLogger.error('Failed to close code workspace preview session', { error, clientId, roomId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to close workspace preview' });
    }
  });

  socket.on('resolve_code_workspace_preview_target', async (payload: unknown, callback?: (response: WorkspacePreviewTargetAck) => void) => {
    const roomId = parseRoomId(payload);
    const target = parsePreviewNavigationTarget(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'resolve code workspace preview target');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!target) {
        callback?.({ success: false, error: 'Preview target is invalid' });
        return;
      }
      callback?.({
        success: true,
        target: await resolveWorkspacePreviewTarget(access.room, target),
      });
    } catch (error) {
      socketLogger.error('Failed to resolve code workspace preview target', { error, clientId, roomId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to resolve workspace preview target' });
    }
  });

  socket.on('connect_code_workspace_preview_automation', async (payload: unknown, callback?: (response: WorkspacePreviewAutomationAck) => void) => {
    const roomId = parseRoomId(payload);
    const requestedConnectionId = parsePreviewAutomationConnectionId(payload);
    const supportedOperations = parsePreviewAutomationSupportedOperations(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'connect code workspace preview automation');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }

      const now = new Date().toISOString();
      const hosts = getPreviewAutomationHostsForRoom(access.room.id);
      for (const [connectionId, host] of hosts.entries()) {
        if (host.socketId === socket.id || host.clientId === access.clientId) {
          hosts.delete(connectionId);
        }
      }
      const connectionId = requestedConnectionId || `preview-automation:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
      const host: WorkspacePreviewAutomationHostRecord = {
        roomId: access.room.id,
        clientId: access.clientId,
        connectionId,
        socketId: socket.id,
        focused: parseWorkspaceBoolean(payload, 'focused'),
        supportedOperations,
        connectedAt: now,
        updatedAt: now,
        emit: (event, eventPayload) => {
          socket.emit(event, eventPayload);
        },
      };
      hosts.set(connectionId, host);

      const publicHost = publicPreviewAutomationHost(host);
      emitPreviewAutomationEvent(host, {
        type: 'connected',
        roomId: access.room.id,
        connectionId,
        host: publicHost,
        createdAt: now,
      });
      io.to(access.room.id).emit('code_workspace_preview_automation_host_event', {
        type: 'connected',
        roomId: access.room.id,
        connectionId,
        host: publicHost,
        createdAt: now,
      });
      callback?.({ success: true, connectionId, host: publicHost });
    } catch (error) {
      socketLogger.error('Failed to connect code workspace preview automation', { error, clientId, roomId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to connect workspace preview automation' });
    }
  });

  socket.on('focus_code_workspace_preview_automation', async (payload: unknown, callback?: (response: WorkspacePreviewAutomationAck) => void) => {
    const roomId = parseRoomId(payload);
    const connectionId = parsePreviewAutomationConnectionId(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'focus code workspace preview automation');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!connectionId) {
        callback?.({ success: false, error: 'Preview automation connection ID is required' });
        return;
      }
      const hosts = getPreviewAutomationHostsForRoom(access.room.id);
      const host = hosts.get(connectionId);
      if (!host || host.clientId !== access.clientId) {
        callback?.({ success: false, error: 'Preview automation host is not connected' });
        return;
      }
      const updated: WorkspacePreviewAutomationHostRecord = {
        ...host,
        focused: parseWorkspaceBoolean(payload, 'focused'),
        updatedAt: new Date().toISOString(),
      };
      hosts.set(connectionId, updated);
      const publicHost = publicPreviewAutomationHost(updated);
      io.to(access.room.id).emit('code_workspace_preview_automation_host_event', {
        type: 'focused',
        roomId: access.room.id,
        connectionId,
        host: publicHost,
        createdAt: updated.updatedAt,
      });
      callback?.({ success: true, connectionId, host: publicHost });
    } catch (error) {
      socketLogger.error('Failed to focus code workspace preview automation', { error, clientId, roomId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to focus workspace preview automation' });
    }
  });

  socket.on('list_code_workspace_preview_automation_hosts', async (payload: unknown, callback?: (response: WorkspacePreviewAutomationAck) => void) => {
    const roomId = parseRoomId(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'list code workspace preview automation hosts');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      callback?.({ success: true, hosts: listPreviewAutomationHosts(access.room.id) });
    } catch (error) {
      socketLogger.error('Failed to list code workspace preview automation hosts', { error, clientId, roomId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to list workspace preview automation hosts' });
    }
  });

  socket.on('request_code_workspace_preview_automation', async (payload: unknown, callback?: (response: WorkspacePreviewAutomationAck) => void) => {
    const roomId = parseRoomId(payload);
    const operation = parsePreviewAutomationOperation(payload);
    const tabId = parsePreviewTabId(payload) || undefined;
    const requestId = parsePreviewAutomationRequestId(payload) || `preview-request:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
    const timeoutMs = parsePreviewAutomationTimeout(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'request code workspace preview automation');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!operation) {
        callback?.({ success: false, error: 'Preview automation operation is invalid' });
        return;
      }
      const host = selectPreviewAutomationHost(access.room.id, operation);
      if (!host) {
        callback?.({ success: false, error: `No preview automation host supports ${operation}` });
        return;
      }

      const request: WorkspacePreviewAutomationRequest = {
        requestId,
        roomId: access.room.id,
        ...(tabId ? { tabId, tabIdExplicit: true } : {}),
        operation,
        input: parsePreviewAutomationInput(payload),
        timeoutMs,
      };
      const requestKey = previewAutomationRequestKey(access.room.id, requestId);
      if (workspacePreviewAutomationPendingByRoomAndRequestId.has(requestKey)) {
        callback?.({ success: false, error: 'Preview automation request ID is already pending' });
        return;
      }

      const timeout = setTimeout(() => {
        workspacePreviewAutomationPendingByRoomAndRequestId.delete(requestKey);
        callback?.({ success: false, error: `Preview automation ${operation} timed out` });
      }, timeoutMs);
      workspacePreviewAutomationPendingByRoomAndRequestId.set(requestKey, {
        hostConnectionId: host.connectionId,
        timeout,
        callback: (response) => callback?.(response),
      });
      try {
        emitPreviewAutomationEvent(host, {
          type: 'request',
          roomId: access.room.id,
          connectionId: host.connectionId,
          request,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        clearTimeout(timeout);
        workspacePreviewAutomationPendingByRoomAndRequestId.delete(requestKey);
        throw error;
      }
    } catch (error) {
      socketLogger.error('Failed to request code workspace preview automation', { error, clientId, roomId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to request workspace preview automation' });
    }
  });

  socket.on('respond_code_workspace_preview_automation', async (payload: unknown, callback?: (response: WorkspacePreviewAutomationAck) => void) => {
    const roomId = parseRoomId(payload);
    const connectionId = parsePreviewAutomationConnectionId(payload);
    const requestId = parsePreviewAutomationRequestId(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'respond to code workspace preview automation');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!connectionId) {
        callback?.({ success: false, error: 'Preview automation connection ID is required' });
        return;
      }
      if (!requestId) {
        callback?.({ success: false, error: 'Preview automation request ID is required' });
        return;
      }
      const host = getPreviewAutomationHostsForRoom(access.room.id).get(connectionId);
      if (!host || host.clientId !== access.clientId) {
        callback?.({ success: false, error: 'Preview automation host is not connected' });
        return;
      }
      const rawError = payload && typeof payload === 'object'
        ? (payload as { error?: unknown }).error
        : undefined;
      const response: WorkspacePreviewAutomationResponse = {
        clientId: access.clientId,
        connectionId,
        requestId,
        ok: parseWorkspaceBoolean(payload, 'ok'),
        ...(payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'result')
          ? { result: (payload as { result?: unknown }).result }
          : {}),
        ...(rawError && typeof rawError === 'object' && typeof (rawError as { message?: unknown }).message === 'string'
          ? {
            error: {
              _tag: typeof (rawError as { _tag?: unknown })._tag === 'string'
                ? String((rawError as { _tag: string })._tag).slice(0, 128)
                : 'PreviewAutomationExecutionError',
              message: String((rawError as { message: string }).message).slice(0, 2048),
              ...(Object.prototype.hasOwnProperty.call(rawError, 'detail') ? { detail: (rawError as { detail?: unknown }).detail } : {}),
            },
          }
          : {}),
      };
      const requestKey = previewAutomationRequestKey(access.room.id, requestId);
      const pending = workspacePreviewAutomationPendingByRoomAndRequestId.get(requestKey);
      if (pending) {
        if (pending.hostConnectionId !== connectionId) {
          callback?.({ success: false, error: 'Preview automation response came from the wrong host' });
          return;
        }
        clearTimeout(pending.timeout);
        workspacePreviewAutomationPendingByRoomAndRequestId.delete(requestKey);
        pending.callback({ success: true, response });
      }
      io.to(access.room.id).emit('code_workspace_preview_automation_response', {
        roomId: access.room.id,
        connectionId,
        requestId,
        response,
        createdAt: new Date().toISOString(),
      });
      callback?.({ success: true, response });
    } catch (error) {
      socketLogger.error('Failed to respond to code workspace preview automation', { error, clientId, roomId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to respond to workspace preview automation' });
    }
  });

  socket.on('disconnect', () => {
    cleanupPreviewAutomationSocket(socket.id);
  });

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
      const workspaceState = await loadWorkspaceSnapshotState(access.room);
      const artifacts = await loadPublishedArtifacts(access.room);

      callback?.({
        success: true,
        snapshot: buildCodeAgentWorkspaceSnapshot(
          access.room,
          messages,
          new Date(),
          workspaceState.changes,
          artifacts,
          workspaceState.workspaceRoot,
        ),
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

  socket.on('search_code_workspace_entries', async (payload: unknown, callback?: (response: WorkspaceEntriesAck) => void) => {
    const roomId = parseRoomId(payload);
    const query = parseWorkspaceString(payload, 'query') || '';
    const limit = parseWorkspacePositiveInteger(payload, 'limit', WORKSPACE_ENTRY_SEARCH_LIMIT, WORKSPACE_ENTRY_SEARCH_LIMIT);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'search code workspace');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!query.trim()) {
        callback?.({ success: true, entries: [], truncated: false });
        return;
      }
      if (!cocoSandboxService?.searchWorkspaceEntries) {
        callback?.({ success: false, error: 'Workspace file search is unavailable' });
        return;
      }
      const workspace = await connectReadyWorkspace(access.room);
      if (!workspace.success) {
        callback?.({ success: false, error: workspace.error });
        return;
      }

      const entries = await cocoSandboxService.searchWorkspaceEntries(workspace.handle, {
        query,
        maxDepth: WORKSPACE_ENTRY_DEPTH,
        maxEntries: limit + 1,
      });
      callback?.({
        success: true,
        entries: entries.slice(0, limit),
        truncated: entries.length > limit,
      });
    } catch (error) {
      socketLogger.error('Failed to search code workspace entries', { error, clientId, roomId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to search workspace files' });
    }
  });

  socket.on('list_code_workspace_refs', async (payload: unknown, callback?: (response: WorkspaceRefsAck) => void) => {
    const roomId = parseRoomId(payload);
    const query = parseWorkspaceOptionalString(payload, 'query')?.trim() || '';
    const limit = parseWorkspacePositiveInteger(payload, 'limit', WORKSPACE_REF_LIMIT, WORKSPACE_REF_LIMIT);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCocoRoom(roomId, 'list code workspace refs');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!cocoSandboxService?.listWorkspaceRefs) {
        callback?.({ success: false, error: 'Workspace refs are unavailable' });
        return;
      }
      const workspace = await connectReadyWorkspace(access.room);
      if (!workspace.success) {
        callback?.({ success: false, error: workspace.error });
        return;
      }

      callback?.({
        success: true,
        refs: await cocoSandboxService.listWorkspaceRefs(workspace.handle, {
          query,
          maxRefs: limit,
        }),
      });
    } catch (error) {
      socketLogger.error('Failed to list code workspace refs', { error, clientId, roomId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to load workspace refs' });
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
    const ignoreWhitespace = parseWorkspaceBoolean(payload, 'ignoreWhitespace');
    const scope = parseWorkspaceDiffScope(payload);
    const baseRef = parseWorkspaceOptionalString(payload, 'baseRef')?.trim() || undefined;
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
          ignoreWhitespace,
          scope,
          ...(scope === 'branch' && baseRef ? { baseRef } : {}),
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

      const previewFile = await cocoSandboxService.readWorkspaceFile(workspace.handle, path, { maxBytes: 1 });
      callback?.({
        success: true,
        asset: codeWorkspaceAssetAccess.issueAssetUrl({
          roomId: access.room.id,
          sandboxId: access.room.sandboxId!,
          path: previewFile.path,
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
