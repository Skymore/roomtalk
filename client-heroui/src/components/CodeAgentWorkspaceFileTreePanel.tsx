import { FileTree, useFileTree, useFileTreeSearch } from '@pierre/trees/react';
import {
  ArrowLeft,
  ChevronRight,
  FilePlus2,
  FolderPlus,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buildCodeAgentMobileFileTree,
  codeAgentMobileAncestorPaths,
  codeAgentMobileFileTreePath,
  defaultExpandedCodeAgentMobileTreePaths,
  flattenCodeAgentMobileFileTree,
  type CodeAgentMobileFileTreeEntry,
} from '../utils/codeAgentMobileFileTree';
import { T3_PIERRE_ICONS } from '../utils/codeAgentPierreIcons';
import { CodeAgentPierreEntryIcon } from './CodeAgentPierreEntryIcon';

export type CodeAgentProjectEntry = CodeAgentMobileFileTreeEntry;

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
  workspaceEditable?: boolean;
  onSearchQueryChange: (query: string) => void;
  remoteSearchPending: boolean;
  remoteSearchError: string | null;
  remoteSearchTruncated: boolean;
  mobileLayout?: boolean;
  onBackToPreview?: () => void;
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

const MOBILE_PULL_REFRESH_THRESHOLD = 72;
const MOBILE_PULL_REFRESH_MAX_DISTANCE = 104;

const firstTouch = (touches: ReactTouchEvent<HTMLDivElement>['touches']) => (
  typeof touches.item === 'function' ? touches.item(0) : touches[0]
);

function CodeAgentMobileFileTreeList({
  entries,
  entriesPending,
  entriesError,
  searchQuery,
  selectedPath,
  resolvedTheme,
  onRefresh,
  onOpenEntry,
}: {
  entries: CodeAgentProjectEntry[];
  entriesPending: boolean;
  entriesError: string | null;
  searchQuery: string;
  selectedPath: string | null;
  resolvedTheme: 'light' | 'dark';
  onRefresh: () => void;
  onOpenEntry: (relativePath: string, kind: CodeAgentProjectEntry['kind']) => void;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement | null>(null);
  const selectedScrollFrameRef = useRef<number | null>(null);
  const pullGestureRef = useRef<{
    pointerId: number | null;
    startY: number;
    maxDistance: number;
  }>({
    pointerId: null,
    startY: 0,
    maxDistance: 0,
  });
  const suppressNextClickRef = useRef(false);
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [pullDistance, setPullDistance] = useState(0);
  const tree = useMemo(() => buildCodeAgentMobileFileTree(entries), [entries]);
  const defaultExpanded = useMemo(() => defaultExpandedCodeAgentMobileTreePaths(tree), [tree]);
  const visibleNodes = useMemo(() => flattenCodeAgentMobileFileTree({
    nodes: tree,
    expanded: expandedPaths,
    searchQuery,
  }), [expandedPaths, searchQuery, tree]);

  useEffect(() => {
    setExpandedPaths((current) => {
      if (current.size > 0 || defaultExpanded.size === 0) {
        return current;
      }
      return new Set(defaultExpanded);
    });
  }, [defaultExpanded]);

  useEffect(() => {
    if (!selectedPath) {
      return;
    }
    setExpandedPaths((current) => {
      const next = new Set(current);
      for (const ancestor of codeAgentMobileAncestorPaths(selectedPath)) {
        next.add(ancestor);
      }
      return next;
    });
  }, [selectedPath]);

  useEffect(() => {
    if (!selectedPath) {
      return undefined;
    }
    if (selectedScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(selectedScrollFrameRef.current);
    }
    selectedScrollFrameRef.current = window.requestAnimationFrame(() => {
      selectedScrollFrameRef.current = null;
      listRef.current
        ?.querySelector<HTMLElement>('[data-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' });
    });
    return () => {
      if (selectedScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(selectedScrollFrameRef.current);
        selectedScrollFrameRef.current = null;
      }
    };
  }, [selectedPath, visibleNodes]);

  useEffect(() => {
    if (!entriesPending) {
      return;
    }
    pullGestureRef.current = { pointerId: null, startY: 0, maxDistance: 0 };
    setPullDistance(0);
  }, [entriesPending]);

  const toggleDirectory = useCallback((path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const finishPullGesture = useCallback((pointerId: number | null) => {
    const gesture = pullGestureRef.current;
    if (pointerId !== null && gesture.pointerId !== pointerId) {
      return;
    }
    const shouldRefresh = gesture.maxDistance >= MOBILE_PULL_REFRESH_THRESHOLD && !entriesPending;
    pullGestureRef.current = { pointerId: null, startY: 0, maxDistance: 0 };
    setPullDistance(0);
    if (shouldRefresh) {
      onRefresh();
    }
  }, [entriesPending, onRefresh]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (entriesPending || (event.pointerType === 'mouse' && event.button !== 0)) {
      return;
    }
    const element = event.currentTarget;
    if (element.scrollTop > 0) {
      return;
    }
    pullGestureRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      maxDistance: 0,
    };
    try {
      element.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic pointer events may not be registered as active pointers.
    }
  }, [entriesPending]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = pullGestureRef.current;
    if (gesture.pointerId !== event.pointerId || entriesPending) {
      return;
    }
    const element = event.currentTarget;
    if (element.scrollTop > 0) {
      finishPullGesture(event.pointerId);
      return;
    }
    const delta = event.clientY - gesture.startY;
    if (delta <= 0) {
      gesture.maxDistance = 0;
      setPullDistance(0);
      return;
    }
    const nextDistance = Math.min(MOBILE_PULL_REFRESH_MAX_DISTANCE, Math.round(delta * 0.55));
    gesture.maxDistance = Math.max(gesture.maxDistance, nextDistance);
    setPullDistance(nextDistance);
    if (nextDistance > 8) {
      suppressNextClickRef.current = true;
      event.preventDefault();
    }
  }, [entriesPending, finishPullGesture]);

  const handlePointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    finishPullGesture(event.pointerId);
  }, [finishPullGesture]);

  const handleTouchStart = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (entriesPending || pullGestureRef.current.pointerId !== null) {
      return;
    }
    const touch = firstTouch(event.touches);
    if (!touch || event.currentTarget.scrollTop > 0) {
      return;
    }
    pullGestureRef.current = {
      pointerId: null,
      startY: touch.clientY,
      maxDistance: 0,
    };
  }, [entriesPending]);

  const handleTouchMove = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    const gesture = pullGestureRef.current;
    if (gesture.pointerId !== null || entriesPending) {
      return;
    }
    const touch = firstTouch(event.touches);
    if (!touch) {
      return;
    }
    const element = event.currentTarget;
    if (element.scrollTop > 0) {
      finishPullGesture(null);
      return;
    }
    const delta = touch.clientY - gesture.startY;
    if (delta <= 0) {
      gesture.maxDistance = 0;
      setPullDistance(0);
      return;
    }
    const nextDistance = Math.min(MOBILE_PULL_REFRESH_MAX_DISTANCE, Math.round(delta * 0.55));
    gesture.maxDistance = Math.max(gesture.maxDistance, nextDistance);
    setPullDistance(nextDistance);
    if (nextDistance > 8) {
      suppressNextClickRef.current = true;
      event.preventDefault();
    }
  }, [entriesPending, finishPullGesture]);

  const handleTouchEnd = useCallback(() => {
    if (pullGestureRef.current.pointerId !== null) {
      return;
    }
    finishPullGesture(null);
  }, [finishPullGesture]);

  const handleClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressNextClickRef.current) {
      return;
    }
    suppressNextClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  if (entriesError && entries.length === 0) {
    return (
      <div className="px-4 py-5 text-xs leading-relaxed text-[#9f462c] dark:text-[#ff9b78]">
        {entriesError}
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-2 [-webkit-overflow-scrolling:touch] touch-pan-y"
      data-testid="code-agent-mobile-file-tree-list"
      onClickCapture={handleClickCapture}
      onPointerCancel={handlePointerEnd}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onTouchCancel={handleTouchEnd}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchMove}
      onTouchStart={handleTouchStart}
    >
      {pullDistance > 0 ? (
        <div
          aria-hidden="true"
          className="pointer-events-none sticky top-0 z-20 -mb-8 flex h-8 justify-center"
          data-pull-ready={pullDistance >= MOBILE_PULL_REFRESH_THRESHOLD ? 'true' : 'false'}
          data-testid="code-agent-mobile-file-tree-pull-refresh"
          style={{ transform: `translateY(${Math.min(pullDistance, MOBILE_PULL_REFRESH_MAX_DISTANCE)}px)` }}
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-full border border-[#dedbd0] bg-[#faf9f5]/95 text-[#5e5d59] shadow-sm backdrop-blur dark:border-[#30302e] dark:bg-[#1d1d1b]/95 dark:text-[#8f8d86]">
            <RefreshCw
              className={`h-3.5 w-3.5 transition-transform ${
                pullDistance >= MOBILE_PULL_REFRESH_THRESHOLD ? 'rotate-180 text-[#9f462c] dark:text-[#ffb197]' : ''
              }`}
            />
          </div>
        </div>
      ) : null}
      {entriesPending ? (
        <div className="mx-2 mb-1 flex items-center justify-between rounded-lg border border-[#dedbd0] px-2 py-1.5 text-[11px] text-[#5e5d59] dark:border-[#30302e] dark:text-[#8f8d86]">
          <span>{t('codeAgentWorkspaceIndexing')}</span>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 font-semibold text-[#5e5d59] hover:bg-[#f0eee6] dark:text-[#b0aea5] dark:hover:bg-[#30302e]"
            onClick={onRefresh}
          >
            {t('codeAgentRefreshWorkspaceFiles')}
          </button>
        </div>
      ) : null}
      {visibleNodes.length === 0 ? (
        <div className="px-4 py-5">
          <div className="text-sm font-semibold text-[#141413] dark:text-[#faf9f5]">{t('codeAgentNoWorkspaceFiles')}</div>
          <div className="mt-1 text-xs leading-5 text-[#5e5d59] dark:text-[#8f8d86]">
            {searchQuery.trim().length > 0 ? t('codeAgentNoWorkspaceSearchResults') : t('codeAgentWorkspaceIndexEmpty')}
          </div>
        </div>
      ) : (
        <div className="space-y-0.5">
          {visibleNodes.map(({ node, depth }) => {
            const selected = node.path === selectedPath;
            const expanded = expandedPaths.has(node.path);
            return (
              <button
                key={node.path}
                type="button"
                aria-label={node.path}
                aria-current={selected ? 'true' : undefined}
                data-testid="code-agent-mobile-file-tree-row"
                data-kind={node.kind}
                data-path={node.path}
                data-selected={selected ? 'true' : undefined}
                className={`mx-2 flex min-h-[42px] w-[calc(100%-1rem)] min-w-0 items-center gap-2 rounded-lg px-2 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] ${
                  selected
                    ? 'bg-[#f0eee6] text-[#141413] dark:bg-[#30302e] dark:text-[#faf9f5]'
                    : 'text-[#4d4c48] hover:bg-[#f0eee6] dark:text-[#e8e6dc] dark:hover:bg-[#30302e]'
                }`}
                style={{ paddingLeft: `${8 + depth * 18}px` }}
                onClick={() => {
                  if (node.kind === 'directory') {
                    toggleDirectory(node.path);
                  }
                  onOpenEntry(node.path, node.kind);
                }}
              >
                {node.kind === 'directory' ? (
                  <ChevronRight
                    className={`h-3.5 w-3.5 shrink-0 text-[#5e5d59] transition-transform dark:text-[#8f8d86] ${expanded ? 'rotate-90' : ''}`}
                  />
                ) : (
                  <span aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                )}
                <CodeAgentPierreEntryIcon
                  pathValue={node.path}
                  kind={node.kind}
                  theme={resolvedTheme}
                  className="size-4 shrink-0"
                />
                <span className={`min-w-0 flex-1 truncate text-sm leading-[19px] ${selected ? 'font-semibold' : 'font-medium'}`}>
                  {node.name}
                </span>
                {node.kind === 'directory' ? (
                  <span className="shrink-0 font-mono text-[10px] font-medium text-[#5e5d59] dark:text-[#8f8d86]">
                    {node.children.length}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
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
  workspaceEditable = true,
  onSearchQueryChange,
  remoteSearchPending,
  remoteSearchError,
  remoteSearchTruncated,
  mobileLayout = false,
  onBackToPreview,
}: CodeAgentWorkspaceFileTreePanelProps) {
  const { t } = useTranslation();
  const entryKindsRef = useRef<ReadonlyMap<string, CodeAgentProjectEntry['kind']>>(entryKinds);
  const selectionSyncingRef = useRef(false);
  const desktopTreeClickSerialRef = useRef(0);
  const desktopSelectionChangeClickSerialRef = useRef(0);
  const mobileSearchInputRef = useRef<HTMLInputElement | null>(null);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [mobileSearchQuery, setMobileSearchQuery] = useState('');
  const treePaths = useMemo(() => entries.map(codeAgentMobileFileTreePath), [entries]);
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
      desktopSelectionChangeClickSerialRef.current = desktopTreeClickSerialRef.current;
      if (selectionSyncingRef.current) {
        return;
      }
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
  const headerRowClassName = mobileLayout
    ? 'flex h-9 min-h-9 shrink-0 items-center gap-2 overflow-x-auto border-b border-[#dedbd0] px-2 py-0 [scrollbar-width:none] dark:border-[#30302e] [&::-webkit-scrollbar]:hidden'
    : 'flex min-h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-[#dedbd0] px-2 py-1 [scrollbar-width:none] dark:border-[#30302e] [&::-webkit-scrollbar]:hidden';
  const toolbarButtonClassName = mobileLayout
    ? 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[#5e5d59] hover:bg-[#f0eee6] hover:text-[#141413] disabled:cursor-not-allowed disabled:opacity-40 dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]'
    : 'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#5e5d59] hover:bg-[#f0eee6] hover:text-[#141413] disabled:cursor-not-allowed disabled:opacity-40 dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]';
  const fileCountClassName = mobileLayout
    ? 'max-w-[7rem] shrink-0 truncate text-sm font-medium text-[#5e5d59] dark:text-[#b0aea5]'
    : 'shrink-0 truncate text-[11px] text-[#5e5d59] dark:text-[#8f8d86]';
  const readOnlyTitle = workspaceEditable ? undefined : t('codeAgentReadOnlyDescription');

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
    const selectedItem = model.getItem(selectedPath);
    const currentSelectedPaths = model.getSelectedPaths().map((path) => path.replace(/\/$/, ''));
    if (selectedItem && (currentSelectedPaths.length !== 1 || currentSelectedPaths[0] !== selectedPath)) {
      selectionSyncingRef.current = true;
      try {
        for (const path of model.getSelectedPaths()) {
          model.getItem(path)?.deselect();
        }
        selectedItem?.select();
      } finally {
        selectionSyncingRef.current = false;
      }
    }
    model.focusPath(selectedPath);
    model.scrollToPath(selectedPath, { offset: 'nearest' });
  }, [entryKinds, model, selectedPath]);

  useEffect(() => {
    onSearchQueryChange(mobileLayout ? (mobileSearchOpen ? mobileSearchQuery : '') : (treeSearch.isOpen ? treeSearch.value : ''));
  }, [mobileLayout, mobileSearchOpen, mobileSearchQuery, onSearchQueryChange, treeSearch.isOpen, treeSearch.value]);

  const handleDesktopTreeClickCapture = useCallback(() => {
    const clickSerial = desktopTreeClickSerialRef.current + 1;
    desktopTreeClickSerialRef.current = clickSerial;
    window.setTimeout(() => {
      if (desktopSelectionChangeClickSerialRef.current === clickSerial) {
        return;
      }
      const selected = model.getSelectedPaths().at(-1)?.replace(/\/$/, '');
      const kind = selected ? entryKindsRef.current.get(selected) : undefined;
      if (selected && kind === 'file') {
        onOpenEntry(selected, kind);
      }
    }, 0);
  }, [model, onOpenEntry]);

  useEffect(() => {
    if (!mobileLayout || !mobileSearchOpen) {
      return undefined;
    }
    const frameId = window.requestAnimationFrame(() => mobileSearchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frameId);
  }, [mobileLayout, mobileSearchOpen]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-[#faf9f5] dark:bg-[#1d1d1b]"
      data-file-browser-panel="t3-workspace"
      data-mobile-file-tree-panel={mobileLayout ? 'true' : undefined}
    >
      <div
        className={headerRowClassName}
        data-testid={mobileLayout ? 'code-agent-mobile-file-tree-header' : 'code-agent-desktop-file-tree-header'}
      >
        {mobileLayout && onBackToPreview ? (
          <button
            type="button"
            className={toolbarButtonClassName}
            aria-label={t('codeAgentBackToFilePreview')}
            title={t('codeAgentBackToFilePreview')}
            data-testid="code-agent-mobile-file-tree-back"
            onClick={onBackToPreview}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <div className={mobileLayout ? 'min-w-0 shrink-0' : 'flex min-w-[8rem] flex-1 items-baseline gap-2'}>
          {!mobileLayout ? (
            <div className="truncate text-xs font-medium text-[#141413] dark:text-[#faf9f5]">{projectName}</div>
          ) : null}
          <div className={fileCountClassName}>
            {fileCountLabel}
            {entriesTruncated ? ` · ${t('codeAgentWorkspacePartial')}` : ''}
            {remoteSearchPending ? ` · ${t('codeAgentSearchingWorkspaceFiles')}` : ''}
            {remoteSearchTruncated ? ` · ${t('codeAgentWorkspaceSearchPartial')}` : ''}
          </div>
        </div>
        <div
          className="flex min-w-max shrink-0 items-center gap-1"
          data-testid={mobileLayout ? 'code-agent-mobile-file-tree-actions' : 'code-agent-desktop-file-tree-actions'}
        >
          <button
            type="button"
            className={toolbarButtonClassName}
            aria-label={t('codeAgentSearchWorkspaceFiles')}
            onClick={() => {
              if (mobileLayout) {
                setMobileSearchOpen((open) => !open);
              } else {
                model.openSearch();
              }
            }}
          >
            <Search className="h-3.5 w-3.5" />
          </button>
          <button type="button" className={toolbarButtonClassName} aria-label={t('codeAgentRefreshWorkspaceFiles')} onClick={onRefresh}>
            <RefreshCw className={`h-3.5 w-3.5 ${entriesPending ? 'animate-spin' : ''}`} />
          </button>
          <div className="mx-1 h-5 w-px shrink-0 bg-[#dedbd0] dark:bg-[#30302e]" />
          <button type="button" disabled={!workspaceEditable} className={toolbarButtonClassName} aria-label={t('codeAgentNewFile')} title={readOnlyTitle} onClick={onCreateFile}>
            <FilePlus2 className="h-3.5 w-3.5" />
          </button>
          <button type="button" disabled={!workspaceEditable} className={toolbarButtonClassName} aria-label={t('codeAgentNewFolder')} title={readOnlyTitle} onClick={onCreateDirectory}>
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
          <button type="button" disabled={!workspaceEditable} className={toolbarButtonClassName} aria-label={t('codeAgentUploadFile')} title={readOnlyTitle} onClick={onUpload}>
            <Upload className="h-3.5 w-3.5" />
          </button>
          <div className="mx-1 h-5 w-px shrink-0 bg-[#dedbd0] dark:bg-[#30302e]" />
          <button type="button" disabled={!workspaceEditable || !selectedPath} className={toolbarButtonClassName} aria-label={t('codeAgentRenameFile')} title={readOnlyTitle} onClick={onRename}>
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button type="button" disabled={!workspaceEditable || !selectedPath} className={toolbarButtonClassName} aria-label={t('codeAgentDeleteFile')} title={readOnlyTitle} onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {entriesError && entries.length === 0 ? (
        <div className="p-4 text-xs leading-relaxed text-[#9f462c] dark:text-[#ff9b78]">{entriesError}</div>
      ) : (
        <>
          {mobileLayout && mobileSearchOpen ? (
            <div className="shrink-0 border-b border-[#dedbd0] px-2 py-2 dark:border-[#30302e]" data-testid="code-agent-mobile-file-tree-search-row">
              <div className="flex min-h-9 items-center gap-2 rounded-lg border border-[#dedbd0] bg-[#f5f4ed] px-2 dark:border-[#30302e] dark:bg-[#141413]">
                <Search className="h-3.5 w-3.5 shrink-0 text-[#5e5d59] dark:text-[#8f8d86]" />
                <input
                  ref={mobileSearchInputRef}
                  value={mobileSearchQuery}
                  className="min-w-0 flex-1 bg-transparent text-sm text-[#141413] outline-none placeholder:text-[#5e5d59] dark:text-[#faf9f5] dark:placeholder:text-[#8f8d86]"
                  placeholder={t('codeAgentSearchWorkspaceFiles')}
                  aria-label={t('codeAgentSearchWorkspaceFiles')}
                  onChange={(event) => setMobileSearchQuery(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setMobileSearchQuery('');
                      setMobileSearchOpen(false);
                    }
                  }}
                />
                <button
                  type="button"
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#5e5d59] hover:bg-[#dedbd0] hover:text-[#141413] dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]"
                  aria-label={t('close')}
                  onClick={() => {
                    setMobileSearchQuery('');
                    setMobileSearchOpen(false);
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ) : null}
          {remoteSearchError ? (
            <div className="border-b border-[#dedbd0] px-3 py-1.5 text-[11px] text-[#9f462c] dark:border-[#30302e] dark:text-[#ff9b78]">
              {remoteSearchError}
            </div>
          ) : null}
          {mobileLayout ? (
            <CodeAgentMobileFileTreeList
              entries={entries}
              entriesPending={entriesPending}
              entriesError={entriesError}
              searchQuery={mobileSearchOpen ? mobileSearchQuery : ''}
              selectedPath={selectedPath}
              resolvedTheme={resolvedTheme}
              onRefresh={onRefresh}
              onOpenEntry={onOpenEntry}
            />
          ) : (
            <div
              className="min-h-0 flex-1 overflow-hidden"
              onClickCapture={handleDesktopTreeClickCapture}
            >
              <FileTree
                model={model}
                aria-label={t('codeAgentWorkspaceFiles')}
                className="h-full min-h-0 overflow-hidden"
                style={{
                  colorScheme: resolvedTheme,
                  ['--trees-fg-override' as string]: resolvedTheme === 'dark' ? '#faf9f5' : '#141413',
                }}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
