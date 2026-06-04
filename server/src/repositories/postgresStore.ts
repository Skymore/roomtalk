import { customAlphabet } from 'nanoid';
import { Logger } from '../logger';
import { AICost, ImageAsset, Message, MessageImageAsset, Room, RoomAICostTotal, RoomMember, RoomMemberRole } from '../types';
import { DEFAULT_ROOM_MESSAGE_PAGE_LIMIT, DurableRoomStore, RoomMessagePageOptions } from './store';
import { POSTGRES_SCHEMA_SQL } from './postgresSchema';

const nanoid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 10);

export interface PostgresQueryResult<T = any> {
  rows: T[];
  rowCount: number | null;
}

export interface PostgresClient {
  query<T = any>(sql: string, params?: unknown[]): Promise<PostgresQueryResult<T>>;
  release(): void;
}

export interface PostgresPool {
  query<T = any>(sql: string, params?: unknown[]): Promise<PostgresQueryResult<T>>;
  connect(): Promise<PostgresClient>;
  end?(): Promise<void>;
}

type RoomRow = {
  id: string;
  name: string;
  description: string | null;
  created_at: string | Date;
  last_activity_at: string | Date;
  creator_id: string;
  message_version?: number | string | null;
};

type MessageRow = {
  id: string;
  room_id: string;
  client_id: string;
  content: string;
  timestamp: string | Date;
  updated_at?: string | Date | null;
  message_type: Message['messageType'];
  username: string | null;
  avatar: unknown;
  mime_type: string | null;
  status: Message['status'] | null;
  ai_model: unknown;
  usage: unknown;
  cost: unknown;
  reply_to: unknown;
  position?: number | string;
};

type RoomMemberRow = {
  room_id: string;
  client_id: string;
  role: RoomMemberRole;
  joined_at: string | Date;
};

type ImageAssetRow = {
  id: string;
  room_id: string;
  message_id: string | null;
  object_key: string;
  mime_type: string;
  byte_size: number | string;
  width: number | string | null;
  height: number | string | null;
  created_at: string | Date;
};

const ROOM_COLUMNS = 'id, name, description, created_at, last_activity_at, creator_id, message_version';
const MESSAGE_COLUMNS = 'id, room_id, client_id, content, timestamp, updated_at, message_type, username, avatar, mime_type, status, ai_model, usage, cost, reply_to';
const ROOM_MEMBER_COLUMNS = 'room_id, client_id, role, joined_at';
const IMAGE_ASSET_COLUMNS = 'id, room_id, message_id, object_key, mime_type, byte_size, width, height, created_at';

const parseTime = (timestamp?: string): number => {
  const time = Date.parse(timestamp || '');
  return Number.isFinite(time) ? time : 0;
};

const getLatestMessageTimestamp = (messages: Message[]): string | undefined => {
  return messages.reduce<string | undefined>((latest, message) => {
    if (!latest || parseTime(message.timestamp) > parseTime(latest)) {
      return message.timestamp;
    }

    return latest;
  }, undefined);
};

const toIsoString = (value: string | Date): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
};

const normalizeMessagePageLimit = (limit?: number): number => {
  if (!Number.isFinite(limit)) {
    return DEFAULT_ROOM_MESSAGE_PAGE_LIMIT;
  }

  return Math.min(200, Math.max(1, Math.floor(limit || DEFAULT_ROOM_MESSAGE_PAGE_LIMIT)));
};

const parseJsonValue = <T>(value: unknown): T | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }

  return value as T;
};

const toJsonb = (value: unknown) => value === undefined ? null : JSON.stringify(value);

const mapRoom = (row: RoomRow): Room => {
  const room: Room = {
    id: row.id,
    name: row.name,
    description: row.description || '',
    createdAt: toIsoString(row.created_at),
    lastActivityAt: toIsoString(row.last_activity_at || row.created_at),
    creatorId: row.creator_id,
  };
  const messageVersion = Number(row.message_version || 0);
  if (messageVersion > 0) room.messageVersion = messageVersion;
  return room;
};

const mapRoomMember = (row: RoomMemberRow): RoomMember => ({
  roomId: row.room_id,
  clientId: row.client_id,
  role: row.role,
  joinedAt: toIsoString(row.joined_at),
});

const toOptionalNumber = (value: number | string | null): number | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const mapImageAsset = (row: ImageAssetRow): ImageAsset => {
  const asset: ImageAsset = {
    id: row.id,
    roomId: row.room_id,
    objectKey: row.object_key,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size) || 0,
    createdAt: toIsoString(row.created_at),
  };

  if (row.message_id) asset.messageId = row.message_id;
  const width = toOptionalNumber(row.width);
  const height = toOptionalNumber(row.height);
  if (width !== undefined) asset.width = width;
  if (height !== undefined) asset.height = height;
  return asset;
};

const toMessageImageAsset = (asset: ImageAsset): MessageImageAsset => {
  const messageAsset: MessageImageAsset = {
    id: asset.id,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
  };
  if (asset.width !== undefined) messageAsset.width = asset.width;
  if (asset.height !== undefined) messageAsset.height = asset.height;
  return messageAsset;
};

const mapMessage = (row: MessageRow): Message => {
  const avatar = parseJsonValue<Message['avatar']>(row.avatar);
  const aiModel = parseJsonValue<Message['aiModel']>(row.ai_model);
  const usage = parseJsonValue<Message['usage']>(row.usage);
  const cost = parseJsonValue<Message['cost']>(row.cost);
  const replyTo = parseJsonValue<Message['replyTo']>(row.reply_to);

  const message: Message = {
    id: row.id,
    clientId: row.client_id,
    content: row.content,
    roomId: row.room_id,
    timestamp: toIsoString(row.timestamp),
    messageType: row.message_type,
  };

  if (row.updated_at) message.updatedAt = toIsoString(row.updated_at);
  if (row.username) message.username = row.username;
  if (avatar) message.avatar = avatar;
  if (row.mime_type) message.mimeType = row.mime_type;
  if (row.status) message.status = row.status;
  if (aiModel) message.aiModel = aiModel;
  if (usage) message.usage = usage;
  if (cost) message.cost = cost;
  if (replyTo) message.replyTo = replyTo;

  return message;
};

const messageParams = (message: Message, position: number): unknown[] => [
  message.id,
  message.roomId,
  message.clientId,
  message.content,
  message.timestamp,
  message.updatedAt || null,
  message.messageType,
  message.username || null,
  toJsonb(message.avatar),
  message.mimeType || null,
  message.status || null,
  toJsonb(message.aiModel),
  toJsonb(message.usage),
  toJsonb(message.cost),
  toJsonb(message.replyTo),
  position,
];

const INSERT_MESSAGE_SQL = `INSERT INTO room_messages (
  id,
  room_id,
  client_id,
  content,
  timestamp,
  updated_at,
  message_type,
  username,
  avatar,
  mime_type,
  status,
  ai_model,
  usage,
  cost,
  reply_to,
  position
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16
) ON CONFLICT (id) DO UPDATE SET
  room_id = EXCLUDED.room_id,
  client_id = EXCLUDED.client_id,
  content = EXCLUDED.content,
  timestamp = EXCLUDED.timestamp,
  updated_at = EXCLUDED.updated_at,
  message_type = EXCLUDED.message_type,
  username = EXCLUDED.username,
  avatar = EXCLUDED.avatar,
  mime_type = EXCLUDED.mime_type,
  status = EXCLUDED.status,
  ai_model = EXCLUDED.ai_model,
  usage = EXCLUDED.usage,
  cost = EXCLUDED.cost,
  reply_to = EXCLUDED.reply_to,
  position = room_messages.position`;

export class PostgresStore implements DurableRoomStore {
  constructor(
    private readonly pool: PostgresPool,
    private readonly logger: Logger
  ) {}

  async initializeSchema(): Promise<void> {
    for (const sql of POSTGRES_SCHEMA_SQL) {
      await this.pool.query(sql);
    }
    this.logger.info('PostgreSQL schema initialized');
  }

  async generateUniqueRoomId(): Promise<string> {
    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
      const id = nanoid();
      const exists = await this.pool.query('SELECT 1 FROM rooms WHERE id = $1 LIMIT 1', [id]);
      if (exists.rows.length === 0) {
        return id;
      }
      attempts++;
      this.logger.debug('PostgreSQL room ID collision detected, retrying', { attempt: attempts, maxAttempts });
    }

    attempts = 0;
    while (attempts < maxAttempts) {
      const id = nanoid(12);
      const exists = await this.pool.query('SELECT 1 FROM rooms WHERE id = $1 LIMIT 1', [id]);
      if (exists.rows.length === 0) {
        return id;
      }
      attempts++;
      this.logger.debug('PostgreSQL long room ID collision detected, retrying', { attempt: attempts, maxAttempts });
    }

    return nanoid(16);
  }

  async appendMessage(message: Message): Promise<Room | null> {
    try {
      return await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [message.roomId]
        );
        if (room.rows.length === 0) {
          this.logger.warn('Cannot append message to missing PostgreSQL room', { roomId: message.roomId, messageId: message.id });
          return null;
        }

        const nextPosition = await client.query<{ position: number | string }>(
          'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM room_messages WHERE room_id = $1',
          [message.roomId]
        );
        const position = Number(nextPosition.rows[0]?.position || 0);
        await client.query(INSERT_MESSAGE_SQL, messageParams(message, position));

        const updatedRoom = await client.query<RoomRow>(
          `UPDATE rooms
          SET last_activity_at = GREATEST(last_activity_at, $2::timestamptz),
            message_version = message_version + 1
          WHERE id = $1
          RETURNING ${ROOM_COLUMNS}`,
          [message.roomId, message.timestamp]
        );
        this.logger.debug('Message appended to PostgreSQL', { roomId: message.roomId, messageId: message.id });
        return updatedRoom.rows[0] ? mapRoom(updatedRoom.rows[0]) : null;
      });
    } catch (error) {
      this.logger.error('Error appending message to PostgreSQL', { error, roomId: message.roomId, messageId: message.id });
      return null;
    }
  }

  async upsertMessage(message: Message): Promise<Room | null> {
    try {
      return await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [message.roomId]
        );
        if (room.rows.length === 0) {
          this.logger.warn('Cannot upsert message for missing PostgreSQL room', { roomId: message.roomId, messageId: message.id });
          return null;
        }

        const nextPosition = await client.query<{ position: number | string }>(
          'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM room_messages WHERE room_id = $1',
          [message.roomId]
        );
        const position = Number(nextPosition.rows[0]?.position || 0);
        await client.query(INSERT_MESSAGE_SQL, messageParams(message, position));

        const updatedRoom = await client.query<RoomRow>(
          `UPDATE rooms
          SET last_activity_at = GREATEST(last_activity_at, $2::timestamptz),
            message_version = message_version + 1
          WHERE id = $1
          RETURNING ${ROOM_COLUMNS}`,
          [message.roomId, message.timestamp]
        );
        this.logger.debug('Message upserted in PostgreSQL', { roomId: message.roomId, messageId: message.id });
        return updatedRoom.rows[0] ? mapRoom(updatedRoom.rows[0]) : null;
      });
    } catch (error) {
      this.logger.error('Error upserting message in PostgreSQL', { error, roomId: message.roomId, messageId: message.id });
      return null;
    }
  }

  async updateMessageContent(roomId: string, messageId: string, updatedContent: string, updatedAt = new Date().toISOString()) {
    try {
      return await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [roomId]
        );
        if (room.rows.length === 0) {
          this.logger.warn('Cannot update message for missing PostgreSQL room', { roomId, messageId });
          return null;
        }

        const updated = await client.query<MessageRow>(
          `UPDATE room_messages
          SET content = $3,
            updated_at = $4
          WHERE room_id = $1 AND id = $2
          RETURNING ${MESSAGE_COLUMNS}`,
          [roomId, messageId, updatedContent, updatedAt]
        );
        if (updated.rows.length === 0) {
          return { room: mapRoom(room.rows[0]), found: false };
        }

        const updatedRoom = await this.updateRoomLastActivityFromMessages(client, roomId, toIsoString(room.rows[0].created_at), true);
        if (!updatedRoom) {
          return null;
        }

        this.logger.debug('Message updated in PostgreSQL', { roomId, messageId });
        return { room: updatedRoom, found: true, updatedMessage: mapMessage(updated.rows[0]) };
      });
    } catch (error) {
      this.logger.error('Error updating message in PostgreSQL', { error, roomId, messageId });
      return null;
    }
  }

  async deleteMessageById(roomId: string, messageId: string) {
    try {
      return await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [roomId]
        );
        if (room.rows.length === 0) {
          this.logger.warn('Cannot delete message for missing PostgreSQL room', { roomId, messageId });
          return null;
        }

        const deleted = await client.query<{ id: string }>(
          'DELETE FROM room_messages WHERE room_id = $1 AND id = $2 RETURNING id',
          [roomId, messageId]
        );
        if (deleted.rows.length === 0) {
          return { room: mapRoom(room.rows[0]), deleted: false };
        }

        const updatedRoom = await this.updateRoomLastActivityFromMessages(client, roomId, toIsoString(room.rows[0].created_at), true);
        if (!updatedRoom) {
          return null;
        }

        this.logger.debug('Message deleted from PostgreSQL', { roomId, messageId });
        return { room: updatedRoom, deleted: true };
      });
    } catch (error) {
      this.logger.error('Error deleting message from PostgreSQL', { error, roomId, messageId });
      return null;
    }
  }

  private async truncateMessages(roomId: string, messageId: string, mode: 'before' | 'after') {
    try {
      return await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [roomId]
        );
        if (room.rows.length === 0) {
          this.logger.warn('Cannot truncate messages for missing PostgreSQL room', { roomId, messageId, mode });
          return null;
        }

        const target = await client.query<{ position: number | string }>(
          'SELECT position FROM room_messages WHERE room_id = $1 AND id = $2',
          [roomId, messageId]
        );
        if (target.rows.length === 0) {
          const messages = await this.readMessagesByRoomInTransaction(client, roomId);
          return { room: mapRoom(room.rows[0]), messages, targetFound: false };
        }

        const operator = mode === 'before' ? '>=' : '>';
        await client.query(
          `DELETE FROM room_messages WHERE room_id = $1 AND position ${operator} $2`,
          [roomId, Number(target.rows[0].position)]
        );

        const updatedRoom = await this.updateRoomLastActivityFromMessages(client, roomId, toIsoString(room.rows[0].created_at), true);
        if (!updatedRoom) {
          return null;
        }

        const messages = await this.readMessagesByRoomInTransaction(client, roomId);
        this.logger.debug('Messages truncated in PostgreSQL', { roomId, messageId, mode, count: messages.length });
        return { room: updatedRoom, messages, targetFound: true };
      });
    } catch (error) {
      this.logger.error('Error truncating messages in PostgreSQL', { error, roomId, messageId, mode });
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
      return await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [roomId]
        );
        if (room.rows.length === 0) {
          this.logger.warn('Cannot update and truncate message for missing PostgreSQL room', { roomId, messageId });
          return null;
        }

        const target = await client.query<{ position: number | string }>(
          'SELECT position FROM room_messages WHERE room_id = $1 AND id = $2',
          [roomId, messageId]
        );
        if (target.rows.length === 0) {
          const messages = await this.readMessagesByRoomInTransaction(client, roomId);
          return { room: mapRoom(room.rows[0]), messages, targetFound: false };
        }

        const updated = await client.query<MessageRow>(
          `UPDATE room_messages
          SET content = $3,
            updated_at = $4
          WHERE room_id = $1 AND id = $2
          RETURNING ${MESSAGE_COLUMNS}`,
          [roomId, messageId, updatedContent, updatedAt]
        );
        if (updated.rows.length === 0) {
          return null;
        }

        await client.query(
          'DELETE FROM room_messages WHERE room_id = $1 AND position > $2',
          [roomId, Number(target.rows[0].position)]
        );

        const updatedRoom = await this.updateRoomLastActivityFromMessages(client, roomId, toIsoString(room.rows[0].created_at), true);
        if (!updatedRoom) {
          return null;
        }

        const messages = await this.readMessagesByRoomInTransaction(client, roomId);
        this.logger.debug('Message updated and history truncated in PostgreSQL', { roomId, messageId, count: messages.length });
        return {
          room: updatedRoom,
          messages,
          targetFound: true,
          updatedMessage: mapMessage(updated.rows[0]),
        };
      });
    } catch (error) {
      this.logger.error('Error updating and truncating message in PostgreSQL', { error, roomId, messageId });
      return null;
    }
  }

  async saveMessageHistory(roomId: string, messages: Message[]): Promise<Room | null> {
    try {
      return await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [roomId]
        );
        if (room.rows.length === 0) {
          this.logger.warn('Cannot save message history for missing PostgreSQL room', { roomId });
          return null;
        }

        await client.query('DELETE FROM room_messages WHERE room_id = $1', [roomId]);
        for (const [index, message] of messages.entries()) {
          await client.query(INSERT_MESSAGE_SQL, messageParams({ ...message, roomId }, index));
        }

        const lastActivityAt = getLatestMessageTimestamp(messages) || toIsoString(room.rows[0].created_at);
        const updatedRoom = await client.query<RoomRow>(
          `UPDATE rooms
          SET last_activity_at = $2,
            message_version = message_version + 1
          WHERE id = $1
          RETURNING ${ROOM_COLUMNS}`,
          [roomId, lastActivityAt]
        );
        this.logger.debug('Message history saved to PostgreSQL', { roomId, count: messages.length });
        return updatedRoom.rows[0] ? mapRoom(updatedRoom.rows[0]) : null;
      });
    } catch (error) {
      this.logger.error('Error saving message history to PostgreSQL', { error, roomId });
      return null;
    }
  }

  async clearRoomMessages(roomId: string): Promise<number> {
    try {
      return await this.transaction(async client => {
        const result = await client.query('DELETE FROM room_messages WHERE room_id = $1', [roomId]);
        const deleted = result.rowCount || 0;
        if (deleted > 0) {
          await client.query(
            `UPDATE rooms
            SET message_version = message_version + 1,
              last_activity_at = created_at
            WHERE id = $1`,
            [roomId]
          );
        }
        return deleted;
      });
    } catch (error) {
      this.logger.error('Error clearing PostgreSQL room messages', { error, roomId });
      return 0;
    }
  }

  async readMessagesByRoom(roomId: string): Promise<Message[]> {
    try {
      const result = await this.pool.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS}
        FROM room_messages
        WHERE room_id = $1
        ORDER BY position ASC, timestamp ASC`,
        [roomId]
      );
      return this.attachImageAssets(roomId, result.rows.map(mapMessage));
    } catch (error) {
      this.logger.error('Error reading PostgreSQL room messages', { error, roomId });
      return [];
    }
  }

  async readMessagePageByRoom(roomId: string, options: RoomMessagePageOptions = {}) {
    const limit = normalizeMessagePageLimit(options.limit);

    try {
      const room = await this.pool.query<RoomRow>(
        `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1`,
        [roomId]
      );
      const historyVersion = Number(room.rows[0]?.message_version || 0);
      if (room.rows.length === 0) {
        return { roomId, messages: [], historyVersion, hasMore: false };
      }

      let rows: MessageRow[] = [];
      if (options.beforeMessageId) {
        const target = await this.pool.query<{ position: number | string }>(
          'SELECT position FROM room_messages WHERE room_id = $1 AND id = $2',
          [roomId, options.beforeMessageId]
        );
        if (target.rows.length === 0) {
          return { roomId, messages: [], historyVersion, hasMore: false };
        }

        const page = await this.pool.query<MessageRow>(
          `SELECT ${MESSAGE_COLUMNS}, position
          FROM room_messages
          WHERE room_id = $1 AND position < $2
          ORDER BY position DESC
          LIMIT $3`,
          [roomId, Number(target.rows[0].position), limit + 1]
        );
        rows = page.rows;
      } else {
        const page = await this.pool.query<MessageRow>(
          `SELECT ${MESSAGE_COLUMNS}, position
          FROM room_messages
          WHERE room_id = $1
          ORDER BY position DESC
          LIMIT $2`,
          [roomId, limit + 1]
        );
        rows = page.rows;
      }

      const hasMore = rows.length > limit;
      const messages = await this.attachImageAssets(roomId, rows.slice(0, limit).reverse().map(mapMessage));
      return {
        roomId,
        messages,
        historyVersion,
        hasMore,
        oldestMessageId: messages[0]?.id,
      };
    } catch (error) {
      this.logger.error('Error reading PostgreSQL room message page', { error, roomId, options });
      return { roomId, messages: [], historyVersion: 0, hasMore: false };
    }
  }

  async saveImageAsset(asset: ImageAsset): Promise<ImageAsset | null> {
    try {
      return await this.saveImageAssetWithClient(this.pool, asset);
    } catch (error) {
      this.logger.error('Error saving PostgreSQL image asset', { error, assetId: asset.id, roomId: asset.roomId });
      return null;
    }
  }

  async replaceMessageImageAsset(roomId: string, messageId: string, asset: ImageAsset) {
    const imageAsset: ImageAsset = {
      ...asset,
      roomId,
      messageId,
    };

    try {
      return await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [roomId]
        );
        if (room.rows.length === 0) {
          this.logger.warn('Cannot replace image asset for missing PostgreSQL room', { roomId, messageId, assetId: asset.id });
          return null;
        }

        const updated = await client.query<MessageRow>(
          `UPDATE room_messages
          SET content = $3,
            mime_type = $4
          WHERE room_id = $1 AND id = $2 AND message_type = 'image'
          RETURNING ${MESSAGE_COLUMNS}`,
          [roomId, messageId, imageAsset.id, imageAsset.mimeType]
        );
        if (updated.rows.length === 0) {
          return { room: mapRoom(room.rows[0]), found: false };
        }

        const savedAsset = await this.saveImageAssetWithClient(client, imageAsset);
        if (!savedAsset) {
          return null;
        }

        const updatedMessage = this.attachImageAssetsFromAssets([mapMessage(updated.rows[0])], [savedAsset])[0];
        this.logger.debug('Image message asset replaced in PostgreSQL', { roomId, messageId, assetId: imageAsset.id });
        return { room: mapRoom(room.rows[0]), found: true, updatedMessage };
      });
    } catch (error) {
      this.logger.error('Error replacing PostgreSQL image message asset', { error, roomId, messageId, assetId: asset.id });
      return null;
    }
  }

  async getImageAsset(assetId: string): Promise<ImageAsset | null> {
    try {
      const result = await this.pool.query<ImageAssetRow>(
        `SELECT ${IMAGE_ASSET_COLUMNS}
        FROM image_assets
        WHERE id = $1`,
        [assetId]
      );
      return result.rows[0] ? mapImageAsset(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL image asset', { error, assetId });
      return null;
    }
  }

  async getImageAssetByMessageId(messageId: string): Promise<ImageAsset | null> {
    try {
      const result = await this.pool.query<ImageAssetRow>(
        `SELECT ${IMAGE_ASSET_COLUMNS}
        FROM image_assets
        WHERE message_id = $1`,
        [messageId]
      );
      return result.rows[0] ? mapImageAsset(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL image asset by message id', { error, messageId });
      return null;
    }
  }

  async readImageAssetsByRoom(roomId: string): Promise<ImageAsset[]> {
    try {
      const result = await this.pool.query<ImageAssetRow>(
        `SELECT ${IMAGE_ASSET_COLUMNS}
        FROM image_assets
        WHERE room_id = $1
        ORDER BY created_at ASC`,
        [roomId]
      );
      return result.rows.map(mapImageAsset);
    } catch (error) {
      this.logger.error('Error reading PostgreSQL image assets by room', { error, roomId });
      return [];
    }
  }

  async deleteImageAsset(assetId: string): Promise<void> {
    try {
      await this.pool.query('DELETE FROM image_assets WHERE id = $1', [assetId]);
    } catch (error) {
      this.logger.error('Error deleting PostgreSQL image asset', { error, assetId });
    }
  }

  async readRoomAICost(roomId: string): Promise<RoomAICostTotal> {
    try {
      const result = await this.pool.query<{ total_usd: string | number }>(
        'SELECT total_usd FROM room_ai_cost_totals WHERE room_id = $1',
        [roomId]
      );
      const totalUsd = Number.parseFloat(String(result.rows[0]?.total_usd || '0'));
      return {
        roomId,
        currency: 'USD',
        totalUsd: Number.isFinite(totalUsd) ? totalUsd : 0,
      };
    } catch (error) {
      this.logger.error('Error reading PostgreSQL room AI cost total', { error, roomId });
      return { roomId, currency: 'USD', totalUsd: 0 };
    }
  }

  async incrementRoomAICost(roomId: string, cost: AICost | null): Promise<RoomAICostTotal> {
    if (!cost || !Number.isFinite(cost.totalUsd) || cost.totalUsd <= 0) {
      return this.readRoomAICost(roomId);
    }

    try {
      const result = await this.pool.query<{ total_usd: string | number }>(
        `INSERT INTO room_ai_cost_totals (room_id, total_usd)
        VALUES ($1, $2)
        ON CONFLICT (room_id) DO UPDATE SET
          total_usd = room_ai_cost_totals.total_usd + EXCLUDED.total_usd,
          updated_at = NOW()
        RETURNING total_usd`,
        [roomId, cost.totalUsd]
      );
      const totalUsd = Number.parseFloat(String(result.rows[0]?.total_usd || cost.totalUsd));
      return {
        roomId,
        currency: 'USD',
        totalUsd: Number.isFinite(totalUsd) ? totalUsd : cost.totalUsd,
      };
    } catch (error) {
      this.logger.error('Error incrementing PostgreSQL room AI cost total', { error, roomId, cost });
      return this.readRoomAICost(roomId);
    }
  }

  async setRoomAICostTotal(roomId: string, totalUsd: number): Promise<RoomAICostTotal> {
    if (!Number.isFinite(totalUsd) || totalUsd <= 0) {
      try {
        await this.pool.query('DELETE FROM room_ai_cost_totals WHERE room_id = $1', [roomId]);
      } catch (error) {
        this.logger.error('Error clearing PostgreSQL room AI cost total', { error, roomId, totalUsd });
      }
      return { roomId, currency: 'USD', totalUsd: 0 };
    }

    try {
      const result = await this.pool.query<{ total_usd: string | number }>(
        `INSERT INTO room_ai_cost_totals (room_id, total_usd)
        VALUES ($1, $2)
        ON CONFLICT (room_id) DO UPDATE SET
          total_usd = EXCLUDED.total_usd,
          updated_at = NOW()
        RETURNING total_usd`,
        [roomId, totalUsd]
      );
      const savedTotalUsd = Number.parseFloat(String(result.rows[0]?.total_usd || totalUsd));
      return {
        roomId,
        currency: 'USD',
        totalUsd: Number.isFinite(savedTotalUsd) ? savedTotalUsd : totalUsd,
      };
    } catch (error) {
      this.logger.error('Error setting PostgreSQL room AI cost total', { error, roomId, totalUsd });
      return this.readRoomAICost(roomId);
    }
  }

  async saveRoom(room: Room): Promise<Room | null> {
    try {
      return await this.transaction(async client => {
        const result = await client.query<RoomRow>(
          `INSERT INTO rooms (id, name, description, created_at, last_activity_at, creator_id)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            last_activity_at = GREATEST(rooms.last_activity_at, EXCLUDED.last_activity_at)
          RETURNING ${ROOM_COLUMNS}`,
          [
            room.id,
            room.name,
            room.description || '',
            room.createdAt,
            room.lastActivityAt || room.createdAt,
            room.creatorId,
          ]
        );

        if (result.rows[0]) {
          await client.query(
            `INSERT INTO room_members (room_id, client_id, role, joined_at)
            VALUES ($1, $2, 'owner', $3)
            ON CONFLICT (room_id, client_id) DO UPDATE SET
              role = 'owner'`,
            [room.id, room.creatorId, room.createdAt]
          );
        }

        this.logger.debug('Room saved to PostgreSQL', { roomId: room.id, creatorId: room.creatorId });
        return result.rows[0] ? mapRoom(result.rows[0]) : null;
      });
    } catch (error) {
      this.logger.error('Error saving room to PostgreSQL', { error, roomId: room.id, creatorId: room.creatorId });
      return null;
    }
  }

  async addRoomMember(roomId: string, clientId: string, role: RoomMemberRole, joinedAt = new Date().toISOString()): Promise<RoomMember | null> {
    try {
      const result = await this.pool.query<RoomMemberRow>(
        `INSERT INTO room_members (room_id, client_id, role, joined_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (room_id, client_id) DO UPDATE SET
          role = CASE
            WHEN room_members.role = 'owner' THEN 'owner'
            WHEN EXCLUDED.role = 'owner' THEN 'owner'
            ELSE room_members.role
          END
        RETURNING ${ROOM_MEMBER_COLUMNS}`,
        [roomId, clientId, role, joinedAt]
      );
      return result.rows[0] ? mapRoomMember(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error adding PostgreSQL room member', { error, roomId, clientId, role });
      return null;
    }
  }

  async removeRoomMember(roomId: string, clientId: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        `DELETE FROM room_members
        WHERE room_id = $1 AND client_id = $2 AND role <> 'owner'`,
        [roomId, clientId]
      );
      return (result.rowCount || 0) > 0;
    } catch (error) {
      this.logger.error('Error removing PostgreSQL room member', { error, roomId, clientId });
      return false;
    }
  }

  async getRoomMember(roomId: string, clientId: string): Promise<RoomMember | null> {
    try {
      const result = await this.pool.query<RoomMemberRow>(
        `SELECT ${ROOM_MEMBER_COLUMNS}
        FROM room_members
        WHERE room_id = $1 AND client_id = $2`,
        [roomId, clientId]
      );
      return result.rows[0] ? mapRoomMember(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL room member', { error, roomId, clientId });
      return null;
    }
  }

  async isRoomMember(roomId: string, clientId: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        'SELECT 1 FROM room_members WHERE room_id = $1 AND client_id = $2 LIMIT 1',
        [roomId, clientId]
      );
      return result.rows.length > 0;
    } catch (error) {
      this.logger.error('Error checking PostgreSQL room membership', { error, roomId, clientId });
      return false;
    }
  }

  async readRoomMembers(roomId: string): Promise<RoomMember[]> {
    try {
      const result = await this.pool.query<RoomMemberRow>(
        `SELECT ${ROOM_MEMBER_COLUMNS}
        FROM room_members
        WHERE room_id = $1
        ORDER BY joined_at ASC`,
        [roomId]
      );
      return result.rows.map(mapRoomMember);
    } catch (error) {
      this.logger.error('Error reading PostgreSQL room members', { error, roomId });
      return [];
    }
  }

  async readRoomsByUser(clientId: string): Promise<Room[]> {
    try {
      const result = await this.pool.query<RoomRow>(
        `SELECT ${ROOM_COLUMNS}
        FROM rooms
        WHERE creator_id = $1
        ORDER BY last_activity_at DESC, created_at DESC`,
        [clientId]
      );
      return result.rows.map(mapRoom);
    } catch (error) {
      this.logger.error('Error reading PostgreSQL rooms for user', { error, clientId });
      return [];
    }
  }

  async saveRoomForUser(roomId: string, clientId: string, savedAt = new Date().toISOString()): Promise<Room | null> {
    try {
      const result = await this.pool.query<{ room_id: string }>(
        `INSERT INTO room_saves (room_id, client_id, saved_at)
        SELECT id, $2, $3
        FROM rooms
        WHERE id = $1
        ON CONFLICT (room_id, client_id) DO UPDATE SET
          saved_at = EXCLUDED.saved_at
        RETURNING room_id`,
        [roomId, clientId, savedAt]
      );

      if (!result.rows[0]) {
        return null;
      }

      return this.getRoomById(roomId);
    } catch (error) {
      this.logger.error('Error saving PostgreSQL room for user', { error, roomId, clientId });
      return null;
    }
  }

  async removeSavedRoomForUser(roomId: string, clientId: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        `DELETE FROM room_saves
        WHERE room_id = $1 AND client_id = $2`,
        [roomId, clientId]
      );
      return (result.rowCount || 0) > 0;
    } catch (error) {
      this.logger.error('Error removing PostgreSQL saved room for user', { error, roomId, clientId });
      return false;
    }
  }

  async readSavedRoomsByUser(clientId: string): Promise<Room[]> {
    try {
      const result = await this.pool.query<RoomRow>(
        `SELECT r.${ROOM_COLUMNS.replace(/, /g, ', r.')}
        FROM rooms r
        INNER JOIN room_saves rs ON rs.room_id = r.id
        WHERE rs.client_id = $1
        ORDER BY rs.saved_at DESC, r.last_activity_at DESC, r.created_at DESC`,
        [clientId]
      );
      return result.rows.map(mapRoom);
    } catch (error) {
      this.logger.error('Error reading PostgreSQL saved rooms for user', { error, clientId });
      return [];
    }
  }

  async getRoomById(roomId: string): Promise<Room | null> {
    try {
      const result = await this.pool.query<RoomRow>(
        `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1`,
        [roomId]
      );
      return result.rows[0] ? mapRoom(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL room by id', { error, roomId });
      return null;
    }
  }

  async updateRoomName(roomId: string, creatorId: string, name: string): Promise<Room | null> {
    try {
      const result = await this.pool.query<RoomRow>(
        `UPDATE rooms
        SET name = $3
        WHERE id = $1 AND creator_id = $2
        RETURNING ${ROOM_COLUMNS}`,
        [roomId, creatorId, name]
      );
      const updatedRoom = result.rows[0] ? mapRoom(result.rows[0]) : null;
      if (!updatedRoom) {
        this.logger.warn('PostgreSQL room rename skipped because room was missing or unauthorized', { roomId, creatorId });
      }
      return updatedRoom;
    } catch (error) {
      this.logger.error('Error renaming PostgreSQL room', { error, roomId, creatorId });
      return null;
    }
  }

  async deleteRoom(roomId: string, creatorId: string): Promise<void> {
    try {
      await this.pool.query('DELETE FROM rooms WHERE id = $1 AND creator_id = $2', [roomId, creatorId]);
      this.logger.debug('Room deleted from PostgreSQL', { roomId, creatorId });
    } catch (error) {
      this.logger.error('Error deleting PostgreSQL room', { error, roomId, creatorId });
    }
  }

  async countRooms(): Promise<number> {
    try {
      const result = await this.pool.query<{ count: string | number }>('SELECT COUNT(*) AS count FROM rooms');
      const count = Number.parseInt(String(result.rows[0]?.count || '0'), 10);
      return Number.isFinite(count) ? count : 0;
    } catch (error) {
      this.logger.error('Error counting PostgreSQL rooms', { error });
      return 0;
    }
  }

  async resetAllDataForTests(): Promise<void> {
    await this.pool.query('TRUNCATE room_ai_cost_totals, image_assets, room_messages, room_saves, room_members, rooms RESTART IDENTITY CASCADE');
  }

  async failInterruptedStreamingMessages(content: string): Promise<number> {
    try {
      const result = await this.pool.query(
        `UPDATE room_messages
        SET status = 'error',
          content = $1,
          timestamp = NOW()
        WHERE status = 'streaming'`,
        [content]
      );
      const updatedCount = result.rowCount || 0;
      if (updatedCount > 0) {
        this.logger.warn('Marked interrupted PostgreSQL streaming messages as error', { count: updatedCount });
      }
      return updatedCount;
    } catch (error) {
      this.logger.error('Error marking interrupted PostgreSQL streaming messages', { error });
      return 0;
    }
  }

  private async transaction<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async updateRoomLastActivityFromMessages(client: PostgresClient, roomId: string, fallbackTimestamp: string, incrementMessageVersion = false): Promise<Room | null> {
    const latestMessage = await client.query<{ timestamp: string | Date }>(
      'SELECT timestamp FROM room_messages WHERE room_id = $1 ORDER BY timestamp DESC LIMIT 1',
      [roomId]
    );
    const lastActivityAt = latestMessage.rows[0]?.timestamp
      ? toIsoString(latestMessage.rows[0].timestamp)
      : fallbackTimestamp;

    const updatedRoom = await client.query<RoomRow>(
      `UPDATE rooms
      SET last_activity_at = $2,
        message_version = message_version + $3
      WHERE id = $1
      RETURNING ${ROOM_COLUMNS}`,
      [roomId, lastActivityAt, incrementMessageVersion ? 1 : 0]
    );
    return updatedRoom.rows[0] ? mapRoom(updatedRoom.rows[0]) : null;
  }

  private async saveImageAssetWithClient(client: Pick<PostgresPool, 'query'>, asset: ImageAsset): Promise<ImageAsset | null> {
    const result = await client.query<ImageAssetRow>(
      `INSERT INTO image_assets (
        id,
        room_id,
        message_id,
        object_key,
        mime_type,
        byte_size,
        width,
        height,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE SET
        message_id = EXCLUDED.message_id,
        object_key = EXCLUDED.object_key,
        mime_type = EXCLUDED.mime_type,
        byte_size = EXCLUDED.byte_size,
        width = EXCLUDED.width,
        height = EXCLUDED.height
      RETURNING ${IMAGE_ASSET_COLUMNS}`,
      [
        asset.id,
        asset.roomId,
        asset.messageId || null,
        asset.objectKey,
        asset.mimeType,
        asset.byteSize,
        asset.width ?? null,
        asset.height ?? null,
        asset.createdAt,
      ]
    );
    return result.rows[0] ? mapImageAsset(result.rows[0]) : null;
  }

  private async attachImageAssets(roomId: string, messages: Message[]): Promise<Message[]> {
    if (!messages.some(message => message.messageType === 'image')) {
      return messages;
    }

    const assets = await this.readImageAssetsByRoom(roomId);
    if (assets.length === 0) {
      return messages;
    }

    return this.attachImageAssetsFromAssets(messages, assets);
  }

  private attachImageAssetsFromAssets(messages: Message[], assets: ImageAsset[]): Message[] {
    const assetsByMessageId = new Map(assets.filter(asset => asset.messageId).map(asset => [asset.messageId!, asset]));
    const assetsById = new Map(assets.map(asset => [asset.id, asset]));

    return messages.map(message => {
      if (message.messageType !== 'image') {
        return message;
      }

      const asset = assetsByMessageId.get(message.id) || assetsById.get(message.content);
      if (!asset) {
        return message;
      }

      return {
        ...message,
        content: asset.id,
        mimeType: asset.mimeType,
        imageAsset: toMessageImageAsset(asset),
      };
    });
  }

  private async readMessagesByRoomInTransaction(client: PostgresClient, roomId: string): Promise<Message[]> {
    const result = await client.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
      FROM room_messages
      WHERE room_id = $1
      ORDER BY position ASC, timestamp ASC`,
      [roomId]
    );
    const messages = result.rows.map(mapMessage);
    if (!messages.some(message => message.messageType === 'image')) {
      return messages;
    }

    const assets = await client.query<ImageAssetRow>(
      `SELECT ${IMAGE_ASSET_COLUMNS}
      FROM image_assets
      WHERE room_id = $1
      ORDER BY created_at ASC`,
      [roomId]
    );
    return this.attachImageAssetsFromAssets(messages, assets.rows.map(mapImageAsset));
  }
}
