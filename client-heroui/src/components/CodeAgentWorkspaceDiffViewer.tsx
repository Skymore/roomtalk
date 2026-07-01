import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CodeViewDiffItem, CodeViewItem, FileDiffMetadata, SelectedLineRange } from '@pierre/diffs';
import { CodeView, type CodeViewHandle } from '@pierre/diffs/react';
import { ChevronDown, ChevronRight, Columns2, FileCode2, Pilcrow, Rows3, WrapText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { loadCodeAgentWorkspaceDiff, type CodeAgentWorkspaceDiff } from '../utils/cocoWorkspace';
import {
  buildFileDiffRenderKey,
  fnv1a32,
  getRenderablePatch,
  resolveCodeAgentDiffThemeName,
  resolveFileDiffPath,
  summarizeFileDiffStat,
} from '../utils/codeAgentDiffRendering';
import { formatCompactDiffCount } from '../utils/codeAgentChangedFileTree';
import { CodeAgentLocalCommentAnnotation } from './CodeAgentLocalCommentAnnotation';
import {
  buildDiffReviewComment,
  restoreDiffReviewCommentRange,
  type ReviewCommentContext,
} from '../utils/codeAgentReviewComments';
import {
  type DiffCommentAnnotationEntry,
  type DiffCommentAnnotationGroup,
  type DiffCommentLineAnnotation,
  appendDiffCommentAnnotationEntry,
  formatDiffCommentRange,
} from './codeAgentDiffCommentAnnotations';
import { nextFileCommentId } from './codeAgentFileCommentAnnotations';

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

function DiffLoadingSkeleton({ label }: { label: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-2" data-testid="code-agent-workspace-diff-loading">
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-[#dedbd0] bg-[#faf9f5]/70 dark:border-[#30302e] dark:bg-[#1d1d1b]/70"
        role="status"
        aria-live="polite"
        aria-label={label}
      >
        <div className="flex items-center gap-2 border-b border-[#dedbd0]/70 px-3 py-2 dark:border-[#30302e]/70">
          <span className="h-4 w-32 animate-pulse rounded-full bg-[#dedbd0] dark:bg-[#30302e]" />
          <span className="ml-auto h-4 w-20 animate-pulse rounded-full bg-[#dedbd0] dark:bg-[#30302e]" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-3 py-4">
          <div className="space-y-2">
            <span className="block h-3 w-full animate-pulse rounded-full bg-[#e8e6dc] dark:bg-[#242422]" />
            <span className="block h-3 w-full animate-pulse rounded-full bg-[#e8e6dc] dark:bg-[#242422]" />
            <span className="block h-3 w-10/12 animate-pulse rounded-full bg-[#e8e6dc] dark:bg-[#242422]" />
            <span className="block h-3 w-11/12 animate-pulse rounded-full bg-[#e8e6dc] dark:bg-[#242422]" />
            <span className="block h-3 w-9/12 animate-pulse rounded-full bg-[#e8e6dc] dark:bg-[#242422]" />
          </div>
          <span className="sr-only">{label}</span>
        </div>
      </div>
    </div>
  );
}

interface CollapsedDiffFilesState {
  scopeKey: string | null;
  fileKeys: Set<string>;
}

interface DiffSelectionContext {
  item: CodeViewItem<DiffCommentAnnotationGroup>;
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

function stripDiffPathPrefix(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith('a/') || trimmed.startsWith('b/') ? trimmed.slice(2) : trimmed;
}

function addDiffTitlePathCandidate(
  candidates: Map<string, string>,
  title: string | null | undefined,
  path: string,
) {
  if (!title) {
    return;
  }
  const trimmed = title.trim();
  if (!trimmed) {
    return;
  }
  candidates.set(trimmed, path);
  candidates.set(stripDiffPathPrefix(trimmed), path);
}

function buildDiffTitlePathMap(items: ReadonlyArray<{ type: 'diff'; fileDiff: FileDiffMetadata }>): ReadonlyMap<string, string> {
  const candidates = new Map<string, string>();
  for (const item of items) {
    if (item.type !== 'diff') {
      continue;
    }
    const filePath = resolveFileDiffPath(item.fileDiff);
    addDiffTitlePathCandidate(candidates, item.fileDiff.name, filePath);
    addDiffTitlePathCandidate(candidates, item.fileDiff.prevName, filePath);
    if (item.fileDiff.prevName && item.fileDiff.name) {
      const previousPath = stripDiffPathPrefix(item.fileDiff.prevName);
      const nextPath = stripDiffPathPrefix(item.fileDiff.name);
      addDiffTitlePathCandidate(candidates, `${previousPath} → ${nextPath}`, filePath);
      addDiffTitlePathCandidate(candidates, `${previousPath} -> ${nextPath}`, filePath);
    }
  }
  return candidates;
}

function normalizeDiffTitleText(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

function resolveDiffTitleOpenPath(rawTitle: string, pathMap: ReadonlyMap<string, string>): string | null {
  const normalizedTitle = normalizeDiffTitleText(rawTitle);
  if (!normalizedTitle) {
    return null;
  }

  const directPath = pathMap.get(normalizedTitle) ?? pathMap.get(stripDiffPathPrefix(normalizedTitle));
  if (directPath) {
    return directPath;
  }

  const sortedTitles = [...pathMap.entries()].sort((left, right) => right[0].length - left[0].length);
  for (const [title, path] of sortedTitles) {
    const normalizedCandidate = normalizeDiffTitleText(title);
    if (
      normalizedCandidate &&
      (normalizedTitle === normalizedCandidate || normalizedTitle.startsWith(`${normalizedCandidate} `))
    ) {
      return path;
    }
  }

  const renameTarget = normalizedTitle.match(/(?:→|->)\s*(.+)$/)?.[1];
  if (renameTarget) {
    const normalizedTarget = stripDiffPathPrefix(renameTarget);
    const targetPath = pathMap.get(renameTarget) ?? pathMap.get(normalizedTarget);
    if (targetPath) {
      return targetPath;
    }
    for (const [title, path] of sortedTitles) {
      const normalizedCandidate = normalizeDiffTitleText(stripDiffPathPrefix(title));
      if (
        normalizedCandidate &&
        (normalizedTarget === normalizedCandidate || normalizedTarget.startsWith(`${normalizedCandidate} `))
      ) {
        return path;
      }
    }
  }

  return stripDiffPathPrefix(normalizedTitle);
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

function withWorkspaceLineTarget(path: string, lineNumber: number | null): string {
  return lineNumber === null ? path : `${path}#L${lineNumber}`;
}

function getDiffCollapseIconClassName(fileDiff: FileDiffMetadata): string {
  switch (fileDiff.type) {
    case 'new':
      return 'text-[var(--diffs-addition-base)]';
    case 'deleted':
      return 'text-[var(--diffs-deletion-base)]';
    case 'change':
    case 'rename-pure':
    case 'rename-changed':
      return 'text-[var(--diffs-modified-base)]';
    default:
      return 'text-[#87867f] dark:text-[#8f8d86]';
  }
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
  const codeViewRef = useRef<CodeViewHandle<DiffCommentAnnotationGroup> | null>(null);
  const [selectedLines, setSelectedLines] = useState<{ id: string; range: SelectedLineRange } | null>(null);
  const [diffAnnotations, setDiffAnnotations] = useState<Record<string, DiffCommentLineAnnotation[]>>({});
  const [collapsedDiffFiles, setCollapsedDiffFiles] = useState<CollapsedDiffFilesState>(() => ({
    scopeKey: null,
    fileKeys: new Set(),
  }));
  const collapseScopeKey = `${roomId}:${refreshKey}:${diffIgnoreWhitespace ? 'ignore-whitespace' : 'show-whitespace'}`;
  const collapsedDiffFileKeys = collapsedDiffFiles.scopeKey === collapseScopeKey
    ? collapsedDiffFiles.fileKeys
    : EMPTY_COLLAPSED_DIFF_FILE_KEYS;
  const wordWrapLabel = t(wordWrap ? 'codeAgentDisableDiffLineWrapping' : 'codeAgentEnableDiffLineWrapping');
  const ignoreWhitespaceLabel = t(diffIgnoreWhitespace ? 'codeAgentShowWhitespaceChanges' : 'codeAgentHideWhitespaceChanges');
  const reviewCommentSectionId = `workspace-diff:${roomId}:${refreshKey || 'current'}`;
  const reviewCommentSectionTitle = t('codeAgentChanges');

  useEffect(() => {
    setSelectedLines(null);
    setDiffAnnotations({});
  }, [collapseScopeKey]);

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
    if (!enabled) {
      return undefined;
    }

    const controller = new AbortController();
    setIsPending(true);
    setError(null);

    loadCodeAgentWorkspaceDiff(roomId, {
      signal: controller.signal,
      ignoreWhitespace: diffIgnoreWhitespace,
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
  }, [diffIgnoreWhitespace, enabled, refreshKey, roomId]);

  const renderablePatch = useMemo(
    () => getRenderablePatch(diff?.patch, `workspace:${roomId}:${refreshKey}:${resolvedTheme}`, {
      compactPartialHunkOffsets: true,
    }),
    [diff?.patch, refreshKey, resolvedTheme, roomId],
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
  const codeViewItems = useMemo<CodeViewDiffItem<DiffCommentAnnotationGroup>[]>(() => (
    parsed.items.map((item) => {
      const filePath = item.type === 'diff' ? resolveFileDiffPath(item.fileDiff) : '';
      const persistedAnnotations = item.type === 'diff'
        ? reviewComments
          .filter((comment) => (
            comment.sectionId === reviewCommentSectionId &&
            comment.filePath === filePath &&
            (comment.fenceLanguage ?? 'diff') === 'diff'
          ))
          .reduce<DiffCommentLineAnnotation[]>((annotations, comment) => {
            const range = restoreDiffReviewCommentRange(item.fileDiff, comment);
            if (!range) return annotations;
            return appendDiffCommentAnnotationEntry(annotations, range, {
              id: comment.id,
              kind: 'comment',
              range,
              rangeLabel: comment.rangeLabel,
              text: comment.text,
            });
          }, [])
        : [];
      const persistedEntryIds = new Set(
        persistedAnnotations.flatMap((annotation) => annotation.metadata.entries.map((entry) => entry.id)),
      );
      const localAnnotations = (diffAnnotations[item.id] || []).flatMap((annotation) => {
        const entries = annotation.metadata.entries.filter((entry) => !persistedEntryIds.has(entry.id));
        return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
      });
      const annotations = [...persistedAnnotations, ...localAnnotations];
      return {
        ...item,
        annotations,
        version: fnv1a32(`${item.version || 0}:${annotations
          .flatMap((annotation) => annotation.metadata.entries.map((entry) => `${entry.id}:${entry.kind}:${entry.rangeLabel}:${entry.text}`))
          .join('|')}`),
      };
    })
  ), [diffAnnotations, parsed.items, reviewCommentSectionId, reviewComments]);
  const diffTitlePathMap = useMemo(() => buildDiffTitlePathMap(parsed.items), [parsed.items]);
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

  const removeDraftDiffAnnotations = useCallback((
    current: Record<string, DiffCommentLineAnnotation[]>,
  ): Record<string, DiffCommentLineAnnotation[]> => {
    const next: Record<string, DiffCommentLineAnnotation[]> = {};
    for (const [fileKey, annotations] of Object.entries(current)) {
      const filteredAnnotations = annotations.flatMap((annotation) => {
        const entries = annotation.metadata.entries.filter((entry) => entry.kind !== 'draft');
        return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
      });
      if (filteredAnnotations.length > 0) {
        next[fileKey] = filteredAnnotations;
      }
    }
    return next;
  }, []);

  const removeAnnotationEntry = useCallback((entryId: string) => {
    setSelectedLines(null);
    onRemoveReviewComment?.(entryId);
    setDiffAnnotations((current) => {
      const next: Record<string, DiffCommentLineAnnotation[]> = {};
      for (const [fileKey, annotations] of Object.entries(current)) {
        const filteredAnnotations = annotations.flatMap((annotation) => {
          const entries = annotation.metadata.entries.filter((entry) => entry.id !== entryId);
          return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
        });
        if (filteredAnnotations.length > 0) {
          next[fileKey] = filteredAnnotations;
        }
      }
      return next;
    });
  }, [onRemoveReviewComment]);

  const removeLocalAnnotationEntry = useCallback((entryId: string) => {
    setDiffAnnotations((current) => {
      const next: Record<string, DiffCommentLineAnnotation[]> = {};
      for (const [fileKey, annotations] of Object.entries(current)) {
        const filteredAnnotations = annotations.flatMap((annotation) => {
          const entries = annotation.metadata.entries.filter((entry) => entry.id !== entryId);
          return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
        });
        if (filteredAnnotations.length > 0) {
          next[fileKey] = filteredAnnotations;
        }
      }
      return next;
    });
  }, []);

  const submitAnnotationEntry = useCallback((entryId: string, text: string) => {
    setSelectedLines(null);
    const submitted = Object.entries(diffAnnotations).flatMap(([fileKey, annotations]) => (
      annotations.flatMap((annotation) => (
        annotation.metadata.entries.map((entry) => ({ fileKey, entry }))
      ))
    )).find(({ entry }) => entry.id === entryId);
    const item = submitted
      ? parsed.items.find((candidate) => candidate.id === submitted.fileKey && candidate.type === 'diff')
      : undefined;
    const comment = submitted && item?.type === 'diff'
      ? buildDiffReviewComment({
        id: submitted.entry.id,
        sectionId: reviewCommentSectionId,
        sectionTitle: reviewCommentSectionTitle,
        filePath: resolveFileDiffPath(item.fileDiff),
        fileDiff: item.fileDiff,
        range: submitted.entry.range,
        text,
      })
      : null;
    if (comment && onAddReviewComment) {
      onAddReviewComment(comment);
      removeLocalAnnotationEntry(entryId);
      return;
    }
    setDiffAnnotations((current) => {
      const next: Record<string, DiffCommentLineAnnotation[]> = {};
      for (const [fileKey, annotations] of Object.entries(current)) {
        next[fileKey] = annotations.map((annotation) => ({
          ...annotation,
          metadata: {
            entries: annotation.metadata.entries.map((entry) => (
              entry.id === entryId ? { ...entry, kind: 'comment', text } : entry
            )),
          },
        }));
      }
      return next;
    });
  }, [
    diffAnnotations,
    onAddReviewComment,
    parsed.items,
    removeLocalAnnotationEntry,
    reviewCommentSectionId,
    reviewCommentSectionTitle,
  ]);

  const beginComment = useCallback((range: SelectedLineRange | null, context: DiffSelectionContext) => {
    if (!range || context.item.type !== 'diff') {
      return;
    }

    const entry: DiffCommentAnnotationEntry = {
      id: nextFileCommentId(),
      kind: 'draft',
      range,
      rangeLabel: formatDiffCommentRange(context.item.fileDiff, range),
      text: '',
    };

    setSelectedLines({ id: context.item.id, range });
    setDiffAnnotations((current) => {
      const withoutDraft = removeDraftDiffAnnotations(current);
      return {
        ...withoutDraft,
        [context.item.id]: appendDiffCommentAnnotationEntry(
          withoutDraft[context.item.id] || [],
          range,
          entry,
        ),
      };
    });
  }, [removeDraftDiffAnnotations]);

  const hasOpenCommentForm = Object.values(diffAnnotations).some((annotations) =>
    annotations.some((annotation) => annotation.metadata.entries.some((entry) => entry.kind === 'draft')),
  );

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
        onOpenFile(openPath);
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
      onOpenFile(withWorkspaceLineTarget(openPath, lineNumber));
    }
  };

  if (!enabled && diff === null) {
    return null;
  }

  if (isPending && diff === null) {
    return <DiffLoadingSkeleton label={t('codeAgentLoadingWorkspaceDiff')} />;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-[#f0b49b]/50 bg-[#fff2ec] px-3 py-2 text-xs text-[#9f462c] dark:border-[#7a321f]/60 dark:bg-[#2a211d] dark:text-[#ff9b78]" role="alert">
        {error}
      </div>
    );
  }

  if (!diff?.available) {
    return (
      <p className="text-xs text-[#87867f] dark:text-[#8f8d86]">{t('codeAgentChangesUnavailable')}</p>
    );
  }

  if (!renderablePatch) {
    return (
      <p className="text-xs text-[#87867f] dark:text-[#8f8d86]">{t('codeAgentNoWorkspaceChanges')}</p>
    );
  }

  return (
    <div className="space-y-2" data-testid="code-agent-workspace-diff-viewer">
      {diff.truncated ? (
        <div className="rounded-md border border-amber-500/20 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          Diff preview truncated at {diff.patch.length.toLocaleString()} characters of a {diff.byteSize.toLocaleString()} byte patch.
        </div>
      ) : null}
      <div className="flex justify-end gap-1">
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
      {renderablePatch.kind === 'raw' ? (
        <div className="min-h-0 overflow-auto rounded-lg border border-[#dedbd0] bg-[#faf9f5] p-2 dark:border-[#30302e] dark:bg-[#1d1d1b]">
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
        <div className="space-y-2" onClickCapture={handleDiffClickCapture}>
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
                  <button
                    key={file.id}
                    type="button"
                    aria-label={`Scroll to diff file ${file.path}`}
                    title={file.path}
                    onClick={(event) => {
                      event.stopPropagation();
                      scrollToDiffItem(file.id);
                    }}
                    className={`inline-flex max-w-[18rem] shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-left text-[11px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] ${
                      selectedFilePath === file.path
                        ? 'border-[#c96442]/60 bg-[#fff2ec] text-[#9f462c] dark:border-[#d97757]/60 dark:bg-[#2a211d] dark:text-[#ffb197]'
                        : 'border-[#dedbd0] bg-[#f5f4ed] text-[#4d4c48] hover:bg-[#f0eee6] dark:border-[#30302e] dark:bg-[#242422] dark:text-[#e8e6dc] dark:hover:bg-[#30302e]'
                    }`}
                  >
                    <FileCode2 className="h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]" />
                    <span className="truncate font-mono">{file.path}</span>
                    <span className="ml-1 inline-flex shrink-0 gap-1 tabular-nums">
                      <span className="font-mono text-[#2f6f4e] dark:text-[#65d08a]">+{formatCompactDiffCount(file.additions)}</span>
                      <span className="font-mono text-[#9f462c] dark:text-[#ff9b78]">-{formatCompactDiffCount(file.deletions)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <CodeView<DiffCommentAnnotationGroup>
            ref={codeViewRef}
            className="h-80 min-h-0 overflow-auto rounded-lg border border-[#dedbd0] bg-[#faf9f5] text-xs dark:border-[#30302e] dark:bg-[#1d1d1b]"
            items={codeViewItems}
            selectedLines={selectedLines}
            onSelectedLinesChange={setSelectedLines}
            renderHeaderPrefix={(item) => {
              if (item.type !== 'diff') {
                return null;
              }
              const filePath = resolveFileDiffPath(item.fileDiff);
              const collapsed = item.collapsed === true;
              return (
                <button
                  type="button"
                  aria-label={t(collapsed ? 'codeAgentExpandDiffFile' : 'codeAgentCollapseDiffFile', { path: filePath })}
                  aria-expanded={!collapsed}
                  title={t(collapsed ? 'codeAgentExpandDiff' : 'codeAgentCollapseDiff')}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleDiffFileCollapsed(item.id);
                  }}
                  className={`inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 transition-colors hover:bg-[#141413]/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:hover:bg-[#faf9f5]/10 ${getDiffCollapseIconClassName(item.fileDiff)}`}
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
              enableGutterUtility: !hasOpenCommentForm,
              enableLineSelection: !hasOpenCommentForm,
              onLineSelectionEnd: beginComment,
              stickyHeaders: true,
              layout: { paddingTop: 8, paddingBottom: 8, gap: 8 },
            }}
            renderAnnotation={(annotation) => (
              <div className="py-1">
                {annotation.metadata.entries.map((entry) => (
                  <CodeAgentLocalCommentAnnotation
                    key={entry.id}
                    kind={entry.kind}
                    rangeLabel={entry.rangeLabel}
                    text={entry.text}
                    onCancel={() => removeAnnotationEntry(entry.id)}
                    onComment={(text) => submitAnnotationEntry(entry.id, text)}
                    onDelete={() => removeAnnotationEntry(entry.id)}
                  />
                ))}
              </div>
            )}
          />
        </div>
      )}
    </div>
  );
};
