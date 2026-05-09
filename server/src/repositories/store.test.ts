import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { AICost, Message, Room } from '../types';
import { CompositeRoomStore, DurableRoomStore, RealtimeRoomStore, RoomMessageCacheStore } from './store';

const room = (overrides: Partial<Room> = {}): Room => ({
  id: 'room-1',
  name: 'Room 1',
  description: '',
  createdAt: '2026-05-03T00:00:00.000Z',
  creatorId: 'client-1',
  ...overrides,
});

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'message-1',
  clientId: 'client-1',
  content: 'hello',
  roomId: 'room-1',
  timestamp: '2026-05-03T00:00:00.000Z',
  messageType: 'text',
  ...overrides,
});

const cost = (): AICost => ({
  currency: 'USD',
  inputUsd: 0.1,
  outputUsd: 0.2,
  totalUsd: 0.3,
  inputPerMillion: 1,
  outputPerMillion: 1,
  estimated: false,
});

describe('CompositeRoomStore', () => {
  it('routes durable operations to the durable store and realtime operations to the realtime store', async () => {
    const calls: string[] = [];
    const durable: DurableRoomStore = {
      async generateUniqueRoomId() { calls.push('durable.generateUniqueRoomId'); return 'room-1'; },
      async appendMessage(_message: Message) { calls.push('durable.appendMessage'); return room(); },
      async upsertMessage(_message: Message) { calls.push('durable.upsertMessage'); return room(); },
      async saveMessageHistory(_roomId: string, _messages: Message[]) { calls.push('durable.saveMessageHistory'); return room(); },
      async clearRoomMessages(_roomId: string) { calls.push('durable.clearRoomMessages'); return 1; },
      async readMessagesByRoom(_roomId: string) { calls.push('durable.readMessagesByRoom'); return [message()]; },
      async readRoomAICost(roomId: string) { calls.push('durable.readRoomAICost'); return { roomId, currency: 'USD', totalUsd: 1 }; },
      async incrementRoomAICost(roomId: string, _cost: AICost | null) { calls.push('durable.incrementRoomAICost'); return { roomId, currency: 'USD', totalUsd: 2 }; },
      async saveRoom(newRoom: Room) { calls.push('durable.saveRoom'); return newRoom; },
      async readRoomsByUser(_clientId: string) { calls.push('durable.readRoomsByUser'); return [room()]; },
      async getRoomById(_roomId: string) { calls.push('durable.getRoomById'); return room(); },
      async deleteRoom(_roomId: string, _creatorId: string) { calls.push('durable.deleteRoom'); },
      async countRooms() { calls.push('durable.countRooms'); return 1; },
      async resetAllDataForTests() { calls.push('durable.resetAllDataForTests'); },
      async failInterruptedStreamingMessages(_content: string) { calls.push('durable.failInterruptedStreamingMessages'); return 2; },
    };
    const realtime: RealtimeRoomStore = {
      async updateRoomMemberCount(_roomId: string, _clientId: string, _isJoining: boolean) { calls.push('realtime.updateRoomMemberCount'); return 1; },
      async getRoomMemberCount(_roomId: string) { calls.push('realtime.getRoomMemberCount'); return 1; },
      async storeClientSession(_socketId: string, _userId: string) { calls.push('realtime.storeClientSession'); },
      async getClientId(_socketId: string) { calls.push('realtime.getClientId'); return 'client-1'; },
      async removeClientSession(_socketId: string) { calls.push('realtime.removeClientSession'); },
      async storeUserRooms(_socketId: string, _roomIds: string[]) { calls.push('realtime.storeUserRooms'); },
      async getUserRooms(_socketId: string) { calls.push('realtime.getUserRooms'); return ['room-1']; },
      async resetAllDataForTests() { calls.push('realtime.resetAllDataForTests'); },
    };
    const store = new CompositeRoomStore(durable, realtime);

    assert.equal(await store.generateUniqueRoomId(), 'room-1');
    assert.deepEqual(await store.appendMessage(message()), room());
    assert.deepEqual(await store.upsertMessage(message()), room());
    assert.deepEqual(await store.saveMessageHistory('room-1', [message()]), room());
    assert.equal(await store.clearRoomMessages('room-1'), 1);
    assert.deepEqual(await store.readMessagesByRoom('room-1'), [message()]);
    assert.deepEqual(await store.readRoomAICost('room-1'), { roomId: 'room-1', currency: 'USD', totalUsd: 1 });
    assert.deepEqual(await store.incrementRoomAICost('room-1', cost()), { roomId: 'room-1', currency: 'USD', totalUsd: 2 });
    assert.deepEqual(await store.saveRoom(room()), room());
    assert.deepEqual(await store.readRoomsByUser('client-1'), [room()]);
    assert.deepEqual(await store.getRoomById('room-1'), room());
    await store.deleteRoom('room-1', 'client-1');
    assert.equal(await store.countRooms(), 1);
    assert.equal(await store.updateRoomMemberCount('room-1', 'client-1', true), 1);
    assert.equal(await store.getRoomMemberCount('room-1'), 1);
    await store.storeClientSession('socket-1', 'client-1');
    assert.equal(await store.getClientId('socket-1'), 'client-1');
    await store.removeClientSession('socket-1');
    await store.storeUserRooms('socket-1', ['room-1']);
    assert.deepEqual(await store.getUserRooms('socket-1'), ['room-1']);
    await store.resetAllDataForTests();
    assert.equal(await store.failInterruptedStreamingMessages('interrupted'), 2);

    assert.deepEqual(calls, [
      'durable.generateUniqueRoomId',
      'durable.appendMessage',
      'durable.upsertMessage',
      'durable.saveMessageHistory',
      'durable.clearRoomMessages',
      'durable.readMessagesByRoom',
      'durable.readRoomAICost',
      'durable.incrementRoomAICost',
      'durable.saveRoom',
      'durable.readRoomsByUser',
      'durable.getRoomById',
      'durable.deleteRoom',
      'durable.countRooms',
      'realtime.updateRoomMemberCount',
      'realtime.getRoomMemberCount',
      'realtime.storeClientSession',
      'realtime.getClientId',
      'realtime.removeClientSession',
      'realtime.storeUserRooms',
      'realtime.getUserRooms',
      'durable.resetAllDataForTests',
      'realtime.resetAllDataForTests',
      'durable.failInterruptedStreamingMessages',
    ]);
  });

  it('uses cached room messages on hit and populates cache on miss', async () => {
    const calls: string[] = [];
    const durable: DurableRoomStore = {
      async generateUniqueRoomId() { return 'room-1'; },
      async appendMessage() { return room(); },
      async upsertMessage() { return room(); },
      async saveMessageHistory() { return room(); },
      async clearRoomMessages() { return 0; },
      async readMessagesByRoom() { calls.push('durable.readMessagesByRoom'); return [message({ id: 'durable-message' })]; },
      async readRoomAICost(roomId: string) { return { roomId, currency: 'USD', totalUsd: 0 }; },
      async incrementRoomAICost(roomId: string) { return { roomId, currency: 'USD', totalUsd: 0 }; },
      async saveRoom(newRoom: Room) { return newRoom; },
      async readRoomsByUser() { return []; },
      async getRoomById() { return null; },
      async deleteRoom() {},
      async countRooms() { return 0; },
    };
    const realtime: RealtimeRoomStore = {
      async updateRoomMemberCount() { return 0; },
      async getRoomMemberCount() { return 0; },
      async storeClientSession() {},
      async getClientId() { return null; },
      async removeClientSession() {},
      async storeUserRooms() {},
      async getUserRooms() { return []; },
    };
    const cache: RoomMessageCacheStore = {
      cached: [message({ id: 'cached-message' })] as Message[] | null,
      async readCachedRoomMessages() { calls.push('cache.read'); return this.cached; },
      async writeRoomMessagesCache(_roomId: string, messages: Message[]) { calls.push(`cache.write:${messages[0]?.id || 'empty'}`); this.cached = messages; },
      async invalidateRoomMessagesCache() { calls.push('cache.invalidate'); this.cached = null; },
      async invalidateAllRoomMessagesCaches() { calls.push('cache.invalidateAll'); this.cached = null; },
    } as RoomMessageCacheStore & { cached: Message[] | null };
    const store = new CompositeRoomStore(durable, realtime, cache);

    assert.deepEqual(await store.readMessagesByRoom('room-1'), [message({ id: 'cached-message' })]);
    assert.deepEqual(calls, ['cache.read']);

    await cache.invalidateRoomMessagesCache('room-1');
    calls.length = 0;

    assert.deepEqual(await store.readMessagesByRoom('room-1'), [message({ id: 'durable-message' })]);
    assert.deepEqual(calls, ['cache.read', 'durable.readMessagesByRoom', 'cache.write:durable-message']);
  });

  it('invalidates message cache after durable message mutations only when writes succeed', async () => {
    const calls: string[] = [];
    const durable: DurableRoomStore = {
      async generateUniqueRoomId() { return 'room-1'; },
      async appendMessage(newMessage: Message) { calls.push(`durable.append:${newMessage.id}`); return newMessage.id === 'fail' ? null : room(); },
      async upsertMessage(newMessage: Message) { calls.push(`durable.upsert:${newMessage.id}`); return room(); },
      async saveMessageHistory(_roomId: string) { calls.push('durable.saveHistory'); return room(); },
      async clearRoomMessages(_roomId: string) { calls.push('durable.clear'); return 1; },
      async readMessagesByRoom() { return []; },
      async readRoomAICost(roomId: string) { return { roomId, currency: 'USD', totalUsd: 0 }; },
      async incrementRoomAICost(roomId: string) { return { roomId, currency: 'USD', totalUsd: 0 }; },
      async saveRoom(newRoom: Room) { return newRoom; },
      async readRoomsByUser() { return []; },
      async getRoomById() { return null; },
      async deleteRoom() { calls.push('durable.delete'); },
      async countRooms() { return 0; },
      async failInterruptedStreamingMessages() { calls.push('durable.failInterrupted'); return 2; },
    };
    const realtime: RealtimeRoomStore = {
      async updateRoomMemberCount() { return 0; },
      async getRoomMemberCount() { return 0; },
      async storeClientSession() {},
      async getClientId() { return null; },
      async removeClientSession() {},
      async storeUserRooms() {},
      async getUserRooms() { return []; },
    };
    const cache: RoomMessageCacheStore = {
      async readCachedRoomMessages() { return null; },
      async writeRoomMessagesCache() {},
      async invalidateRoomMessagesCache(roomId: string) { calls.push(`cache.invalidate:${roomId}`); },
      async invalidateAllRoomMessagesCaches() { calls.push('cache.invalidateAll'); },
    };
    const store = new CompositeRoomStore(durable, realtime, cache);

    assert.deepEqual(await store.appendMessage(message({ id: 'ok' })), room());
    assert.equal(await store.appendMessage(message({ id: 'fail' })), null);
    assert.deepEqual(await store.upsertMessage(message({ id: 'upsert' })), room());
    assert.deepEqual(await store.saveMessageHistory('room-1', [message()]), room());
    assert.equal(await store.clearRoomMessages('room-1'), 1);
    await store.deleteRoom('room-1', 'client-1');
    assert.equal(await store.failInterruptedStreamingMessages('interrupted'), 2);

    assert.deepEqual(calls, [
      'durable.append:ok',
      'cache.invalidate:room-1',
      'durable.append:fail',
      'durable.upsert:upsert',
      'cache.invalidate:room-1',
      'durable.saveHistory',
      'cache.invalidate:room-1',
      'durable.clear',
      'cache.invalidate:room-1',
      'durable.delete',
      'cache.invalidate:room-1',
      'durable.failInterrupted',
      'cache.invalidateAll',
    ]);
  });

  it('ignores cache failures and keeps durable reads and writes usable', async () => {
    const durable: DurableRoomStore = {
      async generateUniqueRoomId() { return 'room-1'; },
      async appendMessage() { return room(); },
      async upsertMessage() { return room(); },
      async saveMessageHistory() { return room(); },
      async clearRoomMessages() { return 0; },
      async readMessagesByRoom() { return [message({ id: 'durable-message' })]; },
      async readRoomAICost(roomId: string) { return { roomId, currency: 'USD', totalUsd: 0 }; },
      async incrementRoomAICost(roomId: string) { return { roomId, currency: 'USD', totalUsd: 0 }; },
      async saveRoom(newRoom: Room) { return newRoom; },
      async readRoomsByUser() { return []; },
      async getRoomById() { return null; },
      async deleteRoom() {},
      async countRooms() { return 0; },
    };
    const realtime: RealtimeRoomStore = {
      async updateRoomMemberCount() { return 0; },
      async getRoomMemberCount() { return 0; },
      async storeClientSession() {},
      async getClientId() { return null; },
      async removeClientSession() {},
      async storeUserRooms() {},
      async getUserRooms() { return []; },
    };
    const failingCache: RoomMessageCacheStore = {
      async readCachedRoomMessages() { throw new Error('cache read failed'); },
      async writeRoomMessagesCache() { throw new Error('cache write failed'); },
      async invalidateRoomMessagesCache() { throw new Error('cache invalidate failed'); },
      async invalidateAllRoomMessagesCaches() { throw new Error('cache invalidate all failed'); },
    };
    const store = new CompositeRoomStore(durable, realtime, failingCache);

    assert.deepEqual(await store.readMessagesByRoom('room-1'), [message({ id: 'durable-message' })]);
    assert.deepEqual(await store.appendMessage(message()), room());
    assert.equal(await store.clearRoomMessages('room-1'), 0);
  });

  it('runs realtime reset even when durable reset fails', async () => {
    const calls: string[] = [];
    const durable: DurableRoomStore = {
      async generateUniqueRoomId() { return 'room-1'; },
      async appendMessage() { return room(); },
      async upsertMessage() { return room(); },
      async saveMessageHistory() { return room(); },
      async clearRoomMessages() { return 0; },
      async readMessagesByRoom() { return []; },
      async readRoomAICost(roomId: string) { return { roomId, currency: 'USD', totalUsd: 0 }; },
      async incrementRoomAICost(roomId: string) { return { roomId, currency: 'USD', totalUsd: 0 }; },
      async saveRoom(newRoom: Room) { return newRoom; },
      async readRoomsByUser() { return []; },
      async getRoomById() { return null; },
      async deleteRoom() {},
      async countRooms() { return 0; },
      async resetAllDataForTests() {
        calls.push('durable.reset');
        throw new Error('durable failed');
      },
    };
    const realtime: RealtimeRoomStore = {
      async updateRoomMemberCount() { return 0; },
      async getRoomMemberCount() { return 0; },
      async storeClientSession() {},
      async getClientId() { return null; },
      async removeClientSession() {},
      async storeUserRooms() {},
      async getUserRooms() { return []; },
      async resetAllDataForTests() {
        calls.push('realtime.reset');
      },
    };
    const store = new CompositeRoomStore(durable, realtime);

    await assert.rejects(() => store.resetAllDataForTests(), /durable failed/);

    assert.deepEqual(calls, ['durable.reset', 'realtime.reset']);
  });
});
