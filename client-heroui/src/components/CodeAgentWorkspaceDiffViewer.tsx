import React, { useEffect, useMemo, useState } from 'react';
import { parsePatchFiles, type CodeViewDiffItem, type FileDiffMetadata } from '@pierre/diffs';
import { CodeView } from '@pierre/diffs/react';
import { ChevronDown, ChevronRight, Columns2, LoaderCircle, Pilcrow, Rows3, WrapText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { loadCodeAgentWorkspaceDiff, type CodeAgentWorkspaceDiff } from '../utils/cocoWorkspace';

interface CodeAgentWorkspaceDiffViewerProps {
  roomId: string;
  enabled: boolean;
  refreshKey?: string;
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

function resolveDiffFilePath(fileDiff: FileDiffMetadata): string {
  const rawPath = fileDiff.name || fileDiff.prevName || '';
  return rawPath.startsWith('a/') || rawPath.startsWith('b/') ? rawPath.slice(2) : rawPath;
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
}) => {
  const { t } = useTranslation();
  const resolvedTheme = useResolvedTheme();
  const [diff, setDiff] = useState<CodeAgentWorkspaceDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [wordWrap, setWordWrap] = useState(readInitialDiffWordWrap);
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>(readInitialDiffRenderMode);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(readInitialDiffIgnoreWhitespace);
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

  const parsed = useMemo(() => {
    if (!diff?.patch.trim()) {
      return { items: [] as CodeViewDiffItem[], error: null as string | null };
    }

    try {
      const patches = parsePatchFiles(diff.patch, `workspace:${roomId}:${refreshKey}`, false);
      const items = patches.flatMap((patch, patchIndex) =>
        patch.files.map((fileDiff, fileIndex) => {
          const id = `${patchIndex}:${fileIndex}:${fileDiff.prevName || ''}:${fileDiff.name}`;
          const collapsed = collapsedDiffFileKeys.has(id);
          return {
            id,
            type: 'diff' as const,
            fileDiff,
            collapsed,
            version: collapsed ? 1 : 0,
          };
        }),
      );
      return { items, error: null };
    } catch (parseError) {
      return {
        items: [] as CodeViewDiffItem[],
        error: parseError instanceof Error ? parseError.message : 'Workspace diff parse failed.',
      };
    }
  }, [collapsedDiffFileKeys, diff?.patch, refreshKey, roomId]);

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

  if (!diff.patch.trim() || parsed.items.length === 0) {
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
      {parsed.error ? (
        <div className="rounded-lg border border-[#f0b49b]/50 bg-[#fff2ec] px-3 py-2 text-xs text-[#9f462c] dark:border-[#7a321f]/60 dark:bg-[#2a211d] dark:text-[#ff9b78]" role="alert">
          {parsed.error}
        </div>
      ) : (
        <CodeView
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
      )}
    </div>
  );
};
