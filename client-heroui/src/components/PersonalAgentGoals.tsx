import React from 'react';
import { Button, Checkbox, Chip, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Select, SelectItem, Textarea } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { createPersonalAgentGoal, cancelPersonalAgentGoal, deletePersonalAgentGoal, runPersonalAgentGoal, updatePersonalAgentGoal,
  type PersonalAgentGoal, type PersonalAgentGoalInput } from '../utils/personalAgent';
import type { Room } from '../utils/types';

interface GoalAction { (): Promise<void> }
interface PersonalAgentGoalsProps {
  clientId: string; goals: PersonalAgentGoal[]; rooms: Room[]; isConnected: boolean;
  onRoomSelect: (room: Room) => void; onGoalsChange: (goals: PersonalAgentGoal[]) => void;
  showSuccess: (message: string) => void; showError: (message: string) => void;
}
const panelClass = 'rounded-2xl border border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]';
const mutedClass = 'text-[#5e5d59] dark:text-[#b0aea5]';
const localDateTime = (value?: string) => {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const formatRunDate = (date: string, language: string, timezone: string) => new Intl.DateTimeFormat(language, {
  timeZone: timezone, dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(date));
const newGoal = (): PersonalAgentGoalInput => ({
  title: '', prompt: '', schedule: 'manual', weekday: new Date().getDay(), time: '09:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
});

export const PersonalAgentGoals: React.FC<PersonalAgentGoalsProps> = ({ clientId, goals, rooms, isConnected, onRoomSelect, onGoalsChange, showSuccess, showError }) => {
  const { t, i18n } = useTranslation();
  const [isBusy, setIsBusy] = React.useState(false);
  const [isGoalModalOpen, setIsGoalModalOpen] = React.useState(false);
  const [editingGoal, setEditingGoal] = React.useState<PersonalAgentGoal | null>(null);
  const [goalDraft, setGoalDraft] = React.useState<PersonalAgentGoalInput>(newGoal);

  const mutate = async (action: GoalAction) => {
    if (isBusy) return;
    setIsBusy(true);
    try { await action(); } catch (error) { showError(error instanceof Error ? error.message : t('personalAgentUpdateFailed')); }
    finally { setIsBusy(false); }
  };
  const openGoal = (goal?: PersonalAgentGoal) => {
    setEditingGoal(goal ?? null);
    setGoalDraft(goal ? { title: goal.title, prompt: goal.prompt, schedule: goal.schedule, time: goal.time, timezone: goal.timezone, weekday: goal.weekday ?? new Date().getDay(), runAt: goal.runAt, milestones: goal.milestones } : newGoal());
    setIsGoalModalOpen(true);
  };

  return <>
    <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className={`max-w-lg text-sm ${mutedClass}`}>{t('personalAgentGoalsDescription')}</p>
            <Button size="sm" color="secondary" onPress={() => openGoal()} startContent={<Icon icon="lucide:plus" className="h-4 w-4" />}>{t('personalAgentNewGoal')}</Button>
          </div>
          {goals.length === 0 && <p className={`${panelClass} p-6 text-sm ${mutedClass}`}>{t('personalAgentNoGoals')}</p>}
          {goals.map(goal => <article key={goal.id} className={`${panelClass} p-4`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><h3 className="font-medium">{goal.title}</h3><p className={`mt-1 whitespace-pre-wrap text-sm ${mutedClass}`}>{goal.prompt}</p></div>
              <Chip size="sm" variant="flat" color={goal.enabled ? 'success' : 'default'}>{t(goal.completedAt ? 'personalAgentGoalCompleted' : goal.schedule === 'once' && goal.lastRunAt && !goal.nextRunAt ? 'personalAgentScheduledRunStarted' : goal.enabled ? 'personalAgentEnabled' : 'personalAgentPaused')}</Chip>
            </div>
            {Boolean(goal.milestones?.length) && <div className="mt-3 flex flex-col gap-2" aria-label={t('personalAgentMilestones')}>
              {goal.milestones!.map(milestone => <Checkbox key={milestone.id} size="sm" isSelected={milestone.done} isDisabled={isBusy || Boolean(goal.completedAt)} onValueChange={done => { void mutate(async () => {
                const { goal: updated } = await updatePersonalAgentGoal(clientId, goal.id, { milestones: goal.milestones!.map(item => item.id === milestone.id ? { ...item, done } : item) }, goal.updatedAt);
                onGoalsChange(goals.map(item => item.id === goal.id ? updated : item));
              }); }}>{milestone.title}</Checkbox>)}
            </div>}
            <p className={`mt-3 flex flex-wrap items-center gap-1.5 text-xs ${mutedClass}`}><Icon icon="lucide:clock" className="h-3.5 w-3.5" />{t(`personalAgentSchedule_${goal.schedule}`)}{goal.schedule === 'weekly' && <> · {new Intl.DateTimeFormat(i18n.language, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 9, 4 + goal.weekday!)))}</>}{goal.schedule === 'once' ? <> · {goal.runAt && formatRunDate(goal.runAt, i18n.language, goal.timezone)} · {goal.timezone}</> : goal.schedule !== 'manual' && <> · {goal.time} · {goal.timezone}</>}</p>
            {goal.nextRunAt && <p className={`mt-1 text-xs ${mutedClass}`}>{t('personalAgentNextRun', { date: formatRunDate(goal.nextRunAt, i18n.language, goal.timezone) })}</p>}
            {goal.lastRunAt && <p className={`mt-1 text-xs ${mutedClass}`}>{t('personalAgentLastRun', { date: formatRunDate(goal.lastRunAt, i18n.language, goal.timezone) })}</p>}
            {goal.lastRun && <p className={`mt-2 text-sm ${mutedClass}`}>{t('personalAgentRunStatus', { status: t(`personalAgentRun_${goal.lastRun.status}`) })}</p>}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" variant="flat" color="secondary" isDisabled={isBusy || !isConnected || Boolean(goal.completedAt)} onPress={() => { void mutate(async () => { const { room } = await runPersonalAgentGoal(clientId, goal.id); onRoomSelect(room); }); }} startContent={<Icon icon="lucide:play" className="h-3.5 w-3.5" />}>{t('personalAgentRunNow')}</Button>
              <Button size="sm" variant="light" isDisabled={isBusy} onPress={() => { void mutate(async () => { const { goal: updated } = await updatePersonalAgentGoal(clientId, goal.id, { enabled: !goal.enabled, ...(goal.completedAt ? { completed: false } : {}) }, goal.updatedAt); onGoalsChange(goals.map(item => item.id === goal.id ? updated : item)); }); }}>{t(goal.completedAt ? 'personalAgentReopenGoal' : goal.enabled ? 'personalAgentPause' : 'personalAgentResume')}</Button>
              {!goal.completedAt && <Button size="sm" variant="light" isDisabled={isBusy} onPress={() => { void mutate(async () => {
                const { goal: updated } = await updatePersonalAgentGoal(clientId, goal.id, { completed: true, milestones: (goal.milestones || []).map(item => ({ ...item, done: true })) }, goal.updatedAt);
                onGoalsChange(goals.map(item => item.id === goal.id ? updated : item));
              }); }}>{t('personalAgentCompleteGoal')}</Button>}
              {goal.lastRun && ['queued', 'running'].includes(goal.lastRun.status) && <Button size="sm" variant="light" color="danger" isDisabled={isBusy} onPress={() => { void mutate(async () => {
                const { goal: updated } = await cancelPersonalAgentGoal(clientId, goal.id, goal.updatedAt);
                onGoalsChange(goals.map(item => item.id === goal.id ? { ...updated, lastRun: goal.lastRun } : item));
                showSuccess(t('personalAgentCancellationRequested'));
              }); }}>{t('personalAgentCancelWork')}</Button>}
              {goal.lastRunRoomId && rooms.some(room => room.id === goal.lastRunRoomId) && <Button size="sm" variant="light" onPress={() => onRoomSelect(rooms.find(room => room.id === goal.lastRunRoomId)!)}>{t('personalAgentViewWork')}</Button>}
              <Button size="sm" variant="light" isDisabled={isBusy} onPress={() => openGoal(goal)}>{t('edit')}</Button>
              <Button size="sm" variant="light" color="danger" isDisabled={isBusy} onPress={() => { void mutate(async () => { await deletePersonalAgentGoal(clientId, goal.id, goal.updatedAt); onGoalsChange(goals.filter(item => item.id !== goal.id)); }); }}>{t('delete')}</Button>
            </div>
          </article>)}
        </section>
      <Modal isOpen={isGoalModalOpen} onOpenChange={setIsGoalModalOpen} scrollBehavior="inside">
        <ModalContent><ModalHeader>{t(editingGoal ? 'personalAgentEditGoal' : 'personalAgentNewGoal')}</ModalHeader><ModalBody className="gap-4">
          <Input autoFocus label={t('personalAgentGoalTitle')} value={goalDraft.title} maxLength={100} onValueChange={title => setGoalDraft({ ...goalDraft, title })} />
          <Textarea label={t('personalAgentGoalPrompt')} minRows={4} value={goalDraft.prompt} maxLength={16000} onValueChange={prompt => setGoalDraft({ ...goalDraft, prompt })} />
          <Textarea label={t('personalAgentMilestones')} description={t('personalAgentMilestonesHint')} minRows={2} value={(goalDraft.milestones || []).map(item => item.title).join('\n')} onValueChange={value => setGoalDraft({ ...goalDraft, milestones: value.split('\n').map((title, index) => {
            const existing = goalDraft.milestones?.[index];
            return { id: existing?.id || crypto.randomUUID(), title, done: existing?.title === title ? existing.done : false };
          }) })} />
          <Select label={t('personalAgentSchedule')} selectedKeys={[goalDraft.schedule]} onSelectionChange={keys => { const schedule = Array.from(keys)[0]; if (schedule === 'manual' || schedule === 'once' || schedule === 'daily' || schedule === 'weekly') setGoalDraft({ ...goalDraft, schedule }); }}>
            {(['manual', 'once', 'daily', 'weekly'] as const).map(schedule => <SelectItem key={schedule}>{t(`personalAgentSchedule_${schedule}`)}</SelectItem>)}
          </Select>
          {goalDraft.schedule === 'weekly' && <fieldset>
            <legend className={`mb-2 text-sm ${mutedClass}`}>{t('personalAgentWeekday')}</legend>
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: 7 }, (_, day) => <Button key={day} size="sm" variant={goalDraft.weekday === day ? 'flat' : 'light'} color={goalDraft.weekday === day ? 'secondary' : 'default'} aria-pressed={goalDraft.weekday === day} onPress={() => setGoalDraft({ ...goalDraft, weekday: day })}>
                {new Intl.DateTimeFormat(i18n.language, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 9, 4 + day)))}
              </Button>)}
            </div>
          </fieldset>}
          {goalDraft.schedule === 'once' && <Input type="datetime-local" label={t('personalAgentExecutionDate')} value={localDateTime(goalDraft.runAt)} onValueChange={value => setGoalDraft({ ...goalDraft, runAt: value ? new Date(value).toISOString() : undefined, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })} />}
          {goalDraft.schedule !== 'manual' && <>
            {goalDraft.schedule !== 'once' && <Input type="time" label={t('personalAgentScheduleTime')} value={goalDraft.time} onValueChange={time => setGoalDraft({ ...goalDraft, time })} />}<Input label={t('personalAgentTimezone')} isReadOnly={goalDraft.schedule === 'once'} value={goalDraft.schedule === 'once' ? Intl.DateTimeFormat().resolvedOptions().timeZone : goalDraft.timezone} onValueChange={timezone => setGoalDraft({ ...goalDraft, timezone })} /><p className={`text-xs ${mutedClass}`}>{t('personalAgentScheduleHint')}</p></>}
        </ModalBody><ModalFooter>
          <Button variant="light" onPress={() => setIsGoalModalOpen(false)}>{t('cancel')}</Button>
          <Button color="secondary" isLoading={isBusy} isDisabled={!goalDraft.title.trim() || !goalDraft.prompt.trim() || !goalDraft.time || !goalDraft.timezone.trim() || (goalDraft.schedule === 'once' && !goalDraft.runAt)} onPress={() => { void mutate(async () => {
            const { goal } = editingGoal ? await updatePersonalAgentGoal(clientId, editingGoal.id, { ...goalDraft, milestones: goalDraft.milestones?.filter(item => item.title.trim()) }, editingGoal.updatedAt) : await createPersonalAgentGoal(clientId, { ...goalDraft, milestones: goalDraft.milestones?.filter(item => item.title.trim()) });
            onGoalsChange(editingGoal ? goals.map(item => item.id === goal.id ? goal : item) : [goal, ...goals]);
            setIsGoalModalOpen(false);
            showSuccess(t('personalAgentGoalSaved'));
          }); }}>{t('save')}</Button>
        </ModalFooter></ModalContent>
      </Modal>
  </>;
};
