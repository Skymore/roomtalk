import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { PersonalAgentGoal } from '../types';
import { nextPersonalAgentGoalRunAt } from './personalAgentSchedule';

const goal = (overrides: Partial<PersonalAgentGoal> = {}): PersonalAgentGoal => ({
  id: 'goal-1', clientId: 'owner', title: 'Morning report', prompt: 'Read my news',
  schedule: 'daily', time: '09:00', timezone: 'America/Los_Angeles', enabled: true,
  createdAt: '2026-10-05T12:00:00.000Z', updatedAt: '2026-10-05T12:00:00.000Z', ...overrides,
});

describe('personal agent schedule', () => {
  it('uses the selected timezone, advances after the slot, and disables manual schedules', () => {
    assert.equal(nextPersonalAgentGoalRunAt(goal(), new Date('2026-10-05T15:59:59Z')), '2026-10-05T16:00:00.000Z');
    assert.equal(nextPersonalAgentGoalRunAt(goal(), new Date('2026-10-05T16:00:00Z')), '2026-10-06T16:00:00.000Z');
    assert.equal(nextPersonalAgentGoalRunAt(goal({ timezone: 'Asia/Shanghai' }), new Date('2026-10-05T00:00:00Z')), '2026-10-05T01:00:00.000Z');
    assert.equal(nextPersonalAgentGoalRunAt(goal({ schedule: 'manual' }), new Date()), undefined);
    assert.equal(nextPersonalAgentGoalRunAt(goal({ enabled: false }), new Date()), undefined);
  });

  it('anchors weekly schedules to the local weekday on which the goal was created', () => {
    assert.equal(nextPersonalAgentGoalRunAt(goal({ schedule: 'weekly' }), new Date('2026-10-06T10:00:00Z')), '2026-10-12T16:00:00.000Z');
  });

  it('skips nonexistent spring wall times and runs only once during a repeated autumn hour', () => {
    assert.equal(nextPersonalAgentGoalRunAt(goal({ time: '02:30' }), new Date('2026-03-08T09:00:00Z')), '2026-03-09T09:30:00.000Z');
    assert.equal(nextPersonalAgentGoalRunAt(goal({ time: '01:30' }), new Date('2026-11-01T07:00:00Z')), '2026-11-01T08:30:00.000Z');
    assert.equal(nextPersonalAgentGoalRunAt(goal({ time: '01:30' }), new Date('2026-11-01T08:31:00Z')), '2026-11-02T09:30:00.000Z');
  });
});
