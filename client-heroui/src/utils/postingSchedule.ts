import { RoomPostingSchedule } from './types';

// 与服务端 roomAuthorization.ts 的 getLocalRoomTime/parseMinutes 保持同一套语义:
// 客户端只负责算出"下一个窗口边界还有多久",到点后向服务端重新拉取权限,
// 不在本地翻转 canPost,避免两端时区/边界实现不一致。

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const WEEKDAY_TO_NUMBER: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const MINUTES_PER_DAY = 24 * 60;
const WEEK_MINUTES = 7 * MINUTES_PER_DAY;

const parseMinutes = (value: string): number | null => {
  const match = TIME_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
};

const getLocalRoomTime = (now: Date, timezone: string) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);

  const weekday = parts.find(part => part.type === 'weekday')?.value || 'Sun';
  const hour = Number(parts.find(part => part.type === 'hour')?.value || '0');
  const minute = Number(parts.find(part => part.type === 'minute')?.value || '0');
  const second = Number(parts.find(part => part.type === 'second')?.value || '0');

  return {
    day: WEEKDAY_TO_NUMBER[weekday] ?? 0,
    minutes: hour * 60 + minute,
    seconds: second,
  };
};

// 边界落点之后再多等一秒,确保服务端按"已跨过边界"的时间求值
const BOUNDARY_BUFFER_MS = 1000;

export const getNextPostingBoundaryDelayMs = (
  schedule: RoomPostingSchedule | undefined,
  now: Date = new Date(),
): number | null => {
  if (!schedule?.enabled || !schedule.windows.length) {
    return null;
  }

  let timezone = schedule.timezone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    timezone = 'UTC';
  }

  const local = getLocalRoomTime(now, timezone);
  const nowWeekMinutes = local.day * MINUTES_PER_DAY + local.minutes;

  let bestDelta: number | null = null;
  const consider = (day: number, minutes: number) => {
    let delta = day * MINUTES_PER_DAY + minutes - nowWeekMinutes;
    if (delta <= 0) {
      delta += WEEK_MINUTES;
    }
    if (bestDelta === null || delta < bestDelta) {
      bestDelta = delta;
    }
  };

  for (const window of schedule.windows) {
    const start = parseMinutes(window.start);
    const end = parseMinutes(window.end);
    if (start === null || end === null || start === end) {
      continue;
    }

    for (const day of window.days) {
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        continue;
      }
      consider(day, start);
      // 跨午夜窗口(start > end)的结束边界落在次日
      consider(start < end ? day : (day + 1) % 7, end);
    }
  }

  if (bestDelta === null) {
    return null;
  }

  return bestDelta * 60_000 - local.seconds * 1000 + BOUNDARY_BUFFER_MS;
};
