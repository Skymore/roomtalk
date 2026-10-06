import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import express from 'express';
import { Logger } from '../logger';
import { PersonalAgentGoalConflictError, RoomStore } from '../repositories/store';
import { PersonalAgentGoal } from '../types';
import { CodeAgentRoomContextService } from '../services/codeAgentRoomContext';
import { registerPersonalAgentGoalContextRoutes } from './personalAgentGoalContextRoutes';

describe('personal goal conversation broker', () => {
  let server: Server, url: string, context: CodeAgentRoomContextService;
  let active: boolean, owner: string | undefined, currentGoal: string | undefined;
  let goals: PersonalAgentGoal[], queued: boolean, running: boolean, starts: number, stops: number;
  beforeEach(async () => {
    active = true; owner = 'owner'; currentGoal = undefined;
    goals = []; queued = false; running = false; starts = 0; stops = 0;
    const store = {
      getRoomById: async () => ({ id: 'chat', type: 'codeAgent', creatorId: 'owner', personalAgentOwnerId: owner, personalAgentGoalId: currentGoal }),
      hasActiveCodeAgentRoomLease: async (room: string, _now: string, turn?: string) => room === 'chat' ? active && turn === 'turn' : running,
      readPersonalAgentGoals: async (clientId: string) => goals.filter(goal => goal.clientId === clientId),
      readPersonalAgentRooms: async () => [{ id: 'work', personalAgentGoalId: goals[0]?.id }],
      readMessagesByRoom: async () => queued ? [{ id: 'input', codeAgentQueuedInput: { state: 'queued' } }] : [],
      savePersonalAgentGoal: async (goal: PersonalAgentGoal, expected?: string) => {
        const existing = goals.find(item => item.id === goal.id);
        if (expected && expected !== existing?.updatedAt) throw new PersonalAgentGoalConflictError('Goal changed');
        const saved = { ...goal, updatedAt: new Date(Date.parse(existing?.updatedAt || goal.updatedAt) + 1).toISOString() };
        goals = [...goals.filter(item => item.id !== goal.id), saved]; return saved;
      },
      deletePersonalAgentGoal: async (_client: string, id: string, expected: string) => {
        if (goals.find(item => item.id === id)?.updatedAt !== expected) return false;
        goals = goals.filter(item => item.id !== id); return true;
      },
    } as unknown as RoomStore;
    context = new CodeAgentRoomContextService(store, { tokenSecret: 'goal-test-secret' });
    const app = express(); app.use(express.json());
    registerPersonalAgentGoalContextRoutes(app, { store, roomContext: context, logger: new Logger('GoalContextTest'), execution: {
      startGoal: async () => { starts++; return { roomId: 'work' }; },
      interruptTurn: async () => { stops++; running = false; return { success: true }; },
      cancelQueuedTurn: async () => { stops++; queued = false; return { success: true }; },
    } });
    server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/code-agent/room-context/personal-goals`;
  });
  afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  const request = (body?: unknown, mode: 'plan' | 'edit' = 'edit') => fetch(url, {
    method: body ? 'PATCH' : 'GET', headers: { 'content-type': 'application/json',
      authorization: `Bearer ${context.issueTurnToken({ roomId: 'chat', clientId: 'owner', turnId: 'turn', mode })}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const create = async () => {
    const result = await request({ action: 'create', title: 'Trip', prompt: 'Plan a trip', milestones: ['Confirm dates', 'Prepare plan'], clientId: 'forged' });
    assert.equal(result.status, 200); return (await result.json()).goal as PersonalAgentGoal;
  };
  it('persists owner goals and milestones, returns their status, and rejects stale changes', async () => {
    assert.equal((await fetch(url)).status, 401);
    const goal = await create(); assert.equal(goal.clientId, 'owner'); assert.equal(goal.milestones!.length, 2);
    assert.equal((await (await request()).json()).goals.length, 1);
    const update = { action: 'update', id: goal.id, expectedUpdatedAt: goal.updatedAt, title: 'Changed' };
    assert.equal((await request(update)).status, 200);
    assert.equal((await request(update)).status, 409);
    assert.equal((await request({ action: 'update', id: goal.id, title: 'No revision' })).status, 400);
    assert.equal((await request({ action: 'run', id: 'foreign' })).status, 404);
    assert.equal((await request({ action: 'run', id: goal.id })).status, 200); assert.equal(starts, 1);
  });
  it('pauses and resumes future work, cancels real queue and runner work, and deletes with a revision', async () => {
    let goal = await create();
    goal = (await (await request({ action: 'pause', id: goal.id, expectedUpdatedAt: goal.updatedAt })).json()).goal;
    assert.equal(goal.enabled, false);
    goal = (await (await request({ action: 'resume', id: goal.id, expectedUpdatedAt: goal.updatedAt })).json()).goal;
    assert.equal(goal.enabled, true);
    queued = true; running = true;
    const cancel = await request({ action: 'cancel', id: goal.id, expectedUpdatedAt: goal.updatedAt });
    assert.equal(cancel.status, 200); const result = await cancel.json(); goal = result.goal;
    assert.equal(result.cancellationRequested, true); assert.equal(stops, 2); assert.equal(goal.enabled, false);
    assert.equal((await request({ action: 'delete', id: goal.id, expectedUpdatedAt: goal.updatedAt })).status, 200);
    assert.equal(goals.length, 0);
  });
  it('rejects ordinary rooms, ended turns, readonly mutations and recursively running or cancelling itself', async () => {
    assert.equal((await request({ action: 'create', title: 'No', prompt: 'No' }, 'plan')).status, 403);
    active = false; assert.equal((await request()).status, 403); active = true;
    owner = undefined; assert.equal((await request()).status, 403); owner = 'owner';
    const goal = await create(); currentGoal = goal.id;
    assert.equal((await request({ action: 'run', id: goal.id })).status, 400);
    assert.equal((await request({ action: 'cancel', id: goal.id, expectedUpdatedAt: goal.updatedAt })).status, 400);
    assert.equal(starts, 0); assert.equal(stops, 0);
  });
});
