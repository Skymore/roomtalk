import React from 'react';
import { PersonalAgentTracking } from './PersonalAgentTracking';
import { PersonalAgentUpdates } from './PersonalAgentUpdates';
import { PersonalAgentIdeas } from './PersonalAgentIdeas';
import { PersonalAgentMemory } from './PersonalAgentMemory';
import { PersonalAgentGoals } from './PersonalAgentGoals';
import { PersonalAgentChats } from './PersonalAgentChats';
import { Button, Checkbox, Input, Spinner, Textarea } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { getCodexConnectionStatus, type CodexConnectionStatus } from '../utils/codexConnection';
import { formatDate } from '../utils/formatters';
import { getRoomActivityAt, pickNewerRoom, sortRoomsByLastActivityDesc } from '../utils/roomState';
import {
  getPersonalAgent, updatePersonalAgentProfile,
  type PersonalAgentProfile, type PersonalAgentSnapshot,
} from '../utils/personalAgent';
import type { Room } from '../utils/types';

interface PersonalAgentViewProps {
  clientId: string;
  roomUpdates: Room[];
  onRoomSelect: (room: Room) => void;
  onOpenConnections: () => void;
  onBack?: () => void;
  showSuccess: (message: string) => void;
  showError: (message: string) => void;
}

type AgentTab = 'chats' | 'ideas' | 'tracking' | 'goals' | 'activity' | 'memory';
interface AgentAction { (): Promise<void> }
const tabs: { key: AgentTab; icon: string; label: string }[] = [
  { key: 'chats', icon: 'lucide:message-circle', label: 'personalAgentChats' },
  { key: 'ideas', icon: 'lucide:lightbulb', label: 'personalAgentIdeas' },
  { key: 'tracking', icon: 'lucide:radar', label: 'personalAgentTracking' },
  { key: 'goals', icon: 'lucide:target', label: 'personalAgentGoals' },
  { key: 'activity', icon: 'lucide:activity', label: 'personalAgentActivity' },
  { key: 'memory', icon: 'lucide:brain', label: 'personalAgentMemory' },
];
const panelClass = 'rounded-2xl border border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]';
const mutedClass = 'text-[#5e5d59] dark:text-[#b0aea5]';
const roomStatusKey = (room: Room) => room.codeAgentStatus === 'running'
  ? 'personalAgentWorking' : room.codeAgentStatus === 'error' ? 'personalAgentNeedsAttention' : 'personalAgentConversationUpdated';

export const PersonalAgentView: React.FC<PersonalAgentViewProps> = ({
  clientId, roomUpdates, onRoomSelect, onOpenConnections, onBack, showSuccess, showError,
}) => {
  const { t, i18n } = useTranslation();
  const [snapshot, setSnapshot] = React.useState<PersonalAgentSnapshot | null>(null);
  const [profileDraft, setProfileDraft] = React.useState<PersonalAgentProfile | null>(null);
  const [connection, setConnection] = React.useState<CodexConnectionStatus | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [requiresSignIn, setRequiresSignIn] = React.useState(false);
  const [isBusy, setIsBusy] = React.useState(false);
  const [tab, setTab] = React.useState<AgentTab>(() => new URLSearchParams(window.location.search).get('tab') === 'activity' ? 'activity' : 'chats');
  const profileDirty = React.useRef(false);

  const refresh = React.useCallback(async () => {
    const results = await Promise.allSettled([getPersonalAgent(clientId), getCodexConnectionStatus(clientId)]);
    const agent = results[0];
    if (agent.status === 'fulfilled') {
      setRequiresSignIn(false);
      setSnapshot(agent.value);
      if (!profileDirty.current) {
        setProfileDraft(agent.value.profile);
      }
    } else {
      setRequiresSignIn(agent.reason?.status === 401);
      showError(agent.reason instanceof Error ? agent.reason.message : t('personalAgentLoadFailed'));
    }
    const codex = results[1];
    setConnection(codex.status === 'fulfilled' ? codex.value : null);
    setIsLoading(false);
  }, [clientId, showError, t]);

  React.useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30000);
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', onFocus); };
  }, [refresh]);

  const rooms = React.useMemo(() => sortRoomsByLastActivityDesc((snapshot?.rooms ?? []).map(room => {
    const updated = roomUpdates.find(item => item.id === room.id);
    return updated ? pickNewerRoom(updated, room) : room;
  })), [roomUpdates, snapshot]);
  const mainRoom = rooms.find(room => room.id === snapshot?.profile.mainRoomId);
  const workingCount = rooms.filter(room => room.codeAgentStatus === 'running').length;
  const isConnected = connection?.status === 'connected';

  const mutate = async (action: AgentAction) => {
    if (isBusy) return;
    setIsBusy(true);
    try { await action(); } catch (error) {
      showError(error instanceof Error ? error.message : t('personalAgentUpdateFailed'));
    } finally { setIsBusy(false); }
  };

  const editProfile = (changes: Partial<PersonalAgentProfile>) => {
    profileDirty.current = true;
    setProfileDraft(previous => previous ? { ...previous, ...changes } : previous);
  };

  if (isLoading) return <div className="flex h-full w-full items-center justify-center"><Spinner label={t('loading')} color="secondary" /></div>;
  if (!snapshot || !profileDraft) return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-6">
      <Icon icon="lucide:bot" className="h-10 w-10 text-secondary" />
      <p className={mutedClass}>{t('personalAgentLoadFailed')}</p>
      {requiresSignIn && <><p className={`max-w-md text-center text-sm ${mutedClass}`}>{t('personalAgentSignInHint')}</p><Button color="secondary" onPress={onOpenConnections}>{t('settings')}</Button></>}
      <Button onPress={() => { setIsLoading(true); void refresh(); }}>{t('retry')}</Button>
    </div>
  );

  return (
    <div className="h-full w-full overflow-y-auto" data-testid="personal-agent-view">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-8 sm:py-9">
        <div className="flex items-center justify-between"><Button size="sm" variant="light" onPress={onBack} startContent={<Icon icon="lucide:arrow-left" />}>RoomTalk</Button><Button isIconOnly variant="light" aria-label={t('settings')} onPress={onOpenConnections}><Icon icon="lucide:settings" className="h-5 w-5" /></Button></div>
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[#e8e6dc] text-3xl dark:bg-[#30302e]" aria-hidden="true">{snapshot.profile.avatar}</span>
            <div>
              <p className={`text-xs font-medium ${mutedClass}`}>{t('personalAgent')}</p>
              <h2 className="font-serif text-3xl">{snapshot.profile.name}</h2>
              {workingCount > 0 && <p className={`mt-1 text-sm ${mutedClass}`}>{t('personalAgentWorkingCount', { count: workingCount })}</p>}
            </div>
          </div>
          <Button size="sm" variant="flat" onPress={() => { void refresh(); }} startContent={<Icon icon="lucide:refresh-cw" className="h-4 w-4" />}>{t('refresh')}</Button>
        </header>

        {!isConnected && <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-default-100 p-4"><p className="flex-1 text-sm text-default-600">{t('personalAgentConnectionHint')}</p><Button size="sm" color="secondary" onPress={onOpenConnections}>{t('personalAgentConnectAccount')}</Button></div>}

        <nav className="grid grid-cols-3 gap-1 rounded-2xl bg-default-100 p-1 sm:flex sm:rounded-full" aria-label={t('personalAgentSections')}>
          {tabs.map(item => <Button key={item.key} className="min-w-0" size="sm" variant={tab === item.key ? 'flat' : 'light'} color={tab === item.key ? 'secondary' : 'default'} onPress={() => setTab(item.key)} aria-current={tab === item.key ? 'page' : undefined} startContent={<Icon icon={item.icon} className="h-4 w-4" />}>{t(item.label)}</Button>)}
        </nav>

        {tab !== 'activity' && <PersonalAgentUpdates key={`${clientId}:banner`} clientId={clientId} rooms={rooms} mode="banner" enabled={snapshot.profile.showUpdates !== false}
          onRoomSelect={onRoomSelect} onOpenUpdates={() => setTab('activity')} showError={showError} />}
        {tab === 'tracking' && <PersonalAgentTracking key={clientId} clientId={clientId} showError={showError} showSuccess={showSuccess} />}
        {tab === 'chats' && <PersonalAgentChats clientId={clientId} rooms={rooms} mainRoom={mainRoom}
          onRoomSelect={onRoomSelect} onRoomUpdated={room => setSnapshot(previous => previous ? {
            ...previous, rooms: previous.rooms.some(item => item.id === room.id)
              ? previous.rooms.map(item => item.id === room.id ? room : item) : [...previous.rooms, room],
          } : previous)} showSuccess={showSuccess} showError={showError} />}

        {tab === 'ideas' && <PersonalAgentIdeas key={clientId} clientId={clientId} ideas={snapshot.ideas} rooms={rooms} isConnected={isConnected}
          onRoomSelect={onRoomSelect} onIdeasChange={ideas => setSnapshot(previous => previous ? { ...previous, ideas } : previous)}
          onIdeaChange={idea => setSnapshot(previous => previous ? { ...previous, ideas: previous.ideas.map(value => value.id === idea.id ? idea : value) } : previous)}
          onIdeasAppend={ideas => setSnapshot(previous => previous ? { ...previous, ideas: [...previous.ideas, ...ideas.filter(idea => !previous.ideas.some(value => value.id === idea.id))] } : previous)}
          showSuccess={showSuccess} showError={showError} />}

        {tab === 'goals' && <PersonalAgentGoals clientId={clientId} goals={snapshot.goals} rooms={rooms} isConnected={isConnected}
          onRoomSelect={onRoomSelect} onGoalsChange={goals => setSnapshot(previous => previous ? { ...previous, goals } : previous)}
          showSuccess={showSuccess} showError={showError} />}

        {tab === 'activity' && <><PersonalAgentUpdates key={`${clientId}:updates`} clientId={clientId} rooms={rooms} mode="list" enabled onRoomSelect={onRoomSelect} onOpenUpdates={() => setTab('activity')} showError={showError} /><section className={`${panelClass} divide-y divide-[#dedbd0] dark:divide-[#30302e]`} aria-label={t('personalAgentActivity')}>
          {rooms.filter(room => room.personalAgentThreadKind !== 'watch').map(room => <button key={room.id} type="button" className="flex w-full items-center gap-3 p-4 text-left hover:bg-[#f0eee6] dark:hover:bg-[#242422]" onClick={() => onRoomSelect(room)}>
            <Icon icon={room.codeAgentStatus === 'running' ? 'lucide:loader-circle' : room.codeAgentStatus === 'error' ? 'lucide:circle-alert' : 'lucide:message-circle'} className={`h-5 w-5 shrink-0 text-secondary ${room.codeAgentStatus === 'running' ? 'animate-spin' : ''}`} />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{room.name}</span><span className={`mt-1 block text-xs ${mutedClass}`}>{t(roomStatusKey(room))}</span></span>
            <span className={`text-right text-xs ${mutedClass}`}>{formatDate(getRoomActivityAt(room), i18n.language)}</span>
          </button>)}
        </section></>}

        {tab === 'memory' && <><PersonalAgentMemory clientId={clientId} rooms={rooms} onRoomSelect={onRoomSelect} showError={showError} showSuccess={showSuccess} /><form className={`${panelClass} space-y-5 p-5 sm:p-6`} onSubmit={event => { event.preventDefault(); void mutate(async () => {
          const { profile } = await updatePersonalAgentProfile(clientId, profileDraft, profileDraft.updatedAt);
          profileDirty.current = false;
          setSnapshot(previous => previous ? { ...previous, profile } : previous);
          setProfileDraft(profile);
          showSuccess(t('personalAgentProfileSaved'));
        }); }}>
          <p className={`text-sm ${mutedClass}`}>{t('personalAgentMemoryDescription')}</p>
          <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
            <Input label={t('personalAgentName')} value={profileDraft.name} maxLength={100} isRequired onValueChange={name => editProfile({ name })} />
            <Input label={t('personalAgentAvatar')} value={profileDraft.avatar} maxLength={64} isRequired onValueChange={avatar => editProfile({ avatar })} />
          </div>
          <Textarea label={t('personalAgentInstructions')} description={t('personalAgentInstructionsDescription')} value={profileDraft.instructions} minRows={4} maxLength={8000} onValueChange={instructions => editProfile({ instructions })} />
          <Textarea label={t('personalAgentAboutYou')} description={t('personalAgentMemoryFieldDescription')} value={profileDraft.memory} minRows={6} maxLength={16000} onValueChange={memory => editProfile({ memory })} />
          <div className="space-y-3">
            <Checkbox isSelected={profileDraft.showUpdates !== false} onValueChange={showUpdates => editProfile({ showUpdates })}>{t('personalShowUpdates')}</Checkbox>
            <Checkbox isSelected={profileDraft.pushEnabled !== false} onValueChange={pushEnabled => editProfile({ pushEnabled })}>{t('personalPushUpdates')}</Checkbox>
            <p className="text-xs text-default-500">{t('personalNotificationPreferencesHint')}</p>
          </div>
          <Button type="submit" color="secondary" isLoading={isBusy} isDisabled={!profileDraft.name.trim() || !profileDraft.avatar.trim()}>{t('save')}</Button>
        </form></>}
      </div>


    </div>
  );
};
