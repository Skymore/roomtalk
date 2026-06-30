import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { VirtualizedFile } from '@pierre/diffs';
import { Editor } from '@pierre/diffs/editor';
import { EditorProvider, File as DiffFile, type FileOptions, Virtualizer } from '@pierre/diffs/react';
import { FileTree, useFileTree, useFileTreeSearch } from '@pierre/trees/react';
import type { FileTreeIcons } from '@pierre/trees';
import {
  ChevronRight,
  Code2,
  Download,
  Eye,
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
import { installFileEditorDismissal } from './codeAgentFileEditorDismissal';
import { projectFileCacheKey } from './codeAgentFileContentRevision';
import { FileSaveCoordinator } from './codeAgentFileSaveCoordinator';
import { isMarkdownPreviewFile, setMarkdownTaskChecked } from './codeAgentFilePreviewMode';

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
const FILE_EXPLORER_MIN_WIDTH = 180;
const FILE_PREVIEW_MIN_WIDTH = 180;
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
    setData(fileCacheRef.current.get(normalizedPath) ?? null);
    setError(null);
    setIsPending(true);

    loadCodeWorkspaceFile(roomId, normalizedPath, { signal: controller.signal }).then(
      (file) => {
        if (controller.signal.aborted || requestIdRef.current !== requestId) {
          return;
        }
        fileCacheRef.current.set(normalizeWorkspacePath(file.path), file);
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
  onFileChange: React.Dispatch<React.SetStateAction<CodeWorkspaceFile | null>>;
  onSaveStateChange: (path: string, state: SaveState, error?: string | null) => void;
  onEntriesChanged: () => void;
}

function EditableFileSurface({
  roomId,
  file,
  resolvedTheme,
  wordWrap,
  onPostRender,
  onFileChange,
  onSaveStateChange,
  onEntriesChanged,
}: EditableFileSurfaceProps) {
  const filePath = file.path;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const latestDraftContentsRef = useRef(file.content);

  useEffect(() => {
    onSaveStateChange(filePath, 'idle', null);
    latestDraftContentsRef.current = file.content;
    // Reset persistence state only when T3 mounts a different file surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  const setDraftFileContents = useCallback((contents: string) => {
    latestDraftContentsRef.current = contents;
    onFileChange((current) => updateWorkspaceFileContents(current, filePath, contents));
  }, [filePath, onFileChange]);

  const confirmFileContents = useCallback((contents: string) => {
    if (latestDraftContentsRef.current !== contents) {
      return;
    }
    onFileChange((current) => updateWorkspaceFileContents(current, filePath, contents));
  }, [filePath, onFileChange]);

  const saveCoordinator = useMemo(
    () => new FileSaveCoordinator({
      debounceMs: FILE_SAVE_DEBOUNCE_MS,
      onPendingChange: (pending) => onSaveStateChange(filePath, pending ? 'pending' : 'saved', null),
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
    [confirmFileContents, filePath, onEntriesChanged, onSaveStateChange, roomId],
  );

  useEffect(() => () => saveCoordinator.dispose(), [saveCoordinator]);

  const editor = useMemo(() => {
    return new Editor({
      onChange: (nextFile) => {
        setDraftFileContents(nextFile.contents);
        saveCoordinator.change(nextFile.contents);
      },
    });
  }, [saveCoordinator, setDraftFileContents]);

  useEffect(() => () => {
    editor.cleanUp();
  }, [editor]);

  useEffect(() => {
    const root = surfaceRef.current;
    if (!root) return undefined;
    return installFileEditorDismissal({
      root,
      editor,
      isBlocked: () => false,
      onDismiss: () => undefined,
    });
  }, [editor]);

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
  onEntriesChanged: () => void;
  onOpenWorkspaceFile: (path: string) => void;
}

function RenderedMarkdownSurface({
  roomId,
  file,
  onFileChange,
  onSaveStateChange,
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
    onFileChange((current) => updateWorkspaceFileContents(current, filePath, contents));
  }, [filePath, onFileChange]);

  const confirmFileContents = useCallback((contents: string) => {
    if (latestDraftContentsRef.current !== contents) {
      return;
    }
    onFileChange((current) => updateWorkspaceFileContents(current, filePath, contents));
  }, [filePath, onFileChange]);

  const saveCoordinator = useMemo(
    () => new FileSaveCoordinator({
      debounceMs: FILE_SAVE_DEBOUNCE_MS,
      onPendingChange: (pending) => onSaveStateChange(filePath, pending ? 'pending' : 'saved', null),
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
    [confirmFileContents, filePath, onEntriesChanged, onSaveStateChange, roomId],
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
              const currentContents = fileRef.current.content;
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
  onOpenEntry: (relativePath: string) => void;
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
      if (nextPath && entryKindsRef.current.has(nextPath)) {
        onOpenEntry(nextPath);
      }
    },
    paths: [],
    search: true,
    unsafeCSS: TREE_UNSAFE_CSS,
  });
  const treeSearch = useFileTreeSearch(model);

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
            {entriesPending && entries.length === 0 ? 'Indexing...' : `${fileCount.toLocaleString()} files`}
            {entriesTruncated ? ' · partial' : ''}
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
  onEntriesChanged: () => void;
  onOpenWorkspaceFile: (path: string) => void;
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
  onEntriesChanged,
  onOpenWorkspaceFile,
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
          Preview limited to {visibleByteSize.toLocaleString()} of {file.byteSize.toLocaleString()} bytes.
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
  openFileRequest = null,
  revealLine = null,
  revealRequestId = 0,
}) => {
  const { t } = useTranslation();
  const resolvedTheme = useResolvedTheme();
  const entriesQuery = useCodeWorkspaceEntriesQuery(roomId);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const breadcrumbRef = useRef<HTMLDivElement | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
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
  const selectedKind = selectedPath
    ? entryKinds.get(selectedPath) ?? (selectedPath === externallySelectedFilePath ? 'file' : undefined)
    : undefined;
  const relativePath = selectedPath && selectedKind === 'file' ? selectedPath : null;
  const isMarkdown = relativePath ? isMarkdownPreviewFile(relativePath) : false;
  const supportsWorkspaceAssetPreview = relativePath ? isWorkspacePreviewEntryPath(relativePath) : false;
  const canOpenInBrowserPreview = relativePath ? isWorkspaceBrowserPreviewPath(relativePath) : false;
  const supportsPreview = Boolean(relativePath && (isMarkdown || supportsWorkspaceAssetPreview));
  const localRevealApplies = Boolean(
    localOpenFileRequest &&
    localOpenFileRequest.path === relativePath,
  );
  const effectiveRevealLine = localRevealApplies ? localOpenFileRequest?.line ?? null : revealLine;
  const effectiveRevealRequestId = localRevealApplies ? localOpenFileRequest?.requestId ?? 0 : revealRequestId;
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
      : '';
  const breadcrumbs = useMemo(
    () => (relativePath ? fileBreadcrumbs(projectName, relativePath) : []),
    [projectName, relativePath],
  );
  const canToggleFileWordWrap = Boolean(relativePath && fileQuery.data?.encoding === 'utf-8');
  const wordWrapLabel = wordWrap
    ? t('codeAgentDisableFileLineWrapping')
    : t('codeAgentEnableFileLineWrapping');
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
    if (!openFileRequest?.path) {
      return;
    }
    const normalizedPath = normalizeWorkspacePath(openFileRequest.path);
    if (!normalizedPath) {
      return;
    }
    setSelectedPath(normalizedPath);
    setExternallySelectedFilePath(normalizedPath);
    setLocalOpenFileRequest(null);
    setOperationError(null);
  }, [openFileRequest?.path, openFileRequest?.requestId]);

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
    setExternallySelectedFilePath(null);
    setLocalOpenFileRequest(null);
    setOperationError(null);
  }, []);

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
    setExternallySelectedFilePath(target.path);
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
            wordWrap={wordWrap}
            revealLine={effectiveRevealLine}
            revealRequestId={effectiveRevealRequestId}
            saveState={activeSaveState}
            saveError={activeSaveError}
            onSaveStateChange={handleSaveStateChange}
            onEntriesChanged={refreshEntries}
            onOpenWorkspaceFile={handleOpenWorkspaceFileFromMarkdown}
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
                className="absolute inset-y-0 -left-3 z-40 w-6 cursor-col-resize touch-none border-x border-transparent transition-colors hover:border-[#c96442]/30 hover:bg-[#c96442]/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442]"
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
      {operationError ? (
        <div className="border-t border-[#dedbd0] px-3 py-2 text-[11px] text-[#9f462c] dark:border-[#30302e] dark:text-[#ff9b78]">
          {operationError}
        </div>
      ) : null}
      <input ref={uploadInputRef} type="file" className="hidden" multiple onChange={handleUpload} />
    </div>
  );
};
