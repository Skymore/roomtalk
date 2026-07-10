import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  FileDiff,
  FileWarning,
  Files,
  Globe2,
  LoaderCircle,
  Minus,
  MoreVertical,
  Plus,
  RadioTower,
  RefreshCw,
  RotateCcw,
  TerminalSquare,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  createCodeWorkspaceDirectory,
  deleteCodeWorkspaceEntry,
  loadCodeWorkspaceEntries,
  loadCodeWorkspaceFile,
  renameCodeWorkspaceEntry,
  resolveCodeWorkspaceAssetUrl,
  resolveCodeWorkspaceFilePreview,
  searchCodeWorkspaceEntries,
  writeCodeWorkspaceFile,
  type CodeWorkspaceEntry,
  type CodeWorkspaceFile,
  type CodeWorkspaceFilePreview,
} from '../utils/codeWorkspaceFiles';
import { appendWorkspaceAssetPreviewRevision } from '../utils/codeWorkspaceFilePreview';
import type { CodeAgentWorkspaceSnapshot } from '../utils/codeAgentWorkspace';
import type { RoomSandboxStatus } from '../utils/types';
import { codeAgentFaviconUrlForOrigin } from '../utils/codeAgentFavicon';
import { beginHorizontalResize } from '../utils/horizontalResize';
import { normalizeWorkspaceOpenPath, parseWorkspaceFileOpenTarget } from '../utils/workspaceFileOpenTarget';
import { type ReviewCommentContext } from '../utils/codeAgentReviewComments';
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
  listCodeWorkspacePreviewServers,
  mergeCodeWorkspacePreviewServers,
  previewPortTargetFromLocalUrl,
  type CodeWorkspacePreviewServer,
  type PreviewableCodeWorkspacePreviewServer,
} from '../utils/codeWorkspacePreviewServers';
import {
  closeCodeWorkspaceTerminalSession,
} from '../utils/codeWorkspaceTerminalSessions';
import {
  FILL_CODE_AGENT_PREVIEW_VIEWPORT,
  type CodeAgentPreviewViewportSetting,
} from '../utils/codeAgentPreviewViewport';
import {
  resolveResponsiveCodeAgentBrowserViewportSize,
} from '../utils/codeAgentBrowserViewportLayout';
import { CodeAgentTerminalSurface } from './CodeAgentTerminalSurface';

interface CodeAgentFileBrowserPanelProps {
  roomId: string;
  projectName: string;
  surface?: 'desktop' | 'mobile';
  sandboxStatus?: RoomSandboxStatus;
  sandboxUpdatedAt?: string;
  workspaceRoot?: string | null;
  workspaceChanges?: CodeAgentWorkspaceSnapshot['changes'] | null;
  workspaceEditable?: boolean;
  openFileRequest?: { path: string; requestId: number } | null;
  revealLine?: number | null;
  revealRequestId?: number;
  reviewComments?: readonly ReviewCommentContext[];
  onAddReviewComment?: (comment: ReviewCommentContext) => void;
  onRemoveReviewComment?: (commentId: string) => void;
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
  data: CodeWorkspaceFilePreview | null;
  resolvedUrl: string | null;
  error: string | null;
  isPending: boolean;
  refresh: () => void;
  startDevServer: () => void;
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
  onAddTerminal: () => void;
  onAddFiles: () => void;
  onAddDiff: () => void;
}

type CodeAgentPreviewPanelSurface = Extract<CodeAgentRightPanelSurface, { kind: 'preview' }>;
type CodeAgentTerminalPanelSurface = Extract<CodeAgentRightPanelSurface, { kind: 'terminal' }>;

function isCodeAgentPreviewSurface(
  surface: CodeAgentRightPanelSurface,
): surface is CodeAgentPreviewPanelSurface {
  return surface.kind === 'preview';
}

function isCodeAgentTerminalSurface(
  surface: CodeAgentRightPanelSurface,
): surface is CodeAgentTerminalPanelSurface {
  return surface.kind === 'terminal';
}

function previewSessionTabIdFromSurface(surface: CodeAgentPreviewPanelSurface): string {
  return surface.previewSessionId ?? surface.id;
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
        className="h-3.5 w-3.5 shrink-0 text-[#5e5d59] dark:text-[#8f8d86]"
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
  zoomFactor,
  deviceToolbarVisible,
  onHardReload,
  onToggleDeviceToolbar,
  onZoomIn,
  onZoomOut,
  onResetZoom,
}: {
  canRefresh: boolean;
  canZoom: boolean;
  canToggleDeviceToolbar: boolean;
  zoomFactor: number;
  deviceToolbarVisible: boolean;
  onHardReload: () => void;
  onToggleDeviceToolbar: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
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
    const menuHeight = 176;
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
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#5e5d59] transition-colors hover:bg-[#f0eee6] hover:text-[#141413] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]"
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
            <RefreshCw className="h-3.5 w-3.5 shrink-0 text-[#5e5d59] dark:text-[#8f8d86]" />
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
            <Globe2 className="h-3.5 w-3.5 shrink-0 text-[#5e5d59] dark:text-[#8f8d86]" />
            <span className="min-w-0 truncate">
              {deviceToolbarVisible
                ? t('codeAgentBrowserHideDeviceToolbar')
                : t('codeAgentBrowserShowDeviceToolbar')}
            </span>
          </button>
          <div className="my-1 h-px bg-[#dedbd0] dark:bg-[#30302e]" />
          <div
            className={`flex items-center justify-between gap-3 rounded px-2 py-1.5 text-xs ${
              canZoom ? 'text-[#141413] dark:text-[#faf9f5]' : 'text-[#5e5d59] opacity-60 dark:text-[#8f8d86]'
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
              <span className="min-w-12 text-center text-[11px] tabular-nums text-[#5e5d59] dark:text-[#8f8d86]">
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
        </div>
      ) : null}
    </>
  );
}

function CodeAgentRightPanelEmptyState({
  onAddBrowser,
  onAddTerminal,
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
      disabledReason: null,
      icon: TerminalSquare,
      onClick: onAddTerminal,
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
          <p className="mt-1 text-xs text-[#5e5d59] dark:text-[#8f8d86]">
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
                <span className="mt-1 text-xs leading-relaxed text-[#5e5d59] dark:text-[#8f8d86]">
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
}

interface CodeAgentBrowserSurfaceChromeProps {
  value: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  canRefresh: boolean;
  canOpenExternal: boolean;
  canZoom: boolean;
  canToggleDeviceToolbar: boolean;
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
  onHardReload: () => void;
  onToggleDeviceToolbar: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
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
        <FileWarning className="mb-6 h-12 w-12 text-[#5e5d59] dark:text-[#8f8d86]" />
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

        <div className="mt-8 text-xs uppercase tracking-wide text-[#5e5d59] dark:text-[#8f8d86]">
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
            className="inline-flex h-8 items-center rounded-md bg-secondary px-3 text-xs font-semibold text-secondary-foreground transition-colors hover:bg-[#94462f] dark:hover:bg-[#ffb197]"
            onClick={onReload}
          >
            {t('codeAgentBrowserUnreachableReload')}
          </button>
        </div>
      </div>
    </div>
  );
}

function CodeAgentDevServerPreviewPending({
  preview,
  onStart,
}: {
  preview: Extract<CodeWorkspaceFilePreview, { kind: 'dev-server' }>;
  onStart: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-white px-6 py-8 dark:bg-[#141413]"
      data-testid="code-agent-dev-server-preview-pending"
    >
      <div className="flex w-full max-w-xl flex-col items-start gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md border border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]">
            <TerminalSquare className="h-4 w-4 text-[#5e5d59] dark:text-[#b0aea5]" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-[#141413] dark:text-[#faf9f5]">
              {t('codeAgentPreparingBrowserPreview')}
            </div>
            <div className="mt-0.5 truncate text-xs text-[#5e5d59] dark:text-[#8f8d86]">
              {preview.frameworkName} - {preview.requestedUrl}
            </div>
          </div>
        </div>
        <code className="block w-full overflow-x-auto rounded-md border border-[#dedbd0] bg-[#f5f4ed] px-3 py-2 text-xs text-[#4d4c48] dark:border-[#30302e] dark:bg-[#1d1d1b] dark:text-[#d7d4ca]">
          {preview.command}
        </code>
        <button
          type="button"
          className="inline-flex h-8 items-center rounded-md border border-[#dedbd0] px-3 text-xs font-medium text-[#4d4c48] transition-colors hover:bg-[#f0eee6] hover:text-[#141413] dark:border-[#30302e] dark:text-[#b0aea5] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]"
          onClick={onStart}
        >
          {preview.status === 'starting' ? t('refresh') : t('codeAgentStartPreview')}
        </button>
      </div>
    </div>
  );
}

function CodeAgentBrowserSurfaceChrome({
  value,
  loading,
  canGoBack,
  canGoForward,
  canRefresh,
  canOpenExternal,
  canZoom,
  canToggleDeviceToolbar,
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
  onHardReload,
  onToggleDeviceToolbar,
  onZoomIn,
  onZoomOut,
  onResetZoom,
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
  const browserChromeButtonClass = 'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#5e5d59] transition-colors hover:bg-[#f0eee6] hover:text-[#141413] disabled:cursor-not-allowed disabled:opacity-45 dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]';
  const addressInput = (
    <input
      ref={inputRef}
      aria-label={t('codeAgentBrowserAddressLabel')}
      className="h-7 min-w-0 flex-1 rounded-md border border-transparent bg-[#f0eee6] px-2 text-xs text-[#141413] outline-none transition-colors placeholder:text-[#5e5d59] focus:border-[#c96442]/70 focus:bg-[#faf9f5] dark:bg-[#242422] dark:text-[#faf9f5] dark:placeholder:text-[#8f8d86] dark:focus:border-[#d97757]/70 dark:focus:bg-[#1d1d1b]"
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
  const moreMenu = (
    <CodeAgentBrowserMoreMenu
      canRefresh={canRefresh}
      canZoom={canZoom}
      canToggleDeviceToolbar={canToggleDeviceToolbar}
      zoomFactor={zoomFactor}
      deviceToolbarVisible={deviceToolbarVisible}
      onHardReload={onHardReload}
      onToggleDeviceToolbar={onToggleDeviceToolbar}
      onZoomIn={onZoomIn}
      onZoomOut={onZoomOut}
      onResetZoom={onResetZoom}
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
  const [previewViewportContainerSize, setPreviewViewportContainerSize] = useState({ width: 1024, height: 768 });
  const zoomFactor = surface.zoomFactor ?? 1;
  const viewport = surface.viewport ?? FILL_CODE_AGENT_PREVIEW_VIEWPORT;
  const viewportRef = useRef(viewport);
  const currentAddress = previewUrl ?? relativePath ?? '';
  const resolvedWorkspacePreviewUrl = relativePath && assetUrlQuery.resolvedUrl && assetUrlQuery.data?.kind === 'static-file'
    ? appendWorkspaceAssetPreviewRevision(assetUrlQuery.resolvedUrl, assetPreviewRevision)
    : assetUrlQuery.resolvedUrl;
  const resolvedPreviewUrl = previewUrl ?? resolvedWorkspacePreviewUrl;
  const devServerPreview = assetUrlQuery.data?.kind === 'dev-server' ? assetUrlQuery.data : null;
  const canRefreshPreview = Boolean(resolvedPreviewUrl || relativePath || isBrowserEmptyPreview);
  const browserChromeLoading = assetUrlQuery.isPending || (Boolean(resolvedPreviewUrl) && browserFrameLoading);
  const { canGoBack, canGoForward } = getCodeAgentPreviewSurfaceNavigationState(surface);
  const previewSessionTabId = surface.previewSessionId ?? surface.id;

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

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

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
      assetUrlQuery.refresh();
      onRefreshWorkspacePreview(relativePath);
    }
    setBrowserReloadNonce((current) => current + 1);
  }, [assetUrlQuery, isBrowserEmptyPreview, onRefreshWorkspacePreview, previewSessionTabId, relativePath, roomId]);

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

  const updateViewport = useCallback(async (nextViewport: CodeAgentPreviewViewportSetting) => {
    const session = await resizeCodeWorkspacePreviewSession({
      roomId,
      tabId: previewSessionTabId,
      viewport: nextViewport,
    });
    setCodeAgentRightPanelPreviewViewport(roomId, session.tabId, session.viewport);
    return session;
  }, [previewSessionTabId, roomId]);

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
    } else {
      setBrowserLoadFailure(null);
    }
    void reportCodeWorkspacePreviewSession({
      roomId,
      tabId: previewSessionTabId,
      navStatus,
      ...(status._tag === 'Success' && status.renderedViewport
        ? { renderedViewport: status.renderedViewport }
        : {}),
    }).catch(() => undefined);
  }, [previewSessionTabId, relativePath, resolvedPreviewUrl, roomId, previewUrl]);

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

  const chrome = (
    <CodeAgentBrowserSurfaceChrome
      value={currentAddress}
      loading={browserChromeLoading}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      canRefresh={canRefreshPreview}
      canOpenExternal={Boolean(resolvedPreviewUrl)}
      canZoom={browserFrameAvailable}
      canToggleDeviceToolbar={browserFrameAvailable}
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
      onHardReload={handleRefresh}
      onToggleDeviceToolbar={handleToggleDeviceToolbar}
      onZoomIn={handleZoomIn}
      onZoomOut={handleZoomOut}
      onResetZoom={handleResetZoom}
    />
  );

  if (isBrowserEmptyPreview) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-[#faf9f5] dark:bg-[#1d1d1b]">
        {chrome}
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
                        <TerminalSquare className="h-4 w-4 shrink-0 text-[#5e5d59] dark:text-[#8f8d86]" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium text-[#141413] dark:text-[#faf9f5]">
                            {label}
                          </span>
                          <span className="block truncate text-[11px] text-[#5e5d59] dark:text-[#8f8d86]">
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
                <p className="mt-2 px-1 text-xs leading-relaxed text-[#5e5d59] dark:text-[#8f8d86]">
                  {t('codeAgentWorkspacePreviewServersHint')}
                </p>
              </div>
            ) : (
              <>
                <Globe2 className="h-5 w-5 text-[#5e5d59] dark:text-[#8f8d86]" />
                <div className="text-sm font-medium text-[#141413] dark:text-[#faf9f5]">
                  {t('codeAgentNoPreviewLoaded')}
                </div>
                <div className="max-w-sm text-xs leading-relaxed text-[#5e5d59] dark:text-[#8f8d86]">
                  {t('codeAgentBrowserSurfaceDescription')}
                </div>
              </>
            )}
            {workspacePreviewServersPending ? (
              <div className="flex items-center gap-2 text-xs text-[#5e5d59] dark:text-[#8f8d86]">
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
                      <Globe2 className="h-3.5 w-3.5 shrink-0 text-[#5e5d59] dark:text-[#8f8d86]" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-[#141413] dark:text-[#faf9f5]">
                          {title}
                        </span>
                        <span className="block truncate text-[11px] text-[#5e5d59] dark:text-[#8f8d86]">
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
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-[#9f462c] dark:text-[#ff9b78]">
          {assetUrlQuery.error}
        </div>
      </div>
    );
  }

  if (relativePath && (assetUrlQuery.isPending || (!assetUrlQuery.data && !assetUrlQuery.resolvedUrl))) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-[#faf9f5] dark:bg-[#1d1d1b]">
        {chrome}
        <div
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-[#5e5d59] dark:text-[#8f8d86]"
          role="status"
          aria-label={t('codeAgentPreparingBrowserPreview')}
        >
          <LoaderCircle className="h-5 w-5 animate-spin" />
          <div className="text-sm">{t('codeAgentPreparingBrowserPreview')}</div>
        </div>
      </div>
    );
  }

  if (devServerPreview && !resolvedPreviewUrl) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-[#faf9f5] dark:bg-[#1d1d1b]">
        {chrome}
        <CodeAgentDevServerPreviewPending
          preview={devServerPreview}
          onStart={assetUrlQuery.startDevServer}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#faf9f5] dark:bg-[#1d1d1b]">
      {chrome}
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
              onViewportChange={updateViewport}
              onViewportContainerSizeChange={setPreviewViewportContainerSize}
              onPreviewStatusChange={handlePreviewStatusChange}
              onLoadingChange={setBrowserFrameLoading}
            />
          )}
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
  const [data, setData] = useState<CodeWorkspaceFilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const refresh = useCallback((options: { startDevServer?: boolean } = {}) => {
    if (!relativePath || !enabled) {
      setData(null);
      setError(null);
      setIsPending(false);
      return () => undefined;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const controller = new AbortController();
    setData(null);
    setError(null);
    setIsPending(true);

    resolveCodeWorkspaceFilePreview(roomId, relativePath, {
      signal: controller.signal,
      startDevServer: options.startDevServer,
    }).then(
      (preview) => {
        if (controller.signal.aborted || requestIdRef.current !== requestId) {
          return;
        }
        setData(preview);
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
  }, [enabled, roomId, relativePath]);

  useEffect(() => {
    return refresh();
  }, [refresh, scopeKey]);

  return {
    data,
    resolvedUrl: data?.kind === 'static-file'
      ? resolveCodeWorkspaceAssetUrl(data.asset)
      : data?.kind === 'dev-server'
        ? data.resolvedUrl ?? null
        : null,
    error,
    isPending,
    refresh: () => {
      refresh();
    },
    startDevServer: () => {
      refresh({ startDevServer: true });
    },
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
  workspaceEditable = true,
  openFileRequest = null,
  revealLine = null,
  revealRequestId = 0,
  reviewComments = [],
  onAddReviewComment,
  onRemoveReviewComment,
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
  const [fileSurfaceTabScrollState, setFileSurfaceTabScrollState] = useState({
    canScrollStart: false,
    canScrollEnd: false,
  });
  const [fileSurfaceAddMenuPosition, setFileSurfaceAddMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const fileSurfaceAddMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const fileSurfaceAddMenuRef = useRef<HTMLDivElement | null>(null);
  const fileSurfaceAddMenuOpen = fileSurfaceAddMenuPosition !== null;
  const pendingBrowserAddressFocusRef = useRef(false);
  const previewSessionsRef = useRef<CodeWorkspacePreviewSession[]>([]);
  const [browserAddressFocusRequests, setBrowserAddressFocusRequests] = useState<Record<string, number>>({});
  const didInitializeRightPanelRef = useRef(false);
  const isMobileSurface = surface === 'mobile';

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
  const activeTerminalSurface = useMemo(
    () => rightPanelSurfaces.find((surface): surface is CodeAgentTerminalPanelSurface => (
      surface.id === rightPanelState.activeSurfaceId && isCodeAgentTerminalSurface(surface)
    )) ?? null,
    [rightPanelState.activeSurfaceId, rightPanelSurfaces],
  );

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
                tabId: previewSessionTabIdFromSurface(surface),
                url: surface.url,
                title: surface.url,
                viewport: surface.viewport ?? FILL_CODE_AGENT_PREVIEW_VIEWPORT,
              }).catch(() => null)
            )))).filter((session): session is CodeWorkspacePreviewSession => session !== null);
            if (disposed) {
              return;
            }
            if (recoveredSessions.length > 0) {
              previewSessionsRef.current = recoveredSessions;
              reconcileCodeAgentPreviewSessionSurfaces(roomId, recoveredSessions);
              return;
            }
          }
        }
        previewSessionsRef.current = sessions;
        reconcileCodeAgentPreviewSessionSurfaces(roomId, sessions);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [roomId]);

  useEffect(() => subscribeCodeWorkspacePreviewEvents(roomId, (event) => {
    if (event.snapshot) {
      previewSessionsRef.current = [
        event.snapshot,
        ...previewSessionsRef.current.filter((session) => session.tabId !== event.snapshot?.tabId),
      ];
      reconcileCodeAgentPreviewSessionSurfaces(roomId, [event.snapshot]);
      setCodeAgentRightPanelPreviewViewport(roomId, event.snapshot.tabId, event.snapshot.viewport);
      return;
    }
    if (event.type === 'closed') {
      previewSessionsRef.current = previewSessionsRef.current.filter(
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

  const updateFileSurfaceTabScrollState = useCallback(() => {
    const element = fileSurfaceTabListRef.current;
    if (!element) {
      setFileSurfaceTabScrollState((current) => (
        current.canScrollStart || current.canScrollEnd
          ? { canScrollStart: false, canScrollEnd: false }
          : current
      ));
      return;
    }
    const next = {
      canScrollStart: element.scrollLeft > 1,
      canScrollEnd: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
    };
    setFileSurfaceTabScrollState((current) => (
      current.canScrollStart === next.canScrollStart && current.canScrollEnd === next.canScrollEnd
        ? current
        : next
    ));
  }, []);

  useEffect(() => {
    if (rightPanelSurfaces.length === 0) {
      setFileSurfaceTabScrollState((current) => (
        current.canScrollStart || current.canScrollEnd
          ? { canScrollStart: false, canScrollEnd: false }
          : current
      ));
      return undefined;
    }
    const element = fileSurfaceTabListRef.current;
    if (!element) {
      return undefined;
    }
    updateFileSurfaceTabScrollState();
    element.addEventListener('scroll', updateFileSurfaceTabScrollState, { passive: true });
    window.addEventListener('resize', updateFileSurfaceTabScrollState);
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updateFileSurfaceTabScrollState);
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', updateFileSurfaceTabScrollState);
      window.removeEventListener('resize', updateFileSurfaceTabScrollState);
      observer?.disconnect();
    };
  }, [rightPanelSurfaces.length, updateFileSurfaceTabScrollState]);

  useEffect(() => {
    updateFileSurfaceTabScrollState();
  });

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
    if (!workspaceEditable) return;
    const path = window.prompt(t('codeAgentNewFilePrompt'), joinWorkspacePath(selectedDirectory, 'untitled.txt'));
    const normalizedPath = path ? normalizeWorkspacePath(path) : '';
    if (!normalizedPath) return;
    void mutate(() => writeCodeWorkspaceFile(roomId, normalizedPath, '', 'utf-8'), normalizedPath, normalizedPath);
  }, [mutate, roomId, selectedDirectory, t, workspaceEditable]);

  const handleCreateDirectory = useCallback(() => {
    if (!workspaceEditable) return;
    const path = window.prompt(t('codeAgentNewFolderPrompt'), joinWorkspacePath(selectedDirectory, 'new-folder'));
    const normalizedPath = path ? normalizeWorkspacePath(path) : '';
    if (!normalizedPath) return;
    void mutate(() => createCodeWorkspaceDirectory(roomId, normalizedPath), normalizedPath);
  }, [mutate, roomId, selectedDirectory, t, workspaceEditable]);

  const handleRename = useCallback(() => {
    if (!workspaceEditable) return;
    if (!selectedPath) return;
    const path = window.prompt(t('codeAgentRenamePrompt'), selectedPath);
    const normalizedPath = path ? normalizeWorkspacePath(path) : '';
    if (!normalizedPath || normalizedPath === selectedPath) return;
    const nextPreviewPath = relativePath && pathContains(selectedPath, relativePath)
      ? replacePathPrefix(relativePath, selectedPath, normalizedPath)
      : undefined;
    void mutate(() => renameCodeWorkspaceEntry(roomId, selectedPath, normalizedPath), normalizedPath, nextPreviewPath);
  }, [mutate, relativePath, roomId, selectedPath, t, workspaceEditable]);

  const handleDelete = useCallback(() => {
    if (!workspaceEditable) return;
    if (!selectedPath) return;
    if (!window.confirm(t('codeAgentDeleteConfirm', { path: selectedPath }))) return;
    const nextPreviewPath = relativePath && pathContains(selectedPath, relativePath) ? null : undefined;
    void mutate(() => deleteCodeWorkspaceEntry(roomId, selectedPath), null, nextPreviewPath);
  }, [mutate, relativePath, roomId, selectedPath, t, workspaceEditable]);

  const handleUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    if (!workspaceEditable) {
      event.target.value = '';
      return;
    }
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
  }, [mutate, roomId, selectedDirectory, workspaceEditable]);

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

  const closeTerminalSessionsForSurfaces = useCallback((
    surfaces: readonly CodeAgentRightPanelSurface[],
  ) => {
    const terminalIds = new Set<string>();
    for (const surface of surfaces) {
      if (surface.kind !== 'terminal') {
        continue;
      }
      terminalIds.add(surface.terminalId);
    }
    for (const terminalId of terminalIds) {
      void closeCodeWorkspaceTerminalSession({ roomId, terminalId }).catch(() => {
        // Closing the local surface should not be blocked by a stale cloud terminal session.
      });
    }
  }, [roomId]);

  const closeFileSurface = useCallback((surfaceId: string) => {
    const surface = rightPanelSurfaces.find((entry) => entry.id === surfaceId);
    if (surface) {
      closePreviewSessionsForSurfaces([surface]);
      closeTerminalSessionsForSurfaces([surface]);
    }
    closeCodeAgentRightPanelSurface(roomId, surfaceId);
  }, [closePreviewSessionsForSurfaces, closeTerminalSessionsForSurfaces, rightPanelSurfaces, roomId]);

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

  const openTerminalSurface = useCallback(() => {
    closeFileSurfaceAddMenu();
    openCodeAgentRightPanel(roomId, 'terminal');
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
    const surfacesToClose = rightPanelSurfaces.filter((surface) => surface.id !== surfaceId);
    closePreviewSessionsForSurfaces(surfacesToClose);
    closeTerminalSessionsForSurfaces(surfacesToClose);
    closeOtherCodeAgentRightPanelSurfaces(roomId, surfaceId);
  }, [closeFileSurfaceTabMenu, closePreviewSessionsForSurfaces, closeTerminalSessionsForSurfaces, rightPanelSurfaces, roomId]);

  const closeFileSurfacesToRight = useCallback((surfaceId: string) => {
    closeFileSurfaceTabMenu();
    const surfaceIndex = rightPanelSurfaces.findIndex((surface) => surface.id === surfaceId);
    if (surfaceIndex >= 0) {
      const surfacesToClose = rightPanelSurfaces.slice(surfaceIndex + 1);
      closePreviewSessionsForSurfaces(surfacesToClose);
      closeTerminalSessionsForSurfaces(surfacesToClose);
    }
    closeCodeAgentRightPanelSurfacesToRight(roomId, surfaceId);
  }, [closeFileSurfaceTabMenu, closePreviewSessionsForSurfaces, closeTerminalSessionsForSurfaces, rightPanelSurfaces, roomId]);

  const closeAllFileSurfaces = useCallback(() => {
    closeFileSurfaceTabMenu();
    closePreviewSessionsForSurfaces(rightPanelSurfaces);
    closeTerminalSessionsForSurfaces(rightPanelSurfaces);
    closeAllCodeAgentRightPanelSurfaces(roomId);
  }, [closeFileSurfaceTabMenu, closePreviewSessionsForSurfaces, closeTerminalSessionsForSurfaces, rightPanelSurfaces, roomId]);

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
        onUpload={() => {
          if (workspaceEditable) {
            uploadInputRef.current?.click();
          }
        }}
        onRename={handleRename}
        onDelete={handleDelete}
        workspaceEditable={workspaceEditable}
        onSearchQueryChange={handleSearchQueryChange}
        remoteSearchPending={remoteSearch.isPending}
        remoteSearchError={remoteSearch.error}
        remoteSearchTruncated={remoteSearch.truncated}
        mobileLayout={isMobileSurface}
        onBackToPreview={isMobileSurface && relativePath ? handleBackToMobileFilePreview : undefined}
      />
    </aside>
  ) : null;
  const showMobileDiffFileList = isMobileSurface && mobileDiffFileListOpen && changedFileEntries.length > 0;
  const diffSurfaceBodyClassName = isMobileSurface
    ? `flex-col ${showMobileDiffFileList ? 'p-2' : 'p-0'}`
    : 'p-2';
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
          className="relative h-8 shrink-0 border-b border-[#dedbd0] bg-[#f0eee6] text-xs dark:border-[#30302e] dark:bg-[#242422]"
          data-testid="code-agent-file-surface-tabs-frame"
        >
          <div
            ref={fileSurfaceTabListRef}
            className="h-full overflow-x-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            data-testid="code-agent-file-surface-tabs"
            role="tablist"
          >
            <div className="flex h-full w-max min-w-full items-center gap-1 pr-7">
              {rightPanelSurfaces.map((surface) => {
                const isActive = surface.id === rightPanelState.activeSurfaceId;
                const title = surface.kind === 'diff'
                  ? t('codeAgentChanges')
                  : surface.kind === 'files'
                    ? t('codeAgentWorkspaceFiles')
                    : surface.kind === 'terminal'
                      ? t('codeAgentTerminalSurface')
                      : surface.kind === 'preview'
                        ? (surface.relativePath
                          ? basename(surface.relativePath)
                          : surface.url
                            ? formatBrowserSurfaceUrlTitle(surface.url)
                            : t('codeAgentBrowserSurface'))
                        : basename(surface.relativePath);
                const fullTitle = surface.kind === 'file'
                  ? surface.relativePath
                  : surface.kind === 'terminal'
                    ? t('codeAgentTerminalSurface')
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
                        <FileDiff className="h-3.5 w-3.5 shrink-0 text-[#5e5d59] dark:text-[#8f8d86]" />
                      ) : surface.kind === 'files' ? (
                        <Files className="h-3.5 w-3.5 shrink-0 text-[#5e5d59] dark:text-[#8f8d86]" />
                      ) : surface.kind === 'terminal' ? (
                        <TerminalSquare className="h-3.5 w-3.5 shrink-0 text-[#5e5d59] dark:text-[#8f8d86]" />
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
                        className="mr-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[#5e5d59] hover:bg-[#dedbd0] hover:text-[#141413] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]"
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
                      className={`relative mr-0.5 inline-flex shrink-0 items-center justify-center rounded text-[#5e5d59] hover:bg-[#dedbd0] hover:text-[#141413] focus:opacity-100 dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5] ${
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
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[#5e5d59] transition-colors hover:bg-[#faf9f5] hover:text-[#141413] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:text-[#8f8d86] dark:hover:bg-[#1d1d1b] dark:hover:text-[#faf9f5]"
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
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute inset-y-1 left-0 z-10 w-5 bg-gradient-to-r from-[#f0eee6] to-transparent transition-opacity dark:from-[#242422] ${
              fileSurfaceTabScrollState.canScrollStart ? 'opacity-100' : 'opacity-0'
            }`}
            data-testid="code-agent-file-surface-tabs-scroll-fade-start"
            data-visible={fileSurfaceTabScrollState.canScrollStart ? 'true' : 'false'}
          />
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute inset-y-1 right-0 z-10 w-8 bg-gradient-to-l from-[#f0eee6] to-transparent transition-opacity dark:from-[#242422] ${
              fileSurfaceTabScrollState.canScrollEnd ? 'opacity-100' : 'opacity-0'
            }`}
            data-testid="code-agent-file-surface-tabs-scroll-fade-end"
            data-visible={fileSurfaceTabScrollState.canScrollEnd ? 'true' : 'false'}
          />
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
            <Globe2 className="h-3.5 w-3.5 shrink-0 text-[#5e5d59] dark:text-[#8f8d86]" />
            <span className="min-w-0 truncate">{t('codeAgentBrowserSurface')}</span>
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[#141413] hover:bg-[#f0eee6] dark:text-[#faf9f5] dark:hover:bg-[#30302e]"
            role="menuitem"
            onClick={openTerminalSurface}
          >
            <TerminalSquare className="h-3.5 w-3.5 shrink-0 text-[#5e5d59] dark:text-[#8f8d86]" />
            <span className="min-w-0 truncate">{t('codeAgentTerminalSurface')}</span>
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[#141413] hover:bg-[#f0eee6] dark:text-[#faf9f5] dark:hover:bg-[#30302e]"
            role="menuitem"
            onClick={openFilesSurface}
          >
            <Files className="h-3.5 w-3.5 shrink-0 text-[#5e5d59] dark:text-[#8f8d86]" />
            <span className="min-w-0 truncate">{t('codeAgentWorkspaceFiles')}</span>
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[#141413] hover:bg-[#f0eee6] dark:text-[#faf9f5] dark:hover:bg-[#30302e]"
            role="menuitem"
            onClick={openDiffSurface}
          >
            <FileDiff className="h-3.5 w-3.5 shrink-0 text-[#5e5d59] dark:text-[#8f8d86]" />
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
          onAddTerminal={openTerminalSurface}
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
        />
      ) : activeTerminalSurface ? (
        <CodeAgentTerminalSurface
          roomId={roomId}
          terminalId={activeTerminalSurface.terminalId}
        />
      ) : activeDiffSurface ? (
        <div
          ref={diffSurfaceRef}
          className={`${diffSurfaceBodyClassName} flex min-h-0 flex-1 gap-2 overflow-hidden`}
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
                  <FileDiff className="h-3.5 w-3.5 shrink-0 text-[#5e5d59] dark:text-[#8f8d86]" />
                ) : (
                  <Files className="h-3.5 w-3.5 shrink-0 text-[#5e5d59] dark:text-[#8f8d86]" />
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
              compactLayout={isMobileSurface}
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
          devServerPreview={assetUrlQuery.data?.kind === 'dev-server' ? assetUrlQuery.data : null}
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
          onStartDevServerPreview={assetUrlQuery.startDevServer}
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
      <input ref={uploadInputRef} type="file" className="hidden" multiple disabled={!workspaceEditable} onChange={handleUpload} />
    </div>
  );
};
