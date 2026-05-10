import { customAlphabet } from 'nanoid';
import { RedisClientType } from 'redis';
import { Logger } from '../logger';
import { AICost, Message, Room, RoomAICostTotal } from '../types';
import { RoomMessageCacheStore, RoomStore } from './store';

const nanoid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 10);
const DEFAULT_ROOM_MESSAGES_CACHE_TTL_SECONDS = 30;
const ROOM_MESSAGES_CACHE_KEY_PREFIX = 'cache:room:';
const ROOM_MESSAGES_CACHE_KEY_SUFFIX = ':messages';

export const resolveRoomMessagesCacheTtlSeconds = (env: NodeJS.ProcessEnv = process.env): number => {
  const rawValue = env.ROOM_MESSAGES_CACHE_TTL_SECONDS;
  if (!rawValue) {
    return DEFAULT_ROOM_MESSAGES_CACHE_TTL_SECONDS;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const APPEND_MESSAGE_LIST_SCRIPT = `
local roomJson = redis.call('HGET', KEYS[1], ARGV[1])
if not roomJson then
  return { 0, '' }
end

local ok, room = pcall(cjson.decode, roomJson)
if not ok then
  return { 0, '' }
end

local currentLastActivityAt = room['lastActivityAt'] or room['createdAt'] or ''
if ARGV[3] > currentLastActivityAt then
  room['lastActivityAt'] = ARGV[3]
end
local messagePayload = ARGV[2]
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(room))
redis.call('RPUSH', KEYS[2], messagePayload)
return { 1, cjson.encode(room) }
`;

const REPLACE_MESSAGE_LIST_SCRIPT = `
local roomJson = redis.call('HGET', KEYS[1], ARGV[1])
if not roomJson then
  return { 0, 0, '' }
end

local ok, room = pcall(cjson.decode, roomJson)
if not ok then
  return { 0, 0, '' }
end

room['lastActivityAt'] = ARGV[2]
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(room))
redis.call('DEL', KEYS[2])
for i = 3, #ARGV do
  redis.call('RPUSH', KEYS[2], ARGV[i])
end
return { 1, #ARGV - 2, cjson.encode(room) }
`;

const UPSERT_MESSAGE_LIST_SCRIPT = `
local roomJson = redis.call('HGET', KEYS[1], ARGV[1])
if not roomJson then
  return { 0, 0, 0, '' }
end

local roomOk, room = pcall(cjson.decode, roomJson)
if not roomOk then
  return { 0, 0, 0, '' }
end

local existing = redis.call('LRANGE', KEYS[2], 0, -1)
local targetId = ARGV[2]
local payload = ARGV[3]
local found = 0

for i = 1, #existing do
  local ok, decoded = pcall(cjson.decode, existing[i])
  if ok and decoded['id'] == targetId then
    existing[i] = payload
    found = 1
    break
  end
end

if found == 0 then
  table.insert(existing, payload)
end

local currentLastActivityAt = room['lastActivityAt'] or room['createdAt'] or ''
if ARGV[4] > currentLastActivityAt then
  room['lastActivityAt'] = ARGV[4]
end
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(room))
redis.call('DEL', KEYS[2])
for i = 1, #existing do
  redis.call('RPUSH', KEYS[2], existing[i])
end

return { 1, found, #existing, cjson.encode(room) }
`;

const parseTime = (timestamp?: string): number => {
  const time = Date.parse(timestamp || '');
  return Number.isFinite(time) ? time : 0;
};

const getRoomActivityTime = (room: Room): number => parseTime(room.lastActivityAt || room.createdAt);

const getLatestMessageTimestamp = (messages: Message[]): string | undefined => {
  return messages.reduce<string | undefined>((latest, message) => {
    if (!latest || parseTime(message.timestamp) > parseTime(latest)) {
      return message.timestamp;
    }

    return latest;
  }, undefined);
};

const parseScriptRoom = (result: unknown, index: number): Room | null => {
  if (!Array.isArray(result) || Number(result[0]) !== 1 || typeof result[index] !== 'string' || !result[index]) {
    return null;
  }

  try {
    return JSON.parse(result[index]) as Room;
  } catch {
    return null;
  }
};

export class RedisStore implements RoomStore, RoomMessageCacheStore {
  constructor(
    private readonly redisClient: RedisClientType,
    private readonly logger: Logger,
    private readonly roomMessagesCacheTtlSeconds = resolveRoomMessagesCacheTtlSeconds()
  ) {}

  getRoomMessagesCacheKey(roomId: string): string {
    return `${ROOM_MESSAGES_CACHE_KEY_PREFIX}${roomId}${ROOM_MESSAGES_CACHE_KEY_SUFFIX}`;
  }

  async readCachedRoomMessages(roomId: string): Promise<Message[] | null> {
    const cacheKey = this.getRoomMessagesCacheKey(roomId);
    try {
      const cached = await this.redisClient.get(cacheKey);
      if (!cached) {
        this.logger.debug('Room message cache miss', { roomId });
        return null;
      }

      const parsed = JSON.parse(cached);
      if (!Array.isArray(parsed)) {
        await this.redisClient.del(cacheKey);
        this.logger.warn('Invalid room message cache payload discarded', { roomId });
        return null;
      }

      this.logger.debug('Room message cache hit', { roomId, count: parsed.length });
      return parsed as Message[];
    } catch (error) {
      this.logger.error('Error reading room message cache', { error, roomId });
      return null;
    }
  }

  async writeRoomMessagesCache(roomId: string, messages: Message[]): Promise<void> {
    if (this.roomMessagesCacheTtlSeconds <= 0) {
      return;
    }

    try {
      await this.redisClient.setEx(
        this.getRoomMessagesCacheKey(roomId),
        this.roomMessagesCacheTtlSeconds,
        JSON.stringify(messages)
      );
      this.logger.debug('Room message cache written', { roomId, count: messages.length, ttlSeconds: this.roomMessagesCacheTtlSeconds });
    } catch (error) {
      this.logger.error('Error writing room message cache', { error, roomId });
    }
  }

  async invalidateRoomMessagesCache(roomId: string): Promise<void> {
    try {
      await this.redisClient.del(this.getRoomMessagesCacheKey(roomId));
      this.logger.debug('Room message cache invalidated', { roomId });
    } catch (error) {
      this.logger.error('Error invalidating room message cache', { error, roomId });
    }
  }

  async invalidateAllRoomMessagesCaches(): Promise<void> {
    try {
      const pattern = `${ROOM_MESSAGES_CACHE_KEY_PREFIX}*${ROOM_MESSAGES_CACHE_KEY_SUFFIX}`;
      const scanIterator = (this.redisClient as any).scanIterator;
      const pendingKeys: string[] = [];

      if (typeof scanIterator === 'function') {
        for await (const keyOrKeys of scanIterator.call(this.redisClient, {
          MATCH: pattern,
          COUNT: 100,
        })) {
          if (Array.isArray(keyOrKeys)) {
            pendingKeys.push(...keyOrKeys.map(String));
          } else {
            pendingKeys.push(String(keyOrKeys));
          }

          if (pendingKeys.length >= 100) {
            await this.redisClient.del(pendingKeys.splice(0));
          }
        }
      } else if (typeof (this.redisClient as any).keys === 'function') {
        this.logger.warn('Redis scanIterator unavailable; falling back to KEYS for room message cache invalidation');
        const keys = await (this.redisClient as any).keys(pattern);
        if (Array.isArray(keys)) {
          pendingKeys.push(...keys.map(String));
        }
      } else {
        this.logger.error('Cannot invalidate all room message caches because Redis client supports neither scanIterator nor keys');
        return;
      }

      if (pendingKeys.length > 0) {
        await this.redisClient.del(pendingKeys);
      }
      this.logger.debug('All room message caches invalidated');
    } catch (error) {
      this.logger.error('Error invalidating all room message caches', { error });
    }
  }

  async generateUniqueRoomId(): Promise<string> {
    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
      const id = nanoid();
      const exists = await this.redisClient.hExists('rooms', id);
      if (!exists) {
        return id;
      }
      attempts++;
      this.logger.debug('Room ID collision detected, retrying', { attempt: attempts, maxAttempts });
    }

    this.logger.warn('Multiple collisions detected, using longer ID');
    attempts = 0;
    while (attempts < maxAttempts) {
      const id = nanoid(12);
      const exists = await this.redisClient.hExists('rooms', id);
      if (!exists) {
        return id;
      }
      attempts++;
      this.logger.debug('Long room ID collision detected, retrying', { attempt: attempts, maxAttempts });
    }

    this.logger.warn('Multiple long room ID collisions detected, using extra-long ID');
    return nanoid(16);
  }

  async appendMessage(message: Message): Promise<Room | null> {
    try {
      const result = await (this.redisClient as any).eval(APPEND_MESSAGE_LIST_SCRIPT, {
        keys: ['rooms', `room:${message.roomId}:messages`],
        arguments: [message.roomId, JSON.stringify(message), message.timestamp],
      });
      const updatedRoom = parseScriptRoom(result, 1);
      if (!updatedRoom) {
        this.logger.warn('Cannot append message for missing or invalid Redis room', { messageId: message.id, roomId: message.roomId });
        return null;
      }
      this.logger.debug('Message appended to Redis list', { messageId: message.id, roomId: message.roomId });
      return updatedRoom;
    } catch (error) {
      this.logger.error('Error appending message to Redis', { error, messageId: message.id, roomId: message.roomId });
      return null;
    }
  }

  async upsertMessage(message: Message): Promise<Room | null> {
    try {
      const messageKey = `room:${message.roomId}:messages`;
      const result = await (this.redisClient as any).eval(UPSERT_MESSAGE_LIST_SCRIPT, {
        keys: ['rooms', messageKey],
        arguments: [message.roomId, message.id, JSON.stringify(message), message.timestamp],
      });

      const updatedRoom = parseScriptRoom(result, 3);
      if (!updatedRoom) {
        this.logger.warn('Cannot upsert message for missing or invalid Redis room', { messageId: message.id, roomId: message.roomId });
        return null;
      }
      const replaced = Array.isArray(result) ? Number(result[1]) === 1 : false;
      this.logger.debug('Message upserted in Redis list', { messageId: message.id, roomId: message.roomId, replaced });
      return updatedRoom;
    } catch (error) {
      this.logger.error('Error upserting message in Redis', { error, messageId: message.id, roomId: message.roomId });
      return null;
    }
  }

  async saveMessageHistory(roomId: string, messages: Message[]): Promise<Room | null> {
    try {
      const messageKey = `room:${roomId}:messages`;
      const fallbackRoom = await this.getRoomById(roomId);
      const result = await (this.redisClient as any).eval(REPLACE_MESSAGE_LIST_SCRIPT, {
        keys: ['rooms', messageKey],
        arguments: [
          roomId,
          getLatestMessageTimestamp(messages) || fallbackRoom?.createdAt || new Date().toISOString(),
          ...messages.map(message => JSON.stringify(message)),
        ],
      });
      const updatedRoom = parseScriptRoom(result, 2);
      if (!updatedRoom) {
        this.logger.warn('Cannot save message history for missing or invalid Redis room', { roomId, count: messages.length });
        return null;
      }
      this.logger.debug('Message history saved/overwritten to Redis', { roomId, count: messages.length });
      return updatedRoom;
    } catch (error) {
      this.logger.error('Error saving message history to Redis', { error, roomId });
      return null;
    }
  }

  async clearRoomMessages(roomId: string): Promise<number> {
    return this.redisClient.del(`room:${roomId}:messages`);
  }

  async readMessagesByRoom(roomId: string): Promise<Message[]> {
    try {
      const messages = await this.redisClient.lRange(`room:${roomId}:messages`, 0, -1);
      this.logger.debug('Messages read from Redis', { roomId, count: messages.length });
      return messages.map((message: string) => JSON.parse(message));
    } catch (error) {
      this.logger.error('Error reading messages from Redis', { error, roomId });
      return [];
    }
  }

  getRoomAICostKey(roomId: string): string {
    return `room:${roomId}:ai_cost_total_usd`;
  }

  async readRoomAICost(roomId: string): Promise<RoomAICostTotal> {
    try {
      const total = await this.redisClient.get(this.getRoomAICostKey(roomId));
      const totalUsd = Number.parseFloat(total || '0');

      return {
        roomId,
        currency: 'USD',
        totalUsd: Number.isFinite(totalUsd) ? totalUsd : 0,
      };
    } catch (error) {
      this.logger.error('Error reading room AI cost total', { error, roomId });
      return { roomId, currency: 'USD', totalUsd: 0 };
    }
  }

  async incrementRoomAICost(roomId: string, cost: AICost | null): Promise<RoomAICostTotal> {
    if (!cost || !Number.isFinite(cost.totalUsd) || cost.totalUsd <= 0) {
      return this.readRoomAICost(roomId);
    }

    try {
      const total = await this.redisClient.incrByFloat(this.getRoomAICostKey(roomId), cost.totalUsd);
      const totalUsd = typeof total === 'number' ? total : Number.parseFloat(String(total));
      return {
        roomId,
        currency: 'USD',
        totalUsd: Number.isFinite(totalUsd) ? totalUsd : cost.totalUsd,
      };
    } catch (error) {
      this.logger.error('Error incrementing room AI cost total', { error, roomId, cost });
      return this.readRoomAICost(roomId);
    }
  }

  async saveRoom(room: Room): Promise<Room | null> {
    try {
      await this.redisClient.hSet('rooms', room.id, JSON.stringify(room));
      await this.redisClient.sAdd(`user:${room.creatorId}:rooms`, room.id);
      this.logger.debug('Room saved to Redis', { roomId: room.id, creatorId: room.creatorId });
      return room;
    } catch (error) {
      this.logger.error('Error saving room to Redis', { error, roomId: room.id });
      return null;
    }
  }

  async readRoomsByUser(clientId: string): Promise<Room[]> {
    try {
      const roomIds = await this.redisClient.sMembers(`user:${clientId}:rooms`);
      const rooms = await Promise.all(
        roomIds.map((id: string) => this.redisClient.hGet('rooms', id))
      );
      this.logger.debug('Rooms read by user from Redis', { clientId, count: roomIds.length });
      return rooms
        .filter(room => room)
        .map((room: string | undefined) => JSON.parse(room!))
        .sort((first: Room, second: Room) => getRoomActivityTime(second) - getRoomActivityTime(first));
    } catch (error) {
      this.logger.error('Error reading rooms for user from Redis', { error, clientId });
      return [];
    }
  }

  async getRoomById(roomId: string): Promise<Room | null> {
    try {
      const roomStr = await this.redisClient.hGet('rooms', roomId);
      this.logger.debug('Room read by ID from Redis', { roomId, found: !!roomStr });
      return roomStr ? JSON.parse(roomStr) : null;
    } catch (error) {
      this.logger.error('Error reading room by id from Redis', { error, roomId });
      return null;
    }
  }

  async updateRoomLastActivity(roomId: string, lastActivityAt?: string): Promise<Room | null> {
    try {
      const room = await this.getRoomById(roomId);
      if (!room) {
        this.logger.warn('Cannot update last activity for missing room', { roomId });
        return null;
      }

      const updatedRoom = {
        ...room,
        lastActivityAt: lastActivityAt || room.createdAt,
      };
      await this.redisClient.hSet('rooms', roomId, JSON.stringify(updatedRoom));
      return updatedRoom;
    } catch (error) {
      this.logger.error('Error updating room last activity', { error, roomId, lastActivityAt });
      return null;
    }
  }

  async updateRoomMemberCount(roomId: string, clientId: string, isJoining: boolean): Promise<number> {
    try {
      const roomMembersKey = `room:${roomId}:members`;

      if (isJoining) {
        await this.redisClient.sAdd(roomMembersKey, clientId);
      } else {
        await this.redisClient.sRem(roomMembersKey, clientId);
      }

      return await this.redisClient.sCard(roomMembersKey);
    } catch (error) {
      this.logger.error('Error updating room member count', { error, roomId, clientId, isJoining });
      return 0;
    }
  }

  async getRoomMemberCount(roomId: string): Promise<number> {
    try {
      return await this.redisClient.sCard(`room:${roomId}:members`);
    } catch (error) {
      this.logger.error('Error getting room member count', { error, roomId });
      return 0;
    }
  }

  async storeClientSession(socketId: string, userId: string): Promise<void> {
    try {
      await this.redisClient.hSet('socket:clients', socketId, userId);
    } catch (error) {
      this.logger.error('Error storing client session', { error, socketId, userId });
    }
  }

  async getClientId(socketId: string): Promise<string | null> {
    try {
      const clientId = await this.redisClient.hGet('socket:clients', socketId);
      return clientId || null;
    } catch (error) {
      this.logger.error('Error getting client ID', { error, socketId });
      return null;
    }
  }

  async removeClientSession(socketId: string): Promise<void> {
    try {
      await this.redisClient.hDel('socket:clients', socketId);
    } catch (error) {
      this.logger.error('Error removing client session', { error, socketId });
    }
  }

  async storeUserRooms(socketId: string, roomIds: string[]): Promise<void> {
    try {
      if (roomIds.length > 0) {
        await this.redisClient.hSet('socket:rooms', socketId, JSON.stringify(roomIds));
      } else {
        await this.redisClient.hDel('socket:rooms', socketId);
      }
    } catch (error) {
      this.logger.error('Error storing user rooms', { error, socketId, roomIds });
    }
  }

  async getUserRooms(socketId: string): Promise<string[]> {
    try {
      const roomsJson = await this.redisClient.hGet('socket:rooms', socketId);
      return roomsJson ? JSON.parse(roomsJson) : [];
    } catch (error) {
      this.logger.error('Error getting user rooms', { error, socketId });
      return [];
    }
  }

  async deleteRoom(roomId: string, creatorId: string): Promise<void> {
    try {
      await Promise.all([
        this.redisClient.hDel('rooms', roomId),
        this.redisClient.del(`room:${roomId}:messages`),
        this.redisClient.del(this.getRoomMessagesCacheKey(roomId)),
        this.redisClient.del(this.getRoomAICostKey(roomId)),
        this.redisClient.del(`room:${roomId}:members`),
        this.redisClient.sRem(`user:${creatorId}:rooms`, roomId),
      ]);
      this.logger.debug('Room deleted from Redis', { roomId, creatorId });
    } catch (error) {
      this.logger.error('Error deleting room from Redis', { error, roomId, creatorId });
    }
  }

  async countRooms(): Promise<number> {
    try {
      return await this.redisClient.hLen('rooms');
    } catch (error) {
      this.logger.error('Error counting Redis rooms', { error });
      return 0;
    }
  }

  async resetAllDataForTests(): Promise<void> {
    try {
      await this.redisClient.flushDb();
    } catch (error) {
      this.logger.error('Error resetting Redis test data', { error });
    }
  }

  async failInterruptedStreamingMessages(content: string): Promise<number> {
    try {
      const roomIds = await this.redisClient.hKeys('rooms');
      let updatedCount = 0;

      for (const roomId of roomIds) {
        const messages = await this.readMessagesByRoom(roomId);
        let changed = false;
        let changedCount = 0;
        const updatedMessages = messages.map(message => {
          if (message.status !== 'streaming') {
            return message;
          }
          changed = true;
          changedCount++;
          return {
            ...message,
            status: 'error' as const,
            content,
            timestamp: new Date().toISOString(),
          };
        });

        if (changed) {
          const updatedRoom = await this.saveMessageHistory(roomId, updatedMessages);
          if (updatedRoom) {
            updatedCount += changedCount;
            await this.invalidateRoomMessagesCache(roomId);
          }
        }
      }

      if (updatedCount > 0) {
        this.logger.warn('Marked interrupted Redis streaming messages as error', { count: updatedCount });
      }
      return updatedCount;
    } catch (error) {
      this.logger.error('Error marking interrupted Redis streaming messages', { error });
      return 0;
    }
  }
}
