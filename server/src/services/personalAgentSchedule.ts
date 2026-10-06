import { PersonalAgentGoal } from '../types';

type LocalDateTime = { year: number; month: number; day: number; hour: number; minute: number };

const localParts = (formatter: Intl.DateTimeFormat, date: Date): LocalDateTime => {
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute),
  };
};

const wallTime = (parts: LocalDateTime) => Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);

/** Resolve a local calendar slot without duplicating repeated DST wall times. */
export const nextPersonalAgentGoalRunAt = (
  goal: Pick<PersonalAgentGoal, 'schedule' | 'time' | 'timezone' | 'enabled' | 'weekday' | 'runAt'>,
  after: Date,
): string | undefined => {
  if (!goal.enabled || goal.schedule === 'manual') return undefined;
  if (goal.schedule === 'once') {
    const runAt = goal.runAt ? Date.parse(goal.runAt) : NaN;
    if (!Number.isFinite(runAt)) throw new RangeError('Invalid one-time execution date');
    return runAt > after.getTime() ? new Date(runAt).toISOString() : undefined;
  }
  const match = /^(\d{2}):(\d{2})$/.exec(goal.time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error('Invalid personal agent routine time');
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: goal.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const today = localParts(formatter, after);
  const weeklyDay = goal.weekday;
  if (goal.schedule === 'weekly' && (weeklyDay === undefined || !Number.isInteger(weeklyDay) || weeklyDay < 0 || weeklyDay > 6)) throw new RangeError('Invalid weekly weekday');
  const dayMs = 24 * 60 * 60 * 1000;
  for (let day = 0; day <= 14; day += 1) {
    const calendarDay = new Date(Date.UTC(today.year, today.month - 1, today.day + day));
    if (goal.schedule === 'weekly' && calendarDay.getUTCDay() !== weeklyDay) continue;
    const target: LocalDateTime = {
      year: calendarDay.getUTCFullYear(), month: calendarDay.getUTCMonth() + 1, day: calendarDay.getUTCDate(),
      hour: Number(match[1]), minute: Number(match[2]),
    };
    const targetWallTime = wallTime(target);
    // Both offsets around a DST change are candidates. A missing wall time is
    // skipped; an autumn repeated time uses only its first occurrence so a
    // daily routine does not execute twice on the same local calendar day.
    const offsets = new Set([-dayMs, 0, dayMs].map(delta => {
      const sample = new Date(targetWallTime + delta);
      return wallTime(localParts(formatter, sample)) - sample.getTime();
    }));
    const candidates = [...offsets].map(offset => targetWallTime - offset)
      .filter(candidate => wallTime(localParts(formatter, new Date(candidate))) === targetWallTime)
      .sort((left, right) => left - right);
    if (candidates.length && candidates[0] > after.getTime()) return new Date(candidates[0]).toISOString();
  }
  throw new Error('Unable to resolve personal agent routine schedule');
};
