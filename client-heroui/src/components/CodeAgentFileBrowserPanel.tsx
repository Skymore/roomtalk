import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Editor } from '@pierre/diffs/editor';
import { EditorProvider, File as DiffFile, Virtualizer } from '@pierre/diffs/react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import type { FileTreeIcons } from '@pierre/trees';
import {
  ChevronRight,
  Code2,
  Download,
  Eye,
  FilePlus2,
  FolderPlus,
  FolderTree,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Upload,
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
import { projectFileCacheKey } from './codeAgentFileContentRevision';
import { FileSaveCoordinator } from './codeAgentFileSaveCoordinator';

const MarkdownContent = React.lazy(() =>
  import('./MarkdownContent').then((module) => ({ default: module.MarkdownContent })),
);

interface CodeAgentFileBrowserPanelProps {
  roomId: string;
  projectName: string;
  sandboxStatus?: RoomSandboxStatus;
  sandboxUpdatedAt?: string;
}

type ProjectEntry = {
  path: string;
  kind: 'file' | 'directory';
};

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

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
const FILE_EXPLORER_STORAGE_KEY = 'roomtalk.codeWorkspace.fileExplorerOpen';
const FILE_EXPLORER_WIDTH_STORAGE_KEY = 'roomtalk.codeWorkspace.fileExplorerWidth';
const FILE_EXPLORER_MIN_WIDTH = 180;
const FILE_PREVIEW_MIN_WIDTH = 180;
const FILE_EXPLORER_DEFAULT_WIDTH = 352;

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
  return path.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function parentPath(path: string): string {
  const normalizedPath = normalizeWorkspacePath(path);
  const index = normalizedPath.lastIndexOf('/');
  return index > 0 ? normalizedPath.slice(0, index) : '';
}

function joinWorkspacePath(directory: string, name: string): string {
  return [normalizeWorkspacePath(directory), normalizeWorkspacePath(name)].filter(Boolean).join('/');
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
  const [data, setData] = useState<CodeWorkspaceFile | null>(null);
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

    loadCodeWorkspaceFile(roomId, relativePath, { signal: controller.signal }).then(
      (file) => {
        if (controller.signal.aborted || requestIdRef.current !== requestId) {
          return;
        }
        setData(file);
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
  }, [enabled, roomId, relativePath]);

  return { data, error, isPending, setData };
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

function isMarkdownPreview(path: string) {
  return /\.(md|mdx)$/i.test(path);
}

interface EditableFileSurfaceProps {
  roomId: string;
  file: CodeWorkspaceFile;
  resolvedTheme: 'light' | 'dark';
  onFileChange: React.Dispatch<React.SetStateAction<CodeWorkspaceFile | null>>;
  onSaveStateChange: (state: SaveState, error?: string | null) => void;
  onEntriesChanged: () => void;
}

function EditableFileSurface({
  roomId,
  file,
  resolvedTheme,
  onFileChange,
  onSaveStateChange,
  onEntriesChanged,
}: EditableFileSurfaceProps) {
  const filePath = file.path;

  useEffect(() => {
    onSaveStateChange('idle', null);
    // Reset persistence state only when T3 mounts a different file surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  const setFileContents = useCallback((contents: string) => {
    onFileChange((current) => current ? {
      ...current,
      content: contents,
      byteSize: new TextEncoder().encode(contents).byteLength,
      truncated: false,
      encoding: 'utf-8',
    } : current);
  }, [onFileChange]);

  const saveCoordinator = useMemo(
    () => new FileSaveCoordinator({
      debounceMs: FILE_SAVE_DEBOUNCE_MS,
      onPendingChange: (pending) => onSaveStateChange(pending ? 'pending' : 'saved', null),
      persist: async (contents) => {
        onSaveStateChange('saving', null);
        try {
          await writeCodeWorkspaceFile(roomId, filePath, contents, 'utf-8');
          onEntriesChanged();
          return { _tag: 'Success' };
        } catch (error) {
          onSaveStateChange('error', error instanceof Error ? error.message : 'File save failed.');
          return { _tag: 'Failure' };
        }
      },
      onConfirmed: (contents) => {
        setFileContents(contents);
      },
    }),
    [filePath, onEntriesChanged, onSaveStateChange, roomId, setFileContents],
  );

  useEffect(() => () => saveCoordinator.dispose(), [saveCoordinator]);

  const editor = useMemo(() => {
    return new Editor({
      onChange: (nextFile) => {
        setFileContents(nextFile.contents);
        saveCoordinator.change(nextFile.contents);
      },
    });
  }, [saveCoordinator, setFileContents]);

  useEffect(() => () => {
    editor.cleanUp();
  }, [editor]);

  return (
    <EditorProvider editor={editor}>
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
              overflow: 'scroll',
              theme: resolvedTheme === 'dark' ? 'pierre-dark' : 'pierre-light',
              themeType: resolvedTheme,
            }}
            className="min-h-full"
            contentEditable
          />
        </Virtualizer>
      </div>
    </EditorProvider>
  );
}

interface RenderedMarkdownSurfaceProps {
  contents: string;
}

function RenderedMarkdownSurface({ contents }: RenderedMarkdownSurfaceProps) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-5 text-[#141413] dark:text-[#faf9f5]">
        <React.Suspense fallback={<LoaderCircle className="h-5 w-5 animate-spin text-[#87867f] dark:text-[#8f8d86]" />}>
          <MarkdownContent content={contents} />
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
  onOpenEntry: (relativePath: string) => void;
  onRefresh: () => void;
  onCreateFile: () => void;
  onCreateDirectory: () => void;
  onUpload: () => void;
  onRename: () => void;
  onDelete: () => void;
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
      if (nextPath && entryKindsRef.current.has(nextPath)) {
        onOpenEntry(nextPath);
      }
    },
    paths: [],
    search: true,
    unsafeCSS: TREE_UNSAFE_CSS,
  });

  useEffect(() => {
    if (previousTreePathsRef.current === treePaths) return;
    entryKindsRef.current = entryKinds;
    previousTreePathsRef.current = treePaths;
    model.resetPaths(treePaths);
  }, [entryKinds, model, treePaths]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#faf9f5] dark:bg-[#1d1d1b]" data-file-browser-panel="t3-workspace">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[#dedbd0] px-3 dark:border-[#30302e]">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-[#141413] dark:text-[#faf9f5]">{projectName}</div>
          <div className="truncate text-[10px] leading-none text-[#87867f] dark:text-[#8f8d86]">
            {entriesPending && entries.length === 0 ? 'Indexing...' : `${fileCount.toLocaleString()} files`}
            {entriesTruncated ? ' · partial' : ''}
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
        <FileTree
          model={model}
          aria-label={`${projectName} files`}
          className="min-h-0 flex-1 overflow-hidden"
          style={{
            colorScheme: resolvedTheme,
            ['--trees-fg-override' as string]: resolvedTheme === 'dark' ? '#faf9f5' : '#141413',
          }}
        />
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
  saveState: SaveState;
  saveError: string | null;
  onSaveStateChange: (state: SaveState, error?: string | null) => void;
  onEntriesChanged: () => void;
}

function FilePreviewSurface({
  roomId,
  file,
  relativePath,
  fileQuery,
  assetUrlQuery,
  resolvedTheme,
  renderPreview,
  saveState,
  saveError,
  onSaveStateChange,
  onEntriesChanged,
}: FilePreviewSurfaceProps) {
  const { t } = useTranslation();

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

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {file.truncated ? (
        <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          Preview limited to the first 1 MB of a {file.byteSize.toLocaleString()} byte file.
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
      ) : renderPreview && isMarkdownPreview(file.path) ? (
        <RenderedMarkdownSurface contents={file.content} />
      ) : (
        <EditableFileSurface
          key={`${file.path}:${resolvedTheme}`}
          roomId={roomId}
          file={file}
          resolvedTheme={resolvedTheme}
          onFileChange={fileQuery.setData}
          onSaveStateChange={onSaveStateChange}
          onEntriesChanged={onEntriesChanged}
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
}) => {
  const { t } = useTranslation();
  const resolvedTheme = useResolvedTheme();
  const entriesQuery = useCodeWorkspaceEntriesQuery(roomId);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [explorerOpen, setExplorerOpen] = useState(initialExplorerOpen);
  const [explorerWidth, setExplorerWidth] = useState(() => initialExplorerWidth());
  const explorerWidthRef = useRef(explorerWidth);
  const explorerResizeCleanupRef = useRef<(() => void) | null>(null);
  const [sourceView, setSourceView] = useState<{ path: string | null }>({ path: null });
  const workspaceReadyKey = `${sandboxStatus || 'none'}:${sandboxUpdatedAt || ''}`;
  const previousWorkspaceReadyKeyRef = useRef(workspaceReadyKey);

  const entries = useMemo(
    () => projectEntriesFromWorkspace(entriesQuery.data?.entries ?? []),
    [entriesQuery.data?.entries],
  );
  const entryKinds = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry.kind] as const)),
    [entries],
  );
  const selectedKind = selectedPath ? entryKinds.get(selectedPath) : undefined;
  const relativePath = selectedPath && selectedKind === 'file' ? selectedPath : null;
  const isMarkdown = relativePath ? isMarkdownPreview(relativePath) : false;
  const supportsWorkspaceAssetPreview = relativePath ? isWorkspacePreviewEntryPath(relativePath) : false;
  const supportsPreview = Boolean(relativePath && (isMarkdown || supportsWorkspaceAssetPreview));
  const renderPreview = supportsPreview && sourceView.path !== relativePath;
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
      : '';
  const breadcrumbs = useMemo(
    () => (relativePath ? fileBreadcrumbs(projectName, relativePath) : []),
    [projectName, relativePath],
  );
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
    if (!entriesQuery.isPending && selectedPath && !entryKinds.has(selectedPath)) {
      setSelectedPath(null);
    }
  }, [entriesQuery.isPending, entryKinds, selectedPath]);

  useEffect(() => {
    const previousKey = previousWorkspaceReadyKeyRef.current;
    previousWorkspaceReadyKeyRef.current = workspaceReadyKey;
    if (sandboxStatus === 'ready' && previousKey !== workspaceReadyKey) {
      refreshWorkspaceEntries();
    }
  }, [refreshWorkspaceEntries, sandboxStatus, workspaceReadyKey]);

  useEffect(() => {
    setSourceView({ path: null });
  }, [relativePath]);

  const refreshEntries = useCallback(() => {
    refreshWorkspaceEntries();
  }, [refreshWorkspaceEntries]);

  const mutate = useCallback(async (operation: () => unknown, nextSelectedPath?: string | null) => {
    setOperationError(null);
    try {
      await operation();
      if (nextSelectedPath !== undefined) {
        setSelectedPath(nextSelectedPath);
      }
      refreshEntries();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Workspace file operation failed.');
    }
  }, [refreshEntries]);

  const handleOpenEntry = useCallback((path: string) => {
    setSelectedPath(path);
    setOperationError(null);
  }, []);

  const handleCreateFile = useCallback(() => {
    const path = window.prompt(t('codeAgentNewFilePrompt'), joinWorkspacePath(selectedDirectory, 'untitled.txt'));
    const normalizedPath = path ? normalizeWorkspacePath(path) : '';
    if (!normalizedPath) return;
    void mutate(() => writeCodeWorkspaceFile(roomId, normalizedPath, '', 'utf-8'), normalizedPath);
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
    void mutate(() => renameCodeWorkspaceEntry(roomId, selectedPath, normalizedPath), normalizedPath);
  }, [mutate, roomId, selectedPath, t]);

  const handleDelete = useCallback(() => {
    if (!selectedPath) return;
    if (!window.confirm(t('codeAgentDeleteConfirm', { path: selectedPath }))) return;
    void mutate(() => deleteCodeWorkspaceEntry(roomId, selectedPath), null);
  }, [mutate, roomId, selectedPath, t]);

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
    setSourceView((current) => ({
      path: current.path === relativePath ? null : relativePath,
    }));
  }, [relativePath]);

  const handleSaveStateChange = useCallback((state: SaveState, error: string | null = null) => {
    setSaveState(state);
    setSaveError(error);
  }, []);

  return (
    <div
      ref={panelRef}
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#faf9f5] dark:bg-[#1d1d1b]"
      data-file-browser-panel={`${roomId}:workspace`}
      style={{ ['--workspace-file-explorer-width' as string]: `${explorerWidth}px` }}
    >
      {relativePath ? (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[#dedbd0] px-3 dark:border-[#30302e]" data-surface-subheader>
          <div className="flex min-w-0 flex-1 items-center overflow-hidden text-xs">
            {breadcrumbs.map((crumb, index) => (
              <React.Fragment key={crumb.path || 'project'}>
                {index > 0 ? <ChevronRight className="mx-1 h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]" /> : null}
                <span className={`truncate ${crumb.kind === 'file' ? 'font-medium text-[#141413] dark:text-[#faf9f5]' : 'text-[#87867f] dark:text-[#8f8d86]'}`} title={crumb.path || projectName}>
                  {crumb.label}
                </span>
              </React.Fragment>
            ))}
          </div>
          {fileQuery.data ? (
            <button type="button" className="rounded-md p-1.5 text-[#87867f] hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]" aria-label={t('codeAgentDownloadFile')} onClick={() => createDownload(fileQuery.data!)}>
              <Download className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {supportsPreview ? (
            <button
              type="button"
              className="rounded-md p-1.5 text-[#87867f] hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]"
              aria-label={renderPreview ? t('codeAgentShowMarkdownSource') : t('codeAgentShowRenderedMarkdown')}
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
            saveState={saveState}
            saveError={saveError}
            onSaveStateChange={handleSaveStateChange}
            onEntriesChanged={refreshEntries}
          />
        </div>
        {explorerOpen || relativePath === null ? (
          <aside
            className={`${relativePath ? 'relative min-w-[180px] border-l border-[#dedbd0] dark:border-[#30302e]' : 'min-w-0 flex-1'} flex min-h-0 shrink-0 bg-[#faf9f5] dark:bg-[#1d1d1b]`}
            style={relativePath ? {
              width: 'var(--workspace-file-explorer-width)',
              maxWidth: `calc(100% - ${FILE_PREVIEW_MIN_WIDTH}px)`,
            } : undefined}
          >
            {relativePath ? (
              <button
                type="button"
                aria-label={t('codeAgentResizeFileExplorer')}
                className="absolute inset-y-0 -left-1 z-40 w-2 cursor-col-resize touch-none border-x border-transparent transition-colors hover:border-[#c96442]/30 hover:bg-[#c96442]/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442]"
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
            />
          </aside>
        ) : null}
      </div>
      {operationError ? (
        <div className="border-t border-[#dedbd0] px-3 py-2 text-[11px] text-[#9f462c] dark:border-[#30302e] dark:text-[#ff9b78]">
          {operationError}
        </div>
      ) : null}
      <input ref={uploadInputRef} type="file" className="hidden" multiple onChange={handleUpload} />
    </div>
  );
};
