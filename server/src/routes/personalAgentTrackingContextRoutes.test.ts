import assert from 'node:assert/strict';
import express from 'express';
import { describe, it } from 'node:test';
import { AddressInfo } from 'node:net';
import { CodeAgentRoomContextService } from '../services/codeAgentRoomContext';
import { PersonalAgentTrackingService } from '../services/personalAgentTracking';
import { PersonalAgentNotificationService } from '../services/personalAgentNotifications';
import { registerPersonalAgentTrackingContextRoutes } from './personalAgentTrackingContextRoutes';
import { registerPersonalAgentRoutes } from './personalAgentRoutes';

describe('private and public personal tracking access', () => {
  it('requires authenticated owners and live write-capable turns', async () => {
    let active = true;
    const rows: any[] = [], notifications: any[] = [{ id: 'notice', clientId: 'owner', eventKey: 'event', kind: 'task_complete', title: 'Done', body: 'Actual response' }];
    const store = {
      async getRoomMember() { return null; },
      async getRoomById() { return { id: 'private', creatorId: 'owner', personalAgentOwnerId: 'owner', type: 'codeAgent', codeAgentAccess: 'owner' }; },
      async hasActiveCodeAgentRoomLease() { return active; },
      async getAccountByClientId(clientId: string) { return { primaryClientId: clientId }; },
      async ensurePersonalAgentProfile(clientId: string) { return { clientId }; },
      async readPersonalAgentWatches(clientId: string) { const watches = rows.filter(row => row.clientId === clientId); return { watches, total: watches.length }; },
      async createPersonalAgentWatch(watch: any, _room: unknown, claim: unknown) { assert.deepEqual(claim, { roomId: 'private', turnId: 'turn' }); rows.push(watch); return watch; },
      async readPersonalAgentNotifications(clientId: string) { return { notifications: notifications.filter(row => row.clientId === clientId), total: clientId === 'owner' ? 1 : 0, unread: 1 }; },
      async markPersonalAgentNotificationRead(clientId: string, id: string) { const row = notifications.find(item => item.clientId === clientId && item.id === id); if (row) row.readAt = '2026-10-06T12:00:00Z'; return row || null; },
    } as any;
    const logger = { error() {}, warn() {} } as any;
    const tracking = new PersonalAgentTrackingService(store, {} as any, {} as any, logger);
    const updates = new PersonalAgentNotificationService(store, logger, async () => {});
    const context = new CodeAgentRoomContextService(store, { tokenSecret: 'test-tracking-secret' });
    const app = express(); app.use(express.json());
    registerPersonalAgentTrackingContextRoutes(app, { store, roomContext: context, tracking, notifications: updates, logger });
    registerPersonalAgentRoutes(app, { store, tracking, notifications: updates, logger, getClientId: req => String(req.query.clientId || req.body?.clientId || ''),
      authorizeClientRequest: async (req, res, clientId) => {
        if (req.header('x-client-auth-token') === `${clientId}-token`) return true;
        res.status(401).json({ error: 'Invalid token' }); return false;
      } });
    const server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const endpoint = `${base}/api/code-agent/room-context/personal-watches`;
    const headers = (clientId = 'owner', mode: 'plan' | 'fullAccess' = 'fullAccess') => ({ 'Content-Type': 'application/json',
      authorization: `Bearer ${context.issueTurnToken({ roomId: 'private', clientId, turnId: 'turn', mode })}` });
    const body = JSON.stringify({ action: 'create', title: 'Stock', url: 'https://example.org/stock', condition: 'change', clientId: 'other' });
    try {
      assert.equal((await fetch(endpoint)).status, 401);
      assert.equal((await fetch(endpoint, { method: 'PATCH', body, headers: headers('other') })).status, 403);
      assert.equal((await fetch(endpoint, { method: 'PATCH', body, headers: headers('owner', 'plan') })).status, 403);
      assert.equal((await fetch(endpoint, { headers: headers('owner', 'plan') })).status, 200);
      const created = await fetch(endpoint, { method: 'PATCH', body, headers: headers() }); assert.equal(created.status, 200);
      const result = await created.json() as any;
      assert.equal(result.watch.clientId, undefined); assert.equal(rows[0].clientId, 'owner');
      active = false;
      assert.equal((await fetch(endpoint, { method: 'PATCH', body, headers: headers() })).status, 403);
      const read = (clientId: string, token = `${clientId}-token`) => fetch(`${base}/api/personal-agent/notifications/notice/read`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-client-auth-token': token }, body: JSON.stringify({ clientId }) });
      assert.equal((await read('owner', 'wrong')).status, 401);
      assert.equal((await read('other')).status, 404);
      const receipt = await read('owner'); assert.equal(receipt.status, 200);
      const saved = await receipt.json() as any; assert.ok(saved.notification.readAt); assert.equal(saved.notification.eventKey, undefined);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
