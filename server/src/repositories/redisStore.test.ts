import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { RedisStore } from './redisStore';
import { AICost, Message, Room } from '../types';

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

  async del(key: string) {
    const deleted = [
      this.hashes.delete(key),
      this.lists.delete(key),
      this.sets.delete(key),
      this.strings.delete(key),
    ].some(Boolean);
    return deleted ? 1 : 0;
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

  async incrByFloat(key: string, value: number) {
    const current = Number.parseFloat(this.strings.get(key) || '0');
    const next = current + value;
    this.strings.set(key, String(next));
    return next;
  }
}

const logger = {
  debug() {},
  error() {},
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
  it('saves, reads, lists, and deletes rooms with related room state', async () => {
    const { redis, store } = createStore();
    const savedRoom = room();

    assert.deepEqual(await store.saveRoom(savedRoom), savedRoom);
    assert.deepEqual(await store.getRoomById('room-1'), savedRoom);
    assert.deepEqual(await store.readRoomsByUser('client-1'), [savedRoom]);

    await store.appendMessage(message());
    await store.updateRoomMemberCount('room-1', 'client-1', true);
    await store.incrementRoomAICost('room-1', cost(0.5));
    await store.deleteRoom('room-1', 'client-1');

    assert.equal(await store.getRoomById('room-1'), null);
    assert.deepEqual(await store.readMessagesByRoom('room-1'), []);
    assert.deepEqual(await store.readRoomsByUser('client-1'), []);
    assert.equal(await store.getRoomMemberCount('room-1'), 0);
    assert.equal(await redis.get(store.getRoomAICostKey('room-1')), undefined);
  });

  it('appends, overwrites, and clears room message history', async () => {
    const { store } = createStore();
    const first = message({ id: 'm1', content: 'first' });
    const second = message({ id: 'm2', content: 'second' });
    const replacement = message({ id: 'm3', content: 'replacement' });

    await store.appendMessage(first);
    await store.appendMessage(second);
    assert.deepEqual(await store.readMessagesByRoom('room-1'), [first, second]);

    await store.saveMessageHistory('room-1', [replacement]);
    assert.deepEqual(await store.readMessagesByRoom('room-1'), [replacement]);

    assert.equal(await store.clearRoomMessages('room-1'), 1);
    assert.deepEqual(await store.readMessagesByRoom('room-1'), []);
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

  it('tracks member counts, client sessions, and per-socket room membership', async () => {
    const { store } = createStore();

    assert.equal(await store.updateRoomMemberCount('room-1', 'client-1', true), 1);
    assert.equal(await store.updateRoomMemberCount('room-1', 'client-1', true), 1);
    assert.equal(await store.updateRoomMemberCount('room-1', 'client-2', true), 2);
    assert.equal(await store.getRoomMemberCount('room-1'), 2);
    assert.equal(await store.updateRoomMemberCount('room-1', 'client-1', false), 1);

    await store.storeClientSession('socket-1', 'client-1');
    assert.equal(await store.getClientId('socket-1'), 'client-1');
    await store.removeClientSession('socket-1');
    assert.equal(await store.getClientId('socket-1'), null);

    await store.storeUserRooms('socket-1', ['room-1', 'room-2']);
    assert.deepEqual(await store.getUserRooms('socket-1'), ['room-1', 'room-2']);
    await store.storeUserRooms('socket-1', []);
    assert.deepEqual(await store.getUserRooms('socket-1'), []);
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
