import { describe, expect, it } from 'vitest';
import { getNextPostingBoundaryDelayMs } from './postingSchedule';
import { RoomPostingSchedule } from './types';

const schedule = (overrides: Partial<RoomPostingSchedule> = {}): RoomPostingSchedule => ({
  enabled: true,
  timezone: 'UTC',
  windows: [{ days: [1], start: '09:00', end: '17:00' }],
  ...overrides,
});

// 2026-06-08 is a Monday (day=1)
const mondayUtc = (time: string) => new Date(`2026-06-08T${time}Z`);

describe('getNextPostingBoundaryDelayMs', () => {
  it('returns null when the schedule is disabled or empty', () => {
    expect(getNextPostingBoundaryDelayMs(undefined)).toBeNull();
    expect(getNextPostingBoundaryDelayMs(schedule({ enabled: false }))).toBeNull();
    expect(getNextPostingBoundaryDelayMs(schedule({ windows: [] }))).toBeNull();
    expect(getNextPostingBoundaryDelayMs(schedule({
      windows: [{ days: [1], start: '09:00', end: '09:00' }],
    }))).toBeNull();
  });

  it('targets the window opening when now is before the window', () => {
    const delay = getNextPostingBoundaryDelayMs(schedule(), mondayUtc('08:00:00'));
    expect(delay).toBe(60 * 60_000 + 1000);
  });

  it('targets the window closing when now is inside the window', () => {
    const delay = getNextPostingBoundaryDelayMs(schedule(), mondayUtc('16:30:00'));
    expect(delay).toBe(30 * 60_000 + 1000);
  });

  it('wraps to next week when all boundaries for the day have passed', () => {
    const delay = getNextPostingBoundaryDelayMs(schedule(), mondayUtc('18:00:00'));
    // 下一个边界是下周一 09:00
    expect(delay).toBe((6 * 24 * 60 + 15 * 60) * 60_000 + 1000);
  });

  it('subtracts elapsed seconds within the current minute', () => {
    const delay = getNextPostingBoundaryDelayMs(schedule(), mondayUtc('08:59:30'));
    expect(delay).toBe(60_000 - 30_000 + 1000);
  });

  it('puts the closing boundary of an overnight window on the next day', () => {
    const overnight = schedule({ windows: [{ days: [1], start: '22:00', end: '02:00' }] });
    // 周一 23:00,窗口开放中,下一个边界是周二 02:00
    const delay = getNextPostingBoundaryDelayMs(overnight, mondayUtc('23:00:00'));
    expect(delay).toBe(3 * 60 * 60_000 + 1000);
  });

  it('evaluates boundaries in the room timezone', () => {
    // 12:00 UTC = 08:00 America/New_York(2026-06 为 EDT,UTC-4),
    // 房间时区 09:00 开门 → 还差 1 小时
    const eastern = schedule({ timezone: 'America/New_York' });
    const delay = getNextPostingBoundaryDelayMs(eastern, mondayUtc('12:00:00'));
    expect(delay).toBe(60 * 60_000 + 1000);
  });

  it('falls back to UTC for an invalid timezone', () => {
    const broken = schedule({ timezone: 'Not/AZone' });
    const delay = getNextPostingBoundaryDelayMs(broken, mondayUtc('08:00:00'));
    expect(delay).toBe(60 * 60_000 + 1000);
  });
});
