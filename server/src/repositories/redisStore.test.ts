import assert from 'assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_ROOM_MESSAGES_CACHE_MAX_BYTES,
  RedisStore,
  resolveRoomMessagesCacheMaxBytes,
} from './redisStore';
import { AICost, MediaAsset, Message, Room, RoomAgentTurn } from '../types';
import { OutboxEventRecord } from './store';

const toTime = (value?: string) => Date.parse(value || '') || 0;
const latest = (first?: string, second?: string) => toTime(first) >= toTime(second) ? first : second;

class MemoryRedis {
  hashes = new Map<string, Map<string, string>>();
  lists = new Map<string, string[]>();
  sets = new Map<string, Set<string>>();
  zsets = new Map<string, Map<string, number>>();
  strings = new Map<string, string>();

  private hash(key: string) {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    return this.hashes.get(key)!;
  }

  private set(key: string) {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    return this.sets.get(key)!;
  }

  private zset(key: string) {
    if (!this.zsets.has(key)) this.zsets.set(key, new Map());
    return this.zsets.get(key)!;
  }

  private rebuildClientMessageIds(messageKey: string, clientMessageIdsKey?: string) {
    if (!clientMessageIdsKey) return;
    this.hashes.delete(clientMessageIdsKey);
    const index = this.hash(clientMessageIdsKey);
    index.set('__roomtalk_index_ready__', '1');
    for (const payload of this.lists.get(messageKey) || []) {
      try {
        const item = JSON.parse(payload) as Message;
        if (item.clientMessageId) {
          const field = `${item.clientId.length}:${item.clientId}${item.clientMessageId}`;
          if (!index.has(field)) index.set(field, item.id);
        }
      } catch {
        // Invalid legacy list entries do not participate in idempotency.
      }
    }
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
        this.zsets.delete(item),
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

  async zAdd(key: string, memberOrMembers: { score: number; value: string } | Array<{ score: number; value: string }>) {
    const members = Array.isArray(memberOrMembers) ? memberOrMembers : [memberOrMembers];
    const zset = this.zset(key);
    for (const member of members) {
      zset.set(member.value, member.score);
    }
    return members.length;
  }

  async zCard(key: string) {
    return this.zset(key).size;
  }

  async zRange(key: string, start: number | string, stop: number | string, options?: { REV?: true; LIMIT?: { offset: number; count: number } }) {
    const toScore = (value: number | string) => {
      if (value === '+inf') return Number.POSITIVE_INFINITY;
      if (value === '-inf') return Number.NEGATIVE_INFINITY;
      return Number(value);
    };
    const startScore = toScore(start);
    const stopScore = toScore(stop);
    const minScore = Math.min(startScore, stopScore);
    const maxScore = Math.max(startScore, stopScore);
    const sorted = Array.from(this.zset(key).entries())
      .filter(([, score]) => score >= minScore && score <= maxScore)
      .sort((first, second) => options?.REV
        ? second[1] - first[1] || second[0].localeCompare(first[0])
        : first[1] - second[1] || first[0].localeCompare(second[0]))
      .map(([value]) => value);
    const offset = options?.LIMIT?.offset ?? 0;
    const count = options?.LIMIT?.count ?? sorted.length;
    return sorted.slice(offset, offset + count);
  }

  async zRangeByScore(key: string, min: number | string, max: number | string, options?: { LIMIT?: { offset: number; count: number } }) {
    return this.zRange(key, min, max, options);
  }

  async zRem(key: string, value: string) {
    return this.zset(key).delete(value) ? 1 : 0;
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

    if (script.includes('local passwordMode = ARGV[3]')) {
      const [
        roomId,
        updatedAt,
        passwordMode,
        passwordHash,
        postingScheduleMode,
        postingScheduleJson,
        codeAgentAccessMode,
        codeAgentAccess,
        codeAgentModeMode,
        codeAgentMode,
        codeAgentBackendMode,
        codeAgentBackend,
      ] = options.arguments;
      const roomJson = this.hash('rooms').get(roomId);
      if (!roomJson) {
        return '';
      }
      const room = JSON.parse(roomJson);
      if (passwordMode === 'set') {
        this.strings.set(options.keys[1], passwordHash);
        room.hasPassword = true;
      } else if (passwordMode === 'clear') {
        this.strings.delete(options.keys[1]);
        delete room.hasPassword;
      }
      if (postingScheduleMode === 'set') {
        room.postingSchedule = JSON.parse(postingScheduleJson);
      } else if (postingScheduleMode === 'clear') {
        delete room.postingSchedule;
      }
      if (codeAgentAccessMode === 'set') {
        room.codeAgentAccess = codeAgentAccess;
      } else if (codeAgentAccessMode === 'clear') {
        delete room.codeAgentAccess;
      }
      if (codeAgentModeMode === 'set') {
        room.codeAgentMode = codeAgentMode;
      } else if (codeAgentModeMode === 'clear') {
        delete room.codeAgentMode;
      }
      if (codeAgentBackendMode === 'set') {
        room.codeAgentBackend = codeAgentBackend;
      } else if (codeAgentBackendMode === 'clear') {
        delete room.codeAgentBackend;
      }
      const updatedRoom = {
        ...room,
        updatedAt,
        roomVersion: (Number(room.roomVersion) || 0) + 1,
      };
      const encoded = JSON.stringify(updatedRoom);
      this.hash('rooms').set(roomId, encoded);
      return encoded;
    }

    if (script.includes('local expectedCreatorId = ARGV[2]')) {
      const [roomId, creatorId, name, updatedAt] = options.arguments;
      const roomJson = this.hash('rooms').get(roomId);
      if (!roomJson) {
        return [0, ''];
      }
      const room = JSON.parse(roomJson);
      if (room.creatorId !== creatorId) {
        return [2, room.creatorId || ''];
      }
      const updatedRoom = {
        ...room,
        name,
        updatedAt,
        roomVersion: (Number(room.roomVersion) || 0) + 1,
      };
      const encoded = JSON.stringify(updatedRoom);
      this.hash('rooms').set(roomId, encoded);
      return [1, encoded];
    }

    if (script.includes('local clientId = ARGV[1]')) {
      const [roomMembersKey, clientSocketsKey] = options.keys;
      const [clientId, socketId, isJoining] = options.arguments;
      if (isJoining === '1') {
        this.set(clientSocketsKey).add(socketId);
        this.set(roomMembersKey).add(clientId);
      } else {
        this.set(clientSocketsKey).delete(socketId);
        if (this.set(clientSocketsKey).size === 0) {
          await this.del(clientSocketsKey);
          this.set(roomMembersKey).delete(clientId);
        }
      }
      return this.set(roomMembersKey).size;
    }

    if (script.includes('local dedupeField = ARGV[4]')) {
      const [roomsKey, messageKey, clientMessageIdsKey] = options.keys;
      const [roomId, payload, lastActivityAt, dedupeField, messageId] = options.arguments;
      const roomJson = this.hash(roomsKey).get(roomId);
      if (!roomJson) return [0, '', ''];
      if (dedupeField) {
        const index = this.hash(clientMessageIdsKey);
        const existingId = index.get(dedupeField);
        if (!existingId && !index.has('__roomtalk_index_ready__')) {
          this.rebuildClientMessageIds(messageKey, clientMessageIdsKey);
        }
        const indexedId = this.hash(clientMessageIdsKey).get(dedupeField);
        const existingPayload = indexedId && (this.lists.get(messageKey) || []).find(item => {
          try {
            return JSON.parse(item).id === indexedId;
          } catch {
            return false;
          }
        });
        if (existingPayload) return [2, roomJson, existingPayload];
      }
      const updatedRoom = this.updateRoomActivity(roomId, lastActivityAt);
      if (!updatedRoom) return [0, '', ''];
      const list = this.lists.get(messageKey) || [];
      list.push(payload);
      this.lists.set(messageKey, list);
      if (dedupeField) {
        this.hash(clientMessageIdsKey).set(dedupeField, messageId);
        this.hash(clientMessageIdsKey).set('__roomtalk_index_ready__', '1');
      }
      return [1, JSON.stringify(updatedRoom), payload];
    }

    if (script.includes("redis.call('ZADD', KEYS[5]")) {
      const [, messageKey, mediaAssetsKey, roomMediaAssetsKey, roomMediaAssetsTimelineKey] = options.keys;
      const [roomId, messagePayload, lastActivityAt, assetId, assetPayload, assetScore] = options.arguments;
      const updatedRoom = this.updateRoomActivity(roomId, lastActivityAt);
      if (!updatedRoom) {
        return [0, ''];
      }
      const list = this.lists.get(messageKey) || [];
      list.push(messagePayload);
      this.lists.set(messageKey, list);
      this.hash(mediaAssetsKey).set(assetId, assetPayload);
      this.set(roomMediaAssetsKey).add(assetId);
      this.zset(roomMediaAssetsTimelineKey).set(assetId, Number(assetScore));
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

    if (script.includes("queued['state'] = 'starting'")) {
      const [, messageKey] = options.keys;
      const [roomId, updatedAt] = options.arguments;
      const roomJson = this.hash('rooms').get(roomId);
      if (!roomJson) return [0, 0, '', ''];
      const list = this.lists.get(messageKey) || [];
      const index = list.findIndex(item => JSON.parse(item).codeAgentQueuedInput?.state === 'queued');
      if (index === -1) return [1, 0, roomJson, ''];
      const message = JSON.parse(list[index]);
      message.codeAgentQueuedInput = { ...message.codeAgentQueuedInput, state: 'starting', updatedAt };
      delete message.codeAgentQueuedInput.lastError;
      message.updatedAt = updatedAt;
      list[index] = JSON.stringify(message);
      const updatedRoom = this.updateRoomActivity(roomId, JSON.parse(roomJson).lastActivityAt);
      return [1, 1, JSON.stringify(updatedRoom), list[index]];
    }

    if (script.includes("decoded['updatedAt'] = ARGV[5]") && script.includes('codeAgentQueuedInput')) {
      const [, messageKey] = options.keys;
      const [roomId, messageId, expectedState, queuedJson, updatedAt, contentMode, content] = options.arguments;
      const roomJson = this.hash('rooms').get(roomId);
      if (!roomJson) return [0, 0, '', ''];
      const list = this.lists.get(messageKey) || [];
      const index = list.findIndex(item => {
        const parsed = JSON.parse(item);
        return parsed.id === messageId && parsed.codeAgentQueuedInput?.state === expectedState;
      });
      if (index === -1) return [1, 0, roomJson, ''];
      const message = JSON.parse(list[index]);
      if (queuedJson) message.codeAgentQueuedInput = JSON.parse(queuedJson);
      else delete message.codeAgentQueuedInput;
      message.updatedAt = updatedAt;
      if (contentMode === '1') message.content = content;
      list[index] = JSON.stringify(message);
      const updatedRoom = this.updateRoomActivity(roomId, JSON.parse(roomJson).lastActivityAt);
      return [1, 1, JSON.stringify(updatedRoom), list[index]];
    }

    if (script.includes("queued['state'] == ARGV[3]") && script.includes('local remaining = {}')) {
      const [, messageKey] = options.keys;
      const [roomId, messageId, expectedState] = options.arguments;
      const roomJson = this.hash('rooms').get(roomId);
      if (!roomJson) return [0, 0, '', 0];
      const list = this.lists.get(messageKey) || [];
      const index = list.findIndex(item => {
        const parsed = JSON.parse(item);
        return parsed.id === messageId && parsed.codeAgentQueuedInput?.state === expectedState;
      });
      if (index === -1) return [1, 0, roomJson, list.length];
      list.splice(index, 1);
      this.lists.set(messageKey, list);
      const updatedRoom = this.updateRoomActivity(roomId, JSON.parse(roomJson).lastActivityAt);
      return [1, 1, JSON.stringify(updatedRoom), list.length];
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
      const [, messageKey, clientMessageIdsKey] = options.keys;
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
        this.rebuildClientMessageIds(messageKey, clientMessageIdsKey);
        return [1, 0, list.length, JSON.stringify(updatedRoom)];
      }
      list[index] = payload;
      this.lists.set(messageKey, list);
      this.rebuildClientMessageIds(messageKey, clientMessageIdsKey);
      return [1, 1, list.length, JSON.stringify(updatedRoom)];
    }

    if (script.includes('return { 1, #ARGV - 1 }')) {
      const [, messageKey, clientMessageIdsKey] = options.keys;
      const [roomId, ...messages] = options.arguments;
      if (!this.hash('rooms').has(roomId)) {
        return [0, 0];
      }
      this.lists.set(messageKey, messages);
      this.rebuildClientMessageIds(messageKey, clientMessageIdsKey);
      return [1, messages.length];
    }

    const [, messageKey, clientMessageIdsKey] = options.keys;
    const [roomId, lastActivityAt, ...messages] = options.arguments;
    const updatedRoom = this.updateRoomActivity(roomId, lastActivityAt);
    if (!updatedRoom) {
      return [0, 0, ''];
    }
    this.lists.set(messageKey, messages);
    this.rebuildClientMessageIds(messageKey, clientMessageIdsKey);
    return [1, messages.length, JSON.stringify(updatedRoom)];
  }

  async flushDb() {
    this.hashes.clear();
    this.lists.clear();
    this.sets.clear();
    this.zsets.clear();
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
      ...this.zsets.keys(),
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
      ...this.zsets.keys(),
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
    if (script.includes('for i = 3, #ARGV do') || script.includes('return { 1, #ARGV - 1 }')) {
      throw new Error('replace failed');
    }
    return super.eval(script, options);
  }
}

class ConcurrentRoomMutationRedis extends MemoryRedis {
  private nextMutation: { roomId: string; mutate: (room: Room) => Room } | null = null;

  mutateBeforeNextRoomEval(roomId: string, mutate: (room: Room) => Room) {
    this.nextMutation = { roomId, mutate };
  }

  async eval(script: string, options: { keys: string[]; arguments: string[] }) {
    const roomId = options.keys[0] === 'rooms' ? options.arguments[0] : '';
    if (this.nextMutation && roomId === this.nextMutation.roomId) {
      const rooms = this.hashes.get('rooms');
      const roomJson = rooms?.get(roomId);
      if (roomJson) {
        rooms!.set(roomId, JSON.stringify(this.nextMutation.mutate(JSON.parse(roomJson) as Room)));
      }
      this.nextMutation = null;
    }

    return super.eval(script, options);
  }
}

class FailingMemberSocketCountRedis extends MemoryRedis {
  async sCard(key: string) {
    if (key.includes(':member_sockets:')) {
      throw new Error('member socket counts must be updated atomically');
    }
    return super.sCard(key);
  }
}

class FailingRoomScanRedis extends MemoryRedis {
  async hKeys(key: string) {
    if (key === 'rooms') {
      throw new Error('readRoomsByUser must use the per-user owner index');
    }
    return super.hKeys(key);
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

const outboxEvent = (overrides: Partial<OutboxEventRecord> = {}): OutboxEventRecord => ({
  id: 'event-1',
  eventType: 'test.event',
  aggregateType: 'test',
  aggregateId: 'aggregate-1',
  payload: {},
  status: 'pending',
  attempts: 0,
  availableAt: '2026-06-22T00:00:00.000Z',
  createdAt: '2026-06-22T00:00:00.000Z',
  updatedAt: '2026-06-22T00:00:00.000Z',
  ...overrides,
});

const createStore = () => {
  const redis = new MemoryRedis();
  return { redis, store: new RedisStore(redis as any, logger as any) };
};

describe('RedisStore', () => {
  it('uses a safe default maximum for room message cache payloads', () => {
    assert.equal(resolveRoomMessagesCacheMaxBytes({}), DEFAULT_ROOM_MESSAGES_CACHE_MAX_BYTES);
    assert.equal(resolveRoomMessagesCacheMaxBytes({ ROOM_MESSAGES_CACHE_MAX_BYTES: '4096' }), 4096);
    assert.equal(resolveRoomMessagesCacheMaxBytes({ ROOM_MESSAGES_CACHE_MAX_BYTES: 'invalid' }), DEFAULT_ROOM_MESSAGES_CACHE_MAX_BYTES);
  });

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

  it('merges Redis room name and settings updates atomically against concurrent room field changes', async () => {
    const schedule = {
      enabled: true,
      timezone: 'America/Los_Angeles',
      windows: [{ days: [1, 2, 3], start: '09:00', end: '17:00' }],
    };

    const renameRedis = new ConcurrentRoomMutationRedis();
    const renameStore = new RedisStore(renameRedis as any, logger as any);
    await renameStore.saveRoom(room({ name: 'Original Room' }));
    renameRedis.mutateBeforeNextRoomEval('room-1', current => ({
      ...current,
      postingSchedule: schedule,
      hasPassword: true,
    }));

    const renamed = await renameStore.updateRoomName('room-1', 'client-1', 'Renamed Room');

    assert.equal(renamed?.name, 'Renamed Room');
    assert.deepEqual(renamed?.postingSchedule, schedule);
    assert.equal(renamed?.hasPassword, true);

    const settingsRedis = new ConcurrentRoomMutationRedis();
    const settingsStore = new RedisStore(settingsRedis as any, logger as any);
    await settingsStore.saveRoom(room({ name: 'Original Room' }));
    settingsRedis.mutateBeforeNextRoomEval('room-1', current => ({
      ...current,
      name: 'Concurrent Rename',
    }));

    const settingsUpdated = await settingsStore.updateRoomSettings('room-1', {
      passwordHash: 'secret-hash',
      postingSchedule: schedule,
      codeAgentBackend: 'codex',
    });

    assert.equal(settingsUpdated?.name, 'Concurrent Rename');
    assert.deepEqual(settingsUpdated?.postingSchedule, schedule);
    assert.equal(settingsUpdated?.codeAgentBackend, 'codex');
    assert.equal(settingsUpdated?.hasPassword, true);
    assert.equal(await settingsStore.readRoomPasswordHash('room-1'), 'secret-hash');
  });

  it('lists user rooms by most recent activity first', async () => {
    const { store } = createStore();
    const olderRoom = room({ id: 'older-room', lastActivityAt: '2026-05-03T00:00:00.000Z' });
    const newerRoom = room({ id: 'newer-room', lastActivityAt: '2026-05-05T00:00:00.000Z' });

    await store.saveRoom(olderRoom);
    await store.saveRoom(newerRoom);

    assert.deepEqual((await store.readRoomsByUser('client-1')).map(item => item.id), ['newer-room', 'older-room']);
  });

  it('reads user rooms from the owner index and prunes stale entries', async () => {
    const redis = new FailingRoomScanRedis();
    const store = new RedisStore(redis as any, logger as any);
    const olderRoom = room({ id: 'older-room', lastActivityAt: '2026-05-03T00:00:00.000Z' });
    const newerRoom = room({ id: 'newer-room', lastActivityAt: '2026-05-05T00:00:00.000Z' });
    const foreignRoom = room({ id: 'foreign-room', creatorId: 'client-2' });

    await store.saveRoom(olderRoom);
    await store.saveRoom(newerRoom);
    await redis.hSet('rooms', foreignRoom.id, JSON.stringify(foreignRoom));
    await redis.sAdd('user:client-1:rooms', foreignRoom.id);
    await redis.sAdd('user:client-1:rooms', 'missing-room');

    assert.deepEqual((await store.readRoomsByUser('client-1')).map(item => item.id), ['newer-room', 'older-room']);
    assert.deepEqual(await redis.sMembers('user:client-1:rooms'), ['older-room', 'newer-room']);
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

  it('claims, transitions, finds, and deletes queued code-agent messages atomically', async () => {
    const { store } = createStore();
    const queuedInput = {
      state: 'queued' as const,
      queuedAt: '2026-05-04T00:00:00.000Z',
      updatedAt: '2026-05-04T00:00:00.000Z',
      selectedModel: {
        id: 'deepseek-v4-pro',
        apiModel: 'deepseek-v4-pro',
        provider: 'deepseek' as const,
        label: 'DeepSeek V4 Pro',
        description: 'Test model',
      },
    };
    await store.saveRoom(room({ type: 'codeAgent' }));
    await store.appendMessage(message({ id: 'queued-1', content: 'first', codeAgentQueuedInput: queuedInput }));

    assert.deepEqual(await store.findRoomsWithQueuedCodeAgentMessages(), ['room-1']);
    const claimed = await store.claimNextCodeAgentQueuedMessage('room-1', '2026-05-04T00:00:01.000Z');
    assert.equal(claimed?.message.codeAgentQueuedInput?.state, 'starting');

    const requeued = await store.updateCodeAgentQueuedMessage('room-1', 'queued-1', {
      expectedState: 'starting',
      content: 'edited',
      updatedAt: '2026-05-04T00:00:02.000Z',
      queuedInput: { ...queuedInput, updatedAt: '2026-05-04T00:00:02.000Z' },
    });
    assert.equal(requeued?.updatedMessage?.content, 'edited');
    assert.equal(requeued?.updatedMessage?.codeAgentQueuedInput?.state, 'queued');

    assert.equal((await store.deleteCodeAgentQueuedMessage('room-1', 'queued-1'))?.deleted, true);
    assert.deepEqual(await store.readMessagesByRoom('room-1'), []);
  });

  it('backfills a legacy client message id before resolving a retry', async () => {
    const { redis, store } = createStore();
    const legacy = message({
      id: 'legacy-canonical',
      clientMessageId: 'legacy-client-message',
      content: 'already persisted',
    });
    await store.saveRoom(room());
    await redis.rPush('room:room-1:messages', JSON.stringify(legacy));
    const versionBeforeRetry = (await store.getRoomById('room-1'))?.roomVersion;

    const result = await store.appendMessageIdempotent(message({
      id: 'retry-server-id',
      clientMessageId: legacy.clientMessageId,
      content: 'must not duplicate',
    }));

    assert.equal(result?.inserted, false);
    assert.deepEqual(result?.message, legacy);
    assert.equal(result?.room.roomVersion, versionBeforeRetry);
    assert.deepEqual(await store.readMessagesByRoom('room-1'), [legacy]);
    assert.equal(
      await redis.hGet('room:room-1:client_message_ids', '8:client-1legacy-client-message'),
      legacy.id,
    );
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

  it('reads media history pages from the room media timeline', async () => {
    const { store } = createStore();
    const imageNew = mediaAsset({ id: 'image-new', createdAt: '2026-06-03T00:00:00.000Z' });
    const videoNew = mediaAsset({
      id: 'video-new',
      kind: 'video',
      mimeType: 'video/mp4',
      objectKey: 'rooms/room-1/media/video/video-new',
      createdAt: '2026-06-02T00:00:00.000Z',
    });
    const audioHidden = mediaAsset({
      id: 'audio-hidden',
      kind: 'audio',
      mimeType: 'audio/webm',
      objectKey: 'rooms/room-1/media/audio/audio-hidden',
      createdAt: '2026-06-04T00:00:00.000Z',
    });
    const oldHidden = mediaAsset({ id: 'old-hidden', createdAt: '2025-01-01T00:00:00.000Z' });

    await store.saveMediaAsset(imageNew);
    await store.saveMediaAsset(videoNew);
    await store.saveMediaAsset(audioHidden);
    await store.saveMediaAsset(oldHidden);

    const firstPage = await store.readMediaHistoryPageByRoom('room-1', {
      limit: 1,
      since: '2026-01-01T00:00:00.000Z',
      kinds: ['image', 'video'],
    });
    assert.deepEqual(firstPage.assets.map(asset => asset.id), ['image-new']);
    assert.equal(firstPage.hasMore, true);

    const secondPage = await store.readMediaHistoryPageByRoom('room-1', {
      limit: 10,
      since: '2026-01-01T00:00:00.000Z',
      before: { createdAt: imageNew.createdAt, assetId: imageNew.id },
      kinds: ['image', 'video'],
    });
    assert.deepEqual(secondPage.assets.map(asset => asset.id), ['video-new']);
    assert.equal(secondPage.hasMore, false);
  });

  it('backfills missing Redis media timeline entries from legacy room asset sets', async () => {
    const { redis, store } = createStore();
    const legacyAsset = mediaAsset({ id: 'legacy-image', createdAt: '2026-06-03T00:00:00.000Z' });

    await redis.hSet('media_assets', legacyAsset.id, JSON.stringify(legacyAsset));
    await redis.sAdd('room:room-1:media_assets', legacyAsset.id);

    const page = await store.readMediaHistoryPageByRoom('room-1', {
      limit: 10,
      since: '2026-01-01T00:00:00.000Z',
      kinds: ['image', 'video'],
    });

    assert.deepEqual(page.assets, [legacyAsset]);
    assert.equal(page.hasMore, false);
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

  it('does not reclaim terminally failed outbox events', async () => {
    const { store } = createStore();
    const saved = await store.createOutboxEvent(outboxEvent());
    assert.ok(saved);

    const claimed = await store.claimOutboxEvents({
      workerId: 'worker-1',
      now: '2026-06-22T00:00:01.000Z',
      lockMs: 60_000,
    });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].status, 'processing');
    assert.equal(claimed[0].attempts, 1);

    const failed = await store.markOutboxEventFailed('event-1', 'boom', {
      maxAttempts: 1,
      now: '2026-06-22T00:00:02.000Z',
    });
    assert.equal(failed?.status, 'failed');

    const reclaimed = await store.claimOutboxEvents({
      workerId: 'worker-2',
      now: '2026-06-22T00:00:03.000Z',
      lockMs: 60_000,
    });
    assert.deepEqual(reclaimed, []);
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

  it('skips room message caches that exceed the configured byte limit', async () => {
    const redis = new MemoryRedis();
    const store = new RedisStore(redis as any, logger as any, 30, 256);
    const cacheKey = store.getRoomMessagesCacheKey('room-1');

    await store.writeRoomMessagesCache('room-1', [message({ content: 'x'.repeat(512) })], 1);

    assert.equal(await redis.get(cacheKey), undefined);
  });

  it('compacts duplicate tool fields in room message caches and restores them on read', async () => {
    const { redis, store } = createStore();
    const cacheKey = store.getRoomMessagesCacheKey('room-1');
    const toolArgs = { command: 'printf hello' };
    const toolCall = message({
      id: 'tool-call',
      messageType: 'tool_call',
      toolCallId: 'call-1',
      toolName: 'shell',
      toolArgs,
      content: `shell ${JSON.stringify(toolArgs, null, 2)}`,
    });
    const toolResult = message({
      id: 'tool-result',
      messageType: 'tool_result',
      toolCallId: 'call-1',
      toolName: 'shell',
      content: 'hello',
      toolOutputPreview: 'hello',
    });

    await store.writeRoomMessagesCache('room-1', [toolCall, toolResult], 2);

    const raw = JSON.parse((await redis.get(cacheKey)) as string);
    assert.equal(raw.messages[0].content, undefined);
    assert.equal(raw.messages[1].toolOutputPreview, undefined);
    assert.deepEqual(await store.readCachedRoomMessages('room-1', 2), [toolCall, toolResult]);
  });

  it('validates room message caches by message version', async () => {
    const { redis, store } = createStore();
    const cachedMessages = [message({ id: 'cached-message' })];
    const cacheKey = store.getRoomMessagesCacheKey('room-1');

    await store.writeRoomMessagesCache('room-1', cachedMessages, 2);

    const raw = await redis.get(cacheKey);
    assert.equal(typeof raw, 'string');
    assert.deepEqual(JSON.parse(raw as string), { messageVersion: 2, messages: cachedMessages });
    assert.deepEqual(await store.readCachedRoomMessages('room-1', 2), cachedMessages);

    assert.equal(await store.readCachedRoomMessages('room-1', 3), null);
    assert.equal(await redis.get(cacheKey), undefined);

    redis.strings.set(cacheKey, JSON.stringify(cachedMessages));
    assert.equal(await store.readCachedRoomMessages('room-1', 2), null);
    assert.equal(await redis.get(cacheKey), undefined);
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

    await store.storeClientSession('socket-1', 'client-1', 'browser-1');
    assert.equal(await store.getClientId('socket-1'), 'client-1');
    assert.equal(await store.getBrowserInstanceId('socket-1'), 'browser-1');
    await store.removeClientSession('socket-1');
    assert.equal(await store.getClientId('socket-1'), null);
    assert.equal(await store.getBrowserInstanceId('socket-1'), null);

    await store.updateRoomBrowserPresence('room-1', 'browser-1', 'socket-1', true);
    await store.updateRoomBrowserPresence('room-1', 'browser-1', 'socket-2', true);
    await store.updateRoomBrowserPresence('room-1', 'browser-2', 'socket-3', true);
    assert.deepEqual((await store.getRoomActiveBrowserInstanceIds('room-1')).sort(), ['browser-1', 'browser-2']);
    await store.updateRoomBrowserPresence('room-1', 'browser-1', 'socket-1', false);
    assert.deepEqual((await store.getRoomActiveBrowserInstanceIds('room-1')).sort(), ['browser-1', 'browser-2']);
    await store.updateRoomBrowserPresence('room-1', 'browser-1', 'socket-2', false);
    assert.deepEqual(await store.getRoomActiveBrowserInstanceIds('room-1'), ['browser-2']);

    await store.storeUserRooms('socket-1', ['room-1', 'room-2']);
    assert.deepEqual(await store.getUserRooms('socket-1'), ['room-1', 'room-2']);
    await store.storeUserRooms('socket-1', []);
    assert.deepEqual(await store.getUserRooms('socket-1'), []);
  });

  it('updates per-socket room membership without non-atomic socket count reads', async () => {
    const redis = new FailingMemberSocketCountRedis();
    const store = new RedisStore(redis as any, logger as any);

    assert.equal(await store.updateRoomMemberCount('room-1', 'client-1', 'socket-1', true), 1);
    assert.equal(await store.updateRoomMemberCount('room-1', 'client-1', 'socket-2', true), 1);
    assert.equal(await store.updateRoomMemberCount('room-1', 'client-1', 'socket-1', false), 1);
    assert.deepEqual(await redis.sMembers('room:room-1:member_sockets:client-1'), ['socket-2']);
    assert.equal(await store.getRoomMemberCount('room-1'), 1);
  });

  it('clears realtime room member state without deleting persistent room members', async () => {
    const { redis, store } = createStore();

    await store.saveRoom(room());
    await store.addRoomMember('room-1', 'client-2', 'member', '2026-05-03T00:01:00.000Z');
    await store.updateRoomMemberCount('room-1', 'client-1', 'socket-1', true);
    await store.updateRoomMemberCount('room-1', 'client-1', 'socket-2', true);
    await store.updateRoomMemberCount('room-1', 'client-2', 'socket-3', true);
    await store.updateRoomBrowserPresence('room-1', 'browser-1', 'socket-1', true);

    assert.equal(await store.getRoomMemberCount('room-1'), 2);
    assert.deepEqual(await redis.sMembers('room:room-1:member_sockets:client-1'), ['socket-1', 'socket-2']);

    await store.clearRealtimeRoomMembers();

    assert.equal(await store.getRoomMemberCount('room-1'), 0);
    assert.deepEqual(await redis.sMembers('room:room-1:member_sockets:client-1'), []);
    assert.deepEqual(await store.getRoomActiveBrowserInstanceIds('room-1'), []);
    assert.deepEqual(await redis.sMembers('room:room-1:browser_instance_sockets:browser-1'), []);
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

  it('tracks and claims expired pending media uploads', async () => {
    const { store } = createStore();
    const upload = {
      assetId: 'pending-1',
      roomId: 'room-1',
      objectKey: 'rooms/room-1/media/image/pending-1',
      kind: 'image' as const,
      mimeType: 'image/webp',
      byteSize: 123,
      uploadedByClientId: 'client-1',
      createdAt: '2026-05-03T00:00:00.000Z',
      expiresAt: '2026-05-03T00:30:00.000Z',
    };

    await store.savePendingMediaUpload(upload);

    assert.deepEqual(await store.getPendingMediaUpload(upload.assetId), upload);
    assert.deepEqual(await store.claimExpiredPendingMediaUploads('2026-05-03T00:29:59.000Z'), []);
    assert.deepEqual(await store.claimExpiredPendingMediaUploads('2026-05-03T00:30:00.000Z'), [upload]);
    assert.equal(await store.getPendingMediaUpload(upload.assetId), null);
  });

  it('resets all Redis test data through the store abstraction', async () => {
    const { store } = createStore();

    await store.saveRoom(room());
    await store.appendMessage(message());
    await store.storeClientSession('socket-1', 'client-1', 'browser-1');

    await store.resetAllDataForTests();

    assert.equal(await store.countRooms(), 0);
    assert.deepEqual(await store.readMessagesByRoom('room-1'), []);
    assert.equal(await store.getClientId('socket-1'), null);
    assert.equal(await store.getBrowserInstanceId('socket-1'), null);
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
    const roomBeforeRecovery = await store.getRoomById('room-1');

    assert.equal(await store.failInterruptedStreamingMessages('Response interrupted.'), 1);
    assert.equal(await store.readCachedRoomMessages('room-1'), null);
    assert.deepEqual(await store.getRoomById('room-1'), roomBeforeRecovery);

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

  it('only recovers interrupted streaming messages for the requested owner', async () => {
    const { store } = createStore();
    const ownedStreamingMessage = {
      ...message({ id: 'm1', status: 'streaming', content: '' }),
      aiStreamOwnerId: 'owner-1',
    } as Message;
    const otherStreamingMessage = {
      ...message({ id: 'm2', status: 'streaming', content: 'still running' }),
      aiStreamOwnerId: 'owner-2',
    } as Message;
    const unownedStreamingMessage = message({ id: 'm3', status: 'streaming', content: 'legacy running' });
    await store.saveRoom(room());
    await store.saveMessageHistory('room-1', [
      ownedStreamingMessage,
      otherStreamingMessage,
      unownedStreamingMessage,
    ]);

    assert.equal(await store.failInterruptedStreamingMessages('Response interrupted.', { aiStreamOwnerId: 'owner-1' }), 1);

    const recoveredMessages = await store.readMessagesByRoom('room-1');
    assert.equal(recoveredMessages[0].status, 'error');
    assert.equal(recoveredMessages[0].content, 'Response interrupted.');
    assert.equal((recoveredMessages[0] as any).aiStreamOwnerId, undefined);
    assert.equal(recoveredMessages[1].status, 'streaming');
    assert.equal(recoveredMessages[1].content, 'still running');
    assert.equal((recoveredMessages[1] as any).aiStreamOwnerId, undefined);
    assert.equal(recoveredMessages[2].status, 'streaming');
    assert.equal(recoveredMessages[2].content, 'legacy running');
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

  it('persists room agent turn metadata and recovers running turns', async () => {
    const { store } = createStore();
    const turn: RoomAgentTurn = {
      id: 'turn-1',
      roomId: 'room-1',
      status: 'running',
      startedAt: '2026-05-03T00:00:00.000Z',
      backend: 'codex-app-server',
      assistantName: 'Codex',
      phase: 'preparing_sandbox',
      phaseMessage: 'Connecting to the workspace',
      lastHeartbeatAt: '2026-05-03T00:00:00.000Z',
      updatedAt: '2026-05-03T00:00:00.000Z',
    };

    assert.deepEqual(await store.upsertRoomAgentTurn(turn), turn);
    assert.deepEqual(await store.readRoomAgentTurns('room-1', ['turn-1']), [turn]);
    assert.equal(await store.failInterruptedRoomAgentTurns('2026-05-03T00:01:00.000Z'), 1);
    const { phase: _phase, phaseMessage: _phaseMessage, ...turnWithoutPhase } = turn;
    assert.deepEqual(await store.readRoomAgentTurns('room-1'), [{
      ...turnWithoutPhase,
      status: 'error',
      lastHeartbeatAt: '2026-05-03T00:01:00.000Z',
      completedAt: '2026-05-03T00:01:00.000Z',
      updatedAt: '2026-05-03T00:01:00.000Z',
    }]);
  });
});
