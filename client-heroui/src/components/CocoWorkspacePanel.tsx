import React from 'react';
import { Chip } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { formatUsdCost } from '../utils/formatters';
import { summarizeCocoMessages } from '../utils/cocoWorkspace';
import { FeatureFlags } from '../utils/features';
import { Message, Room } from '../utils/types';
import {
  getCocoAgentStatusClassName,
  getCocoStatusLabelKey,
  getSandboxStatusClassName,
  getSandboxStatusLabelKey,
} from '../utils/cocoRoom';

interface CocoWorkspacePanelProps {
  room: Room;
  messages: Message[];
  cocoMode: FeatureFlags['coco']['mode'];
  sessionCostUsd: number;
}

const statClassName = 'min-w-0 rounded-lg border border-[#dedbd0] bg-[#faf9f5] px-3 py-2 dark:border-[#30302e] dark:bg-[#1d1d1b]';

export const CocoWorkspacePanel: React.FC<CocoWorkspacePanelProps> = ({
  room,
  messages,
  cocoMode,
  sessionCostUsd,
}) => {
  const { t } = useTranslation();
  const summary = React.useMemo(() => summarizeCocoMessages(messages), [messages]);
  const isPlanMode = cocoMode === 'plan';
  const visibleFiles = summary.touchedFiles.slice(0, 8);
  const hiddenFileCount = Math.max(0, summary.touchedFiles.length - visibleFiles.length);

  const stats = [
    { label: t('codeAgentTools'), value: summary.toolCalls, icon: 'lucide:wrench' },
    { label: t('codeAgentResults'), value: summary.toolResults, icon: 'lucide:list-checks' },
    { label: t('codeAgentErrors'), value: summary.toolErrors, icon: 'lucide:circle-alert' },
  ];

  return (
    <section
      data-testid="code-agent-workspace"
      className="mb-3 border-b border-[#dedbd0] bg-[#f5f4ed] pb-3 dark:border-[#30302e] dark:bg-[#141413]"
      aria-label={t('codeAgentWorkspace')}
    >
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold uppercase tracking-normal text-[#5e5d59] dark:text-[#b0aea5]">
              {t('codeAgentWorkspace')}
            </h3>
            <Chip
              size="sm"
              variant="flat"
              startContent={<Icon icon={isPlanMode ? 'lucide:eye' : 'lucide:pencil-ruler'} className="h-3 w-3" />}
              classNames={{
                base: 'h-6 border border-[#dedbd0] bg-[#faf9f5] px-1.5 text-[#4d4c48] dark:border-[#30302e] dark:bg-[#242421] dark:text-[#faf9f5]',
                content: 'px-0 text-[11px] font-semibold',
              }}
            >
              {isPlanMode ? t('codeAgentReadOnlyMode') : t('codeAgentEditMode')}
            </Chip>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-[#5e5d59] dark:text-[#b0aea5]">
            {isPlanMode ? t('codeAgentReadOnlyDescription') : t('codeAgentEditDescription')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`inline-flex max-w-[150px] items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium ${getSandboxStatusClassName(room.sandboxStatus)}`}>
            <Icon icon="lucide:box" className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{t(getSandboxStatusLabelKey(room.sandboxStatus))}</span>
          </span>
          <span className={`inline-flex max-w-[150px] items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium ${getCocoAgentStatusClassName(room.cocoStatus)}`}>
            <Icon icon="lucide:bot" className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{t(getCocoStatusLabelKey(room.cocoStatus))}</span>
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-[#dedbd0] bg-[#faf9f5] px-2 py-1 text-[11px] font-medium text-[#4d4c48] dark:border-[#30302e] dark:bg-[#1d1d1b] dark:text-[#e8e6dc]">
            <Icon icon="lucide:coins" className="h-3 w-3" />
            {t('sessionCost')}: {formatUsdCost(sessionCostUsd)}
          </span>
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {stats.map((item) => (
          <div key={item.label} className={statClassName}>
            <div className="flex items-center gap-2 text-xs text-[#87867f] dark:text-[#b0aea5]">
              <Icon icon={item.icon} className="h-3.5 w-3.5" />
              <span className="truncate">{item.label}</span>
            </div>
            <div className="mt-1 text-lg font-semibold text-[#141413] dark:text-[#faf9f5]">{item.value}</div>
          </div>
        ))}
      </div>

      <div className="mt-2 grid gap-2 lg:grid-cols-[1.2fr_0.8fr]">
        <div className={statClassName}>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[#5e5d59] dark:text-[#b0aea5]">
            <Icon icon="lucide:file-code-2" className="h-3.5 w-3.5" />
            {t('codeAgentFiles')}
          </div>
          {summary.touchedFiles.length > 0 ? (
            <div className="flex max-h-20 flex-wrap gap-1 overflow-y-auto pr-1">
              {visibleFiles.map(file => (
                <span
                  key={file}
                  className="max-w-full truncate rounded-md bg-[#e8e6dc] px-2 py-1 font-mono text-[11px] text-[#4d4c48] dark:bg-[#30302e] dark:text-[#e8e6dc]"
                  title={file}
                >
                  {file}
                </span>
              ))}
              {hiddenFileCount > 0 && (
                <span
                  className="rounded-md border border-[#dedbd0] px-2 py-1 text-[11px] font-semibold text-[#5e5d59] dark:border-[#30302e] dark:text-[#b0aea5]"
                  title={summary.touchedFiles.slice(8).join('\n')}
                >
                  +{hiddenFileCount}
                </span>
              )}
            </div>
          ) : (
            <p className="text-xs text-[#87867f] dark:text-[#8f8d86]">{t('codeAgentNoFiles')}</p>
          )}
        </div>

        <div className={statClassName}>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[#5e5d59] dark:text-[#b0aea5]">
            <Icon icon="lucide:activity" className="h-3.5 w-3.5" />
            {t('codeAgentActivity')}
          </div>
          {summary.lastToolName ? (
            <p className="truncate text-xs text-[#4d4c48] dark:text-[#e8e6dc]">
              {t('codeAgentLatestTool')}: <span className="font-mono">{summary.lastToolName}</span>
            </p>
          ) : (
            <p className="text-xs text-[#87867f] dark:text-[#8f8d86]">{t('codeAgentNoActivity')}</p>
          )}
        </div>
      </div>
    </section>
  );
};
