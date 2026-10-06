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

/** Weekly routines use the weekday on which the goal was created in its timezone. */
export const nextPersonalAgentGoalRunAt = (
  goal: Pick<PersonalAgentGoal, 'schedule' | 'time' | 'timezone' | 'createdAt' | 'enabled'>,
  after: Date,
): string | undefined => {
  if (!goal.enabled || goal.schedule === 'manual') return undefined;
  const match = /^(\d{2}):(\d{2})$/.exec(goal.time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error('Invalid personal agent routine time');
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: goal.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const today = localParts(formatter, after);
  const created = localParts(formatter, new Date(goal.createdAt));
  const weeklyDay = new Date(Date.UTC(created.year, created.month - 1, created.day)).getUTCDay();
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
