import { MessageCircle, X } from 'lucide-react';
import type { ReviewCommentContext } from '../utils/codeAgentReviewComments';
import { HoverTooltip } from './HoverTooltip';
import {
  CODE_AGENT_COMPOSER_INLINE_CHIP_CLASS_NAME,
  CODE_AGENT_COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
  CODE_AGENT_COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  CODE_AGENT_COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from './codeAgentComposerInlineChip';

function classNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ');
}

interface CodeAgentPendingReviewCommentsProps {
  comments: ReadonlyArray<ReviewCommentContext>;
  onRemove: (commentId: string) => void;
  removeLabel: (label: string) => string;
  className?: string;
}

export function CodeAgentPendingReviewComments({
  comments,
  onRemove,
  removeLabel,
  className,
}: CodeAgentPendingReviewCommentsProps) {
  if (comments.length === 0) return null;

  return (
    <div className={classNames('flex flex-wrap gap-1.5', className)}>
      {comments.map((comment) => {
        const label = `${comment.filePath} ${comment.rangeLabel}`;
        return (
          <HoverTooltip
            key={comment.id}
            content={comment.text}
            placement="top"
            size="sm"
            classNames={{
              content: 'max-w-96 whitespace-pre-wrap leading-tight',
            }}
          >
            <span className={classNames(CODE_AGENT_COMPOSER_INLINE_CHIP_CLASS_NAME, 'pr-1')}>
              <MessageCircle
                className={CODE_AGENT_COMPOSER_INLINE_CHIP_ICON_CLASS_NAME}
                aria-hidden="true"
              />
              <span className={CODE_AGENT_COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>
                {label}
              </span>
              <button
                type="button"
                aria-label={removeLabel(label)}
                className={CODE_AGENT_COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onRemove(comment.id);
                }}
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </span>
          </HoverTooltip>
        );
      })}
    </div>
  );
}
