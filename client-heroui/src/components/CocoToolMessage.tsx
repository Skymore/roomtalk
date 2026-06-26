import React from 'react';
import { Button, Card, Chip } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { Message } from '../utils/types';

interface CocoToolMessageProps {
  message: Message;
}

const COLLAPSE_LIMIT = 900;

const formatToolArgs = (args: Record<string, unknown> | undefined): string => {
  if (!args || Object.keys(args).length === 0) return '';

  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
};

export const CocoToolMessage: React.FC<CocoToolMessageProps> = ({ message }) => {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = React.useState(false);
  const isToolCall = message.messageType === 'tool_call';
  const isToolResult = message.messageType === 'tool_result';
  const isSandboxStatus = message.messageType === 'sandbox_status';
  const title = isToolCall
    ? t('toolCall')
    : isToolResult
      ? t(message.isError ? 'toolResultFailed' : 'toolResultSucceeded')
      : t('sandboxStatusEvent');
  const toolName = message.toolName || t('unknownTool');
  const body = isToolCall
    ? formatToolArgs(message.toolArgs) || message.content
    : message.toolOutputPreview || message.content;
  const shouldCollapse = body.length > COLLAPSE_LIMIT;
  const visibleBody = shouldCollapse && !isExpanded ? `${body.slice(0, COLLAPSE_LIMIT)}...` : body;
  const icon = isToolCall ? 'lucide:wrench' : isToolResult ? (message.isError ? 'lucide:circle-alert' : 'lucide:check-circle') : 'lucide:box';
  const toneClassName = message.isError || message.status === 'error'
    ? 'border-danger-400/50 bg-danger-500/10 text-danger-700 dark:text-danger-300'
    : isSandboxStatus
      ? 'border-warning-400/50 bg-warning-500/10 text-warning-700 dark:text-warning-300'
      : 'border-[#c96442]/40 bg-[#c96442]/10 text-[#8c422b] dark:text-[#f0a487]';

  return (
    <Card className="w-full max-w-full overflow-hidden rounded-xl bg-[#faf9f5] text-[#141413] shadow-[0_0_0_1px_rgba(222,219,208,0.95)] dark:bg-[#1d1d1b] dark:text-[#faf9f5] dark:shadow-[0_0_0_1px_rgba(48,48,46,0.95)]">
      <div className="flex min-w-0 items-start gap-2 border-b border-[#dedbd0] px-3 py-2 dark:border-[#30302e]">
        <span className={`mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md border ${toneClassName}`}>
          <Icon icon={icon} className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="truncate text-xs font-semibold uppercase text-[#5e5d59] dark:text-[#b0aea5]">
              {title}
            </span>
            {!isSandboxStatus && (
              <Chip
                size="sm"
                variant="flat"
                classNames={{
                  base: 'h-5 max-w-full bg-[#e8e6dc] px-1.5 text-[#4d4c48] dark:bg-[#30302e] dark:text-[#faf9f5]',
                  content: 'truncate px-0 text-[11px] font-semibold',
                }}
              >
                {toolName}
              </Chip>
            )}
            {typeof message.exitCode === 'number' && (
              <Chip
                size="sm"
                variant="flat"
                classNames={{
                  base: 'h-5 bg-[#e8e6dc] px-1.5 text-[#4d4c48] dark:bg-[#30302e] dark:text-[#faf9f5]',
                  content: 'px-0 text-[11px] font-semibold',
                }}
              >
                {t('exitCode')} {message.exitCode}
              </Chip>
            )}
          </div>
          {message.content && isSandboxStatus && (
            <p className="mt-1 break-words text-xs text-[#5e5d59] dark:text-[#b0aea5]">{message.content}</p>
          )}
        </div>
      </div>

      {!isSandboxStatus && (
        <div className="max-w-full px-3 py-2">
          <pre className="max-h-[360px] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#f0eee6] p-2 font-mono text-xs leading-5 text-[#272724] dark:bg-[#242421] dark:text-[#e8e6dc]">
            {visibleBody || t('emptyToolOutput')}
          </pre>
          {shouldCollapse && (
            <Button
              size="sm"
              variant="light"
              className="mt-2 h-7 px-2 text-xs text-[#c96442] dark:text-[#d97757]"
              onPress={() => setIsExpanded(value => !value)}
            >
              {isExpanded ? t('showLess') : t('showMore')}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
};
