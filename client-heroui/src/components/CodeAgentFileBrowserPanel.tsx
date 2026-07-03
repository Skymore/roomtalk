import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  Copy,
  Download,
  ExternalLink,
  FileDiff,
  FileWarning,
  Files,
  Globe2,
  LoaderCircle,
  Minus,
  MoreVertical,
  MousePointerClick,
  Plus,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Square,
  TerminalSquare,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  createCodeWorkspaceAssetUrl,
  createCodeWorkspaceDirectory,
  deleteCodeWorkspaceEntry,
  loadCodeWorkspaceEntries,
  loadCodeWorkspaceFile,
  renameCodeWorkspaceEntry,
  resolveCodeWorkspaceAssetUrl,
  searchCodeWorkspaceEntries,
  writeCodeWorkspaceFile,
  type CodeWorkspaceAssetUrl,
  type CodeWorkspaceEntry,
  type CodeWorkspaceFile,
} from '../utils/codeWorkspaceFiles';
import { appendWorkspaceAssetPreviewRevision } from '../utils/codeWorkspaceFilePreview';
import type { CodeAgentWorkspaceSnapshot } from '../utils/cocoWorkspace';
import type { RoomSandboxStatus } from '../utils/types';
import { codeAgentFaviconUrlForOrigin } from '../utils/codeAgentFavicon';
import { beginHorizontalResize } from '../utils/horizontalResize';
import { normalizeWorkspaceOpenPath, parseWorkspaceFileOpenTarget } from '../utils/workspaceFileOpenTarget';
import { type ReviewCommentContext } from '../utils/codeAgentReviewComments';
import {
  isCodeAgentPreviewAnnotationContext,
  type CodeAgentPreviewAnnotationContext,
} from '../utils/codeAgentPreviewAnnotations';
import {
  basename,
  isBrowserPreviewFile,
  isImagePreviewFile,
  isMarkdownPreviewFile,
} from './codeAgentFilePath';
import { CodeAgentChangedFilesTree } from './CodeAgentChangedFilesTree';
import { CodeAgentDiffStatLabel, hasNonZeroChangedFileStat } from './CodeAgentDiffStatLabel';
import {
  getOptimisticCodeAgentProjectFileQueryData,
  resolveCodeAgentProjectFileQueryData,
  settleConfirmedCodeAgentProjectFileQueryData,
} from './codeAgentProjectFilesQueryState';
import {
  CodeAgentFilePreviewPanel,
  WorkspaceBrowserAssetPreview,
  type WorkspaceBrowserPreviewStatus,
} from './CodeAgentFilePreviewPanel';
import { CodeAgentPierreEntryIcon } from './CodeAgentPierreEntryIcon';
import {
  CodeAgentWorkspaceDiffViewer,
  type CodeAgentWorkspaceDiffFileSummary,
} from './CodeAgentWorkspaceDiffViewer';
import {
  CodeAgentWorkspaceFileTreePanel,
  type CodeAgentProjectEntry,
} from './CodeAgentWorkspaceFileTreePanel';
import {
  clearCodeAgentDiffFile,
  selectCodeAgentDiffFile,
  useCodeAgentDiffPanelSelection,
} from '../utils/codeAgentDiffPanelStore';
import { summarizeCodeAgentChangedFileStats } from '../utils/codeAgentChangedFileTree';
import {
  setCodeAgentChangedFilesExpanded,
  useCodeAgentChangedFilesExpanded,
} from '../utils/codeAgentChangedFilesExpansionStore';
import {
  activateCodeAgentRightPanelSurface,
  addCodeAgentRightPanelPreviewSurface,
  closeAllCodeAgentRightPanelSurfaces,
  closeCodeAgentRightPanelSurface,
  closeCodeAgentRightPanelSurfacesToRight,
  closeCodeAgentPreviewSessionSurface,
  closeOtherCodeAgentRightPanelSurfaces,
  getCodeAgentPreviewSurfaceNavigationState,
  navigateCodeAgentRightPanelPreviewHistory,
  navigateCodeAgentRightPanelPreviewSurface,
  openCodeAgentRightPanel,
  openCodeAgentRightPanelFile,
  openCodeAgentRightPanelPreview,
  readCodeAgentRightPanelState,
  reconcileCodeAgentPreviewSessionSurfaces,
  reconcileCodeAgentFileSurfaces,
  setCodeAgentRightPanelPreviewSessionId,
  setCodeAgentRightPanelPreviewZoomFactor,
  setCodeAgentRightPanelPreviewViewport,
  useCodeAgentPreviewRecentTargets,
  type CodeAgentPreviewNavigationTarget,
  type CodeAgentRightPanelState,
  type CodeAgentRightPanelSurface,
  useCodeAgentRightPanelState,
} from '../utils/codeAgentRightPanelStore';
import {
  closeCodeWorkspacePreviewSession,
  codeWorkspacePreviewUrlFromStatus,
  listCodeWorkspacePreviewSessions,
  navigateCodeWorkspacePreviewSession,
  openCodeWorkspacePreviewSession,
  refreshCodeWorkspacePreviewSession,
  reportCodeWorkspacePreviewSession,
  resolveCodeWorkspacePreviewTarget,
  resizeCodeWorkspacePreviewSession,
  subscribeCodeWorkspacePreviewEvents,
  type CodeWorkspacePreviewNavStatus,
  type CodeWorkspacePreviewSession,
} from '../utils/codeWorkspacePreviewSessions';
import {
  needsCodeWorkspacePreviewAutomationSessionSync,
  resolveCodeWorkspacePreviewAutomationOpenTab,
  resolveCodeWorkspacePreviewAutomationTarget,
  type CodeWorkspacePreviewAutomationSessionIndex,
} from '../utils/codeWorkspacePreviewAutomationTarget';
import {
  listCodeWorkspacePreviewServers,
  mergeCodeWorkspacePreviewServers,
  previewPortTargetFromLocalUrl,
  type CodeWorkspacePreviewServer,
  type PreviewableCodeWorkspacePreviewServer,
} from '../utils/codeWorkspacePreviewServers';
import {
  CODE_AGENT_PREVIEW_VIEWPORT_PRESET_IDS,
  FILL_CODE_AGENT_PREVIEW_VIEWPORT,
  resolveCodeAgentPreviewViewport,
  type CodeAgentPreviewViewportPresetId,
  type CodeAgentPreviewViewportSetting,
  type CodeAgentPreviewViewportSize,
} from '../utils/codeAgentPreviewViewport';
import {
  codeAgentBrowserViewportSettingKey,
  resolveResponsiveCodeAgentBrowserViewportSize,
} from '../utils/codeAgentBrowserViewportLayout';
import {
  CODE_WORKSPACE_PREVIEW_AUTOMATION_CLOUD_BROWSER_OPERATIONS,
  CODE_WORKSPACE_PREVIEW_AUTOMATION_SESSION_OPERATIONS,
  connectCodeWorkspacePreviewAutomationHost,
  runCodeWorkspacePreviewAutomationRequest,
  type CodeWorkspacePreviewAutomationRequest,
} from '../utils/codeWorkspacePreviewAutomation';
import {
  codeWorkspacePreviewAutomationOpenNeedsReadiness,
  codeWorkspacePreviewAutomationReadiness,
  codeWorkspacePreviewAutomationTimeoutMs,
  type CodeWorkspacePreviewAutomationReadiness,
} from '../utils/codeWorkspacePreviewAutomationReadiness';
import { isCodeWorkspacePreviewViewportReady } from '../utils/codeWorkspacePreviewViewportReadiness';
import {
  isCodeWorkspacePreviewDomAutomationOperation,
  type CodeWorkspacePreviewDomAutomationHandler,
} from '../utils/codeWorkspacePreviewDomAutomation';

interface CodeAgentFileBrowserPanelProps {
  roomId: string;
  projectName: string;
  surface?: 'desktop' | 'mobile';
  sandboxStatus?: RoomSandboxStatus;
  sandboxUpdatedAt?: string;
  workspaceRoot?: string | null;
  workspaceChanges?: CodeAgentWorkspaceSnapshot['changes'] | null;
  openFileRequest?: { path: string; requestId: number } | null;
  revealLine?: number | null;
  revealRequestId?: number;
  reviewComments?: readonly ReviewCommentContext[];
  onAddReviewComment?: (comment: ReviewCommentContext) => void;
  onRemoveReviewComment?: (commentId: string) => void;
  onAddPreviewAnnotation?: (annotation: CodeAgentPreviewAnnotationContext) => void;
  onFileSavePendingChange?: (relativePath: string, pending: boolean) => void;
}

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';
type SaveStatus = {
  path: string | null;
  state: SaveState;
  error: string | null;
};

type ScopedDiffFileSummaries = {
  scopeKey: string | null;
  summaries: readonly CodeAgentWorkspaceDiffFileSummary[];
};

const EMPTY_DIFF_FILE_SUMMARIES: readonly CodeAgentWorkspaceDiffFileSummary[] = [];
const EMPTY_CHANGED_FILES: string[] = [];
const EMPTY_CHANGED_FILE_STATS: CodeAgentWorkspaceSnapshot['changes']['changedFileStats'] = [];

type FileSurfaceTabMenuState = {
  surfaceId: string;
  x: number;
  y: number;
} | null;

type FileQueryState = {
  data: CodeWorkspaceFile | null;
  error: string | null;
  isPending: boolean;
  refresh: () => void;
  setData: React.Dispatch<React.SetStateAction<CodeWorkspaceFile | null>>;
};

type AssetUrlQueryState = {
  data: CodeWorkspaceAssetUrl | null;
  resolvedUrl: string | null;
  error: string | null;
  isPending: boolean;
};

type WorkspaceRemoteSearchState = {
  query: string;
  scopeKey: string | null;
  entries: CodeWorkspaceEntry[];
  truncated: boolean;
  isPending: boolean;
  error: string | null;
};

interface CodeAgentRightPanelEmptyStateProps {
  onAddBrowser: () => void;
  onAddFiles: () => void;
  onAddDiff: () => void;
}

type CodeAgentPreviewPanelSurface = Extract<CodeAgentRightPanelSurface, { kind: 'preview' }>;

function isCodeAgentPreviewSurface(
  surface: CodeAgentRightPanelSurface,
): surface is CodeAgentPreviewPanelSurface {
  return surface.kind === 'preview';
}

function previewAutomationRequestedTabId(
  request: CodeWorkspacePreviewAutomationRequest,
): string | undefined {
  const tabId = typeof request.tabId === 'string' ? request.tabId.trim() : '';
  return tabId || undefined;
}

function previewAutomationTabIdFromSurface(surface: CodeAgentPreviewPanelSurface): string {
  return surface.previewSessionId ?? surface.id;
}

function previewAutomationSessionFromSurface(
  roomId: string,
  surface: CodeAgentPreviewPanelSurface,
): CodeWorkspacePreviewSession {
  const url = surface.url ?? null;
  return {
    roomId,
    tabId: previewAutomationTabIdFromSurface(surface),
    navStatus: url
      ? { _tag: 'Success', url, title: url }
      : { _tag: 'Idle' },
    canGoBack: false,
    canGoForward: false,
    viewport: surface.viewport ?? FILL_CODE_AGENT_PREVIEW_VIEWPORT,
    updatedAt: new Date(0).toISOString(),
  };
}

function findPreviewAutomationSurfaceByTabId(
  state: CodeAgentRightPanelState,
  tabId: string | null | undefined,
): CodeAgentPreviewPanelSurface | null {
  if (!tabId) {
    return null;
  }
  return state.surfaces.find((surface): surface is CodeAgentPreviewPanelSurface => (
    isCodeAgentPreviewSurface(surface) && previewAutomationTabIdFromSurface(surface) === tabId
  )) ?? null;
}

function previewAutomationSessionIndexFromRightPanelState(
  roomId: string,
  state: CodeAgentRightPanelState,
  serverSessions: readonly CodeWorkspacePreviewSession[] = [],
): CodeWorkspacePreviewAutomationSessionIndex {
  const sessions: Record<string, CodeWorkspacePreviewSession> = {};
  for (const surface of state.surfaces) {
    if (!isCodeAgentPreviewSurface(surface)) {
      continue;
    }
    const session = previewAutomationSessionFromSurface(roomId, surface);
    sessions[session.tabId] = session;
  }
  for (const session of serverSessions) {
    sessions[session.tabId] = session;
  }
  const activeSurface = state.surfaces.find((surface): surface is CodeAgentPreviewPanelSurface => (
    state.activeSurfaceId === surface.id && isCodeAgentPreviewSurface(surface)
  )) ?? null;
  const activeTabId = activeSurface ? previewAutomationTabIdFromSurface(activeSurface) : null;
  return {
    snapshot: activeTabId ? sessions[activeTabId] ?? null : null,
    sessions,
  };
}

function previewAutomationStatusFromSession(
  state: CodeAgentRightPanelState,
  surface: CodeAgentPreviewPanelSurface | null,
  session: CodeWorkspacePreviewSession,
) {
  const navStatus = session.navStatus;
  const url = codeWorkspacePreviewUrlFromStatus(navStatus);
  const visible = Boolean(surface && state.isOpen && state.activeSurfaceId === surface.id);
  return {
    available: true,
    visible,
    tabId: session.tabId,
    url,
    title: navStatus._tag === 'Idle' ? null : navStatus.title || url,
    loading: navStatus._tag === 'Loading',
    viewportSetting: session.viewport ?? FILL_CODE_AGENT_PREVIEW_VIEWPORT,
  };
}

function previewAutomationStatusFromSurface(
  state: CodeAgentRightPanelState,
  surface: CodeAgentPreviewPanelSurface | null,
) {
  const visible = Boolean(surface && state.isOpen && state.activeSurfaceId === surface.id);
  return {
    available: true,
    visible,
    tabId: surface ? previewAutomationTabIdFromSurface(surface) : null,
    url: surface?.url ?? surface?.relativePath ?? null,
    title: surface?.url ?? surface?.relativePath ?? null,
    loading: false,
    ...(surface ? { viewportSetting: surface.viewport ?? FILL_CODE_AGENT_PREVIEW_VIEWPORT } : {}),
  };
}

function recoverablePreviewSessionSurfaces(
  state: CodeAgentRightPanelState,
): Array<CodeAgentPreviewPanelSurface & { url: string }> {
  return state.surfaces.filter((surface): surface is CodeAgentPreviewPanelSurface & { url: string } => (
    isCodeAgentPreviewSurface(surface) && typeof surface.url === 'string' && surface.url.length > 0
  ));
}

const FILE_WORD_WRAP_STORAGE_KEY = 'roomtalk.codeWorkspace.fileWordWrap';
const FILE_EXPLORER_STORAGE_KEY = 'roomtalk.codeWorkspace.fileExplorerOpen';
const FILE_EXPLORER_WIDTH_STORAGE_KEY = 'roomtalk.codeWorkspace.fileExplorerWidth';
const FILE_EXPLORER_MIN_WIDTH = 160;
const FILE_PREVIEW_MIN_WIDTH = 220;
const FILE_EXPLORER_DEFAULT_WIDTH = 352;
const DIFF_CHANGED_FILES_WIDTH_STORAGE_KEY = 'roomtalk.codeWorkspace.diffChangedFilesWidth';
const DIFF_CHANGED_FILES_MIN_WIDTH = 180;
const DIFF_VIEWER_MIN_WIDTH = 260;
const DIFF_CHANGED_FILES_DEFAULT_WIDTH = 288;
const FILE_SURFACE_MENU_VIEWPORT_PADDING = 8;
const FILE_SURFACE_ADD_MENU_WIDTH = 160;
const FILE_SURFACE_ADD_MENU_HEIGHT = 136;
const FILE_SURFACE_TAB_MENU_WIDTH = 160;
const FILE_SURFACE_TAB_MENU_HEIGHT = 168;
const WORKSPACE_TREE_REMOTE_SEARCH_LIMIT = 200;
const WORKSPACE_TREE_REMOTE_SEARCH_DEBOUNCE_MS = 150;
const EMPTY_WORKSPACE_ENTRIES: readonly CodeWorkspaceEntry[] = [];

function getFileExplorerResizeBounds(panelWidth: number) {
  return {
    min: FILE_EXPLORER_MIN_WIDTH,
    max: Math.max(FILE_EXPLORER_MIN_WIDTH, Math.floor(panelWidth - FILE_PREVIEW_MIN_WIDTH)),
  };
}

function clampFileExplorerWidth(value: number, panelWidth: number): number {
  const bounds = getFileExplorerResizeBounds(panelWidth);
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}

function getDiffChangedFilesResizeBounds(panelWidth: number) {
  return {
    min: DIFF_CHANGED_FILES_MIN_WIDTH,
    max: Math.max(DIFF_CHANGED_FILES_MIN_WIDTH, Math.floor(panelWidth - DIFF_VIEWER_MIN_WIDTH)),
  };
}

function clampDiffChangedFilesWidth(value: number, panelWidth: number): number {
  const bounds = getDiffChangedFilesResizeBounds(panelWidth);
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}

function clampFixedMenuPosition({
  x,
  y,
  width,
  height,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number } {
  const viewportWidth = typeof window === 'undefined'
    ? width + FILE_SURFACE_MENU_VIEWPORT_PADDING * 2
    : window.innerWidth;
  const viewportHeight = typeof window === 'undefined'
    ? height + FILE_SURFACE_MENU_VIEWPORT_PADDING * 2
    : window.innerHeight;

  return {
    x: Math.max(
      FILE_SURFACE_MENU_VIEWPORT_PADDING,
      Math.min(Math.round(x), viewportWidth - width - FILE_SURFACE_MENU_VIEWPORT_PADDING),
    ),
    y: Math.max(
      FILE_SURFACE_MENU_VIEWPORT_PADDING,
      Math.min(Math.round(y), viewportHeight - height - FILE_SURFACE_MENU_VIEWPORT_PADDING),
    ),
  };
}

function normalizeWorkspacePath(path: string): string {
  return normalizeWorkspaceOpenPath(path);
}

function normalizeBrowserHttpUrl(input: string): string | null {
  const trimmed = input.trim();
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

function resolveBrowserNavigationTarget(
  input: string,
  workspaceRoot?: string | null,
): { kind: 'workspace-file'; relativePath: string } | { kind: 'url'; url: string } | null {
  const url = normalizeBrowserHttpUrl(input);
  if (url) {
    return { kind: 'url', url };
  }

  const target = parseWorkspaceFileOpenTarget(input, { workspaceRoot: workspaceRoot ?? undefined });
  if (!target || !isBrowserPreviewFile(target.path)) {
    return null;
  }
  return { kind: 'workspace-file', relativePath: target.path };
}

function formatBrowserSurfaceUrlTitle(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch {
    return url;
  }
}

function formatBrowserPreviewTargetTitle(target: CodeAgentPreviewNavigationTarget): string {
  return target.kind === 'url'
    ? formatBrowserSurfaceUrlTitle(target.url)
    : basename(target.relativePath);
}

function formatBrowserPreviewTargetSubtitle(target: CodeAgentPreviewNavigationTarget): string {
  return target.kind === 'url' ? target.url : target.relativePath;
}

const BROWSER_PREVIEW_ZOOM_MIN = 0.25;
const BROWSER_PREVIEW_ZOOM_MAX = 3;
const BROWSER_PREVIEW_ZOOM_STEP = 0.1;
const BROWSER_PREVIEW_ZOOM_EPSILON = 0.001;
const BROWSER_PREVIEW_ZOOM_INDICATOR_HIDE_MS = 1500;
const BROWSER_PREVIEW_LOAD_TICK_INTERVAL_MS = 120;
const BROWSER_PREVIEW_LOAD_FADE_OUT_MS = 220;
const BROWSER_PREVIEW_LOAD_SEED_PERCENT = 4;
const BROWSER_PREVIEW_LOAD_ASYMPTOTE_PERCENT = 90;
const BROWSER_PREVIEW_LOAD_APPROACH_FACTOR = 0.08;
const BROWSER_PREVIEW_LOAD_MIN_INCREMENT = 0.5;

function clampBrowserPreviewZoomFactor(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(BROWSER_PREVIEW_ZOOM_MAX, Math.max(BROWSER_PREVIEW_ZOOM_MIN, Math.round(value * 100) / 100));
}

function formatBrowserPreviewZoomFactor(value: number): string {
  return `${Math.round(clampBrowserPreviewZoomFactor(value) * 100)}%`;
}

function useCodeAgentBrowserLoadingProgress(loading: boolean): number {
  const [progress, setProgress] = useState(0);
  const progressRef = useRef(0);
  progressRef.current = progress;

  useEffect(() => {
    if (!loading) {
      if (progressRef.current === 0) {
        return undefined;
      }
      setProgress(100);
      const timer = window.setTimeout(() => setProgress(0), BROWSER_PREVIEW_LOAD_FADE_OUT_MS);
      return () => window.clearTimeout(timer);
    }

    setProgress((value) => (
      value > 0 && value < 95 ? value : BROWSER_PREVIEW_LOAD_SEED_PERCENT
    ));
    const interval = window.setInterval(() => {
      const current = progressRef.current;
      if (current >= BROWSER_PREVIEW_LOAD_ASYMPTOTE_PERCENT) {
        return;
      }
      const remaining = BROWSER_PREVIEW_LOAD_ASYMPTOTE_PERCENT - current;
      const increment = Math.max(BROWSER_PREVIEW_LOAD_MIN_INCREMENT, remaining * BROWSER_PREVIEW_LOAD_APPROACH_FACTOR);
      setProgress(Math.min(BROWSER_PREVIEW_LOAD_ASYMPTOTE_PERCENT, current + increment));
    }, BROWSER_PREVIEW_LOAD_TICK_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [loading]);

  return progress;
}

function CodeAgentBrowserTabIcon({
  url,
}: {
  url: string | null | undefined;
}) {
  const faviconUrl = codeAgentFaviconUrlForOrigin(url, 32);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (!faviconUrl || failedUrl === faviconUrl) {
    return (
      <Globe2
        className="h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]"
        data-testid="code-agent-browser-tab-favicon-fallback"
      />
    );
  }

  return (
    <img
      src={faviconUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
      className="h-3.5 w-3.5 shrink-0 rounded-sm"
      data-testid="code-agent-browser-tab-favicon"
      onError={() => setFailedUrl(faviconUrl)}
    />
  );
}

function CodeAgentBrowserZoomIndicator({
  zoomFactor,
}: {
  zoomFactor: number;
}) {
  const [visible, setVisible] = useState(false);
  const lastZoomFactorRef = useRef(zoomFactor);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (Math.abs(lastZoomFactorRef.current - zoomFactor) < BROWSER_PREVIEW_ZOOM_EPSILON) {
      return undefined;
    }
    lastZoomFactorRef.current = zoomFactor;
    setVisible(true);
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      setVisible(false);
      timerRef.current = null;
    }, BROWSER_PREVIEW_ZOOM_INDICATOR_HIDE_MS);
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [zoomFactor]);

  return (
    <div
      aria-hidden={!visible}
      className={`pointer-events-none absolute right-3 top-3 z-20 select-none rounded-full border border-[#dedbd0] bg-[#faf9f5]/95 px-2.5 py-1 text-xs font-medium tabular-nums text-[#141413] shadow-lg backdrop-blur transition-all duration-200 dark:border-[#30302e] dark:bg-[#1d1d1b]/95 dark:text-[#faf9f5] ${
        visible ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0'
      }`}
      data-testid="code-agent-browser-zoom-indicator"
    >
      {formatBrowserPreviewZoomFactor(zoomFactor)}
    </div>
  );
}

function CodeAgentBrowserMoreMenu({
  canRefresh,
  canZoom,
  canToggleDeviceToolbar,
  canClearBrowserData,
  clearCookiesPending,
  clearCachePending,
  zoomFactor,
  deviceToolbarVisible,
  onHardReload,
  onToggleDeviceToolbar,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onClearCookies,
  onClearCache,
}: {
  canRefresh: boolean;
  canZoom: boolean;
  canToggleDeviceToolbar: boolean;
  canClearBrowserData: boolean;
  clearCookiesPending: boolean;
  clearCachePending: boolean;
  zoomFactor: number;
  deviceToolbarVisible: boolean;
  onHardReload: () => void;
  onToggleDeviceToolbar: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onClearCookies: () => void;
  onClearCache: () => void;
}) {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const menuOpen = menuPosition !== null;
  const zoomLabel = formatBrowserPreviewZoomFactor(zoomFactor);
  const canZoomOut = canZoom && zoomFactor > BROWSER_PREVIEW_ZOOM_MIN + BROWSER_PREVIEW_ZOOM_EPSILON;
  const canZoomIn = canZoom && zoomFactor < BROWSER_PREVIEW_ZOOM_MAX - BROWSER_PREVIEW_ZOOM_EPSILON;
  const canResetZoom = canZoom && Math.abs(zoomFactor - 1) >= BROWSER_PREVIEW_ZOOM_EPSILON;

  const closeMenu = useCallback(() => {
    setMenuPosition(null);
  }, []);

  const toggleMenu = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (menuOpen) {
      closeMenu();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const menuWidth = 224;
    const menuHeight = 240;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || menuWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || menuHeight;
    setMenuPosition({
      x: Math.min(Math.max(8, rect.right - menuWidth), Math.max(8, viewportWidth - menuWidth - 8)),
      y: Math.min(rect.bottom + 6, Math.max(8, viewportHeight - menuHeight - 8)),
    });
  }, [closeMenu, menuOpen]);

  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (buttonRef.current?.contains(target) || menuRef.current?.contains(target))
      ) {
        return;
      }
      closeMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeMenu, menuOpen]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#87867f] transition-colors hover:bg-[#f0eee6] hover:text-[#141413] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]"
        aria-label={t('moreActions')}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={t('moreActions')}
        onClick={toggleMenu}
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </button>
      {menuOpen && menuPosition ? (
        <div
          ref={menuRef}
          className="fixed z-[90] min-w-56 rounded-md border border-[#dedbd0] bg-[#faf9f5] p-1 shadow-xl dark:border-[#30302e] dark:bg-[#1d1d1b]"
          data-testid="code-agent-browser-more-menu"
          role="menu"
          style={{ left: menuPosition.x, top: menuPosition.y }}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[#141413] hover:bg-[#f0eee6] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent dark:text-[#faf9f5] dark:hover:bg-[#30302e] dark:disabled:hover:bg-transparent"
            role="menuitem"
            disabled={!canRefresh}
            onClick={() => {
              onHardReload();
              closeMenu();
            }}
          >
            <RefreshCw className="h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]" />
            <span className="min-w-0 truncate">{t('codeAgentBrowserHardReload')}</span>
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[#141413] hover:bg-[#f0eee6] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent dark:text-[#faf9f5] dark:hover:bg-[#30302e] dark:disabled:hover:bg-transparent"
            role="menuitem"
            disabled={!canToggleDeviceToolbar}
            onClick={() => {
              onToggleDeviceToolbar();
              closeMenu();
            }}
          >
            <Globe2 className="h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]" />
            <span className="min-w-0 truncate">
              {deviceToolbarVisible
                ? t('codeAgentBrowserHideDeviceToolbar')
                : t('codeAgentBrowserShowDeviceToolbar')}
            </span>
          </button>
          <div className="my-1 h-px bg-[#dedbd0] dark:bg-[#30302e]" />
          <div
            className={`flex items-center justify-between gap-3 rounded px-2 py-1.5 text-xs ${
              canZoom ? 'text-[#141413] dark:text-[#faf9f5]' : 'text-[#87867f] opacity-60 dark:text-[#8f8d86]'
            }`}
            role="group"
            aria-label={t('codeAgentBrowserZoom')}
          >
            <span>{t('codeAgentBrowserZoom')}</span>
            <span className="flex items-center gap-1">
              <button
                type="button"
                className="inline-flex h-6 w-6 items-center justify-center rounded border border-[#dedbd0] text-[#5e5d59] hover:bg-[#f0eee6] disabled:cursor-not-allowed disabled:opacity-40 dark:border-[#30302e] dark:text-[#b0aea5] dark:hover:bg-[#30302e]"
                aria-label={t('codeAgentBrowserZoomOut')}
                disabled={!canZoomOut}
                onClick={onZoomOut}
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
              <span className="min-w-12 text-center text-[11px] tabular-nums text-[#87867f] dark:text-[#8f8d86]">
                {zoomLabel}
              </span>
              <button
                type="button"
                className="inline-flex h-6 w-6 items-center justify-center rounded border border-[#dedbd0] text-[#5e5d59] hover:bg-[#f0eee6] disabled:cursor-not-allowed disabled:opacity-40 dark:border-[#30302e] dark:text-[#b0aea5] dark:hover:bg-[#30302e]"
                aria-label={t('codeAgentBrowserZoomIn')}
                disabled={!canZoomIn}
                onClick={onZoomIn}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className="inline-flex h-6 w-6 items-center justify-center rounded text-[#5e5d59] hover:bg-[#f0eee6] disabled:cursor-not-allowed disabled:opacity-40 dark:text-[#b0aea5] dark:hover:bg-[#30302e]"
                aria-label={t('codeAgentBrowserResetZoom')}
                disabled={!canResetZoom}
                onClick={onResetZoom}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            </span>
          </div>
          <div className="my-1 h-px bg-[#dedbd0] dark:bg-[#30302e]" />
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[#141413] hover:bg-[#f0eee6] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent dark:text-[#faf9f5] dark:hover:bg-[#30302e] dark:disabled:hover:bg-transparent"
            role="menuitem"
            disabled={!canClearBrowserData || clearCookiesPending}
            onClick={() => {
              onClearCookies();
              closeMenu();
            }}
          >
            {clearCookiesPending ? (
              <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-[#87867f] dark:text-[#8f8d86]" />
            ) : (
              <Trash2 className="h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]" />
            )}
            <span className="min-w-0 truncate">{t('codeAgentBrowserClearCookies')}</span>
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[#141413] hover:bg-[#f0eee6] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent dark:text-[#faf9f5] dark:hover:bg-[#30302e] dark:disabled:hover:bg-transparent"
            role="menuitem"
            disabled={!canClearBrowserData || clearCachePending}
            onClick={() => {
              onClearCache();
              closeMenu();
            }}
          >
            {clearCachePending ? (
              <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-[#87867f] dark:text-[#8f8d86]" />
            ) : (
              <Trash2 className="h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]" />
            )}
            <span className="min-w-0 truncate">{t('codeAgentBrowserClearCache')}</span>
          </button>
        </div>
      ) : null}
    </>
  );
}

function CodeAgentRightPanelEmptyState({
  onAddBrowser,
  onAddFiles,
  onAddDiff,
}: CodeAgentRightPanelEmptyStateProps) {
  const { t } = useTranslation();
  const actions = [
    {
      label: t('codeAgentBrowserSurface'),
      description: t('codeAgentBrowserSurfaceDescription'),
      disabledReason: null,
      icon: Globe2,
      onClick: onAddBrowser,
    },
    {
      label: t('codeAgentTerminalSurface'),
      description: t('codeAgentTerminalSurfaceDescription'),
      disabledReason: t('codeAgentTerminalSurfaceUnavailable'),
      icon: TerminalSquare,
      onClick: null,
    },
    {
      label: t('codeAgentWorkspaceFiles'),
      description: t('codeAgentFilesSurfaceDescription'),
      disabledReason: null,
      icon: Files,
      onClick: onAddFiles,
    },
    {
      label: t('codeAgentChanges'),
      description: t('codeAgentDiffSurfaceDescription'),
      disabledReason: null,
      icon: FileDiff,
      onClick: onAddDiff,
    },
  ] as const;

  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center p-6"
      data-testid="code-agent-file-surface-empty"
    >
      <div className="w-full max-w-xl">
        <div className="mb-5 text-center">
          <h3 className="text-sm font-medium text-[#141413] dark:text-[#faf9f5]">
            {t('codeAgentOpenWorkspaceSurface')}
          </h3>
          <p className="mt-1 text-xs text-[#87867f] dark:text-[#8f8d86]">
            {t('codeAgentChooseWorkspaceSurface')}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {actions.map((action) => {
            const Icon = action.icon;
            const available = action.onClick !== null;
            return (
              <button
                key={action.label}
                type="button"
                aria-disabled={!available}
                disabled={!available}
                title={action.disabledReason ?? undefined}
                onClick={action.onClick ?? undefined}
                className={`flex min-h-28 w-full flex-col items-start rounded-lg border border-[#dedbd0] bg-[#faf9f5]/70 p-4 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:border-[#30302e] dark:bg-[#1d1d1b]/70 ${
                  available
                    ? 'hover:border-[#c9c5b8] hover:bg-[#f0eee6] dark:hover:border-[#3c3c38] dark:hover:bg-[#242422]'
                    : 'cursor-not-allowed opacity-40'
                }`}
              >
                <Icon className="mb-3 h-5 w-5 text-[#5e5d59] dark:text-[#b0aea5]" />
                <span className="text-sm font-medium text-[#141413] dark:text-[#faf9f5]">
                  {action.label}
                </span>
                <span className="mt-1 text-xs leading-relaxed text-[#87867f] dark:text-[#8f8d86]">
                  {action.description}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface CodeAgentPreviewSurfaceProps {
  roomId: string;
  surface: CodeAgentPreviewPanelSurface;
  mobileLayout?: boolean;
  assetUrlQuery: AssetUrlQueryState;
  assetPreviewRevision: number;
  focusUrlNonce?: number;
  recentTargets: readonly CodeAgentPreviewNavigationTarget[];
  workspaceRoot?: string | null;
  onNavigate: (
    surfaceId: string,
    target: { kind: 'workspace-file'; relativePath: string } | { kind: 'url'; url: string },
  ) => void;
  onNavigateHistory: (surfaceId: string, direction: 'back' | 'forward') => void;
  onRefreshWorkspacePreview: (relativePath: string) => void;
  onRecordingArtifactSaved: (artifact: CodeAgentPreviewRecordingArtifact) => void;
  onOpenWorkspaceFile: (relativePath: string) => void;
  onAddPreviewAnnotation?: (annotation: CodeAgentPreviewAnnotationContext) => void;
  onRenderedViewportChange: (
    tabId: string,
    setting: CodeAgentPreviewViewportSetting,
    viewport: CodeAgentPreviewViewportSize,
  ) => void;
  waitForRenderedViewport: (
    tabId: string,
    setting: CodeAgentPreviewViewportSetting,
    timeoutMs: number,
    requestId: string,
  ) => unknown;
}

type CodeAgentPreviewAutomationHandler = (
  request: CodeWorkspacePreviewAutomationRequest,
) => unknown;

type CodeAgentPreviewAutomationController = {
  dispose: () => void;
  setFocused: (focused: boolean) => unknown;
};

type CodeAgentPreviewAutomationScreenshot = {
  mimeType: 'image/png';
  data: string;
  width: number;
  height: number;
  unavailable?: boolean;
};

type CodeAgentPreviewAutomationSnapshot = {
  screenshot: CodeAgentPreviewAutomationScreenshot;
};

type CodeAgentPreviewRecordingArtifact = {
  id: string;
  tabId: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
};

type CodeAgentPreviewAutomationNavigationWaiter = {
  id: number;
  requestId: string;
  url: string;
  readiness: CodeWorkspacePreviewAutomationReadiness;
  timeoutId: number;
  resolve: () => void;
  reject: (error: Error) => void;
};

type CodeAgentPreviewAutomationViewportWaiter = {
  id: number;
  requestId: string;
  tabId: string;
  setting: CodeAgentPreviewViewportSetting;
  timeoutId: number;
  resolve: (viewport: CodeAgentPreviewViewportSize) => void;
  reject: (error: Error) => void;
};

type CodeAgentPreviewRenderedViewportSnapshot = {
  setting: CodeAgentPreviewViewportSetting;
  viewport: CodeAgentPreviewViewportSize;
};

interface CodeAgentBrowserSurfaceChromeProps {
  value: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  canRefresh: boolean;
  canOpenExternal: boolean;
  canCaptureScreenshot: boolean;
  canRecordPreview: boolean;
  canAnnotatePreview: boolean;
  screenshotCapturePending: boolean;
  screenshotCaptureCopied: boolean;
  recordingActive: boolean;
  recordingPending: boolean;
  annotationActive: boolean;
  annotationPending: boolean;
  canZoom: boolean;
  canToggleDeviceToolbar: boolean;
  canClearBrowserData: boolean;
  clearCookiesPending: boolean;
  clearCachePending: boolean;
  zoomFactor: number;
  deviceToolbarVisible: boolean;
  mobileLayout?: boolean;
  focusUrlNonce?: number;
  navigationError: string | null;
  onBack: () => void;
  onForward: () => void;
  onSubmit: (value: string) => void;
  onRefresh: () => void;
  onOpenExternal: () => void;
  onCaptureScreenshot: () => void;
  onToggleRecording: () => void;
  onToggleAnnotation: () => void;
  onHardReload: () => void;
  onToggleDeviceToolbar: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onClearCookies: () => void;
  onClearCache: () => void;
}

function formatBrowserSurfaceAddressDisplay(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.host : value;
  } catch {
    return value;
  }
}

const PREVIEW_ERROR_CODE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ERR_NAME_NOT_RESOLVED: 'DNS address could not be found',
  ERR_NAME_RESOLUTION_FAILED: 'DNS address could not be found',
  ERR_CONNECTION_REFUSED: 'Connection refused',
  ERR_CONNECTION_RESET: 'Connection was reset',
  ERR_CONNECTION_CLOSED: 'Connection was closed',
  ERR_CONNECTION_TIMED_OUT: 'Connection timed out',
  ERR_INTERNET_DISCONNECTED: 'No internet connection',
  ERR_TIMED_OUT: 'Connection timed out',
  ERR_CERT_AUTHORITY_INVALID: 'Certificate authority is not trusted',
  ERR_CERT_COMMON_NAME_INVALID: 'Certificate hostname mismatch',
  ERR_CERT_DATE_INVALID: 'Certificate is expired or not yet valid',
  ERR_TOO_MANY_REDIRECTS: 'Too many redirects',
});

interface CodeAgentBrowserLoadFailure {
  url: string;
  title: string;
  code: number;
  description: string;
}

function browserLoadFailureFromNavStatus(
  status: CodeWorkspacePreviewNavStatus,
): CodeAgentBrowserLoadFailure | null {
  if (status._tag !== 'LoadFailed') {
    return null;
  }
  return {
    url: status.url,
    title: status.title,
    code: status.code,
    description: status.description,
  };
}

function describePreviewError(code: number, description: string): string {
  const trimmed = description.trim();
  const friendly = PREVIEW_ERROR_CODE_MESSAGES[trimmed];
  if (friendly) {
    return friendly;
  }
  if (trimmed) {
    return trimmed;
  }
  return `Network error (${code})`;
}

function previewErrorLabel(code: number, description: string): string {
  const trimmed = description.trim();
  return trimmed || `ERR_${Math.abs(code) || 'FAILED'}`;
}

function safeBrowserPreviewHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function CodeAgentBrowserUnreachable({
  failure,
  onReload,
}: {
  failure: CodeAgentBrowserLoadFailure;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const [showDetails, setShowDetails] = useState(false);
  const host = safeBrowserPreviewHost(failure.url) ?? failure.url;
  const friendly = describePreviewError(failure.code, failure.description);
  const errorLabel = previewErrorLabel(failure.code, failure.description);

  return (
    <div
      className="relative flex h-full min-h-0 w-full overflow-y-auto bg-white dark:bg-[#141413]"
      data-testid="code-agent-browser-preview-unreachable"
    >
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col px-8 py-12 sm:py-16">
        <FileWarning className="mb-6 h-12 w-12 text-[#87867f] dark:text-[#8f8d86]" />
        <h1 className="mb-3 text-2xl font-semibold leading-tight text-[#141413] dark:text-[#faf9f5]">
          {t('codeAgentBrowserUnreachableTitle')}
        </h1>
        <p className="text-sm leading-relaxed text-[#5e5d59] dark:text-[#b0aea5]">
          <span className="font-semibold text-[#141413] dark:text-[#faf9f5]">{host}</span>
          {t('codeAgentBrowserUnreachableReasonSuffix', { reason: friendly })}
        </p>

        {showDetails ? (
          <div className="mt-6 rounded-lg border border-[#dedbd0] bg-[#f5f4ed] p-4 text-sm dark:border-[#30302e] dark:bg-[#1d1d1b]">
            <p className="mb-2 font-medium text-[#141413] dark:text-[#faf9f5]">
              {t('codeAgentBrowserUnreachableTry')}
            </p>
            <ul className="list-disc space-y-1 pl-5 text-[#5e5d59] dark:text-[#b0aea5]">
              <li>{t('codeAgentBrowserUnreachableCheckConnection')}</li>
              <li>{t('codeAgentBrowserUnreachableCheckServer')}</li>
              <li>{t('codeAgentBrowserUnreachableCheckProxy')}</li>
            </ul>
          </div>
        ) : null}

        <div className="mt-8 text-xs uppercase tracking-wide text-[#87867f] dark:text-[#8f8d86]">
          {errorLabel}
        </div>

        <div className="mt-auto flex items-center gap-2 pt-8">
          <button
            type="button"
            className="inline-flex h-8 items-center rounded-md border border-[#dedbd0] px-3 text-xs font-medium text-[#4d4c48] transition-colors hover:bg-[#f0eee6] hover:text-[#141413] dark:border-[#30302e] dark:text-[#b0aea5] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]"
            onClick={() => setShowDetails((value) => !value)}
          >
            {showDetails
              ? t('codeAgentBrowserUnreachableHideDetails')
              : t('codeAgentBrowserUnreachableDetails')}
          </button>
          <div className="flex-1" />
          <button
            type="button"
            className="inline-flex h-8 items-center rounded-md bg-[#c96442] px-3 text-xs font-semibold text-white transition-colors hover:bg-[#b95334] dark:bg-[#d97757] dark:hover:bg-[#c96442]"
            onClick={onReload}
          >
            {t('codeAgentBrowserUnreachableReload')}
          </button>
        </div>
      </div>
    </div>
  );
}

function previewAutomationStringInput(input: unknown, key: string): string | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

type PreviewAutomationNavigationTarget =
  | { kind: 'url'; url: string }
  | { kind: 'environment-port'; port: number; protocol?: 'http' | 'https'; path?: string };

function previewAutomationNavigationTarget(input: unknown): PreviewAutomationNavigationTarget | null {
  const directUrl = previewAutomationStringInput(input, 'url');
  if (directUrl) {
    return { kind: 'url', url: directUrl };
  }
  if (!input || typeof input !== 'object') {
    return null;
  }
  const target = (input as { target?: unknown }).target;
  if (!target || typeof target !== 'object') {
    return null;
  }
  const kind = (target as { kind?: unknown }).kind;
  if (kind === 'url') {
    const url = previewAutomationStringInput(target, 'url');
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
  const path = previewAutomationStringInput(target, 'path');
  return {
    kind: 'environment-port',
    port,
    ...(protocol ? { protocol } : {}),
    ...(path ? { path } : {}),
  };
}

async function previewAutomationNavigationUrl(roomId: string, input: unknown): Promise<string | null> {
  const target = previewAutomationNavigationTarget(input);
  if (!target) {
    return null;
  }
  if (target.kind === 'url') {
    return target.url;
  }
  const resolution = await resolveCodeWorkspacePreviewTarget({ roomId, target });
  return resolution.resolvedUrl;
}

function previewAutomationViewportSetting(input: unknown): CodeAgentPreviewViewportSetting {
  if (!input || typeof input !== 'object') {
    throw new Error('Preview automation resize input is invalid.');
  }
  const record = input as Record<string, unknown>;
  if (record.mode === 'fill') {
    return FILL_CODE_AGENT_PREVIEW_VIEWPORT;
  }
  if (record.mode === 'freeform') {
    return resolveCodeAgentPreviewViewport({
      mode: 'freeform',
      width: Number(record.width),
      height: Number(record.height),
    });
  }
  if (record.mode === 'preset' && typeof record.preset === 'string') {
    if (!CODE_AGENT_PREVIEW_VIEWPORT_PRESET_IDS.includes(record.preset as CodeAgentPreviewViewportPresetId)) {
      throw new Error(`Unknown preview viewport preset: ${record.preset}`);
    }
    return resolveCodeAgentPreviewViewport({
      mode: 'preset',
      preset: record.preset as CodeAgentPreviewViewportPresetId,
      orientation: record.orientation === 'landscape' || record.orientation === 'portrait'
        ? record.orientation
        : undefined,
    });
  }
  throw new Error('Preview automation resize input is invalid.');
}

function isPreviewAutomationSnapshot(value: unknown): value is CodeAgentPreviewAutomationSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const screenshot = (value as { screenshot?: unknown }).screenshot;
  if (!screenshot || typeof screenshot !== 'object') {
    return false;
  }
  const record = screenshot as Partial<CodeAgentPreviewAutomationScreenshot>;
  return (
    record.mimeType === 'image/png'
    && typeof record.data === 'string'
    && record.data.length > 0
    && typeof record.width === 'number'
    && Number.isInteger(record.width)
    && record.width > 0
    && typeof record.height === 'number'
    && Number.isInteger(record.height)
    && record.height > 0
  );
}

function isPreviewRecordingStart(value: unknown): value is { tabId: string; recording: true; startedAt: string } {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<{ tabId: unknown; recording: unknown; startedAt: unknown }>;
  return (
    typeof record.tabId === 'string'
    && record.recording === true
    && typeof record.startedAt === 'string'
    && record.startedAt.length > 0
  );
}

function isPreviewRecordingArtifact(value: unknown): value is CodeAgentPreviewRecordingArtifact {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<CodeAgentPreviewRecordingArtifact>;
  return (
    typeof record.id === 'string'
    && record.id.length > 0
    && typeof record.tabId === 'string'
    && record.tabId.length > 0
    && typeof record.path === 'string'
    && record.path.length > 0
    && typeof record.mimeType === 'string'
    && record.mimeType.length > 0
    && typeof record.sizeBytes === 'number'
    && Number.isFinite(record.sizeBytes)
    && record.sizeBytes >= 0
    && typeof record.createdAt === 'string'
    && record.createdAt.length > 0
  );
}

function previewScreenshotFilename(value: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rawName = (() => {
    try {
      const url = new URL(value);
      return `${url.hostname}${url.pathname}`;
    } catch {
      return value || 'preview';
    }
  })();
  const safeName = rawName
    .replace(/[\r\n]+/g, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'preview';
  return `roomtalk-preview-${safeName}-${timestamp}.png`;
}

function previewRecordingFilename(path: string): string {
  const filename = path.split('/').pop()?.trim();
  return filename || 'preview-recording.webm';
}

function downloadPreviewScreenshot(screenshot: CodeAgentPreviewAutomationScreenshot, filename: string): void {
  const link = document.createElement('a');
  link.href = `data:image/png;base64,${screenshot.data}`;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function downloadWorkspaceAssetUrl(url: string, path: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = previewRecordingFilename(path);
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function previewScreenshotBlob(screenshot: CodeAgentPreviewAutomationScreenshot): Blob {
  const raw = window.atob(screenshot.data);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return new Blob([bytes], { type: screenshot.mimeType });
}

async function copyPreviewScreenshotToClipboard(screenshot: CodeAgentPreviewAutomationScreenshot): Promise<boolean> {
  if (
    typeof navigator === 'undefined'
    || !navigator.clipboard
    || typeof navigator.clipboard.write !== 'function'
    || typeof ClipboardItem === 'undefined'
  ) {
    return false;
  }
  await navigator.clipboard.write([
    new ClipboardItem({ [screenshot.mimeType]: previewScreenshotBlob(screenshot) }),
  ]);
  return true;
}

async function copyTextToClipboard(value: string): Promise<boolean> {
  if (
    typeof navigator === 'undefined'
    || !navigator.clipboard
    || typeof navigator.clipboard.writeText !== 'function'
  ) {
    return false;
  }
  await navigator.clipboard.writeText(value);
  return true;
}

function CodeAgentBrowserSurfaceChrome({
  value,
  loading,
  canGoBack,
  canGoForward,
  canRefresh,
  canOpenExternal,
  canCaptureScreenshot,
  canRecordPreview,
  canAnnotatePreview,
  screenshotCapturePending,
  screenshotCaptureCopied,
  recordingActive,
  recordingPending,
  annotationActive,
  annotationPending,
  canZoom,
  canToggleDeviceToolbar,
  canClearBrowserData,
  clearCookiesPending,
  clearCachePending,
  zoomFactor,
  deviceToolbarVisible,
  mobileLayout = false,
  focusUrlNonce,
  navigationError,
  onBack,
  onForward,
  onSubmit,
  onRefresh,
  onOpenExternal,
  onCaptureScreenshot,
  onToggleRecording,
  onToggleAnnotation,
  onHardReload,
  onToggleDeviceToolbar,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onClearCookies,
  onClearCache,
}: CodeAgentBrowserSurfaceChromeProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(value);
  const [inputFocused, setInputFocused] = useState(false);
  const loadProgress = useCodeAgentBrowserLoadingProgress(loading);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (focusUrlNonce === undefined) {
      return;
    }
    inputRef.current?.focus();
  }, [focusUrlNonce]);

  const submit = useCallback((event?: React.FormEvent | React.KeyboardEvent) => {
    event?.preventDefault();
    const nextValue = draft.trim();
    if (!nextValue) {
      return;
    }
    onSubmit(nextValue);
    setInputFocused(false);
    inputRef.current?.blur();
  }, [draft, onSubmit]);

  const displayValue = inputFocused ? draft : formatBrowserSurfaceAddressDisplay(value);
  const displayTitle = !inputFocused && displayValue !== value ? value : undefined;
  const captureScreenshotLabel = screenshotCaptureCopied ? t('copied') : t('codeAgentBrowserCaptureScreenshot');
  const recordingLabel = recordingPending
    ? (recordingActive ? t('codeAgentBrowserRecordingStopping') : t('codeAgentBrowserRecordingStarting'))
    : recordingActive
      ? t('codeAgentBrowserStopRecording')
      : t('codeAgentBrowserStartRecording');
  const annotationLabel = annotationPending
    ? t('codeAgentBrowserPreviewAnnotationCapturing')
    : annotationActive
      ? t('codeAgentBrowserCancelPreviewAnnotation')
      : t('codeAgentBrowserAnnotatePreview');
  const browserChromeButtonClass = 'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#87867f] transition-colors hover:bg-[#f0eee6] hover:text-[#141413] disabled:cursor-not-allowed disabled:opacity-45 dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]';
  const addressInput = (
    <input
      ref={inputRef}
      aria-label={t('codeAgentBrowserAddressLabel')}
      className="h-7 min-w-0 flex-1 rounded-md border border-transparent bg-[#f0eee6] px-2 text-xs text-[#141413] outline-none transition-colors placeholder:text-[#87867f] focus:border-[#c96442]/70 focus:bg-[#faf9f5] dark:bg-[#242422] dark:text-[#faf9f5] dark:placeholder:text-[#8f8d86] dark:focus:border-[#d97757]/70 dark:focus:bg-[#1d1d1b]"
      placeholder={t('codeAgentBrowserAddressPlaceholder')}
      spellCheck={false}
      title={displayTitle}
      value={displayValue}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => {
        setDraft(value);
        setInputFocused(true);
        queueMicrotask(() => inputRef.current?.select());
      }}
      onBlur={() => {
        setInputFocused(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          submit(event);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setDraft(value);
          setInputFocused(false);
          inputRef.current?.blur();
        }
      }}
    />
  );
  const backButton = (
    <button
      type="button"
      className={browserChromeButtonClass}
      aria-label={t('codeAgentBrowserBack')}
      title={t('codeAgentBrowserBack')}
      disabled={!canGoBack}
      onClick={onBack}
    >
      <ArrowLeft className="h-3.5 w-3.5" />
    </button>
  );
  const forwardButton = (
    <button
      type="button"
      className={browserChromeButtonClass}
      aria-label={t('codeAgentBrowserForward')}
      title={t('codeAgentBrowserForward')}
      disabled={!canGoForward}
      onClick={onForward}
    >
      <ArrowRight className="h-3.5 w-3.5" />
    </button>
  );
  const refreshButton = (
    <button
      type="button"
      className={browserChromeButtonClass}
      aria-label={t('codeAgentBrowserRefresh')}
      title={t('codeAgentBrowserRefresh')}
      disabled={!canRefresh}
      onClick={onRefresh}
    >
      <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
    </button>
  );
  const openExternalButton = (
    <button
      type="button"
      className={browserChromeButtonClass}
      aria-label={t('codeAgentOpenBrowserPreviewExternally')}
      title={t('codeAgentOpenBrowserPreviewExternally')}
      disabled={!canOpenExternal}
      onClick={onOpenExternal}
    >
      <ExternalLink className="h-3.5 w-3.5" />
    </button>
  );
  const screenshotButton = (
    <button
      type="button"
      className={browserChromeButtonClass}
      aria-label={captureScreenshotLabel}
      title={captureScreenshotLabel}
      disabled={!canCaptureScreenshot || screenshotCapturePending || recordingActive || recordingPending}
      onClick={onCaptureScreenshot}
    >
      {screenshotCapturePending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
    </button>
  );
  const recordingButton = (
    <button
      type="button"
      className={`${browserChromeButtonClass} ${recordingActive ? 'bg-[#fff2ec] text-[#c94b2c] hover:bg-[#f7ded3] hover:text-[#9f321b] dark:bg-[#332019] dark:text-[#ff9b78] dark:hover:bg-[#4a271d]' : ''}`}
      aria-label={recordingLabel}
      aria-pressed={recordingActive}
      title={recordingLabel}
      disabled={!canRecordPreview || recordingPending}
      onClick={onToggleRecording}
    >
      {recordingPending ? (
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
      ) : recordingActive ? (
        <Square className="h-3.5 w-3.5 fill-current" />
      ) : (
        <Video className="h-3.5 w-3.5" />
      )}
    </button>
  );
  const annotationButton = (
    <button
      type="button"
      className={`${browserChromeButtonClass} ${annotationActive ? 'bg-[#fff2ec] text-[#c94b2c] hover:bg-[#f7ded3] hover:text-[#9f321b] dark:bg-[#332019] dark:text-[#ff9b78] dark:hover:bg-[#4a271d]' : ''}`}
      aria-label={annotationLabel}
      aria-pressed={annotationActive}
      title={annotationLabel}
      disabled={!canAnnotatePreview || annotationPending}
      onClick={onToggleAnnotation}
    >
      {annotationPending ? (
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <MousePointerClick className="h-3.5 w-3.5" />
      )}
    </button>
  );
  const moreMenu = (
    <CodeAgentBrowserMoreMenu
      canRefresh={canRefresh}
      canZoom={canZoom}
      canToggleDeviceToolbar={canToggleDeviceToolbar}
      canClearBrowserData={canClearBrowserData}
      clearCookiesPending={clearCookiesPending}
      clearCachePending={clearCachePending}
      zoomFactor={zoomFactor}
      deviceToolbarVisible={deviceToolbarVisible}
      onHardReload={onHardReload}
      onToggleDeviceToolbar={onToggleDeviceToolbar}
      onZoomIn={onZoomIn}
      onZoomOut={onZoomOut}
      onResetZoom={onResetZoom}
      onClearCookies={onClearCookies}
      onClearCache={onClearCache}
    />
  );

  if (mobileLayout) {
    return (
      <div
        className="relative shrink-0 border-b border-[#dedbd0] bg-[#faf9f5] px-2 py-2 dark:border-[#30302e] dark:bg-[#1d1d1b]"
        data-mobile-browser-chrome="true"
        data-testid="code-agent-mobile-browser-chrome"
      >
        <form className="flex flex-col gap-2" onSubmit={submit}>
          <div className="flex h-8 items-center gap-2" data-testid="code-agent-mobile-browser-address-row">
            {addressInput}
          </div>
          <div className="flex h-8 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" data-testid="code-agent-mobile-browser-action-row">
            <div className="flex shrink-0 items-center gap-1" role="group">
              {backButton}
              {forwardButton}
              {refreshButton}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {annotationButton}
              {screenshotButton}
              {recordingButton}
              {openExternalButton}
              {moreMenu}
            </div>
          </div>
        </form>
        {navigationError ? (
          <div
            className="mt-2 rounded-md border border-[#f0b49b]/50 bg-[#fff2ec] px-2 py-1.5 text-[11px] text-[#9f462c] dark:border-[#7a321f]/60 dark:bg-[#2a211d] dark:text-[#ff9b78]"
            role="alert"
          >
            {navigationError}
          </div>
        ) : null}
        {loadProgress > 0 ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 left-0 z-10 h-0.5 rounded-r-full bg-[#c96442] transition-all duration-150 ease-out dark:bg-[#d97757]"
            data-testid="code-agent-browser-loading-progress"
            style={{
              width: `${loadProgress}%`,
              boxShadow: '0 0 6px 1px rgba(201, 100, 66, 0.45)',
            }}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="relative shrink-0 border-b border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]">
      <form
        className="flex h-9 items-center gap-1.5 px-2"
        onSubmit={submit}
      >
        <button
          type="button"
          className={browserChromeButtonClass}
          aria-label={t('codeAgentBrowserBack')}
          title={t('codeAgentBrowserBack')}
          disabled={!canGoBack}
          onClick={onBack}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        {forwardButton}
        {refreshButton}
        {addressInput}
        {screenshotButton}
        {recordingButton}
        {annotationButton}
        {openExternalButton}
        {moreMenu}
      </form>
      {navigationError ? (
        <div
          className="border-t border-[#f0b49b]/50 bg-[#fff2ec] px-3 py-1.5 text-[11px] text-[#9f462c] dark:border-[#7a321f]/60 dark:bg-[#2a211d] dark:text-[#ff9b78]"
          role="alert"
        >
          {navigationError}
        </div>
      ) : null}
      {loadProgress > 0 ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 left-0 z-10 h-0.5 rounded-r-full bg-[#c96442] transition-all duration-150 ease-out dark:bg-[#d97757]"
          data-testid="code-agent-browser-loading-progress"
          style={{
            width: `${loadProgress}%`,
            boxShadow: '0 0 6px 1px rgba(201, 100, 66, 0.45)',
          }}
        />
      ) : null}
    </div>
  );
}

function CodeAgentPreviewSurface({
  roomId,
  surface,
  mobileLayout = false,
  assetUrlQuery,
  assetPreviewRevision,
  focusUrlNonce,
  recentTargets,
  workspaceRoot,
  onNavigate,
  onNavigateHistory,
  onRefreshWorkspacePreview,
  onRecordingArtifactSaved,
  onOpenWorkspaceFile,
  onAddPreviewAnnotation,
  onRenderedViewportChange,
  waitForRenderedViewport,
}: CodeAgentPreviewSurfaceProps) {
  const { t } = useTranslation();
  const relativePath = surface.relativePath;
  const previewUrl = surface.url ?? null;
  const isBrowserEmptyPreview = !relativePath && !previewUrl;
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [browserLoadFailure, setBrowserLoadFailure] = useState<CodeAgentBrowserLoadFailure | null>(null);
  const [browserReloadNonce, setBrowserReloadNonce] = useState(0);
  const [browserFrameLoading, setBrowserFrameLoading] = useState(false);
  const [workspacePreviewServers, setWorkspacePreviewServers] = useState<CodeWorkspacePreviewServer[]>([]);
  const [workspacePreviewServersPending, setWorkspacePreviewServersPending] = useState(false);
  const [workspacePreviewServersError, setWorkspacePreviewServersError] = useState<string | null>(null);
  const [workspacePreviewServersRefreshNonce, setWorkspacePreviewServersRefreshNonce] = useState(0);
  const [screenshotCaptureState, setScreenshotCaptureState] = useState<'idle' | 'pending' | 'copied'>('idle');
  const [browserRecordingActive, setBrowserRecordingActive] = useState(false);
  const [browserRecordingAction, setBrowserRecordingAction] = useState<'idle' | 'starting' | 'stopping'>('idle');
  const [browserRecordingArtifact, setBrowserRecordingArtifact] = useState<CodeAgentPreviewRecordingArtifact | null>(null);
  const [browserRecordingAssetUrl, setBrowserRecordingAssetUrl] = useState<string | null>(null);
  const [browserRecordingPathCopied, setBrowserRecordingPathCopied] = useState(false);
  const [browserDataAction, setBrowserDataAction] = useState<'clearCookies' | 'clearCache' | null>(null);
  const [previewAnnotationActive, setPreviewAnnotationActive] = useState(false);
  const [previewAnnotationPending, setPreviewAnnotationPending] = useState(false);
  const [previewAnnotationDraft, setPreviewAnnotationDraft] = useState<CodeAgentPreviewAnnotationContext | null>(null);
  const [previewAnnotationComment, setPreviewAnnotationComment] = useState('');
  const [previewViewportContainerSize, setPreviewViewportContainerSize] = useState({ width: 1024, height: 768 });
  const zoomFactor = surface.zoomFactor ?? 1;
  const viewport = surface.viewport ?? FILL_CODE_AGENT_PREVIEW_VIEWPORT;
  const viewportRef = useRef(viewport);
  const screenshotCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewAnnotationCommentRef = useRef<HTMLTextAreaElement | null>(null);
  const currentAddress = previewUrl ?? relativePath ?? '';
  const resolvedWorkspacePreviewUrl = relativePath && assetUrlQuery.resolvedUrl
    ? appendWorkspaceAssetPreviewRevision(assetUrlQuery.resolvedUrl, assetPreviewRevision)
    : null;
  const resolvedPreviewUrl = previewUrl ?? resolvedWorkspacePreviewUrl;
  const canRefreshPreview = Boolean(resolvedPreviewUrl || relativePath || isBrowserEmptyPreview);
  const browserChromeLoading = assetUrlQuery.isPending || (Boolean(resolvedPreviewUrl) && browserFrameLoading);
  const { canGoBack, canGoForward } = getCodeAgentPreviewSurfaceNavigationState(surface);
  const previewSessionTabId = surface.previewSessionId ?? surface.id;
  const previewAutomationHandlerRef = useRef<CodeAgentPreviewAutomationHandler>(async () => {
    throw new Error('Workspace preview automation is not ready.');
  });
  const previewDomAutomationHandlerRef = useRef<CodeWorkspacePreviewDomAutomationHandler | null>(null);
  const previewNavigationWaitersRef = useRef<CodeAgentPreviewAutomationNavigationWaiter[]>([]);
  const previewNavigationWaiterIdRef = useRef(0);
  const browserChromeLoadingRef = useRef(browserChromeLoading);
  const resolvedPreviewUrlRef = useRef(resolvedPreviewUrl);

  const ensurePreviewSessionTabId = useCallback(() => {
    const tabId = surface.previewSessionId ?? surface.id;
    if (surface.previewSessionId !== tabId) {
      setCodeAgentRightPanelPreviewSessionId(roomId, surface.id, tabId);
    }
    return tabId;
  }, [roomId, surface.id, surface.previewSessionId]);

  useEffect(() => {
    setNavigationError(null);
    setBrowserLoadFailure(null);
    setBrowserReloadNonce(0);
  }, [currentAddress, surface.id]);

  useEffect(() => () => {
    if (screenshotCopiedTimerRef.current !== null) {
      clearTimeout(screenshotCopiedTimerRef.current);
      screenshotCopiedTimerRef.current = null;
    }
    if (recordingCopiedTimerRef.current !== null) {
      clearTimeout(recordingCopiedTimerRef.current);
      recordingCopiedTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    browserChromeLoadingRef.current = browserChromeLoading;
  }, [browserChromeLoading]);

  useEffect(() => {
    resolvedPreviewUrlRef.current = resolvedPreviewUrl;
  }, [resolvedPreviewUrl]);

  useEffect(() => subscribeCodeWorkspacePreviewEvents(roomId, (event) => {
    if (!event.snapshot || event.snapshot.tabId !== previewSessionTabId) {
      return;
    }
    const snapshotUrl = event.snapshot.navStatus._tag === 'Idle'
      ? null
      : event.snapshot.navStatus.url;
    if (resolvedPreviewUrl && snapshotUrl && snapshotUrl !== resolvedPreviewUrl) {
      return;
    }
    const failure = browserLoadFailureFromNavStatus(event.snapshot.navStatus);
    if (failure) {
      setBrowserLoadFailure(failure);
      return;
    }
    if (event.snapshot.navStatus._tag === 'Loading' || event.snapshot.navStatus._tag === 'Success') {
      setBrowserLoadFailure(null);
    }
  }), [previewSessionTabId, resolvedPreviewUrl, roomId]);

  useEffect(() => {
    if (!isBrowserEmptyPreview) {
      return undefined;
    }
    let disposed = false;
    setWorkspacePreviewServersPending(true);
    setWorkspacePreviewServersError(null);
    void listCodeWorkspacePreviewServers(roomId)
      .then((servers) => {
        if (disposed) return;
        setWorkspacePreviewServers(servers);
      })
      .catch((error) => {
        if (disposed) return;
        setWorkspacePreviewServers([]);
        setWorkspacePreviewServersError(error instanceof Error ? error.message : 'Workspace preview server scan failed');
      })
      .finally(() => {
        if (disposed) return;
        setWorkspacePreviewServersPending(false);
      });
    return () => {
      disposed = true;
    };
  }, [isBrowserEmptyPreview, roomId, surface.id, workspacePreviewServersRefreshNonce]);

  const recentPreviewUrls = useMemo(() => recentTargets.flatMap((target) => (
    target.kind === 'url' ? [target.url] : []
  )), [recentTargets]);
  const workspacePreviewServerItems = useMemo(() => mergeCodeWorkspacePreviewServers({
    scanner: workspacePreviewServers,
    recentlySeenUrls: recentPreviewUrls,
  }), [recentPreviewUrls, workspacePreviewServers]);
  const browserRecentTargets = useMemo(() => recentTargets.filter((target) => (
    target.kind !== 'url' || !previewPortTargetFromLocalUrl(target.url)
  )), [recentTargets]);

  useEffect(() => {
    if (!resolvedPreviewUrl) {
      return undefined;
    }
    let disposed = false;
    void openCodeWorkspacePreviewSession({
      roomId,
      tabId: previewSessionTabId,
      url: resolvedPreviewUrl,
      title: previewUrl ?? relativePath ?? t('codeAgentBrowserSurface'),
      viewport: viewportRef.current,
    }).then((session) => {
      if (disposed) return;
      setCodeAgentRightPanelPreviewViewport(roomId, session.tabId, session.viewport);
    }).catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [previewSessionTabId, relativePath, resolvedPreviewUrl, roomId, surface.id, previewUrl, t]);

  const navigateResolvedBrowserUrl = useCallback((url: string, title?: string) => {
    const tabId = ensurePreviewSessionTabId();
    void navigateCodeWorkspacePreviewSession({
      roomId,
      tabId,
      url,
      ...(title ? { title } : {}),
    }).catch(() => undefined);
    onNavigate(surface.id, { kind: 'url', url });
  }, [ensurePreviewSessionTabId, onNavigate, roomId, surface.id]);

  const navigatePreviewUrl = useCallback((url: string) => {
    const portTarget = previewPortTargetFromLocalUrl(url);
    if (!portTarget) {
      navigateResolvedBrowserUrl(url);
      return;
    }
    void resolveCodeWorkspacePreviewTarget({ roomId, target: portTarget })
      .then((resolution) => {
        setNavigationError(null);
        navigateResolvedBrowserUrl(resolution.resolvedUrl, resolution.requestedUrl);
      })
      .catch((error) => {
        setNavigationError(error instanceof Error ? error.message : t('codeAgentBrowserInvalidTarget'));
      });
  }, [navigateResolvedBrowserUrl, roomId, t]);

  const handleNavigate = useCallback((value: string) => {
    const target = resolveBrowserNavigationTarget(value, workspaceRoot);
    if (!target) {
      setNavigationError(t('codeAgentBrowserInvalidTarget'));
      return;
    }
    setNavigationError(null);
    if (target.kind === 'url') {
      navigatePreviewUrl(target.url);
      return;
    }
    onNavigate(surface.id, target);
  }, [navigatePreviewUrl, onNavigate, surface.id, t, workspaceRoot]);

  const handleOpenWorkspacePreviewServer = useCallback((server: PreviewableCodeWorkspacePreviewServer) => {
    const target = previewPortTargetFromLocalUrl(server.url) ?? {
      kind: 'environment-port' as const,
      port: server.port,
      protocol: 'http' as const,
      path: '/',
    };
    setNavigationError(null);
    void resolveCodeWorkspacePreviewTarget({ roomId, target })
      .then((resolution) => {
        navigateResolvedBrowserUrl(resolution.resolvedUrl, resolution.requestedUrl);
      })
      .catch((error) => {
        setNavigationError(error instanceof Error ? error.message : t('codeAgentWorkspacePreviewServersUnavailable'));
      });
  }, [navigateResolvedBrowserUrl, roomId, t]);

  const handleRefresh = useCallback(() => {
    setBrowserLoadFailure(null);
    if (isBrowserEmptyPreview) {
      setWorkspacePreviewServersRefreshNonce((current) => current + 1);
      return;
    }
    void refreshCodeWorkspacePreviewSession({ roomId, tabId: previewSessionTabId }).catch(() => undefined);
    if (relativePath) {
      onRefreshWorkspacePreview(relativePath);
    }
    setBrowserReloadNonce((current) => current + 1);
  }, [isBrowserEmptyPreview, onRefreshWorkspacePreview, previewSessionTabId, relativePath, roomId]);

  const handleBack = useCallback(() => {
    ensurePreviewSessionTabId();
    onNavigateHistory(surface.id, 'back');
  }, [ensurePreviewSessionTabId, onNavigateHistory, surface.id]);

  const handleForward = useCallback(() => {
    ensurePreviewSessionTabId();
    onNavigateHistory(surface.id, 'forward');
  }, [ensurePreviewSessionTabId, onNavigateHistory, surface.id]);

  const handleOpenExternal = useCallback(() => {
    if (!resolvedPreviewUrl) {
      return;
    }
    window.open(resolvedPreviewUrl, '_blank', 'noopener,noreferrer');
  }, [resolvedPreviewUrl]);

  const handleCaptureScreenshot = useCallback(() => {
    if (!resolvedPreviewUrl || screenshotCaptureState === 'pending') {
      return;
    }
    setScreenshotCaptureState('pending');
    setNavigationError(null);
    void runCodeWorkspacePreviewAutomationRequest({
      requestId: `capture-screenshot:${Date.now().toString(36)}`,
      roomId,
      tabId: previewSessionTabId,
      operation: 'snapshot',
      input: {},
      timeoutMs: 5000,
    }).then(async (result) => {
      if (!isPreviewAutomationSnapshot(result) || result.screenshot.unavailable) {
        throw new Error(t('codeAgentBrowserScreenshotUnavailable'));
      }
      const filename = previewScreenshotFilename(previewUrl ?? relativePath ?? resolvedPreviewUrl);
      downloadPreviewScreenshot(result.screenshot, filename);
      let copied = false;
      try {
        copied = await copyPreviewScreenshotToClipboard(result.screenshot);
      } catch {
        copied = false;
      }
      if (copied) {
        setScreenshotCaptureState('copied');
        if (screenshotCopiedTimerRef.current !== null) {
          clearTimeout(screenshotCopiedTimerRef.current);
        }
        screenshotCopiedTimerRef.current = setTimeout(() => {
          screenshotCopiedTimerRef.current = null;
          setScreenshotCaptureState('idle');
        }, 1200);
        return;
      }
      setScreenshotCaptureState('idle');
    }).catch((error) => {
      setScreenshotCaptureState('idle');
      setNavigationError(error instanceof Error ? error.message : t('codeAgentBrowserScreenshotFailed'));
    });
  }, [previewSessionTabId, previewUrl, relativePath, resolvedPreviewUrl, roomId, screenshotCaptureState, t]);

  const resolveRecordingAssetUrl = useCallback(async (path: string) => {
    const asset = await createCodeWorkspaceAssetUrl(roomId, path);
    return resolveCodeWorkspaceAssetUrl(asset);
  }, [roomId]);

  const handleToggleRecording = useCallback(() => {
    if (!resolvedPreviewUrl || browserRecordingAction !== 'idle') {
      return;
    }
    setNavigationError(null);
    if (!browserRecordingActive) {
      setBrowserRecordingAction('starting');
      setBrowserRecordingArtifact(null);
      setBrowserRecordingAssetUrl(null);
      setBrowserRecordingPathCopied(false);
      void runCodeWorkspacePreviewAutomationRequest({
        requestId: `recording-start:${Date.now().toString(36)}`,
        roomId,
        tabId: previewSessionTabId,
        operation: 'recordingStart',
        input: {},
        timeoutMs: 10000,
      }).then((result) => {
        if (!isPreviewRecordingStart(result)) {
          throw new Error(t('codeAgentBrowserRecordingStartFailed'));
        }
        setBrowserRecordingActive(true);
      }).catch((error) => {
        setBrowserRecordingActive(false);
        setNavigationError(error instanceof Error ? error.message : t('codeAgentBrowserRecordingStartFailed'));
      }).finally(() => {
        setBrowserRecordingAction('idle');
      });
      return;
    }

    setBrowserRecordingAction('stopping');
    void runCodeWorkspacePreviewAutomationRequest({
      requestId: `recording-stop:${Date.now().toString(36)}`,
      roomId,
      tabId: previewSessionTabId,
      operation: 'recordingStop',
      input: {},
      timeoutMs: 60000,
    }).then(async (result) => {
      if (!isPreviewRecordingArtifact(result)) {
        throw new Error(t('codeAgentBrowserRecordingStopFailed'));
      }
      setBrowserRecordingActive(false);
      setBrowserRecordingArtifact(result);
      onRecordingArtifactSaved(result);
      try {
        setBrowserRecordingAssetUrl(await resolveRecordingAssetUrl(result.path));
      } catch {
        setBrowserRecordingAssetUrl(null);
      }
    }).catch((error) => {
      setBrowserRecordingActive(false);
      setNavigationError(error instanceof Error ? error.message : t('codeAgentBrowserRecordingStopFailed'));
    }).finally(() => {
      setBrowserRecordingAction('idle');
    });
  }, [
    browserRecordingAction,
    browserRecordingActive,
    onRecordingArtifactSaved,
    previewSessionTabId,
    resolvedPreviewUrl,
    resolveRecordingAssetUrl,
    roomId,
    t,
  ]);

  const handleCopyRecordingPath = useCallback(() => {
    if (!browserRecordingArtifact) {
      return;
    }
    void copyTextToClipboard(browserRecordingArtifact.path).then((copied) => {
      if (!copied) {
        setNavigationError(t('codeAgentBrowserRecordingCopyPathFailed'));
        return;
      }
      setBrowserRecordingPathCopied(true);
      if (recordingCopiedTimerRef.current !== null) {
        clearTimeout(recordingCopiedTimerRef.current);
      }
      recordingCopiedTimerRef.current = setTimeout(() => {
        recordingCopiedTimerRef.current = null;
        setBrowserRecordingPathCopied(false);
      }, 1200);
    }).catch((error) => {
      setNavigationError(error instanceof Error ? error.message : t('codeAgentBrowserRecordingCopyPathFailed'));
    });
  }, [browserRecordingArtifact, t]);

  const handleOpenRecordingFile = useCallback(() => {
    if (!browserRecordingArtifact) {
      return;
    }
    onOpenWorkspaceFile(browserRecordingArtifact.path);
  }, [browserRecordingArtifact, onOpenWorkspaceFile]);

  const handleDownloadRecording = useCallback(() => {
    if (!browserRecordingArtifact || !browserRecordingAssetUrl) {
      setNavigationError(t('codeAgentBrowserRecordingDownloadUnavailable'));
      return;
    }
    downloadWorkspaceAssetUrl(browserRecordingAssetUrl, browserRecordingArtifact.path);
  }, [browserRecordingArtifact, browserRecordingAssetUrl, t]);

  const clearBrowserData = useCallback((operation: 'clearCookies' | 'clearCache') => {
    if (!resolvedPreviewUrl || browserDataAction !== null) {
      return;
    }
    setBrowserDataAction(operation);
    setNavigationError(null);
    void runCodeWorkspacePreviewAutomationRequest({
      requestId: `${operation}:${Date.now().toString(36)}`,
      roomId,
      tabId: previewSessionTabId,
      operation,
      input: {},
      timeoutMs: 10000,
    }).then(() => {
      void refreshCodeWorkspacePreviewSession({ roomId, tabId: previewSessionTabId }).catch(() => undefined);
      setBrowserReloadNonce((current) => current + 1);
    }).catch((error) => {
      const fallback = operation === 'clearCookies'
        ? t('codeAgentBrowserClearCookiesFailed')
        : t('codeAgentBrowserClearCacheFailed');
      setNavigationError(error instanceof Error ? error.message : fallback);
    }).finally(() => {
      setBrowserDataAction(null);
    });
  }, [browserDataAction, previewSessionTabId, resolvedPreviewUrl, roomId, t]);

  const handleClearCookies = useCallback(() => {
    clearBrowserData('clearCookies');
  }, [clearBrowserData]);

  const handleClearCache = useCallback(() => {
    clearBrowserData('clearCache');
  }, [clearBrowserData]);

  const handleToggleAnnotation = useCallback(() => {
    if (!resolvedPreviewUrl || previewAnnotationPending) {
      return;
    }
    setNavigationError(null);
    setPreviewAnnotationDraft(null);
    setPreviewAnnotationComment('');
    setPreviewAnnotationActive((active) => !active);
  }, [previewAnnotationPending, resolvedPreviewUrl]);

  useEffect(() => {
    if (!previewAnnotationActive) {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPreviewAnnotationDraft(null);
        setPreviewAnnotationComment('');
        setPreviewAnnotationActive(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [previewAnnotationActive]);

  useEffect(() => {
    if (!previewAnnotationDraft) {
      return undefined;
    }
    const frameId = window.requestAnimationFrame(() => {
      previewAnnotationCommentRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [previewAnnotationDraft]);

  const handlePreviewAnnotationPick = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!resolvedPreviewUrl || previewAnnotationPending || previewAnnotationDraft || !onAddPreviewAnnotation) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setPreviewAnnotationPending(true);
    setNavigationError(null);
    void runCodeWorkspacePreviewAutomationRequest({
      requestId: `preview-annotation:${Date.now().toString(36)}`,
      roomId,
      tabId: previewSessionTabId,
      operation: 'previewAnnotation',
      input: {
        clientX: event.clientX,
        clientY: event.clientY,
      },
      timeoutMs: 10000,
    }).then((result) => {
      if (!isCodeAgentPreviewAnnotationContext(result)) {
        throw new Error(t('codeAgentBrowserPreviewAnnotationFailed'));
      }
      setPreviewAnnotationDraft(result);
      setPreviewAnnotationComment(result.comment);
    }).catch((error) => {
      setNavigationError(error instanceof Error ? error.message : t('codeAgentBrowserPreviewAnnotationFailed'));
    }).finally(() => {
      setPreviewAnnotationPending(false);
    });
  }, [
    onAddPreviewAnnotation,
    previewAnnotationDraft,
    previewAnnotationPending,
    previewSessionTabId,
    resolvedPreviewUrl,
    roomId,
    t,
  ]);

  const handleCancelPreviewAnnotation = useCallback(() => {
    setPreviewAnnotationDraft(null);
    setPreviewAnnotationComment('');
    setPreviewAnnotationActive(false);
  }, []);

  const handleAttachPreviewAnnotation = useCallback(() => {
    if (!previewAnnotationDraft || !onAddPreviewAnnotation) {
      return;
    }
    onAddPreviewAnnotation({
      ...previewAnnotationDraft,
      comment: previewAnnotationComment.trim(),
    });
    setPreviewAnnotationDraft(null);
    setPreviewAnnotationComment('');
    setPreviewAnnotationActive(false);
  }, [onAddPreviewAnnotation, previewAnnotationComment, previewAnnotationDraft]);

  const handlePreviewAnnotationCommentKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) {
      return;
    }
    event.preventDefault();
    handleAttachPreviewAnnotation();
  }, [handleAttachPreviewAnnotation]);

  const updateViewport = useCallback(async (nextViewport: CodeAgentPreviewViewportSetting) => {
    const session = await resizeCodeWorkspacePreviewSession({
      roomId,
      tabId: previewSessionTabId,
      viewport: nextViewport,
    });
    setCodeAgentRightPanelPreviewViewport(roomId, session.tabId, session.viewport);
    return session;
  }, [previewSessionTabId, roomId]);

  const handleRenderedViewportChange = useCallback((size: CodeAgentPreviewViewportSize) => {
    onRenderedViewportChange(previewSessionTabId, viewport, size);
  }, [onRenderedViewportChange, previewSessionTabId, viewport]);

  const previewAutomationStatus = useCallback((override?: {
    url?: string | null;
    loading?: boolean;
    viewport?: CodeAgentPreviewViewportSetting;
  }) => {
    const statusUrl = override?.url ?? resolvedPreviewUrl ?? previewUrl ?? null;
    return {
      available: true,
      visible: true,
      tabId: previewSessionTabId,
      url: statusUrl,
      title: previewUrl ?? relativePath ?? '',
      loading: override?.loading ?? browserChromeLoading,
      viewportSetting: override?.viewport ?? viewportRef.current,
      viewport: {
        width: Math.max(1, Math.round(previewViewportContainerSize.width)),
        height: Math.max(1, Math.round(previewViewportContainerSize.height)),
      },
    };
  }, [
    browserChromeLoading,
    previewSessionTabId,
    previewUrl,
    previewViewportContainerSize.height,
    previewViewportContainerSize.width,
    relativePath,
    resolvedPreviewUrl,
  ]);

  const removePreviewNavigationWaiter = useCallback((id: number) => {
    const waiters = previewNavigationWaitersRef.current;
    const index = waiters.findIndex((waiter) => waiter.id === id);
    if (index >= 0) {
      waiters.splice(index, 1);
    }
  }, []);

  const createPreviewAutomationNavigationWait = useCallback((
    url: string,
    readiness: CodeWorkspacePreviewAutomationReadiness,
    timeoutMs: number,
    requestId: string,
  ): Promise<void> => {
    if (readiness === 'none') {
      return Promise.resolve();
    }
    if (resolvedPreviewUrlRef.current === url && !browserChromeLoadingRef.current) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const id = previewNavigationWaiterIdRef.current + 1;
      previewNavigationWaiterIdRef.current = id;
      const timeoutId = window.setTimeout(() => {
        removePreviewNavigationWaiter(id);
        reject(new Error(
          `Preview navigation for request ${requestId} did not reach ${readiness} readiness within ${timeoutMs}ms.`,
        ));
      }, timeoutMs);
      previewNavigationWaitersRef.current.push({
        id,
        requestId,
        url,
        readiness,
        timeoutId,
        resolve,
        reject,
      });
    });
  }, [removePreviewNavigationWaiter]);

  const settlePreviewAutomationNavigationWaiters = useCallback((url: string | null, error?: Error) => {
    if (!url) {
      return;
    }
    const waiters = previewNavigationWaitersRef.current;
    if (waiters.length === 0) {
      return;
    }
    const matching = waiters.filter((waiter) => waiter.url === url);
    if (matching.length === 0) {
      return;
    }
    previewNavigationWaitersRef.current = waiters.filter((waiter) => waiter.url !== url);
    for (const waiter of matching) {
      window.clearTimeout(waiter.timeoutId);
      if (error) {
        waiter.reject(error);
      } else {
        waiter.resolve();
      }
    }
  }, []);

  useEffect(() => () => {
    const waiters = previewNavigationWaitersRef.current;
    previewNavigationWaitersRef.current = [];
    for (const waiter of waiters) {
      window.clearTimeout(waiter.timeoutId);
      waiter.reject(new Error('Workspace preview automation closed before navigation reached readiness.'));
    }
  }, []);

  useEffect(() => {
    previewAutomationHandlerRef.current = async (request: CodeWorkspacePreviewAutomationRequest) => {
      if (request.operation === 'status') {
        return previewAutomationStatus();
      }
      if (request.operation === 'open' || request.operation === 'navigate') {
        const url = await previewAutomationNavigationUrl(roomId, request.input);
        const readiness = codeWorkspacePreviewAutomationReadiness(request.input);
        const timeoutMs = codeWorkspacePreviewAutomationTimeoutMs(request.input, request.timeoutMs);
        if (!url) {
          if (request.operation === 'open') {
            const status = previewAutomationStatus();
            const currentNavStatus = status.url
              ? {
                _tag: status.loading ? 'Loading' as const : 'Success' as const,
                url: status.url,
                title: status.title,
              }
              : { _tag: 'Idle' as const };
            if (
              status.url
              && status.loading
              && readiness !== 'none'
              && codeWorkspacePreviewAutomationOpenNeedsReadiness(request.input, currentNavStatus)
            ) {
              await createPreviewAutomationNavigationWait(status.url, readiness, timeoutMs, request.requestId);
              return previewAutomationStatus({ url: status.url, loading: false });
            }
            return status;
          }
          throw new Error('Workspace preview automation requires a direct URL or environment-port target in this cloud surface.');
        }
        const readinessWait = createPreviewAutomationNavigationWait(
          url,
          readiness,
          timeoutMs,
          request.requestId,
        );
        handleNavigate(url);
        if (readiness !== 'none') {
          await readinessWait;
          return previewAutomationStatus({ url, loading: false });
        }
        return previewAutomationStatus({ url, loading: true });
      }
      if (request.operation === 'resize') {
        const nextViewport = previewAutomationViewportSetting(request.input);
        const timeoutMs = codeWorkspacePreviewAutomationTimeoutMs(request.input, request.timeoutMs);
        const session = await updateViewport(nextViewport);
        const renderedViewport = await waitForRenderedViewport(
          session.tabId,
          session.viewport,
          timeoutMs,
          request.requestId,
        ) as CodeAgentPreviewViewportSize;
        return {
          tabId: session.tabId,
          setting: session.viewport,
          viewport: renderedViewport,
        };
      }
      if (isCodeWorkspacePreviewDomAutomationOperation(request.operation)) {
        const handler = previewDomAutomationHandlerRef.current;
        if (!handler) {
          throw new Error('Workspace preview automation frame is not ready.');
        }
        return handler(request);
      }
      throw new Error(`Workspace preview automation does not support ${request.operation} in the cloud browser surface yet.`);
    };
  }, [
    createPreviewAutomationNavigationWait,
    handleNavigate,
    previewAutomationStatus,
    previewSessionTabId,
    previewViewportContainerSize.height,
    previewViewportContainerSize.width,
    roomId,
    updateViewport,
    waitForRenderedViewport,
  ]);

  useEffect(() => {
    let disposed = false;
    let controller: CodeAgentPreviewAutomationController | null = null;
    void connectCodeWorkspacePreviewAutomationHost({
      roomId,
      tabId: previewSessionTabId,
      supportedOperations: CODE_WORKSPACE_PREVIEW_AUTOMATION_CLOUD_BROWSER_OPERATIONS,
      handle: (request) => previewAutomationHandlerRef.current(request),
    }).then((nextController) => {
      if (disposed) {
        nextController.dispose();
        return;
      }
      controller = nextController;
    }).catch(() => undefined);

    const reportFocus = () => {
      void Promise.resolve(
        controller?.setFocused(typeof document === 'undefined' ? true : document.hasFocus()),
      ).catch(() => undefined);
    };
    window.addEventListener('focus', reportFocus);
    window.addEventListener('blur', reportFocus);
    return () => {
      disposed = true;
      window.removeEventListener('focus', reportFocus);
      window.removeEventListener('blur', reportFocus);
      controller?.dispose();
    };
  }, [previewSessionTabId, roomId, surface.id]);

  const handleToggleDeviceToolbar = useCallback(() => {
    if (!resolvedPreviewUrl) {
      return;
    }
    if (viewport._tag !== 'fill') {
      void updateViewport(FILL_CODE_AGENT_PREVIEW_VIEWPORT).catch(() => undefined);
      return;
    }
    const responsiveSize = resolveResponsiveCodeAgentBrowserViewportSize(
      previewViewportContainerSize,
      zoomFactor,
    );
    void updateViewport({ _tag: 'freeform', ...responsiveSize }).catch(() => undefined);
  }, [previewViewportContainerSize, resolvedPreviewUrl, updateViewport, viewport._tag, zoomFactor]);

  const handlePreviewStatusChange = useCallback((status: WorkspaceBrowserPreviewStatus) => {
    if (!resolvedPreviewUrl) {
      return;
    }
    const title = previewUrl ?? relativePath ?? '';
    const navStatus: CodeWorkspacePreviewNavStatus = status._tag === 'Success'
      ? { _tag: 'Success', url: resolvedPreviewUrl, title }
      : {
        _tag: 'LoadFailed',
        url: resolvedPreviewUrl,
        title,
        code: status.code,
        description: status.description,
      };
    if (navStatus._tag === 'LoadFailed') {
      const failure = browserLoadFailureFromNavStatus(navStatus);
      setBrowserLoadFailure(failure);
      settlePreviewAutomationNavigationWaiters(
        resolvedPreviewUrl,
        new Error(`${t('codeAgentBrowserPreviewFailed')}: ${navStatus.description}`),
      );
    } else {
      setBrowserLoadFailure(null);
      settlePreviewAutomationNavigationWaiters(resolvedPreviewUrl);
    }
    void reportCodeWorkspacePreviewSession({
      roomId,
      tabId: previewSessionTabId,
      navStatus,
      ...(status._tag === 'Success' && status.renderedViewport
        ? { renderedViewport: status.renderedViewport }
        : {}),
    }).catch(() => undefined);
  }, [previewSessionTabId, relativePath, resolvedPreviewUrl, roomId, previewUrl, settlePreviewAutomationNavigationWaiters, t]);

  const handlePreviewDomAutomationHandlerChange = useCallback((
    handler: CodeWorkspacePreviewDomAutomationHandler | null,
  ) => {
    previewDomAutomationHandlerRef.current = handler;
  }, []);

  const updateZoomFactor = useCallback((nextZoomFactor: number) => {
    setCodeAgentRightPanelPreviewZoomFactor(
      roomId,
      surface.id,
      nextZoomFactor,
    );
  }, [roomId, surface.id]);

  const handleZoomIn = useCallback(() => {
    updateZoomFactor(clampBrowserPreviewZoomFactor(zoomFactor + BROWSER_PREVIEW_ZOOM_STEP));
  }, [updateZoomFactor, zoomFactor]);

  const handleZoomOut = useCallback(() => {
    updateZoomFactor(clampBrowserPreviewZoomFactor(zoomFactor - BROWSER_PREVIEW_ZOOM_STEP));
  }, [updateZoomFactor, zoomFactor]);

  const handleResetZoom = useCallback(() => {
    updateZoomFactor(1);
  }, [updateZoomFactor]);

  const activeBrowserLoadFailure = browserLoadFailure && resolvedPreviewUrl && browserLoadFailure.url === resolvedPreviewUrl
    ? browserLoadFailure
    : null;
  const browserFrameAvailable = Boolean(resolvedPreviewUrl && !activeBrowserLoadFailure);

  const recordingArtifactBanner = browserRecordingArtifact ? (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#dedbd0] bg-[#f8f5ee] px-3 py-2 text-xs text-[#4d4c48] dark:border-[#30302e] dark:bg-[#242422] dark:text-[#e8e6dc]"
      data-testid="code-agent-browser-recording-saved"
    >
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-[#141413] dark:text-[#faf9f5]">
          {t('codeAgentBrowserRecordingSaved')}
        </span>
        <span className="ml-2 font-mono text-[11px] text-[#87867f] dark:text-[#b0aea5]">
          {browserRecordingArtifact.path}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-md border border-[#dedbd0] px-2 text-[#141413] transition-colors hover:bg-[#f0eee6] dark:border-[#30302e] dark:text-[#faf9f5] dark:hover:bg-[#30302e]"
          onClick={handleCopyRecordingPath}
        >
          {browserRecordingPathCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {browserRecordingPathCopied ? t('copied') : t('codeAgentCopyFilePath')}
        </button>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-md border border-[#dedbd0] px-2 text-[#141413] transition-colors hover:bg-[#f0eee6] dark:border-[#30302e] dark:text-[#faf9f5] dark:hover:bg-[#30302e]"
          onClick={handleOpenRecordingFile}
        >
          <Files className="h-3.5 w-3.5" />
          {t('codeAgentBrowserOpenRecording')}
        </button>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-md border border-[#dedbd0] px-2 text-[#141413] transition-colors hover:bg-[#f0eee6] disabled:cursor-not-allowed disabled:opacity-45 dark:border-[#30302e] dark:text-[#faf9f5] dark:hover:bg-[#30302e]"
          disabled={!browserRecordingAssetUrl}
          onClick={handleDownloadRecording}
        >
          <Download className="h-3.5 w-3.5" />
          {t('codeAgentDownloadFile')}
        </button>
      </span>
    </div>
  ) : null;

  const chrome = (
    <CodeAgentBrowserSurfaceChrome
      value={currentAddress}
      loading={browserChromeLoading}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      canRefresh={canRefreshPreview}
      canOpenExternal={Boolean(resolvedPreviewUrl)}
      canCaptureScreenshot={browserFrameAvailable}
      canRecordPreview={browserFrameAvailable}
      canAnnotatePreview={Boolean(browserFrameAvailable && onAddPreviewAnnotation)}
      screenshotCapturePending={screenshotCaptureState === 'pending'}
      screenshotCaptureCopied={screenshotCaptureState === 'copied'}
      recordingActive={browserRecordingActive}
      recordingPending={browserRecordingAction !== 'idle'}
      annotationActive={previewAnnotationActive}
      annotationPending={previewAnnotationPending}
      canZoom={browserFrameAvailable}
      canToggleDeviceToolbar={browserFrameAvailable}
      canClearBrowserData={browserFrameAvailable}
      clearCookiesPending={browserDataAction === 'clearCookies'}
      clearCachePending={browserDataAction === 'clearCache'}
      zoomFactor={zoomFactor}
      deviceToolbarVisible={viewport._tag !== 'fill'}
      mobileLayout={mobileLayout}
      focusUrlNonce={focusUrlNonce}
      navigationError={navigationError}
      onBack={handleBack}
      onForward={handleForward}
      onSubmit={handleNavigate}
      onRefresh={handleRefresh}
      onOpenExternal={handleOpenExternal}
      onCaptureScreenshot={handleCaptureScreenshot}
      onToggleRecording={handleToggleRecording}
      onToggleAnnotation={handleToggleAnnotation}
      onHardReload={handleRefresh}
      onToggleDeviceToolbar={handleToggleDeviceToolbar}
      onZoomIn={handleZoomIn}
      onZoomOut={handleZoomOut}
      onResetZoom={handleResetZoom}
      onClearCookies={handleClearCookies}
      onClearCache={handleClearCache}
    />
  );

  if (isBrowserEmptyPreview) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-[#faf9f5] dark:bg-[#1d1d1b]">
        {chrome}
        {recordingArtifactBanner}
        <div
          className="flex min-h-0 flex-1 overflow-auto px-5 py-8"
          data-testid="code-agent-browser-surface-empty"
        >
          <div className="m-auto flex w-full max-w-xl flex-col items-center gap-3 text-center">
            {workspacePreviewServerItems.length > 0 ? (
              <div className="w-full text-left" data-testid="code-agent-browser-preview-servers">
                <div className="mb-2 flex items-center gap-2 px-1 text-xs font-medium text-[#5e5d59] dark:text-[#b0aea5]">
                  <RadioTower className="h-3.5 w-3.5 shrink-0" />
                  <span>{t('codeAgentWorkspacePreviewServers')}</span>
                </div>
                <div className="flex flex-col divide-y divide-[#dedbd0] overflow-hidden rounded-md border border-[#dedbd0] bg-[#faf9f5] dark:divide-[#30302e] dark:border-[#30302e] dark:bg-[#1d1d1b]">
                  {workspacePreviewServerItems.map((server) => {
                    const label = server.processName
                      || (server.listening
                        ? t('codeAgentWorkspacePreviewServerListening')
                        : server.source === 'configured'
                          ? t('codeAgentWorkspacePreviewServerConfigured')
                          : t('codeAgentWorkspacePreviewServerRecent'));
                    const subtitle = `${server.host}:${server.port}`;
                    return (
                      <button
                        key={`${server.host}:${server.port}`}
                        type="button"
                        className="flex min-w-0 items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-[#f0eee6] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:hover:bg-[#242422]"
                        data-testid={`code-agent-browser-preview-server-${server.port}`}
                        title={server.url}
                        onClick={() => handleOpenWorkspacePreviewServer(server)}
                      >
                        <TerminalSquare className="h-4 w-4 shrink-0 text-[#87867f] dark:text-[#8f8d86]" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium text-[#141413] dark:text-[#faf9f5]">
                            {label}
                          </span>
                          <span className="block truncate text-[11px] text-[#87867f] dark:text-[#8f8d86]">
                            {subtitle}
                          </span>
                        </span>
                        {server.listening ? (
                          <span
                            aria-label={t('codeAgentWorkspacePreviewServerListening')}
                            className="relative inline-flex h-2 w-2 shrink-0"
                          >
                            <span className="absolute inset-0 animate-ping rounded-full bg-[#1f9d68] opacity-60" />
                            <span className="relative inline-flex h-2 w-2 rounded-full bg-[#1f9d68]" />
                          </span>
                        ) : (
                          <span
                            aria-label={t('codeAgentWorkspacePreviewServerNotListening')}
                            className="h-2 w-2 shrink-0 rounded-full bg-[#b8b4aa] dark:bg-[#5e5d59]"
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 px-1 text-xs leading-relaxed text-[#87867f] dark:text-[#8f8d86]">
                  {t('codeAgentWorkspacePreviewServersHint')}
                </p>
              </div>
            ) : (
              <>
                <Globe2 className="h-5 w-5 text-[#87867f] dark:text-[#8f8d86]" />
                <div className="text-sm font-medium text-[#141413] dark:text-[#faf9f5]">
                  {t('codeAgentNoPreviewLoaded')}
                </div>
                <div className="max-w-sm text-xs leading-relaxed text-[#87867f] dark:text-[#8f8d86]">
                  {t('codeAgentBrowserSurfaceDescription')}
                </div>
              </>
            )}
            {workspacePreviewServersPending ? (
              <div className="flex items-center gap-2 text-xs text-[#87867f] dark:text-[#8f8d86]">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                <span>{t('codeAgentWorkspacePreviewServersScanning')}</span>
              </div>
            ) : null}
            {workspacePreviewServersError ? (
              <div className="max-w-md rounded-md border border-[#f0b49b]/60 bg-[#fff2ec] px-3 py-2 text-xs leading-relaxed text-[#9f462c] dark:border-[#7a321f]/60 dark:bg-[#2a211d] dark:text-[#ff9b78]">
                {t('codeAgentWorkspacePreviewServersUnavailable')}
              </div>
            ) : null}
          {browserRecentTargets.length > 0 ? (
            <div
              className="mt-2 w-full max-w-md text-left"
              data-testid="code-agent-browser-recent-targets"
            >
              <div className="mb-2 px-1 text-xs font-medium text-[#5e5d59] dark:text-[#b0aea5]">
                {t('recentlyUsed')}
              </div>
              <div className="flex flex-col divide-y divide-[#dedbd0] overflow-hidden rounded-md border border-[#dedbd0] bg-[#faf9f5] dark:divide-[#30302e] dark:border-[#30302e] dark:bg-[#1d1d1b]">
                {browserRecentTargets.map((target) => {
                  const title = formatBrowserPreviewTargetTitle(target);
                  const subtitle = formatBrowserPreviewTargetSubtitle(target);
                  return (
                    <button
                      key={`${target.kind}:${subtitle}`}
                      type="button"
                      className="flex min-w-0 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[#f0eee6] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:hover:bg-[#242422]"
                      title={subtitle}
                      onClick={() => onNavigate(surface.id, target)}
                    >
                      <Globe2 className="h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-[#141413] dark:text-[#faf9f5]">
                          {title}
                        </span>
                        <span className="block truncate text-[11px] text-[#87867f] dark:text-[#8f8d86]">
                          {subtitle}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          </div>
        </div>
      </div>
    );
  }

  if (assetUrlQuery.error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-[#faf9f5] dark:bg-[#1d1d1b]">
        {chrome}
        {recordingArtifactBanner}
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-[#9f462c] dark:text-[#ff9b78]">
          {assetUrlQuery.error}
        </div>
      </div>
    );
  }

  if (relativePath && (assetUrlQuery.isPending || !assetUrlQuery.resolvedUrl)) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-[#faf9f5] dark:bg-[#1d1d1b]">
        {chrome}
        {recordingArtifactBanner}
        <div
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-[#87867f] dark:text-[#8f8d86]"
          role="status"
          aria-label={t('codeAgentPreparingBrowserPreview')}
        >
          <LoaderCircle className="h-5 w-5 animate-spin" />
          <div className="text-sm">{t('codeAgentPreparingBrowserPreview')}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#faf9f5] dark:bg-[#1d1d1b]">
      {chrome}
      {recordingArtifactBanner}
      {resolvedPreviewUrl ? (
        <div className="relative flex min-h-0 flex-1 flex-col">
          {activeBrowserLoadFailure ? (
            <CodeAgentBrowserUnreachable
              failure={activeBrowserLoadFailure}
              onReload={handleRefresh}
            />
          ) : (
            <WorkspaceBrowserAssetPreview
              key={`${resolvedPreviewUrl}:${browserReloadNonce}`}
              src={resolvedPreviewUrl}
              title={previewUrl ?? relativePath ?? t('codeAgentBrowserSurface')}
              zoomFactor={zoomFactor}
              viewport={viewport}
              automationTabId={previewSessionTabId}
              onViewportChange={updateViewport}
              onViewportContainerSizeChange={setPreviewViewportContainerSize}
              onRenderedViewportChange={handleRenderedViewportChange}
              onPreviewStatusChange={handlePreviewStatusChange}
              onLoadingChange={setBrowserFrameLoading}
              onAutomationHandlerChange={handlePreviewDomAutomationHandlerChange}
            />
          )}
          {previewAnnotationActive ? (
            <div
              className={`absolute inset-0 z-30 flex justify-center bg-[#141413]/10 p-3 text-center backdrop-blur-[1px] dark:bg-[#faf9f5]/10 ${
                previewAnnotationDraft
                  ? 'items-end sm:items-start'
                  : 'cursor-crosshair items-start'
              }`}
              data-testid="code-agent-preview-annotation-overlay"
              role={previewAnnotationDraft ? 'dialog' : 'button'}
              tabIndex={0}
              aria-label={previewAnnotationDraft
                ? t('codeAgentPreviewAnnotationEditorTitle')
                : t('codeAgentBrowserPreviewAnnotationOverlay')}
              onPointerDown={previewAnnotationDraft ? undefined : handlePreviewAnnotationPick}
            >
              {previewAnnotationDraft ? (
                <form
                  className={`pointer-events-auto border border-[#d8d0c3] bg-[#faf9f5]/95 p-3 text-left shadow-xl dark:border-[#454540] dark:bg-[#1d1d1b]/95 ${
                    mobileLayout
                      ? 'w-full max-w-none rounded-xl'
                      : 'w-[min(360px,calc(100vw-16px))] rounded-lg'
                  }`}
                  data-testid="code-agent-preview-annotation-editor"
                  onPointerDown={(event) => event.stopPropagation()}
                  onSubmit={(event) => {
                    event.preventDefault();
                    handleAttachPreviewAnnotation();
                  }}
                >
                  <div className="mb-2 min-w-0">
                    <div className="text-xs font-semibold text-[#141413] dark:text-[#faf9f5]">
                      {t('codeAgentPreviewAnnotationEditorTitle')}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-[#6f6a60] dark:text-[#a9a49a]">
                      {previewAnnotationDraft.pageTitle || previewAnnotationDraft.pageUrl}
                    </div>
                  </div>
                  <label className="block">
                    <span className="sr-only">{t('codeAgentPreviewAnnotationCommentLabel')}</span>
                    <textarea
                      ref={previewAnnotationCommentRef}
                      value={previewAnnotationComment}
                      onChange={(event) => setPreviewAnnotationComment(event.currentTarget.value)}
                      onKeyDown={handlePreviewAnnotationCommentKeyDown}
                      rows={3}
                      placeholder={t('codeAgentPreviewAnnotationCommentPlaceholder')}
                      className="min-h-[76px] w-full resize-none rounded-md border border-[#d8d0c3] bg-white/85 px-2.5 py-2 text-xs text-[#141413] outline-none transition focus:border-[#c96442] focus:ring-2 focus:ring-[#c96442]/20 dark:border-[#454540] dark:bg-[#10100f]/85 dark:text-[#faf9f5] dark:focus:border-[#d97757] dark:focus:ring-[#d97757]/20"
                    />
                  </label>
                  <div className="mt-3 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      className="rounded-md border border-[#d8d0c3] px-2.5 py-1.5 text-xs font-medium text-[#5f5a52] transition hover:bg-[#f1eee8] dark:border-[#454540] dark:text-[#c9c4ba] dark:hover:bg-[#2b2a27]"
                      onClick={handleCancelPreviewAnnotation}
                    >
                      {t('cancel')}
                    </button>
                    <button
                      type="submit"
                      className="rounded-md bg-[#c96442] px-2.5 py-1.5 text-xs font-semibold text-white transition hover:bg-[#b45738] dark:bg-[#d97757] dark:hover:bg-[#c9684c]"
                    >
                      {t('codeAgentAttachPreviewAnnotation')}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="pointer-events-none rounded-full border border-[#c96442]/70 bg-[#faf9f5]/95 px-3 py-1 text-[11px] font-medium text-[#141413] shadow-md dark:border-[#d97757]/70 dark:bg-[#1d1d1b]/95 dark:text-[#faf9f5]">
                  {previewAnnotationPending
                    ? t('codeAgentBrowserPreviewAnnotationCapturing')
                    : t('codeAgentBrowserPreviewAnnotationOverlay')}
                </div>
              )}
            </div>
          ) : null}
          <CodeAgentBrowserZoomIndicator zoomFactor={zoomFactor} />
        </div>
      ) : null}
    </div>
  );
}

function parentPath(path: string): string {
  const normalizedPath = normalizeWorkspacePath(path);
  const index = normalizedPath.lastIndexOf('/');
  return index > 0 ? normalizedPath.slice(0, index) : '';
}

function pathContains(parent: string, child: string): boolean {
  const normalizedParent = normalizeWorkspacePath(parent);
  const normalizedChild = normalizeWorkspacePath(child);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

function replacePathPrefix(path: string, previousPrefix: string, nextPrefix: string): string {
  const normalizedPath = normalizeWorkspacePath(path);
  const normalizedPreviousPrefix = normalizeWorkspacePath(previousPrefix);
  const normalizedNextPrefix = normalizeWorkspacePath(nextPrefix);
  if (normalizedPath === normalizedPreviousPrefix) {
    return normalizedNextPrefix;
  }
  if (normalizedPath.startsWith(`${normalizedPreviousPrefix}/`)) {
    return `${normalizedNextPrefix}${normalizedPath.slice(normalizedPreviousPrefix.length)}`;
  }
  return normalizedPath;
}

function joinWorkspacePath(directory: string, name: string): string {
  return [normalizeWorkspacePath(directory), normalizeWorkspacePath(name)].filter(Boolean).join('/');
}

function projectEntriesFromWorkspace(entries: readonly CodeWorkspaceEntry[]): CodeAgentProjectEntry[] {
  const byPath = new Map<string, CodeAgentProjectEntry>();

  for (const entry of entries) {
    const normalizedPath = normalizeWorkspacePath(entry.path);
    if (!normalizedPath) {
      continue;
    }

    const parts = normalizedPath.split('/').filter(Boolean);
    for (let index = 1; index < parts.length; index += 1) {
      const ancestor = parts.slice(0, index).join('/');
      if (!byPath.has(ancestor)) {
        byPath.set(ancestor, { path: ancestor, kind: 'directory' });
      }
    }

    byPath.set(normalizedPath, {
      path: normalizedPath,
      kind: entry.type === 'directory' ? 'directory' : 'file',
    });
  }

  return Array.from(byPath.values()).sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'directory' ? -1 : 1;
    }
    return left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function mergeWorkspaceEntries(
  primaryEntries: readonly CodeWorkspaceEntry[],
  secondaryEntries: readonly CodeWorkspaceEntry[],
): CodeWorkspaceEntry[] {
  const byPath = new Map<string, CodeWorkspaceEntry>();
  for (const entry of primaryEntries) {
    byPath.set(entry.path, entry);
  }
  for (const entry of secondaryEntries) {
    byPath.set(entry.path, entry);
  }
  return [...byPath.values()];
}

function workspaceEntryForPath(path: string, type: CodeWorkspaceEntry['type'] = 'file'): CodeWorkspaceEntry | null {
  const normalizedPath = normalizeWorkspacePath(path);
  if (!normalizedPath) {
    return null;
  }
  const parts = normalizedPath.split('/').filter(Boolean);
  return {
    path: normalizedPath,
    name: parts.at(-1) ?? normalizedPath,
    type,
  };
}

function readResolvedTheme() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function useResolvedTheme() {
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(readResolvedTheme);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return undefined;
    }
    const observer = new MutationObserver(() => setResolvedTheme(readResolvedTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return resolvedTheme;
}

function initialExplorerOpen(): boolean {
  try {
    const stored = window.localStorage.getItem(FILE_EXPLORER_STORAGE_KEY);
    return stored === null ? true : stored === 'true';
  } catch {
    return true;
  }
}

function initialExplorerWidth(): number {
  try {
    const stored = window.localStorage.getItem(FILE_EXPLORER_WIDTH_STORAGE_KEY);
    const parsed = Number.parseInt(stored || '', 10);
    return Number.isFinite(parsed)
      ? clampFileExplorerWidth(parsed, window.innerWidth)
      : FILE_EXPLORER_DEFAULT_WIDTH;
  } catch {
    return FILE_EXPLORER_DEFAULT_WIDTH;
  }
}

function initialDiffChangedFilesWidth(): number {
  try {
    const stored = window.localStorage.getItem(DIFF_CHANGED_FILES_WIDTH_STORAGE_KEY);
    const parsed = Number.parseInt(stored || '', 10);
    return Number.isFinite(parsed)
      ? clampDiffChangedFilesWidth(parsed, window.innerWidth)
      : DIFF_CHANGED_FILES_DEFAULT_WIDTH;
  } catch {
    return DIFF_CHANGED_FILES_DEFAULT_WIDTH;
  }
}

function readInitialFileWordWrap(): boolean {
  try {
    return window.localStorage.getItem(FILE_WORD_WRAP_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function useCodeWorkspaceEntriesQuery(roomId: string) {
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const [data, setData] = useState<{ entries: CodeWorkspaceEntry[]; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const refresh = useCallback(() => {
    abortRef.current?.abort();
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const controller = new AbortController();
    abortRef.current = controller;
    setIsPending(true);
    setError(null);

    loadCodeWorkspaceEntries(roomId, { signal: controller.signal }).then(
      (nextData) => {
        if (controller.signal.aborted || requestIdRef.current !== requestId) {
          return;
        }
        setData(nextData);
      },
      (nextError) => {
        if (controller.signal.aborted || requestIdRef.current !== requestId) {
          return;
        }
        setError(nextError instanceof Error ? nextError.message : 'Workspace query failed.');
      },
    ).finally(() => {
      if (requestIdRef.current === requestId) {
        setIsPending(false);
        abortRef.current = null;
      }
    });
  }, [roomId]);

  useEffect(() => {
    refresh();
    return () => {
      requestIdRef.current += 1;
      abortRef.current?.abort();
    };
  }, [refresh]);

  return { data, error, isPending, refresh };
}

function scopedFileCacheKey(roomId: string, scopeKey: string, normalizedPath: string): string {
  return `${roomId}:${scopeKey}:${normalizedPath}`;
}

function useCodeWorkspaceFileQuery(
  roomId: string,
  relativePath: string | null,
  enabled = true,
  scopeKey = '',
): FileQueryState {
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const fileCacheRef = useRef(new Map<string, CodeWorkspaceFile>());
  const [data, setData] = useState<CodeWorkspaceFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const normalizedPath = relativePath ? normalizeWorkspacePath(relativePath) : null;
  const normalizedScopeKey = scopeKey || 'default';
  const latestQueryStateRef = useRef({ normalizedPath, enabled, scopeKey: normalizedScopeKey });
  latestQueryStateRef.current = { normalizedPath, enabled, scopeKey: normalizedScopeKey };

  const setCachedData = useCallback<React.Dispatch<React.SetStateAction<CodeWorkspaceFile | null>>>((nextData) => {
    setData((current) => {
      const resolvedData = typeof nextData === 'function'
        ? nextData(current)
        : nextData;
      if (resolvedData) {
        const normalizedFilePath = normalizeWorkspacePath(resolvedData.path);
        fileCacheRef.current.set(
          scopedFileCacheKey(roomId, latestQueryStateRef.current.scopeKey, normalizedFilePath),
          resolvedData,
        );
      }
      return resolvedData;
    });
  }, [roomId]);

  const refresh = useCallback(() => {
    if (
      !normalizedPath ||
      !enabled ||
      latestQueryStateRef.current.normalizedPath !== normalizedPath ||
      !latestQueryStateRef.current.enabled ||
      latestQueryStateRef.current.scopeKey !== normalizedScopeKey
    ) {
      return;
    }

    abortRef.current?.abort();
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const controller = new AbortController();
    abortRef.current = controller;
    setData(resolveCodeAgentProjectFileQueryData(
      roomId,
      normalizedPath,
      fileCacheRef.current.get(scopedFileCacheKey(roomId, normalizedScopeKey, normalizedPath)) ?? null,
      normalizedScopeKey,
    ));
    setError(null);
    setIsPending(true);

    loadCodeWorkspaceFile(roomId, normalizedPath, { signal: controller.signal }).then(
      (file) => {
        if (
          controller.signal.aborted ||
          requestIdRef.current !== requestId ||
          latestQueryStateRef.current.normalizedPath !== normalizedPath ||
          !latestQueryStateRef.current.enabled ||
          latestQueryStateRef.current.scopeKey !== normalizedScopeKey
        ) {
          return;
        }
        const normalizedFilePath = normalizeWorkspacePath(file.path);
        const optimisticFile = getOptimisticCodeAgentProjectFileQueryData(roomId, normalizedFilePath, normalizedScopeKey);
        fileCacheRef.current.set(scopedFileCacheKey(roomId, normalizedScopeKey, normalizedFilePath), file);
        const settled = settleConfirmedCodeAgentProjectFileQueryData(roomId, normalizedFilePath, file, normalizedScopeKey);
        setData(settled ? file : optimisticFile ?? file);
      },
      (nextError) => {
        if (
          controller.signal.aborted ||
          requestIdRef.current !== requestId ||
          latestQueryStateRef.current.normalizedPath !== normalizedPath ||
          !latestQueryStateRef.current.enabled ||
          latestQueryStateRef.current.scopeKey !== normalizedScopeKey
        ) {
          return;
        }
        setError(nextError instanceof Error ? nextError.message : 'File open failed.');
      },
    ).finally(() => {
      if (
        requestIdRef.current === requestId &&
        latestQueryStateRef.current.normalizedPath === normalizedPath &&
        latestQueryStateRef.current.enabled &&
        latestQueryStateRef.current.scopeKey === normalizedScopeKey
      ) {
        setIsPending(false);
        abortRef.current = null;
      }
    });
  }, [enabled, normalizedPath, normalizedScopeKey, roomId]);

  useEffect(() => {
    if (!normalizedPath || !enabled) {
      requestIdRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      setData(null);
      setError(null);
      setIsPending(false);
      return undefined;
    }

    refresh();
    return () => {
      requestIdRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [enabled, normalizedPath, normalizedScopeKey, refresh]);

  return { data, error, isPending, refresh, setData: setCachedData };
}

function useCodeWorkspaceAssetUrlQuery(
  roomId: string,
  relativePath: string | null,
  enabled: boolean,
  scopeKey = '',
): AssetUrlQueryState {
  const requestIdRef = useRef(0);
  const [data, setData] = useState<CodeWorkspaceAssetUrl | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  useEffect(() => {
    if (!relativePath || !enabled) {
      setData(null);
      setError(null);
      setIsPending(false);
      return undefined;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const controller = new AbortController();
    setData(null);
    setError(null);
    setIsPending(true);

    createCodeWorkspaceAssetUrl(roomId, relativePath, { signal: controller.signal }).then(
      (asset) => {
        if (controller.signal.aborted || requestIdRef.current !== requestId) {
          return;
        }
        setData(asset);
      },
      (nextError) => {
        if (controller.signal.aborted || requestIdRef.current !== requestId) {
          return;
        }
        setError(nextError instanceof Error ? nextError.message : 'File preview failed.');
      },
    ).finally(() => {
      if (requestIdRef.current === requestId) {
        setIsPending(false);
      }
    });

    return () => controller.abort();
  }, [enabled, roomId, relativePath, scopeKey]);

  return {
    data,
    resolvedUrl: data ? resolveCodeWorkspaceAssetUrl(data) : null,
    error,
    isPending,
  };
}

export const CodeAgentFileBrowserPanel: React.FC<CodeAgentFileBrowserPanelProps> = ({
  roomId,
  projectName,
  surface = 'desktop',
  sandboxStatus,
  sandboxUpdatedAt,
  workspaceRoot,
  workspaceChanges,
  openFileRequest = null,
  revealLine = null,
  revealRequestId = 0,
  reviewComments = [],
  onAddReviewComment,
  onRemoveReviewComment,
  onAddPreviewAnnotation,
  onFileSavePendingChange,
}) => {
  const { t } = useTranslation();
  const resolvedTheme = useResolvedTheme();
  const entriesQuery = useCodeWorkspaceEntriesQuery(roomId);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const diffSurfaceRef = useRef<HTMLDivElement | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [externallySelectedFilePath, setExternallySelectedFilePath] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({
    path: null,
    state: 'idle',
    error: null,
  });
  const [pendingFileSurfaceIds, setPendingFileSurfaceIds] = useState<ReadonlySet<string>>(() => new Set());
  const [explorerOpen, setExplorerOpen] = useState(initialExplorerOpen);
  const [mobileExplorerOpen, setMobileExplorerOpen] = useState(false);
  const [mobileDiffFileListOpen, setMobileDiffFileListOpen] = useState(false);
  const [explorerWidth, setExplorerWidth] = useState(() => initialExplorerWidth());
  const [diffChangedFilesWidth, setDiffChangedFilesWidth] = useState(() => initialDiffChangedFilesWidth());
  const [wordWrap, setWordWrap] = useState(readInitialFileWordWrap);
  const explorerWidthRef = useRef(explorerWidth);
  const explorerResizeCleanupRef = useRef<(() => void) | null>(null);
  const diffChangedFilesWidthRef = useRef(diffChangedFilesWidth);
  const diffChangedFilesResizeCleanupRef = useRef<(() => void) | null>(null);
  const [sourceView, setSourceView] = useState<{ path: string | null }>({ path: null });
  const [markdownView, setMarkdownView] = useState<{
    path: string | null;
    revealRequestId: number | null;
  }>({ path: null, revealRequestId: null });
  const [assetPreviewRevisions, setAssetPreviewRevisions] = useState<Record<string, number>>({});
  const [localOpenFileRequest, setLocalOpenFileRequest] = useState<{
    path: string;
    line: number | null;
    requestId: number;
  } | null>(null);
  const localOpenFileRequestIdRef = useRef(0);
  const [remoteSearch, setRemoteSearch] = useState<WorkspaceRemoteSearchState>({
    query: '',
    scopeKey: null,
    entries: [],
    truncated: false,
    isPending: false,
    error: null,
  });
  const workspaceReadyKey = `${sandboxStatus || 'none'}:${sandboxUpdatedAt || ''}`;
  const remoteSearchScopeKey = `${roomId}:${workspaceReadyKey}`;
  const previousWorkspaceReadyKeyRef = useRef(workspaceReadyKey);
  const rightPanelState = useCodeAgentRightPanelState(roomId);
  const previewRecentTargets = useCodeAgentPreviewRecentTargets(roomId);
  const diffPanelSelection = useCodeAgentDiffPanelSelection(roomId);
  const [diffFileSummaries, setDiffFileSummaries] = useState<ScopedDiffFileSummaries>({
    scopeKey: null,
    summaries: [],
  });
  const [fileSurfaceTabMenu, setFileSurfaceTabMenu] = useState<FileSurfaceTabMenuState>(null);
  const fileSurfaceTabMenuRef = useRef<HTMLDivElement | null>(null);
  const fileSurfaceTabListRef = useRef<HTMLDivElement | null>(null);
  const [fileSurfaceAddMenuPosition, setFileSurfaceAddMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const fileSurfaceAddMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const fileSurfaceAddMenuRef = useRef<HTMLDivElement | null>(null);
  const fileSurfaceAddMenuOpen = fileSurfaceAddMenuPosition !== null;
  const pendingBrowserAddressFocusRef = useRef(false);
  const panelPreviewAutomationHandlerRef = useRef<CodeAgentPreviewAutomationHandler>(async () => ({
    available: true,
    visible: false,
    tabId: null,
    url: null,
    title: null,
    loading: false,
  }));
  const panelPreviewAutomationSessionsRef = useRef<CodeWorkspacePreviewSession[]>([]);
  const previewRenderedViewportByTabIdRef = useRef(new Map<string, CodeAgentPreviewRenderedViewportSnapshot>());
  const previewViewportWaitersRef = useRef<CodeAgentPreviewAutomationViewportWaiter[]>([]);
  const previewViewportWaiterIdRef = useRef(0);
  const [browserAddressFocusRequests, setBrowserAddressFocusRequests] = useState<Record<string, number>>({});
  const didInitializeRightPanelRef = useRef(false);
  const isMobileSurface = surface === 'mobile';

  const readRenderedPreviewViewport = useCallback((
    tabId: string,
    setting: CodeAgentPreviewViewportSetting,
  ): CodeAgentPreviewViewportSize | null => {
    const snapshot = previewRenderedViewportByTabIdRef.current.get(tabId);
    if (snapshot) {
      const declaredViewport = snapshot.setting._tag === 'fill'
        ? snapshot.viewport
        : { width: snapshot.setting.width, height: snapshot.setting.height };
      if (isCodeWorkspacePreviewViewportReady({
        setting,
        appliedSettingKey: codeAgentBrowserViewportSettingKey(snapshot.setting),
        declaredViewport,
        renderedViewport: snapshot.viewport,
      })) {
        return snapshot.viewport;
      }
    }

    const state = readCodeAgentRightPanelState(roomId);
    const surface = findPreviewAutomationSurfaceByTabId(state, tabId);
    const appliedSetting = surface?.viewport ?? FILL_CODE_AGENT_PREVIEW_VIEWPORT;
    if (
      setting._tag !== 'fill'
      && codeAgentBrowserViewportSettingKey(appliedSetting) === codeAgentBrowserViewportSettingKey(setting)
    ) {
      return { width: setting.width, height: setting.height };
    }
    return null;
  }, [roomId]);

  const settlePreviewViewportWaiters = useCallback(() => {
    const pending = previewViewportWaitersRef.current;
    if (pending.length === 0) {
      return;
    }
    const remaining: CodeAgentPreviewAutomationViewportWaiter[] = [];
    for (const waiter of pending) {
      const viewport = readRenderedPreviewViewport(waiter.tabId, waiter.setting);
      if (viewport) {
        window.clearTimeout(waiter.timeoutId);
        waiter.resolve(viewport);
      } else {
        remaining.push(waiter);
      }
    }
    previewViewportWaitersRef.current = remaining;
  }, [readRenderedPreviewViewport]);

  const waitForPreviewRenderedViewport = useCallback((
    tabId: string,
    setting: CodeAgentPreviewViewportSetting,
    timeoutMs: number,
    requestId: string,
  ): Promise<CodeAgentPreviewViewportSize> => {
    const current = readRenderedPreviewViewport(tabId, setting);
    if (current) {
      return Promise.resolve(current);
    }
    return new Promise<CodeAgentPreviewViewportSize>((resolve, reject) => {
      const id = previewViewportWaiterIdRef.current + 1;
      previewViewportWaiterIdRef.current = id;
      const timeoutId = window.setTimeout(() => {
        previewViewportWaitersRef.current = previewViewportWaitersRef.current.filter((waiter) => waiter.id !== id);
        reject(new Error(
          `Preview viewport for request ${requestId} on tab ${tabId} was not rendered within ${timeoutMs}ms.`,
        ));
      }, timeoutMs);
      previewViewportWaitersRef.current.push({
        id,
        requestId,
        tabId,
        setting,
        timeoutId,
        resolve,
        reject,
      });
    });
  }, [readRenderedPreviewViewport]);

  const handlePreviewRenderedViewportChange = useCallback((
    tabId: string,
    setting: CodeAgentPreviewViewportSetting,
    viewport: CodeAgentPreviewViewportSize,
  ) => {
    const current = previewRenderedViewportByTabIdRef.current.get(tabId);
    if (
      current
      && codeAgentBrowserViewportSettingKey(current.setting) === codeAgentBrowserViewportSettingKey(setting)
      && current.viewport.width === viewport.width
      && current.viewport.height === viewport.height
    ) {
      return;
    }
    previewRenderedViewportByTabIdRef.current.set(tabId, { setting, viewport });
    settlePreviewViewportWaiters();
  }, [settlePreviewViewportWaiters]);

  useEffect(() => () => {
    const waiters = previewViewportWaitersRef.current;
    previewViewportWaitersRef.current = [];
    for (const waiter of waiters) {
      window.clearTimeout(waiter.timeoutId);
      waiter.reject(new Error('Workspace preview automation closed before viewport rendered.'));
    }
  }, []);

  const externallySelectedEntry = useMemo(
    () => (externallySelectedFilePath ? workspaceEntryForPath(externallySelectedFilePath, 'file') : null),
    [externallySelectedFilePath],
  );
  const activeRemoteSearchEntries = remoteSearch.scopeKey === remoteSearchScopeKey
    ? remoteSearch.entries
    : EMPTY_WORKSPACE_ENTRIES;
  const workspaceEntries = useMemo(
    () => mergeWorkspaceEntries(
      entriesQuery.data?.entries ?? [],
      externallySelectedEntry ? [...activeRemoteSearchEntries, externallySelectedEntry] : activeRemoteSearchEntries,
    ),
    [activeRemoteSearchEntries, entriesQuery.data?.entries, externallySelectedEntry],
  );
  const entries = useMemo(
    () => projectEntriesFromWorkspace(workspaceEntries),
    [workspaceEntries],
  );
  const entryKinds = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry.kind] as const)),
    [entries],
  );
  const fileEntryPathSet = useMemo(
    () => new Set(entries
      .filter((entry) => entry.kind === 'file')
      .map((entry) => entry.path)
      .concat(externallySelectedFilePath ? [externallySelectedFilePath] : [])),
    [entries, externallySelectedFilePath],
  );
  const fileSurfaces = useMemo(
    () => rightPanelState.surfaces.filter((surface) => surface.kind === 'file'),
    [rightPanelState.surfaces],
  );
  const rightPanelSurfaces = rightPanelState.surfaces;
  const activeFileSurface = useMemo(
    () => fileSurfaces.find((surface) => surface.id === rightPanelState.activeSurfaceId) ?? null,
    [fileSurfaces, rightPanelState.activeSurfaceId],
  );
  const activeFilesSurface = useMemo(
    () => rightPanelSurfaces.find((surface) => surface.id === rightPanelState.activeSurfaceId && surface.kind === 'files') ?? null,
    [rightPanelState.activeSurfaceId, rightPanelSurfaces],
  );
  const activeDiffSurface = useMemo(
    () => rightPanelSurfaces.find((surface) => surface.id === rightPanelState.activeSurfaceId && surface.kind === 'diff') ?? null,
    [rightPanelState.activeSurfaceId, rightPanelSurfaces],
  );
  const activePreviewSurface = useMemo(
    () => rightPanelSurfaces.find((surface): surface is CodeAgentPreviewPanelSurface => (
      surface.id === rightPanelState.activeSurfaceId && isCodeAgentPreviewSurface(surface)
    )) ?? null,
    [rightPanelState.activeSurfaceId, rightPanelSurfaces],
  );

  const readActivePreviewSurface = useCallback((): CodeAgentPreviewPanelSurface | null => {
    const state = readCodeAgentRightPanelState(roomId);
    return state.surfaces.find((surface): surface is CodeAgentPreviewPanelSurface => (
      surface.id === state.activeSurfaceId && isCodeAgentPreviewSurface(surface)
    )) ?? null;
  }, [roomId]);

  const readPanelPreviewAutomationState = useCallback(async (
    requestedTabId: string | undefined,
  ): Promise<{
    state: CodeAgentRightPanelState;
    index: CodeWorkspacePreviewAutomationSessionIndex;
  }> => {
    const currentState = readCodeAgentRightPanelState(roomId);
    const currentIndex = previewAutomationSessionIndexFromRightPanelState(
      roomId,
      currentState,
      panelPreviewAutomationSessionsRef.current,
    );
    if (!needsCodeWorkspacePreviewAutomationSessionSync(currentIndex, requestedTabId)) {
      return { state: currentState, index: currentIndex };
    }
    const sessions = await listCodeWorkspacePreviewSessions(roomId);
    panelPreviewAutomationSessionsRef.current = sessions;
    const nextState = readCodeAgentRightPanelState(roomId);
    return {
      state: nextState,
      index: previewAutomationSessionIndexFromRightPanelState(roomId, nextState, sessions),
    };
  }, [roomId]);

  const syncPanelPreviewSurfaceForSession = useCallback((
    session: CodeWorkspacePreviewSession,
  ): CodeAgentPreviewPanelSurface => {
    const currentState = readCodeAgentRightPanelState(roomId);
    let surface = findPreviewAutomationSurfaceByTabId(currentState, session.tabId);
    if (!surface) {
      addCodeAgentRightPanelPreviewSurface(roomId);
      surface = readActivePreviewSurface();
    }
    if (!surface) {
      throw new Error('Workspace preview surface is not available.');
    }
    setCodeAgentRightPanelPreviewSessionId(roomId, surface.id, session.tabId);
    setCodeAgentRightPanelPreviewViewport(roomId, session.tabId, session.viewport);

    const sessionUrl = codeWorkspacePreviewUrlFromStatus(session.navStatus);
    if (sessionUrl) {
      navigateCodeAgentRightPanelPreviewSurface(roomId, surface.id, { kind: 'url', url: sessionUrl });
    } else {
      activateCodeAgentRightPanelSurface(roomId, surface.id);
    }

    const nextState = readCodeAgentRightPanelState(roomId);
    return findPreviewAutomationSurfaceByTabId(nextState, session.tabId)
      ?? readActivePreviewSurface()
      ?? surface;
  }, [readActivePreviewSurface, roomId]);

  const panelPreviewAutomationStatus = useCallback(async (
    request?: CodeWorkspacePreviewAutomationRequest,
    surfaceOverride?: CodeAgentPreviewPanelSurface | null,
  ) => {
    const requestedTabId = request ? previewAutomationRequestedTabId(request) : undefined;
    const { state, index } = await readPanelPreviewAutomationState(requestedTabId);
    if (surfaceOverride !== undefined) {
      return previewAutomationStatusFromSurface(state, surfaceOverride);
    }
    const target = resolveCodeWorkspacePreviewAutomationTarget(index, requestedTabId ?? null);
    if (target.snapshot) {
      return previewAutomationStatusFromSession(
        state,
        findPreviewAutomationSurfaceByTabId(state, target.tabId),
        target.snapshot,
      );
    }
    const surface = requestedTabId ? null : readActivePreviewSurface();
    return previewAutomationStatusFromSurface(state, surface);
  }, [readActivePreviewSurface, readPanelPreviewAutomationState]);

  const ensurePanelPreviewSurface = useCallback((
    reuseExisting: boolean,
    existingTabId?: string | null,
  ): CodeAgentPreviewPanelSurface => {
    const existingState = readCodeAgentRightPanelState(roomId);
    const existing = existingTabId
      ? findPreviewAutomationSurfaceByTabId(existingState, existingTabId)
      : (reuseExisting ? readActivePreviewSurface() : null);
    if (existing) {
      activateCodeAgentRightPanelSurface(roomId, existing.id);
      return existing;
    }
    addCodeAgentRightPanelPreviewSurface(roomId);
    const surface = readActivePreviewSurface();
    if (!surface) {
      throw new Error('Workspace preview surface is not available.');
    }
    return surface;
  }, [readActivePreviewSurface, roomId]);

  const handlePanelPreviewAutomationSession = useCallback(async (
    request: CodeWorkspacePreviewAutomationRequest,
  ): Promise<unknown> => {
    if (request.operation === 'status') {
      return panelPreviewAutomationStatus(request);
    }

    if (request.operation === 'open' || request.operation === 'navigate') {
      const input = request.input && typeof request.input === 'object'
        ? request.input as Record<string, unknown>
        : {};
      const requestedTabId = previewAutomationRequestedTabId(request);
      const { index } = await readPanelPreviewAutomationState(requestedTabId);
      const reuseExistingTab = input.reuseExistingTab !== false;
      const existingTabId = resolveCodeWorkspacePreviewAutomationOpenTab(
        index,
        requestedTabId,
        reuseExistingTab,
      );
      const url = await previewAutomationNavigationUrl(roomId, request.input);
      if (request.operation === 'navigate' && !url) {
        throw new Error('Workspace preview automation requires a direct URL or environment-port target in this cloud surface.');
      }
      if (request.operation === 'navigate' && requestedTabId && !existingTabId) {
        throw new Error(`Workspace preview tab ${requestedTabId} is not available.`);
      }
      const existingSession = existingTabId ? index.sessions[existingTabId] ?? null : null;
      const surface = existingSession
        ? syncPanelPreviewSurfaceForSession(existingSession)
        : ensurePanelPreviewSurface(reuseExistingTab, existingTabId);
      if (!url) {
        return panelPreviewAutomationStatus(request, surface);
      }
      setCodeAgentRightPanelPreviewSessionId(roomId, surface.id, surface.previewSessionId ?? surface.id);
      navigateCodeAgentRightPanelPreviewSurface(roomId, surface.id, { kind: 'url', url });
      return panelPreviewAutomationStatus(request, readActivePreviewSurface());
    }

    if (request.operation === 'resize') {
      const requestedTabId = previewAutomationRequestedTabId(request);
      const { index } = await readPanelPreviewAutomationState(requestedTabId);
      const target = resolveCodeWorkspacePreviewAutomationTarget(index, requestedTabId ?? null);
      const surface = target.snapshot
        ? syncPanelPreviewSurfaceForSession(target.snapshot)
        : (requestedTabId ? null : readActivePreviewSurface());
      if (!surface) {
        throw new Error('Workspace preview surface is not open.');
      }
      const nextViewport = previewAutomationViewportSetting(request.input);
      const timeoutMs = codeWorkspacePreviewAutomationTimeoutMs(request.input, request.timeoutMs);
      const tabId = previewAutomationTabIdFromSurface(surface);
      const session = await resizeCodeWorkspacePreviewSession({
        roomId,
        tabId,
        viewport: nextViewport,
      });
      setCodeAgentRightPanelPreviewViewport(roomId, session.tabId, session.viewport);
      const renderedViewport = await waitForPreviewRenderedViewport(
        session.tabId,
        session.viewport,
        timeoutMs,
        request.requestId,
      );
      return {
        tabId: session.tabId,
        setting: session.viewport,
        viewport: renderedViewport,
      };
    }

    throw new Error(`Workspace preview automation opener does not support ${request.operation}.`);
  }, [
    ensurePanelPreviewSurface,
    panelPreviewAutomationStatus,
    readActivePreviewSurface,
    readPanelPreviewAutomationState,
    roomId,
    syncPanelPreviewSurfaceForSession,
    waitForPreviewRenderedViewport,
  ]);

  useEffect(() => {
    panelPreviewAutomationHandlerRef.current = handlePanelPreviewAutomationSession;
  }, [handlePanelPreviewAutomationSession]);

  useEffect(() => {
    let disposed = false;
    void listCodeWorkspacePreviewSessions(roomId)
      .then(async (sessions) => {
        if (disposed) {
          return;
        }
        if (sessions.length === 0) {
          const recoverableSurfaces = recoverablePreviewSessionSurfaces(readCodeAgentRightPanelState(roomId));
          if (recoverableSurfaces.length > 0) {
            const recoveredSessions = (await Promise.all(recoverableSurfaces.map((surface) => (
              openCodeWorkspacePreviewSession({
                roomId,
                tabId: previewAutomationTabIdFromSurface(surface),
                url: surface.url,
                title: surface.url,
                viewport: surface.viewport ?? FILL_CODE_AGENT_PREVIEW_VIEWPORT,
              }).catch(() => null)
            )))).filter((session): session is CodeWorkspacePreviewSession => session !== null);
            if (disposed) {
              return;
            }
            if (recoveredSessions.length > 0) {
              panelPreviewAutomationSessionsRef.current = recoveredSessions;
              reconcileCodeAgentPreviewSessionSurfaces(roomId, recoveredSessions);
              return;
            }
          }
        }
        panelPreviewAutomationSessionsRef.current = sessions;
        reconcileCodeAgentPreviewSessionSurfaces(roomId, sessions);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [roomId]);

  useEffect(() => {
    let disposed = false;
    let controller: CodeAgentPreviewAutomationController | null = null;
    void connectCodeWorkspacePreviewAutomationHost({
      roomId,
      supportedOperations: CODE_WORKSPACE_PREVIEW_AUTOMATION_SESSION_OPERATIONS,
      handle: (request) => panelPreviewAutomationHandlerRef.current(request),
    }).then((nextController) => {
      if (disposed) {
        nextController.dispose();
        return;
      }
      controller = nextController;
    }).catch(() => undefined);

    const reportFocus = () => {
      void Promise.resolve(
        controller?.setFocused(typeof document === 'undefined' ? true : document.hasFocus()),
      ).catch(() => undefined);
    };
    window.addEventListener('focus', reportFocus);
    window.addEventListener('blur', reportFocus);
    return () => {
      disposed = true;
      window.removeEventListener('focus', reportFocus);
      window.removeEventListener('blur', reportFocus);
      controller?.dispose();
    };
  }, [roomId]);

  useEffect(() => subscribeCodeWorkspacePreviewEvents(roomId, (event) => {
    if (event.snapshot) {
      panelPreviewAutomationSessionsRef.current = [
        event.snapshot,
        ...panelPreviewAutomationSessionsRef.current.filter((session) => session.tabId !== event.snapshot?.tabId),
      ];
      reconcileCodeAgentPreviewSessionSurfaces(roomId, [event.snapshot]);
      setCodeAgentRightPanelPreviewViewport(roomId, event.snapshot.tabId, event.snapshot.viewport);
      return;
    }
    if (event.type === 'closed') {
      panelPreviewAutomationSessionsRef.current = panelPreviewAutomationSessionsRef.current.filter(
        (session) => session.tabId !== event.tabId,
      );
      closeCodeAgentPreviewSessionSurface(roomId, event.tabId);
    }
  }), [roomId]);
  const diffSelectionScopeKey = diffPanelSelection.kind === 'branch'
    ? `branch:${diffPanelSelection.baseRef ?? 'auto'}`
    : 'unstaged';
  const changedFilesExpansionScopeKey = `${workspaceReadyKey}:${diffSelectionScopeKey}`;
  const allChangedDirectoriesExpanded = useCodeAgentChangedFilesExpanded(roomId, changedFilesExpansionScopeKey);
  const diffFileSummaryScopeKey = `${workspaceReadyKey}:${diffSelectionScopeKey}`;
  const hasActiveDiffFileSummaries = diffFileSummaries.scopeKey === diffFileSummaryScopeKey;
  const activeDiffFileSummaries = hasActiveDiffFileSummaries
    ? diffFileSummaries.summaries
    : EMPTY_DIFF_FILE_SUMMARIES;
  const snapshotChangedFiles = workspaceChanges?.changedFiles ?? EMPTY_CHANGED_FILES;
  const snapshotChangedFileStats = workspaceChanges?.changedFileStats ?? EMPTY_CHANGED_FILE_STATS;
  const liveChangedFileEntries = useMemo(
    () => activeDiffFileSummaries.map((summary) => ({
      path: normalizeWorkspacePath(summary.path),
      additions: summary.additions,
      deletions: summary.deletions,
    })).filter((entry) => entry.path.length > 0),
    [activeDiffFileSummaries],
  );
  const snapshotChangedFileEntries = useMemo(
    () => {
      const statEntries = snapshotChangedFileStats.map((stat) => ({
        path: normalizeWorkspacePath(stat.path),
        additions: stat.additions,
        deletions: stat.deletions,
      })).filter((entry) => entry.path.length > 0);
      const statPathSet = new Set(statEntries.map((entry) => entry.path));
      const fallbackEntries = snapshotChangedFiles
        .map((path) => ({ path: normalizeWorkspacePath(path) }))
        .filter((entry) => entry.path.length > 0 && !statPathSet.has(entry.path));
      if (statEntries.length > 0) {
        return [...statEntries, ...fallbackEntries];
      }
      return fallbackEntries;
    },
    [snapshotChangedFileStats, snapshotChangedFiles],
  );
  const changedFileEntries = hasActiveDiffFileSummaries
    ? liveChangedFileEntries
    : snapshotChangedFileEntries;
  const changedFileSummary = useMemo(
    () => summarizeCodeAgentChangedFileStats(changedFileEntries),
    [changedFileEntries],
  );
  const selectedDiffFilePath = diffPanelSelection.filePath;
  const selectedDiffFileRequestId = diffPanelSelection.revealRequestId;
  const normalizedChangedFilePathSet = useMemo(
    () => new Set(changedFileEntries.map((entry) => entry.path)),
    [changedFileEntries],
  );
  const hasChangedFileDirectories = useMemo(
    () => changedFileEntries.some((entry) => entry.path.includes('/')),
    [changedFileEntries],
  );
  const fileSurfaceTabMenuSurface = useMemo(
    () => fileSurfaceTabMenu
      ? rightPanelSurfaces.find((surface) => surface.id === fileSurfaceTabMenu.surfaceId) ?? null
      : null,
    [fileSurfaceTabMenu, rightPanelSurfaces],
  );
  const selectedKind = selectedPath
    ? entryKinds.get(selectedPath) ?? (selectedPath === externallySelectedFilePath ? 'file' : undefined)
    : undefined;
  const previewKind = previewPath
    ? entryKinds.get(previewPath) ?? (previewPath === externallySelectedFilePath ? 'file' : undefined)
    : undefined;
  const relativePath = previewPath && previewKind === 'file' ? previewPath : null;
  const isMarkdown = relativePath ? isMarkdownPreviewFile(relativePath) : false;
  const isImagePreview = relativePath ? isImagePreviewFile(relativePath) : false;
  const canOpenInBrowserPreview = relativePath ? isBrowserPreviewFile(relativePath) : false;
  const supportsWorkspaceAssetPreview = canOpenInBrowserPreview || isImagePreview;
  const supportsPreview = Boolean(relativePath && (isMarkdown || (supportsWorkspaceAssetPreview && !isImagePreview)));
  const localRevealApplies = Boolean(
    localOpenFileRequest &&
    localOpenFileRequest.path === relativePath,
  );
  const surfaceRevealApplies = Boolean(activeFileSurface && activeFileSurface.relativePath === relativePath);
  const effectiveRevealLine = localRevealApplies
    ? localOpenFileRequest?.line ?? null
    : surfaceRevealApplies
      ? activeFileSurface?.revealLine ?? null
      : revealLine;
  const effectiveRevealRequestId = localRevealApplies
    ? localOpenFileRequest?.requestId ?? 0
    : surfaceRevealApplies
      ? activeFileSurface?.revealRequestId ?? 0
      : revealRequestId;
  const renderMarkdown = Boolean(
    relativePath &&
    isMarkdown &&
    markdownView.path === relativePath &&
    (effectiveRevealLine === null || markdownView.revealRequestId === effectiveRevealRequestId),
  );
  const renderPreview = isMarkdown
    ? renderMarkdown
    : Boolean(supportsWorkspaceAssetPreview && (isImagePreview || sourceView.path !== relativePath));
  const browserPreviewPending = false;
  const activeSaveState = saveStatus.path === relativePath ? saveStatus.state : 'idle';
  const activeSaveError = saveStatus.path === relativePath ? saveStatus.error : null;
  const fileQuery = useCodeWorkspaceFileQuery(
    roomId,
    relativePath,
    Boolean(relativePath && (!renderPreview || isMarkdown)),
    workspaceReadyKey,
  );
  const assetUrlQuery = useCodeWorkspaceAssetUrlQuery(
    roomId,
    relativePath,
    Boolean(relativePath && supportsWorkspaceAssetPreview && (renderPreview || (isMobileSurface && canOpenInBrowserPreview))),
    workspaceReadyKey,
  );
  const activeAssetPreviewRevision = relativePath ? assetPreviewRevisions[relativePath] ?? 0 : 0;
  const previewSurfacePath = activePreviewSurface?.relativePath ?? null;
  const previewSurfaceAssetUrlQuery = useCodeWorkspaceAssetUrlQuery(
    roomId,
    previewSurfacePath,
    Boolean(previewSurfacePath),
    workspaceReadyKey,
  );
  const activePreviewSurfaceRevision = previewSurfacePath ? assetPreviewRevisions[previewSurfacePath] ?? 0 : 0;
  const recentPreviewTargets = useMemo(() => {
    const workspaceFileSetIsAuthoritative = entriesQuery.data !== null && !entriesQuery.data.truncated;
    return previewRecentTargets.filter((target) => (
      target.kind === 'url' ||
      !workspaceFileSetIsAuthoritative ||
      fileEntryPathSet.has(target.relativePath)
    ));
  }, [entriesQuery.data, fileEntryPathSet, previewRecentTargets]);
  const selectedDirectory = selectedKind === 'directory'
    ? selectedPath || ''
    : selectedPath
      ? parentPath(selectedPath)
      : relativePath
        ? parentPath(relativePath)
        : '';
  const canToggleFileWordWrap = Boolean(relativePath && fileQuery.data?.encoding === 'utf-8');
  const refreshSourceFile = fileQuery.refresh;
  const refreshCurrentFilePending = (!renderPreview && fileQuery.isPending) || (renderPreview && assetUrlQuery.isPending);
  const refreshWorkspaceEntries = entriesQuery.refresh;

  useEffect(() => {
    explorerWidthRef.current = explorerWidth;
    panelRef.current?.style.setProperty('--workspace-file-explorer-width', `${explorerWidth}px`);
  }, [explorerWidth]);

  useEffect(() => {
    diffChangedFilesWidthRef.current = diffChangedFilesWidth;
    panelRef.current?.style.setProperty('--workspace-diff-changed-files-width', `${diffChangedFilesWidth}px`);
  }, [diffChangedFilesWidth]);

  useEffect(() => () => {
    explorerResizeCleanupRef.current?.();
    explorerResizeCleanupRef.current = null;
    diffChangedFilesResizeCleanupRef.current?.();
    diffChangedFilesResizeCleanupRef.current = null;
  }, []);

  useEffect(() => {
    if (
      !entriesQuery.isPending &&
      selectedPath &&
      !entryKinds.has(selectedPath) &&
      selectedPath !== externallySelectedFilePath
    ) {
      setSelectedPath(null);
    }
  }, [entriesQuery.isPending, entryKinds, externallySelectedFilePath, selectedPath]);

  useEffect(() => {
    if (
      !entriesQuery.isPending &&
      previewPath &&
      !entryKinds.has(previewPath) &&
      previewPath !== externallySelectedFilePath
    ) {
      setPreviewPath(null);
    }
  }, [entriesQuery.isPending, entryKinds, externallySelectedFilePath, previewPath]);

  useEffect(() => {
    if (didInitializeRightPanelRef.current) {
      return;
    }
    didInitializeRightPanelRef.current = true;
    if (rightPanelSurfaces.length === 0) {
      openCodeAgentRightPanel(roomId, 'files');
    }
  }, [rightPanelSurfaces.length, roomId]);

  useEffect(() => {
    if (activeFilesSurface || activeDiffSurface || activePreviewSurface) {
      if (previewPath) {
        setPreviewPath(null);
      }
      return;
    }
    if (!activeFileSurface) {
      if (previewPath && fileSurfaces.length === 0) {
        setPreviewPath(null);
      }
      return;
    }
    setSelectedPath(activeFileSurface.relativePath);
    setPreviewPath(activeFileSurface.relativePath);
  }, [activeDiffSurface, activeFileSurface, activeFilesSurface, activePreviewSurface, fileSurfaces.length, previewPath]);

  useEffect(() => {
    const activeTab = fileSurfaceTabListRef.current?.querySelector<HTMLElement>('[data-active-tab="true"]');
    if (typeof activeTab?.scrollIntoView === 'function') {
      activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [rightPanelState.activeSurfaceId]);

  useEffect(() => {
    if (entriesQuery.isPending) {
      return;
    }
    if (entriesQuery.data === null) {
      if (entriesQuery.error) {
        reconcileCodeAgentFileSurfaces(roomId, false);
      }
      return;
    }
    if (entriesQuery.data.truncated) {
      return;
    }
    reconcileCodeAgentFileSurfaces(roomId, true, fileEntryPathSet);
  }, [entriesQuery.data, entriesQuery.error, entriesQuery.isPending, fileEntryPathSet, roomId]);

  useEffect(() => {
    if (!pendingBrowserAddressFocusRef.current || !activePreviewSurface) {
      return;
    }
    pendingBrowserAddressFocusRef.current = false;
    setBrowserAddressFocusRequests((current) => ({
      ...current,
      [activePreviewSurface.id]: (current[activePreviewSurface.id] ?? 0) + 1,
    }));
  }, [activePreviewSurface]);

  useEffect(() => {
    if (
      !activeDiffSurface ||
      !selectedDiffFilePath ||
      !hasActiveDiffFileSummaries ||
      normalizedChangedFilePathSet.has(selectedDiffFilePath)
    ) {
      return;
    }
    clearCodeAgentDiffFile(roomId);
  }, [
    activeDiffSurface,
    hasActiveDiffFileSummaries,
    normalizedChangedFilePathSet,
    roomId,
    selectedDiffFilePath,
  ]);

  useEffect(() => {
    if (!isMobileSurface || !activeDiffSurface || changedFileEntries.length === 0) {
      setMobileDiffFileListOpen(false);
    }
  }, [activeDiffSurface, changedFileEntries.length, isMobileSurface]);

  useEffect(() => {
    if (!openFileRequest?.path) {
      return;
    }
    const normalizedPath = normalizeWorkspacePath(openFileRequest.path);
    if (!normalizedPath) {
      return;
    }
    setSelectedPath(normalizedPath);
    setPreviewPath(normalizedPath);
    setExternallySelectedFilePath(normalizedPath);
    if (isMobileSurface) {
      setMobileExplorerOpen(false);
    }
    openCodeAgentRightPanelFile(roomId, normalizedPath, revealLine);
    setLocalOpenFileRequest(null);
    setOperationError(null);
  }, [isMobileSurface, openFileRequest?.path, openFileRequest?.requestId, revealLine, roomId]);

  useEffect(() => {
    const previousKey = previousWorkspaceReadyKeyRef.current;
    previousWorkspaceReadyKeyRef.current = workspaceReadyKey;
    if (sandboxStatus === 'ready' && previousKey !== workspaceReadyKey) {
      if (rightPanelSurfaces.length === 0) {
        openCodeAgentRightPanel(roomId, 'files');
      }
      refreshWorkspaceEntries();
    }
  }, [refreshWorkspaceEntries, rightPanelSurfaces.length, roomId, sandboxStatus, workspaceReadyKey]);

  useEffect(() => {
    setSourceView({ path: null });
    setMarkdownView({ path: null, revealRequestId: null });
  }, [relativePath]);

  const refreshEntries = useCallback(() => {
    refreshWorkspaceEntries();
  }, [refreshWorkspaceEntries]);

  const refreshAfterFileContentsChanged = useCallback(() => {
    refreshWorkspaceEntries();
    refreshSourceFile();
  }, [refreshSourceFile, refreshWorkspaceEntries]);

  const handleAssetPreviewChanged = useCallback((changedPath: string) => {
    setAssetPreviewRevisions((current) => ({
      ...current,
      [changedPath]: (current[changedPath] ?? 0) + 1,
    }));
  }, []);

  const handlePreviewRecordingArtifactSaved = useCallback((artifact: CodeAgentPreviewRecordingArtifact) => {
    handleAssetPreviewChanged(artifact.path);
    refreshWorkspaceEntries();
  }, [handleAssetPreviewChanged, refreshWorkspaceEntries]);

  const handleOpenWorkspaceFileFromPreviewSurface = useCallback((path: string) => {
    const normalizedPath = normalizeWorkspacePath(path);
    if (!normalizedPath) {
      return;
    }
    setSelectedPath(normalizedPath);
    setPreviewPath(normalizedPath);
    setExternallySelectedFilePath(normalizedPath);
    if (isMobileSurface) {
      setMobileExplorerOpen(false);
    }
    openCodeAgentRightPanelFile(roomId, normalizedPath);
    setOperationError(null);
  }, [isMobileSurface, roomId]);

  const handleRefreshCurrentFile = useCallback(() => {
    if (!relativePath) {
      return;
    }
    if (renderPreview && supportsWorkspaceAssetPreview) {
      handleAssetPreviewChanged(relativePath);
      return;
    }
    refreshSourceFile();
  }, [handleAssetPreviewChanged, refreshSourceFile, relativePath, renderPreview, supportsWorkspaceAssetPreview]);

  const handleSearchQueryChange = useCallback((query: string) => {
    setRemoteSearch((current) => (
      current.query === query
        ? current
        : { ...current, query }
    ));
  }, []);

  useEffect(() => {
    const query = remoteSearch.query.trim();
    if (query.length < 2) {
      setRemoteSearch((current) => (
        current.scopeKey === null
        && current.entries.length === 0
        && !current.truncated
        && !current.isPending
        && current.error === null
          ? current
          : { ...current, scopeKey: null, entries: [], truncated: false, isPending: false, error: null }
      ));
      return undefined;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setRemoteSearch((current) => (
        current.query === remoteSearch.query
          ? {
            ...current,
            scopeKey: remoteSearchScopeKey,
            entries: current.scopeKey === remoteSearchScopeKey ? current.entries : [],
            truncated: current.scopeKey === remoteSearchScopeKey ? current.truncated : false,
            isPending: true,
            error: null,
          }
          : current
      ));
      searchCodeWorkspaceEntries(roomId, query, {
        limit: WORKSPACE_TREE_REMOTE_SEARCH_LIMIT,
        signal: controller.signal,
      }).then(
        (result) => {
          if (controller.signal.aborted) return;
          setRemoteSearch((current) => (
            current.query === remoteSearch.query
              ? {
                ...current,
                scopeKey: remoteSearchScopeKey,
                entries: result.entries,
                truncated: result.truncated,
                isPending: false,
                error: null,
              }
              : current
          ));
        },
        (error) => {
          if (controller.signal.aborted) return;
          setRemoteSearch((current) => (
            current.query === remoteSearch.query
              ? {
                ...current,
                scopeKey: remoteSearchScopeKey,
                entries: [],
                truncated: false,
                isPending: false,
                error: error instanceof Error ? error.message : 'Workspace file search failed.',
              }
              : current
          ));
        },
      );
    }, WORKSPACE_TREE_REMOTE_SEARCH_DEBOUNCE_MS);

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [remoteSearch.query, remoteSearchScopeKey, roomId]);

  const mutate = useCallback(async (
    operation: () => unknown,
    nextSelectedPath?: string | null,
    nextPreviewPath?: string | null,
  ) => {
    setOperationError(null);
    try {
      await operation();
      if (nextSelectedPath !== undefined) {
        setSelectedPath(nextSelectedPath);
      }
      if (nextPreviewPath !== undefined) {
        setPreviewPath(nextPreviewPath);
        setLocalOpenFileRequest(null);
        if (nextPreviewPath === null) {
          setExternallySelectedFilePath(null);
          if (relativePath) {
            closeCodeAgentRightPanelSurface(roomId, `file:${relativePath}`);
          }
        } else {
          if (isMobileSurface) {
            setMobileExplorerOpen(false);
          }
          openCodeAgentRightPanelFile(roomId, nextPreviewPath);
        }
      }
      refreshEntries();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Workspace file operation failed.');
    }
  }, [isMobileSurface, refreshEntries, relativePath, roomId]);

  const handleOpenEntry = useCallback((path: string, kind: CodeAgentProjectEntry['kind']) => {
    const normalizedPath = normalizeWorkspacePath(path);
    if (!normalizedPath) {
      return;
    }
    setSelectedPath(normalizedPath);
    if (kind === 'file') {
      setPreviewPath(normalizedPath);
      setExternallySelectedFilePath(null);
      setLocalOpenFileRequest(null);
      if (isMobileSurface) {
        setMobileExplorerOpen(false);
      }
      openCodeAgentRightPanelFile(roomId, normalizedPath);
    }
    setOperationError(null);
  }, [isMobileSurface, roomId]);

  const handleOpenWorkspaceFileFromMarkdown = useCallback((path: string) => {
    const target = parseWorkspaceFileOpenTarget(path, { workspaceRoot: workspaceRoot ?? undefined });
    if (!target) {
      return;
    }

    localOpenFileRequestIdRef.current += 1;
    setLocalOpenFileRequest({
      path: target.path,
      line: target.line,
      requestId: localOpenFileRequestIdRef.current,
    });
    setSelectedPath(target.path);
    setPreviewPath(target.path);
    setExternallySelectedFilePath(target.path);
    if (isMobileSurface) {
      setMobileExplorerOpen(false);
    }
    openCodeAgentRightPanelFile(roomId, target.path, target.line);
    setOperationError(null);
  }, [isMobileSurface, roomId, workspaceRoot]);

  const handleCreateFile = useCallback(() => {
    const path = window.prompt(t('codeAgentNewFilePrompt'), joinWorkspacePath(selectedDirectory, 'untitled.txt'));
    const normalizedPath = path ? normalizeWorkspacePath(path) : '';
    if (!normalizedPath) return;
    void mutate(() => writeCodeWorkspaceFile(roomId, normalizedPath, '', 'utf-8'), normalizedPath, normalizedPath);
  }, [mutate, roomId, selectedDirectory, t]);

  const handleCreateDirectory = useCallback(() => {
    const path = window.prompt(t('codeAgentNewFolderPrompt'), joinWorkspacePath(selectedDirectory, 'new-folder'));
    const normalizedPath = path ? normalizeWorkspacePath(path) : '';
    if (!normalizedPath) return;
    void mutate(() => createCodeWorkspaceDirectory(roomId, normalizedPath), normalizedPath);
  }, [mutate, roomId, selectedDirectory, t]);

  const handleRename = useCallback(() => {
    if (!selectedPath) return;
    const path = window.prompt(t('codeAgentRenamePrompt'), selectedPath);
    const normalizedPath = path ? normalizeWorkspacePath(path) : '';
    if (!normalizedPath || normalizedPath === selectedPath) return;
    const nextPreviewPath = relativePath && pathContains(selectedPath, relativePath)
      ? replacePathPrefix(relativePath, selectedPath, normalizedPath)
      : undefined;
    void mutate(() => renameCodeWorkspaceEntry(roomId, selectedPath, normalizedPath), normalizedPath, nextPreviewPath);
  }, [mutate, relativePath, roomId, selectedPath, t]);

  const handleDelete = useCallback(() => {
    if (!selectedPath) return;
    if (!window.confirm(t('codeAgentDeleteConfirm', { path: selectedPath }))) return;
    const nextPreviewPath = relativePath && pathContains(selectedPath, relativePath) ? null : undefined;
    void mutate(() => deleteCodeWorkspaceEntry(roomId, selectedPath), null, nextPreviewPath);
  }, [mutate, relativePath, roomId, selectedPath, t]);

  const handleUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length === 0) return;
    void mutate(async () => {
      for (const file of files) {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (const byte of bytes) {
          binary += String.fromCharCode(byte);
        }
        await writeCodeWorkspaceFile(
          roomId,
          joinWorkspacePath(selectedDirectory, file.name),
          window.btoa(binary),
          'base64',
        );
      }
    });
  }, [mutate, roomId, selectedDirectory]);

  const toggleExplorer = useCallback(() => {
    if (isMobileSurface) {
      setMobileExplorerOpen((current) => !current);
      return;
    }
    setExplorerOpen((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(FILE_EXPLORER_STORAGE_KEY, String(next));
      } catch {
        // Ignore localStorage failures; the explorer toggle remains functional.
      }
      return next;
    });
  }, [isMobileSurface]);
  const handleBackToMobileFilePreview = useCallback(() => {
    setMobileExplorerOpen(false);
  }, []);

  const handleExplorerResizeStart = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) {
      return;
    }

    const panel = panelRef.current;
    if (!panel) {
      return;
    }

    event.preventDefault();
    const startWidth = explorerWidthRef.current;
    explorerResizeCleanupRef.current?.();
    explorerResizeCleanupRef.current = beginHorizontalResize({
      pointerId: event.pointerId,
      startX: event.clientX,
      initialWidth: startWidth,
      direction: -1,
      captureTarget: event.currentTarget,
      getBounds: () => getFileExplorerResizeBounds(panel.getBoundingClientRect().width),
      onResize: (width) => {
        panel.style.setProperty('--workspace-file-explorer-width', `${width}px`);
      },
      onFinish: (width) => {
        explorerWidthRef.current = width;
        setExplorerWidth(width);
        try {
          window.localStorage.setItem(FILE_EXPLORER_WIDTH_STORAGE_KEY, String(width));
        } catch {
          // localStorage persistence is best-effort; the live resize still applies.
        }
        explorerResizeCleanupRef.current = null;
      },
    });
  }, []);

  const handleDiffChangedFilesResizeStart = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) {
      return;
    }

    const surface = diffSurfaceRef.current;
    if (!surface) {
      return;
    }

    event.preventDefault();
    const startWidth = diffChangedFilesWidthRef.current;
    diffChangedFilesResizeCleanupRef.current?.();
    diffChangedFilesResizeCleanupRef.current = beginHorizontalResize({
      pointerId: event.pointerId,
      startX: event.clientX,
      initialWidth: startWidth,
      direction: 1,
      captureTarget: event.currentTarget,
      getBounds: () => getDiffChangedFilesResizeBounds(surface.getBoundingClientRect().width),
      onResize: (width) => {
        panelRef.current?.style.setProperty('--workspace-diff-changed-files-width', `${width}px`);
      },
      onFinish: (width) => {
        diffChangedFilesWidthRef.current = width;
        setDiffChangedFilesWidth(width);
        try {
          window.localStorage.setItem(DIFF_CHANGED_FILES_WIDTH_STORAGE_KEY, String(width));
        } catch {
          // localStorage persistence is best-effort; the live resize still applies.
        }
        diffChangedFilesResizeCleanupRef.current = null;
      },
    });
  }, []);

  const togglePreviewView = useCallback(() => {
    if (!relativePath) {
      return;
    }
    if (isMarkdown) {
      setMarkdownView((current) => ({
        path: renderMarkdown && current.path === relativePath ? null : relativePath,
        revealRequestId: renderMarkdown && current.path === relativePath ? null : effectiveRevealRequestId,
      }));
      return;
    }
    setSourceView((current) => ({
      path: current.path === relativePath ? null : relativePath,
    }));
  }, [effectiveRevealRequestId, isMarkdown, relativePath, renderMarkdown]);

  const toggleWordWrap = useCallback(() => {
    setWordWrap((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(FILE_WORD_WRAP_STORAGE_KEY, String(next));
      } catch {
        // Preference persistence is best-effort; the live toggle still applies.
      }
      return next;
    });
  }, []);

  const openBrowserPreviewPath = useCallback((path: string) => {
    const targetPath = parseWorkspaceFileOpenTarget(path, { workspaceRoot: workspaceRoot ?? undefined })?.path ?? '';
    if (!targetPath || !isBrowserPreviewFile(targetPath)) {
      return;
    }

    setOperationError(null);
    setSelectedPath(targetPath);
    setExternallySelectedFilePath((current) => (entryKinds.has(targetPath) ? current : targetPath));
    openCodeAgentRightPanelPreview(roomId, targetPath);
  }, [entryKinds, roomId, workspaceRoot]);

  const handleNavigatePreviewSurface = useCallback((
    surfaceId: string,
    target: { kind: 'workspace-file'; relativePath: string } | { kind: 'url'; url: string },
  ) => {
    if (target.kind === 'workspace-file') {
      const normalizedPath = normalizeWorkspacePath(target.relativePath);
      if (!normalizedPath || !isBrowserPreviewFile(normalizedPath)) {
        return;
      }
      setSelectedPath(normalizedPath);
      setExternallySelectedFilePath((current) => (entryKinds.has(normalizedPath) ? current : normalizedPath));
      navigateCodeAgentRightPanelPreviewSurface(roomId, surfaceId, {
        kind: 'workspace-file',
        relativePath: normalizedPath,
      });
      setOperationError(null);
      return;
    }

    navigateCodeAgentRightPanelPreviewSurface(roomId, surfaceId, target);
    setOperationError(null);
  }, [entryKinds, roomId]);

  const handleNavigatePreviewHistory = useCallback((
    surfaceId: string,
    direction: 'back' | 'forward',
  ) => {
    navigateCodeAgentRightPanelPreviewHistory(roomId, surfaceId, direction);
    setOperationError(null);
  }, [roomId]);

  const handleOpenInBrowserPreview = useCallback(() => {
    if (!relativePath) {
      return;
    }
    openBrowserPreviewPath(relativePath);
  }, [openBrowserPreviewPath, relativePath]);

  const handleSaveStateChange = useCallback((path: string, state: SaveState, error: string | null = null) => {
    setSaveStatus({
      path,
      state,
      error,
    });
    const normalizedPath = normalizeWorkspacePath(path);
    if (!normalizedPath) {
      return;
    }
    const surfaceId = `file:${normalizedPath}`;
    const pending = state === 'pending' || state === 'saving';
    setPendingFileSurfaceIds((current) => {
      if (current.has(surfaceId) === pending) {
        return current;
      }
      const next = new Set(current);
      if (pending) {
        next.add(surfaceId);
      } else {
        next.delete(surfaceId);
      }
      return next;
    });
  }, []);

  const activateFileSurface = useCallback((surfaceId: string) => {
    activateCodeAgentRightPanelSurface(roomId, surfaceId);
  }, [roomId]);

  const closePreviewSessionsForSurfaces = useCallback((
    surfaces: readonly CodeAgentRightPanelSurface[],
  ) => {
    const tabIds = new Set<string>();
    for (const surface of surfaces) {
      if (!isCodeAgentPreviewSurface(surface)) {
        continue;
      }
      tabIds.add(surface.previewSessionId ?? surface.id);
    }
    for (const tabId of tabIds) {
      void closeCodeWorkspacePreviewSession({ roomId, tabId }).catch(() => {
        // Closing the local surface should not be blocked by a stale cloud preview session.
      });
    }
  }, [roomId]);

  const closeFileSurface = useCallback((surfaceId: string) => {
    const surface = rightPanelSurfaces.find((entry) => entry.id === surfaceId);
    if (surface) {
      closePreviewSessionsForSurfaces([surface]);
    }
    closeCodeAgentRightPanelSurface(roomId, surfaceId);
  }, [closePreviewSessionsForSurfaces, rightPanelSurfaces, roomId]);

  const closeFileSurfaceAddMenu = useCallback(() => {
    setFileSurfaceAddMenuPosition(null);
  }, []);

  const handleFileSurfaceAddMenuToggle = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (fileSurfaceAddMenuOpen) {
      closeFileSurfaceAddMenu();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setFileSurfaceAddMenuPosition(clampFixedMenuPosition({
      x: rect.left,
      y: rect.bottom + 6,
      width: FILE_SURFACE_ADD_MENU_WIDTH,
      height: FILE_SURFACE_ADD_MENU_HEIGHT,
    }));
  }, [closeFileSurfaceAddMenu, fileSurfaceAddMenuOpen]);

  const openFilesSurface = useCallback(() => {
    closeFileSurfaceAddMenu();
    openCodeAgentRightPanel(roomId, 'files');
  }, [closeFileSurfaceAddMenu, roomId]);

  const openPreviewSurface = useCallback(() => {
    closeFileSurfaceAddMenu();
    pendingBrowserAddressFocusRef.current = true;
    addCodeAgentRightPanelPreviewSurface(roomId);
  }, [closeFileSurfaceAddMenu, roomId]);

  const openDiffSurface = useCallback(() => {
    closeFileSurfaceAddMenu();
    openCodeAgentRightPanel(roomId, 'diff');
  }, [closeFileSurfaceAddMenu, roomId]);

  const handleOpenWorkspaceFileFromDiff = useCallback((path: string) => {
    const target = parseWorkspaceFileOpenTarget(path, { workspaceRoot: workspaceRoot ?? undefined });
    if (!target) {
      return;
    }
    setSelectedPath(target.path);
    setPreviewPath(target.path);
    setExternallySelectedFilePath(target.path);
    if (isMobileSurface) {
      setMobileExplorerOpen(false);
    }
    openCodeAgentRightPanelFile(roomId, target.path, target.line);
    setLocalOpenFileRequest(null);
    setOperationError(null);
  }, [isMobileSurface, roomId, workspaceRoot]);

  const handleDiffFileSummariesChange = useCallback((summaries: readonly CodeAgentWorkspaceDiffFileSummary[]) => {
    setDiffFileSummaries({
      scopeKey: diffFileSummaryScopeKey,
      summaries,
    });
  }, [diffFileSummaryScopeKey]);

  const handleOpenChangedDiffFile = useCallback((path: string) => {
    const normalizedPath = normalizeWorkspacePath(path);
    if (!normalizedPath) {
      return;
    }
    selectCodeAgentDiffFile(roomId, normalizedPath);
  }, [roomId]);

  const handleOpenMobileChangedDiffFile = useCallback((path: string) => {
    handleOpenChangedDiffFile(path);
    setMobileDiffFileListOpen(false);
  }, [handleOpenChangedDiffFile]);

  const closeFileSurfaceTabMenu = useCallback(() => {
    setFileSurfaceTabMenu(null);
  }, []);

  const handleFileSurfaceTabContextMenu = useCallback((
    event: React.MouseEvent,
    surface: CodeAgentRightPanelSurface,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setFileSurfaceTabMenu({
      surfaceId: surface.id,
      ...clampFixedMenuPosition({
        x: event.clientX,
        y: event.clientY,
        width: FILE_SURFACE_TAB_MENU_WIDTH,
        height: FILE_SURFACE_TAB_MENU_HEIGHT,
      }),
    });
  }, []);

  const handleFileSurfaceTabMenuButtonClick = useCallback((
    event: React.MouseEvent<HTMLButtonElement>,
    surface: CodeAgentRightPanelSurface,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setFileSurfaceTabMenu({
      surfaceId: surface.id,
      ...clampFixedMenuPosition({
        x: rect.left,
        y: rect.bottom + 6,
        width: FILE_SURFACE_TAB_MENU_WIDTH,
        height: FILE_SURFACE_TAB_MENU_HEIGHT,
      }),
    });
  }, []);

  const handleFileSurfaceTabMouseDown = useCallback((event: React.MouseEvent) => {
    if (event.button !== 1) {
      return;
    }
    event.preventDefault();
  }, []);

  const handleFileSurfaceTabAuxClick = useCallback((
    event: React.MouseEvent,
    surface: CodeAgentRightPanelSurface,
  ) => {
    if (event.button !== 1) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    closeFileSurface(surface.id);
  }, [closeFileSurface]);

  const copyFileSurfacePath = useCallback((relativePath: string) => {
    closeFileSurfaceTabMenu();
    navigator.clipboard?.writeText?.(relativePath)?.catch(() => {
      // Clipboard access is best-effort; the tab action should not fail the UI.
    });
  }, [closeFileSurfaceTabMenu]);

  const closeOtherFileSurfaces = useCallback((surfaceId: string) => {
    closeFileSurfaceTabMenu();
    closePreviewSessionsForSurfaces(rightPanelSurfaces.filter((surface) => surface.id !== surfaceId));
    closeOtherCodeAgentRightPanelSurfaces(roomId, surfaceId);
  }, [closeFileSurfaceTabMenu, closePreviewSessionsForSurfaces, rightPanelSurfaces, roomId]);

  const closeFileSurfacesToRight = useCallback((surfaceId: string) => {
    closeFileSurfaceTabMenu();
    const surfaceIndex = rightPanelSurfaces.findIndex((surface) => surface.id === surfaceId);
    if (surfaceIndex >= 0) {
      closePreviewSessionsForSurfaces(rightPanelSurfaces.slice(surfaceIndex + 1));
    }
    closeCodeAgentRightPanelSurfacesToRight(roomId, surfaceId);
  }, [closeFileSurfaceTabMenu, closePreviewSessionsForSurfaces, rightPanelSurfaces, roomId]);

  const closeAllFileSurfaces = useCallback(() => {
    closeFileSurfaceTabMenu();
    closePreviewSessionsForSurfaces(rightPanelSurfaces);
    closeAllCodeAgentRightPanelSurfaces(roomId);
  }, [closeFileSurfaceTabMenu, closePreviewSessionsForSurfaces, rightPanelSurfaces, roomId]);

  useEffect(() => {
    if (!fileSurfaceTabMenu || fileSurfaceTabMenuSurface) {
      return undefined;
    }
    setFileSurfaceTabMenu(null);
    return undefined;
  }, [fileSurfaceTabMenu, fileSurfaceTabMenuSurface]);

  useEffect(() => {
    if (!fileSurfaceTabMenu) {
      return undefined;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && fileSurfaceTabMenuRef.current?.contains(target)) {
        return;
      }
      setFileSurfaceTabMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFileSurfaceTabMenu(null);
      }
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [fileSurfaceTabMenu]);

  useEffect(() => {
    if (!fileSurfaceAddMenuOpen) {
      return undefined;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node
        && (fileSurfaceAddMenuButtonRef.current?.contains(target) || fileSurfaceAddMenuRef.current?.contains(target))
      ) {
        return;
      }
      closeFileSurfaceAddMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeFileSurfaceAddMenu();
      }
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeFileSurfaceAddMenu, fileSurfaceAddMenuOpen]);

  const effectiveExplorerOpen = isMobileSurface ? mobileExplorerOpen : explorerOpen;
  const fileExplorerHasPreviewSibling = Boolean(relativePath && !isMobileSurface);
  const fileExplorer = effectiveExplorerOpen || relativePath === null ? (
    <aside
      className={`${fileExplorerHasPreviewSibling ? 'relative min-w-[160px] border-l border-[#dedbd0] dark:border-[#30302e]' : 'min-w-0 flex-1'} flex min-h-0 shrink-0 bg-[#faf9f5] dark:bg-[#1d1d1b]`}
      data-mobile-file-explorer={isMobileSurface ? 'true' : undefined}
      style={fileExplorerHasPreviewSibling ? {
        width: 'var(--workspace-file-explorer-width)',
        maxWidth: `calc(100% - ${FILE_PREVIEW_MIN_WIDTH}px)`,
      } : undefined}
    >
      {fileExplorerHasPreviewSibling ? (
        <button
          type="button"
          aria-label={t('codeAgentResizeFileExplorer')}
          className="group absolute inset-y-0 -left-4 z-40 w-8 cursor-col-resize touch-none focus-visible:outline-none"
          onPointerDown={handleExplorerResizeStart}
        >
          <span
            aria-hidden="true"
            data-code-agent-resize-highlight="file-explorer"
            className="pointer-events-none absolute inset-y-0 left-1/2 z-50 -ml-px w-0.5 -translate-x-1/2 rounded-full bg-transparent transition-colors duration-150 group-hover:bg-[#c96442] group-active:bg-[#c96442] group-focus-visible:bg-[#c96442]"
          />
        </button>
      ) : null}
      <CodeAgentWorkspaceFileTreePanel
        projectName={projectName}
        entries={entries}
        entryKinds={entryKinds}
        entriesPending={entriesQuery.isPending}
        entriesLoaded={entriesQuery.data !== null}
        entriesError={entriesQuery.error}
        entriesTruncated={Boolean(entriesQuery.data?.truncated)}
        selectedPath={selectedPath}
        resolvedTheme={resolvedTheme}
        onOpenEntry={handleOpenEntry}
        onRefresh={entriesQuery.refresh}
        onCreateFile={handleCreateFile}
        onCreateDirectory={handleCreateDirectory}
        onUpload={() => uploadInputRef.current?.click()}
        onRename={handleRename}
        onDelete={handleDelete}
        onSearchQueryChange={handleSearchQueryChange}
        remoteSearchPending={remoteSearch.isPending}
        remoteSearchError={remoteSearch.error}
        remoteSearchTruncated={remoteSearch.truncated}
        mobileLayout={isMobileSurface}
        onBackToPreview={isMobileSurface ? handleBackToMobileFilePreview : undefined}
      />
    </aside>
  ) : null;
  const showMobileDiffFileList = isMobileSurface && mobileDiffFileListOpen && changedFileEntries.length > 0;
  const changedFilesTreePanel = changedFileEntries.length > 0 ? (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]">
      <div
        className={`${isMobileSurface ? 'min-h-10 flex-wrap' : 'min-h-0'} flex shrink-0 items-center gap-2 border-b border-[#dedbd0] px-3 py-2 text-xs text-[#4d4c48] dark:border-[#30302e] dark:text-[#e8e6dc]`}
        data-testid="code-agent-changed-files-panel-header"
      >
        <span className="min-w-0 flex-1 truncate font-semibold">
          {t('codeAgentChangedFilesCount', { count: changedFileEntries.length })}
        </span>
        {hasNonZeroChangedFileStat(changedFileSummary) ? (
          <CodeAgentDiffStatLabel
            additions={changedFileSummary.additions}
            deletions={changedFileSummary.deletions}
            className="shrink-0 text-[11px]"
            layout="inline"
          />
        ) : null}
        {hasChangedFileDirectories ? (
          <button
            type="button"
            data-scroll-anchor-ignore
            className={`${isMobileSurface ? 'min-h-8 px-2.5' : 'px-2 py-1'} shrink-0 rounded-md border border-[#dedbd0] text-[11px] font-semibold text-[#5e5d59] transition-colors hover:bg-[#f0eee6] hover:text-[#141413] dark:border-[#30302e] dark:text-[#b0aea5] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]`}
            onClick={() => setCodeAgentChangedFilesExpanded(roomId, changedFilesExpansionScopeKey, !allChangedDirectoriesExpanded)}
          >
            {allChangedDirectoriesExpanded ? t('codeAgentCollapseChangedFileTree') : t('codeAgentExpandChangedFileTree')}
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <CodeAgentChangedFilesTree
          files={changedFileEntries}
          allDirectoriesExpanded={allChangedDirectoriesExpanded}
          resolvedTheme={resolvedTheme}
          selectedPath={selectedDiffFilePath}
          onOpenDiffFile={isMobileSurface ? handleOpenMobileChangedDiffFile : handleOpenChangedDiffFile}
          mobileLayout={isMobileSurface}
        />
      </div>
    </div>
  ) : null;

  return (
    <div
      ref={panelRef}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[#faf9f5] dark:bg-[#1d1d1b]"
      data-file-browser-panel={`${roomId}:workspace`}
      style={{
        ['--workspace-file-explorer-width' as string]: `${explorerWidth}px`,
        ['--workspace-diff-changed-files-width' as string]: `${diffChangedFilesWidth}px`,
      }}
    >
      {rightPanelSurfaces.length > 0 ? (
        <div
          ref={fileSurfaceTabListRef}
          className="h-8 shrink-0 overflow-x-auto border-b border-[#dedbd0] bg-[#f0eee6] px-2 text-xs dark:border-[#30302e] dark:bg-[#242422]"
          data-testid="code-agent-file-surface-tabs"
          role="tablist"
        >
          <div className="flex h-full w-max min-w-full items-center gap-1">
            {rightPanelSurfaces.map((surface) => {
              const isActive = surface.id === rightPanelState.activeSurfaceId;
              const title = surface.kind === 'diff'
                ? t('codeAgentChanges')
                : surface.kind === 'files'
                  ? t('codeAgentWorkspaceFiles')
                  : surface.kind === 'preview'
                    ? (surface.relativePath
                      ? basename(surface.relativePath)
                      : surface.url
                        ? formatBrowserSurfaceUrlTitle(surface.url)
                        : t('codeAgentBrowserSurface'))
                    : basename(surface.relativePath);
              const fullTitle = surface.kind === 'file'
                ? surface.relativePath
                : surface.kind === 'preview'
                  ? surface.relativePath ?? surface.url ?? title
                  : title;
              const pending = pendingFileSurfaceIds.has(surface.id);
              return (
                <div
                  key={surface.id}
                  data-active-tab={isActive}
                  className={`group flex max-w-56 shrink-0 items-center rounded-md border ${
                    isActive
                      ? 'border-[#c96442]/50 bg-[#faf9f5] text-[#141413] dark:border-[#ffb197]/50 dark:bg-[#1d1d1b] dark:text-[#faf9f5]'
                      : 'border-transparent text-[#5e5d59] hover:bg-[#faf9f5] hover:text-[#141413] dark:text-[#b0aea5] dark:hover:bg-[#1d1d1b] dark:hover:text-[#faf9f5]'
                  }`}
                  role="tab"
                  aria-selected={isActive}
                  onMouseDown={handleFileSurfaceTabMouseDown}
                  onAuxClick={(event) => handleFileSurfaceTabAuxClick(event, surface)}
                  onContextMenu={(event) => handleFileSurfaceTabContextMenu(event, surface)}
                >
                  <button
                    type="button"
                    className={`flex min-w-0 flex-1 items-center gap-1.5 truncate px-2 text-left ${isMobileSurface ? 'min-h-7 py-1.5' : 'py-1'}`}
                    title={fullTitle}
                    onClick={() => activateFileSurface(surface.id)}
                  >
                    {surface.kind === 'diff' ? (
                      <FileDiff className="h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]" />
                    ) : surface.kind === 'files' ? (
                      <Files className="h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]" />
                    ) : surface.kind === 'preview' ? (
                      <CodeAgentBrowserTabIcon url={surface.url} />
                    ) : surface.kind === 'file' ? (
                      <CodeAgentPierreEntryIcon
                        pathValue={surface.relativePath}
                        kind="file"
                        theme={resolvedTheme}
                        className="size-3.5"
                      />
                    ) : null}
                    <span className="truncate">{title}</span>
                  </button>
                  {isMobileSurface ? (
                    <button
                      type="button"
                      className="mr-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[#87867f] hover:bg-[#dedbd0] hover:text-[#141413] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]"
                      aria-label={`${t('moreActions')} ${fullTitle}`}
                      title={t('moreActions')}
                      data-testid="code-agent-mobile-file-tab-actions"
                      onClick={(event) => handleFileSurfaceTabMenuButtonClick(event, surface)}
                    >
                      <MoreVertical className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={`relative mr-0.5 inline-flex shrink-0 items-center justify-center rounded text-[#87867f] hover:bg-[#dedbd0] hover:text-[#141413] focus:opacity-100 dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5] ${
                      isMobileSurface ? 'h-6 w-6 p-1 opacity-100' : `h-4 w-4 p-0.5 ${pending ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`
                    }`}
                    aria-label={`${t('close')} ${fullTitle}`}
                    onClick={() => {
                      closeFileSurfaceTabMenu();
                      closeFileSurface(surface.id);
                    }}
                  >
                    {pending ? (
                      <>
                        <span
                          className="h-2 w-2 rounded-full bg-current group-hover:hidden"
                          data-testid="code-agent-file-tab-pending-indicator"
                          aria-hidden="true"
                        />
                        <X className="hidden h-3 w-3 group-hover:block" />
                      </>
                    ) : (
                      <X className="h-3 w-3" />
                    )}
                  </button>
                </div>
              );
            })}
            <div className="relative ml-0.5 shrink-0">
              <button
                ref={fileSurfaceAddMenuButtonRef}
                type="button"
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[#87867f] transition-colors hover:bg-[#faf9f5] hover:text-[#141413] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:text-[#8f8d86] dark:hover:bg-[#1d1d1b] dark:hover:text-[#faf9f5]"
                aria-label={t('codeAgentAddWorkspaceSurface')}
                aria-haspopup="menu"
                aria-expanded={fileSurfaceAddMenuOpen}
                title={t('codeAgentAddWorkspaceSurface')}
                onClick={handleFileSurfaceAddMenuToggle}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {fileSurfaceAddMenuOpen && fileSurfaceAddMenuPosition ? (
        <div
          ref={fileSurfaceAddMenuRef}
          className="fixed z-[90] min-w-40 rounded-md border border-[#dedbd0] bg-[#faf9f5] p-1 shadow-xl dark:border-[#30302e] dark:bg-[#1d1d1b]"
          data-testid="code-agent-file-surface-add-menu"
          role="menu"
          style={{ left: fileSurfaceAddMenuPosition.x, top: fileSurfaceAddMenuPosition.y }}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[#141413] hover:bg-[#f0eee6] dark:text-[#faf9f5] dark:hover:bg-[#30302e]"
            role="menuitem"
            onClick={openPreviewSurface}
          >
            <Globe2 className="h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]" />
            <span className="min-w-0 truncate">{t('codeAgentBrowserSurface')}</span>
          </button>
          <button
            type="button"
            className="flex w-full cursor-not-allowed items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[#141413] opacity-45 disabled:hover:bg-transparent dark:text-[#faf9f5] dark:disabled:hover:bg-transparent"
            role="menuitem"
            aria-disabled="true"
            title={t('codeAgentTerminalSurfaceUnavailable')}
            disabled
          >
            <TerminalSquare className="h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]" />
            <span className="min-w-0 truncate">{t('codeAgentTerminalSurface')}</span>
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[#141413] hover:bg-[#f0eee6] dark:text-[#faf9f5] dark:hover:bg-[#30302e]"
            role="menuitem"
            onClick={openFilesSurface}
          >
            <Files className="h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]" />
            <span className="min-w-0 truncate">{t('codeAgentWorkspaceFiles')}</span>
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[#141413] hover:bg-[#f0eee6] dark:text-[#faf9f5] dark:hover:bg-[#30302e]"
            role="menuitem"
            onClick={openDiffSurface}
          >
            <FileDiff className="h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]" />
            <span className="min-w-0 truncate">{t('codeAgentChanges')}</span>
          </button>
        </div>
      ) : null}
      {fileSurfaceTabMenu && fileSurfaceTabMenuSurface ? (() => {
        const surface = fileSurfaceTabMenuSurface;
        const surfaceIndex = rightPanelSurfaces.findIndex((entry) => entry.id === surface.id);
        const hasOtherSurfaces = rightPanelSurfaces.length > 1;
        const hasSurfacesToRight = surfaceIndex >= 0 && surfaceIndex < rightPanelSurfaces.length - 1;
        const disabledItemClassName = 'cursor-not-allowed opacity-40';
        const menuItemClassName = 'block w-full rounded px-2 py-1.5 text-left text-xs text-[#141413] hover:bg-[#f0eee6] disabled:hover:bg-transparent dark:text-[#faf9f5] dark:hover:bg-[#30302e]';
        return (
          <div
            ref={fileSurfaceTabMenuRef}
            className="fixed z-[90] min-w-40 rounded-md border border-[#dedbd0] bg-[#faf9f5] p-1 shadow-xl dark:border-[#30302e] dark:bg-[#1d1d1b]"
            data-testid="code-agent-file-surface-menu"
            role="menu"
            style={{ left: fileSurfaceTabMenu.x, top: fileSurfaceTabMenu.y }}
          >
            {surface.kind === 'file' ? (
              <button
                type="button"
                className={menuItemClassName}
                role="menuitem"
                onClick={() => copyFileSurfacePath(surface.relativePath)}
              >
                {t('codeAgentCopyFilePath')}
              </button>
            ) : null}
            <button
              type="button"
              className={menuItemClassName}
              role="menuitem"
              onClick={() => {
                closeFileSurfaceTabMenu();
                closeFileSurface(surface.id);
              }}
            >
              {t('codeAgentCloseFileTab')}
            </button>
            <button
              type="button"
              className={`${menuItemClassName} ${hasOtherSurfaces ? '' : disabledItemClassName}`}
              role="menuitem"
              disabled={!hasOtherSurfaces}
              onClick={() => closeOtherFileSurfaces(surface.id)}
            >
              {t('codeAgentCloseOtherFileTabs')}
            </button>
            <button
              type="button"
              className={`${menuItemClassName} ${hasSurfacesToRight ? '' : disabledItemClassName}`}
              role="menuitem"
              disabled={!hasSurfacesToRight}
              onClick={() => closeFileSurfacesToRight(surface.id)}
            >
              {t('codeAgentCloseFileTabsToRight')}
            </button>
            <button
              type="button"
              className={menuItemClassName}
              role="menuitem"
              onClick={closeAllFileSurfaces}
            >
              {t('codeAgentCloseAllFileTabs')}
            </button>
          </div>
        );
      })() : null}
      {rightPanelSurfaces.length === 0 ? (
        <CodeAgentRightPanelEmptyState
          onAddBrowser={openPreviewSurface}
          onAddFiles={openFilesSurface}
          onAddDiff={openDiffSurface}
        />
      ) : activePreviewSurface ? (
        <CodeAgentPreviewSurface
          roomId={roomId}
          surface={activePreviewSurface}
          mobileLayout={isMobileSurface}
          assetUrlQuery={previewSurfaceAssetUrlQuery}
          assetPreviewRevision={activePreviewSurfaceRevision}
          focusUrlNonce={browserAddressFocusRequests[activePreviewSurface.id]}
          recentTargets={recentPreviewTargets}
          workspaceRoot={workspaceRoot}
          onNavigate={handleNavigatePreviewSurface}
          onNavigateHistory={handleNavigatePreviewHistory}
          onRefreshWorkspacePreview={handleAssetPreviewChanged}
          onRecordingArtifactSaved={handlePreviewRecordingArtifactSaved}
          onOpenWorkspaceFile={handleOpenWorkspaceFileFromPreviewSurface}
          onAddPreviewAnnotation={onAddPreviewAnnotation}
          onRenderedViewportChange={handlePreviewRenderedViewportChange}
          waitForRenderedViewport={waitForPreviewRenderedViewport}
        />
      ) : activeDiffSurface ? (
        <div
          ref={diffSurfaceRef}
          className={`${isMobileSurface ? 'flex-col' : ''} flex min-h-0 flex-1 gap-2 overflow-hidden p-2`}
          data-testid="code-agent-diff-surface-body"
          data-mobile-layout={isMobileSurface ? 'true' : undefined}
          data-mobile-view={isMobileSurface ? (showMobileDiffFileList ? 'files' : 'diff') : undefined}
        >
          {showMobileDiffFileList ? (
            <div className="flex shrink-0 items-center gap-2 rounded-md border border-[#dedbd0] bg-[#faf9f5] px-2 py-1.5 text-xs text-[#4d4c48] dark:border-[#30302e] dark:bg-[#1d1d1b] dark:text-[#e8e6dc]">
              <button
                type="button"
                className="inline-flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1 text-left font-semibold text-[#141413] transition-colors hover:bg-[#f0eee6] dark:text-[#faf9f5] dark:hover:bg-[#30302e]"
                data-testid="code-agent-mobile-diff-files-toggle"
                aria-pressed={showMobileDiffFileList}
                onClick={() => setMobileDiffFileListOpen((open) => !open)}
              >
                {showMobileDiffFileList ? (
                  <FileDiff className="h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]" />
                ) : (
                  <Files className="h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]" />
                )}
                <span className="min-w-0 truncate">
                  {showMobileDiffFileList ? t('codeAgentChanges') : t('codeAgentChangedFiles')}
                </span>
              </button>
            </div>
          ) : null}
          {!isMobileSurface && changedFileEntries.length > 0 ? (
            <aside
              className="relative flex min-h-0 min-w-[180px] shrink-0"
              data-testid="code-agent-diff-changed-files-sidebar"
              style={{
                width: 'var(--workspace-diff-changed-files-width)',
                maxWidth: `calc(100% - ${DIFF_VIEWER_MIN_WIDTH}px)`,
              }}
            >
              {changedFilesTreePanel}
              <button
                type="button"
                aria-label={t('codeAgentResizeChangedFiles')}
                className="group absolute inset-y-0 -right-4 z-40 w-8 cursor-col-resize touch-none focus-visible:outline-none"
                onPointerDown={handleDiffChangedFilesResizeStart}
              >
                <span
                  aria-hidden="true"
                  data-code-agent-resize-highlight="diff-changed-files"
                  className="pointer-events-none absolute inset-y-0 left-1/2 z-50 -ml-px w-0.5 -translate-x-1/2 rounded-full bg-transparent transition-colors duration-150 group-hover:bg-[#c96442] group-active:bg-[#c96442] group-focus-visible:bg-[#c96442]"
                />
              </button>
            </aside>
          ) : null}
          {showMobileDiffFileList ? (
            <section
              className="flex min-h-0 min-w-0 flex-1"
              data-testid="code-agent-mobile-diff-changed-files-panel"
            >
              {changedFilesTreePanel}
            </section>
          ) : (
            <CodeAgentWorkspaceDiffViewer
              roomId={roomId}
              enabled
              refreshKey={workspaceReadyKey}
              onOpenFile={handleOpenWorkspaceFileFromDiff}
              onFileSummariesChange={handleDiffFileSummariesChange}
              selectedFilePath={selectedDiffFilePath}
              selectedFileRevealRequestId={selectedDiffFileRequestId}
              reviewComments={reviewComments}
              onAddReviewComment={onAddReviewComment}
              onRemoveReviewComment={onRemoveReviewComment}
              mobileLayout={isMobileSurface}
              onOpenChangedFiles={isMobileSurface && changedFileEntries.length > 0 ? () => setMobileDiffFileListOpen(true) : undefined}
            />
          )}
        </div>
      ) : (
        <CodeAgentFilePreviewPanel
          roomId={roomId}
          workspaceScopeKey={workspaceReadyKey}
          projectName={projectName}
          workspaceRoot={workspaceRoot}
          relativePath={relativePath}
          file={fileQuery.data}
          fileError={fileQuery.error}
          filePending={fileQuery.isPending}
          onFileChange={fileQuery.setData}
          assetPreviewError={assetUrlQuery.error}
          assetPreviewPending={assetUrlQuery.isPending}
          assetPreviewResolvedUrl={assetUrlQuery.resolvedUrl}
          assetPreviewRevision={activeAssetPreviewRevision}
          resolvedTheme={resolvedTheme}
          renderPreview={renderPreview}
          wordWrap={wordWrap}
          revealLine={effectiveRevealLine}
          revealRequestId={effectiveRevealRequestId}
          saveState={activeSaveState}
          saveError={activeSaveError}
          mobileLayout={isMobileSurface}
          explorerOpen={effectiveExplorerOpen}
          explorer={fileExplorer}
          browserPreviewPending={browserPreviewPending}
          externalPreviewUrl={isMobileSurface && canOpenInBrowserPreview ? assetUrlQuery.resolvedUrl : undefined}
          externalPreviewPending={isMobileSurface && canOpenInBrowserPreview ? assetUrlQuery.isPending : false}
          canToggleFileWordWrap={canToggleFileWordWrap}
          canOpenInBrowserPreview={canOpenInBrowserPreview}
          supportsPreview={supportsPreview}
          refreshCurrentFilePending={refreshCurrentFilePending}
          onRefreshCurrentFile={handleRefreshCurrentFile}
          onToggleWordWrap={toggleWordWrap}
          onOpenInBrowserPreview={handleOpenInBrowserPreview}
          onTogglePreviewView={togglePreviewView}
          onToggleExplorer={toggleExplorer}
          onSaveStateChange={handleSaveStateChange}
          onFileSavePendingChange={onFileSavePendingChange}
          onEntriesChanged={refreshAfterFileContentsChanged}
          onAssetPreviewChanged={handleAssetPreviewChanged}
          onOpenWorkspaceFile={handleOpenWorkspaceFileFromMarkdown}
          onOpenWorkspaceFileInBrowserPreview={openBrowserPreviewPath}
          reviewComments={reviewComments}
          onAddReviewComment={onAddReviewComment}
          onRemoveReviewComment={onRemoveReviewComment}
        />
      )}
      {operationError ? (
        <div className="border-t border-[#dedbd0] px-3 py-2 text-[11px] text-[#9f462c] dark:border-[#30302e] dark:text-[#ff9b78]">
          {operationError}
        </div>
      ) : null}
      <input ref={uploadInputRef} type="file" className="hidden" multiple onChange={handleUpload} />
    </div>
  );
};
