import { useState } from 'react';
import { MessageCircle, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface LocalCommentAnnotationProps {
  kind: 'draft' | 'comment';
  rangeLabel: string;
  text: string;
  onCancel: () => void;
  onComment: (text: string) => void;
  onDelete: () => void;
}

export function CodeAgentLocalCommentAnnotation({
  kind,
  rangeLabel,
  text: savedText,
  onCancel,
  onComment,
  onDelete,
}: LocalCommentAnnotationProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');

  if (kind === 'comment') {
    return (
      <div
        data-file-comment-annotation
        className="mx-3 my-2 rounded-lg border border-[#dedbd0] bg-[#faf9f5] p-3 shadow-sm dark:border-[#30302e] dark:bg-[#1d1d1b]"
        contentEditable={false}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <MessageCircle className="h-4 w-4 text-[#87867f] dark:text-[#8f8d86]" />
          <span className="text-xs font-medium text-[#141413] dark:text-[#faf9f5]">{t('codeAgentLocalComment')}</span>
          <span className="ml-auto text-[11px] text-[#87867f] dark:text-[#8f8d86]">{rangeLabel}</span>
          <button
            type="button"
            aria-label={t('codeAgentDeleteComment')}
            onClick={onDelete}
            className="rounded-md p-1 text-[#87867f] hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[#141413] dark:text-[#faf9f5]">
          {savedText}
        </p>
      </div>
    );
  }

  return (
    <div
      data-file-comment-annotation
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
        aria-label={t('codeAgentCommentOnLines', { range: rangeLabel })}
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
