import { customAlphabet } from 'nanoid';
import { RedisClientType } from 'redis';
import { Logger } from '../logger';
import { AICost, MediaAsset, Message, MessageMediaAsset, Room, RoomAICostTotal, RoomMember, RoomMemberRole, RoomOnlineMember } from '../types';
import { DEFAULT_ROOM_MESSAGE_PAGE_LIMIT, MediaMessageAppendResult, RoomMessageCacheStore, RoomMessagePageOptions, RoomSettingsUpdate, RoomStore } from './store';

const nanoid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 10);
const DEFAULT_ROOM_MESSAGES_CACHE_TTL_SECONDS = 30;
const ROOM_MESSAGES_CACHE_KEY_PREFIX = 'cache:room:';
const ROOM_MESSAGES_CACHE_KEY_SUFFIX = ':messages';
const getPersistentRoomMembersKey = (roomId: string) => `room:${roomId}:room_members`;
const CLIENT_NICKNAMES_KEY = 'client:nicknames';
const getRoomMediaAssetsKey = (roomId: string) => `room:${roomId}:media_assets`;
const getSavedRoomsKey = (clientId: string) => `user:${clientId}:saved_rooms`;
const getRoomSavedByKey = (roomId: string) => `room:${roomId}:saved_by`;
const getRoomPasswordHashKey = (roomId: string) => `room:${roomId}:password_hash`;

const toMessageMediaAsset = (asset: MediaAsset): MessageMediaAsset => {
  const messageAsset: MessageMediaAsset = {
    id: asset.id,
    kind: asset.kind,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
  };
  if (asset.width !== undefined) messageAsset.width = asset.width;
  if (asset.height !== undefined) messageAsset.height = asset.height;
  if (asset.durationMs !== undefined) messageAsset.durationMs = asset.durationMs;
  return messageAsset;
};

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
room['messageVersion'] = (tonumber(room['messageVersion']) or 0) + 1
local messagePayload = ARGV[2]
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(room))
redis.call('RPUSH', KEYS[2], messagePayload)
return { 1, cjson.encode(room) }
`;

const APPEND_MEDIA_MESSAGE_WITH_ASSET_SCRIPT = `
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
room['messageVersion'] = (tonumber(room['messageVersion']) or 0) + 1
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(room))
redis.call('RPUSH', KEYS[2], ARGV[2])
redis.call('HSET', KEYS[3], ARGV[4], ARGV[5])
redis.call('SADD', KEYS[4], ARGV[4])
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
room['messageVersion'] = (tonumber(room['messageVersion']) or 0) + 1
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
room['messageVersion'] = (tonumber(room['messageVersion']) or 0) + 1
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(room))
redis.call('DEL', KEYS[2])
for i = 1, #existing do
  redis.call('RPUSH', KEYS[2], existing[i])
end

return { 1, found, #existing, cjson.encode(room) }
`;

const UPDATE_MESSAGE_CONTENT_SCRIPT = `
local roomJson = redis.call('HGET', KEYS[1], ARGV[1])
if not roomJson then
  return { 0, 0, '', '' }
end

local roomOk, room = pcall(cjson.decode, roomJson)
if not roomOk then
  return { 0, 0, '', '' }
end

local existing = redis.call('LRANGE', KEYS[2], 0, -1)
local targetId = ARGV[2]
local updatedPayload = ''
local found = 0

for i = 1, #existing do
  local ok, decoded = pcall(cjson.decode, existing[i])
  if ok and decoded['id'] == targetId then
    decoded['content'] = ARGV[3]
    decoded['updatedAt'] = ARGV[4]
    updatedPayload = cjson.encode(decoded)
    redis.call('LSET', KEYS[2], i - 1, updatedPayload)
    found = 1
    break
  end
end

if found == 1 then
  room['messageVersion'] = (tonumber(room['messageVersion']) or 0) + 1
  redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(room))
end

return { 1, found, cjson.encode(room), updatedPayload }
`;

const REPLACE_MEDIA_MESSAGE_ASSET_SCRIPT = `
local roomJson = redis.call('HGET', KEYS[1], ARGV[1])
if not roomJson then
  return { 0, 0, '', '' }
end

local roomOk, room = pcall(cjson.decode, roomJson)
if not roomOk then
  return { 0, 0, '', '' }
end

local existing = redis.call('LRANGE', KEYS[2], 0, -1)
local mediaMessageId = ARGV[2]
local mediaMimeType = ARGV[3]
local updatedPayload = ''
local found = 0

for i = 1, #existing do
  local ok, decoded = pcall(cjson.decode, existing[i])
  if ok and decoded['id'] == mediaMessageId and decoded['messageType'] == 'media' then
    decoded['content'] = ''
    decoded['messageType'] = 'media'
    decoded['mimeType'] = mediaMimeType
    decoded['mediaAsset'] = nil
    updatedPayload = cjson.encode(decoded)
    redis.call('LSET', KEYS[2], i - 1, updatedPayload)
    found = 1
    break
  end
end

return { 1, found, cjson.encode(room), updatedPayload }
`;

const DELETE_MESSAGE_BY_ID_SCRIPT = `
local roomJson = redis.call('HGET', KEYS[1], ARGV[1])
if not roomJson then
  return { 0, 0, 0, '' }
end

local roomOk, room = pcall(cjson.decode, roomJson)
if not roomOk then
  return { 0, 0, 0, '' }
end

local existing = redis.call('LRANGE', KEYS[2], 0, -1)
local remaining = {}
local targetId = ARGV[2]
local found = 0
local latestTimestamp = ''

for i = 1, #existing do
  local ok, decoded = pcall(cjson.decode, existing[i])
  if ok and decoded['id'] == targetId then
    found = 1
  else
    table.insert(remaining, existing[i])
    if ok and decoded['timestamp'] and decoded['timestamp'] > latestTimestamp then
      latestTimestamp = decoded['timestamp']
    end
  end
end

if found == 1 then
  room['lastActivityAt'] = latestTimestamp ~= '' and latestTimestamp or room['createdAt']
  room['messageVersion'] = (tonumber(room['messageVersion']) or 0) + 1
  redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(room))
  redis.call('DEL', KEYS[2])
  for i = 1, #remaining do
    redis.call('RPUSH', KEYS[2], remaining[i])
  end
end

return { 1, found, #remaining, cjson.encode(room) }
`;

const TRUNCATE_MESSAGE_LIST_SCRIPT = `
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
local mode = ARGV[3]
local targetIndex = 0

for i = 1, #existing do
  local ok, decoded = pcall(cjson.decode, existing[i])
  if ok and decoded['id'] == targetId then
    targetIndex = i
    break
  end
end

local remaining = {}
local found = targetIndex > 0 and 1 or 0

if found == 1 then
  local keepCount = mode == 'before' and targetIndex - 1 or targetIndex
  local latestTimestamp = ''
  for i = 1, keepCount do
    table.insert(remaining, existing[i])
    local ok, decoded = pcall(cjson.decode, existing[i])
    if ok and decoded['timestamp'] and decoded['timestamp'] > latestTimestamp then
      latestTimestamp = decoded['timestamp']
    end
  end

  room['lastActivityAt'] = latestTimestamp ~= '' and latestTimestamp or room['createdAt']
  room['messageVersion'] = (tonumber(room['messageVersion']) or 0) + 1
  redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(room))
  redis.call('DEL', KEYS[2])
  for i = 1, #remaining do
    redis.call('RPUSH', KEYS[2], remaining[i])
  end
else
  remaining = existing
end

local response = { 1, found, #remaining, cjson.encode(room) }
for i = 1, #remaining do
  table.insert(response, remaining[i])
end
return response
`;

const UPDATE_AND_TRUNCATE_AFTER_SCRIPT = `
local roomJson = redis.call('HGET', KEYS[1], ARGV[1])
if not roomJson then
  return { 0, 0, 0, '', '' }
end

local roomOk, room = pcall(cjson.decode, roomJson)
if not roomOk then
  return { 0, 0, 0, '', '' }
end

local existing = redis.call('LRANGE', KEYS[2], 0, -1)
local targetId = ARGV[2]
local targetIndex = 0
local updatedPayload = ''

for i = 1, #existing do
  local ok, decoded = pcall(cjson.decode, existing[i])
  if ok and decoded['id'] == targetId then
    decoded['content'] = ARGV[3]
    decoded['updatedAt'] = ARGV[4]
    updatedPayload = cjson.encode(decoded)
    existing[i] = updatedPayload
    targetIndex = i
    break
  end
end

local remaining = {}
local found = targetIndex > 0 and 1 or 0

if found == 1 then
  local latestTimestamp = ''
  for i = 1, targetIndex do
    table.insert(remaining, existing[i])
    local ok, decoded = pcall(cjson.decode, existing[i])
    if ok and decoded['timestamp'] and decoded['timestamp'] > latestTimestamp then
      latestTimestamp = decoded['timestamp']
    end
  end

  room['lastActivityAt'] = latestTimestamp ~= '' and latestTimestamp or room['createdAt']
  room['messageVersion'] = (tonumber(room['messageVersion']) or 0) + 1
  redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(room))
  redis.call('DEL', KEYS[2])
  for i = 1, #remaining do
    redis.call('RPUSH', KEYS[2], remaining[i])
  end
else
  remaining = existing
end

local response = { 1, found, #remaining, cjson.encode(room), updatedPayload }
for i = 1, #remaining do
  table.insert(response, remaining[i])
end
return response
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

const normalizeMessagePageLimit = (limit?: number): number => {
  if (!Number.isFinite(limit)) {
    return DEFAULT_ROOM_MESSAGE_PAGE_LIMIT;
  }

  return Math.min(200, Math.max(1, Math.floor(limit || DEFAULT_ROOM_MESSAGE_PAGE_LIMIT)));
};

const bumpRoomMessageVersion = (room: Room): Room => ({
  ...room,
  messageVersion: (room.messageVersion || 0) + 1,
});

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

const parseScriptMessage = (value: unknown): Message | undefined => {
  if (typeof value !== 'string' || !value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as Message;
  } catch {
    return undefined;
  }
};

const parseScriptMessages = (result: unknown, startIndex: number): Message[] => {
  if (!Array.isArray(result)) {
    return [];
  }

  return result
    .slice(startIndex)
    .map(parseScriptMessage)
    .filter((message): message is Message => !!message);
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

  async appendMediaMessageWithAsset(message: Message, asset: MediaAsset): Promise<MediaMessageAppendResult | null> {
    const mediaMessage: Message = {
      ...message,
      messageType: 'media',
    };
    const mediaAsset: MediaAsset = {
      ...asset,
      roomId: mediaMessage.roomId,
      messageId: mediaMessage.id,
    };
    const savedMessage: Message = {
      ...mediaMessage,
      content: mediaMessage.content || '',
      mimeType: mediaAsset.mimeType as Message['mimeType'],
      mediaAsset: toMessageMediaAsset(mediaAsset),
    };

    try {
      const result = await (this.redisClient as any).eval(APPEND_MEDIA_MESSAGE_WITH_ASSET_SCRIPT, {
        keys: ['rooms', `room:${mediaMessage.roomId}:messages`, 'media_assets', getRoomMediaAssetsKey(mediaMessage.roomId)],
        arguments: [
          mediaMessage.roomId,
          JSON.stringify(savedMessage),
          mediaMessage.timestamp,
          mediaAsset.id,
          JSON.stringify(mediaAsset),
        ],
      });
      const updatedRoom = parseScriptRoom(result, 1);
      if (!updatedRoom) {
        this.logger.warn('Cannot append media message for missing or invalid Redis room', { messageId: mediaMessage.id, roomId: mediaMessage.roomId, assetId: mediaAsset.id });
        return null;
      }
      await this.invalidateRoomMessagesCache(mediaMessage.roomId);
      this.logger.debug('Media message and asset appended to Redis list', { messageId: mediaMessage.id, roomId: mediaMessage.roomId, assetId: mediaAsset.id, kind: mediaAsset.kind });
      return { room: updatedRoom, message: savedMessage, asset: mediaAsset };
    } catch (error) {
      this.logger.error('Error appending media message and asset to Redis', { error, messageId: mediaMessage.id, roomId: mediaMessage.roomId, assetId: mediaAsset.id });
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

  async updateMessageContent(roomId: string, messageId: string, updatedContent: string, updatedAt = new Date().toISOString()) {
    try {
      const result = await (this.redisClient as any).eval(UPDATE_MESSAGE_CONTENT_SCRIPT, {
        keys: ['rooms', `room:${roomId}:messages`],
        arguments: [roomId, messageId, updatedContent, updatedAt],
      });
      const updatedRoom = parseScriptRoom(result, 2);
      if (!updatedRoom) {
        this.logger.warn('Cannot update message for missing or invalid Redis room', { messageId, roomId });
        return null;
      }

      const found = Array.isArray(result) ? Number(result[1]) === 1 : false;
      if (!found) {
        return { room: updatedRoom, found: false };
      }

      const updatedMessage = parseScriptMessage(Array.isArray(result) ? result[3] : undefined);
      if (!updatedMessage) {
        this.logger.warn('Redis message update succeeded without returning an updated message', { messageId, roomId });
        return null;
      }

      this.logger.debug('Message updated in Redis list', { messageId, roomId });
      return { room: updatedRoom, found: true, updatedMessage };
    } catch (error) {
      this.logger.error('Error updating message in Redis', { error, messageId, roomId });
      return null;
    }
  }

  async deleteMessageById(roomId: string, messageId: string) {
    try {
      const result = await (this.redisClient as any).eval(DELETE_MESSAGE_BY_ID_SCRIPT, {
        keys: ['rooms', `room:${roomId}:messages`],
        arguments: [roomId, messageId],
      });
      const updatedRoom = parseScriptRoom(result, 3);
      if (!updatedRoom) {
        this.logger.warn('Cannot delete message for missing or invalid Redis room', { messageId, roomId });
        return null;
      }

      const deleted = Array.isArray(result) ? Number(result[1]) === 1 : false;
      this.logger.debug('Message delete processed in Redis list', { messageId, roomId, deleted });
      return { room: updatedRoom, deleted };
    } catch (error) {
      this.logger.error('Error deleting message in Redis', { error, messageId, roomId });
      return null;
    }
  }

  private async truncateMessages(roomId: string, messageId: string, mode: 'before' | 'after') {
    try {
      const result = await (this.redisClient as any).eval(TRUNCATE_MESSAGE_LIST_SCRIPT, {
        keys: ['rooms', `room:${roomId}:messages`],
        arguments: [roomId, messageId, mode],
      });
      const updatedRoom = parseScriptRoom(result, 3);
      if (!updatedRoom) {
        this.logger.warn('Cannot truncate messages for missing or invalid Redis room', { messageId, roomId, mode });
        return null;
      }

      const targetFound = Array.isArray(result) ? Number(result[1]) === 1 : false;
      const messages = parseScriptMessages(result, 4);
      this.logger.debug('Message truncation processed in Redis list', { messageId, roomId, mode, targetFound, count: messages.length });
      return { room: updatedRoom, messages, targetFound };
    } catch (error) {
      this.logger.error('Error truncating messages in Redis', { error, messageId, roomId, mode });
      return null;
    }
  }

  truncateBeforeMessage(roomId: string, messageId: string) {
    return this.truncateMessages(roomId, messageId, 'before');
  }

  truncateAfterMessage(roomId: string, messageId: string) {
    return this.truncateMessages(roomId, messageId, 'after');
  }

  async updateMessageAndTruncateAfter(roomId: string, messageId: string, updatedContent: string, updatedAt = new Date().toISOString()) {
    try {
      const result = await (this.redisClient as any).eval(UPDATE_AND_TRUNCATE_AFTER_SCRIPT, {
        keys: ['rooms', `room:${roomId}:messages`],
        arguments: [roomId, messageId, updatedContent, updatedAt],
      });
      const updatedRoom = parseScriptRoom(result, 3);
      if (!updatedRoom) {
        this.logger.warn('Cannot update and truncate message for missing or invalid Redis room', { messageId, roomId });
        return null;
      }

      const targetFound = Array.isArray(result) ? Number(result[1]) === 1 : false;
      const messages = parseScriptMessages(result, 5);
      if (!targetFound) {
        return { room: updatedRoom, messages, targetFound: false };
      }

      const updatedMessage = parseScriptMessage(Array.isArray(result) ? result[4] : undefined);
      if (!updatedMessage) {
        this.logger.warn('Redis update-and-truncate succeeded without returning an updated message', { messageId, roomId });
        return null;
      }

      this.logger.debug('Message updated and history truncated in Redis list', { messageId, roomId, count: messages.length });
      return { room: updatedRoom, messages, targetFound: true, updatedMessage };
    } catch (error) {
      this.logger.error('Error updating and truncating message in Redis', { error, messageId, roomId });
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
    const messageKey = `room:${roomId}:messages`;
    const count = await this.redisClient.del(messageKey);
    if (count > 0) {
      const room = await this.getRoomById(roomId);
      if (room) {
        await this.redisClient.hSet('rooms', roomId, JSON.stringify({
          ...bumpRoomMessageVersion(room),
          lastActivityAt: room.createdAt,
        }));
      }
    }
    return count;
  }

  async readMessagesByRoom(roomId: string): Promise<Message[]> {
    try {
      const messages = await this.redisClient.lRange(`room:${roomId}:messages`, 0, -1);
      this.logger.debug('Messages read from Redis', { roomId, count: messages.length });
      return this.attachMediaAssets(roomId, messages.map((message: string) => JSON.parse(message)));
    } catch (error) {
      this.logger.error('Error reading messages from Redis', { error, roomId });
      return [];
    }
  }

  async readMessagePageByRoom(roomId: string, options: RoomMessagePageOptions = {}) {
    const limit = normalizeMessagePageLimit(options.limit);

    try {
      const room = await this.getRoomById(roomId);
      const historyVersion = room?.messageVersion || 0;
      if (!room) {
        return { roomId, messages: [], historyVersion, hasMore: false };
      }

      const allMessages = await this.readMessagesByRoom(roomId);
      let endIndex = allMessages.length;
      if (options.beforeMessageId) {
        const targetIndex = allMessages.findIndex(message => message.id === options.beforeMessageId);
        if (targetIndex === -1) {
          return { roomId, messages: [], historyVersion, hasMore: false };
        }
        endIndex = targetIndex;
      }

      const startIndex = Math.max(0, endIndex - limit);
      const messages = allMessages.slice(startIndex, endIndex);
      return {
        roomId,
        messages,
        historyVersion,
        hasMore: startIndex > 0,
        oldestMessageId: messages[0]?.id,
      };
    } catch (error) {
      this.logger.error('Error reading Redis room message page', { error, roomId, options });
      return { roomId, messages: [], historyVersion: 0, hasMore: false };
    }
  }

  async saveMediaAsset(asset: MediaAsset): Promise<MediaAsset | null> {
    try {
      await this.redisClient.hSet('media_assets', asset.id, JSON.stringify(asset));
      await this.redisClient.sAdd(getRoomMediaAssetsKey(asset.roomId), asset.id);
      return asset;
    } catch (error) {
      this.logger.error('Error saving Redis media asset', { error, assetId: asset.id, roomId: asset.roomId, kind: asset.kind });
      return null;
    }
  }

  async replaceMessageMediaAsset(roomId: string, messageId: string, asset: MediaAsset) {
    const mediaAsset: MediaAsset = {
      ...asset,
      roomId,
      messageId,
    };

    try {
      const result = await (this.redisClient as any).eval(REPLACE_MEDIA_MESSAGE_ASSET_SCRIPT, {
        keys: ['rooms', `room:${roomId}:messages`],
        arguments: [roomId, messageId, mediaAsset.mimeType],
      });
      const updatedRoom = parseScriptRoom(result, 2);
      if (!updatedRoom) {
        this.logger.warn('Cannot replace media asset for missing or invalid Redis room', { messageId, roomId, assetId: mediaAsset.id });
        return null;
      }

      const found = Array.isArray(result) ? Number(result[1]) === 1 : false;
      if (!found) {
        return { room: updatedRoom, found: false };
      }

      const updatedMessage = parseScriptMessage(Array.isArray(result) ? result[3] : undefined);
      if (!updatedMessage) {
        this.logger.warn('Redis media asset replacement succeeded without returning an updated message', { messageId, roomId, assetId: mediaAsset.id });
        return null;
      }

      const savedAsset = await this.saveMediaAsset(mediaAsset);
      if (!savedAsset) {
        return null;
      }

      await this.invalidateRoomMessagesCache(roomId);
      this.logger.debug('Media message asset replaced in Redis list', { messageId, roomId, assetId: mediaAsset.id, kind: mediaAsset.kind });
      return {
        room: updatedRoom,
        found: true,
        updatedMessage: {
          ...updatedMessage,
          content: updatedMessage.content || '',
          mimeType: savedAsset.mimeType as Message['mimeType'],
          mediaAsset: toMessageMediaAsset(savedAsset),
        },
      };
    } catch (error) {
      this.logger.error('Error replacing Redis media message asset', { error, messageId, roomId, assetId: asset.id });
      return null;
    }
  }

  async getMediaAsset(assetId: string): Promise<MediaAsset | null> {
    try {
      const rawAsset = await this.redisClient.hGet('media_assets', assetId);
      return rawAsset ? JSON.parse(rawAsset) : null;
    } catch (error) {
      this.logger.error('Error reading Redis media asset', { error, assetId });
      return null;
    }
  }

  async getMediaAssetByMessageId(messageId: string): Promise<MediaAsset | null> {
    try {
      const assetIds = await this.redisClient.hKeys('media_assets');
      for (const assetId of assetIds) {
        const asset = await this.getMediaAsset(assetId);
        if (asset?.messageId === messageId) {
          return asset;
        }
      }
      return null;
    } catch (error) {
      this.logger.error('Error reading Redis media asset by message id', { error, messageId });
      return null;
    }
  }

  async readMediaAssetsByRoom(roomId: string): Promise<MediaAsset[]> {
    try {
      const assetIds = await this.redisClient.sMembers(getRoomMediaAssetsKey(roomId));
      const assets = await Promise.all(assetIds.map(assetId => this.getMediaAsset(assetId)));
      return assets
        .filter((asset): asset is MediaAsset => !!asset)
        .sort((first, second) => Date.parse(first.createdAt) - Date.parse(second.createdAt));
    } catch (error) {
      this.logger.error('Error reading Redis media assets by room', { error, roomId });
      return [];
    }
  }

  async deleteMediaAsset(assetId: string): Promise<void> {
    try {
      const asset = await this.getMediaAsset(assetId);
      await this.redisClient.hDel('media_assets', assetId);
      if (asset) {
        await this.redisClient.sRem(getRoomMediaAssetsKey(asset.roomId), assetId);
      }
    } catch (error) {
      this.logger.error('Error deleting Redis media asset', { error, assetId });
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
      await this.addRoomMember(room.id, room.creatorId, 'owner', room.createdAt);
      this.logger.debug('Room saved to Redis', { roomId: room.id, creatorId: room.creatorId });
      return room;
    } catch (error) {
      this.logger.error('Error saving room to Redis', { error, roomId: room.id });
      return null;
    }
  }

  async addRoomMember(roomId: string, clientId: string, role: RoomMemberRole, joinedAt = new Date().toISOString()): Promise<RoomMember | null> {
    try {
      const existing = await this.getRoomMember(roomId, clientId);
      const member: RoomMember = {
        roomId,
        clientId,
        role: existing?.role === 'owner' || role === 'owner' ? 'owner' : 'member',
        joinedAt: existing?.joinedAt || joinedAt,
      };
      await this.redisClient.hSet(getPersistentRoomMembersKey(roomId), clientId, JSON.stringify(member));
      return member;
    } catch (error) {
      this.logger.error('Error adding Redis room member', { error, roomId, clientId, role });
      return null;
    }
  }

  async removeRoomMember(roomId: string, clientId: string): Promise<boolean> {
    try {
      const existing = await this.getRoomMember(roomId, clientId);
      if (!existing || existing.role === 'owner') {
        return false;
      }

      const removed = await this.redisClient.hDel(getPersistentRoomMembersKey(roomId), clientId);
      await this.redisClient.sRem(`user:${clientId}:rooms`, roomId);
      return removed > 0;
    } catch (error) {
      this.logger.error('Error removing Redis room member', { error, roomId, clientId });
      return false;
    }
  }

  async getRoomMember(roomId: string, clientId: string): Promise<RoomMember | null> {
    try {
      const rawMember = await this.redisClient.hGet(getPersistentRoomMembersKey(roomId), clientId);
      return rawMember ? JSON.parse(rawMember) : null;
    } catch (error) {
      this.logger.error('Error reading Redis room member', { error, roomId, clientId });
      return null;
    }
  }

  async isRoomMember(roomId: string, clientId: string): Promise<boolean> {
    return !!(await this.getRoomMember(roomId, clientId));
  }

  async readRoomMembers(roomId: string): Promise<RoomMember[]> {
    try {
      const memberIds = await this.redisClient.hKeys(getPersistentRoomMembersKey(roomId));
      const members = await Promise.all(memberIds.map(clientId => this.getRoomMember(roomId, clientId)));
      return members
        .filter((member): member is RoomMember => !!member)
        .sort((first, second) => Date.parse(first.joinedAt) - Date.parse(second.joinedAt));
    } catch (error) {
      this.logger.error('Error reading Redis room members', { error, roomId });
      return [];
    }
  }

  async readRoomPasswordHash(roomId: string): Promise<string | null> {
    try {
      return await this.redisClient.get(getRoomPasswordHashKey(roomId));
    } catch (error) {
      this.logger.error('Error reading Redis room password hash', { error, roomId });
      return null;
    }
  }

  async updateRoomSettings(roomId: string, updates: RoomSettingsUpdate): Promise<Room | null> {
    try {
      const room = await this.getRoomById(roomId);
      if (!room) {
        return null;
      }

      const updatedRoom: Room = { ...room };
      if (Object.prototype.hasOwnProperty.call(updates, 'passwordHash')) {
        if (updates.passwordHash) {
          await this.redisClient.set(getRoomPasswordHashKey(roomId), updates.passwordHash);
          updatedRoom.hasPassword = true;
        } else {
          await this.redisClient.del(getRoomPasswordHashKey(roomId));
          delete updatedRoom.hasPassword;
        }
      }

      if (Object.prototype.hasOwnProperty.call(updates, 'postingSchedule')) {
        if (updates.postingSchedule) {
          updatedRoom.postingSchedule = updates.postingSchedule;
        } else {
          delete updatedRoom.postingSchedule;
        }
      }

      updatedRoom.updatedAt = new Date().toISOString();
      await this.redisClient.hSet('rooms', roomId, JSON.stringify(updatedRoom));
      return updatedRoom;
    } catch (error) {
      this.logger.error('Error updating Redis room settings', { error, roomId });
      return null;
    }
  }

  async updateRoomMemberRole(roomId: string, clientId: string, role: RoomMemberRole, joinedAt = new Date().toISOString()): Promise<RoomMember | null> {
    try {
      const room = await this.getRoomById(roomId);
      if (!room) {
        return null;
      }

      const existing = await this.getRoomMember(roomId, clientId);
      const member: RoomMember = {
        roomId,
        clientId,
        role,
        joinedAt: existing?.joinedAt || joinedAt,
      };
      await this.redisClient.hSet(getPersistentRoomMembersKey(roomId), clientId, JSON.stringify(member));
      return member;
    } catch (error) {
      this.logger.error('Error updating Redis room member role', { error, roomId, clientId, role });
      return null;
    }
  }

  async transferRoomOwnership(
    roomId: string,
    newOwnerClientId: string,
    previousOwnerRole: Exclude<RoomMemberRole, 'owner'> = 'admin',
  ): Promise<Room | null> {
    try {
      const room = await this.getRoomById(roomId);
      if (!room) {
        return null;
      }

      const previousOwnerId = room.creatorId;
      const members = await this.readRoomMembers(roomId);
      await Promise.all(members.map(member => {
        if (member.role !== 'owner' || member.clientId === newOwnerClientId) {
          return Promise.resolve();
        }
        return this.updateRoomMemberRole(roomId, member.clientId, previousOwnerRole, member.joinedAt);
      }));
      await this.updateRoomMemberRole(roomId, newOwnerClientId, 'owner');

      const updatedRoom: Room = {
        ...room,
        creatorId: newOwnerClientId,
      };
      await Promise.all([
        this.redisClient.hSet('rooms', roomId, JSON.stringify(updatedRoom)),
        this.redisClient.sRem(`user:${previousOwnerId}:rooms`, roomId),
        this.redisClient.sAdd(`user:${newOwnerClientId}:rooms`, roomId),
      ]);
      return updatedRoom;
    } catch (error) {
      this.logger.error('Error transferring Redis room ownership', { error, roomId, newOwnerClientId });
      return null;
    }
  }

  async readRoomsByUser(clientId: string): Promise<Room[]> {
    try {
      const roomIds = await this.redisClient.hKeys('rooms');
      const rooms = await Promise.all(
        roomIds.map((id: string) => this.redisClient.hGet('rooms', id))
      );
      this.logger.debug('Rooms read by user from Redis', { clientId, count: roomIds.length });
      return rooms
        .filter(room => room)
        .map((room: string | undefined) => JSON.parse(room!))
        .filter((room: Room) => room.creatorId === clientId)
        .sort((first: Room, second: Room) => getRoomActivityTime(second) - getRoomActivityTime(first));
    } catch (error) {
      this.logger.error('Error reading rooms for user from Redis', { error, clientId });
      return [];
    }
  }

  async saveRoomForUser(roomId: string, clientId: string, savedAt = new Date().toISOString()): Promise<Room | null> {
    try {
      const room = await this.getRoomById(roomId);
      if (!room) {
        return null;
      }

      await this.redisClient.hSet(getSavedRoomsKey(clientId), roomId, savedAt);
      await this.redisClient.sAdd(getRoomSavedByKey(roomId), clientId);
      return room;
    } catch (error) {
      this.logger.error('Error saving Redis room for user', { error, roomId, clientId });
      return null;
    }
  }

  async removeSavedRoomForUser(roomId: string, clientId: string): Promise<boolean> {
    try {
      const removed = await this.redisClient.hDel(getSavedRoomsKey(clientId), roomId);
      await this.redisClient.sRem(getRoomSavedByKey(roomId), clientId);
      return removed > 0;
    } catch (error) {
      this.logger.error('Error removing Redis saved room for user', { error, roomId, clientId });
      return false;
    }
  }

  async readSavedRoomsByUser(clientId: string): Promise<Room[]> {
    try {
      const savedRoomIds = await this.redisClient.hKeys(getSavedRoomsKey(clientId));
      const savedRooms = await Promise.all(savedRoomIds.map(async roomId => {
        const [savedAt, roomJson] = await Promise.all([
          this.redisClient.hGet(getSavedRoomsKey(clientId), roomId),
          this.redisClient.hGet('rooms', roomId),
        ]);

        return roomJson
          ? { room: JSON.parse(roomJson) as Room, savedAt: savedAt || '' }
          : null;
      }));

      return savedRooms
        .filter((item): item is { room: Room; savedAt: string } => !!item)
        .sort((first, second) => {
          const savedTimeDelta = Date.parse(second.savedAt) - Date.parse(first.savedAt);
          return savedTimeDelta || getRoomActivityTime(second.room) - getRoomActivityTime(first.room);
        })
        .map(item => item.room);
    } catch (error) {
      this.logger.error('Error reading Redis saved rooms for user', { error, clientId });
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

  async updateRoomName(roomId: string, creatorId: string, name: string): Promise<Room | null> {
    try {
      const room = await this.getRoomById(roomId);
      if (!room) {
        this.logger.warn('Cannot rename missing Redis room', { roomId, creatorId });
        return null;
      }

      if (room.creatorId !== creatorId) {
        this.logger.warn('Cannot rename Redis room for non-creator', { roomId, creatorId, roomCreatorId: room.creatorId });
        return null;
      }

      const updatedRoom = {
        ...room,
        name,
        updatedAt: new Date().toISOString(),
      };
      await this.redisClient.hSet('rooms', roomId, JSON.stringify(updatedRoom));
      this.logger.debug('Room renamed in Redis', { roomId, creatorId });
      return updatedRoom;
    } catch (error) {
      this.logger.error('Error renaming room in Redis', { error, roomId, creatorId });
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

  async updateRoomMemberCount(roomId: string, clientId: string, socketId: string, isJoining: boolean): Promise<number> {
    try {
      const roomMembersKey = `room:${roomId}:members`;
      const clientSocketsKey = `room:${roomId}:member_sockets:${clientId}`;

      if (isJoining) {
        await this.redisClient.sAdd(clientSocketsKey, socketId);
        await this.redisClient.sAdd(roomMembersKey, clientId);
      } else {
        await this.redisClient.sRem(clientSocketsKey, socketId);
        const remainingSockets = await this.redisClient.sCard(clientSocketsKey);
        if (remainingSockets === 0) {
          await this.redisClient.del(clientSocketsKey);
          await this.redisClient.sRem(roomMembersKey, clientId);
        }
      }

      return await this.redisClient.sCard(roomMembersKey);
    } catch (error) {
      this.logger.error('Error updating room member count', { error, roomId, clientId, socketId, isJoining });
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

  async getRoomOnlineMemberIds(roomId: string): Promise<string[]> {
    try {
      return await this.redisClient.sMembers(`room:${roomId}:members`);
    } catch (error) {
      this.logger.error('Error getting room online member ids', { error, roomId });
      return [];
    }
  }

  // Self-joined presence + nicknames, used when Redis is the only store.
  async getRoomOnlineMembers(roomId: string): Promise<RoomOnlineMember[]> {
    const clientIds = await this.getRoomOnlineMemberIds(roomId);
    const nicknames = await this.getClientNicknames(clientIds);
    return clientIds.map((clientId) => ({ clientId, nickname: nicknames[clientId] }));
  }

  async setClientNickname(clientId: string, nickname: string): Promise<void> {
    try {
      await this.redisClient.hSet(CLIENT_NICKNAMES_KEY, clientId, nickname);
    } catch (error) {
      this.logger.error('Error setting client nickname', { error, clientId });
    }
  }

  async getClientNicknames(clientIds: string[]): Promise<Record<string, string>> {
    if (clientIds.length === 0) {
      return {};
    }
    try {
      const nicknames: Record<string, string> = {};
      await Promise.all(clientIds.map(async (clientId) => {
        const nickname = await this.redisClient.hGet(CLIENT_NICKNAMES_KEY, clientId);
        if (nickname) {
          nicknames[clientId] = nickname;
        }
      }));
      return nicknames;
    } catch (error) {
      this.logger.error('Error getting client nicknames', { error });
      return {};
    }
  }

  async clearRealtimeRoomMembers(): Promise<void> {
    try {
      const patterns = ['room:*:members', 'room:*:member_sockets:*'];
      const pendingKeys: string[] = [];
      let deletedKeyCount = 0;
      const scanIterator = (this.redisClient as any).scanIterator;

      if (typeof scanIterator === 'function') {
        for (const pattern of patterns) {
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
              const keysToDelete = pendingKeys.splice(0);
              deletedKeyCount += keysToDelete.length;
              await this.redisClient.del(keysToDelete);
            }
          }
        }
      } else if (typeof (this.redisClient as any).keys === 'function') {
        this.logger.warn('Redis scanIterator unavailable; falling back to KEYS for realtime room member cleanup');
        for (const pattern of patterns) {
          const keys = await (this.redisClient as any).keys(pattern);
          if (Array.isArray(keys)) {
            pendingKeys.push(...keys.map(String));
          }
        }
      } else {
        this.logger.error('Cannot clear realtime room members because Redis client supports neither scanIterator nor keys');
        return;
      }

      if (pendingKeys.length > 0) {
        deletedKeyCount += pendingKeys.length;
        await this.redisClient.del(pendingKeys);
      }
      this.logger.info('Realtime room member state cleared', { keyCount: deletedKeyCount });
    } catch (error) {
      this.logger.error('Error clearing realtime room member state', { error });
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
      const members = await this.readRoomMembers(roomId);
      const mediaAssets = await this.readMediaAssetsByRoom(roomId);
      const savedByClientIds = await this.redisClient.sMembers(getRoomSavedByKey(roomId));
      await Promise.all([
        this.redisClient.hDel('rooms', roomId),
        this.redisClient.del(`room:${roomId}:messages`),
        this.redisClient.del(this.getRoomMessagesCacheKey(roomId)),
        this.redisClient.del(this.getRoomAICostKey(roomId)),
        this.redisClient.del(getRoomPasswordHashKey(roomId)),
        this.redisClient.del(`room:${roomId}:members`),
        this.redisClient.del(getPersistentRoomMembersKey(roomId)),
        this.redisClient.del(getRoomMediaAssetsKey(roomId)),
        ...members.map(member => this.redisClient.del(`room:${roomId}:member_sockets:${member.clientId}`)),
        ...mediaAssets.map(asset => this.redisClient.hDel('media_assets', asset.id)),
        ...members.map(member => this.redisClient.sRem(`user:${member.clientId}:rooms`, roomId)),
        ...savedByClientIds.map(clientId => this.redisClient.hDel(getSavedRoomsKey(clientId), roomId)),
        this.redisClient.del(getRoomSavedByKey(roomId)),
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

  private async attachMediaAssets(roomId: string, messages: Message[]): Promise<Message[]> {
    if (!messages.some(message => message.messageType === 'media')) {
      return messages;
    }

    const assets = await this.readMediaAssetsByRoom(roomId);
    if (assets.length === 0) {
      return messages;
    }

    const assetsByMessageId = new Map(assets.filter(asset => asset.messageId).map(asset => [asset.messageId!, asset]));
    const assetsById = new Map(assets.map(asset => [asset.id, asset]));

    return messages.map(message => {
      if (message.messageType !== 'media') {
        return message;
      }

      const asset = assetsByMessageId.get(message.id) || assetsById.get(message.content);
      if (!asset) {
        return message;
      }

      return {
        ...message,
        content: message.content || '',
        mimeType: asset.mimeType as Message['mimeType'],
        mediaAsset: toMessageMediaAsset(asset),
      };
    });
  }
}
