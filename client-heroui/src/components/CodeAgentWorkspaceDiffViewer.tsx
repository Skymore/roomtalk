import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CodeViewDiffItem } from '@pierre/diffs';
import { type CodeViewHandle } from '@pierre/diffs/react';
import { ArrowRight, Check, ChevronDown, ChevronRight, Columns2, FileCode2, Pilcrow, RefreshCw, Rows3, Search, WrapText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { loadCodeAgentWorkspaceDiff, loadCodeAgentWorkspaceRefs, type CodeAgentWorkspaceDiff, type CodeAgentWorkspaceDiffScope, type CodeAgentWorkspaceRefs } from '../utils/cocoWorkspace';
import { buildCodeAgentBaseRefChoices, filterCodeAgentBaseRefChoices, type CodeAgentBaseRefChoice } from '../utils/codeWorkspaceRefs';
import {
  selectCodeAgentDiffBranchBaseRef,
  selectCodeAgentDiffScope,
  useCodeAgentDiffPanelSelection,
} from '../utils/codeAgentDiffPanelStore';
import {
  buildFileDiffRenderKey,
  buildDiffTitlePathMap,
  getDiffCollapseIconClassName,
  getRenderablePatch,
  resolveCodeAgentDiffThemeName,
  resolveDiffTitleOpenPath,
  resolveFileDiffPath,
  summarizeFileDiffStat,
  withDiffLineTarget,
} from '../utils/codeAgentDiffRendering';
import { formatCompactDiffCount } from '../utils/codeAgentChangedFileTree';
import { type ReviewCommentContext } from '../utils/codeAgentReviewComments';
import { openCodeAgentDiffFilePrimaryAction } from '../utils/codeAgentDiffFileActions';
import { type DiffCommentAnnotationGroup } from './codeAgentDiffCommentAnnotations';
import { CodeAgentAnnotatableCodeView } from './CodeAgentAnnotatableCodeView';
import {
  CodeAgentWorkspaceDiffLoadingState,
  CodeAgentWorkspaceDiffPanelShell,
  CodeAgentWorkspaceDiffPanelViewport,
} from './CodeAgentWorkspaceDiffPanelShell';

interface CodeAgentWorkspaceDiffViewerProps {
  roomId: string;
  enabled: boolean;
  refreshKey?: string;
  onOpenFile?: (path: string) => void;
  onFileSummariesChange?: (summaries: readonly CodeAgentWorkspaceDiffFileSummary[]) => void;
  selectedFilePath?: string | null;
  selectedFileRevealRequestId?: number;
  reviewComments?: readonly ReviewCommentContext[];
  onAddReviewComment?: (comment: ReviewCommentContext) => void;
  onRemoveReviewComment?: (commentId: string) => void;
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

const DIFF_WORD_WRAP_STORAGE_KEY = 'roomtalk.codeWorkspace.diffWordWrap';
const DIFF_RENDER_MODE_STORAGE_KEY = 'roomtalk.codeWorkspace.diffRenderMode';
const DIFF_IGNORE_WHITESPACE_STORAGE_KEY = 'roomtalk.codeWorkspace.diffIgnoreWhitespace';
const AUTOMATIC_BASE_REF = '__automatic_base_ref__';
const WORKSPACE_REF_LIMIT = 200;
type DiffRenderMode = 'stacked' | 'split';
const EMPTY_COLLAPSED_DIFF_FILE_KEYS: ReadonlySet<string> = new Set();
const DIFF_PANEL_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-header-font-family: var(--font-sans, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif) !important;
  --diffs-font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace) !important;
  --diffs-bg: light-dark(var(--rt-ivory, #faf9f5), var(--rt-dark, #141413)) !important;
  --diffs-light-bg: var(--rt-ivory, #faf9f5) !important;
  --diffs-dark-bg: var(--rt-dark, #141413) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: light-dark(#f5f4ed, #1d1d1b);
  --diffs-bg-hover-override: light-dark(#f0eee6, #242422);
  --diffs-bg-separator-override: light-dark(#e8e6dc, #30302e);
  --diffs-bg-buffer-override: light-dark(#f0eee6, #242422);

  --diffs-bg-addition-override: light-dark(color-mix(in srgb, #faf9f5 88%, #2f7d46), color-mix(in srgb, #141413 78%, #48a868));
  --diffs-bg-addition-number-override: light-dark(color-mix(in srgb, #faf9f5 82%, #2f7d46), color-mix(in srgb, #141413 70%, #48a868));
  --diffs-bg-addition-hover-override: light-dark(color-mix(in srgb, #faf9f5 76%, #2f7d46), color-mix(in srgb, #141413 64%, #48a868));
  --diffs-bg-addition-emphasis-override: light-dark(color-mix(in srgb, #faf9f5 68%, #2f7d46), color-mix(in srgb, #141413 56%, #48a868));

  --diffs-bg-deletion-override: light-dark(color-mix(in srgb, #faf9f5 88%, #c96442), color-mix(in srgb, #141413 78%, #d97757));
  --diffs-bg-deletion-number-override: light-dark(color-mix(in srgb, #faf9f5 82%, #c96442), color-mix(in srgb, #141413 70%, #d97757));
  --diffs-bg-deletion-hover-override: light-dark(color-mix(in srgb, #faf9f5 76%, #c96442), color-mix(in srgb, #141413 64%, #d97757));
  --diffs-bg-deletion-emphasis-override: light-dark(color-mix(in srgb, #faf9f5 68%, #c96442), color-mix(in srgb, #141413 56%, #d97757));

  background-color: var(--diffs-bg) !important;
}

[data-file-info] {
  background-color: light-dark(#f0eee6, #242422) !important;
  border-block-color: light-dark(#dedbd0, #30302e) !important;
  color: light-dark(#141413, #faf9f5) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: light-dark(#f0eee6, #242422) !important;
  border-bottom: 1px solid light-dark(#dedbd0, #30302e) !important;
  align-items: center !important;
  font-family: var(--font-sans, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif) !important;
  font-size: 12px !important;
  line-height: 1 !important;
  min-height: 32px !important;
  padding-block: 6px !important;
}

[data-diffs-header] [data-header-content] {
  align-items: center !important;
  line-height: 1 !important;
}

[data-diffs-header] [data-metadata] {
  align-items: center !important;
  line-height: 1 !important;
  font-variant-numeric: tabular-nums;
}

[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace) !important;
  font-size: 11px !important;
  font-variant-numeric: tabular-nums;
  line-height: 1 !important;
}

[data-diffs-header] [data-change-icon],
[data-diffs-header] [data-rename-icon] {
  display: block;
  flex-shrink: 0;
}

[data-title] {
  cursor: pointer;
  transition:
    color 120ms ease,
    text-decoration-color 120ms ease;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
  font-family: var(--font-sans, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif) !important;
}

[data-title]:hover {
  color: light-dark(#9f462c, #ffb197) !important;
  text-decoration-color: currentColor;
}
`;

interface CollapsedDiffFilesState {
  scopeKey: string | null;
  fileKeys: Set<string>;
}

export interface CodeAgentWorkspaceDiffFileSummary {
  id: string;
  path: string;
  additions: number;
  deletions: number;
}

function readInitialDiffWordWrap() {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    return window.localStorage.getItem(DIFF_WORD_WRAP_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function readInitialDiffRenderMode(): DiffRenderMode {
  if (typeof window === 'undefined') {
    return 'stacked';
  }
  try {
    return window.localStorage.getItem(DIFF_RENDER_MODE_STORAGE_KEY) === 'split' ? 'split' : 'stacked';
  } catch {
    return 'stacked';
  }
}

function readInitialDiffIgnoreWhitespace() {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    return window.localStorage.getItem(DIFF_IGNORE_WHITESPACE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function parseDiffLineNumber(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getDiffLineNumber(element: HTMLElement): number | null {
  return parseDiffLineNumber(element.getAttribute('data-line'))
    ?? parseDiffLineNumber(element.getAttribute('data-column-number'));
}

function findClickedDiffLineElement(
  eventTarget: EventTarget | null,
  composedPath: readonly EventTarget[],
): HTMLElement | null {
  const fromPath = composedPath.find((node): node is HTMLElement => (
    node instanceof HTMLElement && getDiffLineNumber(node) !== null
  ));
  if (fromPath) {
    return fromPath;
  }
  return eventTarget instanceof HTMLElement
    ? eventTarget.closest<HTMLElement>('[data-line], [data-column-number]')
    : null;
}

function findTitleTextInScope(scope: ParentNode | HTMLElement | null | undefined): string | null {
  const title = scope instanceof HTMLElement && scope.hasAttribute('data-title')
    ? scope
    : scope?.querySelector?.<HTMLElement>('[data-title]');
  const text = title?.textContent?.trim();
  return text || null;
}

function findSingleTitleTextInScope(scope: ParentNode | HTMLElement | null | undefined): string | null {
  if (!scope) {
    return null;
  }
  if (scope instanceof HTMLElement && scope.hasAttribute('data-title')) {
    const text = scope.textContent?.trim();
    return text || null;
  }
  const titles = Array.from(scope.querySelectorAll?.<HTMLElement>('[data-title]') ?? []);
  if (titles.length !== 1) {
    return null;
  }
  const text = titles[0].textContent?.trim();
  return text || null;
}

function isSearchableRoot(root: Node): root is Document | ShadowRoot {
  return root instanceof Document || (typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot);
}

function findDiffTitleTextForLine(
  lineElement: HTMLElement,
  composedPath: readonly EventTarget[],
): string | null {
  const container = lineElement.closest<HTMLElement>('[data-diff], [data-file]');
  const containerTitle = findTitleTextInScope(container);
  if (containerTitle) {
    return containerTitle;
  }

  const root = lineElement.getRootNode();
  const rootTitle = findSingleTitleTextInScope(isSearchableRoot(root) ? root : null);
  if (rootTitle) {
    return rootTitle;
  }

  for (const node of composedPath) {
    if (!(node instanceof HTMLElement)) {
      continue;
    }
    const title = node.hasAttribute('data-diff') || node.hasAttribute('data-file')
      ? findTitleTextInScope(node)
      : findSingleTitleTextInScope(node.shadowRoot);
    if (title) {
      return title;
    }
  }

  return null;
}

export const CodeAgentWorkspaceDiffViewer: React.FC<CodeAgentWorkspaceDiffViewerProps> = ({
  roomId,
  enabled,
  refreshKey = '',
  onOpenFile,
  onFileSummariesChange,
  selectedFilePath = null,
  selectedFileRevealRequestId = 0,
  reviewComments = [],
  onAddReviewComment,
  onRemoveReviewComment,
}) => {
  const { t } = useTranslation();
  const resolvedTheme = useResolvedTheme();
  const [diff, setDiff] = useState<CodeAgentWorkspaceDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [wordWrap, setWordWrap] = useState(readInitialDiffWordWrap);
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>(readInitialDiffRenderMode);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(readInitialDiffIgnoreWhitespace);
  const [diffRefreshNonce, setDiffRefreshNonce] = useState(0);
  const diffPanelSelection = useCodeAgentDiffPanelSelection(roomId);
  const diffScope: CodeAgentWorkspaceDiffScope = diffPanelSelection.kind === 'unstaged' ? 'unstaged' : 'branch';
  const diffBaseRef = diffPanelSelection.kind === 'branch' ? diffPanelSelection.baseRef : null;
  const [baseRefQuery, setBaseRefQuery] = useState('');
  const [workspaceRefs, setWorkspaceRefs] = useState<CodeAgentWorkspaceRefs | null>(null);
  const [workspaceRefsError, setWorkspaceRefsError] = useState<string | null>(null);
  const [isWorkspaceRefsPending, setIsWorkspaceRefsPending] = useState(false);
  const codeViewRef = useRef<CodeViewHandle<DiffCommentAnnotationGroup> | null>(null);
  const [collapsedDiffFiles, setCollapsedDiffFiles] = useState<CollapsedDiffFilesState>(() => ({
    scopeKey: null,
    fileKeys: new Set(),
  }));
  const collapseScopeKey = `${roomId}:${refreshKey}:${diffScope}:${diffBaseRef ?? 'auto'}:${diffIgnoreWhitespace ? 'ignore-whitespace' : 'show-whitespace'}`;
  const collapsedDiffFileKeys = collapsedDiffFiles.scopeKey === collapseScopeKey
    ? collapsedDiffFiles.fileKeys
    : EMPTY_COLLAPSED_DIFF_FILE_KEYS;
  const wordWrapLabel = t(wordWrap ? 'codeAgentDisableDiffLineWrapping' : 'codeAgentEnableDiffLineWrapping');
  const ignoreWhitespaceLabel = t(diffIgnoreWhitespace ? 'codeAgentShowWhitespaceChanges' : 'codeAgentHideWhitespaceChanges');
  const refreshDiffLabel = t('codeAgentRefreshWorkspaceDiff');
  const isDiffRefreshPending = isPending || isWorkspaceRefsPending;
  const diffScopeLabel = t(diffScope === 'unstaged' ? 'codeAgentDiffScopeWorkingTree' : 'codeAgentDiffScopeBranch');
  const loadingDiffLabel = t(diffScope === 'unstaged' ? 'codeAgentLoadingWorkingTreeDiff' : 'codeAgentLoadingBranchDiff');
  const diffBaseRefLabel = diffBaseRef || t('codeAgentDiffBaseRefAutomatic');
  const baseRefRequestQuery = baseRefQuery.trim();
  const hasNoNetChanges = Boolean(diff?.available && diff.patch.trim().length === 0);
  const emptyPatchLabel = t(hasNoNetChanges ? 'codeAgentNoNetWorkspaceChanges' : 'codeAgentNoWorkspacePatch');
  const reviewCommentSectionId = `workspace-diff:${roomId}:${refreshKey || 'current'}:${diffScope}:${diffBaseRef ?? 'auto'}`;
  const reviewCommentSectionTitle = t('codeAgentChanges');

  useEffect(() => {
    setBaseRefQuery('');
    setWorkspaceRefs(null);
    setWorkspaceRefsError(null);
  }, [roomId]);

  const selectDiffRenderMode = (nextMode: DiffRenderMode) => {
    setDiffRenderMode(nextMode);
    try {
      window.localStorage.setItem(DIFF_RENDER_MODE_STORAGE_KEY, nextMode);
    } catch {
      // Preference persistence is best-effort; the live toggle still applies.
    }
  };

  const toggleWordWrap = () => {
    setWordWrap((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(DIFF_WORD_WRAP_STORAGE_KEY, String(next));
      } catch {
        // Preference persistence is best-effort; the live toggle still applies.
      }
      return next;
    });
  };

  const toggleDiffIgnoreWhitespace = () => {
    setDiffIgnoreWhitespace((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(DIFF_IGNORE_WHITESPACE_STORAGE_KEY, String(next));
      } catch {
        // Preference persistence is best-effort; the live toggle still applies.
      }
      return next;
    });
  };

  const refreshDiff = () => {
    setDiffRefreshNonce((current) => current + 1);
  };

  const selectDiffScope = (nextScope: CodeAgentWorkspaceDiffScope) => {
    selectCodeAgentDiffScope(roomId, nextScope);
  };

  const selectDiffBaseRef = useCallback((nextBaseRef: string | null) => {
    setBaseRefQuery('');
    selectCodeAgentDiffBranchBaseRef(roomId, nextBaseRef);
  }, [roomId]);

  const toggleDiffFileCollapsed = (fileKey: string) => {
    setCollapsedDiffFiles((current) => {
      const nextFileKeys = new Set(current.scopeKey === collapseScopeKey ? current.fileKeys : []);
      if (nextFileKeys.has(fileKey)) {
        nextFileKeys.delete(fileKey);
      } else {
        nextFileKeys.add(fileKey);
      }
      return {
        scopeKey: collapseScopeKey,
        fileKeys: nextFileKeys,
      };
    });
  };

  useEffect(() => {
    if (!enabled || diffScope !== 'branch') {
      return undefined;
    }

    const controller = new AbortController();
    setIsWorkspaceRefsPending(true);
    setWorkspaceRefsError(null);

    loadCodeAgentWorkspaceRefs(roomId, {
      signal: controller.signal,
      query: baseRefRequestQuery || undefined,
      limit: WORKSPACE_REF_LIMIT,
    }).then(
      (refs) => {
        if (!controller.signal.aborted) {
          setWorkspaceRefs(refs);
        }
      },
      (refsError) => {
        if (!controller.signal.aborted) {
          setWorkspaceRefsError(refsError instanceof Error ? refsError.message : 'Workspace refs failed.');
        }
      },
    ).finally(() => {
      if (!controller.signal.aborted) {
        setIsWorkspaceRefsPending(false);
      }
    });

    return () => controller.abort();
  }, [baseRefRequestQuery, diffRefreshNonce, diffScope, enabled, refreshKey, roomId]);

  const baseRefChoices = useMemo(() => {
    const refs = workspaceRefs?.refs ?? [];
    const localRefs = refs.filter((ref) => ref.kind === 'local' && ref.name !== workspaceRefs?.headRef);
    const remoteRefs = refs.filter((ref) => ref.kind === 'remote');
    return buildCodeAgentBaseRefChoices(localRefs, remoteRefs);
  }, [workspaceRefs]);
  const matchingBaseRefChoices = useMemo(
    () => filterCodeAgentBaseRefChoices(baseRefChoices, baseRefQuery),
    [baseRefChoices, baseRefQuery],
  );
  const valueForBaseRefChoice = useCallback((choice: CodeAgentBaseRefChoice): string => (
    diffBaseRef && diffBaseRef === choice.remote?.name
      ? diffBaseRef
      : (choice.local?.name ?? choice.remote?.name ?? choice.id)
  ), [diffBaseRef]);
  const filteredBaseRefItems = useMemo(() => [
    ...(baseRefQuery.trim().length === 0 ? [AUTOMATIC_BASE_REF] : []),
    ...matchingBaseRefChoices.map(valueForBaseRefChoice),
  ], [baseRefQuery, matchingBaseRefChoices, valueForBaseRefChoice]);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const controller = new AbortController();
    setIsPending(true);
    setError(null);

    loadCodeAgentWorkspaceDiff(roomId, {
      signal: controller.signal,
      ignoreWhitespace: diffIgnoreWhitespace,
      scope: diffScope,
      baseRef: diffScope === 'branch' ? diffBaseRef : null,
    }).then(
      (nextDiff) => {
        if (!controller.signal.aborted) {
          setDiff(nextDiff);
        }
      },
      (nextError) => {
        if (!controller.signal.aborted) {
          setError(nextError instanceof Error ? nextError.message : 'Workspace diff failed.');
        }
      },
    ).finally(() => {
      if (!controller.signal.aborted) {
        setIsPending(false);
      }
    });

    return () => controller.abort();
  }, [diffBaseRef, diffIgnoreWhitespace, diffRefreshNonce, diffScope, enabled, refreshKey, roomId]);

  const renderablePatch = useMemo(
    () => getRenderablePatch(diff?.patch, `workspace:${roomId}:${refreshKey}:${diffScope}:${diffBaseRef ?? 'auto'}:${resolvedTheme}`, {
      compactPartialHunkOffsets: true,
    }),
    [diff?.patch, diffBaseRef, diffScope, refreshKey, resolvedTheme, roomId],
  );
  const parsed = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== 'files') {
      return { items: [] as CodeViewDiffItem<DiffCommentAnnotationGroup>[] };
    }

    const files = [...renderablePatch.files].sort((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: 'base',
      }),
    );
    const items = files.map((fileDiff, fileIndex) => {
      const id = buildFileDiffRenderKey(fileDiff) || `${fileIndex}`;
      const collapsed = collapsedDiffFileKeys.has(id);
      return {
        id,
        type: 'diff' as const,
        fileDiff,
        collapsed,
        version: collapsed ? 1 : 0,
      };
    });
    return { items };
  }, [collapsedDiffFileKeys, renderablePatch]);
  const diffTitlePathMap = useMemo(() => buildDiffTitlePathMap(parsed.items.map((item) => item.fileDiff)), [parsed.items]);
  const diffFileSummaries = useMemo<CodeAgentWorkspaceDiffFileSummary[]>(() => parsed.items.flatMap((item) => {
    if (item.type !== 'diff') {
      return [];
    }
    const stat = summarizeFileDiffStat(item.fileDiff);
    return [{
      id: item.id,
      path: resolveFileDiffPath(item.fileDiff),
      additions: stat.additions,
      deletions: stat.deletions,
    }];
  }), [parsed.items]);

  useEffect(() => {
    onFileSummariesChange?.(diffFileSummaries);
  }, [diffFileSummaries, onFileSummariesChange]);

  const scrollToDiffItem = useCallback((id: string) => {
    codeViewRef.current?.scrollTo({ type: 'item', id, align: 'start' });
  }, []);

  useEffect(() => {
    if (!selectedFilePath) {
      return;
    }
    const file = parsed.items.find((item) => (
      item.type === 'diff' && resolveFileDiffPath(item.fileDiff) === selectedFilePath
    ));
    if (!file) {
      return;
    }
    scrollToDiffItem(file.id);
  }, [parsed.items, scrollToDiffItem, selectedFilePath, selectedFileRevealRequestId]);

  const handleDiffClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onOpenFile) {
      return;
    }
    const composedPath = event.nativeEvent.composedPath?.() ?? [];
    const titleFromPath = composedPath.find((node): node is HTMLElement => (
      node instanceof HTMLElement && node.hasAttribute('data-title')
    ));
    const directTitle = titleFromPath ?? (event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>('[data-title]')
      : null);
    const rawDirectTitle = directTitle?.textContent?.trim();
    if (rawDirectTitle) {
      const openPath = resolveDiffTitleOpenPath(rawDirectTitle, diffTitlePathMap);
      if (openPath) {
        openCodeAgentDiffFilePrimaryAction({
          filePath: openPath,
          openInWorkspaceFileViewer: onOpenFile,
        });
      }
      return;
    }

    const lineElement = findClickedDiffLineElement(event.target, composedPath);
    const lineNumber = lineElement ? getDiffLineNumber(lineElement) : null;
    if (lineNumber === null) {
      return;
    }

    const rawTitle = lineElement ? findDiffTitleTextForLine(lineElement, composedPath) : null;
    const openPath = rawTitle
      ? resolveDiffTitleOpenPath(rawTitle, diffTitlePathMap)
      : diffFileSummaries.length === 1
        ? diffFileSummaries[0].path
        : null;
    if (openPath) {
      openCodeAgentDiffFilePrimaryAction({
        filePath: withDiffLineTarget(openPath, lineNumber),
        openInWorkspaceFileViewer: onOpenFile,
      });
    }
  };

  if (!enabled && diff === null) {
    return null;
  }

  const headerRow = (
    <>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <details className="group relative min-w-0">
            <summary
              aria-label={`${t('codeAgentDiffScope')}: ${diffScopeLabel}`}
              className="inline-flex h-7 max-w-48 cursor-pointer list-none items-center gap-1 rounded-md border border-[#dedbd0] bg-[#faf9f5] px-2 text-xs font-medium text-[#141413] transition-colors hover:bg-[#f0eee6] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:border-[#30302e] dark:bg-[#1d1d1b] dark:text-[#faf9f5] dark:hover:bg-[#30302e] [&::-webkit-details-marker]:hidden"
            >
              <span className="truncate">{diffScopeLabel}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#87867f] transition-transform group-open:rotate-180 dark:text-[#8f8d86]" />
            </summary>
            <div className="absolute left-0 top-8 z-50 w-52 rounded-md border border-[#dedbd0] bg-[#faf9f5] p-1 shadow-lg dark:border-[#30302e] dark:bg-[#1d1d1b]">
              {([
                ['branch', t('codeAgentDiffScopeBranch')],
                ['unstaged', t('codeAgentDiffScopeWorkingTree')],
              ] as const).map(([scope, label]) => (
                <button
                  key={scope}
                  type="button"
                  className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs text-[#141413] hover:bg-[#f0eee6] dark:text-[#faf9f5] dark:hover:bg-[#30302e]"
                  onClick={(event) => {
                    selectDiffScope(scope);
                    event.currentTarget.closest('details')?.removeAttribute('open');
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {diffScope === scope ? <Check className="h-3.5 w-3.5 shrink-0 text-[#9f462c] dark:text-[#ffb197]" /> : null}
                </button>
              ))}
            </div>
          </details>
          {diffScope === 'branch' ? (
            <div
              className="flex min-w-0 max-w-full items-center gap-1.5 overflow-visible text-xs text-[#87867f] dark:text-[#8f8d86]"
              title={`${workspaceRefs?.headRef ?? 'HEAD'} -> ${diffBaseRefLabel}`}
              aria-label={`${t('codeAgentDiffComparing')}: ${workspaceRefs?.headRef ?? 'HEAD'} -> ${diffBaseRefLabel}`}
            >
              <span className="hidden max-w-28 truncate sm:inline">{workspaceRefs?.headRef ?? 'HEAD'}</span>
              <ArrowRight className="hidden h-3.5 w-3.5 shrink-0 opacity-70 sm:block" />
              <details className="group relative min-w-0">
                <summary
                  aria-label={`${t('codeAgentDiffBaseRef')}: ${diffBaseRefLabel}`}
                  className="inline-flex h-7 max-w-52 cursor-pointer list-none items-center gap-1 rounded-md px-1.5 text-xs font-medium text-[#5e5d59] transition-colors hover:bg-[#f0eee6] hover:text-[#141413] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:text-[#b0aea5] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5] [&::-webkit-details-marker]:hidden"
                >
                  <span className="truncate">{diffBaseRefLabel}</span>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#87867f] transition-transform group-open:rotate-180 dark:text-[#8f8d86]" />
                </summary>
                <div className="absolute left-0 top-8 z-50 w-72 max-w-[calc(100vw-1rem)] overflow-hidden rounded-md border border-[#dedbd0] bg-[#faf9f5] shadow-lg dark:border-[#30302e] dark:bg-[#1d1d1b]">
                  <div className="px-3 pt-2.5">
                    <label className="relative block border-b border-[#dedbd0] pb-1.5 transition-colors focus-within:border-[#c96442] dark:border-[#30302e]">
                      <Search className="pointer-events-none absolute left-0 top-1.5 h-4 w-4 text-[#87867f]/70 dark:text-[#8f8d86]/70" />
                      <input
                        aria-label={t('codeAgentDiffBaseRefSearch')}
                        className="h-7 w-full bg-transparent pl-5 pr-1 text-sm text-[#141413] outline-none placeholder:text-[#87867f] dark:text-[#faf9f5] dark:placeholder:text-[#8f8d86]"
                        placeholder={t('codeAgentDiffBaseRefSearch')}
                        value={baseRefQuery}
                        onChange={(event) => setBaseRefQuery(event.target.value)}
                      />
                    </label>
                  </div>
                  <div className="grid grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 border-b border-[#dedbd0] px-3 pb-1.5 pt-2 text-[10px] font-semibold uppercase text-[#87867f] dark:border-[#30302e] dark:text-[#8f8d86]">
                    <span aria-hidden="true" />
                    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center">
                      <span>{t('codeAgentDiffBaseRefBranch')}</span>
                      <span className="text-right">{t('codeAgentDiffBaseRefRemote')}</span>
                    </div>
                  </div>
                  <div className="max-h-64 min-w-0 overflow-y-auto overflow-x-hidden p-1">
                    {isWorkspaceRefsPending && !workspaceRefs ? (
                      <div className="px-2 py-2 text-xs text-[#87867f] dark:text-[#8f8d86]">{t('codeAgentDiffBaseRefLoading')}</div>
                    ) : workspaceRefsError ? (
                      <div className="px-2 py-2 text-xs text-[#9f462c] dark:text-[#ff9b78]">{t('codeAgentDiffBaseRefUnavailable')}</div>
                    ) : !workspaceRefs?.available ? (
                      <div className="px-2 py-2 text-xs text-[#87867f] dark:text-[#8f8d86]">{t('codeAgentDiffBaseRefUnavailable')}</div>
                    ) : filteredBaseRefItems.length === 0 ? (
                      <div className="px-2 py-2 text-xs text-[#87867f] dark:text-[#8f8d86]">{t('codeAgentNoMatchingRefs')}</div>
                    ) : (
                      <>
                        {filteredBaseRefItems.includes(AUTOMATIC_BASE_REF) ? (
                          <button
                            type="button"
                            className="grid h-8 w-full grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 rounded px-2 text-left text-xs text-[#141413] hover:bg-[#f0eee6] dark:text-[#faf9f5] dark:hover:bg-[#30302e]"
                            onClick={(event) => {
                              selectDiffBaseRef(null);
                              event.currentTarget.closest('details')?.removeAttribute('open');
                            }}
                          >
                            {diffBaseRef === null ? <Check className="h-3.5 w-3.5 text-[#9f462c] dark:text-[#ffb197]" /> : <span />}
                            <span className="min-w-0 truncate">{t('codeAgentDiffBaseRefAutomatic')}</span>
                          </button>
                        ) : null}
                        {matchingBaseRefChoices.map((choice) => {
                          const item = valueForBaseRefChoice(choice);
                          if (!filteredBaseRefItems.includes(item)) {
                            return null;
                          }
                          const hasBoth = choice.local !== null && choice.remote !== null;
                          const useRemote = choice.remote?.name === item;
                          const selectItem = (details: HTMLDetailsElement | null) => {
                            selectDiffBaseRef(item);
                            details?.removeAttribute('open');
                          };
                          return (
                            <div
                              key={choice.id}
                              role="button"
                              tabIndex={0}
                              className="grid h-8 w-full grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 rounded px-2 text-left text-xs text-[#141413] hover:bg-[#f0eee6] dark:text-[#faf9f5] dark:hover:bg-[#30302e]"
                              onClick={(event) => {
                                selectItem(event.currentTarget.closest('details'));
                              }}
                              onKeyDown={(event) => {
                                if (event.key !== 'Enter' && event.key !== ' ') {
                                  return;
                                }
                                event.preventDefault();
                                selectItem(event.currentTarget.closest('details'));
                              }}
                            >
                              {diffBaseRef === item ? <Check className="h-3.5 w-3.5 text-[#9f462c] dark:text-[#ffb197]" /> : <span />}
                              <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center overflow-hidden">
                                <span className="min-w-0 truncate pr-2">{choice.label}</span>
                                {hasBoth ? (
                                  <span
                                    className="flex justify-end"
                                    onClick={(event) => event.stopPropagation()}
                                    onPointerDown={(event) => event.stopPropagation()}
                                  >
                                    <label className="relative inline-flex h-4 w-7 cursor-pointer items-center">
                                      <input
                                        type="checkbox"
                                        className="peer sr-only"
                                        aria-label={t('codeAgentDiffBaseRefUseRemote', { ref: choice.label })}
                                        checked={useRemote}
                                        onChange={(event) => {
                                          const nextRef = event.currentTarget.checked
                                            ? choice.remote?.name
                                            : choice.local?.name;
                                          if (nextRef) {
                                            selectDiffBaseRef(nextRef);
                                          }
                                        }}
                                      />
                                      <span className="h-3.5 w-7 rounded-full bg-[#dedbd0] transition-colors peer-checked:bg-[#c96442] dark:bg-[#30302e] dark:peer-checked:bg-[#d97757]" />
                                      <span className="absolute left-0.5 h-2.5 w-2.5 rounded-full bg-[#faf9f5] transition-transform peer-checked:translate-x-3 dark:bg-[#faf9f5]" />
                                    </label>
                                  </span>
                                ) : choice.remote ? (
                                  <span className="flex justify-end text-[#87867f] dark:text-[#8f8d86]" title={t('codeAgentDiffBaseRefRemoteOnly')}>
                                    <Check className="h-3.5 w-3.5" />
                                  </span>
                                ) : null}
                              </span>
                            </div>
                          );
                        })}
                      </>
                    )}
                  </div>
                </div>
              </details>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label={refreshDiffLabel}
            title={refreshDiffLabel}
            disabled={isDiffRefreshPending}
            onClick={refreshDiff}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[#dedbd0] bg-[#faf9f5] text-[#5e5d59] transition-colors hover:bg-[#f0eee6] hover:text-[#141413] disabled:cursor-wait disabled:opacity-60 dark:border-[#30302e] dark:bg-[#1d1d1b] dark:text-[#b0aea5] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isDiffRefreshPending ? 'animate-spin' : ''}`} />
          </button>
        <button
          type="button"
          aria-label={t('codeAgentStackedDiffView')}
          aria-pressed={diffRenderMode === 'stacked'}
          title={t('codeAgentStackedDiffView')}
          onClick={() => selectDiffRenderMode('stacked')}
          className={`inline-flex h-7 w-7 items-center justify-center rounded-md border text-[#5e5d59] transition-colors hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#b0aea5] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5] ${
            diffRenderMode === 'stacked'
              ? 'border-[#c96442]/60 bg-[#fff2ec] text-[#9f462c] dark:border-[#d97757]/60 dark:bg-[#2a211d] dark:text-[#ffb197]'
              : 'border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]'
          }`}
        >
          <Rows3 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={t('codeAgentSplitDiffView')}
          aria-pressed={diffRenderMode === 'split'}
          title={t('codeAgentSplitDiffView')}
          onClick={() => selectDiffRenderMode('split')}
          className={`inline-flex h-7 w-7 items-center justify-center rounded-md border text-[#5e5d59] transition-colors hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#b0aea5] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5] ${
            diffRenderMode === 'split'
              ? 'border-[#c96442]/60 bg-[#fff2ec] text-[#9f462c] dark:border-[#d97757]/60 dark:bg-[#2a211d] dark:text-[#ffb197]'
              : 'border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]'
          }`}
        >
          <Columns2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={wordWrapLabel}
          aria-pressed={wordWrap}
          title={wordWrapLabel}
          onClick={toggleWordWrap}
          className={`inline-flex h-7 w-7 items-center justify-center rounded-md border text-[#5e5d59] transition-colors hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#b0aea5] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5] ${
            wordWrap
              ? 'border-[#c96442]/60 bg-[#fff2ec] text-[#9f462c] dark:border-[#d97757]/60 dark:bg-[#2a211d] dark:text-[#ffb197]'
              : 'border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]'
          }`}
        >
          <WrapText className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={ignoreWhitespaceLabel}
          aria-pressed={diffIgnoreWhitespace}
          title={ignoreWhitespaceLabel}
          onClick={toggleDiffIgnoreWhitespace}
          className={`inline-flex h-7 w-7 items-center justify-center rounded-md border text-[#5e5d59] transition-colors hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#b0aea5] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5] ${
            diffIgnoreWhitespace
              ? 'border-[#c96442]/60 bg-[#fff2ec] text-[#9f462c] dark:border-[#d97757]/60 dark:bg-[#2a211d] dark:text-[#ffb197]'
              : 'border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]'
          }`}
        >
          <Pilcrow className="h-3.5 w-3.5" />
        </button>
        </div>
    </>
  );

  return (
    <CodeAgentWorkspaceDiffPanelShell
      mode="embedded"
      header={headerRow}
      testId="code-agent-workspace-diff-viewer"
    >
      <CodeAgentWorkspaceDiffPanelViewport>
        {diff?.truncated ? (
          <div
            className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300"
            data-testid="code-agent-workspace-diff-truncated"
          >
            {t('codeAgentDiffPreviewTruncated')}
          </div>
        ) : null}
        {isPending && diff === null ? (
          <CodeAgentWorkspaceDiffLoadingState label={loadingDiffLabel} />
        ) : error && diff === null ? (
          <div className="rounded-lg border border-[#f0b49b]/50 bg-[#fff2ec] px-3 py-2 text-xs text-[#9f462c] dark:border-[#7a321f]/60 dark:bg-[#2a211d] dark:text-[#ff9b78]" role="alert">
            {error}
          </div>
        ) : (
          <>
            {error ? (
              <div
                className="shrink-0 border-b border-[#f0b49b]/50 bg-[#fff2ec] px-3 py-1.5 text-[11px] text-[#9f462c] dark:border-[#7a321f]/60 dark:bg-[#2a211d] dark:text-[#ff9b78]"
                data-testid="code-agent-workspace-diff-error-bar"
                role="alert"
              >
                {error}
              </div>
            ) : null}
            {!diff?.available ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-3 text-center">
          <p className="text-xs text-[#87867f] dark:text-[#8f8d86]">{t('codeAgentChangesUnavailable')}</p>
        </div>
      ) : !renderablePatch ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-3 text-center">
          <p className="text-xs text-[#87867f] dark:text-[#8f8d86]">{emptyPatchLabel}</p>
        </div>
      ) : renderablePatch.kind === 'raw' ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto rounded-lg border border-[#dedbd0] bg-[#faf9f5] p-2 dark:border-[#30302e] dark:bg-[#1d1d1b]">
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <p className="text-[11px] text-[#87867f] dark:text-[#8f8d86]">{renderablePatch.reason}</p>
            <pre
              className={`min-h-80 flex-1 overflow-auto rounded-md border border-[#dedbd0] bg-[#f5f4ed] p-3 font-mono text-[11px] leading-relaxed text-[#5e5d59] dark:border-[#30302e] dark:bg-[#141413] dark:text-[#b0aea5] ${
                wordWrap ? 'whitespace-pre-wrap break-words' : ''
              }`}
              data-testid="code-agent-workspace-raw-diff"
            >
              {renderablePatch.text}
            </pre>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2" onClickCapture={handleDiffClickCapture}>
          {diffFileSummaries.length > 0 ? (
            <div
              className="rounded-lg border border-[#dedbd0] bg-[#faf9f5] p-2 dark:border-[#30302e] dark:bg-[#1d1d1b]"
              data-testid="code-agent-diff-file-nav"
            >
              <div className="mb-1 flex items-center justify-between gap-2 px-1 text-[11px] text-[#87867f] dark:text-[#8f8d86]">
                <span className="font-semibold text-[#5e5d59] dark:text-[#b0aea5]">
                  {t('codeAgentChangedFilesCount', { count: diffFileSummaries.length })}
                </span>
              </div>
              <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                {diffFileSummaries.map((file) => (
                  <div
                    key={file.id}
                    className={`inline-flex max-w-[18rem] shrink-0 overflow-hidden rounded-md border text-[11px] transition-colors ${
                      selectedFilePath === file.path
                        ? 'border-[#c96442]/60 bg-[#fff2ec] text-[#9f462c] dark:border-[#d97757]/60 dark:bg-[#2a211d] dark:text-[#ffb197]'
                        : 'border-[#dedbd0] bg-[#f5f4ed] text-[#4d4c48] hover:bg-[#f0eee6] dark:border-[#30302e] dark:bg-[#242422] dark:text-[#e8e6dc] dark:hover:bg-[#30302e]'
                    }`}
                  >
                    <button
                      type="button"
                      aria-label={`${onOpenFile ? 'Open' : 'Select'} diff file ${file.path}`}
                      title={file.path}
                      onClick={(event) => {
                        event.stopPropagation();
                        openCodeAgentDiffFilePrimaryAction({
                          filePath: file.path,
                          openInWorkspaceFileViewer: onOpenFile,
                          openFallback: () => scrollToDiffItem(file.id),
                        });
                      }}
                      className="inline-flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442]"
                    >
                      <FileCode2 className="h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]" />
                      <span className="truncate font-mono">{file.path}</span>
                      <span className="ml-1 inline-flex shrink-0 gap-1 tabular-nums">
                        <span className="font-mono text-[#2f6f4e] dark:text-[#65d08a]">+{formatCompactDiffCount(file.additions)}</span>
                        <span className="font-mono text-[#9f462c] dark:text-[#ff9b78]">-{formatCompactDiffCount(file.deletions)}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Scroll to diff file ${file.path}`}
                      title={`Scroll to ${file.path}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        scrollToDiffItem(file.id);
                      }}
                      className="inline-flex w-7 shrink-0 items-center justify-center border-l border-current/10 text-[#87867f] transition-colors hover:bg-current/10 hover:text-[#5e5d59] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:text-[#8f8d86] dark:hover:text-[#b0aea5]"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <CodeAgentAnnotatableCodeView
            viewerRef={codeViewRef}
            files={parsed.items.map((item) => ({
              fileDiff: item.fileDiff,
              filePath: resolveFileDiffPath(item.fileDiff),
              fileKey: item.id,
              collapsed: item.collapsed === true,
            }))}
            sectionId={reviewCommentSectionId}
            sectionTitle={reviewCommentSectionTitle}
            reviewComments={reviewComments}
            onAddReviewComment={onAddReviewComment}
            onRemoveReviewComment={onRemoveReviewComment}
            className="diff-render-surface min-h-80 flex-1 overflow-auto rounded-lg border border-[#dedbd0] bg-[#faf9f5] text-xs dark:border-[#30302e] dark:bg-[#1d1d1b]"
            renderHeaderPrefix={(fileDiff, fileKey, collapsed) => {
              const filePath = resolveFileDiffPath(fileDiff);
              return (
                <button
                  type="button"
                  aria-label={t(collapsed ? 'codeAgentExpandDiffFile' : 'codeAgentCollapseDiffFile', { path: filePath })}
                  aria-expanded={!collapsed}
                  title={t(collapsed ? 'codeAgentExpandDiff' : 'codeAgentCollapseDiff')}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleDiffFileCollapsed(fileKey);
                  }}
                  className={`inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 transition-colors hover:bg-[#141413]/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:hover:bg-[#faf9f5]/10 ${getDiffCollapseIconClassName(fileDiff)}`}
                >
                  {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
              );
            }}
            options={{
              diffStyle: diffRenderMode === 'split' ? 'split' : 'unified',
              lineDiffType: 'none',
              overflow: wordWrap ? 'wrap' : 'scroll',
              theme: resolveCodeAgentDiffThemeName(resolvedTheme),
              themeType: resolvedTheme,
              unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
              stickyHeaders: true,
              layout: { paddingTop: 8, paddingBottom: 8, gap: 8 },
            }}
          />
        </div>
      )}
          </>
        )}
      </CodeAgentWorkspaceDiffPanelViewport>
    </CodeAgentWorkspaceDiffPanelShell>
  );
};
