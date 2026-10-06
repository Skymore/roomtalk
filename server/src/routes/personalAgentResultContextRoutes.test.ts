import assert from 'node:assert/strict';
import express from 'express';
import { describe, it } from 'node:test';
import { AddressInfo } from 'node:net';
import { CodeAgentRoomContextService } from '../services/codeAgentRoomContext';
import { PersonalAgentResultService } from '../services/personalAgentResults';
import { registerPersonalAgentResultContextRoutes } from './personalAgentResultContextRoutes';
import { registerPersonalAgentRoutes } from './personalAgentRoutes';
import { PersonalAgentResult } from '../types';

describe('personal result owner and turn routes', () => {
  it('saves through the owner broker, serves private downloads and refuses foreign or ended writes', async () => {
    let active = true, owner: string | undefined = 'owner';
    const rows: PersonalAgentResult[] = [], objects = new Map<string, Buffer>();
    const profile = { clientId: 'owner', mainRoomId: 'private' };
    const store = {
      async getRoomMember() { return null; },
      async getRoomById() { return { id: 'private', creatorId: 'owner', personalAgentOwnerId: owner, type: 'codeAgent', codeAgentAccess: 'owner' }; },
      async hasActiveCodeAgentRoomLease() { return active; },
      async getAccountByClientId(clientId: string) { return { primaryClientId: clientId }; },
      async ensurePersonalAgentProfile(clientId: string) { return { ...profile, clientId }; },
      async savePersonalAgentResult(result: PersonalAgentResult) { rows.push(result); return result; },
      async readPersonalAgentResults(clientId: string, options: { id?: string } = {}) {
        const results = rows.filter(row => row.clientId === clientId && (!options.id || row.id === options.id)); return { results, total: results.length };
      },
    } as any;
    const logger = { error() {} } as any;
    const results = new PersonalAgentResultService(store, {
      async putMediaObject({ objectKey, body }: { objectKey: string; body: Buffer }) { objects.set(objectKey, body); },
      async getMediaObject(key: string) { return { body: objects.get(key)!, byteSize: objects.get(key)!.length }; },
      async deleteMediaObject(key: string) { objects.delete(key); },
    } as any, logger);
    const context = new CodeAgentRoomContextService(store, { tokenSecret: 'test-results-secret' });
    const app = express();
    registerPersonalAgentResultContextRoutes(app, { store, roomContext: context, results, logger });
    app.use(express.json());
    registerPersonalAgentRoutes(app, { store, results, logger, getClientId: req => String(req.query.clientId || ''),
      authorizeClientRequest: async (req, res, clientId) => {
        if (req.header('x-client-auth-token') === `${clientId}-token`) return true;
        res.status(401).json({ error: 'Invalid token' }); return false;
      },
    });
    const server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const endpoint = `${base}/api/code-agent/room-context/personal-results`;
    const headers = (clientId = 'owner', mode: 'plan' | 'fullAccess' = 'fullAccess') => ({ 'Content-Type': 'application/json',
      authorization: `Bearer ${context.issueTurnToken({ roomId: 'private', clientId, turnId: 'turn', mode })}` });
    const content = '# Confirmed plan\n' + 'A'.repeat(150_000);
    const body = JSON.stringify({ kind: 'plan', title: 'Plan', filename: 'plan.md', content: Buffer.from(content).toString('base64'), clientId: 'forged', roomId: 'forged', turnId: 'forged' });
    try {
      assert.equal((await fetch(endpoint, { method: 'PATCH', body, headers: headers('owner', 'plan') })).status, 403);
      assert.equal((await fetch(endpoint, { method: 'PATCH', body, headers: headers('other') })).status, 403);
      const saved = await fetch(endpoint, { method: 'PATCH', body, headers: headers() }); assert.equal(saved.status, 200);
      const record = (await saved.json() as { result: PersonalAgentResult }).result;
      assert.equal(record.roomId, 'private'); assert.equal(record.turnId, 'turn'); assert.equal('objectKey' in record, false);
      const publicContent = `${base}/api/personal-agent/results/${record.id}/content`;
      assert.equal((await fetch(`${publicContent}?clientId=owner`)).status, 401);
      assert.equal((await fetch(`${publicContent}?clientId=other`, { headers: { 'x-client-auth-token': 'other-token' } })).status, 404);
      const download = await fetch(`${publicContent}?clientId=owner`, { headers: { 'x-client-auth-token': 'owner-token' } });
      assert.equal(download.status, 200); assert.equal(await download.text(), content);
      assert.match(download.headers.get('content-disposition')!, /attachment/); assert.match(download.headers.get('cache-control')!, /no-store/);
      active = false;
      assert.equal((await fetch(endpoint, { method: 'PATCH', body, headers: headers() })).status, 403);
      assert.equal((await fetch(`${publicContent}?clientId=owner`, { headers: { 'x-client-auth-token': 'owner-token' } })).status, 200);
      active = true; owner = undefined;
      assert.equal((await fetch(endpoint, { method: 'PATCH', body, headers: headers() })).status, 403);
      assert.equal(rows.length, 1);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
