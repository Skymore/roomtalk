import { lazy, memo, Suspense, useEffect, useMemo, useState } from 'react';
import { FileDiff } from '@pierre/diffs/react';
import {
  buildReviewCommentRenderablePatch,
  formatReviewCommentFence,
  type ReviewCommentContext,
} from '../utils/codeAgentReviewComments';
import {
  buildFileDiffRenderKey,
  getRenderablePatch,
  resolveCodeAgentDiffThemeName,
  resolveFileDiffPath,
} from '../utils/codeAgentDiffRendering';
import { formatCodeAgentWorkspaceRelativePath } from '../utils/codeAgentFilePathDisplay';
import {
  CODE_AGENT_CHAT_FILE_TAG_CHIP_CLASS_NAME,
  CodeAgentFileTagChipContent,
} from './CodeAgentFileTagChip';

interface CodeAgentReviewCommentMessageProps {
  comment: ReviewCommentContext;
  onOpenWorkspaceFile?: (path: string) => void;
}

const CODE_AGENT_DEFAULT_WORKSPACE_ROOT = '/workspace';

const MarkdownContent = lazy(() =>
  import('./MarkdownContent').then((module) => ({ default: module.MarkdownContent })),
);

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

export const CodeAgentReviewCommentMessage = memo(function CodeAgentReviewCommentMessage({
  comment,
  onOpenWorkspaceFile,
}: CodeAgentReviewCommentMessageProps) {
  const resolvedTheme = useResolvedTheme();
  const fenceLanguage = comment.fenceLanguage ?? 'diff';
  const displayPath = formatCodeAgentWorkspaceRelativePath(comment.filePath, CODE_AGENT_DEFAULT_WORKSPACE_ROOT);
  const renderablePatch = useMemo(
    () => getRenderablePatch(
      buildReviewCommentRenderablePatch(comment),
      `review-comment:${comment.id}`,
    ),
    [comment],
  );

  return (
    <div
      className="space-y-2 rounded-lg border border-[#dedbd0] bg-[#faf9f5] p-3 text-[#141413] dark:border-[#30302e] dark:bg-[#1d1d1b] dark:text-[#faf9f5]"
      data-testid="code-agent-review-comment-card"
    >
      <div className="min-w-0 space-y-1">
        <div
          className={CODE_AGENT_CHAT_FILE_TAG_CHIP_CLASS_NAME}
          title={comment.filePath}
          data-testid="code-agent-review-comment-file-chip"
        >
          <CodeAgentFileTagChipContent
            path={comment.filePath}
            label={displayPath}
            theme={resolvedTheme}
            selectable
          />
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-medium text-[#5e5d59] dark:text-[#b0aea5]">
            {comment.sectionTitle} · {comment.rangeLabel}
          </div>
        </div>
      </div>

      {comment.text.length > 0 && (
        <div className="whitespace-pre-wrap break-words text-sm leading-5">
          {comment.text}
        </div>
      )}

      {fenceLanguage !== 'diff' && comment.diff.trim().length > 0 && (
        <Suspense fallback={
          <pre className="max-w-full overflow-x-auto rounded-md bg-[#f0eee6] p-2 text-xs dark:bg-[#242421]">
            {comment.diff}
          </pre>
        }>
          <MarkdownContent
            content={formatReviewCommentFence(fenceLanguage, comment.diff)}
            onOpenWorkspaceFile={onOpenWorkspaceFile}
          />
        </Suspense>
      )}

      {renderablePatch?.kind === 'files' && (
        <div className="max-w-full overflow-x-auto rounded-md border border-[#dedbd0] dark:border-[#30302e]" data-testid="code-agent-review-comment-diff">
          {renderablePatch.files.map((fileDiff) => (
            <FileDiff
              key={buildFileDiffRenderKey(fileDiff) || resolveFileDiffPath(fileDiff)}
              fileDiff={fileDiff}
              options={{
                collapsed: false,
                diffStyle: 'unified',
                theme: resolveCodeAgentDiffThemeName(resolvedTheme),
              }}
            />
          ))}
        </div>
      )}

      {renderablePatch?.kind === 'raw' && (
        <pre className="max-w-full overflow-x-auto rounded-md bg-[#f0eee6] p-2 text-xs dark:bg-[#242421]">
          {renderablePatch.text}
        </pre>
      )}
    </div>
  );
});
