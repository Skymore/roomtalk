import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PersonalAgentGoalConflictError, RoomStore } from '../repositories/store';
import { PersonalAgentGoal } from '../types';
import { savePersonalAgentGoal } from './personalAgentGoals';

const now = new Date('2026-10-06T15:00:00Z');
const input = { title: 'Weekly plan', prompt: 'Review progress', schedule: 'weekly', weekday: 5, time: '09:00', timezone: 'America/Los_Angeles' };
const store = { savePersonalAgentGoal: async (goal: PersonalAgentGoal) => goal } as RoomStore;

describe('personal goal saving', () => {
  it('saves a requested weekday and preserves its next run during a content edit', async () => {
    const goal = await savePersonalAgentGoal(store, 'owner', input, undefined, now);
    assert.equal(goal.weekday, 5);
    assert.equal(goal.nextRunAt, '2026-10-09T16:00:00.000Z');
    const edited = await savePersonalAgentGoal(store, 'owner', { title: 'Changed', expectedUpdatedAt: goal.updatedAt }, goal, new Date('2026-10-10T15:00:00Z'));
    assert.equal(edited.nextRunAt, goal.nextRunAt);
    assert.equal(edited.prompt, goal.prompt);
    await assert.rejects(savePersonalAgentGoal(store, 'owner', { title: 'Stale', expectedUpdatedAt: '2026-10-01T00:00:00Z' }, edited, now), PersonalAgentGoalConflictError);
  });
  it('saves an absolute one-time date, pauses it, and rejects past dates or unknown timezones', async () => {
    const goal = await savePersonalAgentGoal(store, 'owner', { ...input, schedule: 'once', runAt: '2026-10-07T09:00:00-07:00' }, undefined, now);
    assert.equal(goal.runAt, '2026-10-07T16:00:00.000Z'); assert.equal(goal.nextRunAt, goal.runAt);
    const paused = await savePersonalAgentGoal(store, 'owner', { enabled: false }, goal, now);
    assert.equal(paused.nextRunAt, undefined);
    await assert.rejects(savePersonalAgentGoal(store, 'owner', { enabled: true }, paused, new Date('2026-10-08T00:00:00Z')), RangeError);
    for (const body of [
      { ...input, weekday: 7 }, { ...input, weekday: undefined }, { ...input, timezone: 'Mars' },
      { ...input, timezone: undefined }, { ...input, schedule: 'once', runAt: '2026-10-07T09:00:00' },
      { ...input, schedule: 'once', runAt: '2026-10-05T09:00:00Z' },
    ]) await assert.rejects(savePersonalAgentGoal(store, 'owner', body, undefined, now), RangeError);
  });
});
