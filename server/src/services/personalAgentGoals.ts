import { randomUUID } from 'node:crypto';
import { PersonalAgentGoalConflictError, RoomStore } from '../repositories/store';
import { PersonalAgentGoal } from '../types';
import { nextPersonalAgentGoalRunAt } from './personalAgentSchedule';

const text = (value: unknown, name: string, limit: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new RangeError(`Invalid ${name}`);
  return value.trim();
};

/** The form and conversation tools share the same schedule and revision rules. */
export const savePersonalAgentGoal = async (
  store: RoomStore, clientId: string, body: Record<string, unknown>, existing?: PersonalAgentGoal,
  now = new Date(),
): Promise<PersonalAgentGoal> => {
  const schedule = body.schedule ?? existing?.schedule ?? 'manual';
  if (!['manual', 'once', 'daily', 'weekly'].includes(String(schedule))) throw new RangeError('Invalid schedule');
  const time = body.time ?? existing?.time ?? '09:00';
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new RangeError('Invalid time');
  const timezone = text(body.timezone ?? existing?.timezone ?? (schedule === 'manual' ? 'UTC' : undefined), 'timezone', 100);
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { throw new RangeError('Invalid timezone'); }
  const completed = body.completed ?? Boolean(existing?.completedAt);
  if (typeof completed !== 'boolean') throw new RangeError('Invalid completed value');
  const enabled = completed ? false : body.enabled ?? existing?.enabled ?? true;
  if (typeof enabled !== 'boolean') throw new RangeError('Invalid enabled value');
  let milestones = existing?.milestones || [];
  if (body.milestones !== undefined) {
    if (!Array.isArray(body.milestones) || (!existing && body.milestones.length > 20)) throw new RangeError('Provide at most 20 milestones');
    milestones = body.milestones.map(value => {
      const item = typeof value === 'string' ? { title: value } : value;
      if (!item || typeof item !== 'object' || (item.done !== undefined && typeof item.done !== 'boolean')) throw new RangeError('Invalid milestone');
      return { id: item.id === undefined ? randomUUID() : text(item.id, 'milestone id', 100),
        title: text(item.title, 'milestone title', 200), done: item.done ?? false };
    });
    if (new Set(milestones.map(item => item.id)).size !== milestones.length) throw new RangeError('Milestone IDs must be distinct');
  }
  const weekday = schedule === 'weekly' ? body.weekday ?? existing?.weekday : undefined;
  if (schedule === 'weekly' && (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 0 || weekday > 6)) {
    throw new RangeError('Select a weekday from 0 (Sunday) to 6 (Saturday)');
  }
  let runAt: string | undefined;
  if (schedule === 'once') {
    const value = body.runAt ?? existing?.runAt;
    if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
      throw new RangeError('Provide a one-time execution date with a timezone offset');
    }
    runAt = new Date(value).toISOString();
  }
  const expected = body.expectedUpdatedAt;
  if (expected !== undefined && (typeof expected !== 'string' || !Number.isFinite(Date.parse(expected)))) throw new RangeError('Invalid expectedUpdatedAt');
  if (existing && expected !== undefined && expected !== existing.updatedAt) {
    throw new PersonalAgentGoalConflictError('This goal changed. Read it again before saving.');
  }
  const description = body.prompt ?? existing?.prompt ?? '';
  if (typeof description !== 'string' || description.length > (body.prompt===undefined && existing ? 16000 : 4000)) throw new RangeError('Invalid description');
  const goal: PersonalAgentGoal = {
    ...existing, id: existing?.id || randomUUID(), clientId,
    title: text(body.title ?? existing?.title, 'title', 160),
    prompt: description.trim(),
    category: text(body.category ?? existing?.category ?? 'Personal', 'category', 80),
    schedule: schedule as PersonalAgentGoal['schedule'], time, timezone, enabled, weekday: weekday as number | undefined, runAt,
    milestones, completedAt: completed ? existing?.completedAt || now.toISOString() : undefined,
    createdAt: existing?.createdAt || now.toISOString(), updatedAt: now.toISOString(),
  };
  const changed = !existing || existing.schedule !== schedule || existing.time !== time || existing.timezone !== timezone
    || existing.enabled !== enabled || existing.weekday !== weekday || existing.runAt !== runAt;
  if (changed) {
    if (enabled && schedule === 'once' && Date.parse(runAt!) <= now.getTime()) throw new RangeError('Choose a future execution date');
    goal.nextRunAt = nextPersonalAgentGoalRunAt(goal, now);
  }
  const saved = await store.savePersonalAgentGoal!(goal, existing?.updatedAt);
  return { ...saved, ...(existing?.lastRun ? { lastRun: existing.lastRun } : {}) };
};

export type PersonalAgentGoalExecution = {
  startGoal: (goal: PersonalAgentGoal) => Promise<{ room: import('../types').Room } | { roomId: string }>;
  interruptTurn: (roomId: string, clientId: string, reason?: string) => Promise<{ success: boolean; error?: string }>;
  cancelQueuedTurn: (roomId: string, clientId: string, messageId: string) => Promise<{ success: boolean; error?: string }>;
};

/** Disable future occurrences, then request cancellation through the real queue/runner controls. */
export const cancelPersonalAgentGoal = async (
  store: RoomStore, goal: PersonalAgentGoal, execution: Pick<PersonalAgentGoalExecution, 'interruptTurn' | 'cancelQueuedTurn'>,
  expectedUpdatedAt?: unknown,
): Promise<PersonalAgentGoal> => {
  const paused = await savePersonalAgentGoal(store, goal.clientId, { enabled: false, expectedUpdatedAt }, goal);
  const rooms = (await store.readPersonalAgentRooms!(goal.clientId)).filter(room => room.personalAgentGoalId === goal.id);
  for (const room of rooms) {
    const messages = await store.readMessagesByRoom(room.id);
    for (const message of messages.filter(item => item.codeAgentQueuedInput?.state === 'queued')) {
      const ack = await execution.cancelQueuedTurn(room.id, goal.clientId, message.id);
      if (!ack.success) throw new PersonalAgentGoalConflictError(ack.error || 'Task changed while cancelling; check its current state');
    }
    if (await store.hasActiveCodeAgentRoomLease!(room.id, new Date().toISOString())) {
      const ack = await execution.interruptTurn(room.id, goal.clientId, 'Cancelled from your personal agent');
      if (!ack.success) throw new PersonalAgentGoalConflictError(ack.error || 'Cancellation was not accepted; check its current state');
    } else if ((await store.readMessagesByRoom(room.id)).some(message => message.codeAgentQueuedInput?.state === 'starting')) {
      throw new PersonalAgentGoalConflictError('The task is starting. Its schedule is paused; check status and cancel again.');
    }
  }
  return paused;
};
