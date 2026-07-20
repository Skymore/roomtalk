import assert from 'assert/strict';
import express from 'express';
import { Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Logger } from '../logger';
import { RoomStore } from '../repositories/store';
import { CodeAgentRoomContextService } from '../services/codeAgentRoomContext';
import { registerCodeAgentRoomContextRoutes } from './codeAgentRoomContextRoutes';

describe('code-agent room context routes', () => {
  let server: HttpServer;
  let baseUrl: string;
  let service: CodeAgentRoomContextService;

  beforeEach(async () => {
    const messages = [
      { id: 'm1', roomId: 'room-1', clientId: 'client-1', username: 'Owner', content: 'first message', timestamp: '2026-07-10T00:00:00.000Z', messageType: 'text' as const },
      { id: 'm2', roomId: 'room-1', clientId: 'client-2', username: 'Member', content: 'second message', timestamp: '2026-07-10T00:00:01.000Z', messageType: 'text' as const },
    ];
    const store = {
      async getRoomById(roomId: string) {
        return roomId === 'room-1'
          ? { id: roomId, name: 'Workspace', description: '', createdAt: '2026-07-10T00:00:00.000Z', creatorId: 'client-1', type: 'codeAgent' as const }
          : null;
      },
      async readMessagesByRoom() { return messages; },
      async readMessagePageByRoom(roomId: string, input: { limit?: number } = {}) {
        const pageMessages = messages.slice(-(input.limit || messages.length));
        return { roomId, messages: pageMessages, hasMore: pageMessages.length < messages.length, oldestMessageId: pageMessages[0]?.id };
      },
    } as unknown as RoomStore;
    service = new CodeAgentRoomContextService(store, { tokenSecret: 'secret', createId: () => 'token-1' });
    const app = express();
    registerCodeAgentRoomContextRoutes(app, {
      service,
      logger: new Logger('RoomContextRoutesTest'),
      listPublishedSites: async (roomId, requestBaseUrl) => [{
        slug: 'roomtalk-demo',
        url: `${requestBaseUrl}/p/roomtalk-demo/`,
        roomId,
      }],
    });
    server = await new Promise<HttpServer>(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it('requires a token and scopes reads to its room', async () => {
    assert.equal((await fetch(`${baseUrl}/api/code-agent/room-context/history`)).status, 401);
    const token = service.issueTurnToken({ roomId: 'room-1', clientId: 'client-1', turnId: 'turn-1', mode: 'plan' });
    const response = await fetch(`${baseUrl}/api/code-agent/room-context/history?limit=1`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const body = await response.json() as { roomId: string; messages: Array<{ id: string }> };
    assert.equal(body.roomId, 'room-1');
    assert.deepEqual(body.messages.map(message => message.id), ['m2']);
  });

  it('exposes delta, search, and exact message endpoints', async () => {
    const token = service.issueTurnToken({ roomId: 'room-1', clientId: 'client-1', turnId: 'turn-1', mode: 'plan' });
    const headers = { authorization: `Bearer ${token}` };
    const delta = await fetch(`${baseUrl}/api/code-agent/room-context/delta?sinceMessageId=m1`, { headers });
    assert.deepEqual(((await delta.json()) as any).messages.map((message: any) => message.id), ['m2']);
    const search = await fetch(`${baseUrl}/api/code-agent/room-context/search?query=second`, { headers });
    assert.deepEqual(((await search.json()) as any).messages.map((message: any) => message.id), ['m2']);
    const message = await fetch(`${baseUrl}/api/code-agent/room-context/messages/m1`, { headers });
    assert.equal(((await message.json()) as any).message.content, 'first message');
  });

  it('lists published sites through the read-only room-scoped token', async () => {
    const token = service.issueTurnToken({ roomId: 'room-1', clientId: 'client-1', turnId: 'turn-1', mode: 'plan' });
    const response = await fetch(`${baseUrl}/api/code-agent/room-context/sites`, {
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(response.status, 200);
    const body = await response.json() as { roomId: string; sites: Array<{ slug: string; url: string; roomId: string }> };
    assert.equal(body.roomId, 'room-1');
    assert.deepEqual(body.sites, [{
      slug: 'roomtalk-demo',
      url: `${baseUrl}/p/roomtalk-demo/`,
      roomId: 'room-1',
    }]);
  });
});
