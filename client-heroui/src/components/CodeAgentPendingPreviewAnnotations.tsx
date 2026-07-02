import { MousePointerClick, X } from 'lucide-react';
import {
  formatCodeAgentPreviewAnnotationLabel,
  type CodeAgentPreviewAnnotationContext,
} from '../utils/codeAgentPreviewAnnotations';
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

interface CodeAgentPendingPreviewAnnotationsProps {
  annotations: ReadonlyArray<CodeAgentPreviewAnnotationContext>;
  onRemove: (annotationId: string) => void;
  removeLabel: (label: string) => string;
  className?: string;
}

export function CodeAgentPendingPreviewAnnotations({
  annotations,
  onRemove,
  removeLabel,
  className,
}: CodeAgentPendingPreviewAnnotationsProps) {
  if (annotations.length === 0) return null;

  return (
    <div className={classNames('flex flex-wrap gap-1.5', className)}>
      {annotations.map((annotation) => {
        const label = formatCodeAgentPreviewAnnotationLabel(annotation);
        const tooltip = annotation.comment.trim()
          || annotation.elements.map((target) => target.element.htmlPreview).filter(Boolean).join('\n\n')
          || annotation.pageUrl;
        return (
          <HoverTooltip
            key={annotation.id}
            content={tooltip}
            placement="top"
            size="sm"
            classNames={{
              content: 'max-w-96 whitespace-pre-wrap leading-tight',
            }}
          >
            <span className={classNames(CODE_AGENT_COMPOSER_INLINE_CHIP_CLASS_NAME, 'pr-1')}>
              <MousePointerClick
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
                  onRemove(annotation.id);
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
