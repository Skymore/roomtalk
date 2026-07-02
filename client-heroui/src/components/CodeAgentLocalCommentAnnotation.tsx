import { useState } from 'react';
import { MessageCircle, Send, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface LocalCommentAnnotationProps {
  kind: 'draft' | 'comment';
  rangeLabel: string;
  text: string;
  filePath?: string;
  mobileLayout?: boolean;
  onCancel: () => void;
  onComment: (text: string) => void;
  onDelete: () => void;
}

export function CodeAgentLocalCommentAnnotation({
  kind,
  rangeLabel,
  text: savedText,
  filePath,
  mobileLayout = false,
  onCancel,
  onComment,
  onDelete,
}: LocalCommentAnnotationProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const commentOnLinesLabel = t('codeAgentCommentOnLines', { range: rangeLabel });
  const textareaId = `code-agent-mobile-comment-${rangeLabel.replace(/[^A-Za-z0-9_-]+/g, '-')}`;

  if (kind === 'comment') {
    return (
      <div
        data-file-comment-annotation
        data-mobile-comment-annotation={mobileLayout ? 'true' : undefined}
        data-testid="code-agent-local-comment-annotation"
        className={mobileLayout
          ? 'mx-2 my-2 rounded-2xl border border-[#dedbd0] bg-[#faf9f5] p-3.5 shadow-sm dark:border-[#30302e] dark:bg-[#1d1d1b]'
          : 'mx-3 my-2 rounded-lg border border-[#dedbd0] bg-[#faf9f5] p-3 shadow-sm dark:border-[#30302e] dark:bg-[#1d1d1b]'}
        contentEditable={false}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className={mobileLayout ? 'flex min-h-10 items-center gap-2' : 'flex items-center gap-2'}>
          <MessageCircle className={`${mobileLayout ? 'h-5 w-5' : 'h-4 w-4'} text-[#87867f] dark:text-[#8f8d86]`} />
          <span className={`${mobileLayout ? 'text-sm' : 'text-xs'} font-medium text-[#141413] dark:text-[#faf9f5]`}>{t('codeAgentLocalComment')}</span>
          <span className={`${mobileLayout ? 'text-xs' : 'text-[11px]'} ml-auto text-[#87867f] dark:text-[#8f8d86]`}>{rangeLabel}</span>
          <button
            type="button"
            aria-label={t('codeAgentDeleteComment')}
            onClick={onDelete}
            className={mobileLayout
              ? 'inline-flex h-10 w-10 items-center justify-center rounded-full text-[#87867f] hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]'
              : 'rounded-md p-1 text-[#87867f] hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]'}
          >
            <Trash2 className={mobileLayout ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
          </button>
        </div>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[#141413] dark:text-[#faf9f5]">
          {savedText}
        </p>
      </div>
    );
  }

  if (mobileLayout) {
    return (
      <div
        data-file-comment-annotation
        data-mobile-comment-annotation="true"
        data-testid="code-agent-mobile-review-comment-sheet"
        role="dialog"
        aria-label={t('codeAgentLocalComment')}
        className="fixed inset-x-3 bottom-[calc(var(--code-agent-composer-height,96px)+env(safe-area-inset-bottom)+0.75rem)] z-[90] max-h-[min(80dvh,32rem)] overflow-hidden rounded-[22px] border border-[#dedbd0] bg-[#faf9f5] shadow-2xl shadow-[#141413]/20 dark:border-[#30302e] dark:bg-[#1d1d1b]"
        contentEditable={false}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex min-h-14 items-center justify-between gap-3 border-b border-[#dedbd0] px-4 py-2 dark:border-[#30302e]">
          <button
            type="button"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#f0eee6] text-[#5e5d59] transition-colors hover:bg-[#e8e6dc] hover:text-[#141413] dark:bg-[#30302e] dark:text-[#b0aea5] dark:hover:text-[#faf9f5]"
            aria-label={t('codeAgentCancelComment')}
            onClick={onCancel}
          >
            <X className="h-4 w-4" />
          </button>
          <div className="min-w-0 text-center">
            <div className="text-base font-semibold text-[#141413] dark:text-[#faf9f5]">{t('codeAgentLocalComment')}</div>
            <div className="mt-0.5 truncate text-xs text-[#87867f] dark:text-[#8f8d86]">{rangeLabel}</div>
          </div>
          <div className="h-10 w-10 shrink-0" />
        </div>
        <div className="max-h-[calc(min(80dvh,32rem)-7.5rem)] overflow-y-auto px-4 py-3 [-webkit-overflow-scrolling:touch]">
          <div className="space-y-1 px-1">
            <div className="text-[11px] font-semibold uppercase text-[#87867f] dark:text-[#8f8d86]">{commentOnLinesLabel}</div>
            {filePath ? (
              <div className="line-clamp-2 break-all font-mono text-xs leading-[17px] text-[#5e5d59] dark:text-[#b0aea5]">
                {filePath}
              </div>
            ) : null}
          </div>
          <label className="mt-4 block text-sm font-semibold text-[#141413] dark:text-[#faf9f5]" htmlFor={textareaId}>
            {t('codeAgentLocalComment')}
          </label>
          <textarea
            id={textareaId}
            autoFocus
            className="mt-2 min-h-[132px] w-full resize-y rounded-[20px] border border-[#dedbd0] bg-[#faf9f5] px-4 py-3 text-base leading-6 text-[#141413] outline-none focus:border-[#c96442] dark:border-[#30302e] dark:bg-[#141413] dark:text-[#faf9f5]"
            data-testid="code-agent-mobile-review-comment-textarea"
            value={text}
            placeholder={t('codeAgentCommentPlaceholder')}
            aria-label={commentOnLinesLabel}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                onCancel();
              }
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && text.trim()) {
                event.preventDefault();
                onComment(text.trim());
              }
            }}
          />
        </div>
        <div className="flex items-center gap-3 border-t border-[#dedbd0] bg-[#f0eee6] px-4 py-3 dark:border-[#30302e] dark:bg-[#242422]">
          <button
            type="button"
            className="inline-flex min-h-11 flex-1 items-center justify-center rounded-full px-4 text-sm font-semibold text-[#5e5d59] transition-colors hover:bg-[#e8e6dc] hover:text-[#141413] dark:text-[#b0aea5] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]"
            onClick={onCancel}
          >
            {t('codeAgentCancelComment')}
          </button>
          <button
            type="button"
            disabled={!text.trim()}
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full bg-[#c96442] px-4 text-sm font-semibold text-[#faf9f5] shadow-lg shadow-[#141413]/10 transition-colors hover:bg-[#ad5237] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#d97757] dark:text-[#141413] dark:hover:bg-[#ffb197]"
            onClick={() => onComment(text.trim())}
          >
            <Send className="h-4 w-4" />
            {t('codeAgentSubmitComment')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      data-file-comment-annotation
      data-testid="code-agent-local-comment-annotation"
      className="mx-3 my-2 rounded-lg border border-[#dedbd0] bg-[#faf9f5] p-3 shadow-lg dark:border-[#30302e] dark:bg-[#1d1d1b]"
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2">
        <MessageCircle className="h-4 w-4 text-[#87867f] dark:text-[#8f8d86]" />
        <span className="text-sm font-medium text-[#141413] dark:text-[#faf9f5]">{t('codeAgentLocalComment')}</span>
      </div>
      <div className="mt-1 text-xs text-[#87867f] dark:text-[#8f8d86]">{t('codeAgentCommentOnLines', { range: rangeLabel })}</div>
      <textarea
        autoFocus
        className="mt-3 min-h-20 w-full resize-y rounded-md border border-[#dedbd0] bg-[#faf9f5] px-2 py-1.5 text-sm text-[#141413] outline-none focus:border-[#c96442] dark:border-[#30302e] dark:bg-[#141413] dark:text-[#faf9f5]"
        value={text}
        placeholder={t('codeAgentCommentPlaceholder')}
        aria-label={commentOnLinesLabel}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && text.trim()) {
            event.preventDefault();
            onComment(text.trim());
          }
        }}
      />
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          className="rounded-md px-2 py-1 text-sm text-[#5e5d59] hover:bg-[#f0eee6] dark:text-[#b0aea5] dark:hover:bg-[#30302e]"
          onClick={onCancel}
        >
          {t('codeAgentCancelComment')}
        </button>
        <button
          type="button"
          disabled={!text.trim()}
          className="rounded-md bg-[#c96442] px-2 py-1 text-sm text-[#faf9f5] disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => onComment(text.trim())}
        >
          {t('codeAgentSubmitComment')}
        </button>
      </div>
    </div>
  );
}
