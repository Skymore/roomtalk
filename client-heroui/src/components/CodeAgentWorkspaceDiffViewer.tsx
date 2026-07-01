import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileDiffMetadata } from '@pierre/diffs';
import { type CodeViewHandle } from '@pierre/diffs/react';
import { ArrowRight, Check, ChevronDown, ChevronRight, Columns2, Pilcrow, RefreshCw, Rows3, Search, WrapText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { loadCodeAgentWorkspaceDiff, loadCodeAgentWorkspaceRefs, type CodeAgentWorkspaceDiff, type CodeAgentWorkspaceDiffScope, type CodeAgentWorkspaceRefs } from '../utils/cocoWorkspace';
import { buildCodeAgentBaseRefChoices, filterCodeAgentBaseRefChoices, type CodeAgentBaseRefChoice } from '../utils/codeWorkspaceRefs';
import {
  selectCodeAgentDiffBranchBaseRef,
  selectCodeAgentDiffScope,
  useCodeAgentDiffPanelSelection,
} from '../utils/codeAgentDiffPanelStore';
import {
  getValidExplicitCodeAgentDiffFileKeys,
  removeCodeAgentDiffFileKey,
  toggleCodeAgentDiffFileKey,
} from '../utils/codeAgentDiffFileVisibility';
import {
  buildFileDiffRenderKey,
  buildDiffTitlePathMap,
  getCodeAgentDiffFilePreviewState,
  getDiffCollapseIconClassName,
  getRenderablePatch,
  isPureRenameFileDiff,
  resolveCodeAgentDiffThemeName,
  resolveDiffTitleOpenPath,
  resolveFileDiffPath,
  summarizeFileDiffStat,
  withDiffLineTarget,
  type CodeAgentDiffFilePreviewState,
} from '../utils/codeAgentDiffRendering';
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
const EMPTY_DIFF_FILE_KEYS: ReadonlySet<string> = new Set();
const RENDER_DIFF_FILE_PREVIEW_STATE: CodeAgentDiffFilePreviewState = { kind: 'render' };
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

interface DiffFileVisibilityEntry {
  collapsedFileKeys: Set<string>;
  viewedFileKeys: Set<string>;
  revealedLargeFileKeys: Set<string>;
}

type DiffFileVisibilityState = Map<string, DiffFileVisibilityEntry>;

interface ScopedWorkspaceDiff {
  scopeKey: string;
  diff: CodeAgentWorkspaceDiff;
}

export interface CodeAgentWorkspaceDiffFileSummary {
  id: string;
  path: string;
  additions: number;
  deletions: number;
}

interface ParsedWorkspaceDiffItem {
  id: string;
  type: 'diff';
  fileDiff: FileDiffMetadata;
  collapsed: boolean;
  viewed: boolean;
  previewState: CodeAgentDiffFilePreviewState;
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
  const [diffState, setDiffState] = useState<ScopedWorkspaceDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [wordWrap, setWordWrap] = useState(readInitialDiffWordWrap);
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>(readInitialDiffRenderMode);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(readInitialDiffIgnoreWhitespace);
  const [diffRefreshNonce, setDiffRefreshNonce] = useState(0);
  const diffPanelSelection = useCodeAgentDiffPanelSelection(roomId);
  const diffScope: CodeAgentWorkspaceDiffScope = diffPanelSelection.kind === 'unstaged' ? 'unstaged' : 'branch';
  const diffBaseRef = diffPanelSelection.kind === 'branch' ? diffPanelSelection.baseRef : null;
  const diffContentScopeKey = `${roomId}:${refreshKey}:${diffIgnoreWhitespace ? 'ignore-whitespace' : 'all-whitespace'}:${diffScope}:${diffScope === 'branch' ? diffBaseRef ?? 'auto' : 'working-tree'}`;
  const diff = diffState?.scopeKey === diffContentScopeKey ? diffState.diff : null;
  const [baseRefQuery, setBaseRefQuery] = useState('');
  const [workspaceRefs, setWorkspaceRefs] = useState<CodeAgentWorkspaceRefs | null>(null);
  const [workspaceRefsError, setWorkspaceRefsError] = useState<string | null>(null);
  const [isWorkspaceRefsPending, setIsWorkspaceRefsPending] = useState(false);
  const codeViewRef = useRef<CodeViewHandle<DiffCommentAnnotationGroup> | null>(null);
  const [diffFileVisibility, setDiffFileVisibility] = useState<DiffFileVisibilityState>(() => new Map());
  const diffFileVisibilityScopeKey = `${roomId}:${diffScope}:${diffScope === 'branch' ? diffBaseRef ?? 'auto' : 'working-tree'}`;
  const scopedDiffFileVisibility = diffFileVisibility.get(diffFileVisibilityScopeKey);
  const collapsedDiffFileKeys = scopedDiffFileVisibility?.collapsedFileKeys ?? EMPTY_DIFF_FILE_KEYS;
  const viewedDiffFileKeys = scopedDiffFileVisibility?.viewedFileKeys ?? EMPTY_DIFF_FILE_KEYS;
  const revealedLargeDiffFileKeys = scopedDiffFileVisibility?.revealedLargeFileKeys ?? EMPTY_DIFF_FILE_KEYS;
  const wordWrapLabel = t(wordWrap ? 'codeAgentDisableDiffLineWrapping' : 'codeAgentEnableDiffLineWrapping');
  const ignoreWhitespaceLabel = t(diffIgnoreWhitespace ? 'codeAgentShowWhitespaceChanges' : 'codeAgentHideWhitespaceChanges');
  const refreshDiffLabel = t('codeAgentRefreshWorkspaceDiff');
  const isDiffRefreshPending = isPending || isWorkspaceRefsPending;
  const diffScopeLabel = t(diffScope === 'unstaged' ? 'codeAgentDiffScopeWorkingTree' : 'codeAgentDiffScopeBranch');
  const loadingDiffLabel = t(diffScope === 'unstaged' ? 'codeAgentLoadingWorkingTreeDiff' : 'codeAgentLoadingBranchDiff');
  const diffHeadRefLabel = diff?.headRef || workspaceRefs?.headRef || 'HEAD';
  const diffBaseRefLabel = diff?.baseRef || diffBaseRef || t('codeAgentDiffBaseRefAutomatic');
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
    setDiffFileVisibility((current) => {
      const scopedVisibility = current.get(diffFileVisibilityScopeKey);
      const collapsedFileKeys = new Set(toggleCodeAgentDiffFileKey(
        [...(scopedVisibility?.collapsedFileKeys ?? [])],
        fileKey,
      ));
      const viewedFileKeys = new Set(scopedVisibility?.viewedFileKeys ?? []);
      const revealedLargeFileKeys = new Set(scopedVisibility?.revealedLargeFileKeys ?? []);
      const next = new Map(current);
      next.set(diffFileVisibilityScopeKey, {
        collapsedFileKeys,
        viewedFileKeys,
        revealedLargeFileKeys,
      });
      return next;
    });
  };

  const toggleDiffFileViewed = (fileKey: string) => {
    setDiffFileVisibility((current) => {
      const scopedVisibility = current.get(diffFileVisibilityScopeKey);
      const collapsedFileKeys = new Set(scopedVisibility?.collapsedFileKeys ?? []);
      const viewedBeforeToggle = scopedVisibility?.viewedFileKeys.has(fileKey) === true;
      const viewedFileKeys = new Set(toggleCodeAgentDiffFileKey(
        [...(scopedVisibility?.viewedFileKeys ?? [])],
        fileKey,
      ));
      const revealedLargeFileKeys = new Set(scopedVisibility?.revealedLargeFileKeys ?? []);
      if (!viewedBeforeToggle) {
        viewedFileKeys.add(fileKey);
        collapsedFileKeys.add(fileKey);
      }
      const next = new Map(current);
      next.set(diffFileVisibilityScopeKey, {
        collapsedFileKeys,
        viewedFileKeys,
        revealedLargeFileKeys,
      });
      return next;
    });
  };

  const revealLargeDiffFile = (fileKey: string) => {
    setDiffFileVisibility((current) => {
      const scopedVisibility = current.get(diffFileVisibilityScopeKey);
      const collapsedFileKeys = new Set(removeCodeAgentDiffFileKey(
        [...(scopedVisibility?.collapsedFileKeys ?? [])],
        fileKey,
      ));
      const viewedFileKeys = new Set(scopedVisibility?.viewedFileKeys ?? []);
      const revealedLargeFileKeys = new Set(scopedVisibility?.revealedLargeFileKeys ?? []);
      revealedLargeFileKeys.add(fileKey);
      const next = new Map(current);
      next.set(diffFileVisibilityScopeKey, {
        collapsedFileKeys,
        viewedFileKeys,
        revealedLargeFileKeys,
      });
      return next;
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
          setDiffState({
            scopeKey: diffContentScopeKey,
            diff: nextDiff,
          });
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
  }, [
    diffBaseRef,
    diffContentScopeKey,
    diffIgnoreWhitespace,
    diffRefreshNonce,
    diffScope,
    enabled,
    roomId,
  ]);

  const renderablePatch = useMemo(
    () => getRenderablePatch(diff?.patch, `workspace:${roomId}:${refreshKey}:${diffScope}:${diffBaseRef ?? 'auto'}:${resolvedTheme}`, {
      compactPartialHunkOffsets: true,
      truncated: diff?.truncated === true,
    }),
    [diff?.patch, diff?.truncated, diffBaseRef, diffScope, refreshKey, resolvedTheme, roomId],
  );
  const showTruncatedDiff = diff?.truncated === true || renderablePatch?.truncated === true;
  const truncatedDiffMessage = renderablePatch?.notice ?? t('codeAgentDiffPreviewTruncated');
  const parsed = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== 'files') {
      return { items: [] as ParsedWorkspaceDiffItem[] };
    }

    const files = [...renderablePatch.files].sort((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: 'base',
      }),
    );
    const filesWithIds = files.map((fileDiff, fileIndex) => ({
      fileDiff,
      id: buildFileDiffRenderKey(fileDiff) || `${fileIndex}`,
    }));
    const visibilityFiles = filesWithIds.map(({ id }) => ({ id }));
    const validCollapsedDiffFileKeys = new Set(getValidExplicitCodeAgentDiffFileKeys(
      visibilityFiles,
      [...collapsedDiffFileKeys],
    ));
    const validViewedDiffFileKeys = new Set(getValidExplicitCodeAgentDiffFileKeys(
      visibilityFiles,
      [...viewedDiffFileKeys],
    ));
    const validRevealedLargeDiffFileKeys = new Set(getValidExplicitCodeAgentDiffFileKeys(
      visibilityFiles,
      [...revealedLargeDiffFileKeys],
    ));
    const items = filesWithIds.map(({ fileDiff, id }) => {
      const previewState = getCodeAgentDiffFilePreviewState(fileDiff);
      const suppressed = previewState.kind === 'suppressed'
        && (previewState.reason !== 'large' || !validRevealedLargeDiffFileKeys.has(id));
      const collapsed = suppressed || validCollapsedDiffFileKeys.has(id);
      const viewed = validViewedDiffFileKeys.has(id);
      return {
        id,
        type: 'diff' as const,
        fileDiff,
        collapsed,
        viewed,
        previewState: suppressed ? previewState : RENDER_DIFF_FILE_PREVIEW_STATE,
        version: collapsed ? 1 : 0,
      };
    });
    return { items };
  }, [collapsedDiffFileKeys, renderablePatch, revealedLargeDiffFileKeys, viewedDiffFileKeys]);
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
          roomId,
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
        roomId,
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
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <div className="inline-flex max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap">
            <details className="group relative min-w-0 shrink-0">
              <summary
                aria-label={`${t('codeAgentDiffScope')}: ${diffScopeLabel}`}
                className="inline-flex h-7 max-w-40 cursor-pointer list-none items-center gap-1 rounded-md border border-[#dedbd0] bg-[#faf9f5] px-2 text-xs font-medium text-[#141413] transition-colors hover:bg-[#f0eee6] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:border-[#30302e] dark:bg-[#1d1d1b] dark:text-[#faf9f5] dark:hover:bg-[#30302e] [&::-webkit-details-marker]:hidden"
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
              className="flex min-w-0 max-w-full shrink-0 items-center gap-1.5 overflow-visible text-xs text-[#87867f] dark:text-[#8f8d86]"
              title={`${diffHeadRefLabel} -> ${diffBaseRefLabel}`}
              aria-label={`${t('codeAgentDiffComparing')}: ${diffHeadRefLabel} -> ${diffBaseRefLabel}`}
            >
              <span className="hidden max-w-28 truncate sm:inline">{diffHeadRefLabel}</span>
              <ArrowRight className="hidden h-3.5 w-3.5 shrink-0 opacity-70 sm:block" />
              <details className="group relative min-w-0 shrink-0">
                <summary
                  aria-label={`${t('codeAgentDiffBaseRef')}: ${diffBaseRefLabel}`}
                  className="inline-flex h-7 max-w-32 cursor-pointer list-none items-center gap-1 rounded-md px-1.5 text-xs font-medium text-[#5e5d59] transition-colors hover:bg-[#f0eee6] hover:text-[#141413] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:text-[#b0aea5] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5] [&::-webkit-details-marker]:hidden"
                >
                  <span className="truncate">{diffBaseRefLabel}</span>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#87867f] transition-transform group-open:rotate-180 dark:text-[#8f8d86]" />
                </summary>
                <div className="absolute left-0 top-8 z-50 w-60 max-w-[calc(100vw-1rem)] overflow-hidden rounded-md border border-[#dedbd0] bg-[#faf9f5] shadow-lg dark:border-[#30302e] dark:bg-[#1d1d1b]">
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
                    <div className="inline-grid max-w-full grid-cols-[minmax(0,9rem)_3rem] items-center gap-3">
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
                              <span className="inline-grid max-w-full grid-cols-[minmax(0,9rem)_3rem] items-center gap-3 overflow-hidden">
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
        <div
          className="inline-flex shrink-0"
          role="group"
          aria-label={`${t('codeAgentStackedDiffView')} / ${t('codeAgentSplitDiffView')}`}
        >
          <button
            type="button"
            aria-label={t('codeAgentStackedDiffView')}
            aria-pressed={diffRenderMode === 'stacked'}
            title={t('codeAgentStackedDiffView')}
            onClick={() => selectDiffRenderMode('stacked')}
            className={`inline-flex h-7 w-7 items-center justify-center rounded-l-md rounded-r-none border text-[#5e5d59] transition-colors hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#b0aea5] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5] ${
              diffRenderMode === 'stacked'
                ? 'z-10 border-[#c96442]/60 bg-[#fff2ec] text-[#9f462c] dark:border-[#d97757]/60 dark:bg-[#2a211d] dark:text-[#ffb197]'
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
            className={`-ml-px inline-flex h-7 w-7 items-center justify-center rounded-l-none rounded-r-md border text-[#5e5d59] transition-colors hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#b0aea5] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5] ${
              diffRenderMode === 'split'
                ? 'z-10 border-[#c96442]/60 bg-[#fff2ec] text-[#9f462c] dark:border-[#d97757]/60 dark:bg-[#2a211d] dark:text-[#ffb197]'
                : 'border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]'
            }`}
          >
            <Columns2 className="h-3.5 w-3.5" />
          </button>
        </div>
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
        {showTruncatedDiff ? (
          <div
            className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300"
            data-testid="code-agent-workspace-diff-truncated"
          >
            {truncatedDiffMessage}
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
        <div className="min-h-0 flex-1 overflow-auto p-2" data-testid="code-agent-workspace-raw-diff-shell">
          <div className="space-y-2">
            <p className="text-[11px] text-[#87867f] dark:text-[#8f8d86]">{renderablePatch.reason}</p>
            <pre
              className={`max-h-[72vh] overflow-auto rounded-md border border-[#dedbd0] bg-[#f5f4ed] p-3 font-mono text-[11px] leading-relaxed text-[#5e5d59] dark:border-[#30302e] dark:bg-[#141413] dark:text-[#b0aea5] ${
                wordWrap ? 'whitespace-pre-wrap break-words' : ''
              }`}
              data-testid="code-agent-workspace-raw-diff"
            >
              {renderablePatch.text}
            </pre>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1" onClickCapture={handleDiffClickCapture}>
          <CodeAgentAnnotatableCodeView
            viewerRef={codeViewRef}
            key={diffFileVisibilityScopeKey}
            files={parsed.items.map((item) => ({
              fileDiff: item.fileDiff,
              filePath: resolveFileDiffPath(item.fileDiff),
              fileKey: item.id,
              collapsed: item.collapsed === true,
              viewed: item.viewed === true,
              previewState: item.previewState,
            }))}
            sectionId={reviewCommentSectionId}
            sectionTitle={reviewCommentSectionTitle}
            reviewComments={reviewComments}
            onAddReviewComment={onAddReviewComment}
            onRemoveReviewComment={onRemoveReviewComment}
            className="diff-render-surface h-full min-h-0 flex-1 overflow-auto"
            renderHeaderPrefix={(fileDiff, fileKey, collapsed, viewed, previewState) => {
              const filePath = resolveFileDiffPath(fileDiff);
              const suppression = previewState.kind === 'suppressed' ? previewState : null;
              const canLoadSuppressedDiff = suppression?.reason === 'large';
              const isCollapseButtonDisabled = suppression !== null && !canLoadSuppressedDiff;
              const suppressionMessageKey = suppression?.reason === 'large'
                ? 'codeAgentLargeDiffSuppressedMessage'
                : 'codeAgentNonTextDiffSuppressedMessage';
              return (
                <div className="inline-flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    aria-label={t(collapsed ? 'codeAgentExpandDiffFile' : 'codeAgentCollapseDiffFile', { path: filePath })}
                    aria-expanded={!collapsed}
                    disabled={isCollapseButtonDisabled}
                    title={t(canLoadSuppressedDiff ? 'codeAgentLoadDiff' : collapsed ? 'codeAgentExpandDiff' : 'codeAgentCollapseDiff')}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (suppression) {
                        if (canLoadSuppressedDiff) {
                          revealLargeDiffFile(fileKey);
                        }
                        return;
                      }
                      toggleDiffFileCollapsed(fileKey);
                    }}
                    className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border-0 bg-transparent p-0 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] disabled:cursor-not-allowed disabled:opacity-50 ${
                      isCollapseButtonDisabled
                        ? 'text-[#87867f] dark:text-[#8f8d86]'
                        : `cursor-pointer hover:bg-[#141413]/10 dark:hover:bg-[#faf9f5]/10 ${canLoadSuppressedDiff ? 'text-[#9f462c] dark:text-[#ffb197]' : getDiffCollapseIconClassName(fileDiff)}`
                    }`}
                  >
                    {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                  <button
                    type="button"
                    aria-label={t(viewed ? 'codeAgentUnmarkDiffFileViewed' : 'codeAgentMarkDiffFileViewed', { path: filePath })}
                    aria-pressed={viewed}
                    title={t(viewed ? 'codeAgentUnmarkDiffViewed' : 'codeAgentMarkDiffViewed')}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleDiffFileViewed(fileKey);
                    }}
                    className={`inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 p-0 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] ${
                      viewed
                        ? 'bg-[#2f7d46]/10 text-[#2f7d46] hover:bg-[#2f7d46]/20 dark:bg-[#48a868]/15 dark:text-[#8bd59e] dark:hover:bg-[#48a868]/25'
                        : 'bg-transparent text-[#87867f] hover:bg-[#141413]/10 hover:text-[#141413] dark:text-[#8f8d86] dark:hover:bg-[#faf9f5]/10 dark:hover:text-[#faf9f5]'
                    }`}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  {suppression && canLoadSuppressedDiff ? (
                    <button
                      type="button"
                      className="inline-flex h-5 max-w-48 cursor-pointer items-center gap-1 overflow-hidden rounded-sm bg-[#f0eee6] px-1.5 text-[10px] font-medium text-[#5e5d59] transition-colors hover:bg-[#ead6cc] hover:text-[#9f462c] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:bg-[#30302e] dark:text-[#b0aea5] dark:hover:bg-[#3b332f] dark:hover:text-[#ffb197] sm:max-w-64"
                      data-testid="code-agent-diff-file-suppression-load"
                      title={t('codeAgentLargeDiffSuppressedMessage')}
                      onClick={(event) => {
                        event.stopPropagation();
                        revealLargeDiffFile(fileKey);
                      }}
                    >
                      <span className="hidden min-w-0 truncate sm:block">
                        {t('codeAgentLargeDiffSuppressedMessage')}
                      </span>
                      <span className="shrink-0 text-[#9f462c] dark:text-[#ffb197]">
                        {t('codeAgentLoadDiff')}
                      </span>
                    </button>
                  ) : suppression ? (
                    <span
                      className="inline-flex h-5 max-w-48 items-center gap-1 overflow-hidden rounded-sm bg-[#f0eee6] px-1.5 text-[10px] font-medium text-[#5e5d59] dark:bg-[#30302e] dark:text-[#b0aea5]"
                      data-testid="code-agent-diff-file-suppression"
                      title={t(suppressionMessageKey)}
                    >
                      <span className="truncate">
                        {t('codeAgentNonTextDiff')}
                      </span>
                    </span>
                  ) : null}
                </div>
              );
            }}
            renderHeaderMetadata={(_fileDiff, fileKey, _collapsed, _viewed, previewState) => {
              if (previewState.kind !== 'suppressed') {
                if (!isPureRenameFileDiff(_fileDiff)) {
                  return null;
                }
                return (
                  <span
                    className="inline-flex max-w-[28rem] items-center overflow-hidden rounded-sm bg-[#f0eee6] px-2 py-1 text-[11px] leading-4 text-[#5e5d59] dark:bg-[#30302e] dark:text-[#b0aea5]"
                    data-testid="code-agent-diff-file-rename-notice"
                    title={t('codeAgentRenameOnlyDiffMessage')}
                  >
                    <span className="min-w-0 truncate">
                      {t('codeAgentRenameOnlyDiffMessage')}
                    </span>
                  </span>
                );
              }
              const messageKey = previewState.reason === 'large'
                ? 'codeAgentLargeDiffSuppressedMessage'
                : 'codeAgentNonTextDiffContentsUnavailable';
              return (
                <span
                  className={`${previewState.reason === 'large' ? 'hidden sm:inline-flex' : 'inline-flex'} max-w-[28rem] items-center gap-2 overflow-hidden rounded-sm bg-[#f0eee6] px-2 py-1 text-[11px] leading-4 text-[#5e5d59] dark:bg-[#30302e] dark:text-[#b0aea5]`}
                  data-testid="code-agent-diff-file-suppression-notice"
                  title={t(messageKey)}
                >
                  <span className="min-w-0 truncate">
                    {t(messageKey)}
                  </span>
                  {previewState.reason === 'large' ? (
                    <button
                      type="button"
                      className="shrink-0 rounded-sm px-1.5 py-0.5 text-[#9f462c] hover:bg-[#c96442]/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:text-[#ffb197] dark:hover:bg-[#d97757]/15"
                      onClick={(event) => {
                        event.stopPropagation();
                        revealLargeDiffFile(fileKey);
                      }}
                    >
                      {t('codeAgentLoadDiff')}
                    </button>
                  ) : null}
                </span>
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
