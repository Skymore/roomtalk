import React, { useEffect, useMemo, useRef, useState } from 'react';
import { parsePatchFiles, type CodeViewDiffItem, type FileDiffMetadata } from '@pierre/diffs';
import { CodeView, type CodeViewHandle } from '@pierre/diffs/react';
import { ChevronDown, ChevronRight, Columns2, LoaderCircle, Pilcrow, Rows3, WrapText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { loadCodeAgentWorkspaceDiff, type CodeAgentWorkspaceDiff } from '../utils/cocoWorkspace';

interface CodeAgentWorkspaceDiffViewerProps {
  roomId: string;
  enabled: boolean;
  refreshKey?: string;
  onOpenFile?: (path: string) => void;
  selectedFilePath?: string | null;
  selectedFileRevealRequestId?: number;
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
const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const SECONDARY_HASH_SEED = 0x9e3779b9;
const SECONDARY_HASH_MULTIPLIER = 0x85ebca6b;

type RenderablePatch =
  | {
    kind: 'files';
    files: FileDiffMetadata[];
  }
  | {
    kind: 'raw';
    text: string;
    reason: string;
  };

interface CollapsedDiffFilesState {
  scopeKey: string | null;
  fileKeys: Set<string>;
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

function fnv1a32(
  input: string,
  seed = FNV_OFFSET_BASIS_32,
  multiplier = FNV_PRIME_32,
): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, multiplier) >>> 0;
  }
  return hash >>> 0;
}

function buildPatchCacheKey(patch: string, scope = 'diff-panel'): string {
  const normalizedPatch = patch.trim();
  const primary = fnv1a32(normalizedPatch, FNV_OFFSET_BASIS_32, FNV_PRIME_32).toString(36);
  const secondary = fnv1a32(
    normalizedPatch,
    SECONDARY_HASH_SEED,
    SECONDARY_HASH_MULTIPLIER,
  ).toString(36);
  return `${scope}:${normalizedPatch.length}:${primary}:${secondary}`;
}

function getRenderablePatch(patch: string | undefined, cacheScope = 'diff-panel'): RenderablePatch | null {
  if (!patch) {
    return null;
  }
  const normalizedPatch = patch.trim();
  if (normalizedPatch.length === 0) {
    return null;
  }

  try {
    const parsedPatches = parsePatchFiles(
      normalizedPatch,
      buildPatchCacheKey(normalizedPatch, cacheScope),
    );
    const files = parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    if (files.length > 0) {
      return { kind: 'files', files };
    }
    return {
      kind: 'raw',
      text: normalizedPatch,
      reason: 'Unsupported diff format. Showing raw patch.',
    };
  } catch {
    return {
      kind: 'raw',
      text: normalizedPatch,
      reason: 'Failed to parse patch. Showing raw patch.',
    };
  }
}

function resolveDiffFilePath(fileDiff: FileDiffMetadata): string {
  const rawPath = fileDiff.name ?? fileDiff.prevName ?? '';
  return rawPath.startsWith('a/') || rawPath.startsWith('b/') ? rawPath.slice(2) : rawPath;
}

function buildDiffFileRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? 'none'}:${fileDiff.name}`;
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

function buildDiffTitlePathMap(items: readonly CodeViewDiffItem[]): ReadonlyMap<string, string> {
  const candidates = new Map<string, string>();
  for (const item of items) {
    if (item.type !== 'diff') {
      continue;
    }
    const filePath = resolveDiffFilePath(item.fileDiff);
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
  selectedFilePath = null,
  selectedFileRevealRequestId = 0,
}) => {
  const { t } = useTranslation();
  const resolvedTheme = useResolvedTheme();
  const [diff, setDiff] = useState<CodeAgentWorkspaceDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [wordWrap, setWordWrap] = useState(readInitialDiffWordWrap);
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>(readInitialDiffRenderMode);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(readInitialDiffIgnoreWhitespace);
  const codeViewRef = useRef<CodeViewHandle<unknown> | null>(null);
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
    () => getRenderablePatch(diff?.patch, `workspace:${roomId}:${refreshKey}:${resolvedTheme}`),
    [diff?.patch, refreshKey, resolvedTheme, roomId],
  );
  const parsed = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== 'files') {
      return { items: [] as CodeViewDiffItem[] };
    }

    const files = [...renderablePatch.files].sort((left, right) =>
      resolveDiffFilePath(left).localeCompare(resolveDiffFilePath(right), undefined, {
        numeric: true,
        sensitivity: 'base',
      }),
    );
    const items = files.map((fileDiff, fileIndex) => {
      const id = buildDiffFileRenderKey(fileDiff) || `${fileIndex}`;
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
  const diffTitlePathMap = useMemo(() => buildDiffTitlePathMap(parsed.items), [parsed.items]);

  useEffect(() => {
    if (!selectedFilePath) {
      return;
    }
    const file = parsed.items.find((item) => (
      item.type === 'diff' && resolveDiffFilePath(item.fileDiff) === selectedFilePath
    ));
    if (!file) {
      return;
    }
    codeViewRef.current?.scrollTo({ type: 'item', id: file.id, align: 'start' });
  }, [parsed.items, selectedFilePath, selectedFileRevealRequestId]);

  const handleDiffClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onOpenFile) {
      return;
    }
    const composedPath = event.nativeEvent.composedPath?.() ?? [];
    const titleFromPath = composedPath.find((node): node is HTMLElement => (
      node instanceof HTMLElement && node.hasAttribute('data-title')
    ));
    const title = titleFromPath ?? (event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>('[data-title]')
      : null);
    const rawTitle = title?.textContent?.trim();
    if (!rawTitle) {
      return;
    }
    onOpenFile(diffTitlePathMap.get(rawTitle) ?? stripDiffPathPrefix(rawTitle));
  };

  if (!enabled && diff === null) {
    return null;
  }

  if (isPending && diff === null) {
    return (
      <div className="flex h-36 items-center justify-center text-[#87867f] dark:text-[#8f8d86]" data-testid="code-agent-workspace-diff-loading">
        <LoaderCircle className="h-5 w-5 animate-spin" />
      </div>
    );
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
        <div onClickCapture={handleDiffClickCapture}>
          <CodeView
            ref={codeViewRef}
            className="h-80 min-h-0 overflow-auto rounded-lg border border-[#dedbd0] bg-[#faf9f5] text-xs dark:border-[#30302e] dark:bg-[#1d1d1b]"
            items={parsed.items}
            renderHeaderPrefix={(item) => {
              if (item.type !== 'diff') {
                return null;
              }
              const filePath = resolveDiffFilePath(item.fileDiff);
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
              overflow: wordWrap ? 'wrap' : 'scroll',
              theme: resolvedTheme === 'dark' ? 'pierre-dark' : 'pierre-light',
              themeType: resolvedTheme,
            }}
          />
        </div>
      )}
    </div>
  );
};
