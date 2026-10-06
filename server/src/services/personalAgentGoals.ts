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
  const enabled = body.enabled ?? existing?.enabled ?? true;
  if (typeof enabled !== 'boolean') throw new RangeError('Invalid enabled value');
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
  const goal: PersonalAgentGoal = {
    ...existing, id: existing?.id || randomUUID(), clientId,
    title: text(body.title ?? existing?.title, 'title', 100),
    prompt: text(body.prompt ?? existing?.prompt, 'prompt', 16000),
    schedule: schedule as PersonalAgentGoal['schedule'], time, timezone, enabled, weekday: weekday as number | undefined, runAt,
    createdAt: existing?.createdAt || now.toISOString(), updatedAt: now.toISOString(),
  };
  const changed = !existing || existing.schedule !== schedule || existing.time !== time || existing.timezone !== timezone
    || existing.enabled !== enabled || existing.weekday !== weekday || existing.runAt !== runAt;
  if (changed) {
    if (enabled && schedule === 'once' && Date.parse(runAt!) <= now.getTime()) throw new RangeError('Choose a future execution date');
    goal.nextRunAt = nextPersonalAgentGoalRunAt(goal, now);
  }
  return store.savePersonalAgentGoal!(goal, existing?.updatedAt);
};
