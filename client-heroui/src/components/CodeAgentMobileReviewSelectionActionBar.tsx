import { MessageCircle, X } from 'lucide-react';

interface CodeAgentMobileReviewSelectionActionBarProps {
  title: string | null;
  clearLabel: string;
  testId?: string;
  onOpenComment: (() => void) | null;
  onClear: () => void;
}

export function CodeAgentMobileReviewSelectionActionBar({
  title,
  clearLabel,
  testId = 'code-agent-mobile-review-selection-action-bar',
  onOpenComment,
  onClear,
}: CodeAgentMobileReviewSelectionActionBarProps) {
  if (!title) {
    return null;
  }

  const content = (
    <>
      <MessageCircle className="h-4 w-4 shrink-0" />
      <span className="min-w-0 truncate">{title}</span>
    </>
  );

  return (
    <div
      className="pointer-events-none absolute inset-x-3 bottom-3 z-50 flex items-center gap-2"
      data-testid={testId}
    >
      {onOpenComment ? (
        <button
          type="button"
          className="pointer-events-auto inline-flex min-h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-full bg-[#c96442] px-4 text-sm font-semibold text-[#faf9f5] shadow-lg shadow-[#141413]/15 transition-colors hover:bg-[#ad5237] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c96442] dark:bg-[#d97757] dark:text-[#141413] dark:hover:bg-[#ffb197]"
          onClick={onOpenComment}
        >
          {content}
        </button>
      ) : (
        <div className="pointer-events-auto inline-flex min-h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-full bg-[#c96442] px-4 text-sm font-semibold text-[#faf9f5] shadow-lg shadow-[#141413]/15 dark:bg-[#d97757] dark:text-[#141413]">
          {content}
        </div>
      )}
      <button
        type="button"
        className="pointer-events-auto inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#c96442] text-[#faf9f5] shadow-lg shadow-[#141413]/15 transition-colors hover:bg-[#ad5237] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c96442] dark:bg-[#d97757] dark:text-[#141413] dark:hover:bg-[#ffb197]"
        aria-label={clearLabel}
        onClick={onClear}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
