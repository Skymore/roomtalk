import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileDiffMetadata } from '@pierre/diffs';
import { type CodeViewHandle } from '@pierre/diffs/react';
import { ArrowRight, Check, ChevronDown, ChevronRight, Columns2, Files, Pilcrow, RefreshCw, Rows3, Search, WrapText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { loadCodeAgentWorkspaceDiff, loadCodeAgentWorkspaceRefs, type CodeAgentWorkspaceDiff, type CodeAgentWorkspaceDiffScope, type CodeAgentWorkspaceRefs } from '../utils/cocoWorkspace';
import { buildCodeAgentBaseRefChoices, filterCodeAgentBaseRefChoices, type CodeAgentBaseRefChoice } from '../utils/codeWorkspaceRefs';
import {
  getCodeAgentDiffReviewSectionId,
  selectCodeAgentDiffReviewSection,
  selectCodeAgentDiffBranchBaseRef,
  useCodeAgentDiffPanelSelection,
} from '../utils/codeAgentDiffPanelStore';
import {
  buildCodeAgentReviewSections,
  type CodeAgentReviewSectionItem,
} from '../utils/codeAgentReviewSections';
import {
  getValidExplicitCodeAgentDiffFileKeys,
  removeCodeAgentDiffFileKey,
  toggleCodeAgentDiffFileKey,
} from '../utils/codeAgentDiffFileVisibility';
import {
  updateCodeAgentDiffFileVisibility,
  useCodeAgentDiffFileVisibility,
} from '../utils/codeAgentDiffFileVisibilityStore';
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
import { CodeAgentDiffStatLabel } from './CodeAgentDiffStatLabel';
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
  mobileLayout?: boolean;
  onOpenChangedFiles?: () => void;
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
const MOBILE_DIFF_WORD_ALT_MAX_LINE_LENGTH = 1_000;
type DiffRenderMode = 'stacked' | 'split';
type MobileDiffToolbarMenuKind = 'scope' | 'baseRef';
interface MobileDiffToolbarMenuState {
  kind: MobileDiffToolbarMenuKind;
  left: number;
  top: number;
  width: number;
  maxHeight: string;
}
const EMPTY_DIFF_FILE_KEYS: readonly string[] = [];
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

type ScopedWorkspaceDiffCache = Record<string, CodeAgentWorkspaceDiff>;

interface ScopedWorkspaceRefs {
  scopeKey: string;
  refs: CodeAgentWorkspaceRefs;
}

interface ScopedWorkspaceRefsError {
  scopeKey: string;
  message: string;
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
  mobileLayout = false,
  onOpenChangedFiles,
}) => {
  const { t } = useTranslation();
  const resolvedTheme = useResolvedTheme();
  const [diffStateByScopeKey, setDiffStateByScopeKey] = useState<ScopedWorkspaceDiffCache>({});
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [wordWrap, setWordWrap] = useState(readInitialDiffWordWrap);
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>(readInitialDiffRenderMode);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(readInitialDiffIgnoreWhitespace);
  const [diffRefreshNonce, setDiffRefreshNonce] = useState(0);
  const [mobileDiffToolbarMenu, setMobileDiffToolbarMenu] = useState<MobileDiffToolbarMenuState | null>(null);
  const diffPanelSelection = useCodeAgentDiffPanelSelection(roomId);
  const diffScope: CodeAgentWorkspaceDiffScope = diffPanelSelection.kind === 'unstaged' ? 'unstaged' : 'branch';
  const diffBaseRef = diffPanelSelection.kind === 'branch' ? diffPanelSelection.baseRef : null;
  const diffContentScopeKey = `${roomId}:${refreshKey}:${diffIgnoreWhitespace ? 'ignore-whitespace' : 'all-whitespace'}:${diffScope}:${diffScope === 'branch' ? diffBaseRef ?? 'auto' : 'working-tree'}`;
  const diff = diffStateByScopeKey[diffContentScopeKey] ?? null;
  const [baseRefQuery, setBaseRefQuery] = useState('');
  const baseRefRequestQuery = baseRefQuery.trim();
  const workspaceRefsScopeKey = `${roomId}:${refreshKey}:${diffScope}:${baseRefRequestQuery}`;
  const [workspaceRefsState, setWorkspaceRefsState] = useState<ScopedWorkspaceRefs | null>(null);
  const [workspaceRefsErrorState, setWorkspaceRefsErrorState] = useState<ScopedWorkspaceRefsError | null>(null);
  const workspaceRefs = workspaceRefsState?.scopeKey === workspaceRefsScopeKey ? workspaceRefsState.refs : null;
  const workspaceRefsError = workspaceRefsErrorState?.scopeKey === workspaceRefsScopeKey
    ? workspaceRefsErrorState.message
    : null;
  const [isWorkspaceRefsPending, setIsWorkspaceRefsPending] = useState(false);
  const codeViewRef = useRef<CodeViewHandle<DiffCommentAnnotationGroup> | null>(null);
  const diffScopeMenuRef = useRef<HTMLDetailsElement | null>(null);
  const diffBaseRefMenuRef = useRef<HTMLDetailsElement | null>(null);
  const mobileDiffToolbarMenuRef = useRef<HTMLDivElement | null>(null);
  const mobileDiffScopeButtonRef = useRef<HTMLButtonElement | null>(null);
  const mobileDiffBaseRefButtonRef = useRef<HTMLButtonElement | null>(null);
  const diffFileVisibilityScopeKey = `${roomId}:${diffScope}:${diffScope === 'branch' ? diffBaseRef ?? 'auto' : 'working-tree'}`;
  const scopedDiffFileVisibility = useCodeAgentDiffFileVisibility(diffFileVisibilityScopeKey);
  const collapsedDiffFileKeys = scopedDiffFileVisibility?.collapsedFileKeys ?? EMPTY_DIFF_FILE_KEYS;
  const viewedDiffFileKeys = scopedDiffFileVisibility?.viewedFileKeys ?? EMPTY_DIFF_FILE_KEYS;
  const revealedLargeDiffFileKeys = scopedDiffFileVisibility?.revealedLargeFileKeys ?? EMPTY_DIFF_FILE_KEYS;
  const wordWrapLabel = t(wordWrap ? 'codeAgentDisableDiffLineWrapping' : 'codeAgentEnableDiffLineWrapping');
  const ignoreWhitespaceLabel = t(diffIgnoreWhitespace ? 'codeAgentShowWhitespaceChanges' : 'codeAgentHideWhitespaceChanges');
  const refreshDiffLabel = t('codeAgentRefreshWorkspaceDiff');
  const isDiffRefreshPending = isPending || isWorkspaceRefsPending;
  const loadingDiffLabel = t(diffScope === 'unstaged' ? 'codeAgentLoadingWorkingTreeDiff' : 'codeAgentLoadingBranchDiff');
  const diffHeadRefLabel = diff?.headRef || workspaceRefs?.headRef || 'HEAD';
  const diffBaseRefLabel = diff?.baseRef || diffBaseRef || t('codeAgentDiffBaseRefAutomatic');
  const reviewSections = useMemo(() => buildCodeAgentReviewSections({
    selection: diffPanelSelection,
    diff,
    refs: workspaceRefs,
    isDiffPending: isPending,
    isRefsPending: isWorkspaceRefsPending,
  }), [diff, diffPanelSelection, isPending, isWorkspaceRefsPending, workspaceRefs]);
  const selectedReviewSectionId = getCodeAgentDiffReviewSectionId(diffPanelSelection);
  const selectedReviewSection = reviewSections.find((section) => section.id === selectedReviewSectionId) ?? reviewSections[0]!;
  const getReviewSectionLabel = useCallback((section: CodeAgentReviewSectionItem) => (
    t(section.kind === 'working-tree'
      ? 'codeAgentReviewSectionWorkingTree'
      : 'codeAgentReviewSectionBranchRange')
  ), [t]);
  const getReviewSectionSubtitle = useCallback((section: CodeAgentReviewSectionItem) => (
    section.kind === 'working-tree'
      ? t('codeAgentReviewSectionWorkingTreeSubtitle')
      : `${section.headRef || diffHeadRefLabel} -> ${section.baseRef || t('codeAgentDiffBaseRefAutomatic')}`
  ), [diffHeadRefLabel, t]);
  const selectedReviewSectionLabel = getReviewSectionLabel(selectedReviewSection);
  const selectedReviewSectionSubtitle = getReviewSectionSubtitle(selectedReviewSection);
  const hasNoNetChanges = Boolean(diff?.available && diff.patch.trim().length === 0);
  const emptyPatchLabel = t(hasNoNetChanges ? 'codeAgentNoNetWorkspaceChanges' : 'codeAgentNoWorkspacePatch');
  const diffReviewCommentScopeKey = `${roomId}:${diffScope}:${diffScope === 'branch' ? diffBaseRef ?? 'auto' : 'working-tree'}`;
  const reviewCommentSectionId = `workspace-diff:${diffReviewCommentScopeKey}`;
  const reviewCommentSectionTitle = t('codeAgentChanges');

  useEffect(() => {
    setBaseRefQuery('');
    setWorkspaceRefsState(null);
    setWorkspaceRefsErrorState(null);
  }, [roomId]);

  useEffect(() => {
    setDiffStateByScopeKey({});
  }, [refreshKey, roomId]);

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

  const openMobileDiffToolbarMenu = useCallback((
    kind: MobileDiffToolbarMenuKind,
    button: HTMLElement,
    preferredWidth: number,
  ) => {
    const rect = button.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportWidth = viewport?.width ?? window.innerWidth ?? preferredWidth;
    const width = Math.min(preferredWidth, Math.max(160, viewportWidth - 16));
    const maxLeft = Math.max(8, viewportWidth - width - 8);
    const left = Math.min(Math.max(8, rect.left), maxLeft);
    const top = Math.max(8, rect.bottom + 4);
    setMobileDiffToolbarMenu({
      kind,
      left: Math.round(left),
      top: Math.round(top),
      width: Math.round(width),
      maxHeight: `calc(100vh - ${Math.round(top + 8)}px)`,
    });
  }, []);

  const closeDiffToolbarMenus = useCallback(() => {
    diffScopeMenuRef.current?.removeAttribute('open');
    diffBaseRefMenuRef.current?.removeAttribute('open');
    setMobileDiffToolbarMenu(null);
  }, []);

  const handleDiffScopeMenuToggle = useCallback((event: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (event.currentTarget.open) {
      diffBaseRefMenuRef.current?.removeAttribute('open');
    }
  }, []);

  const handleDiffBaseRefMenuToggle = useCallback((event: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (event.currentTarget.open) {
      diffScopeMenuRef.current?.removeAttribute('open');
    }
  }, []);

  const selectReviewSection = useCallback((sectionId: CodeAgentReviewSectionItem['id']) => {
    selectCodeAgentDiffReviewSection(roomId, sectionId);
  }, [roomId]);

  const selectDiffBaseRef = useCallback((nextBaseRef: string | null) => {
    setBaseRefQuery('');
    selectCodeAgentDiffBranchBaseRef(roomId, nextBaseRef);
  }, [roomId]);

  const toggleDiffFileCollapsed = (fileKey: string) => {
    updateCodeAgentDiffFileVisibility(diffFileVisibilityScopeKey, (current) => {
      const collapsedFileKeys = toggleCodeAgentDiffFileKey(
        current.collapsedFileKeys,
        fileKey,
      );
      return {
        collapsedFileKeys,
        viewedFileKeys: current.viewedFileKeys,
        revealedLargeFileKeys: current.revealedLargeFileKeys,
      };
    });
  };

  const toggleDiffFileViewed = (fileKey: string) => {
    updateCodeAgentDiffFileVisibility(diffFileVisibilityScopeKey, (current) => {
      const collapsedFileKeys = new Set(current.collapsedFileKeys);
      const viewedBeforeToggle = current.viewedFileKeys.includes(fileKey);
      const viewedFileKeys = toggleCodeAgentDiffFileKey(
        current.viewedFileKeys,
        fileKey,
      );
      if (!viewedBeforeToggle) {
        collapsedFileKeys.add(fileKey);
      }
      return {
        collapsedFileKeys: [...collapsedFileKeys],
        viewedFileKeys,
        revealedLargeFileKeys: current.revealedLargeFileKeys,
      };
    });
  };

  const revealLargeDiffFile = (fileKey: string) => {
    updateCodeAgentDiffFileVisibility(diffFileVisibilityScopeKey, (current) => {
      const collapsedFileKeys = removeCodeAgentDiffFileKey(
        current.collapsedFileKeys,
        fileKey,
      );
      const revealedLargeFileKeys = new Set(current.revealedLargeFileKeys);
      revealedLargeFileKeys.add(fileKey);
      return {
        collapsedFileKeys,
        viewedFileKeys: current.viewedFileKeys,
        revealedLargeFileKeys: [...revealedLargeFileKeys],
      };
    });
  };

  useEffect(() => {
    if (!enabled || diffScope !== 'branch') {
      setIsWorkspaceRefsPending(false);
      return undefined;
    }

    const controller = new AbortController();
    setIsWorkspaceRefsPending(true);
    setWorkspaceRefsErrorState(null);

    loadCodeAgentWorkspaceRefs(roomId, {
      signal: controller.signal,
      query: baseRefRequestQuery || undefined,
      limit: WORKSPACE_REF_LIMIT,
    }).then(
      (refs) => {
        if (!controller.signal.aborted) {
          setWorkspaceRefsState({
            scopeKey: workspaceRefsScopeKey,
            refs,
          });
        }
      },
      (refsError) => {
        if (!controller.signal.aborted) {
          setWorkspaceRefsErrorState({
            scopeKey: workspaceRefsScopeKey,
            message: refsError instanceof Error ? refsError.message : 'Workspace refs failed.',
          });
        }
      },
    ).finally(() => {
      if (!controller.signal.aborted) {
        setIsWorkspaceRefsPending(false);
      }
    });

    return () => controller.abort();
  }, [baseRefRequestQuery, diffRefreshNonce, diffScope, enabled, roomId, workspaceRefsScopeKey]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (
          diffScopeMenuRef.current?.contains(target) ||
          diffBaseRefMenuRef.current?.contains(target) ||
          mobileDiffToolbarMenuRef.current?.contains(target) ||
          mobileDiffScopeButtonRef.current?.contains(target) ||
          mobileDiffBaseRefButtonRef.current?.contains(target)
        )
      ) {
        return;
      }
      closeDiffToolbarMenus();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeDiffToolbarMenus();
      }
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeDiffToolbarMenus]);

  useEffect(() => {
    if (!mobileLayout) {
      setMobileDiffToolbarMenu(null);
    }
  }, [mobileLayout]);

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
          setDiffStateByScopeKey((current) => ({
            ...current,
            [diffContentScopeKey]: nextDiff,
          }));
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
      collapsedDiffFileKeys,
    ));
    const validViewedDiffFileKeys = new Set(getValidExplicitCodeAgentDiffFileKeys(
      visibilityFiles,
      viewedDiffFileKeys,
    ));
    const validRevealedLargeDiffFileKeys = new Set(getValidExplicitCodeAgentDiffFileKeys(
      visibilityFiles,
      revealedLargeDiffFileKeys,
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
  const mobileDiffSummary = useMemo(() => (
    diffFileSummaries.reduce(
      (summary, file) => ({
        additions: summary.additions + file.additions,
        deletions: summary.deletions + file.deletions,
      }),
      { additions: 0, deletions: 0 },
    )
  ), [diffFileSummaries]);
  const showMobileReviewStats = diffFileSummaries.length > 0
    && (mobileDiffSummary.additions !== 0 || mobileDiffSummary.deletions !== 0);

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

    if (mobileLayout) {
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

  const controlClusterGap = mobileLayout ? 'gap-2' : 'gap-1.5';
  const controlIconClassName = mobileLayout ? 'h-4 w-4' : 'h-3.5 w-3.5';
  const diffScopeSummaryClassName = mobileLayout
    ? 'inline-flex h-9 max-w-[14rem] cursor-pointer list-none items-center gap-2 rounded-lg border border-[#dedbd0] bg-[#faf9f5] px-3 text-sm font-semibold text-[#141413] transition-colors hover:bg-[#f0eee6] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:border-[#30302e] dark:bg-[#1d1d1b] dark:text-[#faf9f5] dark:hover:bg-[#30302e] [&::-webkit-details-marker]:hidden'
    : 'inline-flex h-7 min-w-0 max-w-52 cursor-pointer list-none items-center gap-1 rounded-md border border-[#dedbd0] bg-[#faf9f5] px-2 text-xs font-medium text-[#141413] transition-colors hover:bg-[#f0eee6] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:border-[#30302e] dark:bg-[#1d1d1b] dark:text-[#faf9f5] dark:hover:bg-[#30302e] [&::-webkit-details-marker]:hidden';
  const diffScopeMenuClassName = mobileLayout
    ? 'absolute left-0 top-10 z-50 w-72 rounded-lg border border-[#dedbd0] bg-[#faf9f5] p-1 shadow-lg dark:border-[#30302e] dark:bg-[#1d1d1b]'
    : 'absolute left-0 top-8 z-50 w-64 rounded-md border border-[#dedbd0] bg-[#faf9f5] p-1 shadow-lg dark:border-[#30302e] dark:bg-[#1d1d1b]';
  const diffScopeMenuItemClassName = mobileLayout
    ? 'flex min-h-14 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-[#141413] hover:bg-[#f0eee6] dark:text-[#faf9f5] dark:hover:bg-[#30302e]'
    : 'flex min-h-12 w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[#141413] hover:bg-[#f0eee6] dark:text-[#faf9f5] dark:hover:bg-[#30302e]';
  const diffBaseRefSummaryClassName = mobileLayout
    ? 'inline-flex h-9 max-w-[10rem] cursor-pointer list-none items-center gap-2 rounded-lg border border-[#dedbd0] bg-[#faf9f5] px-3 text-sm font-semibold text-[#5e5d59] transition-colors hover:bg-[#f0eee6] hover:text-[#141413] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:border-[#30302e] dark:bg-[#1d1d1b] dark:text-[#b0aea5] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5] [&::-webkit-details-marker]:hidden'
    : 'inline-flex h-7 min-w-0 max-w-32 cursor-pointer list-none items-center gap-1 rounded-md px-1.5 text-xs font-medium text-[#5e5d59] transition-colors hover:bg-[#f0eee6] hover:text-[#141413] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:text-[#b0aea5] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5] [&::-webkit-details-marker]:hidden';
  const diffBaseRefMenuClassName = mobileLayout
    ? 'absolute left-0 top-10 z-50 w-72 max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-[#dedbd0] bg-[#faf9f5] shadow-lg dark:border-[#30302e] dark:bg-[#1d1d1b]'
    : 'absolute left-0 top-8 z-50 w-60 max-w-[calc(100vw-1rem)] overflow-hidden rounded-md border border-[#dedbd0] bg-[#faf9f5] shadow-lg dark:border-[#30302e] dark:bg-[#1d1d1b]';
  const diffBaseRefItemClassName = mobileLayout
    ? 'grid h-10 w-full grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 rounded-md px-3 text-left text-sm text-[#141413] hover:bg-[#f0eee6] dark:text-[#faf9f5] dark:hover:bg-[#30302e]'
    : 'grid h-8 w-full grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 rounded px-2 text-left text-xs text-[#141413] hover:bg-[#f0eee6] dark:text-[#faf9f5] dark:hover:bg-[#30302e]';
  const diffIconButtonClassName = (active = false) => `inline-flex ${mobileLayout ? 'h-9 w-9 rounded-lg' : 'h-7 w-7 rounded-md'} items-center justify-center border text-[#5e5d59] transition-colors hover:bg-[#f0eee6] hover:text-[#141413] disabled:cursor-wait disabled:opacity-60 dark:text-[#b0aea5] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5] ${
    active
      ? 'border-[#c96442]/60 bg-[#fff2ec] text-[#9f462c] dark:border-[#d97757]/60 dark:bg-[#2a211d] dark:text-[#ffb197]'
      : 'border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]'
  }`;
  const diffRenderModeButtonClassName = (active: boolean, side: 'left' | 'right') => `${side === 'right' ? '-ml-px' : ''} inline-flex ${mobileLayout ? 'h-9 w-9' : 'h-7 w-7'} items-center justify-center border text-[#5e5d59] transition-colors hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#b0aea5] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5] ${
    side === 'left'
      ? `${mobileLayout ? 'rounded-l-lg' : 'rounded-l-md'} rounded-r-none`
      : `rounded-l-none ${mobileLayout ? 'rounded-r-lg' : 'rounded-r-md'}`
  } ${
    active
      ? 'z-10 border-[#c96442]/60 bg-[#fff2ec] text-[#9f462c] dark:border-[#d97757]/60 dark:bg-[#2a211d] dark:text-[#ffb197]'
      : 'border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]'
  }`;
  const diffFileHeaderPrefixClassName = mobileLayout
    ? 'inline-flex shrink-0 items-center gap-1.5'
    : 'inline-flex shrink-0 items-center gap-1';
  const diffFileHeaderIconButtonSizeClassName = mobileLayout
    ? 'h-8 w-8 rounded-md'
    : 'h-5 w-5 rounded-sm';
  const diffFileHeaderCollapseIconClassName = 'h-4 w-4';
  const diffFileHeaderViewedIconClassName = mobileLayout ? 'h-4 w-4' : 'h-3.5 w-3.5';
  const diffFileSuppressionPillClassName = mobileLayout
    ? 'inline-flex h-8 max-w-56 items-center gap-1.5 overflow-hidden rounded-md px-2 text-xs font-medium'
    : 'inline-flex h-5 max-w-48 items-center gap-1 overflow-hidden rounded-sm px-1.5 text-[10px] font-medium sm:max-w-64';
  const mobileDiffToolbarMenuKind = mobileDiffToolbarMenu?.kind ?? null;
  const diffScopeChevronClassName = `${controlIconClassName} shrink-0 text-[#87867f] transition-transform dark:text-[#8f8d86] ${
    mobileDiffToolbarMenuKind === 'scope' ? 'rotate-180' : 'group-open:rotate-180'
  }`;
  const diffBaseRefChevronClassName = `${controlIconClassName} shrink-0 text-[#87867f] transition-transform dark:text-[#8f8d86] ${
    mobileDiffToolbarMenuKind === 'baseRef' ? 'rotate-180' : 'group-open:rotate-180'
  }`;
  const diffScopeSectionItems = reviewSections.map((section) => (
    <button
      key={section.id}
      type="button"
      className={diffScopeMenuItemClassName}
      role="menuitem"
      onClick={() => {
        selectReviewSection(section.id);
        closeDiffToolbarMenus();
      }}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{getReviewSectionLabel(section)}</span>
        <span className="block truncate text-[11px] font-normal text-[#87867f] dark:text-[#8f8d86]">
          {getReviewSectionSubtitle(section)}
        </span>
      </span>
      {section.selected ? <Check className="h-3.5 w-3.5 shrink-0 text-[#9f462c] dark:text-[#ffb197]" /> : null}
    </button>
  ));
  const diffScopeMenuContent = (
    <>
      {diffScopeSectionItems}
    </>
  );
  const diffBaseRefMenuContent = (
    <>
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
                className={diffBaseRefItemClassName}
                role="menuitem"
                onClick={() => {
                  selectDiffBaseRef(null);
                  closeDiffToolbarMenus();
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
              const selectItem = () => {
                selectDiffBaseRef(item);
                closeDiffToolbarMenus();
              };
              return (
                <div
                  key={choice.id}
                  role="menuitem"
                  tabIndex={0}
                  className={diffBaseRefItemClassName}
                  onClick={() => {
                    selectItem();
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') {
                      return;
                    }
                    event.preventDefault();
                    selectItem();
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
    </>
  );
  const mobileDiffToolbarMenuOverlay = mobileLayout && mobileDiffToolbarMenu ? (
    <div
      ref={mobileDiffToolbarMenuRef}
      className={`fixed z-[90] overflow-hidden rounded-lg border border-[#dedbd0] bg-[#faf9f5] shadow-xl dark:border-[#30302e] dark:bg-[#1d1d1b] ${
        mobileDiffToolbarMenu.kind === 'scope' ? 'p-1' : ''
      }`}
      data-testid={
        mobileDiffToolbarMenu.kind === 'scope'
          ? 'code-agent-mobile-diff-scope-menu'
          : 'code-agent-mobile-diff-base-ref-menu'
      }
      role="menu"
      style={{
        left: mobileDiffToolbarMenu.left,
        top: mobileDiffToolbarMenu.top,
        width: mobileDiffToolbarMenu.width,
        maxHeight: mobileDiffToolbarMenu.maxHeight,
      }}
    >
      {mobileDiffToolbarMenu.kind === 'scope' ? diffScopeMenuContent : diffBaseRefMenuContent}
    </div>
  ) : null;

  const headerControls = (
    <>
        <div
          className={`flex min-w-0 flex-1 items-center ${controlClusterGap} flex-nowrap`}
          data-testid={mobileLayout ? undefined : 'code-agent-desktop-workspace-diff-primary-controls'}
        >
          <div className={`${mobileLayout ? 'inline-flex max-w-full shrink-0' : 'flex min-w-0 flex-1'} items-center ${controlClusterGap} whitespace-nowrap`}>
            {mobileLayout ? (
              <button
                ref={mobileDiffScopeButtonRef}
                type="button"
                aria-label={`${t('codeAgentReviewSection')}: ${selectedReviewSectionLabel}`}
                aria-haspopup="menu"
                aria-expanded={mobileDiffToolbarMenuKind === 'scope'}
                className={diffScopeSummaryClassName}
                onClick={(event) => {
                  if (mobileDiffToolbarMenuKind === 'scope') {
                    closeDiffToolbarMenus();
                    return;
                  }
                  openMobileDiffToolbarMenu('scope', event.currentTarget, 288);
                }}
                title={selectedReviewSectionSubtitle}
              >
                <span className="truncate">{selectedReviewSectionLabel}</span>
                <ChevronDown className={diffScopeChevronClassName} />
              </button>
            ) : (
              <details
                ref={diffScopeMenuRef}
                className="group relative min-w-0"
                onToggle={handleDiffScopeMenuToggle}
              >
                <summary
                  aria-label={`${t('codeAgentReviewSection')}: ${selectedReviewSectionLabel}`}
                  className={diffScopeSummaryClassName}
                  title={selectedReviewSectionSubtitle}
                >
                  <span className="truncate">{selectedReviewSectionLabel}</span>
                  <ChevronDown className={diffScopeChevronClassName} />
                </summary>
                <div className={diffScopeMenuClassName} role="menu">
                  {diffScopeMenuContent}
                </div>
              </details>
            )}
          {diffScope === 'branch' ? (
            <div
              className={`flex min-w-0 max-w-full ${mobileLayout ? 'shrink-0' : 'shrink'} items-center ${controlClusterGap} overflow-visible text-xs text-[#87867f] dark:text-[#8f8d86]`}
              title={`${diffHeadRefLabel} -> ${diffBaseRefLabel}`}
              aria-label={`${t('codeAgentDiffComparing')}: ${diffHeadRefLabel} -> ${diffBaseRefLabel}`}
            >
              <span className="hidden max-w-28 truncate sm:inline">{diffHeadRefLabel}</span>
              <ArrowRight className="hidden h-3.5 w-3.5 shrink-0 opacity-70 sm:block" />
              {mobileLayout ? (
                <button
                  ref={mobileDiffBaseRefButtonRef}
                  type="button"
                  aria-label={`${t('codeAgentDiffBaseRef')}: ${diffBaseRefLabel}`}
                  aria-haspopup="menu"
                  aria-expanded={mobileDiffToolbarMenuKind === 'baseRef'}
                  className={diffBaseRefSummaryClassName}
                  onClick={(event) => {
                    if (mobileDiffToolbarMenuKind === 'baseRef') {
                      closeDiffToolbarMenus();
                      return;
                    }
                    openMobileDiffToolbarMenu('baseRef', event.currentTarget, 288);
                  }}
                >
                  <span className="truncate">{diffBaseRefLabel}</span>
                  <ChevronDown className={diffBaseRefChevronClassName} />
                </button>
              ) : (
                <details
                  ref={diffBaseRefMenuRef}
                  className="group relative min-w-0"
                  onToggle={handleDiffBaseRefMenuToggle}
                >
                  <summary
                    aria-label={`${t('codeAgentDiffBaseRef')}: ${diffBaseRefLabel}`}
                    className={diffBaseRefSummaryClassName}
                  >
                    <span className="truncate">{diffBaseRefLabel}</span>
                    <ChevronDown className={diffBaseRefChevronClassName} />
                  </summary>
                  <div className={diffBaseRefMenuClassName} role="menu">
                    {diffBaseRefMenuContent}
                  </div>
                </details>
              )}
            </div>
          ) : null}
          </div>
        </div>
        <div
          className={`flex shrink-0 items-center ${mobileLayout ? 'gap-1.5' : 'gap-1'}`}
          data-testid={mobileLayout ? undefined : 'code-agent-desktop-workspace-diff-action-controls'}
        >
          {mobileLayout && onOpenChangedFiles ? (
            <button
              type="button"
              aria-label={t('codeAgentChangedFiles')}
              title={t('codeAgentChangedFiles')}
              data-testid="code-agent-mobile-diff-files-button"
              onClick={onOpenChangedFiles}
              className={diffIconButtonClassName(false)}
            >
              <Files className={controlIconClassName} />
            </button>
          ) : null}
          <button
            type="button"
            aria-label={refreshDiffLabel}
            title={refreshDiffLabel}
            disabled={isDiffRefreshPending}
            onClick={refreshDiff}
            className={diffIconButtonClassName(false)}
          >
            <RefreshCw className={`${controlIconClassName} ${isDiffRefreshPending ? 'animate-spin' : ''}`} />
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
            className={diffRenderModeButtonClassName(diffRenderMode === 'stacked', 'left')}
          >
            <Rows3 className={controlIconClassName} />
          </button>
          <button
            type="button"
            aria-label={t('codeAgentSplitDiffView')}
            aria-pressed={diffRenderMode === 'split'}
            title={t('codeAgentSplitDiffView')}
            onClick={() => selectDiffRenderMode('split')}
            className={diffRenderModeButtonClassName(diffRenderMode === 'split', 'right')}
          >
            <Columns2 className={controlIconClassName} />
          </button>
        </div>
        <button
          type="button"
          aria-label={wordWrapLabel}
          aria-pressed={wordWrap}
          title={wordWrapLabel}
          onClick={toggleWordWrap}
          className={diffIconButtonClassName(wordWrap)}
        >
          <WrapText className={controlIconClassName} />
        </button>
        <button
          type="button"
          aria-label={ignoreWhitespaceLabel}
          aria-pressed={diffIgnoreWhitespace}
          title={ignoreWhitespaceLabel}
          onClick={toggleDiffIgnoreWhitespace}
          className={diffIconButtonClassName(diffIgnoreWhitespace)}
        >
          <Pilcrow className={controlIconClassName} />
        </button>
        </div>
    </>
  );
  const headerRow = mobileLayout ? (
    <div
      className="-mx-2 flex min-w-0 flex-1 overflow-x-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      data-testid="code-agent-mobile-workspace-diff-header"
    >
      <div
        className="flex min-h-9 min-w-max items-center gap-1.5 text-[11px] leading-4 text-[#87867f] dark:text-[#8f8d86]"
        data-testid="code-agent-mobile-workspace-diff-controls-row"
      >
        {headerControls}
        {showMobileReviewStats ? (
          <CodeAgentDiffStatLabel
            additions={mobileDiffSummary.additions}
            deletions={mobileDiffSummary.deletions}
            className="shrink-0 text-[11px]"
            layout="inline"
          />
        ) : null}
        {reviewComments.length > 0 ? (
          <span
            className="shrink-0 rounded-full border border-[#ead6cc] bg-[#fff7f2] px-1.5 py-px text-[10px] font-semibold leading-none text-[#9f462c] dark:border-[#4a3027] dark:bg-[#2a211d] dark:text-[#ffb197]"
            data-count={reviewComments.length}
            data-testid="code-agent-mobile-workspace-diff-pending-review-count"
          >
            {t('codeAgentPendingReviewCommentCount', { count: reviewComments.length })}
          </span>
        ) : null}
      </div>
    </div>
  ) : headerControls;

  return (
    <CodeAgentWorkspaceDiffPanelShell
      mode="embedded"
      header={headerRow}
      testId="code-agent-workspace-diff-viewer"
      headerClassName={mobileLayout ? 'min-h-10 items-center px-2 py-1' : undefined}
    >
      {mobileDiffToolbarMenuOverlay}
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
            mobileLayout={mobileLayout}
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
                <div className={diffFileHeaderPrefixClassName}>
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
                    className={`inline-flex ${diffFileHeaderIconButtonSizeClassName} shrink-0 items-center justify-center border-0 bg-transparent p-0 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] disabled:cursor-not-allowed disabled:opacity-50 ${
                      isCollapseButtonDisabled
                        ? 'text-[#87867f] dark:text-[#8f8d86]'
                        : `cursor-pointer hover:bg-[#141413]/10 dark:hover:bg-[#faf9f5]/10 ${canLoadSuppressedDiff ? 'text-[#9f462c] dark:text-[#ffb197]' : getDiffCollapseIconClassName(fileDiff)}`
                    }`}
                  >
                    {collapsed ? <ChevronRight className={diffFileHeaderCollapseIconClassName} /> : <ChevronDown className={diffFileHeaderCollapseIconClassName} />}
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
                    className={`inline-flex ${diffFileHeaderIconButtonSizeClassName} shrink-0 cursor-pointer items-center justify-center border-0 p-0 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] ${
                      viewed
                        ? 'bg-[#2f7d46]/10 text-[#2f7d46] hover:bg-[#2f7d46]/20 dark:bg-[#48a868]/15 dark:text-[#8bd59e] dark:hover:bg-[#48a868]/25'
                        : 'bg-transparent text-[#87867f] hover:bg-[#141413]/10 hover:text-[#141413] dark:text-[#8f8d86] dark:hover:bg-[#faf9f5]/10 dark:hover:text-[#faf9f5]'
                    }`}
                  >
                    <Check className={diffFileHeaderViewedIconClassName} />
                  </button>
                  {mobileLayout && suppression && canLoadSuppressedDiff ? (
                    <button
                      type="button"
                      className={`${diffFileSuppressionPillClassName} cursor-pointer bg-[#f0eee6] text-[#5e5d59] transition-colors hover:bg-[#ead6cc] hover:text-[#9f462c] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:bg-[#30302e] dark:text-[#b0aea5] dark:hover:bg-[#3b332f] dark:hover:text-[#ffb197]`}
                      data-testid="code-agent-diff-file-suppression-load"
                      title={t('codeAgentLargeDiffSuppressedMessage')}
                      onClick={(event) => {
                        event.stopPropagation();
                        revealLargeDiffFile(fileKey);
                      }}
                    >
                      <span className="min-w-0 truncate sm:hidden">
                        {t('codeAgentLargeDiff')}
                      </span>
                      <span className="hidden min-w-0 truncate sm:block">
                        {t('codeAgentLargeDiffSuppressedMessage')}
                      </span>
                      <span className="shrink-0 text-[#9f462c] dark:text-[#ffb197]">
                        {t('codeAgentLoadDiff')}
                      </span>
                    </button>
                  ) : suppression ? (
                    <span
                      className={`${diffFileSuppressionPillClassName} bg-[#f0eee6] text-[#5e5d59] dark:bg-[#30302e] dark:text-[#b0aea5]`}
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
                  className={`${previewState.reason === 'large' && !mobileLayout ? 'hidden sm:inline-flex' : 'inline-flex'} max-w-[18rem] items-center gap-2 overflow-hidden rounded-sm bg-[#f0eee6] px-2 py-1 text-[11px] leading-4 text-[#5e5d59] dark:bg-[#30302e] dark:text-[#b0aea5] sm:max-w-[28rem]`}
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
              lineDiffType: mobileLayout ? 'word-alt' : 'none',
              ...(mobileLayout ? { maxLineDiffLength: MOBILE_DIFF_WORD_ALT_MAX_LINE_LENGTH } : {}),
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
