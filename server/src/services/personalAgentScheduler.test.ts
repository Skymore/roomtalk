import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { Logger } from '../logger';
import { RoomStore } from '../repositories/store';
import { AIModelOption, CodeAgentMode, Message, PersonalAgentGoal, PersonalAgentProfile, Room } from '../types';
import { PersonalAgentScheduler } from './personalAgentScheduler';

const now = () => new Date('2026-10-05T16:00:00.000Z');
const model: AIModelOption = { id: 'gpt-5', apiModel: 'gpt-5', provider: 'openai', label: 'GPT', description: '' };
const goal = (): PersonalAgentGoal => ({
  id: 'goal-1', clientId: 'owner', title: 'Morning report', prompt: 'Read my news', schedule: 'daily',
  time: '09:00', timezone: 'America/Los_Angeles', enabled: true,
  nextRunAt: now().toISOString(), createdAt: '2026-10-05T12:00:00.000Z', updatedAt: '2026-10-05T12:00:00.000Z',
});

class ScheduleStore {
  goal = goal();
  rooms: Room[] = [];
  messages: Message[] = [];
  mainMode: CodeAgentMode = 'edit';
  profile: PersonalAgentProfile = {
    clientId: 'owner', name: 'Muse', avatar: 'M', instructions: '', memory: '', mainRoomId: 'main',
    createdAt: now().toISOString(), updatedAt: now().toISOString(),
  };
  async getPersonalAgentProfile() { return this.profile; }
  async getRoomById(): Promise<Room> {
    return { id: 'main', name: 'Muse', description: '', creatorId: 'owner', personalAgentOwnerId: 'owner',
      type: 'codeAgent', codeAgentBackend: 'codex-app-server', codeAgentMode: this.mainMode, createdAt: now().toISOString() };
  }
  async readDuePersonalAgentGoals(date: string) {
    return this.goal.enabled && this.goal.nextRunAt && this.goal.nextRunAt <= date ? [{ ...this.goal }] : [];
  }
  async startPersonalAgentGoalRun(input: {
    room: Room; message: Message; expectedNextRunAt?: string; nextRunAt?: string;
  }) {
    if (input.expectedNextRunAt && input.expectedNextRunAt !== this.goal.nextRunAt) return null;
    this.rooms.push(input.room);
    this.messages.push(input.message);
    this.goal = { ...this.goal, nextRunAt: input.nextRunAt, lastRunAt: input.message.timestamp, lastRunRoomId: input.room.id };
    return { goal: this.goal, room: input.room };
  }
}

const createScheduler = (store: ScheduleStore, resumeQueuedTurns: () => Promise<void>, prefix = 'run') => {
  let sequence = 0;
  return new PersonalAgentScheduler(store as unknown as RoomStore, { resumeQueuedTurns }, new Logger('PersonalSchedulerTest'), {
    selectedModel: model, now, createId: () => `${prefix}-${sequence++}`, serverOrigin: 'https://room.example',
  });
};

describe('personal agent scheduler', () => {
  it('queues a durable private task once when due and advances its local schedule', async () => {
    const store = new ScheduleStore();
    let wakes = 0;
    const scheduler = createScheduler(store, async () => { wakes += 1; });
    await scheduler.tick();
    await scheduler.tick();
    assert.equal(store.rooms.length, 1);
    assert.equal(store.goal.nextRunAt, '2026-10-06T16:00:00.000Z');
    assert.equal(store.rooms[0].personalAgentOwnerId, 'owner');
    assert.equal(store.rooms[0].personalAgentThreadKind, 'task');
    assert.equal(store.rooms[0].personalAgentGoalId, 'goal-1');
    assert.equal(store.messages[0].content, 'Read my news');
    assert.equal(store.messages[0].codeAgentQueuedInput?.state, 'queued');
    assert.equal(store.messages[0].codeAgentQueuedInput?.serverOrigin, 'https://room.example');
    assert.equal(wakes, 3);
  });

  it('uses the durable schedule compare-and-set to admit only one run across App instances', async () => {
    const store = new ScheduleStore();
    const first = createScheduler(store, async () => {}, 'first');
    const second = createScheduler(store, async () => {}, 'second');
    await Promise.all([first.tick(), second.tick()]);
    assert.equal(store.rooms.length, 1);
    assert.equal(store.messages.length, 1);
  });

  it('persists the main room mode in both queued execution and Codex permission settings', async () => {
    const store = new ScheduleStore();
    store.mainMode = 'plan';
    await createScheduler(store, async () => {}).tick();
    assert.equal(store.rooms[0].codeAgentMode, 'plan');
    assert.equal(store.messages[0].codeAgentQueuedInput?.requestedMode, 'plan');
    assert.equal(store.messages[0].codeAgentQueuedInput?.codexPermissionMode, 'plan');
  });

  it('keeps the admitted prompt when wake fails and resumes it after restarting without creating another task', async () => {
    const store = new ScheduleStore();
    const scheduler = createScheduler(store, async () => { throw new Error('App stopped after queue commit'); });
    const result = await scheduler.startGoal(store.goal);
    assert.equal(result.room.id, store.rooms[0].id);
    assert.equal(store.messages[0].codeAgentQueuedInput?.state, 'queued');
    let resumed = false;
    const restarted = createScheduler(store, async () => { resumed = true; }, 'restarted');
    await restarted.tick();
    assert.equal(resumed, true);
    assert.equal(store.rooms.length, 1);
  });

  it('allows manually running a paused routine and does not reactivate its schedule', async () => {
    const store = new ScheduleStore();
    store.goal.enabled = false;
    const scheduler = createScheduler(store, async () => {});
    await scheduler.startGoal(store.goal);
    assert.equal(store.rooms.length, 1);
    assert.equal(store.goal.nextRunAt, undefined);
  });
});
