import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { VirtualizedFile, type SelectedLineRange } from '@pierre/diffs';
import { Editor } from '@pierre/diffs/editor';
import { EditorProvider, File as DiffFile, type FileOptions, Virtualizer } from '@pierre/diffs/react';
import { FileTree, useFileTree, useFileTreeSearch } from '@pierre/trees/react';
import type { FileTreeIcons } from '@pierre/trees';
import {
  ChevronRight,
  Code2,
  Download,
  Eye,
  FileDiff,
  FilePlus2,
  FolderPlus,
  FolderTree,
  Globe2,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  WrapText,
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
import {
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
} from '../utils/codeWorkspaceFilePreview';
import type { RoomSandboxStatus } from '../utils/types';
import { beginHorizontalResize } from '../utils/horizontalResize';
import { normalizeWorkspaceOpenPath, parseWorkspaceFileOpenTarget } from '../utils/workspaceFileOpenTarget';
import {
  buildFileReviewComment,
  type ReviewCommentContext,
} from '../utils/codeAgentReviewComments';
import { CodeAgentLocalCommentAnnotation } from './CodeAgentLocalCommentAnnotation';
import {
  type FileCommentAnnotationEntry,
  type FileCommentAnnotationGroup,
  type FileCommentLineAnnotation,
  formatFileCommentRange,
  nextFileCommentId,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from './codeAgentFileCommentAnnotations';
import { installFileEditorDismissal } from './codeAgentFileEditorDismissal';
import { projectFileCacheKey } from './codeAgentFileContentRevision';
import { FileSaveCoordinator } from './codeAgentFileSaveCoordinator';
import { isMarkdownPreviewFile, setMarkdownTaskChecked } from './codeAgentFilePreviewMode';
import {
  clearCodeAgentProjectFileQueryData,
  confirmCodeAgentProjectFileQueryData,
  getOptimisticCodeAgentProjectFileQueryData,
  resolveCodeAgentProjectFileQueryData,
  setCodeAgentProjectFileQueryData,
} from './codeAgentProjectFilesQueryState';
import { CodeAgentWorkspaceDiffViewer } from './CodeAgentWorkspaceDiffViewer';
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

const MarkdownContent = React.lazy(() =>
  import('./MarkdownContent').then((module) => ({ default: module.MarkdownContent })),
);

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

type ProjectEntry = {
  path: string;
  kind: 'file' | 'directory';
};

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

const T3_PIERRE_ICONS = {
  set: 'complete',
  colored: true,
} satisfies FileTreeIcons;

const TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12px;
  }
  button[data-type='item'] { border-radius: 5px; }
`;

const FILE_SAVE_DEBOUNCE_MS = 500;
const FILE_WORD_WRAP_STORAGE_KEY = 'roomtalk.codeWorkspace.fileWordWrap';
const FILE_LINK_REVEAL_ATTRIBUTE = 'data-file-link-reveal';
const FILE_LINK_REVEAL_UNSAFE_CSS = `
  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-line] {
    background-color: color-mix(
      in srgb,
      var(--diffs-computed-diff-line-bg) 72%,
      var(--diffs-bg-selection-override, var(--diffs-selection-base))
    ) !important;
  }

  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-column-number] {
    background-color: color-mix(
      in srgb,
      var(--diffs-computed-diff-line-bg) 62%,
      var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
    ) !important;
    color: var(--diffs-selection-number-fg) !important;
  }
`;
const FILE_EXPLORER_STORAGE_KEY = 'roomtalk.codeWorkspace.fileExplorerOpen';
const FILE_EXPLORER_WIDTH_STORAGE_KEY = 'roomtalk.codeWorkspace.fileExplorerWidth';
const FILE_EXPLORER_MIN_WIDTH = 160;
const FILE_PREVIEW_MIN_WIDTH = 220;
const FILE_EXPLORER_DEFAULT_WIDTH = 352;
const WORKSPACE_TREE_REMOTE_SEARCH_LIMIT = 200;
const WORKSPACE_TREE_REMOTE_SEARCH_DEBOUNCE_MS = 150;
type FilePostRender = NonNullable<FileOptions<unknown>['onPostRender']>;

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

function treePath(entry: ProjectEntry): string {
  return entry.kind === 'directory' ? `${entry.path}/` : entry.path;
}

function normalizeWorkspacePath(path: string): string {
  return normalizeWorkspaceOpenPath(path);
}

function updateWorkspaceFileContents(
  current: CodeWorkspaceFile | null,
  path: string,
  contents: string,
): CodeWorkspaceFile | null {
  if (!current || normalizeWorkspacePath(current.path) !== normalizeWorkspacePath(path)) {
    return current;
  }
  return {
    ...current,
    content: contents,
    byteSize: new TextEncoder().encode(contents).byteLength,
    truncated: false,
    encoding: 'utf-8',
  };
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

function basename(path: string): string {
  const normalizedPath = normalizeWorkspacePath(path);
  return normalizedPath.split('/').pop() || normalizedPath;
}

function projectEntriesFromWorkspace(entries: readonly CodeWorkspaceEntry[]): ProjectEntry[] {
  const byPath = new Map<string, ProjectEntry>();

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

function fileBreadcrumbs(projectName: string, relativePath: string) {
  const parts = relativePath.split('/').filter(Boolean);
  return [
    { label: projectName, path: '', kind: 'project' as const },
    ...parts.map((part, index) => ({
      label: part,
      path: parts.slice(0, index + 1).join('/'),
      kind: index === parts.length - 1 ? ('file' as const) : ('directory' as const),
    })),
  ];
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

function clampFileLine(contents: string, requestedLine: number): number {
  let lineCount = 1;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents.charCodeAt(index);
    if (character === 10) {
      lineCount += 1;
    } else if (character === 13) {
      lineCount += 1;
      if (contents.charCodeAt(index + 1) === 10) {
        index += 1;
      }
    }
  }
  return Math.min(Math.max(1, requestedLine), lineCount);
}

function updateFileLinkReveal(fileContainer: HTMLElement, line: number | null): void {
  const root = fileContainer.shadowRoot ?? fileContainer;
  for (const element of root.querySelectorAll<HTMLElement>(`[${FILE_LINK_REVEAL_ATTRIBUTE}]`)) {
    element.removeAttribute(FILE_LINK_REVEAL_ATTRIBUTE);
  }
  if (line === null) {
    return;
  }

  root
    .querySelector<HTMLElement>(`[data-line="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, '');
  root
    .querySelector<HTMLElement>(`[data-column-number="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, '');
}

function useFileLineReveal(
  relativePath: string | null,
  revealLine: number | null,
  revealRequestId: number,
): FilePostRender {
  const [handledRequestIdsByPath] = useState<Map<string, number>>(() => new Map());
  const [latestRequestIdsByPath] = useState<Map<string, number>>(() => new Map());
  const [pendingFramesByPath] = useState<Map<string, number>>(() => new Map());

  return useCallback<FilePostRender>(
    (fileContainer, instance, phase) => {
      if (relativePath === null) return;

      const cancelPendingReveal = () => {
        const frameId = pendingFramesByPath.get(relativePath);
        if (frameId !== undefined) {
          cancelAnimationFrame(frameId);
          pendingFramesByPath.delete(relativePath);
        }
      };

      if (phase === 'unmount') {
        cancelPendingReveal();
        return;
      }

      const targetLine = revealLine === null ? null : clampFileLine(instance.file?.contents ?? '', revealLine);
      updateFileLinkReveal(fileContainer, targetLine);

      if (!(instance instanceof VirtualizedFile)) return;

      if (latestRequestIdsByPath.get(relativePath) !== revealRequestId) {
        cancelPendingReveal();
        latestRequestIdsByPath.set(relativePath, revealRequestId);
      }

      if (targetLine === null) {
        fileContainer.style.minHeight = '';
        return;
      }

      const scrollContainer = fileContainer.closest<HTMLElement>('.file-preview-virtualizer');
      if (!scrollContainer) return;
      fileContainer.style.minHeight = `${Math.ceil(Math.max(instance.height, scrollContainer.clientHeight))}px`;

      if (
        handledRequestIdsByPath.get(relativePath) === revealRequestId ||
        pendingFramesByPath.has(relativePath)
      ) {
        return;
      }

      const reveal = () => {
        pendingFramesByPath.delete(relativePath);
        if (
          latestRequestIdsByPath.get(relativePath) !== revealRequestId ||
          !fileContainer.isConnected
        ) {
          return;
        }

        const linePosition = instance.getLinePosition(targetLine);
        if (!linePosition) return;

        const fileTop = scrollContainer.scrollTop
          + fileContainer.getBoundingClientRect().top
          - scrollContainer.getBoundingClientRect().top;
        const centeredTop = Math.max(
          0,
          fileTop + linePosition.top - Math.max(0, (scrollContainer.clientHeight - linePosition.height) / 2),
        );
        const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);

        scrollContainer.scrollTop = Math.min(centeredTop, maxScrollTop);
        handledRequestIdsByPath.set(relativePath, revealRequestId);
      };

      pendingFramesByPath.set(relativePath, requestAnimationFrame(reveal));
    },
    [
      handledRequestIdsByPath,
      latestRequestIdsByPath,
      pendingFramesByPath,
      relativePath,
      revealLine,
      revealRequestId,
    ],
  );
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
  const fileCacheRef = useRef(new Map<string, CodeWorkspaceFile>());
  const [data, setData] = useState<CodeWorkspaceFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const normalizedPath = relativePath ? normalizeWorkspacePath(relativePath) : null;

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

  useEffect(() => {
    if (!normalizedPath || !enabled) {
      setData(null);
      setError(null);
      setIsPending(false);
      return undefined;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const controller = new AbortController();
    setData(resolveCodeAgentProjectFileQueryData(
      roomId,
      normalizedPath,
      fileCacheRef.current.get(normalizedPath) ?? null,
    ));
    setError(null);
    setIsPending(true);

    loadCodeWorkspaceFile(roomId, normalizedPath, { signal: controller.signal }).then(
      (file) => {
        if (controller.signal.aborted || requestIdRef.current !== requestId) {
          return;
        }
        const normalizedFilePath = normalizeWorkspacePath(file.path);
        const optimisticFile = getOptimisticCodeAgentProjectFileQueryData(roomId, normalizedFilePath);
        fileCacheRef.current.set(normalizedFilePath, file);
        if (optimisticFile?.content === file.content) {
          clearCodeAgentProjectFileQueryData(roomId, normalizedFilePath);
        }
        setData(optimisticFile ?? file);
      },
      (nextError) => {
        if (controller.signal.aborted || requestIdRef.current !== requestId) {
          return;
        }
        setError(nextError instanceof Error ? nextError.message : 'File open failed.');
      },
    ).finally(() => {
      if (requestIdRef.current === requestId) {
        setIsPending(false);
      }
    });

    return () => controller.abort();
  }, [enabled, normalizedPath, roomId]);

  return { data, error, isPending, setData: setCachedData };
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

function decodeWorkspaceFile(file: CodeWorkspaceFile): BlobPart {
  if (file.encoding === 'utf-8') {
    return file.content;
  }

  const binary = window.atob(file.content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function inferMimeType(path: string, encoding: CodeWorkspaceFile['encoding']) {
  if (/\.(png)$/i.test(path)) return 'image/png';
  if (/\.(jpe?g)$/i.test(path)) return 'image/jpeg';
  if (/\.(gif)$/i.test(path)) return 'image/gif';
  if (/\.(webp)$/i.test(path)) return 'image/webp';
  if (/\.(svg)$/i.test(path)) return 'image/svg+xml';
  if (/\.(pdf)$/i.test(path)) return 'application/pdf';
  if (encoding === 'base64') return 'application/octet-stream';
  if (/\.(html?)$/i.test(path)) return 'text/html;charset=utf-8';
  if (/\.(json)$/i.test(path)) return 'application/json;charset=utf-8';
  if (/\.(css)$/i.test(path)) return 'text/css;charset=utf-8';
  if (/\.(js|mjs|cjs|ts|tsx|jsx)$/i.test(path)) return 'text/javascript;charset=utf-8';
  if (/\.(md|markdown)$/i.test(path)) return 'text/markdown;charset=utf-8';
  return 'text/plain;charset=utf-8';
}

function createDownload(file: CodeWorkspaceFile) {
  const blob = new Blob([decodeWorkspaceFile(file)], {
    type: inferMimeType(file.path, file.encoding),
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.path.split('/').pop() || 'workspace-file';
  anchor.rel = 'noopener noreferrer';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function previewedByteSize(file: CodeWorkspaceFile): number {
  if (file.encoding === 'utf-8') {
    return new TextEncoder().encode(file.content).byteLength;
  }
  return Math.min(file.byteSize, Math.floor((file.content.length * 3) / 4));
}

interface EditableFileSurfaceProps {
  roomId: string;
  file: CodeWorkspaceFile;
  resolvedTheme: 'light' | 'dark';
  wordWrap: boolean;
  onPostRender: FilePostRender;
  revealRequestId: number;
  onFileChange: React.Dispatch<React.SetStateAction<CodeWorkspaceFile | null>>;
  onSaveStateChange: (path: string, state: SaveState, error?: string | null) => void;
  onFileSavePendingChange?: (relativePath: string, pending: boolean) => void;
  onEntriesChanged: () => void;
  reviewComments: readonly ReviewCommentContext[];
  onAddReviewComment?: (comment: ReviewCommentContext) => void;
  onRemoveReviewComment?: (commentId: string) => void;
}

interface FileSelectionOverride {
  revealRequestId: number;
  range: SelectedLineRange | null;
}

function EditableFileSurface({
  roomId,
  file,
  resolvedTheme,
  wordWrap,
  onPostRender,
  revealRequestId,
  onFileChange,
  onSaveStateChange,
  onFileSavePendingChange,
  onEntriesChanged,
  reviewComments,
  onAddReviewComment,
  onRemoveReviewComment,
}: EditableFileSurfaceProps) {
  const filePath = file.path;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const selectionFrameRef = useRef<number | null>(null);
  const latestDraftContentsRef = useRef(file.content);
  const [lineAnnotations, setLineAnnotations] = useState<FileCommentLineAnnotation[]>([]);
  const [selectionOverride, setSelectionOverride] = useState<FileSelectionOverride | null>(null);
  const fileReviewCommentIds = useMemo(() => new Set(
    reviewComments
      .filter((comment) => comment.sectionId === `file:${filePath}` && comment.filePath === filePath)
      .map((comment) => comment.id),
  ), [filePath, reviewComments]);
  const fileReviewCommentIdsKey = useMemo(
    () => [...fileReviewCommentIds].sort().join('\n'),
    [fileReviewCommentIds],
  );
  const selectedRange = selectionOverride?.revealRequestId === revealRequestId ? selectionOverride.range : null;
  const setSelectedRange = useCallback(
    (range: SelectedLineRange | null) => {
      setSelectionOverride({ revealRequestId, range });
    },
    [revealRequestId],
  );

  useEffect(() => {
    onSaveStateChange(filePath, 'idle', null);
    latestDraftContentsRef.current = file.content;
    // Reset persistence state only when T3 mounts a different file surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  useEffect(() => {
    setLineAnnotations((current) => current.flatMap((annotation) => {
      const entries = annotation.metadata.entries.filter((entry) => (
        entry.kind === 'draft' || fileReviewCommentIds.has(entry.id)
      ));
      return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
    }));
  }, [fileReviewCommentIds, fileReviewCommentIdsKey]);

  const setDraftFileContents = useCallback((contents: string) => {
    latestDraftContentsRef.current = contents;
    setCodeAgentProjectFileQueryData(roomId, filePath, contents);
    onFileChange((current) => updateWorkspaceFileContents(current, filePath, contents));
  }, [filePath, onFileChange, roomId]);

  const confirmFileContents = useCallback((contents: string) => {
    if (latestDraftContentsRef.current !== contents) {
      return;
    }
    confirmCodeAgentProjectFileQueryData(roomId, filePath, contents);
    onFileChange((current) => updateWorkspaceFileContents(current, filePath, contents));
  }, [filePath, onFileChange, roomId]);

  const handlePendingChange = useCallback((pending: boolean) => {
    onSaveStateChange(filePath, pending ? 'pending' : 'saved', null);
    onFileSavePendingChange?.(filePath, pending);
  }, [filePath, onFileSavePendingChange, onSaveStateChange]);

  const saveCoordinator = useMemo(
    () => new FileSaveCoordinator({
      debounceMs: FILE_SAVE_DEBOUNCE_MS,
      onPendingChange: handlePendingChange,
      persist: async (contents) => {
        onSaveStateChange(filePath, 'saving', null);
        try {
          await writeCodeWorkspaceFile(roomId, filePath, contents, 'utf-8');
          onEntriesChanged();
          return { _tag: 'Success' };
        } catch (error) {
          onSaveStateChange(filePath, 'error', error instanceof Error ? error.message : 'File save failed.');
          return { _tag: 'Failure' };
        }
      },
      onConfirmed: (contents) => {
        confirmFileContents(contents);
      },
    }),
    [confirmFileContents, filePath, handlePendingChange, onEntriesChanged, onSaveStateChange, roomId],
  );

  useEffect(() => () => saveCoordinator.dispose(), [saveCoordinator]);

  const removeAnnotationEntry = useCallback((entryId: string) => {
    setSelectedRange(null);
    onRemoveReviewComment?.(entryId);
    setLineAnnotations((current) => current.flatMap((annotation) => {
      const entries = annotation.metadata.entries.filter((entry) => entry.id !== entryId);
      return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
    }));
  }, [onRemoveReviewComment, setSelectedRange]);

  const submitAnnotationEntry = useCallback((entryId: string, text: string) => {
    setSelectedRange(null);
    const entry = lineAnnotations
      .flatMap((annotation) => annotation.metadata.entries)
      .find((candidate) => candidate.id === entryId);
    if (entry) {
      onAddReviewComment?.(buildFileReviewComment({
        id: entry.id,
        filePath,
        startLine: entry.startLine,
        endLine: entry.endLine,
        text,
        contents: latestDraftContentsRef.current,
      }));
    }
    setLineAnnotations((current) => current.map((annotation) => ({
      ...annotation,
      metadata: {
        entries: annotation.metadata.entries.map((entry) => (
          entry.id === entryId ? { ...entry, kind: 'comment', text } : entry
        )),
      },
    })));
  }, [filePath, lineAnnotations, onAddReviewComment, setSelectedRange]);

  const beginComment = useCallback((range: SelectedLineRange) => {
    const { startLine, endLine } = normalizeFileCommentRange(range);
    const draftEntry: FileCommentAnnotationEntry = {
      id: nextFileCommentId(),
      kind: 'draft',
      startLine,
      endLine,
      text: '',
    };
    setLineAnnotations((current) => {
      const withoutDraft = current.flatMap((annotation) => {
        const entries = annotation.metadata.entries.filter((entry) => entry.kind !== 'draft');
        return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
      });
      const existingIndex = withoutDraft.findIndex((annotation) => annotation.lineNumber === endLine);
      if (existingIndex < 0) {
        return [
          ...withoutDraft,
          {
            lineNumber: endLine,
            metadata: { entries: [draftEntry] },
          },
        ];
      }
      return withoutDraft.map((annotation, index) => (
        index === existingIndex
          ? {
              ...annotation,
              metadata: { entries: [...annotation.metadata.entries, draftEntry] },
            }
          : annotation
      ));
    });
  }, []);

  const hasOpenCommentForm = lineAnnotations.some((annotation) =>
    annotation.metadata.entries.some((entry) => entry.kind === 'draft'),
  );

  const handleLineSelectionEnd = useCallback((range: SelectedLineRange | null) => {
    setSelectedRange(range);
    if (range) {
      beginComment(range);
    }
  }, [beginComment, setSelectedRange]);

  const editor = useMemo(() => {
    return new Editor<FileCommentAnnotationGroup>({
      onChange: (nextFile, nextLineAnnotations) => {
        setDraftFileContents(nextFile.contents);
        saveCoordinator.change(nextFile.contents);
        if (nextLineAnnotations) {
          setLineAnnotations(remapFileCommentAnnotations(
            nextLineAnnotations as FileCommentLineAnnotation[],
          ));
        }
      },
    });
  }, [saveCoordinator, setDraftFileContents]);

  useEffect(() => () => {
    editor.cleanUp();
  }, [editor]);

  useEffect(() => () => {
    if (selectionFrameRef.current !== null) {
      window.cancelAnimationFrame(selectionFrameRef.current);
      selectionFrameRef.current = null;
    }
  }, []);

  useEffect(() => {
    const root = surfaceRef.current;
    if (!root) return undefined;
    return installFileEditorDismissal({
      root,
      editor,
      isBlocked: () => hasOpenCommentForm,
      onDismiss: () => setSelectedRange(null),
    });
  }, [editor, hasOpenCommentForm, setSelectedRange]);

  const handlePostRender = useCallback<FilePostRender>((fileContainer, instance, phase) => {
    onPostRender(fileContainer, instance, phase);

    if (selectionFrameRef.current !== null) {
      window.cancelAnimationFrame(selectionFrameRef.current);
      selectionFrameRef.current = null;
    }
    if (phase === 'unmount') {
      return;
    }

    selectionFrameRef.current = window.requestAnimationFrame(() => {
      selectionFrameRef.current = null;
      if (!fileContainer.isConnected) {
        return;
      }
      instance.setSelectedLines(selectedRange, { notify: false });
    });
  }, [onPostRender, selectedRange]);

  return (
    <EditorProvider editor={editor}>
      <div ref={surfaceRef} className="flex min-h-0 flex-1">
        <Virtualizer
          className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
          config={{
            overscrollSize: 600,
            intersectionObserverMargin: 1200,
          }}
        >
          <DiffFile<FileCommentAnnotationGroup>
            file={{
              name: file.path,
              contents: file.content,
              cacheKey: projectFileCacheKey('', file.path, file.content),
            }}
            options={{
              disableFileHeader: true,
              enableGutterUtility: !hasOpenCommentForm,
              enableLineSelection: !hasOpenCommentForm,
              onGutterUtilityClick: setSelectedRange,
              onLineSelectionChange: setSelectedRange,
              onLineSelectionEnd: handleLineSelectionEnd,
              overflow: wordWrap ? 'wrap' : 'scroll',
              theme: resolvedTheme === 'dark' ? 'pierre-dark' : 'pierre-light',
              themeType: resolvedTheme,
              unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
              onPostRender: handlePostRender,
            }}
            selectedLines={selectedRange}
            lineAnnotations={lineAnnotations}
            renderAnnotation={(annotation) => (
              <div className="py-1">
                {annotation.metadata.entries.map((entry) => (
                  <CodeAgentLocalCommentAnnotation
                    key={entry.id}
                    kind={entry.kind}
                    rangeLabel={formatFileCommentRange(entry.startLine, entry.endLine)}
                    text={entry.text}
                    onCancel={() => removeAnnotationEntry(entry.id)}
                    onComment={(text) => submitAnnotationEntry(entry.id, text)}
                    onDelete={() => removeAnnotationEntry(entry.id)}
                  />
                ))}
              </div>
            )}
            className="min-h-full"
            contentEditable
          />
        </Virtualizer>
      </div>
    </EditorProvider>
  );
}

interface ReadOnlyFileSurfaceProps {
  file: CodeWorkspaceFile;
  resolvedTheme: 'light' | 'dark';
  wordWrap: boolean;
  onPostRender: FilePostRender;
}

function ReadOnlyFileSurface({
  file,
  resolvedTheme,
  wordWrap,
  onPostRender,
}: ReadOnlyFileSurfaceProps) {
  return (
    <div className="flex min-h-0 flex-1">
      <Virtualizer
        className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
        config={{
          overscrollSize: 600,
          intersectionObserverMargin: 1200,
        }}
      >
        <DiffFile
          file={{
            name: file.path,
            contents: file.content,
            cacheKey: projectFileCacheKey('', file.path, file.content),
          }}
          options={{
            disableFileHeader: true,
            overflow: wordWrap ? 'wrap' : 'scroll',
            theme: resolvedTheme === 'dark' ? 'pierre-dark' : 'pierre-light',
            themeType: resolvedTheme,
            unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
            onPostRender,
          }}
          className="min-h-full"
        />
      </Virtualizer>
    </div>
  );
}

interface RenderedMarkdownSurfaceProps {
  roomId: string;
  file: CodeWorkspaceFile;
  onFileChange: React.Dispatch<React.SetStateAction<CodeWorkspaceFile | null>>;
  onSaveStateChange: (path: string, state: SaveState, error?: string | null) => void;
  onFileSavePendingChange?: (relativePath: string, pending: boolean) => void;
  onEntriesChanged: () => void;
  onOpenWorkspaceFile: (path: string) => void;
}

function RenderedMarkdownSurface({
  roomId,
  file,
  onFileChange,
  onSaveStateChange,
  onFileSavePendingChange,
  onEntriesChanged,
  onOpenWorkspaceFile,
}: RenderedMarkdownSurfaceProps) {
  const filePath = file.path;
  const fileRef = useRef(file);
  const latestFilePathRef = useRef(filePath);
  const latestDraftContentsRef = useRef(file.content);

  useEffect(() => {
    fileRef.current = file;
    if (latestFilePathRef.current !== filePath) {
      latestFilePathRef.current = filePath;
      latestDraftContentsRef.current = file.content;
    }
  }, [file, filePath]);

  const setDraftFileContents = useCallback((contents: string) => {
    latestDraftContentsRef.current = contents;
    setCodeAgentProjectFileQueryData(roomId, filePath, contents);
    onFileChange((current) => updateWorkspaceFileContents(current, filePath, contents));
  }, [filePath, onFileChange, roomId]);

  const confirmFileContents = useCallback((contents: string) => {
    if (latestDraftContentsRef.current !== contents) {
      return;
    }
    confirmCodeAgentProjectFileQueryData(roomId, filePath, contents, fileRef.current);
    onFileChange((current) => updateWorkspaceFileContents(current, filePath, contents));
  }, [filePath, onFileChange, roomId]);

  const handlePendingChange = useCallback((pending: boolean) => {
    onSaveStateChange(filePath, pending ? 'pending' : 'saved', null);
    onFileSavePendingChange?.(filePath, pending);
  }, [filePath, onFileSavePendingChange, onSaveStateChange]);

  const saveCoordinator = useMemo(
    () => new FileSaveCoordinator({
      debounceMs: FILE_SAVE_DEBOUNCE_MS,
      onPendingChange: handlePendingChange,
      persist: async (contents) => {
        onSaveStateChange(filePath, 'saving', null);
        try {
          await writeCodeWorkspaceFile(roomId, filePath, contents, 'utf-8');
          onEntriesChanged();
          return { _tag: 'Success' };
        } catch (error) {
          onSaveStateChange(filePath, 'error', error instanceof Error ? error.message : 'File save failed.');
          return { _tag: 'Failure' };
        }
      },
      onConfirmed: (contents) => {
        confirmFileContents(contents);
      },
    }),
    [confirmFileContents, filePath, handlePendingChange, onEntriesChanged, onSaveStateChange, roomId],
  );

  useEffect(() => () => saveCoordinator.dispose(), [saveCoordinator]);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-5 text-[#141413] dark:text-[#faf9f5]">
        <React.Suspense fallback={<LoaderCircle className="h-5 w-5 animate-spin text-[#87867f] dark:text-[#8f8d86]" />}>
          <MarkdownContent
            content={file.content}
            onOpenWorkspaceFile={onOpenWorkspaceFile}
            onTaskListChange={({ markerOffset, checked }) => {
              const currentContents = getOptimisticCodeAgentProjectFileQueryData(roomId, filePath)?.content
                ?? fileRef.current.content;
              const nextContents = setMarkdownTaskChecked(currentContents, markerOffset, checked);
              if (nextContents === currentContents) return;
              fileRef.current = {
                ...fileRef.current,
                content: nextContents,
                byteSize: new TextEncoder().encode(nextContents).byteLength,
                truncated: false,
                encoding: 'utf-8',
              };
              setDraftFileContents(nextContents);
              saveCoordinator.change(nextContents);
            }}
          />
        </React.Suspense>
      </div>
    </div>
  );
}

interface FileBrowserPanelProps {
  projectName: string;
  entries: ProjectEntry[];
  entryKinds: ReadonlyMap<string, ProjectEntry['kind']>;
  entriesPending: boolean;
  entriesError: string | null;
  entriesTruncated: boolean;
  selectedPath: string | null;
  resolvedTheme: 'light' | 'dark';
  onOpenEntry: (relativePath: string, kind: ProjectEntry['kind']) => void;
  onRefresh: () => void;
  onCreateFile: () => void;
  onCreateDirectory: () => void;
  onUpload: () => void;
  onRename: () => void;
  onDelete: () => void;
  onSearchQueryChange: (query: string) => void;
  remoteSearchPending: boolean;
  remoteSearchError: string | null;
  remoteSearchTruncated: boolean;
}

function FileBrowserPanel({
  projectName,
  entries,
  entryKinds,
  entriesPending,
  entriesError,
  entriesTruncated,
  selectedPath,
  resolvedTheme,
  onOpenEntry,
  onRefresh,
  onCreateFile,
  onCreateDirectory,
  onUpload,
  onRename,
  onDelete,
  onSearchQueryChange,
  remoteSearchPending,
  remoteSearchError,
  remoteSearchTruncated,
}: FileBrowserPanelProps) {
  const { t } = useTranslation();
  const entryKindsRef = useRef<ReadonlyMap<string, ProjectEntry['kind']>>(entryKinds);
  const treePaths = useMemo(() => entries.map(treePath), [entries]);
  const previousTreePathsRef = useRef<readonly string[]>([]);
  const fileCount = useMemo(
    () => entries.reduce((count, entry) => count + (entry.kind === 'file' ? 1 : 0), 0),
    [entries],
  );

  const { model } = useFileTree({
    density: 'compact',
    fileTreeSearchMode: 'hide-non-matches',
    flattenEmptyDirectories: true,
    initialExpansion: 1,
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      const nextPath = selectedPaths.at(-1)?.replace(/\/$/, '');
      const kind = nextPath ? entryKindsRef.current.get(nextPath) : undefined;
      if (nextPath && kind) {
        onOpenEntry(nextPath, kind);
      }
    },
    paths: [],
    search: true,
    unsafeCSS: TREE_UNSAFE_CSS,
  });
  const treeSearch = useFileTreeSearch(model);
  const fileCountLabel = entriesPending && entries.length === 0
    ? t('codeAgentWorkspaceIndexing')
    : t('codeAgentWorkspaceFileCount', { formattedCount: fileCount.toLocaleString() });

  useEffect(() => {
    if (previousTreePathsRef.current === treePaths) return;
    entryKindsRef.current = entryKinds;
    previousTreePathsRef.current = treePaths;
    model.resetPaths(treePaths);
  }, [entryKinds, model, treePaths]);

  useEffect(() => {
    if (!selectedPath || !entryKinds.has(selectedPath)) {
      return;
    }
    model.focusPath(selectedPath);
    model.scrollToPath(selectedPath, { offset: 'nearest' });
  }, [entryKinds, model, selectedPath]);

  useEffect(() => {
    onSearchQueryChange(treeSearch.isOpen ? treeSearch.value : '');
  }, [onSearchQueryChange, treeSearch.isOpen, treeSearch.value]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#faf9f5] dark:bg-[#1d1d1b]" data-file-browser-panel="t3-workspace">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[#dedbd0] px-3 dark:border-[#30302e]">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-[#141413] dark:text-[#faf9f5]">{projectName}</div>
          <div className="truncate text-[10px] leading-none text-[#87867f] dark:text-[#8f8d86]">
            {fileCountLabel}
            {entriesTruncated ? ` · ${t('codeAgentWorkspacePartial')}` : ''}
            {remoteSearchPending ? ` · ${t('codeAgentSearchingWorkspaceFiles')}` : ''}
            {remoteSearchTruncated ? ` · ${t('codeAgentWorkspaceSearchPartial')}` : ''}
          </div>
        </div>
        <button type="button" className="rounded-md p-1.5 text-[#87867f] hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]" aria-label={t('codeAgentSearchWorkspaceFiles')} onClick={() => model.openSearch()}>
          <Search className="h-3.5 w-3.5" />
        </button>
        <button type="button" className="rounded-md p-1.5 text-[#87867f] hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]" aria-label={t('codeAgentRefreshWorkspaceFiles')} onClick={onRefresh}>
          <RefreshCw className={`h-3.5 w-3.5 ${entriesPending ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[#dedbd0] px-2 dark:border-[#30302e]">
        <button type="button" className="rounded-md p-1.5 text-[#87867f] hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]" aria-label={t('codeAgentNewFile')} onClick={onCreateFile}>
          <FilePlus2 className="h-3.5 w-3.5" />
        </button>
        <button type="button" className="rounded-md p-1.5 text-[#87867f] hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]" aria-label={t('codeAgentNewFolder')} onClick={onCreateDirectory}>
          <FolderPlus className="h-3.5 w-3.5" />
        </button>
        <button type="button" className="rounded-md p-1.5 text-[#87867f] hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]" aria-label={t('codeAgentUploadFile')} onClick={onUpload}>
          <Upload className="h-3.5 w-3.5" />
        </button>
        <div className="mx-1 h-4 w-px bg-[#dedbd0] dark:bg-[#30302e]" />
        <button type="button" disabled={!selectedPath} className="rounded-md p-1.5 text-[#87867f] hover:bg-[#f0eee6] hover:text-[#141413] disabled:cursor-not-allowed disabled:opacity-40 dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]" aria-label={t('codeAgentRenameFile')} onClick={onRename}>
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button type="button" disabled={!selectedPath} className="rounded-md p-1.5 text-[#87867f] hover:bg-[#f0eee6] hover:text-[#141413] disabled:cursor-not-allowed disabled:opacity-40 dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]" aria-label={t('codeAgentDeleteFile')} onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {entriesError && entries.length === 0 ? (
        <div className="p-4 text-xs leading-relaxed text-[#9f462c] dark:text-[#ff9b78]">{entriesError}</div>
      ) : (
        <>
          {remoteSearchError ? (
            <div className="border-b border-[#dedbd0] px-3 py-1.5 text-[11px] text-[#9f462c] dark:border-[#30302e] dark:text-[#ff9b78]">
              {remoteSearchError}
            </div>
          ) : null}
          <FileTree
            model={model}
            aria-label={`${projectName} files`}
            className="min-h-0 flex-1 overflow-hidden"
            style={{
              colorScheme: resolvedTheme,
              ['--trees-fg-override' as string]: resolvedTheme === 'dark' ? '#faf9f5' : '#141413',
            }}
          />
        </>
      )}
    </div>
  );
}

interface FilePreviewSurfaceProps {
  roomId: string;
  file: CodeWorkspaceFile | null;
  relativePath: string | null;
  fileQuery: FileQueryState;
  assetUrlQuery: AssetUrlQueryState;
  resolvedTheme: 'light' | 'dark';
  renderPreview: boolean;
  wordWrap: boolean;
  revealLine: number | null;
  revealRequestId: number;
  saveState: SaveState;
  saveError: string | null;
  onSaveStateChange: (path: string, state: SaveState, error?: string | null) => void;
  onFileSavePendingChange?: (relativePath: string, pending: boolean) => void;
  onEntriesChanged: () => void;
  onOpenWorkspaceFile: (path: string) => void;
  reviewComments: readonly ReviewCommentContext[];
  onAddReviewComment?: (comment: ReviewCommentContext) => void;
  onRemoveReviewComment?: (commentId: string) => void;
}

function FilePreviewSurface({
  roomId,
  file,
  relativePath,
  fileQuery,
  assetUrlQuery,
  resolvedTheme,
  renderPreview,
  wordWrap,
  revealLine,
  revealRequestId,
  saveState,
  saveError,
  onSaveStateChange,
  onFileSavePendingChange,
  onEntriesChanged,
  onOpenWorkspaceFile,
  reviewComments,
  onAddReviewComment,
  onRemoveReviewComment,
}: FilePreviewSurfaceProps) {
  const { t } = useTranslation();
  const onFilePostRender = useFileLineReveal(relativePath, revealLine, revealRequestId);

  useEffect(() => {
    if (relativePath) {
      onSaveStateChange(relativePath, 'idle', null);
    }
  }, [onSaveStateChange, relativePath]);

  if (!relativePath) {
    return null;
  }

  const renderBrowserAssetPreview = renderPreview && isWorkspaceBrowserPreviewPath(relativePath);
  const renderImageAssetPreview = renderPreview && isWorkspaceImagePreviewPath(relativePath);
  if (renderBrowserAssetPreview || renderImageAssetPreview) {
    if (assetUrlQuery.error) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-[#9f462c] dark:text-[#ff9b78]">
          {assetUrlQuery.error}
        </div>
      );
    }

    if (assetUrlQuery.isPending || !assetUrlQuery.resolvedUrl) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center text-[#87867f] dark:text-[#8f8d86]">
          <LoaderCircle className="h-5 w-5 animate-spin" />
        </div>
      );
    }

    return renderImageAssetPreview ? (
      <div className="min-h-0 flex-1 overflow-auto bg-[#f0eee6] p-4 dark:bg-[#141413]">
        <img src={assetUrlQuery.resolvedUrl} alt={relativePath} className="mx-auto max-h-full max-w-full object-contain" />
      </div>
    ) : (
      <iframe src={assetUrlQuery.resolvedUrl} title={relativePath} className="min-h-0 flex-1 border-0 bg-white" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
    );
  }

  if (fileQuery.error && file === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-[#9f462c] dark:text-[#ff9b78]">
        {fileQuery.error}
      </div>
    );
  }

  if (fileQuery.isPending || !file) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-[#87867f] dark:text-[#8f8d86]">
        <LoaderCircle className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  const visibleByteSize = previewedByteSize(file);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {file.truncated ? (
        <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          {t('codeAgentFilePreviewTruncated', {
            shown: visibleByteSize.toLocaleString(),
            total: file.byteSize.toLocaleString(),
          })}
        </div>
      ) : null}
      {fileQuery.error ? (
        <div className="shrink-0 border-b border-[#f0b49b]/50 bg-[#fff2ec] px-3 py-1.5 text-[11px] text-[#9f462c] dark:border-[#7a321f]/60 dark:bg-[#2a211d] dark:text-[#ff9b78]">
          {fileQuery.error}
        </div>
      ) : null}
      {saveState !== 'idle' && saveState !== 'saved' ? (
        <div className="shrink-0 border-b border-[#dedbd0] px-3 py-1.5 text-[11px] text-[#87867f] dark:border-[#30302e] dark:text-[#8f8d86]">
          {saveState === 'pending' ? t('codeAgentSavePending') : saveState === 'saving' ? t('codeAgentSaving') : saveError || 'File save failed.'}
        </div>
      ) : null}
      {file.encoding === 'base64' ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-xs text-[#87867f] dark:text-[#8f8d86]">
          <div>{t('codeAgentBinaryPreviewUnavailable')}</div>
          <button type="button" className="inline-flex items-center gap-1.5 rounded-md border border-[#dedbd0] px-2 py-1 text-[#141413] hover:bg-[#f0eee6] dark:border-[#30302e] dark:text-[#faf9f5] dark:hover:bg-[#30302e]" onClick={() => createDownload(file)}>
            <Download className="h-3.5 w-3.5" />
            {t('codeAgentDownloadFile')}
          </button>
        </div>
      ) : renderPreview && isMarkdownPreviewFile(file.path) ? (
        <RenderedMarkdownSurface
          roomId={roomId}
          file={file}
          onFileChange={fileQuery.setData}
          onSaveStateChange={onSaveStateChange}
          onFileSavePendingChange={onFileSavePendingChange}
          onEntriesChanged={onEntriesChanged}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
        />
      ) : file.truncated ? (
        <ReadOnlyFileSurface
          key={`${file.path}:${resolvedTheme}:${file.byteSize}`}
          file={file}
          resolvedTheme={resolvedTheme}
          wordWrap={wordWrap}
          onPostRender={onFilePostRender}
        />
      ) : (
        <EditableFileSurface
          key={`${file.path}:${resolvedTheme}`}
          roomId={roomId}
          file={file}
          resolvedTheme={resolvedTheme}
          wordWrap={wordWrap}
          onPostRender={onFilePostRender}
          revealRequestId={revealRequestId}
          onFileChange={fileQuery.setData}
          onSaveStateChange={onSaveStateChange}
          onFileSavePendingChange={onFileSavePendingChange}
          onEntriesChanged={onEntriesChanged}
          reviewComments={reviewComments}
          onAddReviewComment={onAddReviewComment}
          onRemoveReviewComment={onRemoveReviewComment}
        />
      )}
    </div>
  );
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
  const breadcrumbRef = useRef<HTMLDivElement | null>(null);
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
  const supportsWorkspaceAssetPreview = relativePath ? isWorkspacePreviewEntryPath(relativePath) : false;
  const canOpenInBrowserPreview = relativePath ? isWorkspaceBrowserPreviewPath(relativePath) : false;
  const supportsPreview = Boolean(relativePath && (isMarkdown || supportsWorkspaceAssetPreview));
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
    : Boolean(supportsWorkspaceAssetPreview && sourceView.path !== relativePath);
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
  const selectedDirectory = selectedKind === 'directory'
    ? selectedPath || ''
    : selectedPath
      ? parentPath(selectedPath)
      : relativePath
        ? parentPath(relativePath)
        : '';
  const breadcrumbs = useMemo(
    () => (relativePath ? fileBreadcrumbs(projectName, relativePath) : []),
    [projectName, relativePath],
  );
  const canToggleFileWordWrap = Boolean(relativePath && fileQuery.data?.encoding === 'utf-8');
  const wordWrapLabel = wordWrap
    ? t('codeAgentDisableFileLineWrapping')
    : t('codeAgentEnableFileLineWrapping');
  const previewToggleLabel = isMarkdown
    ? (renderPreview ? t('codeAgentShowMarkdownSource') : t('codeAgentShowRenderedMarkdown'))
    : (renderPreview ? t('codeAgentShowSource') : t('codeAgentShowPreview'));
  const refreshWorkspaceEntries = entriesQuery.refresh;

  useEffect(() => {
    const currentCrumb = breadcrumbRef.current?.querySelector<HTMLElement>(
      '[data-current-file-crumb="true"]',
    );
    currentCrumb?.scrollIntoView?.({ block: 'nearest', inline: 'end' });
  }, [relativePath]);

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

  const handleOpenEntry = useCallback((path: string, kind: ProjectEntry['kind']) => {
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

  const handleOpenInBrowserPreview = useCallback(() => {
    if (!relativePath || !isWorkspaceBrowserPreviewPath(relativePath)) {
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

    if (assetUrlQuery.resolvedUrl) {
      openResolvedUrl(assetUrlQuery.resolvedUrl);
      return;
    }

    const targetPath = relativePath;
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
  }, [assetUrlQuery.resolvedUrl, relativePath, roomId, t]);

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

  return (
    <div
      ref={panelRef}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[#faf9f5] dark:bg-[#1d1d1b]"
      data-file-browser-panel={`${roomId}:workspace`}
      style={{ ['--workspace-file-explorer-width' as string]: `${explorerWidth}px` }}
    >
      {relativePath ? (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[#dedbd0] px-3 dark:border-[#30302e]" data-surface-subheader>
          <div
            ref={breadcrumbRef}
            className="min-w-0 flex-1 overflow-x-auto text-xs [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            data-file-breadcrumbs="true"
            data-testid="code-agent-file-breadcrumbs"
          >
            <div className="flex h-full w-max min-w-full items-center">
              {breadcrumbs.map((crumb, index) => (
                <div
                  key={crumb.path || 'project'}
                  className="flex min-w-0 shrink-0 items-center"
                  data-current-file-crumb={crumb.kind === 'file'}
                >
                  {index > 0 ? <ChevronRight className="mx-1 h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]" /> : null}
                  <span
                    className={`max-w-40 truncate ${crumb.kind === 'file' ? 'font-medium text-[#141413] dark:text-[#faf9f5]' : 'text-[#87867f] dark:text-[#8f8d86]'}`}
                    title={crumb.path || projectName}
                  >
                    {crumb.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
          {fileQuery.data ? (
            <button type="button" className="rounded-md p-1.5 text-[#87867f] hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]" aria-label={t('codeAgentDownloadFile')} onClick={() => createDownload(fileQuery.data!)}>
              <Download className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {canToggleFileWordWrap ? (
            <button
              type="button"
              className={`rounded-md p-1.5 transition-colors hover:bg-[#f0eee6] hover:text-[#141413] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5] ${
                wordWrap
                  ? 'text-[#9f462c] dark:text-[#ffb197]'
                  : 'text-[#87867f] dark:text-[#8f8d86]'
              }`}
              aria-label={wordWrapLabel}
              aria-pressed={wordWrap}
              title={wordWrapLabel}
              onClick={toggleWordWrap}
            >
              <WrapText className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {canOpenInBrowserPreview ? (
            <button
              type="button"
              className="rounded-md p-1.5 text-[#87867f] hover:bg-[#f0eee6] hover:text-[#141413] disabled:cursor-wait disabled:opacity-60 dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]"
              aria-label={t('codeAgentOpenFileInPreview')}
              disabled={browserPreviewPending}
              onClick={handleOpenInBrowserPreview}
            >
              {browserPreviewPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Globe2 className="h-3.5 w-3.5" />}
            </button>
          ) : null}
          {supportsPreview ? (
            <button
              type="button"
              className="rounded-md p-1.5 text-[#87867f] hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]"
              aria-label={previewToggleLabel}
              aria-pressed={renderPreview}
              onClick={togglePreviewView}
            >
              {renderPreview ? <Code2 className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          ) : null}
          <button type="button" className="rounded-md p-1.5 text-[#87867f] hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]" aria-label={explorerOpen ? t('codeAgentHideFileExplorer') : t('codeAgentShowFileExplorer')} onClick={toggleExplorer}>
            <FolderTree className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
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
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className={`${relativePath ? 'flex' : 'hidden'} min-w-0 flex-1 flex-col overflow-hidden`}>
            <FilePreviewSurface
              roomId={roomId}
              file={fileQuery.data}
              relativePath={relativePath}
              fileQuery={fileQuery}
              assetUrlQuery={assetUrlQuery}
              resolvedTheme={resolvedTheme}
              renderPreview={renderPreview}
              wordWrap={wordWrap}
              revealLine={effectiveRevealLine}
              revealRequestId={effectiveRevealRequestId}
              saveState={activeSaveState}
              saveError={activeSaveError}
              onSaveStateChange={handleSaveStateChange}
              onFileSavePendingChange={onFileSavePendingChange}
              onEntriesChanged={refreshEntries}
              onOpenWorkspaceFile={handleOpenWorkspaceFileFromMarkdown}
              reviewComments={reviewComments}
              onAddReviewComment={onAddReviewComment}
              onRemoveReviewComment={onRemoveReviewComment}
            />
          </div>
          {explorerOpen || relativePath === null ? (
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
                  className="absolute inset-y-0 -left-4 z-40 w-8 cursor-col-resize touch-none border-x border-transparent transition-colors hover:border-[#c96442]/30 hover:bg-[#c96442]/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442]"
                  onPointerDown={handleExplorerResizeStart}
                />
              ) : null}
              <FileBrowserPanel
                projectName={projectName}
                entries={entries}
                entryKinds={entryKinds}
                entriesPending={entriesQuery.isPending}
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
          ) : null}
        </div>
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
