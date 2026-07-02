import { useSyncExternalStore } from 'react';

export type CodeAgentRightPanelSurface =
  | { id: 'browser:new' | `browser:new:${number}`; kind: 'preview'; relativePath: null; url?: null }
  | {
    id: `browser:${string}`;
    kind: 'preview';
    relativePath: string;
    url?: null;
  }
  | {
    id: `browser:url:${string}`;
    kind: 'preview';
    relativePath: null;
    url: string;
  }
  | { id: 'diff'; kind: 'diff' }
  | { id: 'files'; kind: 'files' }
  | {
    id: `file:${string}`;
    kind: 'file';
    relativePath: string;
    revealLine: number | null;
    revealRequestId: number;
  };

export interface CodeAgentRightPanelState {
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: CodeAgentRightPanelSurface[];
}

type CodeAgentPreviewSurface = Extract<CodeAgentRightPanelSurface, { kind: 'preview' }>;

export interface CodeAgentRightPanelStoreState {
  byRoomId: Record<string, CodeAgentRightPanelState>;
}

interface PersistedCodeAgentRightPanelStore {
  state?: Partial<CodeAgentRightPanelStoreState>;
  version?: number;
}

const STORAGE_KEY = 'roomtalk.codeWorkspace.rightPanelState.v1';

const EMPTY_ROOM_STATE: CodeAgentRightPanelState = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
};

const listeners = new Set<() => void>();

function normalizeRoomId(roomId: string): string {
  return roomId.trim();
}

function normalizeWorkspacePath(path: string): string {
  return path.trim().replace(/\\/g, '/').split('/').filter(Boolean).join('/');
}

function normalizeBrowserHttpUrl(input: string | null | undefined): string | null {
  const trimmed = input?.trim() ?? '';
  if (!/^https?:\/\//i.test(trimmed)) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeRevealLine(line: number | null | undefined): number | null {
  if (line === undefined || line === null || !Number.isFinite(line)) {
    return null;
  }
  return Math.max(1, Math.trunc(line));
}

function normalizeRevealRequestId(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function fileSurface(relativePath: string, revealLine: number | null, revealRequestId: number): CodeAgentRightPanelSurface {
  return {
    id: `file:${relativePath}`,
    kind: 'file',
    relativePath,
    revealLine,
    revealRequestId,
  };
}

function browserSurface(relativePath: string | null): CodeAgentPreviewSurface {
  return relativePath
    ? { id: `browser:${relativePath}`, kind: 'preview', relativePath }
    : { id: 'browser:new', kind: 'preview', relativePath: null };
}

function browserUrlSurface(url: string): CodeAgentPreviewSurface | null {
  const normalizedUrl = normalizeBrowserHttpUrl(url);
  if (!normalizedUrl) {
    return null;
  }
  return {
    id: `browser:url:${encodeURIComponent(normalizedUrl)}`,
    kind: 'preview',
    relativePath: null,
    url: normalizedUrl,
  };
}

function nextBlankBrowserSurface(surfaces: readonly CodeAgentRightPanelSurface[]): CodeAgentRightPanelSurface {
  const blankIds = new Set(surfaces
    .filter((surface) => surface.kind === 'preview' && surface.relativePath === null)
    .map((surface) => surface.id));
  if (!blankIds.has('browser:new')) {
    return browserSurface(null);
  }
  let index = 2;
  while (blankIds.has(`browser:new:${index}`)) {
    index += 1;
  }
  return { id: `browser:new:${index}`, kind: 'preview', relativePath: null };
}

function singletonSurface(kind: 'diff' | 'files'): CodeAgentRightPanelSurface {
  return kind === 'diff'
    ? { id: 'diff', kind: 'diff' }
    : { id: 'files', kind: 'files' };
}

function emptyStoreState(): CodeAgentRightPanelStoreState {
  return { byRoomId: {} };
}

function coerceSurface(value: unknown): CodeAgentRightPanelSurface | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const surface = value as Partial<CodeAgentRightPanelSurface>;
  if (surface.kind === 'diff' || surface.id === 'diff') {
    return { id: 'diff', kind: 'diff' };
  }
  if (surface.kind === 'files' || surface.id === 'files') {
    return { id: 'files', kind: 'files' };
  }
  if (surface.kind === 'preview' || (typeof surface.id === 'string' && surface.id.startsWith('browser:'))) {
    const relativePath = normalizeWorkspacePath(
      typeof (value as { relativePath?: unknown }).relativePath === 'string'
        ? (value as { relativePath: string }).relativePath
        : '',
    );
    const rawUrl = typeof (value as { url?: unknown }).url === 'string'
      ? (value as { url: string }).url
      : '';
    const rawId = typeof surface.id === 'string' ? surface.id : '';
    if (!relativePath && rawUrl) {
      return browserUrlSurface(rawUrl);
    }
    if (!relativePath && /^browser:new(?::\d+)?$/.test(rawId)) {
      return {
        id: rawId as 'browser:new' | `browser:new:${number}`,
        kind: 'preview',
        relativePath: null,
      };
    }
    return browserSurface(relativePath || null);
  }
  if (surface.kind === 'file') {
    const relativePath = normalizeWorkspacePath(
      typeof surface.relativePath === 'string' ? surface.relativePath : '',
    );
    if (!relativePath) {
      return null;
    }
    return fileSurface(
      relativePath,
      normalizeRevealLine(surface.revealLine),
      normalizeRevealRequestId((value as { revealRequestId?: unknown }).revealRequestId),
    );
  }
  return null;
}

function coerceRoomState(value: unknown): CodeAgentRightPanelState | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const roomState = value as Partial<CodeAgentRightPanelState>;
  const surfaces = Array.isArray(roomState.surfaces)
    ? roomState.surfaces.flatMap((surface) => {
      const coerced = coerceSurface(surface);
      return coerced ? [coerced] : [];
    })
    : [];
  const activeSurfaceId = typeof roomState.activeSurfaceId === 'string' &&
    surfaces.some((surface) => surface.id === roomState.activeSurfaceId)
    ? roomState.activeSurfaceId
    : null;
  const isOpen = typeof roomState.isOpen === 'boolean'
    ? roomState.isOpen
    : activeSurfaceId !== null;

  return {
    isOpen,
    activeSurfaceId,
    surfaces,
  };
}

export function migrateCodeAgentRightPanelState(persistedState: unknown): CodeAgentRightPanelStoreState {
  if (!persistedState || typeof persistedState !== 'object') {
    return emptyStoreState();
  }
  const byRoomId: Record<string, CodeAgentRightPanelState> = {};
  for (const [roomId, roomState] of Object.entries(
    (persistedState as Partial<CodeAgentRightPanelStoreState>).byRoomId ?? {},
  )) {
    const normalizedRoomId = normalizeRoomId(roomId);
    const coerced = coerceRoomState(roomState);
    if (normalizedRoomId && coerced) {
      byRoomId[normalizedRoomId] = coerced;
    }
  }
  return { byRoomId };
}

function readPersistedState(): CodeAgentRightPanelStoreState {
  if (typeof window === 'undefined') {
    return emptyStoreState();
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return emptyStoreState();
    }
    const payload = JSON.parse(raw) as PersistedCodeAgentRightPanelStore;
    return migrateCodeAgentRightPanelState(payload.state);
  } catch {
    return emptyStoreState();
  }
}

let storeState: CodeAgentRightPanelStoreState = readPersistedState();

function writePersistedState(state: CodeAgentRightPanelStoreState) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      state,
      version: 1,
    }));
  } catch {
    // Persistence is best-effort; the live store remains usable.
  }
}

function emit() {
  listeners.forEach((listener) => listener());
}

function updateRoom(
  byRoomId: Record<string, CodeAgentRightPanelState>,
  roomId: string,
  updater: (current: CodeAgentRightPanelState) => CodeAgentRightPanelState,
): Record<string, CodeAgentRightPanelState> {
  const current = byRoomId[roomId] ?? EMPTY_ROOM_STATE;
  const next = updater(current);
  if (!next.isOpen && next.activeSurfaceId === null && next.surfaces.length === 0) {
    if (!(roomId in byRoomId)) return byRoomId;
    const { [roomId]: _removed, ...rest } = byRoomId;
    return rest;
  }
  if (next === current) return byRoomId;
  return { ...byRoomId, [roomId]: next };
}

function updateStore(updater: (state: CodeAgentRightPanelStoreState) => CodeAgentRightPanelStoreState) {
  const nextState = updater(storeState);
  if (nextState === storeState) {
    return;
  }
  storeState = nextState;
  writePersistedState(storeState);
  emit();
}

function selectRoomState(roomId: string): CodeAgentRightPanelState {
  const roomKey = normalizeRoomId(roomId);
  return roomKey ? storeState.byRoomId[roomKey] ?? EMPTY_ROOM_STATE : EMPTY_ROOM_STATE;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCodeAgentRightPanelState(roomId: string): CodeAgentRightPanelState {
  return useSyncExternalStore(
    subscribe,
    () => selectRoomState(roomId),
    () => EMPTY_ROOM_STATE,
  );
}

export function readCodeAgentRightPanelState(roomId: string): CodeAgentRightPanelState {
  return selectRoomState(roomId);
}

export function selectActiveCodeAgentRightPanelSurface(roomId: string): CodeAgentRightPanelSurface | null {
  const state = selectRoomState(roomId);
  if (!state.isOpen) {
    return null;
  }
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
}

export function selectActiveCodeAgentRightPanelKind(roomId: string): CodeAgentRightPanelSurface['kind'] | null {
  return selectActiveCodeAgentRightPanelSurface(roomId)?.kind ?? null;
}

export function openCodeAgentRightPanel(roomId: string, kind: 'diff' | 'files') {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return;
  }
  updateStore((state) => ({
    byRoomId: updateRoom(state.byRoomId, roomKey, (current) => {
      const surface = singletonSurface(kind);
      return {
        isOpen: true,
        surfaces: current.surfaces.some((entry) => entry.id === surface.id)
          ? current.surfaces
          : [...current.surfaces, surface],
        activeSurfaceId: surface.id,
      };
    }),
  }));
}

function replacePreviewSurface(
  current: CodeAgentRightPanelState,
  surfaceId: string,
  nextSurface: CodeAgentPreviewSurface,
): CodeAgentRightPanelState {
  const sourceIndex = current.surfaces.findIndex((surface) => surface.id === surfaceId);
  const duplicateIndex = current.surfaces.findIndex((surface) => surface.id === nextSurface.id);
  if (duplicateIndex >= 0 && duplicateIndex !== sourceIndex) {
    return {
      isOpen: true,
      activeSurfaceId: nextSurface.id,
      surfaces: current.surfaces.filter((surface) => surface.id !== surfaceId),
    };
  }
  if (sourceIndex >= 0) {
    return {
      isOpen: true,
      activeSurfaceId: nextSurface.id,
      surfaces: current.surfaces.map((surface, index) => (index === sourceIndex ? nextSurface : surface)),
    };
  }
  return {
    isOpen: true,
    activeSurfaceId: nextSurface.id,
    surfaces: current.surfaces.some((surface) => surface.id === nextSurface.id)
      ? current.surfaces
      : [...current.surfaces, nextSurface],
  };
}

export function navigateCodeAgentRightPanelPreviewSurface(
  roomId: string,
  surfaceId: string,
  target: { kind: 'workspace-file'; relativePath: string } | { kind: 'url'; url: string },
) {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return;
  }
  const nextSurface = target.kind === 'workspace-file'
    ? browserSurface(normalizeWorkspacePath(target.relativePath))
    : browserUrlSurface(target.url);
  if (!nextSurface) {
    return;
  }
  if (target.kind === 'workspace-file' && !nextSurface.relativePath) {
    return;
  }
  updateStore((state) => ({
    byRoomId: updateRoom(state.byRoomId, roomKey, (current) => (
      replacePreviewSurface(current, surfaceId, nextSurface)
    )),
  }));
}

export function openCodeAgentRightPanelPreview(roomId: string, relativePath?: string | null) {
  const roomKey = normalizeRoomId(roomId);
  const normalizedPath = relativePath ? normalizeWorkspacePath(relativePath) : '';
  if (!roomKey) {
    return;
  }
  updateStore((state) => ({
    byRoomId: updateRoom(state.byRoomId, roomKey, (current) => {
      const surface = browserSurface(normalizedPath || null);
      const withoutPlaceholder = surface.id !== 'browser:new'
        ? current.surfaces.filter((entry) => entry.id !== 'browser:new')
        : current.surfaces;
      return {
        isOpen: true,
        surfaces: withoutPlaceholder.some((entry) => entry.id === surface.id)
          ? withoutPlaceholder
          : [...withoutPlaceholder, surface],
        activeSurfaceId: surface.id,
      };
    }),
  }));
}

export function addCodeAgentRightPanelPreviewSurface(roomId: string) {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return;
  }
  updateStore((state) => ({
    byRoomId: updateRoom(state.byRoomId, roomKey, (current) => {
      const surface = nextBlankBrowserSurface(current.surfaces);
      return {
        isOpen: true,
        surfaces: [...current.surfaces, surface],
        activeSurfaceId: surface.id,
      };
    }),
  }));
}

export function openCodeAgentRightPanelFile(roomId: string, relativePath: string, line?: number | null) {
  const roomKey = normalizeRoomId(roomId);
  const normalizedPath = normalizeWorkspacePath(relativePath);
  if (!roomKey || !normalizedPath) {
    return;
  }
  updateStore((state) => ({
    byRoomId: updateRoom(state.byRoomId, roomKey, (current) => {
      const withoutStandaloneExplorer = current.surfaces.filter((surface) => surface.kind !== 'files');
      const surfaceId = `file:${normalizedPath}` as const;
      const existing = withoutStandaloneExplorer.find(
        (surface): surface is Extract<CodeAgentRightPanelSurface, { kind: 'file' }> =>
          surface.id === surfaceId && surface.kind === 'file',
      );
      const surface = fileSurface(
        normalizedPath,
        normalizeRevealLine(line),
        (existing?.revealRequestId ?? 0) + 1,
      );
      return {
        isOpen: true,
        activeSurfaceId: surface.id,
        surfaces: existing
          ? withoutStandaloneExplorer.map((entry) => entry.id === surface.id ? surface : entry)
          : [...withoutStandaloneExplorer, surface],
      };
    }),
  }));
}

export function showCodeAgentRightPanel(roomId: string) {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return;
  }
  updateStore((state) => ({
    byRoomId: updateRoom(state.byRoomId, roomKey, (current) => (
      current.isOpen ? current : { ...current, isOpen: true }
    )),
  }));
}

export function closeCodeAgentRightPanel(roomId: string) {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return;
  }
  updateStore((state) => ({
    byRoomId: updateRoom(state.byRoomId, roomKey, (current) => (
      current.isOpen ? { ...current, isOpen: false } : current
    )),
  }));
}

export function toggleCodeAgentRightPanelVisibility(roomId: string) {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return;
  }
  updateStore((state) => ({
    byRoomId: updateRoom(state.byRoomId, roomKey, (current) => ({
      ...current,
      isOpen: !current.isOpen,
    })),
  }));
}

export function toggleCodeAgentRightPanel(roomId: string, kind: 'diff' | 'files' | 'preview') {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return;
  }
  updateStore((state) => ({
    byRoomId: updateRoom(state.byRoomId, roomKey, (current) => {
      const active = current.surfaces.find((surface) => surface.id === current.activeSurfaceId);
      if (current.isOpen && active?.kind === kind) {
        return { ...current, isOpen: false };
      }
      if (kind === 'preview') {
        const existing = current.surfaces.find((surface) => surface.kind === 'preview');
        const surface = existing ?? browserSurface(null);
        return {
          isOpen: true,
          surfaces: existing ? current.surfaces : [...current.surfaces, surface],
          activeSurfaceId: surface.id,
        };
      }
      const surface = singletonSurface(kind);
      return {
        isOpen: true,
        surfaces: current.surfaces.some((entry) => entry.id === surface.id)
          ? current.surfaces
          : [...current.surfaces, surface],
        activeSurfaceId: surface.id,
      };
    }),
  }));
}

export function activateCodeAgentRightPanelSurface(roomId: string, surfaceId: string) {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return;
  }
  updateStore((state) => ({
    byRoomId: updateRoom(state.byRoomId, roomKey, (current) => (
      current.surfaces.some((surface) => surface.id === surfaceId)
        ? { ...current, isOpen: true, activeSurfaceId: surfaceId }
        : current
    )),
  }));
}

export function closeCodeAgentRightPanelSurface(roomId: string, surfaceId: string) {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return;
  }
  updateStore((state) => ({
    byRoomId: updateRoom(state.byRoomId, roomKey, (current) => {
      const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
      if (index < 0) return current;
      const surfaces = current.surfaces.filter((surface) => surface.id !== surfaceId);
      if (current.activeSurfaceId !== surfaceId) {
        return { ...current, isOpen: surfaces.length > 0 && current.isOpen, surfaces };
      }
      const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
      return {
        ...current,
        isOpen: surfaces.length > 0 && current.isOpen,
        surfaces,
        activeSurfaceId: fallback?.id ?? null,
      };
    }),
  }));
}

export function closeOtherCodeAgentRightPanelSurfaces(roomId: string, surfaceId: string) {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return;
  }
  updateStore((state) => ({
    byRoomId: updateRoom(state.byRoomId, roomKey, (current) => {
      const surface = current.surfaces.find((entry) => entry.id === surfaceId);
      if (!surface || current.surfaces.length === 1) return current;
      return {
        ...current,
        isOpen: true,
        surfaces: [surface],
        activeSurfaceId: surface.id,
      };
    }),
  }));
}

export function closeCodeAgentRightPanelSurfacesToRight(roomId: string, surfaceId: string) {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return;
  }
  updateStore((state) => ({
    byRoomId: updateRoom(state.byRoomId, roomKey, (current) => {
      const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
      if (index < 0 || index === current.surfaces.length - 1) return current;
      const surfaces = current.surfaces.slice(0, index + 1);
      const activeStillExists = surfaces.some((surface) => surface.id === current.activeSurfaceId);
      return {
        ...current,
        surfaces,
        activeSurfaceId: activeStillExists ? current.activeSurfaceId : surfaceId,
      };
    }),
  }));
}

export function closeAllCodeAgentRightPanelSurfaces(roomId: string) {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return;
  }
  updateStore((state) => ({
    byRoomId: updateRoom(state.byRoomId, roomKey, (current) => (
      current.surfaces.length === 0
        ? current
        : { ...current, isOpen: false, surfaces: [], activeSurfaceId: null }
    )),
  }));
}

export function reconcileCodeAgentFileSurfaces(
  roomId: string,
  workspaceAvailable: boolean,
  availableFilePaths?: ReadonlySet<string>,
) {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return;
  }
  updateStore((state) => ({
    byRoomId: updateRoom(state.byRoomId, roomKey, (current) => {
      const surfaces = current.surfaces.filter((surface) => {
        if (!workspaceAvailable && (surface.kind === 'files' || surface.kind === 'file' || surface.kind === 'preview')) {
          return false;
        }
        if (surface.kind !== 'file') {
          if (surface.kind === 'preview' && surface.relativePath) {
            return !availableFilePaths || availableFilePaths.has(surface.relativePath);
          }
          return true;
        }
        return !availableFilePaths || availableFilePaths.has(surface.relativePath);
      });
      if (surfaces.length === current.surfaces.length) {
        return current;
      }
      const activeStillExists = surfaces.some((surface) => surface.id === current.activeSurfaceId);
      return {
        ...current,
        isOpen: surfaces.length > 0 && current.isOpen,
        surfaces,
        activeSurfaceId: activeStillExists ? current.activeSurfaceId : (surfaces.at(-1)?.id ?? null),
      };
    }),
  }));
}

export function removeCodeAgentRightPanelRoom(roomId: string) {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return;
  }
  updateStore((state) => {
    if (!(roomKey in state.byRoomId)) {
      return state;
    }
    const { [roomKey]: _removed, ...byRoomId } = state.byRoomId;
    return { byRoomId };
  });
}

export function resetCodeAgentRightPanelStoreForTests(state: CodeAgentRightPanelStoreState = emptyStoreState()) {
  storeState = state;
  writePersistedState(storeState);
  emit();
}
