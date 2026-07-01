import { FileTree, useFileTree, useFileTreeSearch } from '@pierre/trees/react';
import {
  FilePlus2,
  FolderPlus,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { T3_PIERRE_ICONS } from '../utils/codeAgentPierreIcons';

export type CodeAgentProjectEntry = {
  path: string;
  kind: 'file' | 'directory';
};

interface CodeAgentWorkspaceFileTreePanelProps {
  projectName: string;
  entries: CodeAgentProjectEntry[];
  entryKinds: ReadonlyMap<string, CodeAgentProjectEntry['kind']>;
  entriesPending: boolean;
  entriesLoaded: boolean;
  entriesError: string | null;
  entriesTruncated: boolean;
  selectedPath: string | null;
  resolvedTheme: 'light' | 'dark';
  onOpenEntry: (relativePath: string, kind: CodeAgentProjectEntry['kind']) => void;
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

function treePath(entry: CodeAgentProjectEntry): string {
  return entry.kind === 'directory' ? `${entry.path}/` : entry.path;
}

export function CodeAgentWorkspaceFileTreePanel({
  projectName,
  entries,
  entryKinds,
  entriesPending,
  entriesLoaded,
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
}: CodeAgentWorkspaceFileTreePanelProps) {
  const { t } = useTranslation();
  const entryKindsRef = useRef<ReadonlyMap<string, CodeAgentProjectEntry['kind']>>(entryKinds);
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
  const fileCountLabel = entriesPending && !entriesLoaded
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
