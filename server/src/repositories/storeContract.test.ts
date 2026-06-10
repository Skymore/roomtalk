import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { AICost, MediaAsset, Message, Room, RoomMemberRole } from '../types';
import { PostgresClient, PostgresPool, PostgresQueryResult, PostgresStore } from './postgresStore';
import { RedisStore } from './redisStore';
import { DurableRoomStore } from './store';

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

  private updateRoomActivity(roomId: string, lastActivityAt: string, useGreatest: boolean) {
    const roomJson = this.hash('rooms').get(roomId);
    if (!roomJson) return null;

    const parsedRoom = JSON.parse(roomJson);
    const updatedRoom = {
      ...parsedRoom,
      lastActivityAt: useGreatest ? latest(parsedRoom.lastActivityAt || parsedRoom.createdAt, lastActivityAt) : lastActivityAt,
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
      if (deleted) deletedCount++;
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
    if (script.includes("redis.call('HSET', KEYS[3]")) {
      const [, messageKey, mediaAssetsKey, roomMediaAssetsKey] = options.keys;
      const [roomId, messagePayload, lastActivityAt, assetId, assetPayload] = options.arguments;
      const updatedRoom = this.updateRoomActivity(roomId, lastActivityAt, true);
      if (!updatedRoom) return [0, ''];
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
      if (!roomJson) return [0, 0, '', ''];
      const list = this.lists.get(messageKey) || [];
      const index = list.findIndex(item => {
        try {
          const parsed = JSON.parse(item);
          return parsed.id === messageId && parsed.messageType === 'media';
        } catch {
          return false;
        }
      });
      if (index === -1) return [1, 0, roomJson, ''];
      const updatedMessage = { ...JSON.parse(list[index]), content: '', messageType: 'media', mimeType };
      delete updatedMessage.mediaAsset;
      list[index] = JSON.stringify(updatedMessage);
      this.lists.set(messageKey, list);
      return [1, 1, roomJson, list[index]];
    }

    if (script.includes('local messagePayload')) {
      const [, messageKey] = options.keys;
      const [roomId, payload, lastActivityAt] = options.arguments;
      const updatedRoom = this.updateRoomActivity(roomId, lastActivityAt, true);
      if (!updatedRoom) return [0, ''];
      const list = this.lists.get(messageKey) || [];
      list.push(payload);
      this.lists.set(messageKey, list);
      return [1, JSON.stringify(updatedRoom)];
    }

    if (script.includes('redis.call(\'LSET\'')) {
      const [, messageKey] = options.keys;
      const [roomId, messageId, newContent, updatedAt] = options.arguments;
      const roomJson = this.hash('rooms').get(roomId);
      if (!roomJson) return [0, 0, '', ''];
      const list = this.lists.get(messageKey) || [];
      const index = list.findIndex(item => {
        try {
          return JSON.parse(item).id === messageId;
        } catch {
          return false;
        }
      });
      if (index === -1) return [1, 0, roomJson, ''];
      const updatedMessage = { ...JSON.parse(list[index]), content: newContent, updatedAt };
      list[index] = JSON.stringify(updatedMessage);
      this.lists.set(messageKey, list);
      return [1, 1, roomJson, list[index]];
    }

    if (script.includes('return { 1, found, #remaining, cjson.encode(room) }')) {
      const [, messageKey] = options.keys;
      const [roomId, messageId] = options.arguments;
      const roomJson = this.hash('rooms').get(roomId);
      if (!roomJson) return [0, 0, 0, ''];
      const list = this.lists.get(messageKey) || [];
      const remaining = list.filter(item => {
        try {
          return JSON.parse(item).id !== messageId;
        } catch {
          return true;
        }
      });
      const found = remaining.length !== list.length;
      if (!found) return [1, 0, list.length, roomJson];
      const latestTimestamp = getLatestMessageTimestamp(remaining.map(item => JSON.parse(item)));
      const room = JSON.parse(roomJson);
      const updatedRoom = { ...room, lastActivityAt: latestTimestamp || room.createdAt };
      this.hash('rooms').set(roomId, JSON.stringify(updatedRoom));
      this.lists.set(messageKey, remaining);
      return [1, 1, remaining.length, JSON.stringify(updatedRoom)];
    }

    if (script.includes('local mode = ARGV[3]')) {
      const [, messageKey] = options.keys;
      const [roomId, messageId, mode] = options.arguments;
      const roomJson = this.hash('rooms').get(roomId);
      if (!roomJson) return [0, 0, 0, ''];
      const list = this.lists.get(messageKey) || [];
      const targetIndex = list.findIndex(item => {
        try {
          return JSON.parse(item).id === messageId;
        } catch {
          return false;
        }
      });
      if (targetIndex === -1) return [1, 0, list.length, roomJson, ...list];
      const keepCount = mode === 'before' ? targetIndex : targetIndex + 1;
      const remaining = list.slice(0, keepCount);
      const latestTimestamp = getLatestMessageTimestamp(remaining.map(item => JSON.parse(item)));
      const room = JSON.parse(roomJson);
      const updatedRoom = { ...room, lastActivityAt: latestTimestamp || room.createdAt };
      this.hash('rooms').set(roomId, JSON.stringify(updatedRoom));
      this.lists.set(messageKey, remaining);
      return [1, 1, remaining.length, JSON.stringify(updatedRoom), ...remaining];
    }

    if (script.includes('cjson.encode(room), updatedPayload')) {
      const [, messageKey] = options.keys;
      const [roomId, messageId, newContent, updatedAt] = options.arguments;
      const roomJson = this.hash('rooms').get(roomId);
      if (!roomJson) return [0, 0, 0, '', ''];
      const list = this.lists.get(messageKey) || [];
      const targetIndex = list.findIndex(item => {
        try {
          return JSON.parse(item).id === messageId;
        } catch {
          return false;
        }
      });
      if (targetIndex === -1) return [1, 0, list.length, roomJson, '', ...list];
      const updatedMessage = { ...JSON.parse(list[targetIndex]), content: newContent, updatedAt };
      const remaining = [...list.slice(0, targetIndex), JSON.stringify(updatedMessage)];
      const latestTimestamp = getLatestMessageTimestamp(remaining.map(item => JSON.parse(item)));
      const room = JSON.parse(roomJson);
      const updatedRoom = { ...room, lastActivityAt: latestTimestamp || room.createdAt };
      this.hash('rooms').set(roomId, JSON.stringify(updatedRoom));
      this.lists.set(messageKey, remaining);
      return [1, 1, remaining.length, JSON.stringify(updatedRoom), JSON.stringify(updatedMessage), ...remaining];
    }

    if (script.includes('local payload = ARGV[3]')) {
      const [, messageKey] = options.keys;
      const [roomId, targetId, payload, lastActivityAt] = options.arguments;
      const updatedRoom = this.updateRoomActivity(roomId, lastActivityAt, true);
      if (!updatedRoom) return [0, 0, 0, ''];
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
    const updatedRoom = this.updateRoomActivity(roomId, lastActivityAt, false);
    if (!updatedRoom) return [0, 0, ''];
    this.lists.set(messageKey, messages);
    return [1, messages.length, JSON.stringify(updatedRoom)];
  }

  async flushDb() {
    this.hashes.clear();
    this.lists.clear();
    this.sets.clear();
    this.strings.clear();
  }
}

type RoomRow = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  last_activity_at: string;
  creator_id: string;
  message_version?: number;
  updated_at?: string;
};

type MessageRow = {
  id: string;
  room_id: string;
  client_id: string;
  content: string;
  timestamp: string;
  updated_at: string | null;
  message_type: Message['messageType'];
  username: string | null;
  avatar: unknown;
  mime_type: string | null;
  status: Message['status'] | null;
  ai_model: unknown;
  usage: unknown;
  cost: unknown;
  reply_to: unknown;
  position: number;
};

type RoomMemberRow = {
  room_id: string;
  client_id: string;
  role: RoomMemberRole;
  joined_at: string;
};

type MediaAssetRow = {
  id: string;
  room_id: string;
  message_id: string | null;
  object_key: string;
  kind: MediaAsset['kind'];
  mime_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  uploaded_by_client_id: string | null;
  created_at: string;
};

const toTime = (value: string) => Date.parse(value) || 0;
const latest = (first: string, second: string) => toTime(first) >= toTime(second) ? first : second;
function getLatestMessageTimestamp(messages: Message[]): string | undefined {
  return messages.reduce<string | undefined>((currentLatest, item) => (
    !currentLatest || toTime(item.timestamp) > toTime(currentLatest)
      ? item.timestamp
      : currentLatest
  ), undefined);
}
const jsonValue = (value: unknown) => value === null || value === undefined ? null : value;

class StatefulPostgresPool implements PostgresPool, PostgresClient {
  rooms = new Map<string, RoomRow>();
  messages = new Map<string, MessageRow[]>();
  roomMembers = new Map<string, Map<string, RoomMemberRow>>();
  roomSaves = new Map<string, Map<string, string>>();
  mediaAssets = new Map<string, MediaAssetRow>();
  costs = new Map<string, number>();
  clientProfiles = new Map<string, string>();
  released = false;

  async connect(): Promise<PostgresClient> {
    this.released = false;
    return this;
  }

  release() {
    this.released = true;
  }

  async query<T = any>(sql: string, params: unknown[] = []): Promise<PostgresQueryResult<T>> {
    const compactSql = sql.replace(/\s+/g, ' ').trim();

    if (compactSql === 'BEGIN' || compactSql === 'COMMIT' || compactSql === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }

    if (/INSERT INTO client_profiles/.test(compactSql)) {
      this.clientProfiles.set(String(params[0]), String(params[1]));
      return { rows: [], rowCount: 1 };
    }

    if (/SELECT client_id, nickname FROM client_profiles WHERE client_id = ANY\(\$1\)/.test(compactSql)) {
      const ids = (params[0] as string[]) || [];
      const rows = ids
        .filter(id => this.clientProfiles.has(id))
        .map(id => ({ client_id: id, nickname: this.clientProfiles.get(id) }));
      return { rows: rows as T[], rowCount: rows.length };
    }

    if (/SELECT 1 FROM rooms WHERE id = \$1 LIMIT 1/.test(compactSql)) {
      return { rows: (this.rooms.has(String(params[0])) ? [{}] : []) as T[], rowCount: this.rooms.has(String(params[0])) ? 1 : 0 };
    }

    if (/INSERT INTO rooms/.test(compactSql)) {
      const [id, name, description, createdAt, lastActivityAt, creatorId] = params.map(String);
      const existing = this.rooms.get(id);
      const saved: RoomRow = existing
        ? {
          ...existing,
          name,
          description,
          last_activity_at: latest(existing.last_activity_at, lastActivityAt),
          updated_at: new Date().toISOString(),
        }
        : {
          id,
          name,
          description,
          created_at: createdAt,
          last_activity_at: lastActivityAt,
          creator_id: creatorId,
          message_version: 0,
          updated_at: new Date().toISOString(),
        };
      this.rooms.set(id, saved);
      return { rows: [saved] as T[], rowCount: 1 };
    }

    if (/INSERT INTO room_members/.test(compactSql)) {
      const roomId = String(params[0]);
      const clientId = String(params[1]);
      const role = (params.length >= 4 ? String(params[2]) : 'owner') as RoomMemberRole;
      const joinedAt = String(params.length >= 4 ? params[3] : params[2]);
      const roomMembers = this.roomMembers.get(roomId) || new Map<string, RoomMemberRow>();
      const existing = roomMembers.get(clientId);
      const member: RoomMemberRow = {
        room_id: roomId,
        client_id: clientId,
        role: existing?.role === 'owner' || role === 'owner' ? 'owner' : 'member',
        joined_at: existing?.joined_at || joinedAt,
      };
      roomMembers.set(clientId, member);
      this.roomMembers.set(roomId, roomMembers);
      return { rows: [member] as T[], rowCount: 1 };
    }

    if (/DELETE FROM room_members WHERE room_id = \$1 AND client_id = \$2 AND role <> 'owner'/.test(compactSql)) {
      const roomId = String(params[0]);
      const clientId = String(params[1]);
      const roomMembers = this.roomMembers.get(roomId);
      const existing = roomMembers?.get(clientId);
      if (!roomMembers || !existing || existing.role === 'owner') {
        return { rows: [], rowCount: 0 };
      }
      roomMembers.delete(clientId);
      return { rows: [], rowCount: 1 };
    }

    if (/SELECT 1 FROM room_members WHERE room_id = \$1 AND client_id = \$2 LIMIT 1/.test(compactSql)) {
      const member = this.roomMembers.get(String(params[0]))?.get(String(params[1]));
      return { rows: (member ? [{}] : []) as T[], rowCount: member ? 1 : 0 };
    }

    if (/FROM room_members WHERE room_id = \$1 AND client_id = \$2/.test(compactSql)) {
      const member = this.roomMembers.get(String(params[0]))?.get(String(params[1]));
      return { rows: (member ? [member] : []) as T[], rowCount: member ? 1 : 0 };
    }

    if (/FROM room_members WHERE room_id = \$1 ORDER BY joined_at ASC/.test(compactSql)) {
      const rows = [...(this.roomMembers.get(String(params[0]))?.values() || [])]
        .sort((first, second) => toTime(first.joined_at) - toTime(second.joined_at));
      return { rows: rows as T[], rowCount: rows.length };
    }

    if (/FROM rooms WHERE id = \$1 FOR UPDATE/.test(compactSql)) {
      const room = this.rooms.get(String(params[0]));
      return { rows: (room ? [room] : []) as T[], rowCount: room ? 1 : 0 };
    }

    if (/SELECT COALESCE\(MAX\(position\), -1\) \+ 1 AS position FROM room_messages WHERE room_id = \$1/.test(compactSql)) {
      const rows = this.messages.get(String(params[0])) || [];
      const maxPosition = rows.reduce((max, row) => Math.max(max, row.position), -1);
      return { rows: [{ position: maxPosition + 1 }] as T[], rowCount: 1 };
    }

    if (/INSERT INTO room_messages/.test(compactSql)) {
      const [
        id,
        roomId,
        clientId,
        content,
        timestamp,
        updatedAt,
        messageType,
        username,
        avatar,
        mimeType,
        status,
        aiModel,
        usage,
        cost,
        replyTo,
        position,
      ] = params;
      const roomMessages = this.messages.get(String(roomId)) || [];
      const existingIndex = roomMessages.findIndex(message => message.id === id);
      const existingPosition = existingIndex === -1 ? Number(position) : roomMessages[existingIndex].position;
      const row: MessageRow = {
        id: String(id),
        room_id: String(roomId),
        client_id: String(clientId),
        content: String(content),
        timestamp: String(timestamp),
        updated_at: updatedAt === null || updatedAt === undefined ? null : String(updatedAt),
        message_type: messageType as Message['messageType'],
        username: username === null || username === undefined ? null : String(username),
        avatar: jsonValue(avatar),
        mime_type: mimeType === null || mimeType === undefined ? null : String(mimeType),
        status: status === null || status === undefined ? null : status as Message['status'],
        ai_model: jsonValue(aiModel),
        usage: jsonValue(usage),
        cost: jsonValue(cost),
        reply_to: jsonValue(replyTo),
        position: existingPosition,
      };
      if (existingIndex === -1) {
        roomMessages.push(row);
      } else {
        roomMessages[existingIndex] = row;
      }
      this.messages.set(String(roomId), roomMessages);
      return { rows: [], rowCount: 1 };
    }

    if (/INSERT INTO media_assets/.test(compactSql)) {
      const [id, roomId, messageId, objectKey, kind, mimeType, byteSize, width, height, durationMs, uploadedByClientId, createdAt] = params;
      const row: MediaAssetRow = {
        id: String(id),
        room_id: String(roomId),
        message_id: messageId === null || messageId === undefined ? null : String(messageId),
        object_key: String(objectKey),
        kind: kind as MediaAsset['kind'],
        mime_type: String(mimeType),
        byte_size: Number(byteSize),
        width: width === null || width === undefined ? null : Number(width),
        height: height === null || height === undefined ? null : Number(height),
        duration_ms: durationMs === null || durationMs === undefined ? null : Number(durationMs),
        uploaded_by_client_id: uploadedByClientId === null || uploadedByClientId === undefined ? null : String(uploadedByClientId),
        created_at: String(createdAt),
      };
      this.mediaAssets.set(row.id, row);
      return { rows: [row] as T[], rowCount: 1 };
    }

    if (/^SELECT .* FROM media_assets WHERE id = \$1/.test(compactSql)) {
      const row = this.mediaAssets.get(String(params[0]));
      return { rows: (row ? [row] : []) as T[], rowCount: row ? 1 : 0 };
    }

    if (/^SELECT .* FROM media_assets WHERE message_id = \$1/.test(compactSql)) {
      const row = [...this.mediaAssets.values()].find(asset => asset.message_id === params[0]);
      return { rows: (row ? [row] : []) as T[], rowCount: row ? 1 : 0 };
    }

    if (/^SELECT .* FROM media_assets WHERE room_id = \$1 ORDER BY created_at ASC/.test(compactSql)) {
      const rows = [...this.mediaAssets.values()]
        .filter(asset => asset.room_id === params[0])
        .sort((first, second) => toTime(first.created_at) - toTime(second.created_at));
      return { rows: rows as T[], rowCount: rows.length };
    }

    if (/DELETE FROM media_assets WHERE room_id = \$1 AND message_id = \$2 RETURNING object_key/.test(compactSql)) {
      const [roomId, messageId] = params.map(String);
      const removed = [...this.mediaAssets.values()].filter(asset => asset.room_id === roomId && asset.message_id === messageId);
      removed.forEach(asset => this.mediaAssets.delete(asset.id));
      return { rows: removed.map(asset => ({ object_key: asset.object_key })) as T[], rowCount: removed.length };
    }

    const mediaByPositionMatch = compactSql.match(/DELETE FROM media_assets WHERE room_id = \$1 AND message_id IN \( SELECT id FROM room_messages WHERE room_id = \$1 AND position (>=|>) \$2 \) RETURNING object_key/);
    if (mediaByPositionMatch) {
      const operator = mediaByPositionMatch[1];
      const roomId = String(params[0]);
      const position = Number(params[1]);
      const roomMessages = this.messages.get(roomId) || [];
      const targetIds = new Set(
        roomMessages
          .filter(row => operator === '>=' ? Number(row.position) >= position : Number(row.position) > position)
          .map(row => row.id)
      );
      const removed = [...this.mediaAssets.values()].filter(asset => asset.room_id === roomId && asset.message_id !== null && targetIds.has(asset.message_id));
      removed.forEach(asset => this.mediaAssets.delete(asset.id));
      return { rows: removed.map(asset => ({ object_key: asset.object_key })) as T[], rowCount: removed.length };
    }

    if (/DELETE FROM media_assets WHERE room_id = \$1 RETURNING object_key/.test(compactSql)) {
      const roomId = String(params[0]);
      const removed = [...this.mediaAssets.values()].filter(asset => asset.room_id === roomId);
      removed.forEach(asset => this.mediaAssets.delete(asset.id));
      return { rows: removed.map(asset => ({ object_key: asset.object_key })) as T[], rowCount: removed.length };
    }

    if (/DELETE FROM media_assets WHERE id = \$1/.test(compactSql)) {
      const deleted = this.mediaAssets.delete(String(params[0]));
      return { rows: [], rowCount: deleted ? 1 : 0 };
    }

    if (/UPDATE rooms SET last_activity_at = GREATEST/.test(compactSql)) {
      const roomId = String(params[0]);
      const timestamp = String(params[1]);
      const messageVersionIncrement = Number(params[2] || 0);
      const room = this.rooms.get(roomId);
      if (!room) return { rows: [], rowCount: 0 };
      const updated = {
        ...room,
        last_activity_at: latest(room.last_activity_at, timestamp),
        message_version: (room.message_version || 0) + messageVersionIncrement,
        updated_at: new Date().toISOString(),
      };
      this.rooms.set(roomId, updated);
      return { rows: [updated] as T[], rowCount: 1 };
    }

    if (/UPDATE rooms SET last_activity_at = \$2, message_version = message_version \+ \$3, updated_at = NOW\(\) WHERE id = \$1 RETURNING/.test(compactSql)) {
      const roomId = String(params[0]);
      const timestamp = String(params[1]);
      const messageVersionIncrement = Number(params[2] || 0);
      const room = this.rooms.get(roomId);
      if (!room) return { rows: [], rowCount: 0 };
      const updated = {
        ...room,
        last_activity_at: timestamp,
        message_version: (room.message_version || 0) + messageVersionIncrement,
        updated_at: new Date().toISOString(),
      };
      this.rooms.set(roomId, updated);
      return { rows: [updated] as T[], rowCount: 1 };
    }

    if (/UPDATE rooms SET last_activity_at = \$2, message_version = message_version \+ 1, updated_at = NOW\(\) WHERE id = \$1 RETURNING/.test(compactSql)) {
      const roomId = String(params[0]);
      const timestamp = String(params[1]);
      const room = this.rooms.get(roomId);
      if (!room) return { rows: [], rowCount: 0 };
      const updated = {
        ...room,
        last_activity_at: timestamp,
        message_version: (room.message_version || 0) + 1,
        updated_at: new Date().toISOString(),
      };
      this.rooms.set(roomId, updated);
      return { rows: [updated] as T[], rowCount: 1 };
    }

    if (/UPDATE rooms SET message_version = message_version \+ 1, last_activity_at = created_at, updated_at = NOW\(\) WHERE id = \$1/.test(compactSql)) {
      const roomId = String(params[0]);
      const room = this.rooms.get(roomId);
      if (!room) return { rows: [], rowCount: 0 };
      const updated = {
        ...room,
        last_activity_at: room.created_at,
        message_version: (room.message_version || 0) + 1,
        updated_at: new Date().toISOString(),
      };
      this.rooms.set(roomId, updated);
      return { rows: [updated] as T[], rowCount: 1 };
    }

    if (/UPDATE rooms SET name = \$3, updated_at = NOW\(\) WHERE id = \$1 AND creator_id = \$2 RETURNING/.test(compactSql)) {
      const [roomId, creatorId, name] = params.map(String);
      const room = this.rooms.get(roomId);
      if (!room || room.creator_id !== creatorId) return { rows: [], rowCount: 0 };
      const updated = { ...room, name, updated_at: new Date().toISOString() };
      this.rooms.set(roomId, updated);
      return { rows: [updated] as T[], rowCount: 1 };
    }

    if (/UPDATE room_messages SET content = \$3, message_type = 'media', mime_type = \$4 WHERE room_id = \$1 AND id = \$2 AND message_type = 'media' RETURNING/.test(compactSql)) {
      const [roomId, messageId, content, mimeType] = params.map(String);
      const rows = this.messages.get(roomId) || [];
      const index = rows.findIndex(row => row.id === messageId && row.message_type === 'media');
      if (index === -1) return { rows: [], rowCount: 0 };
      const updated = { ...rows[index], content, message_type: 'media' as const, mime_type: mimeType };
      rows[index] = updated;
      this.messages.set(roomId, rows);
      return { rows: [updated] as T[], rowCount: 1 };
    }

    if (/UPDATE room_messages SET content = \$3, updated_at = \$4 WHERE room_id = \$1 AND id = \$2 RETURNING/.test(compactSql)) {
      const [roomId, messageId, content, updatedAt] = params.map(String);
      const rows = this.messages.get(roomId) || [];
      const index = rows.findIndex(row => row.id === messageId);
      if (index === -1) return { rows: [], rowCount: 0 };
      const updated = { ...rows[index], content, updated_at: updatedAt };
      rows[index] = updated;
      this.messages.set(roomId, rows);
      return { rows: [updated] as T[], rowCount: 1 };
    }

    if (/UPDATE room_messages SET content = \$3 WHERE room_id = \$1 AND id = \$2 RETURNING/.test(compactSql)) {
      const [roomId, messageId, content] = params.map(String);
      const rows = this.messages.get(roomId) || [];
      const index = rows.findIndex(row => row.id === messageId);
      if (index === -1) return { rows: [], rowCount: 0 };
      const updated = { ...rows[index], content };
      rows[index] = updated;
      this.messages.set(roomId, rows);
      return { rows: [updated] as T[], rowCount: 1 };
    }

    if (/DELETE FROM room_messages WHERE room_id = \$1 AND id = \$2 RETURNING id/.test(compactSql)) {
      const [roomId, messageId] = params.map(String);
      const rows = this.messages.get(roomId) || [];
      const remaining = rows.filter(row => row.id !== messageId);
      const deleted = remaining.length !== rows.length;
      this.messages.set(roomId, remaining);
      return { rows: (deleted ? [{ id: messageId }] : []) as T[], rowCount: deleted ? 1 : 0 };
    }

    if (/SELECT position FROM room_messages WHERE room_id = \$1 AND id = \$2/.test(compactSql)) {
      const [roomId, messageId] = params.map(String);
      const row = (this.messages.get(roomId) || []).find(item => item.id === messageId);
      return { rows: (row ? [{ position: row.position }] : []) as T[], rowCount: row ? 1 : 0 };
    }

    if (/DELETE FROM room_messages WHERE room_id = \$1 AND position (>=|>) \$2/.test(compactSql)) {
      const roomId = String(params[0]);
      const position = Number(params[1]);
      const deleteAtOrAfter = /position >= \$2/.test(compactSql);
      const rows = this.messages.get(roomId) || [];
      const remaining = rows.filter(row => deleteAtOrAfter ? row.position < position : row.position <= position);
      const deletedCount = rows.length - remaining.length;
      this.messages.set(roomId, remaining);
      return { rows: [], rowCount: deletedCount };
    }

    if (/SELECT timestamp FROM room_messages WHERE room_id = \$1 ORDER BY timestamp DESC LIMIT 1/.test(compactSql)) {
      const rows = [...(this.messages.get(String(params[0])) || [])]
        .sort((first, second) => toTime(second.timestamp) - toTime(first.timestamp));
      return { rows: (rows[0] ? [{ timestamp: rows[0].timestamp }] : []) as T[], rowCount: rows[0] ? 1 : 0 };
    }

    if (/DELETE FROM room_messages WHERE room_id = \$1/.test(compactSql)) {
      const roomId = String(params[0]);
      const count = this.messages.get(roomId)?.length || 0;
      this.messages.delete(roomId);
      return { rows: [], rowCount: count };
    }

    if (/FROM room_messages WHERE room_id = \$1 AND position < \$2 ORDER BY position DESC LIMIT \$3/.test(compactSql)) {
      const [roomId, position, limit] = params;
      const rows = [...(this.messages.get(String(roomId)) || [])]
        .filter(row => row.position < Number(position))
        .sort((first, second) => second.position - first.position || toTime(second.timestamp) - toTime(first.timestamp))
        .slice(0, Number(limit));
      return { rows: rows as T[], rowCount: rows.length };
    }

    if (/FROM room_messages WHERE room_id = \$1 ORDER BY position DESC LIMIT \$2/.test(compactSql)) {
      const [roomId, limit] = params;
      const rows = [...(this.messages.get(String(roomId)) || [])]
        .sort((first, second) => second.position - first.position || toTime(second.timestamp) - toTime(first.timestamp))
        .slice(0, Number(limit));
      return { rows: rows as T[], rowCount: rows.length };
    }

    if (/FROM room_messages WHERE room_id = \$1 ORDER BY position ASC/.test(compactSql)) {
      const rows = [...(this.messages.get(String(params[0])) || [])]
        .sort((first, second) => first.position - second.position || toTime(first.timestamp) - toTime(second.timestamp));
      return { rows: rows as T[], rowCount: rows.length };
    }

    if (/SELECT total_usd FROM room_ai_cost_totals WHERE room_id = \$1/.test(compactSql)) {
      const total = this.costs.get(String(params[0]));
      return { rows: (total === undefined ? [] : [{ total_usd: String(total) }]) as T[], rowCount: total === undefined ? 0 : 1 };
    }

    if (/INSERT INTO room_ai_cost_totals/.test(compactSql)) {
      const roomId = String(params[0]);
      const amount = Number(params[1]);
      const next = /room_ai_cost_totals\.total_usd \+ EXCLUDED\.total_usd/.test(compactSql)
        ? (this.costs.get(roomId) || 0) + amount
        : amount;
      this.costs.set(roomId, next);
      return { rows: [{ total_usd: String(next) }] as T[], rowCount: 1 };
    }

    if (/INSERT INTO room_saves/.test(compactSql)) {
      const roomId = String(params[0]);
      const clientId = String(params[1]);
      const savedAt = String(params[2]);
      if (!this.rooms.has(roomId)) {
        return { rows: [], rowCount: 0 };
      }

      const roomSaves = this.roomSaves.get(clientId) || new Map<string, string>();
      roomSaves.set(roomId, savedAt);
      this.roomSaves.set(clientId, roomSaves);
      return { rows: [{ room_id: roomId }] as T[], rowCount: 1 };
    }

    if (/DELETE FROM room_saves WHERE room_id = \$1 AND client_id = \$2/.test(compactSql)) {
      const roomId = String(params[0]);
      const clientId = String(params[1]);
      const deleted = this.roomSaves.get(clientId)?.delete(roomId) || false;
      return { rows: [], rowCount: deleted ? 1 : 0 };
    }

    if (/DELETE FROM room_ai_cost_totals WHERE room_id = \$1/.test(compactSql)) {
      const deleted = this.costs.delete(String(params[0]));
      return { rows: [], rowCount: deleted ? 1 : 0 };
    }

    if (/FROM rooms WHERE creator_id = \$1/.test(compactSql)) {
      const clientId = String(params[0]);
      const rows = [...this.rooms.values()]
        .filter(room => room.creator_id === clientId)
        .sort((first, second) => toTime(second.last_activity_at) - toTime(first.last_activity_at) || toTime(second.created_at) - toTime(first.created_at));
      return { rows: rows as T[], rowCount: rows.length };
    }

    if (/FROM rooms r INNER JOIN room_saves rs ON rs.room_id = r.id WHERE rs.client_id = \$1/.test(compactSql)) {
      const clientId = String(params[0]);
      const saves = this.roomSaves.get(clientId) || new Map<string, string>();
      const rows = [...saves.entries()]
        .map(([roomId, savedAt]) => ({ room: this.rooms.get(roomId), savedAt }))
        .filter((item): item is { room: RoomRow; savedAt: string } => !!item.room)
        .sort((first, second) => (
          toTime(second.savedAt) - toTime(first.savedAt)
          || toTime(second.room.last_activity_at) - toTime(first.room.last_activity_at)
          || toTime(second.room.created_at) - toTime(first.room.created_at)
        ))
        .map(item => item.room);
      return { rows: rows as T[], rowCount: rows.length };
    }

    if (/SELECT 1 FROM rooms WHERE id = \$1 AND creator_id = \$2/.test(compactSql)) {
      const room = this.rooms.get(String(params[0]));
      const owned = !!room && room.creator_id === params[1];
      return { rows: (owned ? [{ '?column?': 1 }] : []) as T[], rowCount: owned ? 1 : 0 };
    }

    if (/SELECT .* FROM rooms WHERE id = \$1/.test(compactSql)) {
      const row = this.rooms.get(String(params[0]));
      return { rows: (row ? [row] : []) as T[], rowCount: row ? 1 : 0 };
    }

    if (/DELETE FROM rooms WHERE id = \$1 AND creator_id = \$2/.test(compactSql)) {
      const roomId = String(params[0]);
      const room = this.rooms.get(roomId);
      if (!room || room.creator_id !== params[1]) {
        return { rows: [], rowCount: 0 };
      }
      this.rooms.delete(roomId);
      this.messages.delete(roomId);
      this.roomMembers.delete(roomId);
      for (const saves of this.roomSaves.values()) {
        saves.delete(roomId);
      }
      for (const [assetId, asset] of this.mediaAssets.entries()) {
        if (asset.room_id === roomId) {
          this.mediaAssets.delete(assetId);
        }
      }
      this.costs.delete(roomId);
      return { rows: [], rowCount: 1 };
    }

    if (/SELECT COUNT\(\*\) AS count FROM rooms/.test(compactSql)) {
      return { rows: [{ count: String(this.rooms.size) }] as T[], rowCount: 1 };
    }

    if (/TRUNCATE room_ai_cost_totals, media_assets, image_assets, room_messages, room_saves, room_members, rooms/.test(compactSql)) {
      this.rooms.clear();
      this.messages.clear();
      this.roomMembers.clear();
      this.roomSaves.clear();
      this.mediaAssets.clear();
      this.costs.clear();
      this.clientProfiles.clear();
      return { rows: [], rowCount: 0 };
    }

    if (/UPDATE room_messages SET status = 'error'/.test(compactSql)) {
      let updatedCount = 0;
      const timestamp = new Date().toISOString();
      for (const [roomId, messages] of this.messages.entries()) {
        this.messages.set(roomId, messages.map(message => {
          if (message.status !== 'streaming') {
            return message;
          }
          updatedCount++;
          return {
            ...message,
            status: 'error',
            content: String(params[0]),
            timestamp,
          };
        }));
      }
      return { rows: [], rowCount: updatedCount };
    }

    throw new Error(`Unhandled stateful PostgreSQL query: ${compactSql}`);
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

// 房间写入路径统一盖 updatedAt;形状断言剥离它,另以 typeof 断言其存在
const stripRoomStamp = <T extends { updatedAt?: string }>(value: T | null | undefined) => {
  if (!value) {
    return value;
  }
  const { updatedAt: _updatedAt, ...rest } = value;
  return rest;
};

const cost = (totalUsd: number): AICost => ({
  currency: 'USD',
  inputUsd: totalUsd,
  outputUsd: 0,
  totalUsd,
  inputPerMillion: 1,
  outputPerMillion: 1,
  estimated: false,
});

type StoreFixture = {
  store: DurableRoomStore;
};

type DurableRoomStoreWithMessageMutations = DurableRoomStore & {
  updateMessageContent(roomId: string, messageId: string, newContent: string, updatedAt?: string): Promise<{ room: Room; found: boolean; updatedMessage?: Message } | null>;
  deleteMessageById(roomId: string, messageId: string): Promise<{ room: Room; deleted: boolean } | null>;
  truncateBeforeMessage(roomId: string, messageId: string): Promise<{ room: Room; messages: Message[]; targetFound: boolean } | null>;
  truncateAfterMessage(roomId: string, messageId: string): Promise<{ room: Room; messages: Message[]; targetFound: boolean } | null>;
  updateMessageAndTruncateAfter(roomId: string, messageId: string, newContent: string, updatedAt?: string): Promise<{ room: Room; targetFound: boolean; updatedMessage?: Message; messages: Message[] } | null>;
};

const storeFactories: Array<[string, () => StoreFixture]> = [
  ['RedisStore', () => ({ store: new RedisStore(new MemoryRedis() as any, logger as any) })],
  ['PostgresStore', () => ({ store: new PostgresStore(new StatefulPostgresPool(), logger as any) })],
];

for (const [storeName, createFixture] of storeFactories) {
  describe(`${storeName} durable contract`, () => {
    it('persists client nicknames and reads them back in batch', async () => {
      const { store } = createFixture();

      assert.deepEqual(await store.getClientNicknames([]), {});

      await store.setClientNickname('client-1', 'Ada');
      await store.setClientNickname('client-2', 'Grace');
      // Later writes overwrite the stored nickname.
      await store.setClientNickname('client-1', 'Ada Lovelace');

      assert.deepEqual(await store.getClientNicknames(['client-1', 'client-2', 'client-missing']), {
        'client-1': 'Ada Lovelace',
        'client-2': 'Grace',
      });
    });

    it('preserves room, message, metadata, ordering, and clear semantics', async () => {
      const { store } = createFixture();
      const initialRoom = room();
      const first = message({
        id: 'm1',
        content: 'first',
        timestamp: '2026-05-03T00:00:01.000Z',
        username: 'User',
        avatar: { text: 'U', color: '#123456' },
      });
      const second = message({
        id: 'm2',
        content: 'second',
        timestamp: '2026-05-03T00:00:02.000Z',
        messageType: 'ai',
        clientId: 'ai_assistant',
        status: 'streaming',
        aiModel: { id: 'deepseek-v4-pro', apiModel: 'deepseek-chat', provider: 'deepseek', label: 'DeepSeek V4 Pro' },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, source: 'reported' },
        cost: cost(0.01),
      });
      const third = message({
        id: 'm3',
        content: 'third',
        timestamp: '2026-05-03T00:00:03.000Z',
      });
      const updatedSecond = {
        ...second,
        content: 'updated second',
        status: 'complete' as const,
        timestamp: '2026-05-03T00:00:04.000Z',
      };
      const replacement = message({
        id: 'replacement',
        content: 'replacement',
        timestamp: '2026-05-03T00:00:05.000Z',
      });

      assert.deepEqual(stripRoomStamp(await store.saveRoom(initialRoom)), initialRoom);
      assert.equal(await store.countRooms(), 1);
      assert.deepEqual(stripRoomStamp(await store.getRoomById(initialRoom.id)), initialRoom);

      await store.appendMessage(first);
      await store.appendMessage(second);
      await store.upsertMessage(updatedSecond);
      await store.upsertMessage(third);

      assert.deepEqual(await store.readMessagesByRoom(initialRoom.id), [first, updatedSecond, third]);
      assert.deepEqual((await store.readRoomsByUser(initialRoom.creatorId)).map(item => item.id), [initialRoom.id]);

      const savedHistoryRoom = await store.saveMessageHistory(initialRoom.id, [replacement]);
      assert.equal(savedHistoryRoom?.id, initialRoom.id);
      assert.equal(savedHistoryRoom?.lastActivityAt, replacement.timestamp);
      assert.deepEqual(await store.readMessagesByRoom(initialRoom.id), [replacement]);
      const versionBeforeClear = (await store.readMessagePageByRoom(initialRoom.id)).historyVersion;
      assert.equal(await store.clearRoomMessages(initialRoom.id), 1);
      assert.deepEqual(await store.readMessagesByRoom(initialRoom.id), []);
      const versionAfterClear = (await store.readMessagePageByRoom(initialRoom.id)).historyVersion;
      assert.equal(versionAfterClear, versionBeforeClear + 1);
    });

    it('reads latest message windows and older pages in durable order', async () => {
      const { store } = createFixture();
      const baseRoom = room();
      const messages = [1, 2, 3, 4, 5].map(index => message({
        id: `m${index}`,
        content: `message ${index}`,
        timestamp: `2026-05-03T00:00:0${index}.000Z`,
      }));

      await store.saveRoom(baseRoom);
      for (const item of messages) {
        await store.appendMessage(item);
      }

      const latestPage = await store.readMessagePageByRoom(baseRoom.id, { limit: 2 });
      assert.deepEqual(latestPage.messages.map(item => item.id), ['m4', 'm5']);
      assert.equal(latestPage.hasMore, true);
      assert.equal(latestPage.oldestMessageId, 'm4');
      assert.equal(typeof latestPage.historyVersion, 'number');

      const previousPage = await store.readMessagePageByRoom(baseRoom.id, { limit: 2, beforeMessageId: 'm4' });
      assert.deepEqual(previousPage.messages.map(item => item.id), ['m2', 'm3']);
      assert.equal(previousPage.hasMore, true);
      assert.equal(previousPage.oldestMessageId, 'm2');

      const firstPage = await store.readMessagePageByRoom(baseRoom.id, { limit: 2, beforeMessageId: 'm2' });
      assert.deepEqual(firstPage.messages.map(item => item.id), ['m1']);
      assert.equal(firstPage.hasMore, false);
      assert.equal(firstPage.oldestMessageId, 'm1');
    });

    it('tracks durable room membership and saved rooms separately from owned rooms', async () => {
      const { store } = createFixture();
      const initialRoom = room();

      assert.deepEqual(stripRoomStamp(await store.saveRoom(initialRoom)), initialRoom);
      assert.deepEqual(await store.getRoomMember(initialRoom.id, initialRoom.creatorId), {
        roomId: initialRoom.id,
        clientId: initialRoom.creatorId,
        role: 'owner',
        joinedAt: initialRoom.createdAt,
      });
      assert.equal(await store.isRoomMember(initialRoom.id, initialRoom.creatorId), true);

      assert.deepEqual(await store.addRoomMember(initialRoom.id, 'client-2', 'member', '2026-05-03T00:01:00.000Z'), {
        roomId: initialRoom.id,
        clientId: 'client-2',
        role: 'member',
        joinedAt: '2026-05-03T00:01:00.000Z',
      });

      assert.deepEqual((await store.readRoomMembers(initialRoom.id)).map(member => member.clientId), [initialRoom.creatorId, 'client-2']);
      assert.deepEqual((await store.readRoomsByUser('client-2')).map(item => item.id), []);
      assert.equal(await store.isRoomMember(initialRoom.id, 'missing-client'), false);
      assert.equal(await store.removeRoomMember(initialRoom.id, initialRoom.creatorId), false);
      assert.equal(await store.removeRoomMember(initialRoom.id, 'client-2'), true);
      assert.equal(await store.isRoomMember(initialRoom.id, 'client-2'), false);

      assert.deepEqual(stripRoomStamp(await store.saveRoomForUser(initialRoom.id, 'client-2', '2026-05-03T00:02:00.000Z')), initialRoom);
      assert.deepEqual((await store.readSavedRoomsByUser('client-2')).map(item => item.id), [initialRoom.id]);
      assert.deepEqual((await store.readRoomsByUser('client-2')).map(item => item.id), []);
      assert.equal(await store.removeSavedRoomForUser(initialRoom.id, 'client-2'), true);
      assert.deepEqual(await store.readSavedRoomsByUser('client-2'), []);
    });

    it('preserves media asset metadata without storing binary media payload in messages', async () => {
      const { store } = createFixture();
      const initialRoom = room();
      const asset: MediaAsset = {
        id: 'asset-1',
        roomId: initialRoom.id,
        messageId: 'media-message',
        objectKey: 'rooms/room-1/media/image/asset-1',
        kind: 'image',
        mimeType: 'image/webp',
        byteSize: 123,
        width: 10,
        height: 20,
        createdAt: '2026-05-03T00:00:00.000Z',
      };
      const imageMessage = message({
        id: 'media-message',
        content: '',
        messageType: 'media',
        mimeType: 'image/webp',
      });

      await store.saveRoom(initialRoom);
      assert.deepEqual(await store.saveMediaAsset(asset), asset);
      assert.deepEqual(await store.getMediaAsset(asset.id), asset);
      assert.deepEqual(await store.getMediaAssetByMessageId(imageMessage.id), asset);
      assert.deepEqual(await store.readMediaAssetsByRoom(initialRoom.id), [asset]);

      await store.appendMessage(imageMessage);

      assert.deepEqual(await store.readMessagesByRoom(initialRoom.id), [{
        ...imageMessage,
        mediaAsset: {
          id: asset.id,
          kind: asset.kind,
          mimeType: asset.mimeType,
          byteSize: asset.byteSize,
          width: asset.width,
          height: asset.height,
        },
      }]);
      await store.deleteMediaAsset(asset.id);
      assert.equal(await store.getMediaAsset(asset.id), null);
      assert.deepEqual(await store.readMediaAssetsByRoom(initialRoom.id), []);
    });

    it('replaces legacy base64 image payloads with media asset metadata without changing message time or room activity', async () => {
      const { store } = createFixture();
      const initialRoom = room({ lastActivityAt: '2026-05-03T00:00:10.000Z' });
      const legacyImage = message({
        id: 'legacy-image',
        content: '',
        messageType: 'media',
        mimeType: 'image/png',
        timestamp: '2026-05-03T00:00:02.000Z',
      });
      const asset: MediaAsset = {
        id: 'asset-legacy',
        roomId: initialRoom.id,
        messageId: legacyImage.id,
        objectKey: 'rooms/room-1/media/image/asset-legacy',
        kind: 'image',
        mimeType: 'image/webp',
        byteSize: 456,
        width: 12,
        height: 14,
        createdAt: '2026-05-03T00:00:11.000Z',
      };

      await store.saveRoom(initialRoom);
      await store.appendMessage(legacyImage);

      const result = await store.replaceMessageMediaAsset(initialRoom.id, legacyImage.id, asset);

      assert.equal(result?.found, true);
      assert.deepEqual(stripRoomStamp(result?.room), initialRoom);
      assert.deepEqual(result?.updatedMessage, {
        ...legacyImage,
        content: '',
        messageType: 'media',
        mimeType: asset.mimeType,
        mediaAsset: {
          id: asset.id,
          kind: asset.kind,
          mimeType: asset.mimeType,
          byteSize: asset.byteSize,
          width: asset.width,
          height: asset.height,
        },
      });
      assert.deepEqual(await store.readMessagesByRoom(initialRoom.id), [result?.updatedMessage]);
      assert.deepEqual(stripRoomStamp(await store.getRoomById(initialRoom.id)), initialRoom);
      assert.deepEqual(await store.getMediaAsset(asset.id), asset);

      const missingResult = await store.replaceMessageMediaAsset(initialRoom.id, 'missing-image', {
        ...asset,
        id: 'missing-asset',
        objectKey: 'rooms/room-1/media/image/missing-asset',
      });
      assert.equal(missingResult?.found, false);
      assert.equal(await store.getMediaAsset('missing-asset'), null);
      assert.deepEqual(await store.readMessagesByRoom(initialRoom.id), [result?.updatedMessage]);
    });

    it('renames rooms only for the creator without changing room activity', async () => {
      const { store } = createFixture();
      const initialRoom = room({
        name: 'Original Room',
        createdAt: '2026-05-03T00:00:00.000Z',
        lastActivityAt: '2026-05-03T00:00:10.000Z',
      });

      await store.saveRoom(initialRoom);

      assert.equal(await store.updateRoomName(initialRoom.id, 'client-2', 'Unauthorized Rename'), null);
      assert.deepEqual(stripRoomStamp(await store.getRoomById(initialRoom.id)), initialRoom);

      const renamedRoom = await store.updateRoomName(initialRoom.id, initialRoom.creatorId, 'Renamed Room');

      // rename 必须 bump updatedAt(客户端用它做 last-write-wins),其余字段保持不变
      const expectRenamed = (actual: Awaited<ReturnType<typeof store.getRoomById>>) => {
        assert.ok(actual);
        const { updatedAt, ...rest } = actual;
        assert.equal(typeof updatedAt, 'string');
        assert.deepEqual(rest, { ...initialRoom, name: 'Renamed Room' });
      };
      expectRenamed(renamedRoom);
      expectRenamed(await store.getRoomById(initialRoom.id));
      const ownedRooms = await store.readRoomsByUser(initialRoom.creatorId);
      assert.equal(ownedRooms.length, 1);
      expectRenamed(ownedRooms[0]);
    });

    it('keeps retry and edit-and-ask truncation semantics consistent', async () => {
      const { store } = createFixture();
      const mutableStore = store as DurableRoomStoreWithMessageMutations;
      const baseRoom = room();
      const userOne = message({ id: 'u1', content: 'first prompt', timestamp: '2026-05-03T00:00:01.000Z' });
      const aiOne = message({ id: 'ai1', clientId: 'ai_assistant', content: 'first answer', messageType: 'ai', status: 'complete', timestamp: '2026-05-03T00:00:02.000Z' });
      const userTwo = message({ id: 'u2', content: 'second prompt', timestamp: '2026-05-03T00:00:03.000Z' });
      const aiTwo = message({ id: 'ai2', clientId: 'ai_assistant', content: 'second answer', messageType: 'ai', status: 'complete', timestamp: '2026-05-03T00:00:04.000Z' });
      const tail = message({ id: 'tail', content: 'tail', timestamp: '2026-05-03T00:00:05.000Z' });
      const retryPlaceholder = message({ id: 'retry-ai', clientId: 'ai_assistant', content: '', messageType: 'ai', status: 'streaming', timestamp: '2026-05-03T00:00:06.000Z' });
      const editPlaceholder = message({ id: 'edit-ai', clientId: 'ai_assistant', content: '', messageType: 'ai', status: 'streaming', timestamp: '2026-05-03T00:00:07.000Z' });
      const missingTargetPlaceholder = message({ id: 'missing-target-ai', clientId: 'ai_assistant', content: '', messageType: 'ai', status: 'streaming', timestamp: '2026-05-03T00:00:08.000Z' });
      const fullHistory = [userOne, aiOne, userTwo, aiTwo, tail];

      await store.saveRoom(baseRoom);

      await store.saveMessageHistory(baseRoom.id, fullHistory);
      const retryTruncation = await mutableStore.truncateBeforeMessage(baseRoom.id, 'ai2');
      assert.equal(retryTruncation?.targetFound, true);
      assert.deepEqual(retryTruncation?.messages.map(item => item.id), ['u1', 'ai1', 'u2']);
      await store.upsertMessage(retryPlaceholder);
      assert.deepEqual((await store.readMessagesByRoom(baseRoom.id)).map(item => item.id), ['u1', 'ai1', 'u2', 'retry-ai']);

      await store.saveMessageHistory(baseRoom.id, fullHistory);
      const editAndTruncate = await mutableStore.updateMessageAndTruncateAfter(baseRoom.id, 'u2', 'edited second prompt', '2026-05-03T00:00:09.000Z');
      assert.equal(editAndTruncate?.targetFound, true);
      assert.ok(editAndTruncate?.updatedMessage);
      assert.equal(editAndTruncate.updatedMessage.content, 'edited second prompt');
      assert.equal(editAndTruncate.updatedMessage.timestamp, userTwo.timestamp);
      assert.equal(editAndTruncate.updatedMessage.updatedAt, '2026-05-03T00:00:09.000Z');
      assert.deepEqual(editAndTruncate?.messages.map(item => item.id), ['u1', 'ai1', 'u2']);
      await store.upsertMessage(editPlaceholder);
      assert.deepEqual((await store.readMessagesByRoom(baseRoom.id)).map(item => item.id), ['u1', 'ai1', 'u2', 'edit-ai']);
      assert.equal((await store.readMessagesByRoom(baseRoom.id))[2].content, 'edited second prompt');
      assert.equal((await store.readMessagesByRoom(baseRoom.id))[2].timestamp, userTwo.timestamp);
      assert.equal((await store.readMessagesByRoom(baseRoom.id))[2].updatedAt, '2026-05-03T00:00:09.000Z');

      await store.saveMessageHistory(baseRoom.id, fullHistory);
      const missingRetryTruncation = await mutableStore.truncateBeforeMessage(baseRoom.id, 'missing');
      assert.equal(missingRetryTruncation?.targetFound, false);
      assert.deepEqual(missingRetryTruncation?.messages.map(item => item.id), ['u1', 'ai1', 'u2', 'ai2', 'tail']);
      await store.upsertMessage(missingTargetPlaceholder);
      assert.deepEqual((await store.readMessagesByRoom(baseRoom.id)).map(item => item.id), ['u1', 'ai1', 'u2', 'ai2', 'tail', 'missing-target-ai']);

      await store.saveMessageHistory(baseRoom.id, fullHistory);
      const lastTargetTruncation = await mutableStore.truncateAfterMessage(baseRoom.id, 'tail');
      assert.equal(lastTargetTruncation?.targetFound, true);
      assert.deepEqual(lastTargetTruncation?.messages.map(item => item.id), ['u1', 'ai1', 'u2', 'ai2', 'tail']);
      await store.upsertMessage(message({ id: 'after-last-target', clientId: 'ai_assistant', content: '', messageType: 'ai', status: 'streaming', timestamp: '2026-05-03T00:00:10.000Z' }));
      assert.deepEqual((await store.readMessagesByRoom(baseRoom.id)).map(item => item.id), ['u1', 'ai1', 'u2', 'ai2', 'tail', 'after-last-target']);
    });

    it('updates and deletes individual messages without replacing whole histories', async () => {
      const { store } = createFixture();
      const mutableStore = store as DurableRoomStoreWithMessageMutations;
      const baseRoom = room();
      const first = message({ id: 'first', content: 'first', timestamp: '2026-05-03T00:00:01.000Z' });
      const second = message({ id: 'second', content: 'second', timestamp: '2026-05-03T00:00:02.000Z' });
      const third = message({ id: 'third', content: 'third', timestamp: '2026-05-03T00:00:03.000Z' });

      await store.saveRoom(baseRoom);
      await store.saveMessageHistory(baseRoom.id, [first, second, third]);

      const editResult = await mutableStore.updateMessageContent(baseRoom.id, 'second', 'edited second', '2026-05-03T00:00:04.000Z');
      assert.equal(editResult?.found, true);
      assert.ok(editResult?.updatedMessage);
      assert.equal(editResult.updatedMessage.content, 'edited second');
      assert.equal(editResult.updatedMessage.timestamp, second.timestamp);
      assert.equal(editResult.updatedMessage.updatedAt, '2026-05-03T00:00:04.000Z');
      assert.equal(editResult.room.lastActivityAt, third.timestamp);
      assert.deepEqual((await store.readMessagesByRoom(baseRoom.id)).map(item => item.id), ['first', 'second', 'third']);
      assert.equal((await store.readMessagesByRoom(baseRoom.id))[1].content, 'edited second');
      assert.equal((await store.readMessagesByRoom(baseRoom.id))[1].timestamp, second.timestamp);
      assert.equal((await store.readMessagesByRoom(baseRoom.id))[1].updatedAt, '2026-05-03T00:00:04.000Z');

      const missingEditResult = await mutableStore.updateMessageContent(baseRoom.id, 'missing', 'missing edit', '2026-05-03T00:00:05.000Z');
      assert.equal(missingEditResult?.found, false);
      assert.deepEqual((await store.readMessagesByRoom(baseRoom.id)).map(item => item.id), ['first', 'second', 'third']);

      const deleteResult = await mutableStore.deleteMessageById(baseRoom.id, 'second');
      assert.equal(deleteResult?.deleted, true);
      assert.deepEqual((await store.readMessagesByRoom(baseRoom.id)).map(item => item.id), ['first', 'third']);

      const missingDeleteResult = await mutableStore.deleteMessageById(baseRoom.id, 'missing');
      assert.equal(missingDeleteResult?.deleted, false);
      assert.deepEqual((await store.readMessagesByRoom(baseRoom.id)).map(item => item.id), ['first', 'third']);
    });

    it('rejects message mutations for missing rooms without creating orphan histories', async () => {
      const { store } = createFixture();
      const missingRoomMessage = message({ roomId: 'missing-room' });

      assert.equal(await store.appendMessage(missingRoomMessage), null);
      assert.equal(await store.upsertMessage(missingRoomMessage), null);
      assert.equal(await store.saveMessageHistory('missing-room', [missingRoomMessage]), null);
      assert.deepEqual(await store.readMessagesByRoom('missing-room'), []);
    });

    it('does not roll back room activity when append or upsert receives older message timestamps', async () => {
      const { store } = createFixture();
      const activeRoom = room({ lastActivityAt: '2026-05-03T00:00:10.000Z' });
      const olderAppend = message({ id: 'old-append', timestamp: '2026-05-03T00:00:01.000Z' });
      const olderUpsert = message({ id: 'old-upsert', timestamp: '2026-05-03T00:00:02.000Z' });

      await store.saveRoom(activeRoom);

      assert.deepEqual(stripRoomStamp(await store.appendMessage(olderAppend)), activeRoom);
      assert.deepEqual(stripRoomStamp(await store.upsertMessage(olderUpsert)), activeRoom);
      assert.deepEqual(stripRoomStamp(await store.getRoomById(activeRoom.id)), activeRoom);
      assert.deepEqual((await store.readMessagesByRoom(activeRoom.id)).map(item => item.id), ['old-append', 'old-upsert']);
    });

    it('tracks AI costs and recovers interrupted streaming messages', async () => {
      const { store } = createFixture();
      const streamingMessage = message({ id: 'streaming', clientId: 'ai_assistant', messageType: 'ai', status: 'streaming', content: '', timestamp: '2026-05-03T00:00:01.000Z' });
      const completeMessage = message({ id: 'complete', clientId: 'ai_assistant', messageType: 'ai', status: 'complete', content: 'done', timestamp: '2026-05-03T00:00:02.000Z' });

      await store.saveRoom(room());
      await store.saveMessageHistory('room-1', [streamingMessage, completeMessage]);

      assert.deepEqual(await store.readRoomAICost('room-1'), { roomId: 'room-1', currency: 'USD', totalUsd: 0 });
      assert.deepEqual(await store.incrementRoomAICost('room-1', null), { roomId: 'room-1', currency: 'USD', totalUsd: 0 });
      assert.deepEqual(await store.incrementRoomAICost('room-1', cost(-1)), { roomId: 'room-1', currency: 'USD', totalUsd: 0 });
      assert.deepEqual(await store.incrementRoomAICost('room-1', cost(0.25)), { roomId: 'room-1', currency: 'USD', totalUsd: 0.25 });
      assert.deepEqual(await store.incrementRoomAICost('room-1', cost(0.5)), { roomId: 'room-1', currency: 'USD', totalUsd: 0.75 });

      assert.equal(await store.failInterruptedStreamingMessages?.('Response interrupted.'), 1);
      const recoveredMessages = await store.readMessagesByRoom('room-1');
      assert.equal(recoveredMessages[0].status, 'error');
      assert.equal(recoveredMessages[0].content, 'Response interrupted.');
      assert.equal(recoveredMessages[1].status, 'complete');
      assert.equal(recoveredMessages[1].content, 'done');
    });
  });
}

describe('PostgresStore media object cleanup', () => {
  const buildMediaStore = () => {
    const deleted: string[] = [];
    const mediaObjectStorage = {
      isConfigured: () => true,
      putMediaObject: async () => {},
      createWriteUrl: async () => ({ url: '', expiresAt: '' }),
      createReadUrl: async () => ({ url: '', expiresAt: '' }),
      headObject: async () => ({ exists: true }),
      deleteMediaObject: async (objectKey: string) => { deleted.push(objectKey); },
    };
    const store = new PostgresStore(new StatefulPostgresPool(), logger as any, mediaObjectStorage as any);
    return { store, deleted };
  };

  const seedMediaMessage = async (store: PostgresStore, messageId: string, assetId: string) => {
    const asset: MediaAsset = {
      id: assetId,
      roomId: 'room-1',
      messageId,
      objectKey: `rooms/room-1/media/image/${assetId}`,
      kind: 'image',
      mimeType: 'image/webp',
      byteSize: 1,
      createdAt: '2026-05-03T00:00:00.000Z',
    };
    await store.appendMediaMessageWithAsset(
      message({ id: messageId, content: '', messageType: 'media', mimeType: 'image/webp' }),
      asset
    );
    return asset.objectKey;
  };

  it('deletes the backing S3 object when a media message is deleted', async () => {
    const { store, deleted } = buildMediaStore();
    await store.saveRoom(room());
    const objectKey = await seedMediaMessage(store, 'media-1', 'asset-1');

    const result = await store.deleteMessageById('room-1', 'media-1');

    assert.equal(result?.deleted, true);
    assert.deepEqual(deleted, [objectKey]);
    assert.equal(await store.getMediaAsset('asset-1'), null);
  });

  it('does not touch storage when the deleted message is not found', async () => {
    const { store, deleted } = buildMediaStore();
    await store.saveRoom(room());
    await seedMediaMessage(store, 'media-1', 'asset-1');

    const result = await store.deleteMessageById('room-1', 'missing');

    assert.equal(result?.deleted, false);
    assert.deepEqual(deleted, []);
    assert.notEqual(await store.getMediaAsset('asset-1'), null);
  });

  it('deletes every room media object when the room is cleared', async () => {
    const { store, deleted } = buildMediaStore();
    await store.saveRoom(room());
    const objectKey = await seedMediaMessage(store, 'media-1', 'asset-1');

    await store.clearRoomMessages('room-1');

    assert.deepEqual(deleted, [objectKey]);
  });

  it('deletes every room media object when the room is deleted by its owner', async () => {
    const { store, deleted } = buildMediaStore();
    await store.saveRoom(room());
    const objectKey = await seedMediaMessage(store, 'media-1', 'asset-1');

    await store.deleteRoom('room-1', 'client-1');
    assert.deepEqual(deleted, [objectKey]);
  });

  it('leaves storage untouched when a non-owner attempts room deletion', async () => {
    const { store, deleted } = buildMediaStore();
    await store.saveRoom(room());
    await seedMediaMessage(store, 'media-1', 'asset-1');

    await store.deleteRoom('room-1', 'intruder');

    assert.deepEqual(deleted, []);
    assert.notEqual(await store.getMediaAsset('asset-1'), null);
  });
});
