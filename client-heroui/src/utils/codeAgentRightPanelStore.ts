import { useSyncExternalStore } from 'react';
import {
  FILL_CODE_AGENT_PREVIEW_VIEWPORT,
  coerceCodeAgentPreviewViewportSetting,
  type CodeAgentPreviewViewportSetting,
} from './codeAgentPreviewViewport';

export type CodeAgentRightPanelSurface =
  | ({
    id: 'browser:new' | `browser:new:${number}`;
    kind: 'preview';
    relativePath: null;
    url?: null;
  } & CodeAgentPreviewNavigationState)
  | {
    id: `browser:${string}`;
    kind: 'preview';
    relativePath: string;
    url?: null;
  } & CodeAgentPreviewNavigationState
  | ({
    id: `browser:url:${string}`;
    kind: 'preview';
    relativePath: null;
    url: string;
  } & CodeAgentPreviewNavigationState)
  | { id: 'diff'; kind: 'diff' }
  | { id: 'files'; kind: 'files' }
  | { id: 'terminal'; kind: 'terminal'; terminalId: 'terminal' }
  | {
    id: `file:${string}`;
    kind: 'file';
    relativePath: string;
    revealLine: number | null;
    revealRequestId: number;
};

export type CodeAgentPreviewNavigationTarget =
  | { kind: 'workspace-file'; relativePath: string }
  | { kind: 'url'; url: string };

type CodeAgentPreviewNavigationState = {
  navigationHistory?: CodeAgentPreviewNavigationTarget[];
  navigationIndex?: number;
  previewSessionId?: string;
  viewport?: CodeAgentPreviewViewportSetting;
  zoomFactor?: number;
};

export interface CodeAgentRightPanelState {
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: CodeAgentRightPanelSurface[];
}

type CodeAgentPreviewSurface = Extract<CodeAgentRightPanelSurface, { kind: 'preview' }>;

export type CodeAgentPreviewSessionSurfaceSnapshot = {
  tabId: string;
  navStatus:
    | { _tag: 'Idle' }
    | { _tag: 'Loading' | 'Success'; url: string; title: string }
    | { _tag: 'LoadFailed'; url: string; title: string; code: number; description: string };
  viewport?: CodeAgentPreviewViewportSetting;
  updatedAt?: string;
};

export interface CodeAgentRightPanelStoreState {
  byRoomId: Record<string, CodeAgentRightPanelState>;
  recentPreviewTargetsByRoomId?: Record<string, CodeAgentPreviewNavigationTarget[]>;
}

interface PersistedCodeAgentRightPanelStore {
  state?: Partial<CodeAgentRightPanelStoreState>;
  version?: number;
}

const STORAGE_KEY = 'roomtalk.codeWorkspace.rightPanelState.v1';
const PREVIEW_RECENT_TARGET_LIMIT = 10;
const PREVIEW_ZOOM_MIN = 0.25;
const PREVIEW_ZOOM_MAX = 3;
const PREVIEW_ZOOM_EPSILON = 0.001;

const EMPTY_ROOM_STATE: CodeAgentRightPanelState = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
};
const EMPTY_PREVIEW_RECENT_TARGETS: readonly CodeAgentPreviewNavigationTarget[] = [];

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

function normalizePreviewNavigationTarget(value: unknown): CodeAgentPreviewNavigationTarget | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const target = value as Partial<CodeAgentPreviewNavigationTarget>;
  if (target.kind === 'url') {
    const url = normalizeBrowserHttpUrl(typeof target.url === 'string' ? target.url : '');
    return url ? { kind: 'url', url } : null;
  }
  if (target.kind === 'workspace-file') {
    const relativePath = normalizeWorkspacePath(
      typeof target.relativePath === 'string' ? target.relativePath : '',
    );
    return relativePath ? { kind: 'workspace-file', relativePath } : null;
  }
  return null;
}

function previewNavigationTargetId(target: CodeAgentPreviewNavigationTarget): string {
  return target.kind === 'url'
    ? `browser:url:${encodeURIComponent(target.url)}`
    : `browser:${target.relativePath}`;
}

function previewNavigationTargetsEqual(
  left: CodeAgentPreviewNavigationTarget | null,
  right: CodeAgentPreviewNavigationTarget | null,
): boolean {
  if (!left || !right || left.kind !== right.kind) {
    return left === right;
  }
  return left.kind === 'url'
    ? left.url === (right as Extract<CodeAgentPreviewNavigationTarget, { kind: 'url' }>).url
    : left.relativePath === (right as Extract<CodeAgentPreviewNavigationTarget, { kind: 'workspace-file' }>).relativePath;
}

function normalizeRecentPreviewTargets(value: unknown): CodeAgentPreviewNavigationTarget[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const targets: CodeAgentPreviewNavigationTarget[] = [];
  for (const item of value) {
    const target = normalizePreviewNavigationTarget(item);
    if (!target || targets.some((existing) => previewNavigationTargetsEqual(existing, target))) {
      continue;
    }
    targets.push(target);
    if (targets.length >= PREVIEW_RECENT_TARGET_LIMIT) {
      break;
    }
  }
  return targets;
}

function recentPreviewTargetsFromSurfaces(
  surfaces: readonly CodeAgentRightPanelSurface[],
): CodeAgentPreviewNavigationTarget[] {
  const targets: CodeAgentPreviewNavigationTarget[] = [];
  const remember = (target: CodeAgentPreviewNavigationTarget | null) => {
    if (!target || targets.some((existing) => previewNavigationTargetsEqual(existing, target))) {
      return;
    }
    targets.push(target);
  };

  for (const surface of [...surfaces].reverse()) {
    if (surface.kind !== 'preview') {
      continue;
    }
    remember(previewTargetFromSurface(surface));
    const history = surface.navigationHistory ?? [];
    for (const target of [...history].reverse()) {
      remember(normalizePreviewNavigationTarget(target));
      if (targets.length >= PREVIEW_RECENT_TARGET_LIMIT) {
        return targets;
      }
    }
  }
  return targets;
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

function clampPreviewZoomFactor(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, Math.round(value * 100) / 100));
}

function normalizePreviewZoomFactor(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return clampPreviewZoomFactor(value);
}

function previewZoomStateFromSurface(
  surface: Partial<CodeAgentPreviewSurface> | null,
): Pick<CodeAgentPreviewNavigationState, 'zoomFactor'> {
  const zoomFactor = normalizePreviewZoomFactor(surface?.zoomFactor);
  return zoomFactor === undefined || Math.abs(zoomFactor - 1) < PREVIEW_ZOOM_EPSILON
    ? {}
    : { zoomFactor };
}

function previewViewportStateFromSurface(
  surface: Partial<CodeAgentPreviewSurface> | null,
): Pick<CodeAgentPreviewNavigationState, 'viewport'> {
  const viewport = coerceCodeAgentPreviewViewportSetting(surface?.viewport);
  return !viewport || viewport._tag === 'fill' ? {} : { viewport };
}

function previewSessionStateFromSurface(
  surface: Partial<CodeAgentPreviewSurface> | null,
): Pick<CodeAgentPreviewNavigationState, 'previewSessionId'> {
  const previewSessionId = typeof surface?.previewSessionId === 'string'
    ? surface.previewSessionId.trim().slice(0, 256)
    : '';
  return previewSessionId ? { previewSessionId } : {};
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

function normalizePreviewNavigationState(
  surface: Partial<CodeAgentPreviewSurface>,
  currentTarget: CodeAgentPreviewNavigationTarget | null,
): CodeAgentPreviewNavigationState {
  if (!currentTarget) {
    return {};
  }
  const history = Array.isArray(surface.navigationHistory)
    ? surface.navigationHistory.flatMap((target) => {
      const normalized = normalizePreviewNavigationTarget(target);
      return normalized ? [normalized] : [];
    })
    : [];
  const navigationIndex = typeof surface.navigationIndex === 'number' &&
    Number.isSafeInteger(surface.navigationIndex) &&
    surface.navigationIndex >= 0 &&
    surface.navigationIndex < history.length
    ? surface.navigationIndex
    : -1;

  if (navigationIndex >= 0 && previewNavigationTargetsEqual(history[navigationIndex] ?? null, currentTarget)) {
    return { navigationHistory: history, navigationIndex };
  }

  return { navigationHistory: [currentTarget], navigationIndex: 0 };
}

function previewTargetFromSurface(surface: CodeAgentPreviewSurface): CodeAgentPreviewNavigationTarget | null {
  if (surface.url) {
    return { kind: 'url', url: surface.url };
  }
  if (surface.relativePath) {
    return { kind: 'workspace-file', relativePath: surface.relativePath };
  }
  return null;
}

function previewTargetFromSessionSnapshot(
  snapshot: CodeAgentPreviewSessionSurfaceSnapshot,
): CodeAgentPreviewNavigationTarget | null {
  if (snapshot.navStatus._tag === 'Idle') {
    return null;
  }
  return normalizePreviewNavigationTarget({ kind: 'url', url: snapshot.navStatus.url });
}

function isWorkspaceAssetPreviewUrl(value: string): boolean {
  const workspaceAssetPrefixes = [
    '/api/code-agent/workspace-assets/',
  ];
  if (workspaceAssetPrefixes.some((prefix) => value.startsWith(prefix))) {
    return true;
  }
  try {
    const url = new URL(value);
    return workspaceAssetPrefixes.some((prefix) => url.pathname.startsWith(prefix));
  } catch {
    return false;
  }
}

function browserSurface(
  relativePath: string | null,
  navigationState?: CodeAgentPreviewNavigationState,
): CodeAgentPreviewSurface {
  if (!relativePath) {
    return { id: 'browser:new', kind: 'preview', relativePath: null };
  }
  const target: CodeAgentPreviewNavigationTarget = { kind: 'workspace-file', relativePath };
  return {
    id: previewNavigationTargetId(target) as `browser:${string}`,
    kind: 'preview',
    relativePath,
    ...(navigationState ?? { navigationHistory: [target], navigationIndex: 0 }),
  };
}

function browserUrlSurface(
  url: string,
  navigationState?: CodeAgentPreviewNavigationState,
): CodeAgentPreviewSurface | null {
  const normalizedUrl = normalizeBrowserHttpUrl(url);
  if (!normalizedUrl) {
    return null;
  }
  const target: CodeAgentPreviewNavigationTarget = { kind: 'url', url: normalizedUrl };
  return {
    id: previewNavigationTargetId(target) as `browser:url:${string}`,
    kind: 'preview',
    relativePath: null,
    url: normalizedUrl,
    ...(navigationState ?? { navigationHistory: [target], navigationIndex: 0 }),
  };
}

function previewSurfaceFromTarget(
  target: CodeAgentPreviewNavigationTarget,
  navigationState?: CodeAgentPreviewNavigationState,
): CodeAgentPreviewSurface | null {
  return target.kind === 'workspace-file'
    ? browserSurface(target.relativePath, navigationState)
    : browserUrlSurface(target.url, navigationState);
}

function navigationStateAfterPreviewTarget(
  sourceSurface: CodeAgentPreviewSurface | null,
  nextTarget: CodeAgentPreviewNavigationTarget,
): CodeAgentPreviewNavigationState {
  if (!sourceSurface) {
    return { navigationHistory: [nextTarget], navigationIndex: 0 };
  }
  const currentTarget = previewTargetFromSurface(sourceSurface);
  const currentNavigation = normalizePreviewNavigationState(sourceSurface, currentTarget);
  const history = currentNavigation.navigationHistory ?? [];
  const index = currentNavigation.navigationIndex ?? -1;
  if (previewNavigationTargetsEqual(currentTarget, nextTarget)) {
    return history.length > 0 && index >= 0
      ? { navigationHistory: history, navigationIndex: index }
      : { navigationHistory: [nextTarget], navigationIndex: 0 };
  }

  return {
    navigationHistory: [...history.slice(0, index + 1), nextTarget],
    navigationIndex: index + 1,
  };
}

export function getCodeAgentPreviewSurfaceNavigationState(
  surface: CodeAgentRightPanelSurface,
): { canGoBack: boolean; canGoForward: boolean } {
  if (surface.kind !== 'preview') {
    return { canGoBack: false, canGoForward: false };
  }
  const currentTarget = previewTargetFromSurface(surface);
  const navigation = normalizePreviewNavigationState(surface, currentTarget);
  const history = navigation.navigationHistory ?? [];
  const index = navigation.navigationIndex ?? -1;
  return {
    canGoBack: index > 0,
    canGoForward: index >= 0 && index < history.length - 1,
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

function previewSurfaceFromSessionSnapshot(
  snapshot: CodeAgentPreviewSessionSurfaceSnapshot,
  existingSurface: CodeAgentPreviewSurface | null,
  blankSurface: CodeAgentPreviewSurface | null,
): CodeAgentPreviewSurface | null {
  const tabId = snapshot.tabId.trim().slice(0, 256);
  if (!tabId) {
    return null;
  }
  const viewport = coerceCodeAgentPreviewViewportSetting(snapshot.viewport);
  const sessionState: CodeAgentPreviewNavigationState = {
    ...previewZoomStateFromSurface(existingSurface),
    ...(viewport && viewport._tag !== 'fill' ? { viewport } : {}),
    previewSessionId: tabId,
  };
  const target = previewTargetFromSessionSnapshot(snapshot);
  if (!target) {
    const blank = existingSurface ?? blankSurface ?? browserSurface(null);
    return {
      ...blank,
      ...sessionState,
    };
  }
  const sourceSurface = existingSurface ?? null;
  if (
    target.kind === 'url' &&
    sourceSurface?.relativePath &&
    isWorkspaceAssetPreviewUrl(target.url)
  ) {
    return {
      ...sourceSurface,
      ...sessionState,
    };
  }
  return previewSurfaceFromTarget(target, {
    ...navigationStateAfterPreviewTarget(sourceSurface, target),
    ...sessionState,
  });
}

function singletonSurface(kind: 'diff' | 'files' | 'terminal'): CodeAgentRightPanelSurface {
  return kind === 'diff'
    ? { id: 'diff', kind: 'diff' }
    : kind === 'files'
      ? { id: 'files', kind: 'files' }
      : { id: 'terminal', kind: 'terminal', terminalId: 'terminal' };
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
  if (surface.kind === 'terminal' || surface.id === 'terminal') {
    return { id: 'terminal', kind: 'terminal', terminalId: 'terminal' };
  }
  if (surface.kind === 'preview' || (typeof surface.id === 'string' && surface.id.startsWith('browser:'))) {
    const previewSurface = surface as Partial<CodeAgentPreviewSurface>;
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
      const target = normalizePreviewNavigationTarget({ kind: 'url', url: rawUrl });
      const nextSurface = target?.kind === 'url' ? browserUrlSurface(target.url) : null;
      return nextSurface
        ? {
          ...nextSurface,
          ...normalizePreviewNavigationState(previewSurface, target),
          ...previewSessionStateFromSurface(previewSurface),
          ...previewViewportStateFromSurface(previewSurface),
          ...previewZoomStateFromSurface(previewSurface),
        }
        : null;
    }
    if (!relativePath && /^browser:new(?::\d+)?$/.test(rawId)) {
      return {
        id: rawId as 'browser:new' | `browser:new:${number}`,
        kind: 'preview',
        relativePath: null,
        ...previewSessionStateFromSurface(previewSurface),
        ...previewViewportStateFromSurface(previewSurface),
        ...previewZoomStateFromSurface(previewSurface),
      };
    }
    const target = relativePath ? normalizePreviewNavigationTarget({ kind: 'workspace-file', relativePath }) : null;
    const nextSurface = target?.kind === 'workspace-file' ? browserSurface(target.relativePath) : browserSurface(null);
    return {
      ...nextSurface,
      ...normalizePreviewNavigationState(previewSurface, target),
      ...previewSessionStateFromSurface(previewSurface),
      ...previewViewportStateFromSurface(previewSurface),
      ...previewZoomStateFromSurface(previewSurface),
    };
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
  const recentPreviewTargetsByRoomId: Record<string, CodeAgentPreviewNavigationTarget[]> = {};
  const persistedRecentTargets = (
    persistedState as Partial<CodeAgentRightPanelStoreState>
  ).recentPreviewTargetsByRoomId ?? {};
  for (const [roomId, roomState] of Object.entries(
    (persistedState as Partial<CodeAgentRightPanelStoreState>).byRoomId ?? {},
  )) {
    const normalizedRoomId = normalizeRoomId(roomId);
    const coerced = coerceRoomState(roomState);
    if (normalizedRoomId && coerced) {
      byRoomId[normalizedRoomId] = coerced;
      const explicitRecentTargets = normalizeRecentPreviewTargets(
        persistedRecentTargets[normalizedRoomId] ?? persistedRecentTargets[roomId],
      );
      const derivedRecentTargets = explicitRecentTargets.length > 0
        ? explicitRecentTargets
        : recentPreviewTargetsFromSurfaces(coerced.surfaces);
      if (derivedRecentTargets.length > 0) {
        recentPreviewTargetsByRoomId[normalizedRoomId] = derivedRecentTargets;
      }
    }
  }
  return Object.keys(recentPreviewTargetsByRoomId).length > 0
    ? { byRoomId, recentPreviewTargetsByRoomId }
    : { byRoomId };
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

function withRecentPreviewTarget(
  state: CodeAgentRightPanelStoreState,
  roomKey: string,
  target: CodeAgentPreviewNavigationTarget | null,
): CodeAgentRightPanelStoreState {
  const normalizedTarget = normalizePreviewNavigationTarget(target);
  if (!normalizedTarget) {
    return state;
  }
  const currentByRoomId = state.recentPreviewTargetsByRoomId ?? {};
  const currentTargets = currentByRoomId[roomKey] ?? [];
  const nextTargets = [
    normalizedTarget,
    ...currentTargets.filter((target) => !previewNavigationTargetsEqual(target, normalizedTarget)),
  ].slice(0, PREVIEW_RECENT_TARGET_LIMIT);
  if (
    currentTargets.length === nextTargets.length &&
    currentTargets.every((target, index) => previewNavigationTargetsEqual(target, nextTargets[index]))
  ) {
    return state;
  }
  return {
    ...state,
    recentPreviewTargetsByRoomId: {
      ...currentByRoomId,
      [roomKey]: nextTargets,
    },
  };
}

function selectRoomState(roomId: string): CodeAgentRightPanelState {
  const roomKey = normalizeRoomId(roomId);
  return roomKey ? storeState.byRoomId[roomKey] ?? EMPTY_ROOM_STATE : EMPTY_ROOM_STATE;
}

function selectPreviewRecentTargets(roomId: string): readonly CodeAgentPreviewNavigationTarget[] {
  const roomKey = normalizeRoomId(roomId);
  return roomKey
    ? storeState.recentPreviewTargetsByRoomId?.[roomKey] ?? EMPTY_PREVIEW_RECENT_TARGETS
    : EMPTY_PREVIEW_RECENT_TARGETS;
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

export function useCodeAgentPreviewRecentTargets(
  roomId: string,
): readonly CodeAgentPreviewNavigationTarget[] {
  return useSyncExternalStore(
    subscribe,
    () => selectPreviewRecentTargets(roomId),
    () => EMPTY_PREVIEW_RECENT_TARGETS,
  );
}

export function readCodeAgentRightPanelState(roomId: string): CodeAgentRightPanelState {
  return selectRoomState(roomId);
}

export function readCodeAgentPreviewRecentTargets(
  roomId: string,
): readonly CodeAgentPreviewNavigationTarget[] {
  return selectPreviewRecentTargets(roomId);
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

export function openCodeAgentRightPanel(roomId: string, kind: 'diff' | 'files' | 'terminal') {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return;
  }
  updateStore((state) => ({
    ...state,
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
    const withoutSource = current.surfaces.filter((_, index) => index !== sourceIndex);
    return {
      isOpen: true,
      activeSurfaceId: nextSurface.id,
      surfaces: withoutSource.map((surface) => (surface.id === nextSurface.id ? nextSurface : surface)),
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
  const nextTarget = normalizePreviewNavigationTarget(target);
  if (!nextTarget) {
    return;
  }
  if (nextTarget.kind === 'workspace-file' && !nextTarget.relativePath) {
    return;
  }
  updateStore((state) => withRecentPreviewTarget({
    ...state,
    byRoomId: updateRoom(state.byRoomId, roomKey, (current) => {
      const sourceSurface = current.surfaces.find(
        (surface): surface is CodeAgentPreviewSurface => surface.id === surfaceId && surface.kind === 'preview',
      ) ?? null;
      const navigationState = navigationStateAfterPreviewTarget(sourceSurface, nextTarget);
      const nextSurface = previewSurfaceFromTarget(nextTarget, {
        ...navigationState,
        ...previewSessionStateFromSurface(sourceSurface),
        ...previewViewportStateFromSurface(sourceSurface),
        ...previewZoomStateFromSurface(sourceSurface),
      });
      return nextSurface ? replacePreviewSurface(current, surfaceId, nextSurface) : current;
    }),
  }, roomKey, nextTarget));
}

export function navigateCodeAgentRightPanelPreviewHistory(
  roomId: string,
  surfaceId: string,
  direction: 'back' | 'forward',
) {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return;
  }
  updateStore((state) => {
    let rememberedTarget: CodeAgentPreviewNavigationTarget | null = null;
    const byRoomId = updateRoom(state.byRoomId, roomKey, (current) => {
      const sourceSurface = current.surfaces.find(
        (surface): surface is CodeAgentPreviewSurface => surface.id === surfaceId && surface.kind === 'preview',
      );
      if (!sourceSurface) {
        return current;
      }
      const currentTarget = previewTargetFromSurface(sourceSurface);
      const navigation = normalizePreviewNavigationState(sourceSurface, currentTarget);
      const history = navigation.navigationHistory ?? [];
      const index = navigation.navigationIndex ?? -1;
      const nextIndex = direction === 'back' ? index - 1 : index + 1;
      const nextTarget = history[nextIndex];
      if (!nextTarget) {
        return current;
      }
      rememberedTarget = normalizePreviewNavigationTarget(nextTarget);
      const nextSurface = previewSurfaceFromTarget(nextTarget, {
        navigationHistory: history,
        navigationIndex: nextIndex,
        ...previewSessionStateFromSurface(sourceSurface),
        ...previewViewportStateFromSurface(sourceSurface),
        ...previewZoomStateFromSurface(sourceSurface),
      });
      return nextSurface ? replacePreviewSurface(current, surfaceId, nextSurface) : current;
    });
    return withRecentPreviewTarget({ ...state, byRoomId }, roomKey, rememberedTarget);
  });
}

export function setCodeAgentRightPanelPreviewZoomFactor(
  roomId: string,
  surfaceId: string,
  zoomFactor: number,
) {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return;
  }
  const nextZoomFactor = clampPreviewZoomFactor(zoomFactor);
  updateStore((state) => ({
    ...state,
    byRoomId: updateRoom(state.byRoomId, roomKey, (current) => {
      const nextSurfaces = current.surfaces.map((surface) => {
        if (
          surface.kind !== 'preview' ||
          (surface.id !== surfaceId && surface.previewSessionId !== surfaceId)
        ) {
          return surface;
        }
        const currentZoomFactor = surface.zoomFactor ?? 1;
        if (Math.abs(currentZoomFactor - nextZoomFactor) < PREVIEW_ZOOM_EPSILON) {
          return surface;
        }
        if (Math.abs(nextZoomFactor - 1) < PREVIEW_ZOOM_EPSILON) {
          const { zoomFactor: _removed, ...rest } = surface;
          return rest;
        }
        return { ...surface, zoomFactor: nextZoomFactor };
      });
      return nextSurfaces.every((surface, index) => surface === current.surfaces[index])
        ? current
        : { ...current, surfaces: nextSurfaces };
    }),
  }));
}

export function setCodeAgentRightPanelPreviewViewport(
  roomId: string,
  surfaceId: string,
  viewport: CodeAgentPreviewViewportSetting,
) {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return;
  }
  const nextViewport = coerceCodeAgentPreviewViewportSetting(viewport) ?? FILL_CODE_AGENT_PREVIEW_VIEWPORT;
  updateStore((state) => ({
    ...state,
    byRoomId: updateRoom(state.byRoomId, roomKey, (current) => {
      const nextSurfaces = current.surfaces.map((surface) => {
        if (
          surface.kind !== 'preview' ||
          (surface.id !== surfaceId && surface.previewSessionId !== surfaceId)
        ) {
          return surface;
        }
        const currentViewport = coerceCodeAgentPreviewViewportSetting(surface.viewport)
          ?? FILL_CODE_AGENT_PREVIEW_VIEWPORT;
        if (
          currentViewport._tag === nextViewport._tag &&
          (currentViewport._tag === 'fill' || (
            nextViewport._tag !== 'fill' &&
            currentViewport.width === nextViewport.width &&
            currentViewport.height === nextViewport.height &&
            (
              currentViewport._tag !== 'preset' ||
              (nextViewport._tag === 'preset' && currentViewport.presetId === nextViewport.presetId)
            )
          ))
        ) {
          return surface;
        }
        if (nextViewport._tag === 'fill') {
          const { viewport: _removed, ...rest } = surface;
          return rest;
        }
        return { ...surface, viewport: nextViewport };
      });
      return nextSurfaces.every((surface, index) => surface === current.surfaces[index])
        ? current
        : { ...current, surfaces: nextSurfaces };
    }),
  }));
}

export function setCodeAgentRightPanelPreviewSessionId(
  roomId: string,
  surfaceId: string,
  previewSessionId: string,
) {
  const roomKey = normalizeRoomId(roomId);
  const nextPreviewSessionId = previewSessionId.trim().slice(0, 256);
  if (!roomKey || !nextPreviewSessionId) {
    return;
  }
  updateStore((state) => ({
    ...state,
    byRoomId: updateRoom(state.byRoomId, roomKey, (current) => {
      const nextSurfaces = current.surfaces.map((surface) => {
        if (surface.id !== surfaceId || surface.kind !== 'preview') {
          return surface;
        }
        return surface.previewSessionId === nextPreviewSessionId
          ? surface
          : { ...surface, previewSessionId: nextPreviewSessionId };
      });
      return nextSurfaces.every((surface, index) => surface === current.surfaces[index])
        ? current
        : { ...current, surfaces: nextSurfaces };
    }),
  }));
}

export function openCodeAgentRightPanelPreview(roomId: string, relativePath?: string | null) {
  const roomKey = normalizeRoomId(roomId);
  const normalizedPath = relativePath ? normalizeWorkspacePath(relativePath) : '';
  if (!roomKey) {
    return;
  }
  updateStore((state) => {
    const target = normalizedPath ? { kind: 'workspace-file' as const, relativePath: normalizedPath } : null;
    return withRecentPreviewTarget({
      ...state,
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
    }, roomKey, target);
  });
}

export function addCodeAgentRightPanelPreviewSurface(roomId: string) {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return;
  }
  updateStore((state) => ({
    ...state,
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

export function reconcileCodeAgentPreviewSessionSurfaces(
  roomId: string,
  snapshots: readonly CodeAgentPreviewSessionSurfaceSnapshot[],
) {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return;
  }
  updateStore((state) => {
    let rememberedTarget: CodeAgentPreviewNavigationTarget | null = null;
    const byRoomId = updateRoom(state.byRoomId, roomKey, (current) => {
      if (snapshots.length === 0) {
        return current;
      }
      let surfaces = current.surfaces;
      let activeSurfaceId = current.activeSurfaceId;
      let changed = false;
      let fallbackSurfaceId: string | null = null;

      const upsertSurface = (
        nextSurface: CodeAgentPreviewSurface,
        sourceIndex: number,
      ) => {
        const duplicateIndex = surfaces.findIndex((surface) => surface.id === nextSurface.id);
        const sourceSurface = sourceIndex >= 0 ? surfaces[sourceIndex] : null;
        const nextSurfaces = [...surfaces];

        if (duplicateIndex >= 0 && duplicateIndex !== sourceIndex) {
          nextSurfaces[duplicateIndex] = nextSurface;
          if (sourceIndex >= 0) {
            nextSurfaces.splice(sourceIndex, 1);
          }
          if (sourceSurface && activeSurfaceId === sourceSurface.id) {
            activeSurfaceId = nextSurface.id;
          }
          if (activeSurfaceId === surfaces[duplicateIndex]?.id) {
            activeSurfaceId = nextSurface.id;
          }
        } else if (sourceIndex >= 0) {
          nextSurfaces[sourceIndex] = nextSurface;
          if (sourceSurface && activeSurfaceId === sourceSurface.id) {
            activeSurfaceId = nextSurface.id;
          }
        } else {
          nextSurfaces.push(nextSurface);
        }

        if (
          nextSurfaces.length !== surfaces.length ||
          nextSurfaces.some((surface, index) => surface !== surfaces[index])
        ) {
          changed = true;
          surfaces = nextSurfaces;
        }
        fallbackSurfaceId = nextSurface.id;
      };

      for (const snapshot of snapshots) {
        const tabId = snapshot.tabId.trim();
        if (!tabId) {
          continue;
        }
        const sourceIndex = surfaces.findIndex((surface) => (
          surface.kind === 'preview' && (surface.previewSessionId === tabId || surface.id === tabId)
        ));
        const sourceSurface = sourceIndex >= 0 && surfaces[sourceIndex].kind === 'preview'
          ? surfaces[sourceIndex] as CodeAgentPreviewSurface
          : null;
        const blankSurface = sourceSurface
          ? null
          : nextBlankBrowserSurface(surfaces) as CodeAgentPreviewSurface;
        const nextSurface = previewSurfaceFromSessionSnapshot(snapshot, sourceSurface, blankSurface);
        if (!nextSurface) {
          continue;
        }
        rememberedTarget = previewTargetFromSurface(nextSurface) ?? rememberedTarget;
        upsertSurface(nextSurface, sourceIndex);
      }

      if (!changed) {
        return current;
      }
      const activeStillExists = activeSurfaceId !== null && surfaces.some((surface) => surface.id === activeSurfaceId);
      const nextActiveSurfaceId = activeStillExists
        ? activeSurfaceId
        : (fallbackSurfaceId ?? surfaces.at(-1)?.id ?? null);
      return {
        isOpen: current.isOpen || current.activeSurfaceId === null,
        surfaces,
        activeSurfaceId: nextActiveSurfaceId,
      };
    });
    return withRecentPreviewTarget({ ...state, byRoomId }, roomKey, rememberedTarget);
  });
}

export function closeCodeAgentPreviewSessionSurface(roomId: string, tabId: string) {
  const roomKey = normalizeRoomId(roomId);
  const normalizedTabId = tabId.trim();
  if (!roomKey || !normalizedTabId) {
    return;
  }
  updateStore((state) => ({
    ...state,
    byRoomId: updateRoom(state.byRoomId, roomKey, (current) => {
      const index = current.surfaces.findIndex((surface) => (
        surface.kind === 'preview' && (surface.previewSessionId === normalizedTabId || surface.id === normalizedTabId)
      ));
      if (index < 0) {
        return current;
      }
      const surfaces = current.surfaces.filter((_, surfaceIndex) => surfaceIndex !== index);
      if (current.activeSurfaceId !== current.surfaces[index].id) {
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

export function openCodeAgentRightPanelFile(roomId: string, relativePath: string, line?: number | null) {
  const roomKey = normalizeRoomId(roomId);
  const normalizedPath = normalizeWorkspacePath(relativePath);
  if (!roomKey || !normalizedPath) {
    return;
  }
  updateStore((state) => ({
    ...state,
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
    ...state,
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
    ...state,
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
    ...state,
    byRoomId: updateRoom(state.byRoomId, roomKey, (current) => ({
      ...current,
      isOpen: !current.isOpen,
    })),
  }));
}

export function toggleCodeAgentRightPanel(roomId: string, kind: 'diff' | 'files' | 'preview' | 'terminal') {
  const roomKey = normalizeRoomId(roomId);
  if (!roomKey) {
    return;
  }
  updateStore((state) => ({
    ...state,
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
    ...state,
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
    ...state,
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
    ...state,
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
    ...state,
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
    ...state,
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
    ...state,
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
    if (!(roomKey in state.byRoomId) && !(roomKey in (state.recentPreviewTargetsByRoomId ?? {}))) {
      return state;
    }
    const { [roomKey]: _removed, ...byRoomId } = state.byRoomId;
    const { [roomKey]: _removedRecent, ...recentPreviewTargetsByRoomId } =
      state.recentPreviewTargetsByRoomId ?? {};
    return Object.keys(recentPreviewTargetsByRoomId).length > 0
      ? { byRoomId, recentPreviewTargetsByRoomId }
      : { byRoomId };
  });
}

export function resetCodeAgentRightPanelStoreForTests(state: CodeAgentRightPanelStoreState = emptyStoreState()) {
  storeState = state;
  writePersistedState(storeState);
  emit();
}
