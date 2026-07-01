import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FileDiff,
  FolderTree,
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
import type { RoomSandboxStatus } from '../utils/types';
import { beginHorizontalResize } from '../utils/horizontalResize';
import { normalizeWorkspaceOpenPath, parseWorkspaceFileOpenTarget } from '../utils/workspaceFileOpenTarget';
import { type ReviewCommentContext } from '../utils/codeAgentReviewComments';
import {
  basename,
  isBrowserPreviewFile,
  isImagePreviewFile,
  isMarkdownPreviewFile,
} from './codeAgentFilePath';
import {
  getOptimisticCodeAgentProjectFileQueryData,
  resolveCodeAgentProjectFileQueryData,
  settleConfirmedCodeAgentProjectFileQueryData,
} from './codeAgentProjectFilesQueryState';
import { CodeAgentFilePreviewPanel } from './CodeAgentFilePreviewPanel';
import { CodeAgentWorkspaceDiffViewer } from './CodeAgentWorkspaceDiffViewer';
import {
  CodeAgentWorkspaceFileTreePanel,
  type CodeAgentProjectEntry,
} from './CodeAgentWorkspaceFileTreePanel';
import {
  activateCodeAgentRightPanelSurface,
  closeAllCodeAgentRightPanelSurfaces,
  closeCodeAgentRightPanelSurface,
  closeCodeAgentRightPanelSurfacesToRight,
  closeOtherCodeAgentRightPanelSurfaces,
  openCodeAgentRightPanel,
  openCodeAgentRightPanelFile,
  reconcileCodeAgentFileSurfaces,
  type CodeAgentRightPanelSurface,
  useCodeAgentRightPanelState,
} from '../utils/codeAgentRightPanelStore';

interface CodeAgentFileBrowserPanelProps {
  roomId: string;
  projectName: string;
  sandboxStatus?: RoomSandboxStatus;
  sandboxUpdatedAt?: string;
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
  entries: CodeWorkspaceEntry[];
  truncated: boolean;
  isPending: boolean;
  error: string | null;
};

const FILE_WORD_WRAP_STORAGE_KEY = 'roomtalk.codeWorkspace.fileWordWrap';
const FILE_EXPLORER_STORAGE_KEY = 'roomtalk.codeWorkspace.fileExplorerOpen';
const FILE_EXPLORER_WIDTH_STORAGE_KEY = 'roomtalk.codeWorkspace.fileExplorerWidth';
const FILE_EXPLORER_MIN_WIDTH = 160;
const FILE_PREVIEW_MIN_WIDTH = 220;
const FILE_EXPLORER_DEFAULT_WIDTH = 352;
const WORKSPACE_TREE_REMOTE_SEARCH_LIMIT = 200;
const WORKSPACE_TREE_REMOTE_SEARCH_DEBOUNCE_MS = 150;

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

function normalizeWorkspacePath(path: string): string {
  return normalizeWorkspaceOpenPath(path);
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

function useCodeWorkspaceFileQuery(roomId: string, relativePath: string | null, enabled = true): FileQueryState {
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const fileCacheRef = useRef(new Map<string, CodeWorkspaceFile>());
  const [data, setData] = useState<CodeWorkspaceFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const normalizedPath = relativePath ? normalizeWorkspacePath(relativePath) : null;
  const latestQueryStateRef = useRef({ normalizedPath, enabled });
  latestQueryStateRef.current = { normalizedPath, enabled };

  const setCachedData = useCallback<React.Dispatch<React.SetStateAction<CodeWorkspaceFile | null>>>((nextData) => {
    setData((current) => {
      const resolvedData = typeof nextData === 'function'
        ? nextData(current)
        : nextData;
      if (resolvedData) {
        fileCacheRef.current.set(normalizeWorkspacePath(resolvedData.path), resolvedData);
      }
      return resolvedData;
    });
  }, []);

  const refresh = useCallback(() => {
    if (
      !normalizedPath ||
      !enabled ||
      latestQueryStateRef.current.normalizedPath !== normalizedPath ||
      !latestQueryStateRef.current.enabled
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
      fileCacheRef.current.get(normalizedPath) ?? null,
    ));
    setError(null);
    setIsPending(true);

    loadCodeWorkspaceFile(roomId, normalizedPath, { signal: controller.signal }).then(
      (file) => {
        if (
          controller.signal.aborted ||
          requestIdRef.current !== requestId ||
          latestQueryStateRef.current.normalizedPath !== normalizedPath ||
          !latestQueryStateRef.current.enabled
        ) {
          return;
        }
        const normalizedFilePath = normalizeWorkspacePath(file.path);
        const optimisticFile = getOptimisticCodeAgentProjectFileQueryData(roomId, normalizedFilePath);
        fileCacheRef.current.set(normalizedFilePath, file);
        const settled = settleConfirmedCodeAgentProjectFileQueryData(roomId, normalizedFilePath, file);
        setData(settled ? file : optimisticFile ?? file);
      },
      (nextError) => {
        if (
          controller.signal.aborted ||
          requestIdRef.current !== requestId ||
          latestQueryStateRef.current.normalizedPath !== normalizedPath ||
          !latestQueryStateRef.current.enabled
        ) {
          return;
        }
        setError(nextError instanceof Error ? nextError.message : 'File open failed.');
      },
    ).finally(() => {
      if (
        requestIdRef.current === requestId &&
        latestQueryStateRef.current.normalizedPath === normalizedPath &&
        latestQueryStateRef.current.enabled
      ) {
        setIsPending(false);
        abortRef.current = null;
      }
    });
  }, [enabled, normalizedPath, roomId]);

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
  }, [enabled, normalizedPath, refresh]);

  return { data, error, isPending, refresh, setData: setCachedData };
}

function useCodeWorkspaceAssetUrlQuery(roomId: string, relativePath: string | null, enabled: boolean): AssetUrlQueryState {
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
  }, [enabled, roomId, relativePath]);

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
  sandboxStatus,
  sandboxUpdatedAt,
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
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [externallySelectedFilePath, setExternallySelectedFilePath] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({
    path: null,
    state: 'idle',
    error: null,
  });
  const [explorerOpen, setExplorerOpen] = useState(initialExplorerOpen);
  const [explorerWidth, setExplorerWidth] = useState(() => initialExplorerWidth());
  const [wordWrap, setWordWrap] = useState(readInitialFileWordWrap);
  const explorerWidthRef = useRef(explorerWidth);
  const explorerResizeCleanupRef = useRef<(() => void) | null>(null);
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
  const [browserPreviewPendingPath, setBrowserPreviewPendingPath] = useState<string | null>(null);
  const [remoteSearch, setRemoteSearch] = useState<WorkspaceRemoteSearchState>({
    query: '',
    entries: [],
    truncated: false,
    isPending: false,
    error: null,
  });
  const workspaceReadyKey = `${sandboxStatus || 'none'}:${sandboxUpdatedAt || ''}`;
  const previousWorkspaceReadyKeyRef = useRef(workspaceReadyKey);
  const rightPanelState = useCodeAgentRightPanelState(roomId);
  const [fileSurfaceTabMenu, setFileSurfaceTabMenu] = useState<FileSurfaceTabMenuState>(null);
  const fileSurfaceTabMenuRef = useRef<HTMLDivElement | null>(null);
  const didInitializeRightPanelRef = useRef(false);

  const externallySelectedEntry = useMemo(
    () => (externallySelectedFilePath ? workspaceEntryForPath(externallySelectedFilePath, 'file') : null),
    [externallySelectedFilePath],
  );
  const workspaceEntries = useMemo(
    () => mergeWorkspaceEntries(
      entriesQuery.data?.entries ?? [],
      externallySelectedEntry ? [...remoteSearch.entries, externallySelectedEntry] : remoteSearch.entries,
    ),
    [entriesQuery.data?.entries, externallySelectedEntry, remoteSearch.entries],
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
  const hasDiffSurface = useMemo(
    () => rightPanelSurfaces.some((surface) => surface.kind === 'diff'),
    [rightPanelSurfaces],
  );
  const hasFilesSurface = useMemo(
    () => rightPanelSurfaces.some((surface) => surface.kind === 'files'),
    [rightPanelSurfaces],
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
  const browserPreviewPending = Boolean(relativePath && browserPreviewPendingPath === relativePath);
  const activeSaveState = saveStatus.path === relativePath ? saveStatus.state : 'idle';
  const activeSaveError = saveStatus.path === relativePath ? saveStatus.error : null;
  const fileQuery = useCodeWorkspaceFileQuery(
    roomId,
    relativePath,
    Boolean(relativePath && (!renderPreview || isMarkdown)),
  );
  const assetUrlQuery = useCodeWorkspaceAssetUrlQuery(
    roomId,
    relativePath,
    Boolean(relativePath && renderPreview && supportsWorkspaceAssetPreview),
  );
  const activeAssetPreviewRevision = relativePath ? assetPreviewRevisions[relativePath] ?? 0 : 0;
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

  useEffect(() => () => {
    explorerResizeCleanupRef.current?.();
    explorerResizeCleanupRef.current = null;
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
    if (activeFilesSurface || activeDiffSurface) {
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
  }, [activeDiffSurface, activeFileSurface, activeFilesSurface, fileSurfaces.length, previewPath]);

  useEffect(() => {
    if (entriesQuery.isPending || entriesQuery.data?.truncated) {
      return;
    }
    reconcileCodeAgentFileSurfaces(roomId, true, fileEntryPathSet);
  }, [entriesQuery.data?.truncated, entriesQuery.isPending, fileEntryPathSet, roomId]);

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
    openCodeAgentRightPanelFile(roomId, normalizedPath, revealLine);
    setLocalOpenFileRequest(null);
    setOperationError(null);
  }, [openFileRequest?.path, openFileRequest?.requestId, revealLine, roomId]);

  useEffect(() => {
    const previousKey = previousWorkspaceReadyKeyRef.current;
    previousWorkspaceReadyKeyRef.current = workspaceReadyKey;
    if (sandboxStatus === 'ready' && previousKey !== workspaceReadyKey) {
      refreshWorkspaceEntries();
    }
  }, [refreshWorkspaceEntries, sandboxStatus, workspaceReadyKey]);

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
        current.entries.length === 0 && !current.truncated && !current.isPending && current.error === null
          ? current
          : { ...current, entries: [], truncated: false, isPending: false, error: null }
      ));
      return undefined;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setRemoteSearch((current) => (
        current.query === remoteSearch.query
          ? { ...current, isPending: true, error: null }
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
  }, [remoteSearch.query, roomId]);

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
          openCodeAgentRightPanelFile(roomId, nextPreviewPath);
        }
      }
      refreshEntries();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Workspace file operation failed.');
    }
  }, [refreshEntries, relativePath, roomId]);

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
      openCodeAgentRightPanelFile(roomId, normalizedPath);
    }
    setOperationError(null);
  }, [roomId]);

  const handleOpenWorkspaceFileFromMarkdown = useCallback((path: string) => {
    const target = parseWorkspaceFileOpenTarget(path);
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
    openCodeAgentRightPanelFile(roomId, target.path, target.line);
    setOperationError(null);
  }, [roomId]);

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
    setExplorerOpen((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(FILE_EXPLORER_STORAGE_KEY, String(next));
      } catch {
        // Ignore localStorage failures; the explorer toggle remains functional.
      }
      return next;
    });
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
    const targetPath = normalizeWorkspacePath(path);
    if (!targetPath || !isBrowserPreviewFile(targetPath)) {
      return;
    }

    const previewWindow = window.open('about:blank', '_blank');
    try {
      if (previewWindow) {
        previewWindow.opener = null;
      }
    } catch {
      // Some browsers lock this down; the asset URL still opens in a new tab.
    }

    const openResolvedUrl = (url: string) => {
      if (previewWindow && !previewWindow.closed) {
        previewWindow.location.href = url;
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    };

    setOperationError(null);
    setBrowserPreviewPendingPath(targetPath);
    createCodeWorkspaceAssetUrl(roomId, targetPath).then(
      (asset) => {
        openResolvedUrl(resolveCodeWorkspaceAssetUrl(asset));
      },
      (error) => {
        try {
          previewWindow?.close();
        } catch {
          // The tab may already be gone.
        }
        setOperationError(error instanceof Error ? error.message : t('codeAgentOpenPreviewFailed'));
      },
    ).finally(() => {
      setBrowserPreviewPendingPath((current) => current === targetPath ? null : current);
    });
  }, [roomId, t]);

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
  }, []);

  const activateFileSurface = useCallback((surfaceId: string) => {
    activateCodeAgentRightPanelSurface(roomId, surfaceId);
  }, [roomId]);

  const closeFileSurface = useCallback((surfaceId: string) => {
    closeCodeAgentRightPanelSurface(roomId, surfaceId);
  }, [roomId]);

  const openFilesSurface = useCallback(() => {
    openCodeAgentRightPanel(roomId, 'files');
  }, [roomId]);

  const openDiffSurface = useCallback(() => {
    openCodeAgentRightPanel(roomId, 'diff');
  }, [roomId]);

  const handleOpenWorkspaceFileFromDiff = useCallback((path: string) => {
    const target = parseWorkspaceFileOpenTarget(path);
    if (!target) {
      return;
    }
    setSelectedPath(target.path);
    setPreviewPath(target.path);
    setExternallySelectedFilePath(target.path);
    openCodeAgentRightPanelFile(roomId, target.path, target.line);
    setLocalOpenFileRequest(null);
    setOperationError(null);
  }, [roomId]);

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
      x: event.clientX,
      y: event.clientY,
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
    closeOtherCodeAgentRightPanelSurfaces(roomId, surfaceId);
  }, [closeFileSurfaceTabMenu, roomId]);

  const closeFileSurfacesToRight = useCallback((surfaceId: string) => {
    closeFileSurfaceTabMenu();
    closeCodeAgentRightPanelSurfacesToRight(roomId, surfaceId);
  }, [closeFileSurfaceTabMenu, roomId]);

  const closeAllFileSurfaces = useCallback(() => {
    closeFileSurfaceTabMenu();
    closeAllCodeAgentRightPanelSurfaces(roomId);
  }, [closeFileSurfaceTabMenu, roomId]);

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

  const fileExplorer = explorerOpen || relativePath === null ? (
    <aside
      className={`${relativePath ? 'relative min-w-[160px] border-l border-[#dedbd0] dark:border-[#30302e]' : 'min-w-0 flex-1'} flex min-h-0 shrink-0 bg-[#faf9f5] dark:bg-[#1d1d1b]`}
      style={relativePath ? {
        width: 'var(--workspace-file-explorer-width)',
        maxWidth: `calc(100% - ${FILE_PREVIEW_MIN_WIDTH}px)`,
      } : undefined}
    >
      {relativePath ? (
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
      />
    </aside>
  ) : null;

  return (
    <div
      ref={panelRef}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[#faf9f5] dark:bg-[#1d1d1b]"
      data-file-browser-panel={`${roomId}:workspace`}
      style={{ ['--workspace-file-explorer-width' as string]: `${explorerWidth}px` }}
    >
      {rightPanelSurfaces.length > 0 ? (
        <div
          className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-[#dedbd0] bg-[#f0eee6] px-2 text-xs dark:border-[#30302e] dark:bg-[#242422]"
          data-testid="code-agent-file-surface-tabs"
          role="tablist"
        >
          {rightPanelSurfaces.map((surface) => {
            const isActive = surface.id === rightPanelState.activeSurfaceId;
            const title = surface.kind === 'diff'
              ? t('codeAgentChanges')
              : surface.kind === 'files'
                ? t('codeAgentWorkspaceFiles')
                : basename(surface.relativePath);
            const fullTitle = surface.kind === 'file' ? surface.relativePath : title;
            return (
              <div
                key={surface.id}
                data-active-tab={isActive}
                className={`flex max-w-56 shrink-0 items-center rounded-md border ${
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
                  className="flex min-w-0 flex-1 items-center gap-1.5 truncate px-2 py-1 text-left"
                  title={fullTitle}
                  onClick={() => activateFileSurface(surface.id)}
                >
                  {surface.kind === 'diff' ? (
                    <FileDiff className="h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]" />
                  ) : surface.kind === 'files' ? (
                    <FolderTree className="h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]" />
                  ) : null}
                  <span className="truncate">{title}</span>
                </button>
                <button
                  type="button"
                  className="mr-0.5 rounded p-0.5 text-[#87867f] hover:bg-[#dedbd0] hover:text-[#141413] dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]"
                  aria-label={`${t('close')} ${fullTitle}`}
                  onClick={() => {
                    closeFileSurfaceTabMenu();
                    closeFileSurface(surface.id);
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
          {!hasDiffSurface ? (
            <button
              type="button"
              className="ml-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[#87867f] transition-colors hover:bg-[#faf9f5] hover:text-[#141413] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:text-[#8f8d86] dark:hover:bg-[#1d1d1b] dark:hover:text-[#faf9f5]"
              aria-label={t('codeAgentChanges')}
              title={t('codeAgentChanges')}
              onClick={openDiffSurface}
            >
              <FileDiff className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {!hasFilesSurface ? (
            <button
              type="button"
              className="ml-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[#87867f] transition-colors hover:bg-[#faf9f5] hover:text-[#141413] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:text-[#8f8d86] dark:hover:bg-[#1d1d1b] dark:hover:text-[#faf9f5]"
              aria-label={t('codeAgentWorkspaceFiles')}
              title={t('codeAgentWorkspaceFiles')}
              onClick={openFilesSurface}
            >
              <FolderTree className="h-3.5 w-3.5" />
            </button>
          ) : null}
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
      {activeDiffSurface ? (
        <div className="flex min-h-0 flex-1 overflow-hidden p-2">
          <CodeAgentWorkspaceDiffViewer
            roomId={roomId}
            enabled
            refreshKey={workspaceReadyKey}
            onOpenFile={handleOpenWorkspaceFileFromDiff}
            reviewComments={reviewComments}
            onAddReviewComment={onAddReviewComment}
            onRemoveReviewComment={onRemoveReviewComment}
          />
        </div>
      ) : (
        <CodeAgentFilePreviewPanel
          roomId={roomId}
          projectName={projectName}
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
          explorerOpen={explorerOpen}
          explorer={fileExplorer}
          browserPreviewPending={browserPreviewPending}
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
