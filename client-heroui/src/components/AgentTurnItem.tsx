import React from 'react';
import { Icon } from '@iconify/react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { Message, RoomAgentTurn, RoomAgentTurnPhase } from '../utils/types';
import { sortMessages } from '../utils/messageState';
import { AgentBackendAvatar } from './AgentBackendAvatar';

type CheckpointBoundary = 'before' | 'after';

interface AgentTurnItemProps {
  turn: RoomAgentTurn;
  messages: Message[];
  renderAgentMessage: (message: Message) => React.ReactNode;
  renderStandaloneMessage: (message: Message) => React.ReactNode;
  onRestoreCheckpoint?: (turn: RoomAgentTurn, targetBoundary: CheckpointBoundary) => unknown;
}

const phaseLabelKeys: Record<RoomAgentTurnPhase, string> = {
  preparing_context: 'agentPhasePreparingContext',
  preparing_sandbox: 'agentPhasePreparingSandbox',
  starting_agent: 'agentPhaseStarting',
  running: 'agentPhaseRunning',
  waiting_approval: 'agentPhaseWaitingApproval',
  completing: 'agentPhaseCompleting',
};

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
  onRestoreCheckpoint,
}) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());
  const [restoreDialogBoundary, setRestoreDialogBoundary] = React.useState<CheckpointBoundary | null>(null);
  const [isRestoreDialogOpen, setIsRestoreDialogOpen] = React.useState(false);
  const [restoringBoundary, setRestoringBoundary] = React.useState<CheckpointBoundary | null>(null);
  const [restoreNotice, setRestoreNotice] = React.useState<{ message: string; tone: 'success' | 'error' } | null>(null);
  const orderedMessages = React.useMemo(() => sortMessages(messages), [messages]);
  const ownMessages = React.useMemo(() => orderedMessages.filter(message => message.turnId === turn.id), [orderedMessages, turn.id]);
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
  const activePhaseLabel = turn.phase ? t(phaseLabelKeys[turn.phase]) : t('agentPhaseRunning');
  const canRestore = Boolean(
    onRestoreCheckpoint
    && turn.backend === 'codex-app-server'
    && turn.status !== 'running'
    && turn.workspaceCheckpoint?.status === 'ready'
  );

  React.useEffect(() => {
    if (!canRestore) setIsRestoreDialogOpen(false);
  }, [canRestore]);

  const restoreCheckpoint = async (targetBoundary: CheckpointBoundary) => {
    if (!onRestoreCheckpoint || restoringBoundary) return;
    setRestoringBoundary(targetBoundary);
    setRestoreNotice(null);
    try {
      const notice = await onRestoreCheckpoint(turn, targetBoundary);
      setRestoreNotice({
        message: typeof notice === 'string' ? notice : t('agentCheckpointRestored', { count: 0 }),
        tone: 'success',
      });
    } catch (error) {
      setRestoreNotice({
        message: error instanceof Error ? error.message : t('agentCheckpointRestoreFailed'),
        tone: 'error',
      });
    } finally {
      setRestoringBoundary(null);
    }
  };

  const openRestoreDialog = (targetBoundary: CheckpointBoundary) => {
    if (restoringBoundary) return;
    setRestoreNotice(null);
    setRestoreDialogBoundary(targetBoundary);
    setIsRestoreDialogOpen(true);
  };

  const confirmRestore = () => {
    const targetBoundary = restoreDialogBoundary;
    setIsRestoreDialogOpen(false);
    if (targetBoundary) void restoreCheckpoint(targetBoundary);
  };

  const renderOwnMessage = (message: Message) => (
    <div key={message.id} className="ml-10 max-w-[82%] sm:max-w-[70%]">
      {renderAgentMessage(message)}
    </div>
  );

  return (
    <div data-testid="agent-turn" data-turn-id={turn.id} data-turn-status={turn.status} className="relative w-full">
      <AgentBackendAvatar backend={turn.backend} label={turn.assistantName} />

      {turn.status === 'running' ? (
        <div className="ml-10 max-w-[82%] sm:max-w-[70%]">
          <div className="mb-1 border-b border-[#dedbd0] px-1 pb-1.5 text-xs text-[#5e5d59] dark:border-[#30302e] dark:text-[#b0aea5]">
            {activePhaseLabel} · {totalDuration}
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
          {canRestore && (
            <div className="mt-1 flex flex-wrap items-center gap-2 px-1">
              {(['before', 'after'] as const).map(targetBoundary => (
                <button
                  key={targetBoundary}
                  type="button"
                  disabled={Boolean(restoringBoundary)}
                  aria-haspopup="dialog"
                  onClick={() => openRestoreDialog(targetBoundary)}
                  className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-[#9f4d34] transition-colors duration-200 hover:bg-[#eadfd8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c96442] focus-visible:ring-offset-2 focus-visible:ring-offset-[#f5f4ed] disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none dark:text-[#e18a6d] dark:hover:bg-[#2a201c] dark:focus-visible:ring-[#d97757] dark:focus-visible:ring-offset-[#141413]"
                >
                  <Icon
                    icon={restoringBoundary === targetBoundary ? 'lucide:loader-circle' : targetBoundary === 'before' ? 'lucide:rotate-ccw' : 'lucide:rotate-cw'}
                    className={`h-3.5 w-3.5 ${restoringBoundary === targetBoundary ? 'animate-spin' : ''}`}
                  />
                  {restoringBoundary === targetBoundary
                    ? t('agentCheckpointRestoring')
                    : t(targetBoundary === 'before' ? 'agentCheckpointRestore' : 'agentCheckpointRestoreAfter')}
                </button>
              ))}
              <span className="text-[11px] text-[#77746d] dark:text-[#96938b]">
                {t('agentCheckpointFiles', { count: turn.workspaceCheckpoint?.restorableFileCount || 0 })}
              </span>
            </div>
          )}
          {restoreNotice && (
            <div
              role={restoreNotice.tone === 'error' ? 'alert' : 'status'}
              className={`mt-1 flex items-start gap-1.5 px-1 text-xs ${restoreNotice.tone === 'error'
                ? 'text-danger-600 dark:text-danger-400'
                : 'text-success-700 dark:text-success-400'}`}
            >
              <Icon
                icon={restoreNotice.tone === 'error' ? 'lucide:circle-alert' : 'lucide:circle-check'}
                className="mt-px h-3.5 w-3.5 flex-none"
                aria-hidden="true"
              />
              <span>{restoreNotice.message}</span>
            </div>
          )}
        </div>
      )}

      <div className="mt-1 flex flex-col space-y-2">
        {orderedMessages.map(message => {
          if (message.turnId !== turn.id) return renderStandaloneMessage(message);
          if (turn.status === 'running') return renderOwnMessage(message);
          if (message.id === finalMessageId) return renderOwnMessage(message);
          if (expanded) return renderOwnMessage(message);
          return null;
        })}
      </div>

      <Modal
        isOpen={isRestoreDialogOpen}
        onClose={() => setIsRestoreDialogOpen(false)}
        size="sm"
        placement="center"
        scrollBehavior="inside"
        classNames={{
          wrapper: 'roomtalk-modal-viewport px-3',
          backdrop: 'bg-[#141413]/50 backdrop-blur-sm',
        }}
      >
        <ModalContent className="mx-3 border border-[#dedbd0] bg-[#faf9f5] text-[#141413] shadow-2xl dark:border-[#3a3936] dark:bg-[#1d1d1b] dark:text-[#faf9f5] sm:mx-0">
          <ModalHeader className="flex items-center gap-3 px-5 pb-2 pt-5">
            <span className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-[#eadfd8] text-[#9f4d34] dark:bg-[#2a201c] dark:text-[#e18a6d]">
              <Icon icon="lucide:history" className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block font-serif text-lg font-medium leading-6">
                {t('agentCheckpointDialogTitle')}
              </span>
              {restoreDialogBoundary && (
                <span className="mt-0.5 block text-xs font-normal text-[#77746d] dark:text-[#aaa79f]">
                  {t(restoreDialogBoundary === 'before' ? 'agentCheckpointRestore' : 'agentCheckpointRestoreAfter')}
                </span>
              )}
            </span>
          </ModalHeader>
          <ModalBody className="gap-4 px-5 py-3">
            <p className="text-sm leading-6 text-[#4d4c48] dark:text-[#d7d5cd]">
              {restoreDialogBoundary && t(restoreDialogBoundary === 'before' ? 'agentCheckpointConfirm' : 'agentCheckpointConfirmAfter')}
            </p>
            <div className="flex items-center gap-3 rounded-xl border border-[#dedbd0] bg-[#f0eee6] px-3.5 py-3 dark:border-[#3a3936] dark:bg-[#242421]">
              <Icon icon="lucide:files" className="h-[18px] w-[18px] flex-none text-[#9f4d34] dark:text-[#e18a6d]" aria-hidden="true" />
              <span className="text-sm font-medium text-[#34332f] dark:text-[#e7e5dd]">
                {t('agentCheckpointFiles', { count: turn.workspaceCheckpoint?.restorableFileCount || 0 })}
              </span>
            </div>
          </ModalBody>
          <ModalFooter className="gap-2 border-t border-[#e5e2d9] px-5 pb-[max(env(safe-area-inset-bottom),1rem)] pt-3 dark:border-[#30302e]">
            <Button
              autoFocus
              variant="flat"
              onPress={() => setIsRestoreDialogOpen(false)}
              className="min-h-11 cursor-pointer bg-[#e8e6dc] text-[#4d4c48] transition-colors duration-200 hover:bg-[#dedbd0] motion-reduce:transition-none dark:bg-[#30302e] dark:text-[#d7d5cd] dark:hover:bg-[#3a3936]"
            >
              {t('cancel')}
            </Button>
            <Button
              onPress={confirmRestore}
              startContent={<Icon icon="lucide:history" className="h-4 w-4" aria-hidden="true" />}
              className="min-h-11 cursor-pointer bg-[#c96442] font-medium text-white shadow-sm transition-colors duration-200 hover:bg-[#b7593d] motion-reduce:transition-none dark:bg-[#d97757] dark:hover:bg-[#c96442]"
            >
              {t('agentCheckpointDialogConfirm')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
};
