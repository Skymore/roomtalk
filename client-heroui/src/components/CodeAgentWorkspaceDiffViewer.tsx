import React, { useEffect, useMemo, useState } from 'react';
import { parsePatchFiles, type CodeViewDiffItem } from '@pierre/diffs';
import { CodeView } from '@pierre/diffs/react';
import { LoaderCircle } from 'lucide-react';
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

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const controller = new AbortController();
    setIsPending(true);
    setError(null);

    loadCodeAgentWorkspaceDiff(roomId, { signal: controller.signal }).then(
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
  }, [enabled, refreshKey, roomId]);

  const parsed = useMemo(() => {
    if (!diff?.patch.trim()) {
      return { items: [] as CodeViewDiffItem[], error: null as string | null };
    }

    try {
      const patches = parsePatchFiles(diff.patch, `workspace:${roomId}:${refreshKey}`, false);
      const items = patches.flatMap((patch, patchIndex) =>
        patch.files.map((fileDiff, fileIndex) => ({
          id: `${patchIndex}:${fileIndex}:${fileDiff.prevName || ''}:${fileDiff.name}`,
          type: 'diff' as const,
          fileDiff,
        })),
      );
      return { items, error: null };
    } catch (parseError) {
      return {
        items: [] as CodeViewDiffItem[],
        error: parseError instanceof Error ? parseError.message : 'Workspace diff parse failed.',
      };
    }
  }, [diff?.patch, refreshKey, roomId]);

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
      {parsed.error ? (
        <div className="rounded-lg border border-[#f0b49b]/50 bg-[#fff2ec] px-3 py-2 text-xs text-[#9f462c] dark:border-[#7a321f]/60 dark:bg-[#2a211d] dark:text-[#ff9b78]" role="alert">
          {parsed.error}
        </div>
      ) : (
        <CodeView
          className="h-80 min-h-0 overflow-auto rounded-lg border border-[#dedbd0] bg-[#faf9f5] text-xs dark:border-[#30302e] dark:bg-[#1d1d1b]"
          items={parsed.items}
          options={{
            diffStyle: 'unified',
            overflow: 'scroll',
            theme: resolvedTheme === 'dark' ? 'pierre-dark' : 'pierre-light',
            themeType: resolvedTheme,
          }}
        />
      )}
    </div>
  );
};
