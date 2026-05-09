import { customAlphabet } from 'nanoid';
import { Logger } from '../logger';
import { AICost, Message, Room, RoomAICostTotal } from '../types';
import { DurableRoomStore } from './store';
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
};

type MessageRow = {
  id: string;
  room_id: string;
  client_id: string;
  content: string;
  timestamp: string | Date;
  message_type: Message['messageType'];
  username: string | null;
  avatar: unknown;
  mime_type: string | null;
  status: Message['status'] | null;
  ai_model: unknown;
  usage: unknown;
  cost: unknown;
};

const ROOM_COLUMNS = 'id, name, description, created_at, last_activity_at, creator_id';

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

const mapRoom = (row: RoomRow): Room => ({
  id: row.id,
  name: row.name,
  description: row.description || '',
  createdAt: toIsoString(row.created_at),
  lastActivityAt: toIsoString(row.last_activity_at || row.created_at),
  creatorId: row.creator_id,
});

const mapMessage = (row: MessageRow): Message => {
  const avatar = parseJsonValue<Message['avatar']>(row.avatar);
  const aiModel = parseJsonValue<Message['aiModel']>(row.ai_model);
  const usage = parseJsonValue<Message['usage']>(row.usage);
  const cost = parseJsonValue<Message['cost']>(row.cost);

  const message: Message = {
    id: row.id,
    clientId: row.client_id,
    content: row.content,
    roomId: row.room_id,
    timestamp: toIsoString(row.timestamp),
    messageType: row.message_type,
  };

  if (row.username) message.username = row.username;
  if (avatar) message.avatar = avatar;
  if (row.mime_type) message.mimeType = row.mime_type;
  if (row.status) message.status = row.status;
  if (aiModel) message.aiModel = aiModel;
  if (usage) message.usage = usage;
  if (cost) message.cost = cost;

  return message;
};

const messageParams = (message: Message, position: number): unknown[] => [
  message.id,
  message.roomId,
  message.clientId,
  message.content,
  message.timestamp,
  message.messageType,
  message.username || null,
  toJsonb(message.avatar),
  message.mimeType || null,
  message.status || null,
  toJsonb(message.aiModel),
  toJsonb(message.usage),
  toJsonb(message.cost),
  position,
];

const INSERT_MESSAGE_SQL = `INSERT INTO room_messages (
  id,
  room_id,
  client_id,
  content,
  timestamp,
  message_type,
  username,
  avatar,
  mime_type,
  status,
  ai_model,
  usage,
  cost,
  position
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14
) ON CONFLICT (id) DO UPDATE SET
  room_id = EXCLUDED.room_id,
  client_id = EXCLUDED.client_id,
  content = EXCLUDED.content,
  timestamp = EXCLUDED.timestamp,
  message_type = EXCLUDED.message_type,
  username = EXCLUDED.username,
  avatar = EXCLUDED.avatar,
  mime_type = EXCLUDED.mime_type,
  status = EXCLUDED.status,
  ai_model = EXCLUDED.ai_model,
  usage = EXCLUDED.usage,
  cost = EXCLUDED.cost,
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
          `UPDATE rooms SET last_activity_at = $2 WHERE id = $1 RETURNING ${ROOM_COLUMNS}`,
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
          `UPDATE rooms SET last_activity_at = GREATEST(last_activity_at, $2::timestamptz) WHERE id = $1 RETURNING ${ROOM_COLUMNS}`,
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
          `UPDATE rooms SET last_activity_at = $2 WHERE id = $1 RETURNING ${ROOM_COLUMNS}`,
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
      const result = await this.pool.query('DELETE FROM room_messages WHERE room_id = $1', [roomId]);
      return result.rowCount || 0;
    } catch (error) {
      this.logger.error('Error clearing PostgreSQL room messages', { error, roomId });
      return 0;
    }
  }

  async readMessagesByRoom(roomId: string): Promise<Message[]> {
    try {
      const result = await this.pool.query<MessageRow>(
        `SELECT id, room_id, client_id, content, timestamp, message_type, username, avatar, mime_type, status, ai_model, usage, cost
        FROM room_messages
        WHERE room_id = $1
        ORDER BY position ASC, timestamp ASC`,
        [roomId]
      );
      return result.rows.map(mapMessage);
    } catch (error) {
      this.logger.error('Error reading PostgreSQL room messages', { error, roomId });
      return [];
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
      const result = await this.pool.query<RoomRow>(
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
      this.logger.debug('Room saved to PostgreSQL', { roomId: room.id, creatorId: room.creatorId });
      return result.rows[0] ? mapRoom(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error saving room to PostgreSQL', { error, roomId: room.id, creatorId: room.creatorId });
      return null;
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
    await this.pool.query('TRUNCATE room_ai_cost_totals, room_messages, rooms RESTART IDENTITY CASCADE');
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
}
