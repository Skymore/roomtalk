import assert from 'assert/strict';
import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Logger } from '../logger';
import { RoomStore } from '../repositories/store';
import { PersonalAgentMemory, PersonalAgentProfile } from '../types';
import { CodeAgentRoomContextService } from '../services/codeAgentRoomContext';
import { registerPersonalAgentContextRoutes } from './personalAgentContextRoutes';

describe('personal agent memory broker', () => {
  let server: Server;
  let url: string;
  let context: CodeAgentRoomContextService;
  let active: boolean;
  let personalOwner: string | undefined;
  let profile: PersonalAgentProfile;
  let memories: PersonalAgentMemory[];
  beforeEach(async () => {
    active = true;
    memories = [];
    personalOwner = 'owner';
    profile = { clientId: 'owner', name: 'Muse', avatar: 'M', instructions: '', memory: 'Seattle', mainRoomId: 'room',
      createdAt: '2026-10-05T12:00:00.000Z', updatedAt: '2026-10-05T12:00:00.000Z' };
    const store = {
      async getRoomById() { return { id: 'room', name: 'Muse', description: '', createdAt: profile.createdAt,
        creatorId: 'owner', type: 'codeAgent', personalAgentOwnerId: personalOwner }; },
      async hasActiveCodeAgentRoomLease(_room: string, _now: string, turn: string) { return active && turn === 'turn'; },
      async getPersonalAgentProfile() { return profile; },
      async readPersonalAgentMemories() { return { memories, total: memories.length }; },
      async savePersonalAgentMemory(entry: PersonalAgentMemory, expected?: string) {
        const existing = memories.find(item => item.id === entry.id);
        if (expected && existing?.updatedAt !== expected) return null;
        const saved = { ...entry, updatedAt: expected ? '2026-10-06T02:00:00.000Z' : entry.updatedAt };
        memories = [...memories.filter(item => item.id !== entry.id), saved]; return saved;
      },
      async deletePersonalAgentMemory(_owner: string, id: string, expected: string) {
        const existing = memories.find(item => item.id === id);
        if (existing?.updatedAt !== expected) return false;
        memories = memories.filter(item => item.id !== id); return true;
      },
      async updatePersonalAgentProfile(_owner: string, update: { memory: string }, expected: string) {
        if (expected !== profile.updatedAt) return null;
        profile = { ...profile, ...update, updatedAt: '2026-10-05T12:01:00.000Z' };
        return profile;
      },
    } as unknown as RoomStore;
    context = new CodeAgentRoomContextService(store, { tokenSecret: 'test-secret' });
    const app = express();
    app.use(express.json());
    registerPersonalAgentContextRoutes(app, { store, roomContext: context, logger: new Logger('PersonalMemoryTest') });
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/code-agent/room-context/personal-memory`;
  });
  afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const tokenHeaders = (mode: 'plan' | 'edit' = 'edit') => ({
    authorization: `Bearer ${context.issueTurnToken({ roomId: 'room', clientId: 'owner', turnId: 'turn', mode })}`,
    'content-type': 'application/json',
  });

  it('reads and updates owner memory with an active turn token and refuses stale writes', async () => {
    const headers = tokenHeaders();
    assert.equal((await fetch(url)).status, 401);
    const current = await (await fetch(url, { headers })).json() as { memory: string; updatedAt: string };
    assert.equal(current.memory, 'Seattle');
    const body = JSON.stringify({ memory: 'Vancouver', expectedUpdatedAt: current.updatedAt });
    assert.equal((await fetch(url, { method: 'PATCH', headers, body })).status, 200);
    assert.equal(profile.memory, 'Vancouver');
    assert.equal((await fetch(url, { method: 'PATCH', headers, body })).status, 409);
    assert.equal(profile.memory, 'Vancouver');
  });

  it('rejects read-only mutation, ended turns and ordinary rooms', async () => {
    const body = JSON.stringify({ memory: 'Vancouver', expectedUpdatedAt: profile.updatedAt });
    assert.equal((await fetch(url, { method: 'PATCH', headers: tokenHeaders('plan'), body })).status, 403);
    active = false;
    assert.equal((await fetch(url, { headers: tokenHeaders() })).status, 403);
    active = true;
    personalOwner = undefined;
    assert.equal((await fetch(url, { headers: tokenHeaders() })).status, 403);
    assert.equal(profile.memory, 'Seattle');
  });
  it('records conversation provenance, refuses stale corrections and forgets only during an active writable turn', async () => {
    const path = `${url}/records`;
    const headers = tokenHeaders();
    const body = { action: 'save', kind: 'topic', title: '旅行安排', content: '已确认周五出发' };
    const createdResponse = await fetch(path, { method: 'PATCH', headers, body: JSON.stringify(body) });
    assert.equal(createdResponse.status, 200);
    const created = (await createdResponse.json() as { memory: PersonalAgentMemory }).memory;
    assert.equal(created.clientId, 'owner'); assert.equal(created.sourceRoomId, 'room'); assert.equal(created.sourceTurnId, 'turn');
    const updatedBody = { ...body, id: created.id, expectedUpdatedAt: created.updatedAt, content: '改为周六出发' };
    assert.equal((await fetch(path, { method: 'PATCH', headers, body: JSON.stringify(updatedBody) })).status, 200);
    assert.equal((await fetch(path, { method: 'PATCH', headers, body: JSON.stringify(updatedBody) })).status, 409);
    const current = (await (await fetch(`${path}?query=${encodeURIComponent('旅行')}`, { headers })).json() as { memories: PersonalAgentMemory[] }).memories[0];
    const forget = JSON.stringify({ action: 'forget', id: current.id, expectedUpdatedAt: current.updatedAt });
    assert.equal((await fetch(path, { method: 'PATCH', headers: tokenHeaders('plan'), body: forget })).status, 403);
    active = false;
    assert.equal((await fetch(path, { method: 'PATCH', headers, body: forget })).status, 403);
    active = true;
    assert.equal((await fetch(path, { method: 'PATCH', headers, body: forget })).status, 200);
    assert.equal(memories.length, 0);
  });

});
