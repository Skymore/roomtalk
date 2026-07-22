import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveAuthenticatedSocketIdentity } from './socketIdentity';

const flushMicrotasks = () => new Promise<void>(resolve => setImmediate(resolve));

const createSocket = (overrides: Record<string, unknown> = {}) => ({
  id: 'socket-1',
  data: { roomtalkClientId: 'client-1', roomtalkBrowserInstanceId: 'browser-1' },
  rooms: new Set(['socket-1', 'client-1', 'room-1']),
  connected: true,
  emitted: [] as unknown[][],
  emit(...args: unknown[]) { this.emitted.push(args); },
  ...overrides,
});

describe('resolveAuthenticatedSocketIdentity', () => {
  it('uses the authenticated socket identity and rebuilds a missing Redis index', async () => {
    const calls: string[] = [];
    const socket = createSocket();
    const store = {
      async getClientId() { return null; },
      async isRoomMember(roomId: string, clientId: string) { return roomId === 'room-1' && clientId === 'client-1'; },
      async storeClientSession(_socketId: string, clientId: string) { calls.push(`session:${clientId}`); },
      async storeUserRooms(_socketId: string, roomIds: string[]) { calls.push(`rooms:${roomIds.join(',')}`); },
      async updateRoomMemberCount(roomId: string, clientId: string) { calls.push(`member:${roomId}:${clientId}`); },
      async updateRoomBrowserPresence(roomId: string, browserId: string) { calls.push(`browser:${roomId}:${browserId}`); },
    };

    assert.equal(await resolveAuthenticatedSocketIdentity({ socket: socket as any, store: store as any, logger: console as any }), 'client-1');
    await flushMicrotasks();

    assert.deepEqual(calls, [
      'session:client-1',
      'rooms:room-1',
      'member:room-1:client-1',
      'browser:room-1:browser-1',
    ]);
  });

  it('fails closed on conflicting identities and only requests registration once', async () => {
    const socket = createSocket();
    const store = { async getClientId() { return 'other-client'; } };

    assert.equal(await resolveAuthenticatedSocketIdentity({ socket: socket as any, store: store as any, logger: console as any }), null);
    assert.equal(await resolveAuthenticatedSocketIdentity({ socket: socket as any, store: store as any, logger: console as any }), null);
    assert.deepEqual(socket.emitted, [['registration_required', { reason: 'identity_conflict' }]]);
  });

  it('does not rebuild derived presence after the Socket has disconnected', async () => {
    const calls: string[] = [];
    const socket = createSocket({ connected: false });
    const store = {
      async getClientId() { return null; },
      async storeClientSession() { calls.push('session'); },
    };

    assert.equal(await resolveAuthenticatedSocketIdentity({ socket: socket as any, store: store as any, logger: console as any }), 'client-1');
    await flushMicrotasks();
    assert.deepEqual(calls, []);
  });

  it('does not rebuild presence for a Socket.IO room after durable access was revoked', async () => {
    const calls: string[] = [];
    const socket = createSocket();
    const store = {
      async getClientId() { return null; },
      async isRoomMember() { return false; },
      async storeClientSession() { calls.push('session'); },
      async storeUserRooms(_socketId: string, roomIds: string[]) { calls.push(`rooms:${roomIds.join(',')}`); },
      async updateRoomMemberCount() { calls.push('member'); },
      async updateRoomBrowserPresence() { calls.push('browser'); },
    };

    assert.equal(await resolveAuthenticatedSocketIdentity({ socket: socket as any, store: store as any, logger: console as any }), 'client-1');
    await flushMicrotasks();

    assert.deepEqual(calls, ['session', 'rooms:']);
  });
});
