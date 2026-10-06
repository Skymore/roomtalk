import assert from 'node:assert/strict';
import express from 'express';
import { describe, it } from 'node:test';
import { AddressInfo } from 'node:net';
import { CodeAgentRoomContextService } from '../services/codeAgentRoomContext';
import { PersonalAgentIdeaService } from '../services/personalAgentIdeas';
import { registerPersonalAgentIdeaContextRoutes } from './personalAgentIdeaContextRoutes';
import { registerPersonalAgentRoutes } from './personalAgentRoutes';
import { PersonalAgentIdea } from '../types';

describe('personal suggestion owner and turn routes', () => {
  it('requires live owner write access, canonical sources and authenticated owner decisions', async () => {
    let active = true, personal = true;
    const rows: PersonalAgentIdea[] = [];
    const source = { kind: 'memory' as const, id: 'note', title: 'Actual topic', excerpt: 'Confirmed decision', recordedAt: '2026-10-06T12:00:00.000Z' };
    const store = {
      async getRoomMember() { return null; },
      async getRoomById() { return { id: 'private', creatorId: 'owner', personalAgentOwnerId: personal ? 'owner' : undefined, type: 'codeAgent', codeAgentAccess: 'owner' }; },
      async hasActiveCodeAgentRoomLease() { return active; },
      async getAccountByClientId(clientId: string) { return { primaryClientId: clientId }; },
      async ensurePersonalAgentProfile(clientId: string) { return { clientId, mainRoomId: 'private' }; },
      async readPersonalAgentIdeaSource(clientId: string, kind: string, id: string) { return clientId === 'owner' && kind === 'memory' && id === 'note' ? source : null; },
      async savePersonalAgentIdea(idea: PersonalAgentIdea, claim: { roomId: string; turnId: string }) {
        assert.deepEqual(claim, { roomId: 'private', turnId: 'turn' }); rows.push(idea); return idea;
      },
      async readPersonalAgentIdeas(clientId: string, options: { id?: string; status?: string } = {}) {
        const ideas = rows.filter(row => row.clientId === clientId && (!options.id || row.id === options.id) && (!options.status || row.status === options.status)); return { ideas, total: ideas.length };
      },
      async dismissPersonalAgentIdea(clientId: string, id: string, revision: string) {
        const idea = rows.find(row => row.clientId === clientId && row.id === id && row.updatedAt === revision);
        if (!idea) return null; idea.status = 'dismissed'; return idea;
      },
    } as any;
    const logger = { error() {} } as any;
    const ideas = new PersonalAgentIdeaService(store);
    const context = new CodeAgentRoomContextService(store, { tokenSecret: 'test-ideas-secret' });
    const app = express(); app.use(express.json());
    registerPersonalAgentIdeaContextRoutes(app, { store, roomContext: context, ideas, logger });
    registerPersonalAgentRoutes(app, { store, ideas, logger, getClientId: req => String(req.query.clientId || req.body?.clientId || ''),
      authorizeClientRequest: async (req, res, clientId) => {
        if (req.header('x-client-auth-token') === `${clientId}-token`) return true;
        res.status(401).json({ error: 'Invalid token' }); return false;
      },
    });
    const server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const endpoint = `${base}/api/code-agent/room-context/personal-ideas`;
    const headers = (clientId = 'owner', mode: 'plan' | 'fullAccess' = 'fullAccess') => ({ 'Content-Type': 'application/json',
      authorization: `Bearer ${context.issueTurnToken({ roomId: 'private', clientId, turnId: 'turn', mode })}` });
    const body = JSON.stringify({ sourceKind: 'memory', sourceId: 'note', title: 'Follow up', reason: 'Saved topic', prompt: 'Prepare next steps',
      clientId: 'other', source: { excerpt: 'Fabricated' } });
    try {
      assert.equal((await fetch(endpoint, { method: 'PATCH', body, headers: headers('owner', 'plan') })).status, 403);
      assert.equal((await fetch(endpoint, { method: 'PATCH', body, headers: headers('other') })).status, 403);
      assert.equal((await fetch(endpoint, { headers: headers('owner', 'plan') })).status, 200);
      assert.equal((await fetch(`${endpoint}?limit=999`, { headers: headers() })).status, 400);
      const saved = await fetch(endpoint, { method: 'PATCH', body, headers: headers() }); assert.equal(saved.status, 200);
      const idea = (await saved.json() as { idea: PersonalAgentIdea }).idea;
      assert.deepEqual(idea.source, source); assert.equal(idea.clientId, 'owner');
      const decision = `${base}/api/personal-agent/ideas/${idea.id}`;
      const patch = (clientId: string, token = `${clientId}-token`, expectedUpdatedAt = idea.updatedAt) => fetch(decision, { method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-client-auth-token': token }, body: JSON.stringify({ clientId, action: 'dismiss', expectedUpdatedAt }) });
      assert.equal((await patch('owner', 'wrong')).status, 401);
      assert.equal((await patch('other')).status, 404);
      assert.equal((await patch('owner', 'owner-token', '2000-01-01T00:00:00Z')).status, 409);
      assert.equal((await patch('owner')).status, 200); assert.equal(rows[0].status, 'dismissed');
      active = false;
      assert.equal((await fetch(endpoint, { method: 'PATCH', body, headers: headers() })).status, 403);
      active = true; personal = false;
      assert.equal((await fetch(endpoint, { method: 'PATCH', body, headers: headers() })).status, 403);
      assert.equal(rows.length, 1);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
