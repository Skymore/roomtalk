import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { RedisStore } from './redisStore';
import { AICost, MediaAsset, Message, Room } from '../types';

const toTime = (value?: string) => Date.parse(value || '') || 0;
const latest = (first?: string, second?: string) => toTime(first) >= toTime(second) ? first : second;

class MemoryRedis {
  hashes = new Map<string, Map<string, string>>();
  lists = new Map<string, string[]>();
  sets = new Map<string, Set<string>>();
  strings = new Map<string, string>();

  private hash(key: string) {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    return this.hashes.get(key)!;
  }

  private set(key: string) {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    return this.sets.get(key)!;
  }

  private updateRoomActivity(roomId: string, lastActivityAt: string) {
    const roomJson = this.hash('rooms').get(roomId);
    if (!roomJson) {
      return null;
    }

    const parsedRoom = JSON.parse(roomJson);
    const updatedRoom = {
      ...parsedRoom,
      lastActivityAt: latest(parsedRoom.lastActivityAt || parsedRoom.createdAt, lastActivityAt),
      // 镜像 Lua 脚本:每次房间写入自增 roomVersion
      roomVersion: (Number(parsedRoom.roomVersion) || 0) + 1,
    };
    this.hash('rooms').set(roomId, JSON.stringify(updatedRoom));
    return updatedRoom;
  }

  async hExists(key: string, field: string) {
    return this.hash(key).has(field);
  }

  async hSet(key: string, field: string, value: string) {
    this.hash(key).set(field, value);
  }

  async hGet(key: string, field: string) {
    return this.hash(key).get(field);
  }

  async hDel(key: string, field: string) {
    return this.hash(key).delete(field) ? 1 : 0;
  }

  async hLen(key: string) {
    return this.hash(key).size;
  }

  async hKeys(key: string) {
    return Array.from(this.hash(key).keys());
  }

  async rPush(key: string, value: string | string[]) {
    const list = this.lists.get(key) || [];
    if (Array.isArray(value)) {
      list.push(...value);
    } else {
      list.push(value);
    }
    this.lists.set(key, list);
  }

  async lRange(key: string, start: number, stop: number) {
    const list = this.lists.get(key) || [];
    const end = stop === -1 ? list.length : stop + 1;
    return list.slice(start, end);
  }

  async del(key: string | string[]) {
    const keys = Array.isArray(key) ? key : [key];
    let deletedCount = 0;
    for (const item of keys) {
      const deleted = [
        this.hashes.delete(item),
        this.lists.delete(item),
        this.sets.delete(item),
        this.strings.delete(item),
      ].some(Boolean);
      if (deleted) {
        deletedCount++;
      }
    }
    return deletedCount;
  }

  async sAdd(key: string, value: string) {
    this.set(key).add(value);
  }

  async sRem(key: string, value: string) {
    return this.set(key).delete(value) ? 1 : 0;
  }

  async sMembers(key: string) {
    return Array.from(this.set(key));
  }

  async sCard(key: string) {
    return this.set(key).size;
  }

  async get(key: string) {
    return this.strings.get(key);
  }

  async setEx(key: string, _seconds: number, value: string) {
    this.strings.set(key, value);
  }

  async incrByFloat(key: string, value: number) {
    const current = Number.parseFloat(this.strings.get(key) || '0');
    const next = current + value;
    this.strings.set(key, String(next));
    return next;
  }

  async eval(script: string, options: { keys: string[]; arguments: string[] }) {
    // WRITE_ROOM_RECORD_SCRIPT:原子写房间 + roomVersion 以存储值为准自增
    if (script.includes('local incomingJson')) {
      const [roomId, incomingJson] = options.arguments;
      const storedJson = this.hash('rooms').get(roomId);
      let storedVersion = 0;
      if (storedJson) {
        try {
          storedVersion = Number(JSON.parse(storedJson).roomVersion) || 0;
        } catch {
          storedVersion = 0;
        }
      }
      const room = { ...JSON.parse(incomingJson), roomVersion: storedVersion + 1 };
      const encoded = JSON.stringify(room);
      this.hash('rooms').set(roomId, encoded);
      return encoded;
    }

    if (script.includes("redis.call('HSET', KEYS[3]")) {
      const [, messageKey, mediaAssetsKey, roomMediaAssetsKey] = options.keys;
      const [roomId, messagePayload, lastActivityAt, assetId, assetPayload] = options.arguments;
      const updatedRoom = this.updateRoomActivity(roomId, lastActivityAt);
      if (!updatedRoom) {
        return [0, ''];
      }
      const list = this.lists.get(messageKey) || [];
      list.push(messagePayload);
      this.lists.set(messageKey, list);
      this.hash(mediaAssetsKey).set(assetId, assetPayload);
      this.set(roomMediaAssetsKey).add(assetId);
      return [1, JSON.stringify(updatedRoom)];
    }

    if (script.includes('local mediaMessageId')) {
      const [, messageKey] = options.keys;
      const [roomId, messageId, mimeType] = options.arguments;
      const roomJson = this.hash('rooms').get(roomId);
      if (!roomJson) {
        return [0, 0, '', ''];
      }
      const list = this.lists.get(messageKey) || [];
      const index = list.findIndex(item => {
        try {
          const parsed = JSON.parse(item);
          return parsed.id === messageId && parsed.messageType === 'media';
        } catch {
          return false;
        }
      });
      if (index === -1) {
        return [1, 0, roomJson, ''];
      }

      const updatedMessage = { ...JSON.parse(list[index]), content: '', messageType: 'media', mimeType };
      delete updatedMessage.mediaAsset;
      list[index] = JSON.stringify(updatedMessage);
      this.lists.set(messageKey, list);
      return [1, 1, roomJson, list[index]];
    }

    if (script.includes('local messagePayload')) {
      const [, messageKey] = options.keys;
      const [roomId, payload, lastActivityAt] = options.arguments;
      const updatedRoom = this.updateRoomActivity(roomId, lastActivityAt);
      if (!updatedRoom) {
        return [0, ''];
      }
      const list = this.lists.get(messageKey) || [];
      list.push(payload);
      this.lists.set(messageKey, list);
      return [1, JSON.stringify(updatedRoom)];
    }

    if (script.includes('local targetId')) {
      const [, messageKey] = options.keys;
      const [roomId, targetId, payload, lastActivityAt] = options.arguments;
      const updatedRoom = this.updateRoomActivity(roomId, lastActivityAt);
      if (!updatedRoom) {
        return [0, 0, 0, ''];
      }
      const list = this.lists.get(messageKey) || [];
      const index = list.findIndex(item => {
        try {
          return JSON.parse(item).id === targetId;
        } catch {
          return false;
        }
      });
      if (index === -1) {
        list.push(payload);
        this.lists.set(messageKey, list);
        return [1, 0, list.length, JSON.stringify(updatedRoom)];
      }
      list[index] = payload;
      this.lists.set(messageKey, list);
      return [1, 1, list.length, JSON.stringify(updatedRoom)];
    }

    const [, messageKey] = options.keys;
    const [roomId, lastActivityAt, ...messages] = options.arguments;
    const updatedRoom = this.updateRoomActivity(roomId, lastActivityAt);
    if (!updatedRoom) {
      return [0, 0, ''];
    }
    this.lists.set(messageKey, messages);
    return [1, messages.length, JSON.stringify(updatedRoom)];
  }

  async flushDb() {
    this.hashes.clear();
    this.lists.clear();
    this.sets.clear();
    this.strings.clear();
  }

  async *scanIterator(options: { MATCH?: string }) {
    const pattern = options.MATCH || '*';
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const matcher = new RegExp(`^${escaped}$`);
    for (const key of [
      ...this.hashes.keys(),
      ...this.lists.keys(),
      ...this.sets.keys(),
      ...this.strings.keys(),
    ]) {
      if (matcher.test(key)) {
        yield key;
      }
    }
  }

  async keys(pattern: string) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const matcher = new RegExp(`^${escaped}$`);
    return [
      ...this.hashes.keys(),
      ...this.lists.keys(),
      ...this.sets.keys(),
      ...this.strings.keys(),
    ].filter(key => matcher.test(key));
  }
}

class CollisionThenUniqueRedis extends MemoryRedis {
  hExistsCalls = 0;

  async hExists(key: string, field: string) {
    this.hExistsCalls++;
    return this.hExistsCalls <= 5;
  }
}

class FailingDeleteRedis extends MemoryRedis {
  async del(key: string | string[]): Promise<number> {
    throw new Error(`delete failed for ${key}`);
  }
}

class KeysOnlyRedis extends MemoryRedis {
  constructor() {
    super();
    (this as any).scanIterator = undefined;
  }
}

class FailingReplaceRedis extends MemoryRedis {
  async eval(script: string, options: { keys: string[]; arguments: string[] }) {
    if (script.includes('for i = 3, #ARGV do')) {
      throw new Error('replace failed');
    }
    return super.eval(script, options);
  }
}

const logger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
};

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

const mediaAsset = (overrides: Partial<MediaAsset> = {}): MediaAsset => ({
  id: 'asset-1',
  roomId: 'room-1',
  messageId: 'message-1',
  objectKey: 'rooms/room-1/media/image/asset-1',
  kind: 'image',
  mimeType: 'image/webp',
  byteSize: 123,
  createdAt: '2026-05-04T00:00:00.000Z',
  ...overrides,
});

const cost = (totalUsd: number): AICost => ({
  currency: 'USD',
  inputUsd: totalUsd,
  outputUsd: 0,
  totalUsd,
  inputPerMillion: 1,
  outputPerMillion: 1,
  estimated: false,
});

const createStore = () => {
  const redis = new MemoryRedis();
  return { redis, store: new RedisStore(redis as any, logger as any) };
};

describe('RedisStore', () => {
  it('checks fallback room IDs for uniqueness after repeated collisions', async () => {
    const redis = new CollisionThenUniqueRedis();
    const store = new RedisStore(redis as any, logger as any);

    const id = await store.generateUniqueRoomId();

    assert.equal(redis.hExistsCalls, 6);
    assert.equal(id.length, 12);
  });

  it('saves, reads, lists, and deletes rooms with related room state', async () => {
    const { redis, store } = createStore();
    const savedRoom = room();

    const storedRoom = await store.saveRoom(savedRoom);
    assert.ok(storedRoom);
    // 每次房间写入都盖 updatedAt 并自增 roomVersion(客户端 last-write-wins 依赖它们)
    assert.equal(typeof storedRoom.updatedAt, 'string');
    assert.equal(storedRoom.roomVersion, 1);
    assert.deepEqual(storedRoom, { ...savedRoom, roomVersion: 1, updatedAt: storedRoom.updatedAt });
    assert.equal(await store.countRooms(), 1);
    assert.deepEqual(await store.getRoomById('room-1'), storedRoom);
    assert.deepEqual(await store.readRoomsByUser('client-1'), [storedRoom]);
    assert.deepEqual(await store.getRoomMember('room-1', 'client-1'), {
      roomId: 'room-1',
      clientId: 'client-1',
      role: 'owner',
      joinedAt: savedRoom.createdAt,
    });
    assert.equal(await store.isRoomMember('room-1', 'client-1'), true);
    assert.deepEqual(await store.addRoomMember('room-1', 'client-2', 'member', '2026-05-03T00:01:00.000Z'), {
      roomId: 'room-1',
      clientId: 'client-2',
      role: 'member',
      joinedAt: '2026-05-03T00:01:00.000Z',
    });
    assert.deepEqual((await store.readRoomMembers('room-1')).map(member => member.clientId), ['client-1', 'client-2']);
    assert.deepEqual(await store.readRoomsByUser('client-2'), []);
    assert.equal(await store.removeRoomMember('room-1', 'client-1'), false);
    assert.equal(await store.removeRoomMember('room-1', 'client-2'), true);
    assert.equal(await store.isRoomMember('room-1', 'client-2'), false);
    assert.deepEqual(await store.addRoomMember('room-1', 'client-2', 'member', '2026-05-03T00:01:00.000Z'), {
      roomId: 'room-1',
      clientId: 'client-2',
      role: 'member',
      joinedAt: '2026-05-03T00:01:00.000Z',
    });
    assert.deepEqual(await store.saveRoomForUser('room-1', 'client-2', '2026-05-03T00:02:00.000Z'), storedRoom);
    assert.deepEqual(await store.readSavedRoomsByUser('client-2'), [storedRoom]);

    const updatedRoom = await store.appendMessage(message({ timestamp: '2026-05-04T00:00:00.000Z' }));
    assert.equal(updatedRoom?.lastActivityAt, '2026-05-04T00:00:00.000Z');
    assert.deepEqual(await store.readRoomsByUser('client-1'), [updatedRoom]);
    assert.deepEqual(await store.readSavedRoomsByUser('client-2'), [updatedRoom]);
    await store.writeRoomMessagesCache('room-1', [message()]);
    await store.updateRoomMemberCount('room-1', 'client-1', 'socket-1', true);
    await store.incrementRoomAICost('room-1', cost(0.5));
    await store.deleteRoom('room-1', 'client-1');

    assert.equal(await store.countRooms(), 0);
    assert.equal(await store.getRoomById('room-1'), null);
    assert.deepEqual(await store.readMessagesByRoom('room-1'), []);
    assert.equal(await store.readCachedRoomMessages('room-1'), null);
    assert.deepEqual(await store.readRoomsByUser('client-1'), []);
    assert.deepEqual(await store.readRoomsByUser('client-2'), []);
    assert.deepEqual(await store.readSavedRoomsByUser('client-2'), []);
    assert.deepEqual(await store.readRoomMembers('room-1'), []);
    assert.equal(await store.getRoomMemberCount('room-1'), 0);
    assert.equal(redis.sets.has('room:room-1:member_sockets:client-1'), false);
    assert.equal(await redis.get(store.getRoomAICostKey('room-1')), undefined);
  });

  it('lists user rooms by most recent activity first', async () => {
    const { store } = createStore();
    const olderRoom = room({ id: 'older-room', lastActivityAt: '2026-05-03T00:00:00.000Z' });
    const newerRoom = room({ id: 'newer-room', lastActivityAt: '2026-05-05T00:00:00.000Z' });

    await store.saveRoom(olderRoom);
    await store.saveRoom(newerRoom);

    assert.deepEqual((await store.readRoomsByUser('client-1')).map(item => item.id), ['newer-room', 'older-room']);
  });

  it('appends media messages and assets together', async () => {
    const { store } = createStore();
    await store.saveRoom(room());

    const result = await store.appendMediaMessageWithAsset(
      message({ content: '', messageType: 'media', mimeType: 'image/webp', timestamp: '2026-05-04T00:00:00.000Z' }),
      mediaAsset({ width: 20, height: 10, uploadedByClientId: 'client-1' })
    );

    assert.equal(result?.room.lastActivityAt, '2026-05-04T00:00:00.000Z');
    assert.deepEqual(result?.message.mediaAsset, {
      id: 'asset-1',
      kind: 'image',
      mimeType: 'image/webp',
      byteSize: 123,
      width: 20,
      height: 10,
    });
    assert.deepEqual(await store.getMediaAsset('asset-1'), mediaAsset({ width: 20, height: 10, uploadedByClientId: 'client-1' }));
    assert.deepEqual(await store.readMediaAssetsByRoom('room-1'), [mediaAsset({ width: 20, height: 10, uploadedByClientId: 'client-1' })]);
    assert.deepEqual((await store.readMessagesByRoom('room-1'))[0]?.mediaAsset, {
      id: 'asset-1',
      kind: 'image',
      mimeType: 'image/webp',
      byteSize: 123,
      width: 20,
      height: 10,
    });
  });


  it('logs and swallows Redis delete failures when deleting a room', async () => {
    const errors: any[] = [];
    const testLogger = {
      debug() {},
      warn() {},
      error(message: string, payload: any) {
        errors.push({ message, payload });
      },
    };
    const store = new RedisStore(new FailingDeleteRedis() as any, testLogger as any);

    await assert.doesNotReject(() => store.deleteRoom('room-1', 'client-1'));

    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'Error deleting room from Redis');
    assert.equal(errors[0].payload.roomId, 'room-1');
    assert.equal(errors[0].payload.creatorId, 'client-1');
  });

  it('appends, overwrites, and clears room message history', async () => {
    const { store } = createStore();
    const first = message({ id: 'm1', content: 'first' });
    const second = message({ id: 'm2', content: 'second' });
    const replacement = message({ id: 'm3', content: 'replacement' });

    await store.saveRoom(room());
    await store.appendMessage(first);
    await store.appendMessage(second);
    assert.deepEqual(await store.readMessagesByRoom('room-1'), [first, second]);

    await store.upsertMessage(message({ id: 'm2', content: 'updated second', timestamp: '2026-05-05T00:00:00.000Z' }));
    assert.deepEqual(await store.readMessagesByRoom('room-1'), [
      first,
      message({ id: 'm2', content: 'updated second', timestamp: '2026-05-05T00:00:00.000Z' }),
    ]);

    await store.upsertMessage(message({ id: 'm4', content: 'inserted' }));
    assert.deepEqual(await store.readMessagesByRoom('room-1'), [
      first,
      message({ id: 'm2', content: 'updated second', timestamp: '2026-05-05T00:00:00.000Z' }),
      message({ id: 'm4', content: 'inserted' }),
    ]);

    await store.saveMessageHistory('room-1', [replacement]);
    assert.deepEqual(await store.readMessagesByRoom('room-1'), [replacement]);

    assert.equal(await store.clearRoomMessages('room-1'), 1);
    assert.deepEqual(await store.readMessagesByRoom('room-1'), []);
  });

  it('stores media assets and attaches metadata to media messages', async () => {
    const { store } = createStore();
    const baseRoom = room();
    const asset = {
      id: 'asset-1',
      roomId: 'room-1',
      messageId: 'media-message',
      objectKey: 'rooms/room-1/media/image/asset-1',
      kind: 'image' as const,
      mimeType: 'image/webp',
      byteSize: 123,
      width: 10,
      height: 20,
      createdAt: '2026-05-03T00:00:00.000Z',
    };

    await store.saveRoom(baseRoom);
    assert.deepEqual(await store.saveMediaAsset(asset), asset);
    assert.deepEqual(await store.getMediaAsset('asset-1'), asset);
    assert.deepEqual(await store.getMediaAssetByMessageId('media-message'), asset);
    assert.deepEqual(await store.readMediaAssetsByRoom('room-1'), [asset]);

    await store.appendMessage(message({
      id: 'media-message',
      content: '',
      messageType: 'media',
      mimeType: 'image/webp',
    }));

    assert.deepEqual(await store.readMessagesByRoom('room-1'), [
      message({
        id: 'media-message',
        content: '',
        messageType: 'media',
        mimeType: 'image/webp',
        mediaAsset: {
          id: 'asset-1',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: 123,
          width: 10,
          height: 20,
        },
      }),
    ]);

    await store.deleteMediaAsset('asset-1');
    assert.equal(await store.getMediaAsset('asset-1'), null);
    assert.deepEqual(await store.readMediaAssetsByRoom('room-1'), []);
  });

  it('replaces legacy base64 image messages with media asset metadata', async () => {
    const { store } = createStore();
    const baseRoom = room({ lastActivityAt: '2026-05-03T00:00:10.000Z' });
    const legacyImage = message({
      id: 'legacy-image',
      content: '',
      messageType: 'media',
      mimeType: 'image/png',
      timestamp: '2026-05-03T00:00:01.000Z',
    });
    const asset = {
      id: 'asset-legacy',
      roomId: 'room-1',
      messageId: 'legacy-image',
      objectKey: 'rooms/room-1/media/image/asset-legacy',
      kind: 'image' as const,
      mimeType: 'image/webp',
      byteSize: 456,
      width: 12,
      height: 14,
      createdAt: '2026-05-03T00:00:11.000Z',
    };

    await store.saveRoom(baseRoom);
    await store.appendMessage(legacyImage);

    const result = await store.replaceMessageMediaAsset('room-1', 'legacy-image', asset);

    assert.equal(result?.found, true);
    assert.ok(result?.room);
    const { updatedAt: roomUpdatedAt, roomVersion: resultRoomVersion, ...roomRest } = result.room;
    assert.equal(typeof roomUpdatedAt, 'string');
    assert.equal(typeof resultRoomVersion, 'number');
    assert.deepEqual(roomRest, baseRoom);
    assert.deepEqual(result?.updatedMessage, {
      ...legacyImage,
      content: '',
      messageType: 'media',
      mimeType: 'image/webp',
      mediaAsset: {
        id: 'asset-legacy',
        kind: 'image',
        mimeType: 'image/webp',
        byteSize: 456,
        width: 12,
        height: 14,
      },
    });
    const roomAfterReplace = await store.getRoomById('room-1');
    assert.ok(roomAfterReplace);
    const { updatedAt: replaceRoomUpdatedAt, roomVersion: replaceRoomVersion, ...roomAfterReplaceRest } = roomAfterReplace;
    assert.equal(typeof replaceRoomUpdatedAt, 'string');
    assert.equal(typeof replaceRoomVersion, 'number');
    assert.deepEqual(roomAfterReplaceRest, baseRoom);
    assert.deepEqual(await store.readMessagesByRoom('room-1'), [result?.updatedMessage]);

    const missingResult = await store.replaceMessageMediaAsset('room-1', 'missing', {
      ...asset,
      id: 'missing-asset',
      objectKey: 'rooms/room-1/media/image/missing-asset',
    });
    assert.equal(missingResult?.found, false);
    assert.equal(await store.getMediaAsset('missing-asset'), null);
  });

  it('does not create orphan message lists for missing rooms', async () => {
    const { redis, store } = createStore();
    const missingRoomMessage = message({ roomId: 'missing-room' });

    assert.equal(await store.appendMessage(missingRoomMessage), null);
    assert.deepEqual(await redis.lRange('room:missing-room:messages', 0, -1), []);

    assert.equal(await store.upsertMessage(missingRoomMessage), null);
    assert.deepEqual(await redis.lRange('room:missing-room:messages', 0, -1), []);

    assert.equal(await store.saveMessageHistory('missing-room', [missingRoomMessage]), null);
    assert.deepEqual(await redis.lRange('room:missing-room:messages', 0, -1), []);
  });

  it('tracks AI cost totals and ignores empty, invalid, or non-positive increments', async () => {
    const { redis, store } = createStore();

    assert.deepEqual(await store.readRoomAICost('room-1'), { roomId: 'room-1', currency: 'USD', totalUsd: 0 });
    assert.deepEqual(await store.incrementRoomAICost('room-1', null), { roomId: 'room-1', currency: 'USD', totalUsd: 0 });
    assert.deepEqual(await store.incrementRoomAICost('room-1', cost(-1)), { roomId: 'room-1', currency: 'USD', totalUsd: 0 });

    assert.deepEqual(await store.incrementRoomAICost('room-1', cost(0.25)), { roomId: 'room-1', currency: 'USD', totalUsd: 0.25 });
    assert.deepEqual(await store.incrementRoomAICost('room-1', cost(0.5)), { roomId: 'room-1', currency: 'USD', totalUsd: 0.75 });

    redis.strings.set(store.getRoomAICostKey('room-bad'), 'not-a-number');
    assert.deepEqual(await store.readRoomAICost('room-bad'), { roomId: 'room-bad', currency: 'USD', totalUsd: 0 });
  });

  it('reads, writes, and invalidates room message caches', async () => {
    const { redis, store } = createStore();
    const cachedMessages = [message({ id: 'cached-message' })];
    const cacheKey = store.getRoomMessagesCacheKey('room-1');

    assert.equal(await store.readCachedRoomMessages('room-1'), null);

    await store.writeRoomMessagesCache('room-1', cachedMessages);
    assert.equal(typeof await redis.get(cacheKey), 'string');
    assert.deepEqual(await store.readCachedRoomMessages('room-1'), cachedMessages);

    await store.invalidateRoomMessagesCache('room-1');
    assert.equal(await store.readCachedRoomMessages('room-1'), null);

    await store.writeRoomMessagesCache('room-1', cachedMessages);
    await store.writeRoomMessagesCache('room-2', [message({ id: 'cached-message-2', roomId: 'room-2' })]);
    await store.invalidateAllRoomMessagesCaches();

    assert.equal(await store.readCachedRoomMessages('room-1'), null);
    assert.equal(await store.readCachedRoomMessages('room-2'), null);
  });

  it('falls back to KEYS when scanIterator is unavailable during full cache invalidation', async () => {
    const redis = new KeysOnlyRedis();
    const store = new RedisStore(redis as any, logger as any);

    await store.writeRoomMessagesCache('room-1', [message({ id: 'cached-message-1' })]);
    await store.writeRoomMessagesCache('room-2', [message({ id: 'cached-message-2', roomId: 'room-2' })]);

    await store.invalidateAllRoomMessagesCaches();

    assert.equal(await store.readCachedRoomMessages('room-1'), null);
    assert.equal(await store.readCachedRoomMessages('room-2'), null);
  });

  it('tracks member counts, client sessions, and per-socket room membership', async () => {
    const { store } = createStore();

    assert.equal(await store.updateRoomMemberCount('room-1', 'client-1', 'socket-1', true), 1);
    assert.equal(await store.updateRoomMemberCount('room-1', 'client-1', 'socket-2', true), 1);
    assert.equal(await store.updateRoomMemberCount('room-1', 'client-2', 'socket-3', true), 2);
    assert.equal(await store.getRoomMemberCount('room-1'), 2);
    assert.equal(await store.updateRoomMemberCount('room-1', 'client-1', 'socket-1', false), 2);
    assert.equal(await store.updateRoomMemberCount('room-1', 'client-1', 'socket-2', false), 1);

    await store.storeClientSession('socket-1', 'client-1');
    assert.equal(await store.getClientId('socket-1'), 'client-1');
    await store.removeClientSession('socket-1');
    assert.equal(await store.getClientId('socket-1'), null);

    await store.storeUserRooms('socket-1', ['room-1', 'room-2']);
    assert.deepEqual(await store.getUserRooms('socket-1'), ['room-1', 'room-2']);
    await store.storeUserRooms('socket-1', []);
    assert.deepEqual(await store.getUserRooms('socket-1'), []);
  });

  it('clears realtime room member state without deleting persistent room members', async () => {
    const { redis, store } = createStore();

    await store.saveRoom(room());
    await store.addRoomMember('room-1', 'client-2', 'member', '2026-05-03T00:01:00.000Z');
    await store.updateRoomMemberCount('room-1', 'client-1', 'socket-1', true);
    await store.updateRoomMemberCount('room-1', 'client-1', 'socket-2', true);
    await store.updateRoomMemberCount('room-1', 'client-2', 'socket-3', true);

    assert.equal(await store.getRoomMemberCount('room-1'), 2);
    assert.deepEqual(await redis.sMembers('room:room-1:member_sockets:client-1'), ['socket-1', 'socket-2']);

    await store.clearRealtimeRoomMembers();

    assert.equal(await store.getRoomMemberCount('room-1'), 0);
    assert.deepEqual(await redis.sMembers('room:room-1:member_sockets:client-1'), []);
    assert.deepEqual(
      (await store.readRoomMembers('room-1')).map(member => member.clientId),
      ['client-1', 'client-2']
    );
  });

  it('returns online room members resolved to their stored nicknames', async () => {
    const { store } = createStore();

    await store.saveRoom(room());
    await store.addRoomMember('room-1', 'client-2', 'member', '2026-05-03T00:01:00.000Z');
    await store.setClientNickname('client-1', 'Ada');
    await store.setClientNickname('client-2', 'Grace');
    await store.updateRoomMemberCount('room-1', 'client-1', 'socket-1', true);
    await store.updateRoomMemberCount('room-1', 'client-2', 'socket-2', true);

    const members = await store.getRoomOnlineMembers('room-1');
    const byClient = new Map(members.map(member => [member.clientId, member.nickname]));

    assert.equal(members.length, 2);
    assert.equal(byClient.get('client-1'), 'Ada');
    assert.equal(byClient.get('client-2'), 'Grace');
  });

  it('returns online members without nicknames when none were stored', async () => {
    const { store } = createStore();

    await store.saveRoom(room());
    await store.updateRoomMemberCount('room-1', 'client-1', 'socket-1', true);

    assert.deepEqual(await store.getRoomOnlineMembers('room-1'), [
      { clientId: 'client-1', nickname: undefined },
    ]);
  });

  it('resets all Redis test data through the store abstraction', async () => {
    const { store } = createStore();

    await store.saveRoom(room());
    await store.appendMessage(message());
    await store.storeClientSession('socket-1', 'client-1');

    await store.resetAllDataForTests();

    assert.equal(await store.countRooms(), 0);
    assert.deepEqual(await store.readMessagesByRoom('room-1'), []);
    assert.equal(await store.getClientId('socket-1'), null);
  });

  it('marks interrupted streaming messages as errors on startup recovery', async () => {
    const { store } = createStore();
    const streamingMessage = message({ id: 'm1', status: 'streaming', content: '' });
    const completeMessage = message({ id: 'm2', status: 'complete', content: 'done' });
    await store.saveRoom(room());
    await store.saveMessageHistory('room-1', [
      streamingMessage,
      completeMessage,
    ]);
    await store.writeRoomMessagesCache('room-1', [streamingMessage, completeMessage]);

    assert.equal(await store.failInterruptedStreamingMessages('Response interrupted.'), 1);
    assert.equal(await store.readCachedRoomMessages('room-1'), null);

    const recoveredMessages = await store.readMessagesByRoom('room-1');
    assert.notEqual(recoveredMessages[0].timestamp, streamingMessage.timestamp);
    assert.deepEqual(recoveredMessages, [
      {
        ...streamingMessage,
        status: 'error',
        content: 'Response interrupted.',
        timestamp: recoveredMessages[0].timestamp,
      },
      completeMessage,
    ]);
  });

  it('does not count interrupted streaming messages when recovery persistence fails', async () => {
    const redis = new FailingReplaceRedis();
    const store = new RedisStore(redis as any, logger as any);
    const streamingMessage = message({ id: 'm1', status: 'streaming', content: '' });

    await store.saveRoom(room());
    await redis.rPush('room:room-1:messages', JSON.stringify(streamingMessage));

    assert.equal(await store.failInterruptedStreamingMessages('Response interrupted.'), 0);
    assert.deepEqual(await store.readMessagesByRoom('room-1'), [streamingMessage]);
  });

  it('returns safe fallbacks when stored JSON cannot be parsed', async () => {
    const { redis, store } = createStore();

    await redis.rPush('room:room-1:messages', '{invalid');
    await redis.hSet('rooms', 'room-1', '{invalid');
    await redis.hSet('socket:rooms', 'socket-1', '{invalid');

    assert.deepEqual(await store.readMessagesByRoom('room-1'), []);
    assert.equal(await store.getRoomById('room-1'), null);
    assert.deepEqual(await store.getUserRooms('socket-1'), []);
  });
});
