import assert from 'node:assert/strict';
import express from 'express';
import { it } from 'node:test';
import { AddressInfo } from 'node:net';
import { CodeAgentRoomContextService } from '../services/codeAgentRoomContext';
import { PersonalAgentBrowserError } from '../services/personalAgentBrowser';
import { registerPersonalAgentBrowserContextRoutes } from './personalAgentBrowserContextRoutes';
import { registerPersonalAgentRoutes } from './personalAgentRoutes';

it('binds browser operations to the live owner turn and authenticates private screenshot and control routes', async () => {
  let active = true, personalOwner: string | undefined = 'owner';
  const calls: unknown[] = [];
  const store = {
    async getRoomMember() { return null; },
    async getRoomById() { return { id: 'private', creatorId: 'owner', personalAgentOwnerId: personalOwner, type: 'codeAgent', codeAgentAccess: 'owner' }; },
    async hasActiveCodeAgentRoomLease() { return active; },
    async getAccountByClientId(clientId: string) { return { primaryClientId: clientId }; },
    async ensurePersonalAgentProfile(clientId: string) { return { clientId }; },
  } as any;
  const control = { id: 'control', fence: 2 };
  const browser = {
    async agent(source: unknown, input: unknown) { calls.push({ source, input }); return { text: 'Actual page' }; },
    async list(clientId: string) { return { observations: [], clientId }; },
    async image(clientId: string) { if (clientId !== 'owner') throw new PersonalAgentBrowserError('Not found', 404); return Buffer.from([0xff, 0xd8, 0xff]); },
    async takeControl(clientId: string, roomId: string) { calls.push({ clientId, roomId }); return { control }; },
    async manual(clientId: string, roomId: string, grant: unknown) { calls.push({ clientId, roomId, grant }); throw new PersonalAgentBrowserError('Control expired', 409); },
    async releaseControl() { return { released: true }; },
  } as any;
  const logger = { error() {} } as any;
  const context = new CodeAgentRoomContextService(store, { tokenSecret: 'browser-route-test' });
  const app = express(); app.use(express.json());
  registerPersonalAgentBrowserContextRoutes(app, { store, browser, roomContext: context, logger });
  registerPersonalAgentRoutes(app, { store, browser, logger, getClientId: req => String(req.query.clientId || ''),
    authorizeClientRequest: async (req, res, clientId) => {
      if (req.header('x-client-auth-token') === `${clientId}-token`) return true;
      res.status(401).json({ error: 'Invalid token' }); return false;
    },
  });
  const server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const endpoint = `${base}/api/code-agent/room-context/personal-browser`;
  const headers = (clientId = 'owner', mode: 'plan' | 'fullAccess' = 'fullAccess') => ({ 'content-type': 'application/json',
    authorization: `Bearer ${context.issueTurnToken({ roomId: 'private', clientId, turnId: 'turn', mode })}` });
  const body = JSON.stringify({ action: 'read', clientId: 'forged', roomId: 'forged', turnId: 'forged' });
  try {
    assert.equal((await fetch(endpoint, { method: 'PATCH', body, headers: { 'content-type': 'application/json' } })).status, 401);
    assert.equal((await fetch(endpoint, { method: 'PATCH', body, headers: headers('other') })).status, 403);
    assert.equal((await fetch(endpoint, { method: 'PATCH', body, headers: headers('owner', 'plan') })).status, 403);
    assert.equal((await fetch(endpoint, { method: 'PATCH', body, headers: headers() })).status, 200);
    assert.deepEqual((calls[0] as any).source, { clientId: 'owner', roomId: 'private', turnId: 'turn' });
    active = false;
    assert.equal((await fetch(endpoint, { method: 'PATCH', body, headers: headers() })).status, 403);
    active = true; personalOwner = undefined;
    assert.equal((await fetch(endpoint, { method: 'PATCH', body, headers: headers() })).status, 403);
    const image = `${base}/api/personal-agent/browser-observations/visit/image`;
    assert.equal((await fetch(`${image}?clientId=owner`)).status, 401);
    assert.equal((await fetch(`${image}?clientId=other`, { headers: { 'x-client-auth-token': 'other-token' } })).status, 404);
    const screenshot = await fetch(`${image}?clientId=owner`, { headers: { 'x-client-auth-token': 'owner-token' } });
    assert.equal(screenshot.status, 200); assert.match(screenshot.headers.get('cache-control')!, /no-store/);
    assert.equal(screenshot.headers.get('content-type'), 'image/jpeg');
    assert.equal(Buffer.from(await screenshot.arrayBuffer()).toString('hex'), 'ffd8ff');
    const publicHeaders = { 'content-type': 'application/json', 'x-client-auth-token': 'owner-token' };
    const roomUrl = `${base}/api/personal-agent/browser/private`;
    const taken = await fetch(`${roomUrl}/take-control?clientId=owner`, { method: 'POST', headers: publicHeaders });
    assert.deepEqual(await taken.json(), { control });
    assert.equal((await fetch(`${roomUrl}/control?clientId=owner`, { method: 'PATCH', headers: publicHeaders, body: JSON.stringify({ action: 'read', control }) })).status, 409);
    assert.deepEqual(await (await fetch(`${roomUrl}/release-control?clientId=owner`, { method: 'POST', headers: publicHeaders, body: JSON.stringify({ control }) })).json(), { released: true });
    assert.equal(calls.length, 3);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
