import React from 'react';
import { PersonalAgentMemory } from './PersonalAgentMemory';
import { PersonalAgentChats } from './PersonalAgentChats';
import { Button, Chip, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Select, SelectItem, Spinner, Textarea } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { getCodexConnectionStatus, type CodexConnectionStatus } from '../utils/codexConnection';
import { formatDate } from '../utils/formatters';
import { getRoomActivityAt, pickNewerRoom, sortRoomsByLastActivityDesc } from '../utils/roomState';
import {
  createPersonalAgentGoal, deletePersonalAgentGoal, getPersonalAgent,
  runPersonalAgentGoal, updatePersonalAgentGoal, updatePersonalAgentProfile,
  type PersonalAgentGoal, type PersonalAgentGoalInput, type PersonalAgentProfile, type PersonalAgentSnapshot,
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

type AgentTab = 'chats' | 'goals' | 'activity' | 'memory';
interface AgentAction { (): Promise<void> }
const tabs: { key: AgentTab; icon: string; label: string }[] = [
  { key: 'chats', icon: 'lucide:message-circle', label: 'personalAgentChats' },
  { key: 'goals', icon: 'lucide:target', label: 'personalAgentGoals' },
  { key: 'activity', icon: 'lucide:activity', label: 'personalAgentActivity' },
  { key: 'memory', icon: 'lucide:brain', label: 'personalAgentMemory' },
];
const panelClass = 'rounded-2xl border border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]';
const mutedClass = 'text-[#5e5d59] dark:text-[#b0aea5]';
const roomStatusKey = (room: Room) => room.codeAgentStatus === 'running'
  ? 'personalAgentWorking' : room.codeAgentStatus === 'error' ? 'personalAgentNeedsAttention' : 'personalAgentConversationUpdated';
const newGoal = (): PersonalAgentGoalInput => ({
  title: '', prompt: '', schedule: 'manual', time: '09:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
});

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
  const [tab, setTab] = React.useState<AgentTab>('chats');
  const [isGoalModalOpen, setIsGoalModalOpen] = React.useState(false);
  const [editingGoal, setEditingGoal] = React.useState<PersonalAgentGoal | null>(null);
  const [goalDraft, setGoalDraft] = React.useState<PersonalAgentGoalInput>(newGoal);
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

  const openGoal = (goal?: PersonalAgentGoal) => {
    setEditingGoal(goal ?? null);
    setGoalDraft(goal ? { title: goal.title, prompt: goal.prompt, schedule: goal.schedule, time: goal.time, timezone: goal.timezone } : newGoal());
    setIsGoalModalOpen(true);
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

        <nav className="flex gap-1 overflow-x-auto rounded-full bg-default-100 p-1" aria-label={t('personalAgentSections')}>
          {tabs.map(item => <Button key={item.key} size="sm" variant={tab === item.key ? 'flat' : 'light'} color={tab === item.key ? 'secondary' : 'default'} onPress={() => setTab(item.key)} aria-current={tab === item.key ? 'page' : undefined} startContent={<Icon icon={item.icon} className="h-4 w-4" />}>{t(item.label)}</Button>)}
        </nav>

        {tab === 'chats' && <PersonalAgentChats clientId={clientId} rooms={rooms} mainRoom={mainRoom}
          onRoomSelect={onRoomSelect} onRoomUpdated={room => setSnapshot(previous => previous ? {
            ...previous, rooms: previous.rooms.some(item => item.id === room.id)
              ? previous.rooms.map(item => item.id === room.id ? room : item) : [...previous.rooms, room],
          } : previous)} showSuccess={showSuccess} showError={showError} />}

        {tab === 'goals' && <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className={`max-w-lg text-sm ${mutedClass}`}>{t('personalAgentGoalsDescription')}</p>
            <Button size="sm" color="secondary" onPress={() => openGoal()} startContent={<Icon icon="lucide:plus" className="h-4 w-4" />}>{t('personalAgentNewGoal')}</Button>
          </div>
          {snapshot.goals.length === 0 && <p className={`${panelClass} p-6 text-sm ${mutedClass}`}>{t('personalAgentNoGoals')}</p>}
          {snapshot.goals.map(goal => <article key={goal.id} className={`${panelClass} p-4`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><h3 className="font-medium">{goal.title}</h3><p className={`mt-1 whitespace-pre-wrap text-sm ${mutedClass}`}>{goal.prompt}</p></div>
              <Chip size="sm" variant="flat" color={goal.enabled ? 'success' : 'default'}>{t(goal.enabled ? 'personalAgentEnabled' : 'personalAgentPaused')}</Chip>
            </div>
            <p className={`mt-3 flex flex-wrap items-center gap-1.5 text-xs ${mutedClass}`}><Icon icon="lucide:clock" className="h-3.5 w-3.5" />{t(`personalAgentSchedule_${goal.schedule}`)}{goal.schedule !== 'manual' && <> · {goal.time} · {goal.timezone}</>}</p>
            {goal.nextRunAt && <p className={`mt-1 text-xs ${mutedClass}`}>{t('personalAgentNextRun', { date: formatDate(goal.nextRunAt, i18n.language) })}</p>}
            {goal.lastRunAt && <p className={`mt-1 text-xs ${mutedClass}`}>{t('personalAgentLastRun', { date: formatDate(goal.lastRunAt, i18n.language) })}</p>}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" variant="flat" color="secondary" isDisabled={isBusy || !isConnected} onPress={() => { void mutate(async () => { const { room } = await runPersonalAgentGoal(clientId, goal.id); onRoomSelect(room); }); }} startContent={<Icon icon="lucide:play" className="h-3.5 w-3.5" />}>{t('personalAgentRunNow')}</Button>
              <Button size="sm" variant="light" isDisabled={isBusy} onPress={() => { void mutate(async () => { const { goal: updated } = await updatePersonalAgentGoal(clientId, goal.id, { enabled: !goal.enabled }); setSnapshot(previous => previous ? { ...previous, goals: previous.goals.map(item => item.id === goal.id ? updated : item) } : previous); }); }}>{t(goal.enabled ? 'personalAgentPause' : 'personalAgentResume')}</Button>
              <Button size="sm" variant="light" isDisabled={isBusy} onPress={() => openGoal(goal)}>{t('edit')}</Button>
              <Button size="sm" variant="light" color="danger" isDisabled={isBusy} onPress={() => { void mutate(async () => { await deletePersonalAgentGoal(clientId, goal.id); setSnapshot(previous => previous ? { ...previous, goals: previous.goals.filter(item => item.id !== goal.id) } : previous); }); }}>{t('delete')}</Button>
            </div>
          </article>)}
        </section>}

        {tab === 'activity' && <section className={`${panelClass} divide-y divide-[#dedbd0] dark:divide-[#30302e]`} aria-label={t('personalAgentActivity')}>
          {rooms.map(room => <button key={room.id} type="button" className="flex w-full items-center gap-3 p-4 text-left hover:bg-[#f0eee6] dark:hover:bg-[#242422]" onClick={() => onRoomSelect(room)}>
            <Icon icon={room.codeAgentStatus === 'running' ? 'lucide:loader-circle' : room.codeAgentStatus === 'error' ? 'lucide:circle-alert' : 'lucide:message-circle'} className={`h-5 w-5 shrink-0 text-secondary ${room.codeAgentStatus === 'running' ? 'animate-spin' : ''}`} />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{room.name}</span><span className={`mt-1 block text-xs ${mutedClass}`}>{t(roomStatusKey(room))}</span></span>
            <span className={`text-right text-xs ${mutedClass}`}>{formatDate(getRoomActivityAt(room), i18n.language)}</span>
          </button>)}
        </section>}

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
          <Button type="submit" color="secondary" isLoading={isBusy} isDisabled={!profileDraft.name.trim() || !profileDraft.avatar.trim()}>{t('save')}</Button>
        </form></>}
      </div>

      <Modal isOpen={isGoalModalOpen} onOpenChange={setIsGoalModalOpen} scrollBehavior="inside">
        <ModalContent><ModalHeader>{t(editingGoal ? 'personalAgentEditGoal' : 'personalAgentNewGoal')}</ModalHeader><ModalBody className="gap-4">
          <Input autoFocus label={t('personalAgentGoalTitle')} value={goalDraft.title} maxLength={100} onValueChange={title => setGoalDraft({ ...goalDraft, title })} />
          <Textarea label={t('personalAgentGoalPrompt')} minRows={4} value={goalDraft.prompt} maxLength={16000} onValueChange={prompt => setGoalDraft({ ...goalDraft, prompt })} />
          <Select label={t('personalAgentSchedule')} selectedKeys={[goalDraft.schedule]} onSelectionChange={keys => { const schedule = Array.from(keys)[0]; if (schedule === 'manual' || schedule === 'daily' || schedule === 'weekly') setGoalDraft({ ...goalDraft, schedule }); }}>
            {(['manual', 'daily', 'weekly'] as const).map(schedule => <SelectItem key={schedule}>{t(`personalAgentSchedule_${schedule}`)}</SelectItem>)}
          </Select>
          {goalDraft.schedule !== 'manual' && <><Input type="time" label={t('personalAgentScheduleTime')} value={goalDraft.time} onValueChange={time => setGoalDraft({ ...goalDraft, time })} /><Input label={t('personalAgentTimezone')} value={goalDraft.timezone} onValueChange={timezone => setGoalDraft({ ...goalDraft, timezone })} /><p className={`text-xs ${mutedClass}`}>{t('personalAgentScheduleHint')}</p></>}
        </ModalBody><ModalFooter>
          <Button variant="light" onPress={() => setIsGoalModalOpen(false)}>{t('cancel')}</Button>
          <Button color="secondary" isLoading={isBusy} isDisabled={!goalDraft.title.trim() || !goalDraft.prompt.trim() || !goalDraft.time || !goalDraft.timezone.trim()} onPress={() => { void mutate(async () => {
            const { goal } = editingGoal ? await updatePersonalAgentGoal(clientId, editingGoal.id, goalDraft) : await createPersonalAgentGoal(clientId, goalDraft);
            setSnapshot(previous => previous ? { ...previous, goals: editingGoal ? previous.goals.map(item => item.id === goal.id ? goal : item) : [goal, ...previous.goals] } : previous);
            setIsGoalModalOpen(false);
            showSuccess(t('personalAgentGoalSaved'));
          }); }}>{t('save')}</Button>
        </ModalFooter></ModalContent>
      </Modal>
    </div>
  );
};
