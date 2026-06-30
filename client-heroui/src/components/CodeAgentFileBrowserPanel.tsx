import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import type { FileTreeIcons } from '@pierre/trees';
import { RefreshCw, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { loadCodeWorkspaceEntries, loadCodeWorkspaceFile, type CodeWorkspaceEntry, type CodeWorkspaceFile } from '../utils/codeWorkspaceFiles';

interface CodeAgentFileBrowserPanelProps {
  roomId: string;
  projectName: string;
}

type ProjectEntry = {
  path: string;
  kind: 'file' | 'directory';
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

const treePath = (entry: ProjectEntry): string => (
  entry.kind === 'directory' ? `${entry.path}/` : entry.path
);

const projectEntriesFromWorkspace = (entries: readonly CodeWorkspaceEntry[]): ProjectEntry[] => {
  const byPath = new Map<string, ProjectEntry>();

  for (const entry of entries) {
    const normalizedPath = entry.path.replace(/^\/+/, '').replace(/\/+$/, '');
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
};

const readResolvedTheme = () => (
  typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
    ? 'dark'
    : 'light'
);

const useResolvedTheme = () => {
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
};

const useCodeWorkspaceEntriesQuery = (roomId: string) => {
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
};

const decodeWorkspaceFile = (file: CodeWorkspaceFile): BlobPart => {
  if (file.encoding === 'utf-8') {
    return file.content;
  }

  const binary = window.atob(file.content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const inferMimeType = (path: string, encoding: CodeWorkspaceFile['encoding']) => {
  if (encoding === 'base64') {
    if (/\.(png)$/i.test(path)) return 'image/png';
    if (/\.(jpe?g)$/i.test(path)) return 'image/jpeg';
    if (/\.(gif)$/i.test(path)) return 'image/gif';
    if (/\.(webp)$/i.test(path)) return 'image/webp';
    if (/\.(svg)$/i.test(path)) return 'image/svg+xml';
    if (/\.(pdf)$/i.test(path)) return 'application/pdf';
    return 'application/octet-stream';
  }
  if (/\.(html?)$/i.test(path)) return 'text/html;charset=utf-8';
  if (/\.(json)$/i.test(path)) return 'application/json;charset=utf-8';
  if (/\.(css)$/i.test(path)) return 'text/css;charset=utf-8';
  if (/\.(js|mjs|cjs|ts|tsx|jsx)$/i.test(path)) return 'text/javascript;charset=utf-8';
  return 'text/plain;charset=utf-8';
};

const openBlankPreviewWindow = (path: string): Window | null => {
  const previewWindow = window.open('about:blank', '_blank');
  if (!previewWindow) {
    return null;
  }

  try {
    previewWindow.opener = null;
    previewWindow.document.title = path;
    previewWindow.document.body.style.margin = '0';
    previewWindow.document.body.style.padding = '16px';
    previewWindow.document.body.style.fontFamily = 'system-ui, sans-serif';
    previewWindow.document.body.textContent = 'Loading file preview...';
  } catch {
    // Some browsers restrict access to the blank tab immediately after opening.
  }

  return previewWindow;
};

const openWorkspaceFile = async (roomId: string, relativePath: string, previewWindow: Window | null) => {
  if (!previewWindow) {
    throw new Error('Browser blocked file preview. Enable pop-ups for this site and try again.');
  }

  const file = await loadCodeWorkspaceFile(roomId, relativePath);
  const blob = new Blob([decodeWorkspaceFile(file)], {
    type: inferMimeType(file.path, file.encoding),
  });
  const url = URL.createObjectURL(blob);
  try {
    previewWindow.location.replace(url);
  } catch {
    previewWindow.location.href = url;
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

export const CodeAgentFileBrowserPanel: React.FC<CodeAgentFileBrowserPanelProps> = ({
  roomId,
  projectName,
}) => {
  const { t } = useTranslation();
  const resolvedTheme = useResolvedTheme();
  const entriesQuery = useCodeWorkspaceEntriesQuery(roomId);
  const entries = useMemo(
    () => projectEntriesFromWorkspace(entriesQuery.data?.entries ?? []),
    [entriesQuery.data?.entries],
  );
  const entryKinds = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry.kind] as const)),
    [entries],
  );
  const entryKindsRef = useRef<ReadonlyMap<string, ProjectEntry['kind']>>(entryKinds);
  const treePaths = useMemo(() => entries.map(treePath), [entries]);
  const previousTreePathsRef = useRef<readonly string[]>([]);
  const [openError, setOpenError] = useState<string | null>(null);

  const { model } = useFileTree({
    density: 'compact',
    fileTreeSearchMode: 'hide-non-matches',
    flattenEmptyDirectories: true,
    initialExpansion: 1,
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, '');
      if (selectedPath && entryKindsRef.current.get(selectedPath) === 'file') {
        setOpenError(null);
        const previewWindow = openBlankPreviewWindow(selectedPath);
        void openWorkspaceFile(roomId, selectedPath, previewWindow).catch((error) => {
          console.error('Failed to open workspace file:', error);
          setOpenError(error instanceof Error ? error.message : 'File open failed.');
        });
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

  const fileCount = useMemo(
    () => entries.reduce((count, entry) => count + (entry.kind === 'file' ? 1 : 0), 0),
    [entries],
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-[#faf9f5] dark:bg-[#1d1d1b]"
      data-file-browser-panel={`${roomId}:workspace`}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[#dedbd0] px-3 dark:border-[#30302e]">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-[#141413] dark:text-[#faf9f5]">{projectName}</div>
          <div className="truncate text-[10px] leading-none text-[#87867f] dark:text-[#8f8d86]">
            {entriesQuery.isPending && entriesQuery.data === null
              ? 'Indexing...'
              : `${fileCount.toLocaleString()} files`}
            {entriesQuery.data?.truncated ? ' · partial' : ''}
          </div>
        </div>
        <button
          type="button"
          className="rounded-md p-1.5 text-[#87867f] hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]"
          aria-label={t('codeAgentSearchWorkspaceFiles')}
          onClick={() => model.openSearch()}
        >
          <Search className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="rounded-md p-1.5 text-[#87867f] hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]"
          aria-label={t('codeAgentRefreshWorkspaceFiles')}
          onClick={entriesQuery.refresh}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${entriesQuery.isPending ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {entriesQuery.error && entriesQuery.data === null ? (
        <div className="p-4 text-xs leading-relaxed text-[#9f462c] dark:text-[#ff9b78]">{entriesQuery.error}</div>
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
      {openError && (
        <div className="border-t border-[#dedbd0] px-3 py-2 text-[11px] text-[#9f462c] dark:border-[#30302e] dark:text-[#ff9b78]">
          {openError}
        </div>
      )}
    </div>
  );
};
