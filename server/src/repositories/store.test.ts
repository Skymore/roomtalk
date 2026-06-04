import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { AICost, ImageAsset, Message, Room, RoomMemberRole } from '../types';
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

const durableMutationStubs = () => ({
  async updateMessageContent() { return { room: room(), found: true, updatedMessage: message() }; },
  async deleteMessageById() { return { room: room(), deleted: true }; },
  async truncateBeforeMessage() { return { room: room(), messages: [message()], targetFound: true }; },
  async truncateAfterMessage() { return { room: room(), messages: [message()], targetFound: true }; },
  async updateMessageAndTruncateAfter() { return { room: room(), messages: [message()], targetFound: true, updatedMessage: message() }; },
});

const durableRoomAccessStubs = () => ({
  async addRoomMember(roomId: string, clientId: string, role: RoomMemberRole, joinedAt = '2026-05-03T00:00:00.000Z') {
    return { roomId, clientId, role, joinedAt };
  },
  async removeRoomMember() {
    return true;
  },
  async getRoomMember(roomId: string, clientId: string) {
    return { roomId, clientId, role: 'member' as const, joinedAt: '2026-05-03T00:00:00.000Z' };
  },
  async isRoomMember() {
    return true;
  },
  async readRoomMembers(roomId: string) {
    return [{ roomId, clientId: 'client-1', role: 'owner' as const, joinedAt: '2026-05-03T00:00:00.000Z' }];
  },
  async saveRoomForUser() {
    return room();
  },
  async removeSavedRoomForUser() {
    return true;
  },
  async readSavedRoomsByUser() {
    return [room()];
  },
});

const imageAsset = (overrides: Partial<ImageAsset> = {}): ImageAsset => ({
  id: 'asset-1',
  roomId: 'room-1',
  messageId: 'message-1',
  objectKey: 'rooms/room-1/asset-1.webp',
  mimeType: 'image/webp',
  byteSize: 123,
  createdAt: '2026-05-03T00:00:00.000Z',
  ...overrides,
});

const durableImageAssetStubs = () => ({
  async saveImageAsset(asset: ImageAsset) {
    return asset;
  },
  async replaceMessageImageAsset(roomId: string, messageId: string, asset: ImageAsset) {
    return {
      room: room(),
      found: true,
      updatedMessage: message({
        id: messageId,
        roomId,
        content: asset.id,
        messageType: 'image',
        mimeType: asset.mimeType as Message['mimeType'],
        imageAsset: {
          id: asset.id,
          mimeType: asset.mimeType,
          byteSize: asset.byteSize,
        },
      }),
    };
  },
  async getImageAsset(assetId: string) {
    return imageAsset({ id: assetId });
  },
  async getImageAssetByMessageId(messageId: string) {
    return imageAsset({ messageId });
  },
  async readImageAssetsByRoom(roomId: string) {
    return [imageAsset({ roomId })];
  },
  async deleteImageAsset() {},
});

describe('CompositeRoomStore', () => {
  it('routes durable operations to the durable store and realtime operations to the realtime store', async () => {
    const calls: string[] = [];
    const durable: DurableRoomStore = {
      async generateUniqueRoomId() { calls.push('durable.generateUniqueRoomId'); return 'room-1'; },
      async appendMessage(_message: Message) { calls.push('durable.appendMessage'); return room(); },
      async upsertMessage(_message: Message) { calls.push('durable.upsertMessage'); return room(); },
      async updateMessageContent() { calls.push('durable.updateMessageContent'); return { room: room(), found: true, updatedMessage: message() }; },
      async deleteMessageById() { calls.push('durable.deleteMessageById'); return { room: room(), deleted: true }; },
      async truncateBeforeMessage() { calls.push('durable.truncateBeforeMessage'); return { room: room(), messages: [message()], targetFound: true }; },
      async truncateAfterMessage() { calls.push('durable.truncateAfterMessage'); return { room: room(), messages: [message()], targetFound: true }; },
      async updateMessageAndTruncateAfter() { calls.push('durable.updateMessageAndTruncateAfter'); return { room: room(), messages: [message()], targetFound: true, updatedMessage: message() }; },
      async saveMessageHistory(_roomId: string, _messages: Message[]) { calls.push('durable.saveMessageHistory'); return room(); },
      async clearRoomMessages(_roomId: string) { calls.push('durable.clearRoomMessages'); return 1; },
      async readMessagesByRoom(_roomId: string) { calls.push('durable.readMessagesByRoom'); return [message()]; },
      async readMessagePageByRoom(_roomId: string) { calls.push('durable.readMessagePageByRoom'); return { roomId: 'room-1', messages: [message()], historyVersion: 1, hasMore: false }; },
      async saveImageAsset(asset: ImageAsset) { calls.push('durable.saveImageAsset'); return asset; },
      async replaceMessageImageAsset(roomId: string, messageId: string, asset: ImageAsset) {
        calls.push('durable.replaceMessageImageAsset');
        return {
          room: room(),
          found: true,
          updatedMessage: message({
            id: messageId,
            roomId,
            content: asset.id,
            messageType: 'image',
            mimeType: asset.mimeType as Message['mimeType'],
            imageAsset: {
              id: asset.id,
              mimeType: asset.mimeType,
              byteSize: asset.byteSize,
            },
          }),
        };
      },
      async getImageAsset(assetId: string) { calls.push('durable.getImageAsset'); return imageAsset({ id: assetId }); },
      async getImageAssetByMessageId(messageId: string) { calls.push('durable.getImageAssetByMessageId'); return imageAsset({ messageId }); },
      async readImageAssetsByRoom(roomId: string) { calls.push('durable.readImageAssetsByRoom'); return [imageAsset({ roomId })]; },
      async deleteImageAsset(_assetId: string) { calls.push('durable.deleteImageAsset'); },
      async readRoomAICost(roomId: string) { calls.push('durable.readRoomAICost'); return { roomId, currency: 'USD', totalUsd: 1 }; },
      async incrementRoomAICost(roomId: string, _cost: AICost | null) { calls.push('durable.incrementRoomAICost'); return { roomId, currency: 'USD', totalUsd: 2 }; },
      async saveRoom(newRoom: Room) { calls.push('durable.saveRoom'); return newRoom; },
      async addRoomMember(roomId: string, clientId: string, role: RoomMemberRole, joinedAt = '2026-05-03T00:00:00.000Z') { calls.push('durable.addRoomMember'); return { roomId, clientId, role, joinedAt }; },
      async removeRoomMember(_roomId: string, _clientId: string) { calls.push('durable.removeRoomMember'); return true; },
      async getRoomMember(roomId: string, clientId: string) { calls.push('durable.getRoomMember'); return { roomId, clientId, role: 'member' as const, joinedAt: '2026-05-03T00:00:00.000Z' }; },
      async isRoomMember(_roomId: string, _clientId: string) { calls.push('durable.isRoomMember'); return true; },
      async readRoomMembers(roomId: string) { calls.push('durable.readRoomMembers'); return [{ roomId, clientId: 'client-1', role: 'owner' as const, joinedAt: '2026-05-03T00:00:00.000Z' }]; },
      async readRoomsByUser(_clientId: string) { calls.push('durable.readRoomsByUser'); return [room()]; },
      async saveRoomForUser(_roomId: string, _clientId: string) { calls.push('durable.saveRoomForUser'); return room(); },
      async removeSavedRoomForUser(_roomId: string, _clientId: string) { calls.push('durable.removeSavedRoomForUser'); return true; },
      async readSavedRoomsByUser(_clientId: string) { calls.push('durable.readSavedRoomsByUser'); return [room()]; },
      async getRoomById(_roomId: string) { calls.push('durable.getRoomById'); return room(); },
      async updateRoomName(_roomId: string, _creatorId: string, _name: string) { calls.push('durable.updateRoomName'); return room({ name: 'Renamed' }); },
      async deleteRoom(_roomId: string, _creatorId: string) { calls.push('durable.deleteRoom'); },
      async countRooms() { calls.push('durable.countRooms'); return 1; },
      async resetAllDataForTests() { calls.push('durable.resetAllDataForTests'); },
      async failInterruptedStreamingMessages(_content: string) { calls.push('durable.failInterruptedStreamingMessages'); return 2; },
    };
    const realtime: RealtimeRoomStore = {
      async updateRoomMemberCount(_roomId: string, _clientId: string, _socketId: string, _isJoining: boolean) { calls.push('realtime.updateRoomMemberCount'); return 1; },
      async getRoomMemberCount(_roomId: string) { calls.push('realtime.getRoomMemberCount'); return 1; },
      async clearRealtimeRoomMembers() { calls.push('realtime.clearRealtimeRoomMembers'); },
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
    assert.deepEqual(await store.updateMessageContent('room-1', 'message-1', 'edited'), { room: room(), found: true, updatedMessage: message() });
    assert.deepEqual(await store.deleteMessageById('room-1', 'message-1'), { room: room(), deleted: true });
    assert.deepEqual(await store.truncateBeforeMessage('room-1', 'message-1'), { room: room(), messages: [message()], targetFound: true });
    assert.deepEqual(await store.truncateAfterMessage('room-1', 'message-1'), { room: room(), messages: [message()], targetFound: true });
    assert.deepEqual(await store.updateMessageAndTruncateAfter('room-1', 'message-1', 'edited'), { room: room(), messages: [message()], targetFound: true, updatedMessage: message() });
    assert.deepEqual(await store.saveMessageHistory('room-1', [message()]), room());
    assert.equal(await store.clearRoomMessages('room-1'), 1);
    assert.deepEqual(await store.readMessagesByRoom('room-1'), [message()]);
    assert.deepEqual(await store.readMessagePageByRoom('room-1'), { roomId: 'room-1', messages: [message()], historyVersion: 1, hasMore: false });
    assert.deepEqual(await store.saveImageAsset(imageAsset()), imageAsset());
    assert.deepEqual(await store.replaceMessageImageAsset('room-1', 'message-1', imageAsset()), {
      room: room(),
      found: true,
      updatedMessage: message({
        content: 'asset-1',
        messageType: 'image',
        mimeType: 'image/webp',
        imageAsset: {
          id: 'asset-1',
          mimeType: 'image/webp',
          byteSize: 123,
        },
      }),
    });
    assert.deepEqual(await store.getImageAsset('asset-1'), imageAsset());
    assert.deepEqual(await store.getImageAssetByMessageId('message-1'), imageAsset());
    assert.deepEqual(await store.readImageAssetsByRoom('room-1'), [imageAsset()]);
    await store.deleteImageAsset('asset-1');
    assert.deepEqual(await store.readRoomAICost('room-1'), { roomId: 'room-1', currency: 'USD', totalUsd: 1 });
    assert.deepEqual(await store.incrementRoomAICost('room-1', cost()), { roomId: 'room-1', currency: 'USD', totalUsd: 2 });
    assert.deepEqual(await store.saveRoom(room()), room());
    assert.deepEqual(await store.addRoomMember('room-1', 'client-2', 'member'), { roomId: 'room-1', clientId: 'client-2', role: 'member', joinedAt: '2026-05-03T00:00:00.000Z' });
    assert.equal(await store.removeRoomMember('room-1', 'client-2'), true);
    assert.deepEqual(await store.getRoomMember('room-1', 'client-2'), { roomId: 'room-1', clientId: 'client-2', role: 'member', joinedAt: '2026-05-03T00:00:00.000Z' });
    assert.equal(await store.isRoomMember('room-1', 'client-2'), true);
    assert.deepEqual(await store.readRoomMembers('room-1'), [{ roomId: 'room-1', clientId: 'client-1', role: 'owner', joinedAt: '2026-05-03T00:00:00.000Z' }]);
    assert.deepEqual(await store.readRoomsByUser('client-1'), [room()]);
    assert.deepEqual(await store.saveRoomForUser('room-1', 'client-2'), room());
    assert.equal(await store.removeSavedRoomForUser('room-1', 'client-2'), true);
    assert.deepEqual(await store.readSavedRoomsByUser('client-2'), [room()]);
    assert.deepEqual(await store.getRoomById('room-1'), room());
    assert.deepEqual(await store.updateRoomName('room-1', 'client-1', 'Renamed'), room({ name: 'Renamed' }));
    await store.deleteRoom('room-1', 'client-1');
    assert.equal(await store.countRooms(), 1);
    assert.equal(await store.updateRoomMemberCount('room-1', 'client-1', 'socket-1', true), 1);
    assert.equal(await store.getRoomMemberCount('room-1'), 1);
    await store.clearRealtimeRoomMembers();
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
      'durable.updateMessageContent',
      'durable.deleteMessageById',
      'durable.truncateBeforeMessage',
      'durable.truncateAfterMessage',
      'durable.updateMessageAndTruncateAfter',
      'durable.saveMessageHistory',
      'durable.clearRoomMessages',
      'durable.readMessagesByRoom',
      'durable.readMessagePageByRoom',
      'durable.saveImageAsset',
      'durable.replaceMessageImageAsset',
      'durable.getImageAsset',
      'durable.getImageAssetByMessageId',
      'durable.readImageAssetsByRoom',
      'durable.deleteImageAsset',
      'durable.readRoomAICost',
      'durable.incrementRoomAICost',
      'durable.saveRoom',
      'durable.addRoomMember',
      'durable.removeRoomMember',
      'durable.getRoomMember',
      'durable.isRoomMember',
      'durable.readRoomMembers',
      'durable.readRoomsByUser',
      'durable.saveRoomForUser',
      'durable.removeSavedRoomForUser',
      'durable.readSavedRoomsByUser',
      'durable.getRoomById',
      'durable.updateRoomName',
      'durable.deleteRoom',
      'durable.countRooms',
      'realtime.updateRoomMemberCount',
      'realtime.getRoomMemberCount',
      'realtime.clearRealtimeRoomMembers',
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
      ...durableMutationStubs(),
      async saveMessageHistory() { return room(); },
      async clearRoomMessages() { return 0; },
      async readMessagesByRoom() { calls.push('durable.readMessagesByRoom'); return [message({ id: 'durable-message' })]; },
      async readMessagePageByRoom() { return { roomId: 'room-1', messages: [message({ id: 'durable-message' })], historyVersion: 1, hasMore: false }; },
      ...durableImageAssetStubs(),
      async readRoomAICost(roomId: string) { return { roomId, currency: 'USD', totalUsd: 0 }; },
      async incrementRoomAICost(roomId: string) { return { roomId, currency: 'USD', totalUsd: 0 }; },
      async saveRoom(newRoom: Room) { return newRoom; },
      ...durableRoomAccessStubs(),
      async readRoomsByUser() { return []; },
      async getRoomById() { return null; },
      async updateRoomName() { return null; },
      async deleteRoom() {},
      async countRooms() { return 0; },
    };
    const realtime: RealtimeRoomStore = {
      async updateRoomMemberCount() { return 0; },
      async getRoomMemberCount() { return 0; },
      async clearRealtimeRoomMembers() {},
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
      async updateMessageContent() { calls.push('durable.updateMessageContent'); return { room: room(), found: true, updatedMessage: message() }; },
      async deleteMessageById() { calls.push('durable.deleteMessageById'); return { room: room(), deleted: true }; },
      async truncateBeforeMessage() { calls.push('durable.truncateBeforeMessage'); return { room: room(), messages: [message()], targetFound: true }; },
      async truncateAfterMessage() { calls.push('durable.truncateAfterMessage'); return { room: room(), messages: [message()], targetFound: true }; },
      async updateMessageAndTruncateAfter() { calls.push('durable.updateMessageAndTruncateAfter'); return { room: room(), messages: [message()], targetFound: true, updatedMessage: message() }; },
      async saveMessageHistory(_roomId: string) { calls.push('durable.saveHistory'); return room(); },
      async clearRoomMessages(_roomId: string) { calls.push('durable.clear'); return 1; },
      async readMessagesByRoom() { return []; },
      async readMessagePageByRoom() { return { roomId: 'room-1', messages: [], historyVersion: 0, hasMore: false }; },
      ...durableImageAssetStubs(),
      async readRoomAICost(roomId: string) { return { roomId, currency: 'USD', totalUsd: 0 }; },
      async incrementRoomAICost(roomId: string) { return { roomId, currency: 'USD', totalUsd: 0 }; },
      async saveRoom(newRoom: Room) { return newRoom; },
      ...durableRoomAccessStubs(),
      async readRoomsByUser() { return []; },
      async getRoomById() { return null; },
      async updateRoomName() { return null; },
      async deleteRoom() { calls.push('durable.delete'); },
      async countRooms() { return 0; },
      async failInterruptedStreamingMessages() { calls.push('durable.failInterrupted'); return 2; },
    };
    const realtime: RealtimeRoomStore = {
      async updateRoomMemberCount() { return 0; },
      async getRoomMemberCount() { return 0; },
      async clearRealtimeRoomMembers() {},
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
    assert.deepEqual(await store.updateMessageContent('room-1', 'message-1', 'edited'), { room: room(), found: true, updatedMessage: message() });
    assert.deepEqual(await store.deleteMessageById('room-1', 'message-1'), { room: room(), deleted: true });
    assert.deepEqual(await store.truncateBeforeMessage('room-1', 'message-1'), { room: room(), messages: [message()], targetFound: true });
    assert.deepEqual(await store.truncateAfterMessage('room-1', 'message-1'), { room: room(), messages: [message()], targetFound: true });
    assert.deepEqual(await store.updateMessageAndTruncateAfter('room-1', 'message-1', 'edited'), { room: room(), messages: [message()], targetFound: true, updatedMessage: message() });
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
      'durable.updateMessageContent',
      'cache.invalidate:room-1',
      'durable.deleteMessageById',
      'cache.invalidate:room-1',
      'durable.truncateBeforeMessage',
      'cache.invalidate:room-1',
      'durable.truncateAfterMessage',
      'cache.invalidate:room-1',
      'durable.updateMessageAndTruncateAfter',
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

  it('ignores Redis message-cache failures and keeps PostgreSQL durable reads and writes usable', async () => {
    const durable: DurableRoomStore = {
      async generateUniqueRoomId() { return 'room-1'; },
      async appendMessage() { return room(); },
      async upsertMessage() { return room(); },
      ...durableMutationStubs(),
      async saveMessageHistory() { return room(); },
      async clearRoomMessages() { return 0; },
      async readMessagesByRoom() { return [message({ id: 'durable-message' })]; },
      async readMessagePageByRoom() { return { roomId: 'room-1', messages: [message({ id: 'durable-message' })], historyVersion: 1, hasMore: false }; },
      ...durableImageAssetStubs(),
      async readRoomAICost(roomId: string) { return { roomId, currency: 'USD', totalUsd: 0 }; },
      async incrementRoomAICost(roomId: string) { return { roomId, currency: 'USD', totalUsd: 0 }; },
      async saveRoom(newRoom: Room) { return newRoom; },
      ...durableRoomAccessStubs(),
      async readRoomsByUser() { return []; },
      async getRoomById() { return null; },
      async updateRoomName() { return null; },
      async deleteRoom() {},
      async countRooms() { return 0; },
    };
    const realtime: RealtimeRoomStore = {
      async updateRoomMemberCount() { return 0; },
      async getRoomMemberCount() { return 0; },
      async clearRealtimeRoomMembers() {},
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
    assert.deepEqual(await store.upsertMessage(message({ id: 'upsert' })), room());
    assert.deepEqual(await store.saveMessageHistory('room-1', [message({ id: 'history' })]), room());
    assert.equal(await store.clearRoomMessages('room-1'), 0);
  });

  it('runs realtime reset even when durable reset fails', async () => {
    const calls: string[] = [];
    const durable: DurableRoomStore = {
      async generateUniqueRoomId() { return 'room-1'; },
      async appendMessage() { return room(); },
      async upsertMessage() { return room(); },
      ...durableMutationStubs(),
      async saveMessageHistory() { return room(); },
      async clearRoomMessages() { return 0; },
      async readMessagesByRoom() { return []; },
      async readMessagePageByRoom() { return { roomId: 'room-1', messages: [], historyVersion: 0, hasMore: false }; },
      ...durableImageAssetStubs(),
      async readRoomAICost(roomId: string) { return { roomId, currency: 'USD', totalUsd: 0 }; },
      async incrementRoomAICost(roomId: string) { return { roomId, currency: 'USD', totalUsd: 0 }; },
      async saveRoom(newRoom: Room) { return newRoom; },
      ...durableRoomAccessStubs(),
      async readRoomsByUser() { return []; },
      async getRoomById() { return null; },
      async updateRoomName() { return null; },
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
      async clearRealtimeRoomMembers() {},
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
