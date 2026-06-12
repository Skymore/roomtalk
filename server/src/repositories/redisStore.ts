import { customAlphabet } from 'nanoid';
import { RedisClientType } from 'redis';
import { Logger } from '../logger';
import { AICost, MediaAsset, Message, MessageMediaAsset, Room, RoomAICostTotal, RoomMember, RoomMemberRole, RoomOnlineMember } from '../types';
import { getAIStreamOwnerId, InterruptedStreamingMessageRecoveryOptions, stripAIStreamRecoveryMetadata } from '../services/aiStreamRecovery';
import { AudioTranscriptionRecord, AudioTranscriptionUpdate, ClientAuthTokenRecord, DEFAULT_ROOM_MESSAGE_PAGE_LIMIT, MediaHistoryPage, MediaHistoryPageCursor, MediaHistoryPageOptions, MediaMessageAppendResult, PendingMediaUpload, PushSubscriptionRecord, RoomMessageCacheStore, RoomMessagePageOptions, RoomSettingsUpdate, RoomStore, SavePushSubscriptionInput } from './store';

const nanoid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 10);
const DEFAULT_ROOM_MESSAGES_CACHE_TTL_SECONDS = 30;
const ROOM_MESSAGES_CACHE_KEY_PREFIX = 'cache:room:';
const ROOM_MESSAGES_CACHE_KEY_SUFFIX = ':messages';
const getPersistentRoomMembersKey = (roomId: string) => `room:${roomId}:room_members`;
const CLIENT_NICKNAMES_KEY = 'client:nicknames';
const getRoomMediaAssetsKey = (roomId: string) => `room:${roomId}:media_assets`;
const getRoomMediaAssetsTimelineKey = (roomId: string) => `room:${roomId}:media_assets_by_time`;
const PENDING_MEDIA_UPLOADS_KEY = 'pending_media_uploads';
const PENDING_MEDIA_UPLOADS_BY_EXPIRY_KEY = 'pending_media_uploads_by_expiry';
const AUDIO_TRANSCRIPTIONS_KEY = 'audio_transcriptions';
const getSavedRoomsKey = (clientId: string) => `user:${clientId}:saved_rooms`;
const getRoomSavedByKey = (roomId: string) => `room:${roomId}:saved_by`;
const getRoomPasswordHashKey = (roomId: string) => `room:${roomId}:password_hash`;
const PUSH_SUBSCRIPTIONS_KEY = 'push_subscriptions';
const CLIENT_PASSWORDS_KEY = 'client:passwords';
const CLIENT_AUTH_TOKENS_KEY = 'client:auth_tokens';
const getClientAuthTokensKey = (clientId: string) => `client:${clientId}:auth_tokens`;

interface RoomMessagesCachePayload {
  messageVersion: number;
  messages: Message[];
}

const normalizeMediaHistoryPageLimit = (limit?: number): number => {
  if (!Number.isFinite(limit)) {
    return 40;
  }

  return Math.min(200, Math.max(1, Math.floor(limit || 40)));
};

const getMediaAssetTimelineScore = (asset: MediaAsset): number => {
  const parsed = Date.parse(asset.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
};

const isBeforeMediaHistoryCursor = (asset: MediaAsset, cursor: MediaHistoryPageCursor): boolean => {
  const assetTime = Date.parse(asset.createdAt);
  const cursorTime = Date.parse(cursor.createdAt);
  if (!Number.isFinite(assetTime) || !Number.isFinite(cursorTime)) {
    return false;
  }

  return assetTime < cursorTime || (assetTime === cursorTime && asset.id < cursor.assetId);
};

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

// 原子房间写入:roomVersion 以"写入时刻存储中的值"为准自增,
// 避免 TS 层 read-modify-write 在并发 handler 下产出重复版本号。
const WRITE_ROOM_RECORD_SCRIPT = `
local incomingJson = ARGV[2]
local ok, room = pcall(cjson.decode, incomingJson)
if not ok then
  return ''
end

local storedVersion = 0
local storedJson = redis.call('HGET', KEYS[1], ARGV[1])
if storedJson then
  local okStored, stored = pcall(cjson.decode, storedJson)
  if okStored and stored['roomVersion'] then
    storedVersion = tonumber(stored['roomVersion']) or 0
  end
end

room['roomVersion'] = storedVersion + 1
local encoded = cjson.encode(room)
redis.call('HSET', KEYS[1], ARGV[1], encoded)
return encoded
`;

const UPDATE_ROOM_SETTINGS_SCRIPT = `
local roomJson = redis.call('HGET', KEYS[1], ARGV[1])
if not roomJson then
  return ''
end

local ok, room = pcall(cjson.decode, roomJson)
if not ok then
  return ''
end

local passwordMode = ARGV[3]
if passwordMode == 'set' then
  redis.call('SET', KEYS[2], ARGV[4])
  room['hasPassword'] = true
elseif passwordMode == 'clear' then
  redis.call('DEL', KEYS[2])
  room['hasPassword'] = nil
end

local postingScheduleMode = ARGV[5]
if postingScheduleMode == 'set' then
  local okSchedule, postingSchedule = pcall(cjson.decode, ARGV[6])
  if not okSchedule then
    return ''
  end
  room['postingSchedule'] = postingSchedule
elseif postingScheduleMode == 'clear' then
  room['postingSchedule'] = nil
end

room['updatedAt'] = ARGV[2]
room['roomVersion'] = (tonumber(room['roomVersion']) or 0) + 1
local encoded = cjson.encode(room)
redis.call('HSET', KEYS[1], ARGV[1], encoded)
return encoded
`;

const UPDATE_ROOM_NAME_SCRIPT = `
local roomJson = redis.call('HGET', KEYS[1], ARGV[1])
if not roomJson then
  return { 0, '' }
end

local ok, room = pcall(cjson.decode, roomJson)
if not ok then
  return { 0, '' }
end

local expectedCreatorId = ARGV[2]
if room['creatorId'] ~= expectedCreatorId then
  return { 2, room['creatorId'] or '' }
end

room['name'] = ARGV[3]
room['updatedAt'] = ARGV[4]
room['roomVersion'] = (tonumber(room['roomVersion']) or 0) + 1
local encoded = cjson.encode(room)
redis.call('HSET', KEYS[1], ARGV[1], encoded)
return { 1, encoded }
`;

const UPDATE_ROOM_MEMBER_COUNT_SCRIPT = `
local clientId = ARGV[1]
local socketId = ARGV[2]
local isJoining = ARGV[3]

if isJoining == '1' then
  redis.call('SADD', KEYS[2], socketId)
  redis.call('SADD', KEYS[1], clientId)
else
  redis.call('SREM', KEYS[2], socketId)
  local remainingSockets = redis.call('SCARD', KEYS[2])
  if remainingSockets == 0 then
    redis.call('DEL', KEYS[2])
    redis.call('SREM', KEYS[1], clientId)
  end
end

return redis.call('SCARD', KEYS[1])
`;

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
room['roomVersion'] = (tonumber(room['roomVersion']) or 0) + 1
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
room['roomVersion'] = (tonumber(room['roomVersion']) or 0) + 1
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(room))
redis.call('RPUSH', KEYS[2], ARGV[2])
redis.call('HSET', KEYS[3], ARGV[4], ARGV[5])
redis.call('SADD', KEYS[4], ARGV[4])
redis.call('ZADD', KEYS[5], ARGV[6], ARGV[4])
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
room['roomVersion'] = (tonumber(room['roomVersion']) or 0) + 1
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
room['roomVersion'] = (tonumber(room['roomVersion']) or 0) + 1
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
  room['roomVersion'] = (tonumber(room['roomVersion']) or 0) + 1
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
  room['roomVersion'] = (tonumber(room['roomVersion']) or 0) + 1
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
  room['roomVersion'] = (tonumber(room['roomVersion']) or 0) + 1
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
  room['roomVersion'] = (tonumber(room['roomVersion']) or 0) + 1
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

// updatedAt 仅作展示/兼容回落;排序真值是 roomVersion——
// TS 写入经 WRITE_ROOM_RECORD_SCRIPT 原子自增,消息类 Lua 脚本各自 +1,
// 两类路径共同保证行级严格单调(Lua 路径不盖 updatedAt,客户端按版本号比较)。
const stampRoomRecord = (room: Room): Room => ({
  ...room,
  updatedAt: new Date().toISOString(),
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
    return stripAIStreamRecoveryMetadata(JSON.parse(value) as Message);
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

  async readCachedRoomMessages(roomId: string, messageVersion?: number): Promise<Message[] | null> {
    const cacheKey = this.getRoomMessagesCacheKey(roomId);
    const requiresVersion = typeof messageVersion === 'number' && Number.isFinite(messageVersion);

    try {
      const cached = await this.redisClient.get(cacheKey);
      if (!cached) {
        this.logger.debug('Room message cache miss', { roomId, messageVersion });
        return null;
      }

      const parsed = JSON.parse(cached) as unknown;
      let cachedMessageVersion: number | undefined;
      let messages: Message[] | null = null;

      if (Array.isArray(parsed)) {
        if (requiresVersion) {
          await this.redisClient.del(cacheKey);
          this.logger.debug('Legacy room message cache payload discarded', { roomId, expectedMessageVersion: messageVersion });
          return null;
        }
        messages = parsed as Message[];
      } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Partial<RoomMessagesCachePayload>).messages)) {
        const payload = parsed as Partial<RoomMessagesCachePayload>;
        cachedMessageVersion = payload.messageVersion;
        if (requiresVersion && cachedMessageVersion !== messageVersion) {
          await this.redisClient.del(cacheKey);
          this.logger.debug('Stale room message cache payload discarded', {
            roomId,
            cachedMessageVersion,
            expectedMessageVersion: messageVersion,
          });
          return null;
        }
        messages = payload.messages as Message[];
      }

      if (!messages) {
        await this.redisClient.del(cacheKey);
        this.logger.warn('Invalid room message cache payload discarded', { roomId });
        return null;
      }

      this.logger.debug('Room message cache hit', { roomId, count: messages.length, messageVersion: cachedMessageVersion });
      return messages.map(stripAIStreamRecoveryMetadata);
    } catch (error) {
      this.logger.error('Error reading room message cache', { error, roomId });
      return null;
    }
  }

  async writeRoomMessagesCache(roomId: string, messages: Message[], messageVersion?: number): Promise<void> {
    if (this.roomMessagesCacheTtlSeconds <= 0) {
      return;
    }

    try {
      const versionedPayload = typeof messageVersion === 'number' && Number.isFinite(messageVersion)
        ? { messageVersion, messages }
        : messages;
      await this.redisClient.setEx(
        this.getRoomMessagesCacheKey(roomId),
        this.roomMessagesCacheTtlSeconds,
        JSON.stringify(versionedPayload)
      );
      this.logger.debug('Room message cache written', { roomId, count: messages.length, messageVersion, ttlSeconds: this.roomMessagesCacheTtlSeconds });
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
        keys: ['rooms', `room:${mediaMessage.roomId}:messages`, 'media_assets', getRoomMediaAssetsKey(mediaMessage.roomId), getRoomMediaAssetsTimelineKey(mediaMessage.roomId)],
        arguments: [
          mediaMessage.roomId,
          JSON.stringify(savedMessage),
          mediaMessage.timestamp,
          mediaAsset.id,
          JSON.stringify(mediaAsset),
          String(getMediaAssetTimelineScore(mediaAsset)),
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
        await this.writeRoomRecord(roomId, {
          ...bumpRoomMessageVersion(room),
          lastActivityAt: room.createdAt,
        });
      }
    }
    return count;
  }

  async readMessagesByRoom(roomId: string): Promise<Message[]> {
    try {
      const messages = await this.redisClient.lRange(`room:${roomId}:messages`, 0, -1);
      this.logger.debug('Messages read from Redis', { roomId, count: messages.length });
      return this.attachMediaAssets(roomId, messages.map((message: string) => stripAIStreamRecoveryMetadata(JSON.parse(message))));
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

  private async indexMediaAsset(asset: MediaAsset): Promise<void> {
    await (this.redisClient as any).zAdd(getRoomMediaAssetsTimelineKey(asset.roomId), {
      score: getMediaAssetTimelineScore(asset),
      value: asset.id,
    });
  }

  private async ensureRoomMediaAssetTimeline(roomId: string): Promise<void> {
    const timelineKey = getRoomMediaAssetsTimelineKey(roomId);
    const [timelineCount, assetCount] = await Promise.all([
      (this.redisClient as any).zCard(timelineKey),
      this.redisClient.sCard(getRoomMediaAssetsKey(roomId)),
    ]);
    if (timelineCount >= assetCount) {
      return;
    }

    const assetIds = await this.redisClient.sMembers(getRoomMediaAssetsKey(roomId));
    if (assetIds.length === 0) {
      return;
    }

    const assets = await Promise.all(assetIds.map(assetId => this.getMediaAsset(assetId)));
    const members = assets
      .filter((asset): asset is MediaAsset => !!asset)
      .map(asset => ({
        score: getMediaAssetTimelineScore(asset),
        value: asset.id,
      }));
    if (members.length > 0) {
      await (this.redisClient as any).zAdd(timelineKey, members);
    }
  }

  async saveMediaAsset(asset: MediaAsset): Promise<MediaAsset | null> {
    try {
      await this.redisClient.hSet('media_assets', asset.id, JSON.stringify(asset));
      await this.redisClient.sAdd(getRoomMediaAssetsKey(asset.roomId), asset.id);
      await this.indexMediaAsset(asset);
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

  async readMediaHistoryPageByRoom(roomId: string, options: MediaHistoryPageOptions = {}): Promise<MediaHistoryPage> {
    const limit = normalizeMediaHistoryPageLimit(options.limit);
    const kinds = new Set(options.kinds?.length ? options.kinds : ['image', 'video', 'audio']);
    const sinceTime = Date.parse(options.since || '');
    const cursorTime = Date.parse(options.before?.createdAt || '');
    const minScore = Number.isFinite(sinceTime) ? sinceTime : '-inf';
    const maxScore = Number.isFinite(cursorTime) ? cursorTime : '+inf';
    const batchSize = Math.max(limit + 1, 40);
    const pageAssets: MediaAsset[] = [];
    let offset = 0;
    let hasMore = false;

    try {
      await this.ensureRoomMediaAssetTimeline(roomId);

      while (pageAssets.length <= limit) {
        const assetIds = await (this.redisClient as any).zRange(
          getRoomMediaAssetsTimelineKey(roomId),
          maxScore,
          minScore,
          {
            BY: 'SCORE',
            REV: true,
            LIMIT: { offset, count: batchSize },
          }
        ) as Array<string | Buffer>;
        if (assetIds.length === 0) {
          break;
        }

        offset += assetIds.length;
        const assets = await Promise.all(assetIds.map(assetId => this.getMediaAsset(assetId.toString())));
        for (const asset of assets) {
          if (!asset || asset.roomId !== roomId || !kinds.has(asset.kind)) {
            continue;
          }

          if (Number.isFinite(sinceTime) && getMediaAssetTimelineScore(asset) < sinceTime) {
            continue;
          }

          if (options.before && Number.isFinite(cursorTime) && !isBeforeMediaHistoryCursor(asset, options.before)) {
            continue;
          }

          pageAssets.push(asset);
          if (pageAssets.length > limit) {
            hasMore = true;
            break;
          }
        }

        if (assetIds.length < batchSize || hasMore) {
          break;
        }
      }

      return {
        assets: pageAssets.slice(0, limit),
        hasMore,
      };
    } catch (error) {
      this.logger.error('Error reading Redis media history page by room', { error, roomId, options });
      return { assets: [], hasMore: false };
    }
  }

  async deleteMediaAsset(assetId: string): Promise<void> {
    try {
      const asset = await this.getMediaAsset(assetId);
      await this.redisClient.hDel('media_assets', assetId);
      await this.redisClient.hDel(AUDIO_TRANSCRIPTIONS_KEY, assetId);
      if (asset) {
        await this.redisClient.sRem(getRoomMediaAssetsKey(asset.roomId), assetId);
        await (this.redisClient as any).zRem(getRoomMediaAssetsTimelineKey(asset.roomId), assetId);
      }
    } catch (error) {
      this.logger.error('Error deleting Redis media asset', { error, assetId });
    }
  }

  async savePendingMediaUpload(upload: PendingMediaUpload): Promise<void> {
    try {
      await this.redisClient.hSet(PENDING_MEDIA_UPLOADS_KEY, upload.assetId, JSON.stringify(upload));
      await (this.redisClient as any).zAdd(PENDING_MEDIA_UPLOADS_BY_EXPIRY_KEY, {
        score: Date.parse(upload.expiresAt),
        value: upload.assetId,
      });
    } catch (error) {
      this.logger.error('Error saving Redis pending media upload', { error, assetId: upload.assetId, roomId: upload.roomId });
      throw error;
    }
  }

  async getPendingMediaUpload(assetId: string): Promise<PendingMediaUpload | null> {
    try {
      const rawUpload = await this.redisClient.hGet(PENDING_MEDIA_UPLOADS_KEY, assetId);
      return rawUpload ? JSON.parse(rawUpload) as PendingMediaUpload : null;
    } catch (error) {
      this.logger.error('Error reading Redis pending media upload', { error, assetId });
      return null;
    }
  }

  async deletePendingMediaUpload(assetId: string): Promise<void> {
    try {
      await this.redisClient.hDel(PENDING_MEDIA_UPLOADS_KEY, assetId);
      await (this.redisClient as any).zRem(PENDING_MEDIA_UPLOADS_BY_EXPIRY_KEY, assetId);
    } catch (error) {
      this.logger.error('Error deleting Redis pending media upload', { error, assetId });
    }
  }

  async claimExpiredPendingMediaUploads(now: string, limit = 50): Promise<PendingMediaUpload[]> {
    const safeLimit = Math.min(200, Math.max(1, Math.floor(limit)));
    const nowScore = Date.parse(now);
    if (!Number.isFinite(nowScore)) {
      return [];
    }

    try {
      const assetIds = await (this.redisClient as any).zRange(
        PENDING_MEDIA_UPLOADS_BY_EXPIRY_KEY,
        '-inf',
        nowScore,
        {
          BY: 'SCORE',
          LIMIT: { offset: 0, count: safeLimit },
        }
      ) as Array<string | Buffer>;
      const ids = assetIds.map(assetId => assetId.toString());
      if (ids.length === 0) {
        return [];
      }

      const uploads = (await Promise.all(ids.map(assetId => this.getPendingMediaUpload(assetId))))
        .filter((upload): upload is PendingMediaUpload => !!upload);
      await Promise.all(ids.map(assetId => this.deletePendingMediaUpload(assetId)));
      return uploads;
    } catch (error) {
      this.logger.error('Error claiming expired Redis pending media uploads', { error, now, limit: safeLimit });
      return [];
    }
  }

  async getAudioTranscription(assetId: string): Promise<AudioTranscriptionRecord | null> {
    try {
      const rawRecord = await this.redisClient.hGet(AUDIO_TRANSCRIPTIONS_KEY, assetId);
      return rawRecord ? JSON.parse(rawRecord) as AudioTranscriptionRecord : null;
    } catch (error) {
      this.logger.error('Error reading Redis audio transcription', { error, assetId });
      return null;
    }
  }

  async createAudioTranscription(record: AudioTranscriptionRecord): Promise<AudioTranscriptionRecord> {
    try {
      const existing = await this.getAudioTranscription(record.assetId);
      if (existing) {
        return existing;
      }

      await this.redisClient.hSet(AUDIO_TRANSCRIPTIONS_KEY, record.assetId, JSON.stringify(record));
      return record;
    } catch (error) {
      this.logger.error('Error creating Redis audio transcription', { error, assetId: record.assetId, roomId: record.roomId, messageId: record.messageId });
      throw error;
    }
  }

  async updateAudioTranscription(assetId: string, updates: AudioTranscriptionUpdate): Promise<AudioTranscriptionRecord | null> {
    try {
      const existing = await this.getAudioTranscription(assetId);
      if (!existing) {
        return null;
      }

      const nextRecord: AudioTranscriptionRecord = {
        ...existing,
        updatedAt: updates.updatedAt || new Date().toISOString(),
      };
      if (updates.status !== undefined) nextRecord.status = updates.status;
      if (updates.transcript !== undefined) {
        if (updates.transcript === null) delete nextRecord.transcript;
        else nextRecord.transcript = updates.transcript;
      }
      if (updates.languageCode !== undefined) {
        if (updates.languageCode === null) delete nextRecord.languageCode;
        else nextRecord.languageCode = updates.languageCode;
      }
      if (updates.providerTranscriptId !== undefined) {
        if (updates.providerTranscriptId === null) delete nextRecord.providerTranscriptId;
        else nextRecord.providerTranscriptId = updates.providerTranscriptId;
      }
      if (updates.error !== undefined) {
        if (updates.error === null) delete nextRecord.error;
        else nextRecord.error = updates.error;
      }
      if (updates.completedAt !== undefined) {
        if (updates.completedAt === null) delete nextRecord.completedAt;
        else nextRecord.completedAt = updates.completedAt;
      }

      await this.redisClient.hSet(AUDIO_TRANSCRIPTIONS_KEY, assetId, JSON.stringify(nextRecord));
      return nextRecord;
    } catch (error) {
      this.logger.error('Error updating Redis audio transcription', { error, assetId, updates });
      throw error;
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
      const storedRoom = await this.writeRoomRecord(room.id, room);
      await this.redisClient.sAdd(`user:${room.creatorId}:rooms`, room.id);
      await this.addRoomMember(room.id, room.creatorId, 'owner', room.createdAt);
      this.logger.debug('Room saved to Redis', { roomId: room.id, creatorId: room.creatorId });
      return storedRoom;
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

  async savePushSubscription(subscription: SavePushSubscriptionInput): Promise<void> {
    const now = new Date().toISOString();
    try {
      const existingRaw = await this.redisClient.hGet(PUSH_SUBSCRIPTIONS_KEY, subscription.endpoint);
      const existing = existingRaw ? JSON.parse(existingRaw) as PushSubscriptionRecord : null;
      const record: PushSubscriptionRecord = {
        clientId: subscription.clientId,
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        userAgent: subscription.userAgent,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      await this.redisClient.hSet(PUSH_SUBSCRIPTIONS_KEY, subscription.endpoint, JSON.stringify(record));
    } catch (error) {
      this.logger.error('Error saving Redis push subscription', { error, clientId: subscription.clientId });
    }
  }

  async deletePushSubscription(clientId: string, endpoint: string): Promise<boolean> {
    try {
      const existingRaw = await this.redisClient.hGet(PUSH_SUBSCRIPTIONS_KEY, endpoint);
      if (!existingRaw) {
        return false;
      }

      const existing = JSON.parse(existingRaw) as PushSubscriptionRecord;
      if (existing.clientId !== clientId) {
        return false;
      }

      const removed = await this.redisClient.hDel(PUSH_SUBSCRIPTIONS_KEY, endpoint);
      return removed > 0;
    } catch (error) {
      this.logger.error('Error deleting Redis push subscription', { error, clientId });
      return false;
    }
  }

  async readPushSubscriptionsByRoom(roomId: string): Promise<PushSubscriptionRecord[]> {
    try {
      const members = await this.readRoomMembers(roomId);
      if (members.length === 0) {
        return [];
      }

      const memberIds = new Set(members.map(member => member.clientId));
      const rawSubscriptions = await this.redisClient.hVals(PUSH_SUBSCRIPTIONS_KEY);
      const subscriptions: PushSubscriptionRecord[] = [];
      for (const raw of rawSubscriptions) {
        try {
          const subscription = JSON.parse(raw) as PushSubscriptionRecord;
          if (memberIds.has(subscription.clientId)) {
            subscriptions.push(subscription);
          }
        } catch {
          // Ignore corrupted subscription records.
        }
      }
      return subscriptions.sort((first, second) => Date.parse(second.updatedAt) - Date.parse(first.updatedAt));
    } catch (error) {
      this.logger.error('Error reading Redis room push subscriptions', { error, roomId });
      return [];
    }
  }

  async setClientPasswordHash(clientId: string, passwordHash: string): Promise<void> {
    try {
      await this.redisClient.hSet(CLIENT_PASSWORDS_KEY, clientId, passwordHash);
    } catch (error) {
      this.logger.error('Error setting Redis client password hash', { error, clientId });
    }
  }

  async getClientPasswordHash(clientId: string): Promise<string | null> {
    try {
      return await this.redisClient.hGet(CLIENT_PASSWORDS_KEY, clientId) || null;
    } catch (error) {
      this.logger.error('Error reading Redis client password hash', { error, clientId });
      return null;
    }
  }

  async saveClientAuthToken(token: ClientAuthTokenRecord): Promise<void> {
    try {
      const record = JSON.stringify({
        clientId: token.clientId,
        tokenHash: token.tokenHash,
        createdAt: token.createdAt,
        lastUsedAt: token.createdAt,
      });
      await Promise.all([
        this.redisClient.hSet(CLIENT_AUTH_TOKENS_KEY, token.tokenHash, record),
        this.redisClient.sAdd(getClientAuthTokensKey(token.clientId), token.tokenHash),
      ]);
    } catch (error) {
      this.logger.error('Error saving Redis client auth token', { error, clientId: token.clientId });
    }
  }

  async isClientAuthTokenValid(clientId: string, tokenHash: string): Promise<boolean> {
    try {
      const rawToken = await this.redisClient.hGet(CLIENT_AUTH_TOKENS_KEY, tokenHash);
      if (!rawToken) {
        return false;
      }

      const token = JSON.parse(rawToken) as { clientId?: string; createdAt?: string };
      if (token.clientId !== clientId) {
        return false;
      }

      await this.redisClient.hSet(CLIENT_AUTH_TOKENS_KEY, tokenHash, JSON.stringify({
        ...token,
        tokenHash,
        lastUsedAt: new Date().toISOString(),
      }));
      return true;
    } catch (error) {
      this.logger.error('Error checking Redis client auth token', { error, clientId });
      return false;
    }
  }

  async deleteClientAuthToken(clientId: string, tokenHash: string): Promise<boolean> {
    try {
      const rawToken = await this.redisClient.hGet(CLIENT_AUTH_TOKENS_KEY, tokenHash);
      if (!rawToken) {
        return false;
      }

      const token = JSON.parse(rawToken) as { clientId?: string };
      if (token.clientId !== clientId) {
        return false;
      }

      const [removed] = await Promise.all([
        this.redisClient.hDel(CLIENT_AUTH_TOKENS_KEY, tokenHash),
        this.redisClient.sRem(getClientAuthTokensKey(clientId), tokenHash),
      ]);
      return removed > 0;
    } catch (error) {
      this.logger.error('Error deleting Redis client auth token', { error, clientId });
      return false;
    }
  }

  async deleteClientAuthTokens(clientId: string): Promise<void> {
    try {
      const tokenHashes = await this.redisClient.sMembers(getClientAuthTokensKey(clientId));
      if (tokenHashes.length > 0) {
        await this.redisClient.hDel(CLIENT_AUTH_TOKENS_KEY, tokenHashes);
      }
      await this.redisClient.del(getClientAuthTokensKey(clientId));
    } catch (error) {
      this.logger.error('Error deleting Redis client auth tokens', { error, clientId });
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
      const passwordMode = Object.prototype.hasOwnProperty.call(updates, 'passwordHash')
        ? updates.passwordHash
          ? 'set'
          : 'clear'
        : 'keep';
      const postingScheduleMode = Object.prototype.hasOwnProperty.call(updates, 'postingSchedule')
        ? updates.postingSchedule
          ? 'set'
          : 'clear'
        : 'keep';
      const result = await (this.redisClient as any).eval(UPDATE_ROOM_SETTINGS_SCRIPT, {
        keys: ['rooms', getRoomPasswordHashKey(roomId)],
        arguments: [
          roomId,
          new Date().toISOString(),
          passwordMode,
          updates.passwordHash || '',
          postingScheduleMode,
          updates.postingSchedule ? JSON.stringify(updates.postingSchedule) : '',
        ],
      });

      if (typeof result !== 'string' || !result) {
        return null;
      }

      return JSON.parse(result) as Room;
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

      const [storedRoom] = await Promise.all([
        this.writeRoomRecord(roomId, { ...room, creatorId: newOwnerClientId }),
        this.redisClient.sRem(`user:${previousOwnerId}:rooms`, roomId),
        this.redisClient.sAdd(`user:${newOwnerClientId}:rooms`, roomId),
      ]);
      return storedRoom;
    } catch (error) {
      this.logger.error('Error transferring Redis room ownership', { error, roomId, newOwnerClientId });
      return null;
    }
  }

  async readRoomsByUser(clientId: string): Promise<Room[]> {
    try {
      const userRoomsKey = `user:${clientId}:rooms`;
      const roomIds = await this.redisClient.sMembers(userRoomsKey);
      if (roomIds.length === 0) {
        this.logger.debug('Rooms read by user from Redis', { clientId, count: 0 });
        return [];
      }

      const roomEntries = await Promise.all(
        roomIds.map(async roomId => ({ roomId, roomJson: await this.redisClient.hGet('rooms', roomId) }))
      );
      const staleRoomIds: string[] = [];
      const rooms: Room[] = [];

      for (const { roomId, roomJson } of roomEntries) {
        if (!roomJson) {
          staleRoomIds.push(roomId);
          continue;
        }

        try {
          const room = JSON.parse(roomJson) as Room;
          if (room.creatorId === clientId) {
            rooms.push(room);
          } else {
            staleRoomIds.push(roomId);
          }
        } catch {
          staleRoomIds.push(roomId);
        }
      }

      await Promise.all(staleRoomIds.map(roomId => this.redisClient.sRem(userRoomsKey, roomId)));
      this.logger.debug('Rooms read by user from Redis', { clientId, count: rooms.length, staleCount: staleRoomIds.length });
      return rooms
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

  // 所有 TS 层房间写入统一走这里:盖 updatedAt + Lua 原子自增 roomVersion
  private async writeRoomRecord(roomId: string, room: Room): Promise<Room> {
    const stamped = stampRoomRecord(room);
    const result = await (this.redisClient as any).eval(WRITE_ROOM_RECORD_SCRIPT, {
      keys: ['rooms'],
      arguments: [roomId, JSON.stringify(stamped)],
    });
    if (typeof result === 'string' && result) {
      return JSON.parse(result) as Room;
    }
    return stamped;
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
      const result = await (this.redisClient as any).eval(UPDATE_ROOM_NAME_SCRIPT, {
        keys: ['rooms'],
        arguments: [roomId, creatorId, name, new Date().toISOString()],
      });
      if (!Array.isArray(result) || Number(result[0]) === 0) {
        this.logger.warn('Cannot rename missing Redis room', { roomId, creatorId });
        return null;
      }

      if (Number(result[0]) === 2) {
        this.logger.warn('Cannot rename Redis room for non-creator', { roomId, creatorId, roomCreatorId: result[1] });
        return null;
      }

      const updatedRoom = parseScriptRoom(result, 1);
      if (!updatedRoom) {
        return null;
      }
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

      return await this.writeRoomRecord(roomId, {
        ...room,
        lastActivityAt: lastActivityAt || room.createdAt,
      });
    } catch (error) {
      this.logger.error('Error updating room last activity', { error, roomId, lastActivityAt });
      return null;
    }
  }

  async updateRoomMemberCount(roomId: string, clientId: string, socketId: string, isJoining: boolean): Promise<number> {
    try {
      const roomMembersKey = `room:${roomId}:members`;
      const clientSocketsKey = `room:${roomId}:member_sockets:${clientId}`;
      const result = await (this.redisClient as any).eval(UPDATE_ROOM_MEMBER_COUNT_SCRIPT, {
        keys: [roomMembersKey, clientSocketsKey],
        arguments: [clientId, socketId, isJoining ? '1' : '0'],
      });
      return Number(result) || 0;
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
        this.redisClient.del(getRoomMediaAssetsTimelineKey(roomId)),
        ...members.map(member => this.redisClient.del(`room:${roomId}:member_sockets:${member.clientId}`)),
        ...mediaAssets.map(asset => this.redisClient.hDel('media_assets', asset.id)),
        ...mediaAssets.map(asset => this.redisClient.hDel(AUDIO_TRANSCRIPTIONS_KEY, asset.id)),
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

  async failInterruptedStreamingMessages(content: string, options: InterruptedStreamingMessageRecoveryOptions = {}): Promise<number> {
    try {
      const roomIds = await this.redisClient.hKeys('rooms');
      let updatedCount = 0;

      for (const roomId of roomIds) {
        const rawMessages = await this.redisClient.lRange(`room:${roomId}:messages`, 0, -1);
        const messages = rawMessages.map(rawMessage => JSON.parse(rawMessage) as Message);
        let changed = false;
        let changedCount = 0;
        const updatedMessages = messages.map(message => {
          if (message.status !== 'streaming') {
            return message;
          }
          if (options.aiStreamOwnerId && getAIStreamOwnerId(message) !== options.aiStreamOwnerId) {
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
        this.logger.warn('Marked interrupted Redis streaming messages as error', { count: updatedCount, aiStreamOwnerId: options.aiStreamOwnerId });
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
