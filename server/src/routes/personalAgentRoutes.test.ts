import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { AddressInfo } from 'node:net';
import express from 'express';
import { registerPersonalAgentRoutes } from './personalAgentRoutes';
import { getRoomActor, authorizeRoomAction } from '../socket/roomAuthorization';
import { PersonalAgentGoal, PersonalAgentProfile, Room } from '../types';

const now = '2026-10-05T12:00:00.000Z';
const privateRoom: Room = {
  id: 'private-main', name: 'My Agent', description: '', creatorId: 'owner', createdAt: now,
  type: 'codeAgent', codeAgentBackend: 'codex-app-server', codeAgentAccess: 'owner',
  personalAgentOwnerId: 'owner', personalAgentThreadKind: 'main',
};
const profile: PersonalAgentProfile = {
  clientId: 'owner', name: 'My Agent', avatar: '✦', instructions: '', memory: '',
  mainRoomId: privateRoom.id, createdAt: now, updatedAt: now,
};
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closes.splice(0).map(close => close())); });

async function startServer() {
  const profiles = new Map([['owner', { ...profile }], ['other', { ...profile, clientId: 'other', mainRoomId: 'other-main' }]]);
  const goals = new Map<string, PersonalAgentGoal>();
  const store = {
    getAccountByClientId: async (clientId: string) => clientId === 'guest' ? null : { primaryClientId: clientId },
    ensurePersonalAgentProfile: async (clientId: string) => profiles.get(clientId),
    readPersonalAgentRooms: async (clientId: string) => clientId === 'owner' ? [privateRoom] : [],
    readPersonalAgentGoals: async (clientId: string) => [...goals.values()].filter(goal => goal.clientId === clientId),
    updatePersonalAgentProfile: async (clientId: string, updates: Partial<PersonalAgentProfile>) => {
      const updated = { ...profiles.get(clientId)!, ...updates };
      profiles.set(clientId, updated); return updated;
    },
    savePersonalAgentGoal: async (goal: PersonalAgentGoal) => { goals.set(goal.id, goal); return goal; },
    deletePersonalAgentGoal: async (clientId: string, id: string) => goals.get(id)?.clientId === clientId && goals.delete(id),
    createPersonalAgentThread: async (clientId: string, name: string) => ({ ...privateRoom, id: 'task', name, creatorId: clientId, personalAgentOwnerId: clientId, personalAgentThreadKind: 'task' }),
  };
  const app = express(); app.use(express.json());
  registerPersonalAgentRoutes(app, {
    store: store as any, logger: { error() {} } as any,
    getClientId: req => String(req.query.clientId || req.body?.clientId || ''),
    authorizeClientRequest: async (req, res, clientId) => {
      if (req.header('x-client-auth-token') === `${clientId}-token`) return true;
      res.status(401).json({ error: 'Invalid token' }); return false;
    },
    startGoal: async () => ({ room: { ...privateRoom, id: 'goal-task', personalAgentThreadKind: 'task' } }),
  });
  const server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  closes.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, clientId = 'owner', method = 'GET', body?: unknown) => fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-client-auth-token': `${clientId}-token` },
    ...(body ? { body: JSON.stringify({ ...(body as object), clientId }) } : {}),
  });
  return { request, base, goals, profiles };
}

describe('personal agent API', () => {
  it('requires a signed-in account and rejects impersonation', async () => {
    const { base, request } = await startServer();
    assert.equal((await fetch(`${base}/api/personal-agent?clientId=owner`)).status, 401);
    assert.equal((await request('/api/personal-agent?clientId=owner', 'other')).status, 401);
    assert.equal((await request('/api/personal-agent?clientId=guest', 'guest')).status, 401);
    const response = await request('/api/personal-agent?clientId=owner');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).profile.mainRoomId, privateRoom.id);
  });

  it('persists profile and routine edits, while another user cannot edit or run the goal', async () => {
    const { request } = await startServer();
    const edit = await request('/api/personal-agent/profile', 'owner', 'PUT', { name: 'Atlas', memory: 'Prefer Chinese' });
    assert.equal((await edit.json()).profile.memory, 'Prefer Chinese');
    const create = await request('/api/personal-agent/goals', 'owner', 'POST', { title: 'Morning', prompt: 'Read the news', schedule: 'daily', time: '09:00', timezone: 'America/Los_Angeles' });
    const goal = (await create.json()).goal;
    assert.equal(create.status, 201); assert.ok(goal.nextRunAt);
    assert.equal((await request(`/api/personal-agent/goals/${goal.id}`, 'other', 'PATCH', { title: 'Stolen' })).status, 404);
    assert.equal((await request(`/api/personal-agent/goals/${goal.id}/run`, 'other', 'POST', {})).status, 404);
    const pause = await request(`/api/personal-agent/goals/${goal.id}`, 'owner', 'PATCH', { enabled: false });
    assert.equal((await pause.json()).goal.nextRunAt, undefined);
    assert.equal((await request(`/api/personal-agent/goals/${goal.id}/run`, 'owner', 'POST', {})).status, 202);
    assert.equal((await request(`/api/personal-agent/goals/${goal.id}`, 'owner', 'DELETE', {})).status, 200);
  });

  it('rejects invalid times and oversized memory before saving', async () => {
    const { request, profiles } = await startServer();
    assert.equal((await request('/api/personal-agent/goals', 'owner', 'POST', { title: 'Bad', prompt: 'Run', time: '25:00' })).status, 400);
    assert.equal((await request('/api/personal-agent/profile', 'owner', 'PUT', { memory: 'x'.repeat(16001) })).status, 400);
    assert.equal(profiles.get('owner')!.memory, '');
  });
});

describe('personal room access', () => {
  it('denies reads and subscriptions even when a second user has an old membership row', async () => {
    const store = { getRoomById: async () => privateRoom, getRoomMember: async () => ({ roomId: privateRoom.id, clientId: 'other', role: 'admin' }) };
    assert.equal(await getRoomActor(store as any, privateRoom.id, 'other'), null);
  });

  it('prevents the owner from transferring or inviting administrators', async () => {
    const store = { getRoomById: async () => privateRoom, getRoomMember: async () => ({ roomId: privateRoom.id, clientId: 'owner', role: 'owner' }) };
    for (const action of [{ type: 'room.transferOwnership', targetClientId: 'other' }, { type: 'room.manageAdmins' }, { type: 'room.manageMembers' }] as const) {
      assert.equal((await authorizeRoomAction({ store: store as any, roomId: privateRoom.id, clientId: 'owner', action })).ok, false);
    }
  });
});
