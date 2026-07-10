import { createCodeAgentAccessControl } from '../services/codeAgentAccessControl';
import { CodeWorkspaceAssetError } from '../services/codeWorkspaceAssetAccess';
import { CodeWorkspaceFilePreview, CodeWorkspaceFilePreviewService } from '../services/codeWorkspaceFilePreview';
import {
  CodeAgentSandboxHandle,
  CodeAgentWorkspaceChanges,
  CodeAgentWorkspaceDiff,
  CodeAgentWorkspaceDiffScope,
  CodeAgentWorkspaceEntry,
  CodeAgentWorkspaceFile,
  CodeAgentWorkspacePreviewServer,
  CodeAgentWorkspacePreviewTargetResolution,
  CodeAgentWorkspaceRefs,
  CodeAgentWorkspaceTerminal,
  ResolveCodeAgentWorkspacePreviewTargetInput,
} from '../services/codeAgentSandboxService';
import { buildCodeAgentWorkspaceSnapshot, CodeAgentWorkspaceSnapshot } from '../services/codeAgentWorkspace';
import { CodeAgentRunnerApprovalDecision } from '../services/codeAgentRunnerProtocol';
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
  entries?: CodeAgentWorkspaceEntry[];
  truncated?: boolean;
  error?: string;
};

type WorkspaceFileAck = {
  success: boolean;
  file?: CodeAgentWorkspaceFile;
  error?: string;
};

type WorkspaceDiffAck = {
  success: boolean;
  diff?: CodeAgentWorkspaceDiff;
  error?: string;
};

type WorkspaceRefsAck = {
  success: boolean;
  refs?: CodeAgentWorkspaceRefs;
  error?: string;
};

type WorkspaceEntryAck = {
  success: boolean;
  entry?: CodeAgentWorkspaceEntry;
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

type WorkspaceFilePreviewAck = {
  success: boolean;
  preview?: CodeWorkspaceFilePreview;
  error?: string;
};

type WorkspaceMutationAck = {
  success: boolean;
  error?: string;
};

type CodeAgentControlAck = {
  success: boolean;
  error?: string;
};

type CodexThreadListAck = {
  success: boolean;
  threads?: unknown[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
  error?: string;
};

type CodexThreadReadAck = {
  success: boolean;
  thread?: unknown;
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
  | ResolveCodeAgentWorkspacePreviewTargetInput;

type WorkspacePreviewTargetResolution =
  | { requestedUrl: string; resolvedUrl: string; resolutionKind: 'direct' }
  | CodeAgentWorkspacePreviewTargetResolution;

type WorkspacePreviewTargetAck = {
  success: boolean;
  target?: WorkspacePreviewTargetResolution;
  error?: string;
};

type WorkspacePreviewServersAck = {
  success: boolean;
  servers?: CodeAgentWorkspacePreviewServer[];
  error?: string;
};

type WorkspaceTerminalStatus = 'running' | 'closed' | 'exited';

type WorkspaceTerminalSessionSnapshot = {
  roomId: string;
  terminalId: string;
  status: WorkspaceTerminalStatus;
  cols: number;
  rows: number;
  pid?: number;
  output: string;
  updatedAt: string;
};

type WorkspaceTerminalSessionAck = {
  success: boolean;
  session?: WorkspaceTerminalSessionSnapshot;
  sessions?: WorkspaceTerminalSessionSnapshot[];
  error?: string;
};

type WorkspaceTerminalEvent = {
  type: 'opened' | 'data' | 'resized' | 'closed' | 'exited';
  roomId: string;
  terminalId: string;
  createdAt: string;
  data?: string;
  snapshot?: WorkspaceTerminalSessionSnapshot;
};

type WorkspaceTerminalRuntime = WorkspaceTerminalSessionSnapshot & {
  terminal: CodeAgentWorkspaceTerminal;
};

type WorkspacePreviewEvent = {
  type: 'opened' | 'navigated' | 'resized' | 'status' | 'refreshed' | 'closed';
  roomId: string;
  tabId: string;
  createdAt: string;
  snapshot?: WorkspacePreviewSessionSnapshot;
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
const TERMINAL_ID_MAX_LENGTH = 128;
const TERMINAL_INPUT_MAX_LENGTH = 64 * 1024;
const TERMINAL_INPUT_ACCESS_CACHE_MS = 2_000;
const TERMINAL_OUTPUT_TAIL_MAX_LENGTH = 200 * 1024;
const TERMINAL_MIN_COLS = 20;
const TERMINAL_MAX_COLS = 500;
const TERMINAL_MIN_ROWS = 4;
const TERMINAL_MAX_ROWS = 200;
const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
const FILL_PREVIEW_VIEWPORT: WorkspacePreviewViewportSetting = { _tag: 'fill' };
const workspacePreviewSessionsByRoomId = new Map<string, Map<string, WorkspacePreviewSessionSnapshot>>();
const workspacePreviewHistoryByRoomAndTabId = new Map<string, string[]>();
const workspaceTerminalSessionsByRoomId = new Map<string, Map<string, WorkspaceTerminalRuntime>>();
const workspaceTerminalInputQueues = new WeakMap<CodeAgentWorkspaceTerminal, Promise<void>>();

const enqueueTerminalInput = async (terminal: CodeAgentWorkspaceTerminal, data: string): Promise<void> => {
  const previous = workspaceTerminalInputQueues.get(terminal) || Promise.resolve();
  const next = previous.catch(() => undefined).then(() => terminal.write(data));
  workspaceTerminalInputQueues.set(terminal, next);
  try {
    await next;
  } finally {
    if (workspaceTerminalInputQueues.get(terminal) === next) {
      workspaceTerminalInputQueues.delete(terminal);
    }
  }
};
const parsePositiveIntegerEnv = (name: string, fallback: number) => {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const WORKSPACE_FILE_MAX_BYTES = parsePositiveIntegerEnv('CODE_AGENT_WORKSPACE_FILE_READ_MAX_BYTES', 10 * 1024 * 1024);
const WORKSPACE_DIFF_MAX_BYTES = parsePositiveIntegerEnv('CODE_AGENT_WORKSPACE_DIFF_READ_MAX_BYTES', 10 * 1024 * 1024);
const unavailableWorkspaceChanges: CodeAgentWorkspaceChanges = {
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

const parseTerminalId = (payload: unknown): string | null => {
  const terminalId = parseWorkspaceString(payload, 'terminalId') || 'terminal';
  return terminalId.length <= TERMINAL_ID_MAX_LENGTH ? terminalId : null;
};

const parseTerminalInput = (payload: unknown): string | null => {
  const data = parseWorkspaceOptionalString(payload, 'data');
  if (data === undefined || data.length > TERMINAL_INPUT_MAX_LENGTH) {
    return null;
  }
  return data;
};

const parseTerminalSize = (payload: unknown): { cols: number; rows: number } => {
  if (!payload || typeof payload !== 'object') {
    return { cols: DEFAULT_TERMINAL_COLS, rows: DEFAULT_TERMINAL_ROWS };
  }
  const rawCols = Number((payload as { cols?: unknown }).cols);
  const rawRows = Number((payload as { rows?: unknown }).rows);
  const cols = Number.isFinite(rawCols)
    ? Math.max(TERMINAL_MIN_COLS, Math.min(TERMINAL_MAX_COLS, Math.trunc(rawCols)))
    : DEFAULT_TERMINAL_COLS;
  const rows = Number.isFinite(rawRows)
    ? Math.max(TERMINAL_MIN_ROWS, Math.min(TERMINAL_MAX_ROWS, Math.trunc(rawRows)))
    : DEFAULT_TERMINAL_ROWS;
  return { cols, rows };
};

const parsePreviewTitle = (payload: unknown): string => {
  const title = parseWorkspaceOptionalString(payload, 'title')?.trim() || '';
  return title.slice(0, PREVIEW_TITLE_MAX_LENGTH);
};

const parsePreviewUrl = (payload: unknown): string | null => {
  const value = parseWorkspaceOptionalString(payload, 'url')?.trim() || '';
  if (!value || value.length > PREVIEW_URL_MAX_LENGTH) {
    return null;
  }
  if (value.startsWith('/api/code-agent/workspace-assets/')) {
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

const parseWorkspaceDiffScope = (payload: unknown): CodeAgentWorkspaceDiffScope => {
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

const parseApprovalDecision = (payload: unknown): CodeAgentRunnerApprovalDecision | null => {
  const decision = parseWorkspaceString(payload, 'decision');
  if (decision === 'accept' || decision === 'acceptForSession' || decision === 'decline' || decision === 'cancel') {
    return decision;
  }
  return null;
};

export function registerCodeAgentWorkspaceHandlers({
  io,
  socket,
  store,
  socketLogger,
  codeAgentAccess = createCodeAgentAccessControl({ enabled: false }),
  codeAgentSandboxLifecycle,
  codeAgentSandboxService,
  codeAgentSessionService,
  codeWorkspaceAssetAccess,
  publishedStaticSiteService,
}: SocketConnectionContext) {
  const codeWorkspaceFilePreviewService = codeAgentSandboxService && codeWorkspaceAssetAccess
    ? new CodeWorkspaceFilePreviewService({
      sandboxService: codeAgentSandboxService,
      assetAccess: codeWorkspaceAssetAccess,
    })
    : null;

  const loadAuthorizedCodeAgentRoom = async (
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

    const access = codeAgentAccess.canUse(clientId);
    if (!access.allowed) {
      socketLogger.warn(`Code workspace ${action} rejected by rollout controls`, {
        socketId: socket.id,
        clientId,
        roomId,
        reason: access.reason,
      });
      return { success: false, error: access.message || 'Workspace is unavailable', clientId };
    }

    const room = await store.getRoomById(roomId);
    if (!room) {
      return { success: false, error: 'Room not found', clientId };
    }

    if (room.type !== 'codeAgent') {
      return { success: false, error: 'Code workspaces are only available for Workspace rooms', clientId };
    }

    return { success: true, clientId, room };
  };

  const terminalInputAccessCacheByRoomId = new Map<string, {
    expiresAt: number;
    promise: ReturnType<typeof loadAuthorizedCodeAgentRoom>;
  }>();

  const loadAuthorizedTerminalInputRoom = (roomId: string | null) => {
    if (!roomId) {
      return loadAuthorizedCodeAgentRoom(roomId, 'write code workspace terminal input');
    }
    const cached = terminalInputAccessCacheByRoomId.get(roomId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.promise;
    }
    const promise = loadAuthorizedCodeAgentRoom(roomId, 'write code workspace terminal input');
    terminalInputAccessCacheByRoomId.set(roomId, {
      expiresAt: Date.now() + TERMINAL_INPUT_ACCESS_CACHE_MS,
      promise,
    });
    void promise.then((access) => {
      if (!access.success && terminalInputAccessCacheByRoomId.get(roomId)?.promise === promise) {
        terminalInputAccessCacheByRoomId.delete(roomId);
      }
    }, () => {
      if (terminalInputAccessCacheByRoomId.get(roomId)?.promise === promise) {
        terminalInputAccessCacheByRoomId.delete(roomId);
      }
    });
    return promise;
  };

  const connectReadyWorkspace = async (
    room: Room,
    clientId?: string
  ): Promise<{ success: true; handle: CodeAgentSandboxHandle } | { success: false; error: string }> => {
    if (clientId && codeAgentSandboxLifecycle) {
      const ready = await codeAgentSandboxLifecycle.ensureReadySandbox(room.id, clientId);
      if (ready.ok) {
        return { success: true, handle: ready.handle };
      }
      if (ready.reason === 'creating') {
        return { success: false, error: 'Workspace sandbox is still starting' };
      }
      if (ready.reason === 'forbidden') {
        return { success: false, error: 'You are not authorized to access this workspace sandbox' };
      }
      return { success: false, error: 'Workspace sandbox is not ready' };
    }
    if (!room.sandboxId || room.sandboxStatus !== 'ready') {
      return { success: false, error: 'Workspace sandbox is not ready' };
    }
    if (!codeAgentSandboxService) {
      return { success: false, error: 'Workspace sandbox service is unavailable' };
    }
    return { success: true, handle: await codeAgentSandboxService.connect(room.sandboxId) };
  };

  socket.on('interrupt_code_agent_turn', async (payload: unknown, callback?: (response: CodeAgentControlAck) => void) => {
    const roomId = parseRoomId(payload);
    const authorized = await loadAuthorizedCodeAgentRoom(roomId, 'interrupt code agent turn');
    if (!authorized.success) {
      callback?.({ success: false, error: authorized.error });
      return;
    }
    if (!codeAgentSessionService) {
      callback?.({ success: false, error: 'Workspace is unavailable' });
      return;
    }
    const reason = parseWorkspaceOptionalString(payload, 'reason')?.slice(0, 500);
    const response = await codeAgentSessionService.interruptTurn(authorized.room.id, authorized.clientId, reason);
    callback?.(response);
  });

  socket.on('steer_code_agent_turn', async (payload: unknown, callback?: (response: CodeAgentControlAck) => void) => {
    const roomId = parseRoomId(payload);
    const authorized = await loadAuthorizedCodeAgentRoom(roomId, 'steer code agent turn');
    if (!authorized.success) {
      callback?.({ success: false, error: authorized.error });
      return;
    }
    if (!codeAgentSessionService) {
      callback?.({ success: false, error: 'Workspace is unavailable' });
      return;
    }
    const prompt = parseWorkspaceString(payload, 'prompt');
    if (!prompt) {
      callback?.({ success: false, error: 'Steer prompt is required' });
      return;
    }
    const response = await codeAgentSessionService.steerTurn(authorized.room.id, authorized.clientId, prompt);
    callback?.(response);
  });

  socket.on('respond_code_agent_approval', async (payload: unknown, callback?: (response: CodeAgentControlAck) => void) => {
    const roomId = parseRoomId(payload);
    const authorized = await loadAuthorizedCodeAgentRoom(roomId, 'respond to code agent approval');
    if (!authorized.success) {
      callback?.({ success: false, error: authorized.error });
      return;
    }
    if (!codeAgentSessionService) {
      callback?.({ success: false, error: 'Workspace is unavailable' });
      return;
    }
    const approvalId = parseWorkspaceString(payload, 'approvalId');
    const decision = parseApprovalDecision(payload);
    if (!approvalId || !decision) {
      callback?.({ success: false, error: 'Approval id and decision are required' });
      return;
    }
    const response = await codeAgentSessionService.respondToApproval(authorized.room.id, authorized.clientId, approvalId, decision);
    callback?.(response);
  });

  socket.on('list_codex_threads', async (payload: unknown, callback?: (response: CodexThreadListAck) => void) => {
    const roomId = parseRoomId(payload);
    const authorized = await loadAuthorizedCodeAgentRoom(roomId, 'list Codex threads');
    if (!authorized.success) {
      callback?.({ success: false, error: authorized.error });
      return;
    }
    if (!codeAgentSessionService) {
      callback?.({ success: false, error: 'Workspace is unavailable' });
      return;
    }
    const limit = parseWorkspacePositiveInteger(payload, 'limit', 25, 100);
    const cursor = parseWorkspaceOptionalString(payload, 'cursor') || null;
    const searchTerm = parseWorkspaceOptionalString(payload, 'searchTerm')?.trim() || undefined;
    try {
      const result = await codeAgentSessionService.listCodexThreads({
        roomId: authorized.room.id,
        clientId: authorized.clientId,
        limit,
        cursor,
        searchTerm,
      });
      callback?.({ success: true, ...result });
    } catch (error) {
      socketLogger.warn('Failed to list Codex threads', { error, roomId: authorized.room.id, clientId: authorized.clientId });
      callback?.({ success: false, error: error instanceof Error ? error.message : 'Failed to list Codex threads' });
    }
  });

  socket.on('read_codex_thread', async (payload: unknown, callback?: (response: CodexThreadReadAck) => void) => {
    const roomId = parseRoomId(payload);
    const authorized = await loadAuthorizedCodeAgentRoom(roomId, 'read Codex thread');
    if (!authorized.success) {
      callback?.({ success: false, error: authorized.error });
      return;
    }
    if (!codeAgentSessionService) {
      callback?.({ success: false, error: 'Workspace is unavailable' });
      return;
    }
    const threadId = parseWorkspaceString(payload, 'threadId');
    if (!threadId) {
      callback?.({ success: false, error: 'Thread id is required' });
      return;
    }
    try {
      const result = await codeAgentSessionService.readCodexThread({
        roomId: authorized.room.id,
        clientId: authorized.clientId,
        threadId,
        includeTurns: parseWorkspaceBoolean(payload, 'includeTurns'),
      });
      callback?.({ success: true, thread: result.thread });
    } catch (error) {
      socketLogger.warn('Failed to read Codex thread', { error, roomId: authorized.room.id, clientId: authorized.clientId, threadId });
      callback?.({ success: false, error: error instanceof Error ? error.message : 'Failed to read Codex thread' });
    }
  });

  const loadWorkspaceSnapshotState = async (room: Room): Promise<{
    changes: CodeAgentWorkspaceChanges;
    workspaceRoot: string | null;
  }> => {
    if (!codeAgentSandboxService || !room.sandboxId || room.sandboxStatus !== 'ready') {
      return { changes: unavailableWorkspaceChanges, workspaceRoot: null };
    }
    try {
      const workspace = await connectReadyWorkspace(room);
      if (!workspace.success) {
        return { changes: unavailableWorkspaceChanges, workspaceRoot: null };
      }
      const workspaceRoot = workspace.handle.workspace || null;
      if (!codeAgentSandboxService.getWorkspaceChanges) {
        return { changes: unavailableWorkspaceChanges, workspaceRoot };
      }
      try {
        return {
          changes: await codeAgentSandboxService.getWorkspaceChanges(workspace.handle),
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
    if (!codeAgentSandboxService?.resolveWorkspacePreviewTarget) {
      throw new Error('Workspace preview port targets are unavailable for this sandbox');
    }
    const workspace = await connectReadyWorkspace(room);
    if (!workspace.success) {
      throw new Error(workspace.error);
    }
    return codeAgentSandboxService.resolveWorkspacePreviewTarget(workspace.handle, target);
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

  const emitPreviewEvent = (event: WorkspacePreviewEvent) => {
    io.to(event.roomId).emit('code_workspace_preview_event', event);
  };

  const getTerminalSessionsForRoom = (roomId: string): Map<string, WorkspaceTerminalRuntime> => {
    const existing = workspaceTerminalSessionsByRoomId.get(roomId);
    if (existing) {
      return existing;
    }
    const sessions = new Map<string, WorkspaceTerminalRuntime>();
    workspaceTerminalSessionsByRoomId.set(roomId, sessions);
    return sessions;
  };

  const terminalSnapshot = (session: WorkspaceTerminalRuntime): WorkspaceTerminalSessionSnapshot => ({
    roomId: session.roomId,
    terminalId: session.terminalId,
    status: session.status,
    cols: session.cols,
    rows: session.rows,
    ...(session.pid !== undefined ? { pid: session.pid } : {}),
    output: session.output,
    updatedAt: session.updatedAt,
  });

  const emitTerminalEvent = (event: WorkspaceTerminalEvent) => {
    io.to(event.roomId).emit('code_workspace_terminal_event', event);
  };

  const appendTerminalOutput = (
    session: WorkspaceTerminalRuntime,
    data: string,
  ): WorkspaceTerminalRuntime => ({
    ...session,
    output: `${session.output}${data}`.slice(-TERMINAL_OUTPUT_TAIL_MAX_LENGTH),
    updatedAt: new Date().toISOString(),
  });

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
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'open code workspace preview');
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
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'navigate code workspace preview');
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
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'resize code workspace preview');
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
      const baseSnapshot = existing ?? buildPreviewSnapshot({
        roomId: access.room.id,
        tabId,
        navStatus: { _tag: 'Idle' },
      });
      const { renderedViewport: _staleRenderedViewport, ...snapshotWithoutRenderedViewport } = baseSnapshot;
      const session = putPreviewSession(access.room.id, tabId, {
        ...snapshotWithoutRenderedViewport,
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
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'report code workspace preview status');
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
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'refresh code workspace preview');
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
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'list code workspace previews');
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
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'close code workspace preview');
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
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'resolve code workspace preview target');
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

  socket.on('list_code_workspace_preview_servers', async (payload: unknown, callback?: (response: WorkspacePreviewServersAck) => void) => {
    const roomId = parseRoomId(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'list code workspace preview servers');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!codeAgentSandboxService?.listWorkspacePreviewServers) {
        callback?.({ success: true, servers: [] });
        return;
      }
      const workspace = await connectReadyWorkspace(access.room, access.clientId);
      if (!workspace.success) {
        callback?.({ success: false, error: workspace.error });
        return;
      }
      callback?.({
        success: true,
        servers: await codeAgentSandboxService.listWorkspacePreviewServers(workspace.handle),
      });
    } catch (error) {
      socketLogger.error('Failed to list code workspace preview servers', { error, clientId, roomId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to list workspace preview servers' });
    }
  });

  socket.on('open_code_workspace_terminal_session', async (payload: unknown, callback?: (response: WorkspaceTerminalSessionAck) => void) => {
    const roomId = parseRoomId(payload);
    const terminalId = parseTerminalId(payload);
    const size = parseTerminalSize(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'open code workspace terminal');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      terminalInputAccessCacheByRoomId.set(access.room.id, {
        expiresAt: Date.now() + TERMINAL_INPUT_ACCESS_CACHE_MS,
        promise: Promise.resolve(access),
      });
      if (!terminalId) {
        callback?.({ success: false, error: 'Terminal id is invalid' });
        return;
      }
      if (!codeAgentSandboxService?.startWorkspaceTerminal) {
        callback?.({ success: false, error: 'Workspace terminal is unavailable' });
        return;
      }
      const workspace = await connectReadyWorkspace(access.room, access.clientId);
      if (!workspace.success) {
        callback?.({ success: false, error: workspace.error });
        return;
      }

      const sessions = getTerminalSessionsForRoom(access.room.id);
      const existing = sessions.get(terminalId);
      if (existing && existing.status === 'running') {
        if (existing.cols !== size.cols || existing.rows !== size.rows) {
          await existing.terminal.resize(size);
          const resized = {
            ...existing,
            cols: size.cols,
            rows: size.rows,
            updatedAt: new Date().toISOString(),
          };
          sessions.set(terminalId, resized);
        }
        callback?.({ success: true, session: terminalSnapshot(sessions.get(terminalId)!) });
        return;
      }

      let earlyOutput = '';
      const terminal = await codeAgentSandboxService.startWorkspaceTerminal({
        handle: workspace.handle,
        cols: size.cols,
        rows: size.rows,
        onData: (data) => {
          const text = Buffer.from(data).toString('utf8');
          const current = sessions.get(terminalId);
          if (!current || current.status !== 'running') {
            earlyOutput = `${earlyOutput}${text}`.slice(-TERMINAL_OUTPUT_TAIL_MAX_LENGTH);
            return;
          }
          const next = appendTerminalOutput(current, text);
          sessions.set(terminalId, next);
          emitTerminalEvent({
            type: 'data',
            roomId: access.room.id,
            terminalId,
            createdAt: next.updatedAt,
            data: text,
          });
        },
      });
      const now = new Date().toISOString();
      const session: WorkspaceTerminalRuntime = {
        roomId: access.room.id,
        terminalId,
        status: 'running',
        cols: size.cols,
        rows: size.rows,
        ...(terminal.pid !== undefined ? { pid: terminal.pid } : {}),
        output: earlyOutput,
        updatedAt: now,
        terminal,
      };
      sessions.set(terminalId, session);
      const snapshot = terminalSnapshot(session);
      emitTerminalEvent({
        type: 'opened',
        roomId: access.room.id,
        terminalId,
        createdAt: now,
        snapshot,
      });
      callback?.({ success: true, session: snapshot });
    } catch (error) {
      socketLogger.error('Failed to open code workspace terminal', { error, clientId, roomId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to open workspace terminal' });
    }
  });

  socket.on('input_code_workspace_terminal_session', async (payload: unknown, callback?: (response: WorkspaceMutationAck) => void) => {
    const roomId = parseRoomId(payload);
    const terminalId = parseTerminalId(payload);
    const data = parseTerminalInput(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedTerminalInputRoom(roomId);
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!terminalId || data === null) {
        callback?.({ success: false, error: 'Terminal input is invalid' });
        return;
      }
      const session = getTerminalSessionsForRoom(access.room.id).get(terminalId);
      if (!session || session.status !== 'running') {
        callback?.({ success: false, error: 'Workspace terminal is not running' });
        return;
      }
      await enqueueTerminalInput(session.terminal, data);
      callback?.({ success: true });
    } catch (error) {
      socketLogger.error('Failed to write code workspace terminal input', { error, clientId, roomId, terminalId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to write workspace terminal input' });
    }
  });

  socket.on('resize_code_workspace_terminal_session', async (payload: unknown, callback?: (response: WorkspaceTerminalSessionAck) => void) => {
    const roomId = parseRoomId(payload);
    const terminalId = parseTerminalId(payload);
    const size = parseTerminalSize(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'resize code workspace terminal');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!terminalId) {
        callback?.({ success: false, error: 'Terminal id is invalid' });
        return;
      }
      const sessions = getTerminalSessionsForRoom(access.room.id);
      const session = sessions.get(terminalId);
      if (!session || session.status !== 'running') {
        callback?.({ success: false, error: 'Workspace terminal is not running' });
        return;
      }
      await session.terminal.resize(size);
      const next = {
        ...session,
        cols: size.cols,
        rows: size.rows,
        updatedAt: new Date().toISOString(),
      };
      sessions.set(terminalId, next);
      const snapshot = terminalSnapshot(next);
      emitTerminalEvent({
        type: 'resized',
        roomId: access.room.id,
        terminalId,
        createdAt: snapshot.updatedAt,
        snapshot,
      });
      callback?.({ success: true, session: snapshot });
    } catch (error) {
      socketLogger.error('Failed to resize code workspace terminal', { error, clientId, roomId, terminalId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to resize workspace terminal' });
    }
  });

  socket.on('close_code_workspace_terminal_session', async (payload: unknown, callback?: (response: WorkspaceTerminalSessionAck) => void) => {
    const roomId = parseRoomId(payload);
    const terminalId = parseTerminalId(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'close code workspace terminal');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!terminalId) {
        callback?.({ success: false, error: 'Terminal id is invalid' });
        return;
      }
      const sessions = getTerminalSessionsForRoom(access.room.id);
      const session = sessions.get(terminalId);
      if (!session) {
        callback?.({ success: true, sessions: [...sessions.values()].map(terminalSnapshot) });
        return;
      }
      if (session.status === 'running') {
        await session.terminal.stop();
      }
      const next = {
        ...session,
        status: 'closed' as const,
        updatedAt: new Date().toISOString(),
      };
      sessions.set(terminalId, next);
      const snapshot = terminalSnapshot(next);
      emitTerminalEvent({
        type: 'closed',
        roomId: access.room.id,
        terminalId,
        createdAt: snapshot.updatedAt,
        snapshot,
      });
      callback?.({ success: true, session: snapshot, sessions: [...sessions.values()].map(terminalSnapshot) });
    } catch (error) {
      socketLogger.error('Failed to close code workspace terminal', { error, clientId, roomId, terminalId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to close workspace terminal' });
    }
  });

  socket.on('list_code_workspace_terminal_sessions', async (payload: unknown, callback?: (response: WorkspaceTerminalSessionAck) => void) => {
    const roomId = parseRoomId(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'list code workspace terminals');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      callback?.({
        success: true,
        sessions: [...getTerminalSessionsForRoom(access.room.id).values()].map(terminalSnapshot),
      });
    } catch (error) {
      socketLogger.error('Failed to list code workspace terminals', { error, clientId, roomId, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to list workspace terminals' });
    }
  });

  socket.on('get_code_workspace_snapshot', async (payload: unknown, callback?: (response: WorkspaceSnapshotAck) => void) => {
    const roomId = parseRoomId(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'refresh code workspace');
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
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'browse code workspace');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!codeAgentSandboxService?.listWorkspaceEntries) {
        callback?.({ success: false, error: 'Workspace file browsing is unavailable' });
        return;
      }
      const workspace = await connectReadyWorkspace(access.room, access.clientId);
      if (!workspace.success) {
        callback?.({ success: false, error: workspace.error });
        return;
      }

      const entries = await codeAgentSandboxService.listWorkspaceEntries(workspace.handle, {
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
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'search code workspace');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!query.trim()) {
        callback?.({ success: true, entries: [], truncated: false });
        return;
      }
      if (!codeAgentSandboxService?.searchWorkspaceEntries) {
        callback?.({ success: false, error: 'Workspace file search is unavailable' });
        return;
      }
      const workspace = await connectReadyWorkspace(access.room, access.clientId);
      if (!workspace.success) {
        callback?.({ success: false, error: workspace.error });
        return;
      }

      const entries = await codeAgentSandboxService.searchWorkspaceEntries(workspace.handle, {
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
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'list code workspace refs');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!codeAgentSandboxService?.listWorkspaceRefs) {
        callback?.({ success: false, error: 'Workspace refs are unavailable' });
        return;
      }
      const workspace = await connectReadyWorkspace(access.room, access.clientId);
      if (!workspace.success) {
        callback?.({ success: false, error: workspace.error });
        return;
      }

      callback?.({
        success: true,
        refs: await codeAgentSandboxService.listWorkspaceRefs(workspace.handle, {
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
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'read code workspace file');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!path) {
        callback?.({ success: false, error: 'File path is required' });
        return;
      }
      if (!codeAgentSandboxService?.readWorkspaceFile) {
        callback?.({ success: false, error: 'Workspace file reading is unavailable' });
        return;
      }
      const workspace = await connectReadyWorkspace(access.room, access.clientId);
      if (!workspace.success) {
        callback?.({ success: false, error: workspace.error });
        return;
      }

      callback?.({
        success: true,
        file: await codeAgentSandboxService.readWorkspaceFile(workspace.handle, path, {
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
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'read code workspace diff');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!codeAgentSandboxService?.getWorkspaceDiff) {
        callback?.({ success: false, error: 'Workspace diff viewing is unavailable' });
        return;
      }
      const workspace = await connectReadyWorkspace(access.room, access.clientId);
      if (!workspace.success) {
        callback?.({ success: false, error: workspace.error });
        return;
      }

      callback?.({
        success: true,
        diff: await codeAgentSandboxService.getWorkspaceDiff(workspace.handle, {
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
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'create code workspace asset URL');
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
      if (!codeAgentSandboxService?.readWorkspaceFile) {
        callback?.({ success: false, error: 'Workspace file reading is unavailable' });
        return;
      }
      const workspace = await connectReadyWorkspace(access.room, access.clientId);
      if (!workspace.success) {
        callback?.({ success: false, error: workspace.error });
        return;
      }

      const previewFile = await codeAgentSandboxService.readWorkspaceFile(workspace.handle, path, { maxBytes: 1 });
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

  socket.on('resolve_code_workspace_file_preview', async (payload: unknown, callback?: (response: WorkspaceFilePreviewAck) => void) => {
    const roomId = parseRoomId(payload);
    const path = parseWorkspacePath(payload);
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'resolve code workspace file preview');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!path) {
        callback?.({ success: false, error: 'File path is required' });
        return;
      }
      if (!codeWorkspaceFilePreviewService) {
        callback?.({ success: false, error: 'Workspace file preview is unavailable' });
        return;
      }
      const workspace = await connectReadyWorkspace(access.room, access.clientId);
      if (!workspace.success) {
        callback?.({ success: false, error: workspace.error });
        return;
      }
      if (!access.room.sandboxId) {
        callback?.({ success: false, error: 'Workspace sandbox is unavailable' });
        return;
      }

      callback?.({
        success: true,
        preview: await codeWorkspaceFilePreviewService.resolve({
          roomId: access.room.id,
          sandboxId: access.room.sandboxId,
          handle: workspace.handle,
          path,
          startDevServer: parseWorkspaceBoolean(payload, 'startDevServer') || parseWorkspaceBoolean(payload, 'start'),
        }),
      });
    } catch (error) {
      if (error instanceof CodeWorkspaceAssetError) {
        callback?.({ success: false, error: error.message });
        return;
      }
      socketLogger.error('Failed to resolve code workspace file preview', { error, clientId, roomId, path, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to resolve workspace file preview' });
    }
  });

  socket.on('write_code_workspace_file', async (payload: unknown, callback?: (response: WorkspaceEntryAck) => void) => {
    const roomId = parseRoomId(payload);
    const path = parseWorkspacePath(payload);
    const content = parseWorkspaceOptionalString(payload, 'content');
    const encoding = parseWorkspaceOptionalString(payload, 'encoding');
    let clientId: string | null = null;

    try {
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'write code workspace file');
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
      if (!codeAgentSandboxService?.writeWorkspaceFile) {
        callback?.({ success: false, error: 'Workspace file writing is unavailable' });
        return;
      }
      const workspace = await connectReadyWorkspace(access.room, access.clientId);
      if (!workspace.success) {
        callback?.({ success: false, error: workspace.error });
        return;
      }

      callback?.({
        success: true,
        entry: await codeAgentSandboxService.writeWorkspaceFile(workspace.handle, {
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
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'create code workspace directory');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!path) {
        callback?.({ success: false, error: 'Directory path is required' });
        return;
      }
      if (!codeAgentSandboxService?.createWorkspaceDirectory) {
        callback?.({ success: false, error: 'Workspace directory creation is unavailable' });
        return;
      }
      const workspace = await connectReadyWorkspace(access.room, access.clientId);
      if (!workspace.success) {
        callback?.({ success: false, error: workspace.error });
        return;
      }

      callback?.({
        success: true,
        entry: await codeAgentSandboxService.createWorkspaceDirectory(workspace.handle, path),
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
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'rename code workspace entry');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!fromPath || !toPath) {
        callback?.({ success: false, error: 'Source and destination paths are required' });
        return;
      }
      if (!codeAgentSandboxService?.renameWorkspaceEntry) {
        callback?.({ success: false, error: 'Workspace entry rename is unavailable' });
        return;
      }
      const workspace = await connectReadyWorkspace(access.room, access.clientId);
      if (!workspace.success) {
        callback?.({ success: false, error: workspace.error });
        return;
      }

      callback?.({
        success: true,
        entry: await codeAgentSandboxService.renameWorkspaceEntry(workspace.handle, { fromPath, toPath }),
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
      const access = await loadAuthorizedCodeAgentRoom(roomId, 'delete code workspace entry');
      clientId = access.clientId ?? null;
      if (!access.success) {
        callback?.({ success: false, error: access.error });
        return;
      }
      if (!path) {
        callback?.({ success: false, error: 'Workspace path is required' });
        return;
      }
      if (!codeAgentSandboxService?.deleteWorkspaceEntry) {
        callback?.({ success: false, error: 'Workspace entry deletion is unavailable' });
        return;
      }
      const workspace = await connectReadyWorkspace(access.room, access.clientId);
      if (!workspace.success) {
        callback?.({ success: false, error: workspace.error });
        return;
      }

      await codeAgentSandboxService.deleteWorkspaceEntry(workspace.handle, path);
      callback?.({ success: true });
    } catch (error) {
      socketLogger.error('Failed to delete code workspace entry', { error, clientId, roomId, path, socketId: socket.id });
      callback?.({ success: false, error: 'Failed to delete workspace entry' });
    }
  });
}
