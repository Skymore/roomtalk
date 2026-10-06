import {readPersonalTaskSteps} from '../utils/personalTaskSteps';
import {PersonalAgentTaskReceipt} from './PersonalAgentTaskReceipt';
import {DesktopToolCard} from './personalComputer/DesktopToolCard';
import type {PersonalDesktopStep} from '../utils/personalDesktopSteps';
import React from 'react';
import { PersonalAgentBrowserVisits } from './PersonalAgentBrowser';
import { PersonalAgentResults } from './PersonalAgentResults';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { MarkdownContent } from './MarkdownContent';
import { MessageItem } from './MessageItem';
import type { Message, RoomAgentTurn } from '../utils/types';

export const PersonalAgentMessage: React.FC<{ message: Message; onRetry?: (message: Message) => void; onOpenFile?: (path: string) => void; canInteract?: boolean }> = ({ message, onRetry, onOpenFile, canInteract = true }) => {
  const { t } = useTranslation();
  if (message.messageType === 'media') return <div className="mx-auto w-full max-w-3xl"><MessageItem message={message} roomPermissions={null} onStartEdit={() => {}} onDeleteMessage={() => {}} onReply={() => {}} isInteractionDisabled={!canInteract} /></div>;
  if (message.messageType !== 'text' && message.messageType !== 'ai') return null;
  if (!message.content.trim()) return null;
  const own = message.messageType === 'text';
  return <div className={`mx-auto flex w-full max-w-3xl ${own ? 'justify-end' : 'justify-start'}`} data-testid={own ? 'personal-user-message' : 'personal-agent-message'}>
    <div className={`min-w-0 max-w-[92%] rounded-3xl px-5 py-3 text-sm leading-7 ${own ? 'bg-[#ece8e0] dark:bg-[#34332f]' : 'bg-white dark:bg-[#252522]'} ${message.status === 'error' || message.deliveryStatus === 'failed' ? 'border border-danger-200' : ''}`}>
      {own ? <p className="whitespace-pre-wrap break-words">{message.content}</p> : <MarkdownContent content={message.content} isStreaming={message.status === 'streaming'} onOpenWorkspaceFile={onOpenFile} />}
      {message.deliveryStatus === 'failed' && <button type="button" className="mt-2 text-danger underline" disabled={!canInteract} onClick={() => onRetry?.(message)}>{t('retry')}</button>}
      {message.codeAgentQueuedInput?.state === 'queued' && <p className="mt-1 text-xs text-default-500">{t('personalAgentQueued')}</p>}
    </div>
  </div>;
};

export const PersonalAgentTurn: React.FC<{ clientId: string; canInteract?: boolean; desktopSteps?:PersonalDesktopStep[];liveDesktopStepId?:string;onOpenComputer?:()=>void;turn: RoomAgentTurn; messages: Message[]; renderMessage: (message: Message) => React.ReactNode }> = ({ clientId, canInteract = true, turn, messages, renderMessage, desktopSteps=[],liveDesktopStepId,onOpenComputer }) => {
  const { t } = useTranslation();
  const answers = messages.filter(message => message.messageType === 'ai' && message.content.trim());
  const final = turn.finalMessageId ? answers.find(message => message.id === turn.finalMessageId) : undefined;
  return <div className="space-y-3" data-testid="personal-agent-turn">
    {messages.filter(message => message.messageType === 'text' || message.messageType === 'media').map(message => <React.Fragment key={message.id}>{renderMessage(message)}</React.Fragment>)}
    {(final ? [final] : answers).map(message => <React.Fragment key={message.id}>{renderMessage(message)}</React.Fragment>)}
    {canInteract && readPersonalTaskSteps(messages).map(step=><PersonalAgentTaskReceipt key={step.id} clientId={clientId} step={step}/>)}
    {canInteract && desktopSteps.map(step=><DesktopToolCard key={step.id} clientId={clientId} step={step} live={step.id===liveDesktopStepId} onOpen={onOpenComputer}/>)}
    <PersonalAgentBrowserVisits clientId={clientId} turn={turn} canInteract={canInteract} />
    <PersonalAgentResults clientId={clientId} turn={turn} canInteract={canInteract} />
    {turn.status === 'running' && <p className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 py-2 text-sm text-default-500" role="status"><Icon icon="lucide:ellipsis" className="h-5 w-5 motion-safe:animate-pulse" />{t('personalAgentThinking')}</p>}
    {turn.status === 'error' && answers.length === 0 && <p className="mx-auto max-w-3xl text-sm text-danger" role="alert">{t('personalAgentTaskFailed')}</p>}
    {turn.status === 'cancelled' && <p className="mx-auto max-w-3xl px-4 text-xs text-default-500">{t('personalAgentStopped')}</p>}
  </div>;
};
