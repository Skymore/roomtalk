import assert from 'assert/strict';
import { describe, it } from 'node:test';
import {
  migrateRedisToPostgres,
  RedisMigrationSource,
  RedisToPostgresMigrationSource,
  RedisToPostgresMigrationTarget,
} from './migrateRedisToPostgres';
import { Message, Room, RoomAICostTotal } from '../types';

const room = (overrides: Partial<Room> = {}): Room => ({
  id: 'room-1',
  name: 'Room 1',
  description: '',
  createdAt: '2026-05-03T00:00:00.000Z',
  lastActivityAt: '2026-05-03T00:00:00.000Z',
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

class MemoryMigrationSource implements RedisToPostgresMigrationSource {
  constructor(
    readonly rooms: Room[],
    readonly messagesByRoom: Map<string, Message[]>,
    readonly costsByRoom = new Map<string, RoomAICostTotal>()
  ) {}

  async readRooms() {
    return this.rooms;
  }

  async readMessagesByRoom(roomId: string) {
    return this.messagesByRoom.get(roomId) || [];
  }

  async readRoomAICost(roomId: string) {
    return this.costsByRoom.get(roomId) || { roomId, currency: 'USD', totalUsd: 0 };
  }
}

class MemoryMigrationTarget implements RedisToPostgresMigrationTarget {
  rooms = new Map<string, Room>();
  messagesByRoom = new Map<string, Message[]>();
  costsByRoom = new Map<string, number>();
  calls: string[] = [];

  async saveRoom(newRoom: Room) {
    this.calls.push(`saveRoom:${newRoom.id}`);
    this.rooms.set(newRoom.id, newRoom);
    return newRoom;
  }

  async saveMessageHistory(roomId: string, messages: Message[]) {
    this.calls.push(`saveMessages:${roomId}:${messages.length}`);
    this.messagesByRoom.set(roomId, messages);
    return this.rooms.get(roomId) || null;
  }

  async setRoomAICostTotal(roomId: string, totalUsd: number) {
    this.calls.push(`setCost:${roomId}:${totalUsd}`);
    if (totalUsd <= 0) {
      this.costsByRoom.delete(roomId);
      return { roomId, currency: 'USD' as const, totalUsd: 0 };
    }
    this.costsByRoom.set(roomId, totalUsd);
    return { roomId, currency: 'USD' as const, totalUsd };
  }
}

class LimitFailingRedisList {
  constructor(
    readonly messages: string[],
    readonly failFullRangeThreshold: number
  ) {}

  async hKeys() {
    return ['room-1'];
  }

  async hGet(_key: string, field: string) {
    return field === 'room-1' ? JSON.stringify(room()) : null;
  }

  async lRange(_key: string, start: number, stop: number) {
    if (start === 0 && stop === -1 && this.messages.length > this.failFullRangeThreshold) {
      throw new Error('Response size exceeds Upstash limit');
    }
    const end = stop === -1 ? this.messages.length : stop + 1;
    return this.messages.slice(start, end);
  }

  async lLen() {
    return this.messages.length;
  }

  async lIndex(_key: string, index: number) {
    return this.messages[index] ?? null;
  }

  async get() {
    return null;
  }
}

class BrokenFallbackRedisList extends LimitFailingRedisList {
  async lLen(): Promise<number> {
    throw new Error('fallback length read failed');
  }
}

class UnusedRedisStore {
  async readRoomAICost(roomId: string) {
    return { roomId, currency: 'USD' as const, totalUsd: 0 };
  }
}

const logger = {
  info() {},
  error() {},
  warn() {},
};

describe('migrateRedisToPostgres', () => {
  it('does not write to the target during dry-run and still reports source counts', async () => {
    const source = new MemoryMigrationSource(
      [room()],
      new Map([['room-1', [message(), message({ id: 'message-2' })]]]),
      new Map([['room-1', { roomId: 'room-1', currency: 'USD', totalUsd: 0.5 }]])
    );
    const target = new MemoryMigrationTarget();

    const stats = await migrateRedisToPostgres({ source, target, dryRun: true });

    assert.deepEqual(stats, {
      dryRun: true,
      roomsRead: 1,
      roomsWritten: 0,
      roomsFailed: 0,
      messagesRead: 2,
      messagesWritten: 0,
      costsRead: 1,
      costsWritten: 0,
      failures: [],
    });
    assert.deepEqual(target.calls, []);
  });

  it('migrates rooms, messages, and exact cost totals idempotently', async () => {
    const source = new MemoryMigrationSource(
      [room(), room({ id: 'room-2', name: 'Room 2' })],
      new Map([
        ['room-1', [message()]],
        ['room-2', [message({ id: 'message-2', roomId: 'room-2' })]],
      ]),
      new Map([
        ['room-1', { roomId: 'room-1', currency: 'USD', totalUsd: 0.5 }],
        ['room-2', { roomId: 'room-2', currency: 'USD', totalUsd: 0 }],
      ])
    );
    const target = new MemoryMigrationTarget();

    const firstRun = await migrateRedisToPostgres({ source, target });
    const secondRun = await migrateRedisToPostgres({ source, target });

    assert.equal(firstRun.roomsWritten, 2);
    assert.equal(firstRun.messagesWritten, 2);
    assert.equal(firstRun.costsWritten, 2);
    assert.equal(secondRun.roomsWritten, 2);
    assert.equal(secondRun.messagesWritten, 2);
    assert.equal(secondRun.costsWritten, 2);
    assert.equal(target.rooms.size, 2);
    assert.deepEqual(target.messagesByRoom.get('room-1')?.map(item => item.id), ['message-1']);
    assert.deepEqual(target.messagesByRoom.get('room-2')?.map(item => item.id), ['message-2']);
    assert.equal(target.costsByRoom.get('room-1'), 0.5);
    assert.equal(target.costsByRoom.has('room-2'), false);
  });

  it('records failures and continues with later rooms', async () => {
    const source = new MemoryMigrationSource(
      [room(), room({ id: 'room-2' })],
      new Map([
        ['room-1', [message()]],
        ['room-2', [message({ id: 'message-2', roomId: 'room-2' })]],
      ])
    );
    const target = new MemoryMigrationTarget();
    target.saveMessageHistory = async (roomId: string, messages: Message[]) => {
      target.calls.push(`saveMessages:${roomId}:${messages.length}`);
      return roomId === 'room-1' ? null : target.rooms.get(roomId) || null;
    };

    const stats = await migrateRedisToPostgres({ source, target });

    assert.equal(stats.roomsRead, 2);
    assert.equal(stats.roomsWritten, 1);
    assert.equal(stats.roomsFailed, 1);
    assert.deepEqual(stats.failures, [{
      roomId: 'room-1',
      stage: 'save_messages',
      error: 'Target rejected message history save',
    }]);
    assert.deepEqual(target.messagesByRoom.get('room-2'), undefined);
    assert.equal(target.costsByRoom.has('room-1'), false);
    assert.equal(target.costsByRoom.has('room-2'), false);
  });

  it('records thrown target write failures and keeps migrating later rooms', async () => {
    const source = new MemoryMigrationSource(
      [room(), room({ id: 'room-2' }), room({ id: 'room-3' })],
      new Map([
        ['room-1', [message()]],
        ['room-2', [message({ id: 'message-2', roomId: 'room-2' })]],
        ['room-3', [message({ id: 'message-3', roomId: 'room-3' })]],
      ])
    );
    const target = new MemoryMigrationTarget();
    target.saveRoom = async (newRoom: Room) => {
      target.calls.push(`saveRoom:${newRoom.id}`);
      if (newRoom.id === 'room-1') {
        throw new Error('room write failed');
      }
      target.rooms.set(newRoom.id, newRoom);
      return newRoom;
    };
    target.saveMessageHistory = async (roomId: string, messages: Message[]) => {
      target.calls.push(`saveMessages:${roomId}:${messages.length}`);
      if (roomId === 'room-2') {
        throw new Error('message write failed');
      }
      target.messagesByRoom.set(roomId, messages);
      return target.rooms.get(roomId) || null;
    };

    const stats = await migrateRedisToPostgres({ source, target });

    assert.equal(stats.roomsRead, 3);
    assert.equal(stats.roomsWritten, 1);
    assert.equal(stats.roomsFailed, 2);
    assert.deepEqual(stats.failures, [
      { roomId: 'room-1', stage: 'save_room', error: 'room write failed' },
      { roomId: 'room-2', stage: 'save_messages', error: 'message write failed' },
    ]);
    assert.deepEqual(target.messagesByRoom.get('room-3')?.map(item => item.id), ['message-3']);
    assert.equal(target.costsByRoom.has('room-3'), false);
  });

  it('falls back to index-by-index Redis reads when full message list reads exceed provider limits', async () => {
    const sourceMessages = Array.from({ length: 105 }, (_, index) => message({
      id: `message-${index.toString().padStart(3, '0')}`,
      content: `message ${index}`,
      timestamp: new Date(Date.UTC(2026, 4, 3, 0, 0, index)).toISOString(),
    }));
    const redisClient = new LimitFailingRedisList(
      sourceMessages.map(item => JSON.stringify(item)),
      100
    );
    const source = new RedisMigrationSource(redisClient as any, new UnusedRedisStore() as any, logger as any);
    const target = new MemoryMigrationTarget();

    const stats = await migrateRedisToPostgres({ source, target });

    assert.equal(stats.roomsWritten, 1);
    assert.equal(stats.messagesRead, sourceMessages.length);
    assert.equal(stats.messagesWritten, sourceMessages.length);
    assert.deepEqual(
      target.messagesByRoom.get('room-1')?.map(item => item.id),
      sourceMessages.map(item => item.id)
    );
    assert.deepEqual(
      target.messagesByRoom.get('room-1')?.map(item => item.content),
      sourceMessages.map(item => item.content)
    );

    const secondRun = await migrateRedisToPostgres({ source, target });
    assert.equal(secondRun.messagesWritten, sourceMessages.length);
    assert.deepEqual(
      target.messagesByRoom.get('room-1')?.map(item => item.id),
      sourceMessages.map(item => item.id)
    );
  });

  it('records a room data failure when the Redis fallback read path also fails', async () => {
    const sourceMessages = Array.from({ length: 3 }, (_, index) => message({ id: `message-${index}` }));
    const redisClient = new BrokenFallbackRedisList(
      sourceMessages.map(item => JSON.stringify(item)),
      1
    );
    const source = new RedisMigrationSource(redisClient as any, new UnusedRedisStore() as any, logger as any);
    const target = new MemoryMigrationTarget();

    const stats = await migrateRedisToPostgres({ source, target });

    assert.equal(stats.roomsRead, 1);
    assert.equal(stats.roomsFailed, 1);
    assert.equal(stats.roomsWritten, 0);
    assert.deepEqual(stats.failures, [{
      roomId: 'room-1',
      stage: 'read_room_data',
      error: 'fallback length read failed',
    }]);
    assert.deepEqual(target.calls, []);
  });
});
