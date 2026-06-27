import React from 'react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { Message } from '../utils/types';

interface CocoToolMessageProps {
  message: Message;
  pairedResult?: Message;
}

const OUTPUT_COLLAPSE_LIMIT = 1200;

const getToolSummary = (message: Message): string => {
  const args = message.toolArgs;
  if (!args) return '';
  const filePath = args.file_path || args.path || args.filename;
  if (typeof filePath === 'string') {
    const segments = filePath.split('/');
    return segments.length > 2
      ? `…/${segments.slice(-2).join('/')}`
      : filePath;
  }
  const command = args.command;
  if (typeof command === 'string') {
    return command.length > 60 ? `${command.slice(0, 57)}…` : command;
  }
  const query = args.query || args.url || args.pattern;
  if (typeof query === 'string') {
    return query.length > 60 ? `${query.slice(0, 57)}…` : query;
  }
  return '';
};

const getToolIcon = (toolName: string): string => {
  const lower = toolName.toLowerCase();
  if (lower === 'read') return 'lucide:file-text';
  if (lower === 'edit') return 'lucide:pencil';
  if (lower === 'write') return 'lucide:file-plus';
  if (lower === 'bash') return 'lucide:terminal';
  if (lower.includes('search') || lower.includes('grep')) return 'lucide:search';
  if (lower.includes('web') || lower.includes('fetch')) return 'lucide:globe';
  if (lower.includes('list') || lower.includes('glob')) return 'lucide:folder-open';
  return 'lucide:wrench';
};

const formatToolArgs = (args: Record<string, unknown> | undefined): string => {
  if (!args || Object.keys(args).length === 0) return '';
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
};

export const CocoToolMessage: React.FC<CocoToolMessageProps> = ({ message, pairedResult }) => {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = React.useState(false);
  const [isOutputExpanded, setIsOutputExpanded] = React.useState(false);

  const isToolCall = message.messageType === 'tool_call';
  const isSandboxStatus = message.messageType === 'sandbox_status';

  if (isSandboxStatus) {
    return (
      <div className="flex items-center gap-1.5 px-1 py-0.5">
        <Icon icon="lucide:box" className="h-3 w-3 flex-shrink-0 text-[#87867f] dark:text-[#8f8d86]" />
        <span className="text-xs text-[#87867f] dark:text-[#8f8d86]">
          {message.content || t('sandboxStatusEvent')}
        </span>
      </div>
    );
  }

  const isToolResult = message.messageType === 'tool_result';
  const toolName = message.toolName || t('unknownTool');
  const summary = isToolCall ? getToolSummary(message) : '';
  const icon = getToolIcon(toolName);

  const result = isToolResult ? message : pairedResult;
  const hasResult = !!result;
  const isError = result?.isError || result?.status === 'error';
  const isSuccess = hasResult && !isError;
  const isPending = isToolCall && !hasResult;

  const output = result?.toolOutputPreview || result?.content || '';
  const shouldCollapseOutput = output.length > OUTPUT_COLLAPSE_LIMIT;
  const visibleOutput = shouldCollapseOutput && !isOutputExpanded
    ? `${output.slice(0, OUTPUT_COLLAPSE_LIMIT)}…`
    : output;

  const argsBody = isToolCall ? formatToolArgs(message.toolArgs) : '';

  return (
    <div className="my-0.5 max-w-full">
      <button
        type="button"
        data-testid={isToolCall ? 'coco-tool-call' : 'coco-tool-result'}
        className={`
          group/tool flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-lg
          border px-2.5 py-1.5 text-left transition-colors
          ${isError
            ? 'border-danger-300/50 bg-danger-50/50 hover:bg-danger-50 dark:border-danger-500/30 dark:bg-danger-500/5 dark:hover:bg-danger-500/10'
            : 'border-[#dedbd0]/80 bg-[#f5f4ef]/60 hover:bg-[#efede5] dark:border-[#3a3a37]/80 dark:bg-[#242421]/60 dark:hover:bg-[#2a2a27]'
          }
        `}
        onClick={() => setIsExpanded(v => !v)}
      >
        <Icon
          icon={icon}
          className={`h-3.5 w-3.5 flex-shrink-0 ${isError ? 'text-danger-500 dark:text-danger-400' : 'text-[#87867f] dark:text-[#8f8d86]'}`}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-[#4d4c48] dark:text-[#c8c6be]">
          {toolName}
          {summary && (
            <span className="ml-1 font-normal text-[#87867f] dark:text-[#8f8d86]">{summary}</span>
          )}
        </span>

        {isPending && (
          <span className="ml-auto inline-block h-3 w-3 flex-shrink-0 animate-spin rounded-full border-[1.5px] border-[#87867f] border-t-transparent dark:border-[#8f8d86] dark:border-t-transparent" />
        )}
        {isSuccess && (
          <Icon icon="lucide:check" className="ml-auto h-3.5 w-3.5 flex-shrink-0 text-emerald-500 dark:text-emerald-400" />
        )}
        {isError && (
          <Icon icon="lucide:x" className="ml-auto h-3.5 w-3.5 flex-shrink-0 text-danger-500 dark:text-danger-400" />
        )}
        {typeof result?.exitCode === 'number' && result.exitCode !== 0 && (
          <span className="ml-0.5 text-[10px] font-mono text-danger-500 dark:text-danger-400">
            E{result.exitCode}
          </span>
        )}
        <Icon
          icon="lucide:chevron-right"
          className={`h-3 w-3 flex-shrink-0 text-[#b0aea5] transition-transform dark:text-[#6b6a65] ${isExpanded ? 'rotate-90' : ''}`}
        />
      </button>

      {isExpanded && (
        <div className="mt-1 max-w-full overflow-hidden rounded-lg border border-[#dedbd0]/60 bg-[#f9f8f4] dark:border-[#3a3a37]/60 dark:bg-[#1d1d1b]">
          {argsBody && (
            <div className="border-b border-[#dedbd0]/60 px-3 py-2 dark:border-[#3a3a37]/60">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[#87867f] dark:text-[#8f8d86]">
                {t('toolCall')}
              </div>
              <pre className="max-h-[200px] max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-[#4d4c48] dark:text-[#c8c6be]">
                {argsBody}
              </pre>
            </div>
          )}
          {hasResult && (
            <div className="px-3 py-2">
              <div className="mb-1 flex items-center gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[#87867f] dark:text-[#8f8d86]">
                  {t(isError ? 'toolResultFailed' : 'toolResultSucceeded')}
                </span>
                {typeof result.exitCode === 'number' && (
                  <span className="text-[10px] font-mono text-[#87867f] dark:text-[#8f8d86]">
                    {t('exitCode')} {result.exitCode}
                  </span>
                )}
              </div>
              <pre className={`max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 ${isError ? 'text-danger-600 dark:text-danger-300' : 'text-[#4d4c48] dark:text-[#c8c6be]'} ${shouldCollapseOutput && !isOutputExpanded ? '' : 'max-h-[400px]'}`}>
                {visibleOutput || t('emptyToolOutput')}
              </pre>
              {shouldCollapseOutput && (
                <button
                  type="button"
                  className="mt-1.5 text-xs font-medium text-[#87867f] hover:text-[#4d4c48] dark:text-[#8f8d86] dark:hover:text-[#c8c6be]"
                  onClick={(e) => { e.stopPropagation(); setIsOutputExpanded(v => !v); }}
                >
                  {isOutputExpanded ? t('showLess') : t('showMore')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
