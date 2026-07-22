import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { enforceRoomEventAuthorizationBarrier } from './roomEventAuthorizationBarrier';

const socket = (clientId?: string) => ({
  data: clientId ? { roomtalkClientId: clientId } : {},
  emitted: [] as Array<{ event: string; payload: unknown }>,
  left: [] as string[],
  emit(event: string, payload: unknown) {
    this.emitted.push({ event, payload });
  },
  async leave(roomId: string) {
    this.left.push(roomId);
  },
});

describe('room event authorization barrier', () => {
  it('uses authenticated local socket identity after Redis loses its session map', async () => {
    const localSocket = socket('client-1');
    const result = await enforceRoomEventAuthorizationBarrier({
      roomId: 'room-1',
      socketIds: ['socket-1'],
      getLocalSocket: () => localSocket as any,
      readStoredClientIds: async () => new Map(),
      readAuthorizedClientIds: async clientIds => new Set(clientIds),
      onUnavailable: () => assert.fail('local identity should keep authorization available'),
    });

    assert.equal(result, true);
    assert.deepEqual(localSocket.emitted, []);
  });

  it('removes only a socket without local authenticated identity', async () => {
    const localSocket = socket();
    const unavailable: unknown[] = [];
    const result = await enforceRoomEventAuthorizationBarrier({
      roomId: 'room-1',
      socketIds: ['socket-1'],
      getLocalSocket: () => localSocket as any,
      readStoredClientIds: async () => new Map(),
      readAuthorizedClientIds: async () => assert.fail('membership must not run without identity'),
      onUnavailable: context => unavailable.push(context),
    });

    assert.equal(result, true);
    assert.equal(unavailable.length, 1);
    assert.deepEqual(localSocket.emitted, [{
      event: 'registration_required',
      payload: { reason: 'missing_authenticated_identity' },
    }]);
    assert.deepEqual(localSocket.left, ['room-1']);
  });

  it('removes only a socket whose Redis and local identities conflict', async () => {
    const localSocket = socket('client-local');
    const result = await enforceRoomEventAuthorizationBarrier({
      roomId: 'room-1',
      socketIds: ['socket-1'],
      getLocalSocket: () => localSocket as any,
      readStoredClientIds: async () => new Map([['socket-1', 'client-redis']]),
      readAuthorizedClientIds: async () => assert.fail('conflicting identity must not reach membership'),
      onUnavailable: () => undefined,
    });

    assert.equal(result, true);
    assert.deepEqual(localSocket.emitted, [{
      event: 'registration_required',
      payload: { reason: 'identity_conflict' },
    }]);
    assert.deepEqual(localSocket.left, ['room-1']);
  });

  it('keeps the fast path available for verified sockets while removing an unresolved peer', async () => {
    const verified = socket('client-1');
    const unresolved = socket();
    const sockets = new Map([['socket-1', verified], ['socket-2', unresolved]]);
    const result = await enforceRoomEventAuthorizationBarrier({
      roomId: 'room-1',
      socketIds: [...sockets.keys()],
      getLocalSocket: socketId => sockets.get(socketId) as any,
      readStoredClientIds: async () => new Map(),
      readAuthorizedClientIds: async clientIds => new Set(clientIds),
      onUnavailable: () => undefined,
    });

    assert.equal(result, true);
    assert.deepEqual(verified.emitted, []);
    assert.deepEqual(verified.left, []);
    assert.deepEqual(unresolved.emitted.map(item => item.event), ['registration_required']);
    assert.deepEqual(unresolved.left, ['room-1']);
  });

  it('falls back to local identity when Redis throws and removes only explicit non-members', async () => {
    const authorized = socket('client-1');
    const removed = socket('client-2');
    const sockets = new Map([['socket-1', authorized], ['socket-2', removed]]);
    const result = await enforceRoomEventAuthorizationBarrier({
      roomId: 'room-1',
      socketIds: [...sockets.keys()],
      getLocalSocket: socketId => sockets.get(socketId) as any,
      readStoredClientIds: async () => { throw new Error('redis unavailable'); },
      readAuthorizedClientIds: async () => new Set(['client-1']),
      onUnavailable: () => undefined,
    });

    assert.equal(result, true);
    assert.deepEqual(authorized.emitted, []);
    assert.deepEqual(removed.emitted.map(item => item.event), ['room_removed', 'room_permissions_invalidated']);
    assert.deepEqual(removed.left, ['room-1']);
  });

  it('keeps every socket joined when PostgreSQL membership is unavailable', async () => {
    const localSocket = socket('client-1');
    const result = await enforceRoomEventAuthorizationBarrier({
      roomId: 'room-1',
      socketIds: ['socket-1'],
      getLocalSocket: () => localSocket as any,
      readStoredClientIds: async () => new Map([['socket-1', 'client-1']]),
      readAuthorizedClientIds: async () => { throw new Error('postgres unavailable'); },
      onUnavailable: () => undefined,
    });

    assert.equal(result, false);
    assert.deepEqual(localSocket.emitted, []);
    assert.deepEqual(localSocket.left, []);
  });
});
