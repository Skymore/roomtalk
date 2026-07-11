import React from 'react';
import { Avatar } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { Message, RoomAgentTurn } from '../utils/types';

interface AgentTurnItemProps {
  turn: RoomAgentTurn;
  messages: Message[];
  renderAgentMessage: (message: Message) => React.ReactNode;
  renderStandaloneMessage: (message: Message) => React.ReactNode;
}

const timestampMs = (value?: string) => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
};

export const formatAgentTurnDuration = (durationMs: number) => {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

export const AgentTurnItem: React.FC<AgentTurnItemProps> = ({
  turn,
  messages,
  renderAgentMessage,
  renderStandaloneMessage,
}) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());
  const ownMessages = React.useMemo(() => messages.filter(message => message.turnId === turn.id), [messages, turn.id]);
  const lastAIMessageId = [...ownMessages].reverse().find(message => message.messageType === 'ai')?.id;
  const fallbackFinalId = [...ownMessages].reverse().find(message => message.messageType !== 'tool_result')?.id || ownMessages.at(-1)?.id;
  const finalMessageId = ownMessages.some(message => message.id === turn.finalMessageId)
    ? turn.finalMessageId
    : lastAIMessageId || fallbackFinalId;

  React.useEffect(() => {
    if (turn.status !== 'running') return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [turn.status]);

  const startedAtMs = timestampMs(turn.startedAt);
  const completedAtMs = timestampMs(turn.completedAt) || Math.max(...ownMessages.map(message => timestampMs(message.timestamp)), startedAtMs);
  const totalDuration = formatAgentTurnDuration((turn.status === 'running' ? now : completedAtMs) - startedAtMs);

  const renderOwnMessage = (message: Message) => (
    <div key={message.id} className="ml-10 max-w-[82%] sm:max-w-[70%]">
      {renderAgentMessage(message)}
    </div>
  );

  return (
    <div data-testid="agent-turn" data-turn-id={turn.id} data-turn-status={turn.status} className="relative w-full">
      <Avatar
        icon={<Icon icon="lucide:bot" />}
        color="secondary"
        size="sm"
        aria-label={turn.assistantName}
        classNames={{
          base: 'absolute left-0 top-0 flex-shrink-0 bg-[#e8e6dc] text-[#4d4c48] dark:bg-[#30302e] dark:text-[#faf9f5]',
        }}
      />

      {turn.status === 'running' ? (
        <div className="ml-10 max-w-[82%] sm:max-w-[70%]">
          <div className="mb-1 border-b border-[#dedbd0] px-1 pb-1.5 text-xs text-[#5e5d59] dark:border-[#30302e] dark:text-[#b0aea5]">
            {t('agentWorkingFor', { duration: totalDuration })}
          </div>
        </div>
      ) : (
        <div className="ml-10 max-w-[82%] sm:max-w-[70%]">
          <div className="mb-1 ml-1 text-tiny text-[#5e5d59] dark:text-[#b0aea5]">{turn.assistantName}</div>
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? t('agentCollapseWork') : t('agentExpandWork')}
            onClick={() => setExpanded(value => !value)}
            className="flex w-full cursor-pointer items-center gap-1 border-b border-[#dedbd0] px-1 pb-2 text-left text-xs text-[#5e5d59] transition-colors duration-200 hover:text-[#141413] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c96442] motion-reduce:transition-none dark:border-[#30302e] dark:text-[#b0aea5] dark:hover:text-[#faf9f5] dark:focus-visible:ring-[#d97757]"
          >
            <span>{t('agentWorkedFor', { duration: totalDuration })}</span>
            <Icon icon="lucide:chevron-right" className={`h-3.5 w-3.5 transition-transform duration-200 motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`} />
          </button>
        </div>
      )}

      <div className="mt-1 flex flex-col space-y-2">
        {messages.map(message => {
          if (message.turnId !== turn.id) return renderStandaloneMessage(message);
          if (turn.status === 'running') return renderOwnMessage(message);
          if (message.id === finalMessageId) return renderOwnMessage(message);
          if (expanded) return renderOwnMessage(message);
          return null;
        })}
      </div>
    </div>
  );
};
