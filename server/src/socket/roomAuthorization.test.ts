import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { canUseCocoRoom, getPostingAvailability } from './roomAuthorization';
import { Room, RoomPostingSchedule } from '../types';

// 对拍向量:与 client-heroui/src/utils/postingSchedule.test.ts 使用同一组场景
// (同一时刻、同一窗口)。客户端断言"距下一边界的时长",服务端断言"此刻是否开放",
// 两侧互相印证。任何一侧修改窗口/时区语义,必须同步另一侧的向量。

const room = (postingSchedule?: RoomPostingSchedule): Room => ({
  id: 'room-1',
  name: 'Room 1',
  description: '',
  createdAt: '2026-05-03T00:00:00.000Z',
  creatorId: 'client-1',
  ...(postingSchedule ? { postingSchedule } : {}),
});

const schedule = (overrides: Partial<RoomPostingSchedule> = {}): RoomPostingSchedule => ({
  enabled: true,
  timezone: 'UTC',
  windows: [{ days: [1], start: '09:00', end: '17:00' }],
  ...overrides,
});

// 2026-06-08 is a Monday (day=1)
const mondayUtc = (time: string) => new Date(`2026-06-08T${time}Z`);

describe('getPostingAvailability', () => {
  it('allows posting when no schedule is configured or it is disabled', () => {
    assert.deepEqual(getPostingAvailability(room()), { allowed: true });
    assert.deepEqual(getPostingAvailability(room(schedule({ enabled: false }))), { allowed: true });
  });

  it('blocks posting when the schedule is enabled with no windows', () => {
    const result = getPostingAvailability(room(schedule({ windows: [] })), mondayUtc('12:00:00'));
    assert.deepEqual(result, { allowed: false, reason: 'Posting closed' });
  });

  it('treats the window start as inclusive and the end as exclusive', () => {
    const target = room(schedule());
    // 客户端向量:08:00 时距开门 1h
    assert.equal(getPostingAvailability(target, mondayUtc('08:00:00')).allowed, false);
    assert.equal(getPostingAvailability(target, mondayUtc('09:00:00')).allowed, true);
    // 客户端向量:16:30 时距关门 30min
    assert.equal(getPostingAvailability(target, mondayUtc('16:30:00')).allowed, true);
    assert.equal(getPostingAvailability(target, mondayUtc('17:00:00')).allowed, false);
    assert.equal(getPostingAvailability(target, mondayUtc('18:00:00')).allowed, false);
  });

  it('keeps an overnight window open across midnight into the next day', () => {
    const target = room(schedule({ windows: [{ days: [1], start: '22:00', end: '02:00' }] }));
    // 客户端向量:周一 23:00 时距关门 3h(周二 02:00)
    assert.equal(getPostingAvailability(target, mondayUtc('23:00:00')).allowed, true);
    assert.equal(getPostingAvailability(target, new Date('2026-06-09T01:30:00Z')).allowed, true);
    assert.equal(getPostingAvailability(target, new Date('2026-06-09T02:00:00Z')).allowed, false);
    // 周一窗口未开启前
    assert.equal(getPostingAvailability(target, mondayUtc('21:00:00')).allowed, false);
  });

  it('evaluates windows in the room timezone', () => {
    const target = room(schedule({ timezone: 'America/New_York' }));
    // 客户端向量:12:00 UTC = 08:00 EDT,距开门 1h
    assert.equal(getPostingAvailability(target, mondayUtc('12:00:00')).allowed, false);
    assert.equal(getPostingAvailability(target, mondayUtc('13:00:00')).allowed, true);
  });
});

describe('canUseCocoRoom', () => {
  const cocoRoom = (overrides: Partial<Room> = {}): Room => ({
    ...room(),
    type: 'coco',
    ...overrides,
  });

  it('defaults Coco access to owner only', () => {
    const target = cocoRoom();

    assert.equal(canUseCocoRoom(target, 'client-1', 'owner'), true);
    assert.equal(canUseCocoRoom(target, 'client-2', 'member'), false);
  });

  it('allows administrators only when Coco access is admin', () => {
    const target = cocoRoom({ cocoAccess: 'admin' });

    assert.equal(canUseCocoRoom(target, 'client-2', 'admin'), true);
    assert.equal(canUseCocoRoom(target, 'client-3', 'member'), false);
  });

  it('allows all room members when Coco access is member', () => {
    const target = cocoRoom({ cocoAccess: 'member' });

    assert.equal(canUseCocoRoom(target, 'client-2', 'member'), true);
  });

  it('rejects non-Coco rooms', () => {
    assert.equal(canUseCocoRoom(room(), 'client-1', 'owner'), false);
  });
});
