import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createPostgresPool } from './postgresPool';
import { PostgresPool, PostgresStore } from './postgresStore';
import { PersonalAgentGoal, Room } from '../types';
import { getRoomActor } from '../socket/roomAuthorization';

const databaseUrl = process.env.ROOM_EVENT_TEST_DATABASE_URL;
if (databaseUrl && !/(^|[_-])(test|e2e)([_-]|$)/i.test(new URL(databaseUrl).pathname.slice(1))) {
  throw new Error('Personal agent integration tests require a dedicated test/e2e database');
}
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const owner = `personal-test-${randomUUID()}`;
const now = '2026-10-05T12:00:00.000Z';
const model = { id: 'test', apiModel: 'test', provider: 'openai' as const, label: 'Test', description: 'Test' };

describe('personal agent PostgreSQL persistence', { skip: !databaseUrl }, () => {
  let pool: PostgresPool;
  let store: PostgresStore;
  before(async () => {
    pool = createPostgresPool(databaseUrl!, logger as any);
    store = new PostgresStore(pool, logger as any);
    await store.initializeSchema();
    await store.createPasswordAccountForClient({ clientId: owner, accountId: owner, now });
  });
  after(async () => {
    if (pool) {
      await pool.query('DELETE FROM rooms WHERE personal_agent_owner_id = $1', [owner]);
      await pool.query('DELETE FROM rooms WHERE creator_id = $1', [owner]);
      await pool.query('DELETE FROM accounts WHERE id = $1', [owner]);
      await pool.end?.();
    }
  });

  it('creates one main room under concurrent initialization and captures private metadata in events', async () => {
    const [first, second] = await Promise.all([store.ensurePersonalAgentProfile(owner), store.ensurePersonalAgentProfile(owner)]);
    assert.equal(first.mainRoomId, second.mainRoomId);
    assert.equal((await store.readPersonalAgentRooms(owner)).filter(room => room.personalAgentThreadKind === 'main').length, 1);
    assert.deepEqual(await store.readRoomsByUser(owner), []);
    const events = await store.readRoomEvents(first.mainRoomId, { afterSeq: 0 });
    const room = events.events.find(event => event.type === 'room.updated')!.payload.room!;
    assert.equal(room.personalAgentOwnerId, owner);
    assert.equal(room.personalAgentThreadKind, 'main');
    const ordinaryRoom: Room = { id: randomUUID(), name: 'Ordinary room', description: '', creatorId: owner, createdAt: now };
    await store.saveRoom(ordinaryRoom);
    const ordinaryEvents = await pool.query<{ payload: { roomRow: Record<string, unknown> } }>(
      "SELECT payload FROM room_events WHERE room_id = $1 AND event_type = 'room.updated'", [ordinaryRoom.id],
    );
    assert.ok(ordinaryEvents.rows.length > 0);
    for (const event of ordinaryEvents.rows) {
      assert.equal(Object.prototype.hasOwnProperty.call(event.payload.roomRow, 'personal_agent_owner_id'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(event.payload.roomRow, 'personal_agent_thread_kind'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(event.payload.roomRow, 'personal_agent_goal_id'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(event.payload.roomRow, 'personal_agent_archived_at'), false);
    }
    const restarted = new PostgresStore(pool, logger as any);
    assert.equal((await restarted.getPersonalAgentProfile(owner))!.mainRoomId, first.mainRoomId);
  });

  it('blocks another user from joining, reading and saving the private room', async () => {
    const profile = await store.ensurePersonalAgentProfile(owner);
    assert.equal(await store.addRoomMember(profile.mainRoomId, 'other', 'member'), null);
    assert.equal(await getRoomActor(store as any, profile.mainRoomId, 'other'), null);
    assert.equal(await store.canReadRoomEvents(profile.mainRoomId, 'other'), false);
    assert.equal(await store.saveRoomForUser(profile.mainRoomId, 'other'), null);
    assert.equal(await store.transferRoomOwnership(profile.mainRoomId, 'other'), null);
  });

  it('uses compare-and-swap so concurrent personal memory updates cannot overwrite each other', async () => {
    const profile = await store.ensurePersonalAgentProfile(owner);
    const results = await Promise.all([
      store.updatePersonalAgentProfile(owner, { memory: 'First memory' }, profile.updatedAt),
      store.updatePersonalAgentProfile(owner, { memory: 'Second memory' }, profile.updatedAt),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.notEqual((await store.getPersonalAgentProfile(owner))!.updatedAt, profile.updatedAt);
  });

  it('keeps renamed and archived conversations durable without losing history, memory, or immutable events', async () => {
    const profile = await store.ensurePersonalAgentProfile(owner);
    const room = await store.createPersonalAgentThread(owner, 'Archive test');
    const note = await store.savePersonalAgentMemory({ id: randomUUID(), clientId: owner, kind: 'topic',
      title: 'Archive handoff', content: 'Keep this topic decision', source: 'Remembered in conversation',
      sourceRoomId: room.id, createdAt: now, updatedAt: now });
    await store.appendMessage({ id: randomUUID(), clientId: owner, roomId: room.id, content: 'Keep this history', timestamp: now, messageType: 'text' });
    assert.equal(await store.updatePersonalAgentThread('another-owner', room.id, { archived: true }), null);
    assert.equal(await store.updatePersonalAgentThread(owner, profile.mainRoomId, { archived: true }), null);
    const renamed = await store.updatePersonalAgentThread(owner, room.id, { name: '旅行计划' });
    assert.equal(renamed!.name, '旅行计划');
    const archived = await store.updatePersonalAgentThread(owner, room.id, { archived: true });
    assert.ok(archived!.personalAgentArchivedAt);
    const atArchive = await store.readRoomEvents(room.id, { afterSeq: 0 });
    assert.equal(atArchive.events.filter(event => event.type === 'room.updated').at(-1)!.payload.room!.personalAgentArchivedAt, archived!.personalAgentArchivedAt);
    const restarted = new PostgresStore(pool, logger as any);
    assert.equal((await restarted.readPersonalAgentRooms(owner)).find(item => item.id === room.id)!.personalAgentArchivedAt, archived!.personalAgentArchivedAt);
    // Runtime status updates must not resurrect an archived conversation.
    await store.saveRoom({ ...renamed!, codeAgentStatus: 'running' });
    assert.equal((await store.getRoomById(room.id))!.personalAgentArchivedAt, archived!.personalAgentArchivedAt);
    const restored = await restarted.updatePersonalAgentThread(owner, room.id, { archived: false });
    assert.equal(restored!.name, '旅行计划');
    assert.equal(restored!.personalAgentArchivedAt, undefined);
    assert.equal(restored!.codeAgentStatus, 'running');
    assert.equal((await restarted.readMessagesByRoom(room.id))[0].content, 'Keep this history');
    assert.equal((await restarted.getPersonalAgentProfile(owner))!.memory, profile.memory);
    assert.deepEqual((await restarted.readPersonalAgentMemories(owner, { query: 'Archive handoff' })).memories, [note]);
    await restarted.deletePersonalAgentMemory(owner, note!.id, note!.updatedAt);
    const eventsAfterRestore = await restarted.readRoomEvents(room.id, { afterSeq: 0 });
    assert.deepEqual(eventsAfterRestore.events.slice(0, atArchive.events.length), atArchive.events);
    assert.equal(eventsAfterRestore.events.filter(event => event.type === 'room.updated').at(-1)!.payload.room!.personalAgentArchivedAt, undefined);
  });

  it('shares searchable memory across conversations with owner isolation, pagination and versioned corrections', async () => {
    const profile = await store.ensurePersonalAgentProfile(owner);
    const thread = await store.createPersonalAgentThread(owner, 'Side conversation');
    assert.equal(thread.codeAgentMode, 'fullAccess');
    assert.equal((await store.getRoomById(profile.mainRoomId))!.codeAgentMode, 'fullAccess');
    const entry = await store.savePersonalAgentMemory({ id: randomUUID(), clientId: owner, kind: 'preference',
      title: '语言与计划', content: '用中文回答，预算为 100% 确认值', source: 'Remembered in conversation',
      sourceRoomId: thread.id, sourceTurnId: 'test-turn', createdAt: now, updatedAt: now });
    assert.ok(entry);
    assert.equal((await store.readPersonalAgentMemories(owner, { query: '中文' })).total, 1);
    assert.equal((await store.readPersonalAgentMemories(owner, { query: '100%' })).total, 1);
    assert.equal((await store.readPersonalAgentMemories(owner, { query: '100_' })).total, 0);
    assert.equal((await store.readPersonalAgentMemories('another-owner')).total, 0);
    assert.equal(await store.savePersonalAgentMemory({ ...entry, clientId: 'another-owner', content: 'Overwrite' }, entry.updatedAt), null);
    const concurrent = await Promise.all(['中文和英文', '中文和日文'].map(content => store.savePersonalAgentMemory({ ...entry, content }, entry.updatedAt)));
    assert.equal(concurrent.filter(Boolean).length, 1);
    assert.equal(await store.deletePersonalAgentMemory(owner, entry.id, entry.updatedAt), false);
    const current = (await new PostgresStore(pool, logger as any).readPersonalAgentMemories(owner, { limit: 1 })).memories[0];
    assert.equal(current.sourceRoomId, thread.id);
    assert.equal((await store.readPersonalAgentMemories(owner, { offset: 1 })).memories.length, 0);
    assert.equal(await store.deletePersonalAgentMemory('another-owner', current.id, current.updatedAt), false);
    assert.equal(await store.deletePersonalAgentMemory(owner, current.id, current.updatedAt), true);
    assert.equal((await store.readPersonalAgentMemories(owner)).total, 0);
  });

  it('atomically admits exactly one scheduled run with a durable prompt and survives process recreation', async () => {
    const goal: PersonalAgentGoal = {
      id: randomUUID(), clientId: owner, title: 'Daily report', prompt: 'Prepare the report',
      schedule: 'daily', time: '12:00', timezone: 'UTC', enabled: true,
      nextRunAt: now, createdAt: now, updatedAt: now,
    };
    const savedGoal = await store.savePersonalAgentGoal(goal);
    const createInput = () => {
      const room: Room = {
        id: randomUUID(), name: goal.title, description: '', creatorId: owner, createdAt: now,
        personalAgentOwnerId: owner, personalAgentThreadKind: 'task', personalAgentGoalId: goal.id,
      };
      return {
        clientId: owner, goalId: goal.id, room, expectedNextRunAt: now, nextRunAt: '2026-10-06T12:00:00.000Z',
        message: { id: randomUUID(), clientId: owner, roomId: room.id, content: goal.prompt, timestamp: now,
          messageType: 'text' as const, codeAgentQueuedInput: { state: 'queued' as const, queuedAt: now, updatedAt: now, selectedModel: model } },
      };
    };
    const results = await Promise.all([store.startPersonalAgentGoalRun(createInput()), store.startPersonalAgentGoalRun(createInput())]);
    assert.equal(results.filter(Boolean).length, 1);
    const admitted = results.find(Boolean)!;
    const restarted = new PostgresStore(pool, logger as any);
    assert.ok((await restarted.findRoomsWithQueuedCodeAgentMessages()).includes(admitted.room.id));
    const messages = await restarted.readMessagesByRoom(admitted.room.id);
    assert.equal(messages.length, 1); assert.equal(messages[0].content, goal.prompt);
    assert.equal(messages[0].codeAgentQueuedInput!.state, 'queued');
    assert.equal(messages[0].position, 0);
    const events = await restarted.readRoomEvents(admitted.room.id, { afterSeq: 0 });
    assert.ok(events.events.some(event => event.payload.messages?.[0]?.id === messages[0].id));
    assert.equal((await restarted.readPersonalAgentGoals(owner))[0].lastRunRoomId, admitted.room.id);
    assert.equal((await restarted.readDuePersonalAgentGoals(now)).some(item => item.id === goal.id), false);
    await assert.rejects(store.savePersonalAgentGoal({ ...savedGoal, prompt: 'Stale edit' }, savedGoal.updatedAt));
    assert.equal((await store.readPersonalAgentGoals(owner)).find(item => item.id === goal.id)!.nextRunAt, '2026-10-06T12:00:00.000Z');
  });

  it('rolls back task-room creation when queued prompt persistence fails', async () => {
    const goal: PersonalAgentGoal = {
      id: randomUUID(), clientId: owner, title: 'Rollback', prompt: 'Run it', schedule: 'manual',
      time: '09:00', timezone: 'UTC', enabled: true, createdAt: now, updatedAt: now,
    };
    await store.savePersonalAgentGoal(goal);
    const profile = await store.ensurePersonalAgentProfile(owner);
    const duplicateId = randomUUID();
    await store.appendMessage({ id: duplicateId, clientId: owner, roomId: profile.mainRoomId, content: 'Existing message', timestamp: now, messageType: 'text' });
    const room: Room = { id: randomUUID(), name: 'Rollback', description: '', creatorId: owner, personalAgentOwnerId: owner, createdAt: now };
    await assert.rejects(store.startPersonalAgentGoalRun({
      clientId: owner, goalId: goal.id, room,
      message: { id: duplicateId, clientId: owner, roomId: room.id, content: goal.prompt, timestamp: now,
        messageType: 'text', codeAgentQueuedInput: { state: 'queued', queuedAt: now, updatedAt: now, selectedModel: model } },
    }));
    assert.equal(await store.getRoomById(room.id), null);
    assert.equal((await store.readPersonalAgentGoals(owner)).find(item => item.id === goal.id)!.lastRunAt, undefined);
    assert.ok(await store.getRoomById(profile.mainRoomId));
  });
});
