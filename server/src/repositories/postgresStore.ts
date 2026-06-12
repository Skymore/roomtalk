import { customAlphabet } from 'nanoid';
import { Logger } from '../logger';
import { AICost, MediaAsset, Message, MessageMediaAsset, Room, RoomAICostTotal, RoomMember, RoomMemberRole, RoomPostingSchedule } from '../types';
import { getAIStreamOwnerId, InterruptedStreamingMessageRecoveryOptions } from '../services/aiStreamRecovery';
import { AudioTranscriptionRecord, AudioTranscriptionUpdate, ClientAuthTokenRecord, DEFAULT_ROOM_MESSAGE_PAGE_LIMIT, DurableRoomStore, MediaHistoryPage, MediaHistoryPageOptions, MediaMessageAppendResult, PendingMediaUpload, PushSubscriptionRecord, RoomMessagePageOptions, RoomSettingsUpdate, SavePushSubscriptionInput } from './store';
import { POSTGRES_MIGRATIONS, POSTGRES_SCHEMA_SQL } from './postgresSchema';
import { MediaObjectStorage } from '../services/mediaObjectStorage';

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
  password_hash?: string | null;
  posting_schedule?: unknown;
  room_version?: number | string | null;
  updated_at?: string | Date | null;
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
  ai_stream_owner_id?: string | null;
  position?: number | string;
};

type RoomMemberRow = {
  room_id: string;
  client_id: string;
  role: RoomMemberRole;
  joined_at: string | Date;
};

type MediaAssetRow = {
  id: string;
  room_id: string;
  message_id: string | null;
  object_key: string;
  kind: MediaAsset['kind'];
  mime_type: string;
  byte_size: number | string;
  filename: string | null;
  width: number | string | null;
  height: number | string | null;
  duration_ms: number | string | null;
  uploaded_by_client_id: string | null;
  created_at: string | Date;
};

type PendingMediaUploadRow = {
  id: string;
  room_id: string;
  object_key: string;
  kind: MediaAsset['kind'];
  mime_type: string;
  byte_size: number | string;
  filename: string | null;
  uploaded_by_client_id: string;
  expires_at: string | Date;
  created_at: string | Date;
};

type AudioTranscriptionRow = {
  asset_id: string;
  room_id: string;
  message_id: string;
  requested_by_client_id: string;
  status: AudioTranscriptionRecord['status'];
  transcript: string | null;
  language_code: string | null;
  provider: AudioTranscriptionRecord['provider'];
  provider_transcript_id: string | null;
  error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  completed_at: string | Date | null;
};

type PushSubscriptionRow = {
  endpoint: string;
  client_id: string;
  browser_instance_id: string | null;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

const ROOM_COLUMNS = 'id, name, description, created_at, last_activity_at, creator_id, message_version, password_hash, posting_schedule, room_version, updated_at';
const MESSAGE_COLUMNS = 'id, room_id, client_id, content, timestamp, updated_at, message_type, username, avatar, mime_type, status, ai_model, usage, cost, reply_to, ai_stream_owner_id';
const ROOM_MEMBER_COLUMNS = 'room_id, client_id, role, joined_at';
const MEDIA_ASSET_COLUMNS = 'id, room_id, message_id, object_key, kind, mime_type, byte_size, filename, width, height, duration_ms, uploaded_by_client_id, created_at';
const PENDING_MEDIA_UPLOAD_COLUMNS = 'id, room_id, object_key, kind, mime_type, byte_size, filename, uploaded_by_client_id, expires_at, created_at';
const AUDIO_TRANSCRIPTION_COLUMNS = 'asset_id, room_id, message_id, requested_by_client_id, status, transcript, language_code, provider, provider_transcript_id, error, created_at, updated_at, completed_at';
const PUSH_SUBSCRIPTION_COLUMNS = 'endpoint, client_id, browser_instance_id, p256dh, auth, user_agent, created_at, updated_at';

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

const normalizeMediaHistoryPageLimit = (limit?: number): number => {
  if (!Number.isFinite(limit)) {
    return 40;
  }

  return Math.min(200, Math.max(1, Math.floor(limit || 40)));
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
  if (row.password_hash) room.hasPassword = true;
  const postingSchedule = parseJsonValue<RoomPostingSchedule>(row.posting_schedule);
  if (postingSchedule) room.postingSchedule = postingSchedule;
  const roomVersion = Number(row.room_version || 0);
  if (roomVersion > 0) room.roomVersion = roomVersion;
  if (row.updated_at) room.updatedAt = toIsoString(row.updated_at);
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

const mapMediaAsset = (row: MediaAssetRow): MediaAsset => {
  const asset: MediaAsset = {
    id: row.id,
    roomId: row.room_id,
    objectKey: row.object_key,
    kind: row.kind,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size) || 0,
    createdAt: toIsoString(row.created_at),
  };

  if (row.message_id) asset.messageId = row.message_id;
  if (row.filename) asset.filename = row.filename;
  if (row.uploaded_by_client_id) asset.uploadedByClientId = row.uploaded_by_client_id;
  const width = toOptionalNumber(row.width);
  const height = toOptionalNumber(row.height);
  const durationMs = toOptionalNumber(row.duration_ms);
  if (width !== undefined) asset.width = width;
  if (height !== undefined) asset.height = height;
  if (durationMs !== undefined) asset.durationMs = durationMs;
  return asset;
};

const mapPendingMediaUpload = (row: PendingMediaUploadRow): PendingMediaUpload => {
  const upload: PendingMediaUpload = {
    assetId: row.id,
    roomId: row.room_id,
    objectKey: row.object_key,
    kind: row.kind,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size) || 0,
    uploadedByClientId: row.uploaded_by_client_id,
    expiresAt: toIsoString(row.expires_at),
    createdAt: toIsoString(row.created_at),
  };
  if (row.filename) upload.filename = row.filename;
  return upload;
};

const mapAudioTranscription = (row: AudioTranscriptionRow): AudioTranscriptionRecord => {
  const record: AudioTranscriptionRecord = {
    assetId: row.asset_id,
    roomId: row.room_id,
    messageId: row.message_id,
    requestedByClientId: row.requested_by_client_id,
    status: row.status,
    provider: row.provider,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
  if (row.transcript) record.transcript = row.transcript;
  if (row.language_code) record.languageCode = row.language_code;
  if (row.provider_transcript_id) record.providerTranscriptId = row.provider_transcript_id;
  if (row.error) record.error = row.error;
  if (row.completed_at) record.completedAt = toIsoString(row.completed_at);
  return record;
};

const mapPushSubscription = (row: PushSubscriptionRow): PushSubscriptionRecord => ({
  clientId: row.client_id,
  browserInstanceId: row.browser_instance_id || undefined,
  endpoint: row.endpoint,
  p256dh: row.p256dh,
  auth: row.auth,
  userAgent: row.user_agent || undefined,
  createdAt: toIsoString(row.created_at),
  updatedAt: toIsoString(row.updated_at),
});

const toMessageMediaAsset = (asset: MediaAsset): MessageMediaAsset => {
  const messageAsset: MessageMediaAsset = {
    id: asset.id,
    kind: asset.kind,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
  };
  if (asset.filename !== undefined) messageAsset.filename = asset.filename;
  if (asset.width !== undefined) messageAsset.width = asset.width;
  if (asset.height !== undefined) messageAsset.height = asset.height;
  if (asset.durationMs !== undefined) messageAsset.durationMs = asset.durationMs;
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
  getAIStreamOwnerId(message) || null,
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
  ai_stream_owner_id,
  position
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16, $17
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
  ai_stream_owner_id = EXCLUDED.ai_stream_owner_id,
  position = room_messages.position`;

export class PostgresStore implements DurableRoomStore {
  constructor(
    private readonly pool: PostgresPool,
    private readonly logger: Logger,
    private readonly mediaObjectStorage?: MediaObjectStorage
  ) {}

  // Best-effort removal of S3 objects whose media_assets rows were already
  // deleted in a committed transaction. Runs AFTER commit so a storage failure
  // never rolls back the durable delete; orphaned objects are logged, not fatal.
  private async deleteOrphanedMediaObjects(objectKeys: string[]): Promise<void> {
    if (objectKeys.length === 0 || !this.mediaObjectStorage?.deleteMediaObject) {
      return;
    }

    for (const objectKey of objectKeys) {
      try {
        await this.mediaObjectStorage.deleteMediaObject(objectKey);
      } catch (error) {
        this.logger.error('Failed to delete orphaned media object', { error, objectKey });
      }
    }
  }

  async initializeSchema(): Promise<void> {
    for (const sql of POSTGRES_SCHEMA_SQL) {
      await this.pool.query(sql);
    }
    await this.runMigrations();
    this.logger.info('PostgreSQL schema initialized');
  }

  private async runMigrations(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );

    for (const migration of POSTGRES_MIGRATIONS) {
      const applied = await this.pool.query(
        'SELECT 1 FROM schema_migrations WHERE id = $1 LIMIT 1',
        [migration.id]
      );
      if (applied.rows.length > 0) {
        continue;
      }

      // Apply the migration and record it atomically, so a crash mid-migration
      // never leaves it marked as applied without its effect (or vice versa).
      await this.transaction(async client => {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
          [migration.id]
        );
      });
      this.logger.info('Applied PostgreSQL migration', { id: migration.id });
    }
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
            message_version = message_version + 1,
            room_version = room_version + 1, updated_at = NOW()
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

    try {
      return await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [mediaMessage.roomId]
        );
        if (room.rows.length === 0) {
          this.logger.warn('Cannot append media message to missing PostgreSQL room', { roomId: mediaMessage.roomId, messageId: mediaMessage.id, assetId: mediaAsset.id });
          return null;
        }

        const nextPosition = await client.query<{ position: number | string }>(
          'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM room_messages WHERE room_id = $1',
          [mediaMessage.roomId]
        );
        const position = Number(nextPosition.rows[0]?.position || 0);
        await client.query(INSERT_MESSAGE_SQL, messageParams(mediaMessage, position));

        const savedAsset = await this.saveMediaAssetWithClient(client, mediaAsset);
        if (!savedAsset) {
          throw new Error('Failed to save media asset');
        }

        const updatedRoom = await client.query<RoomRow>(
          `UPDATE rooms
          SET last_activity_at = GREATEST(last_activity_at, $2::timestamptz),
            message_version = message_version + 1,
            room_version = room_version + 1, updated_at = NOW()
          WHERE id = $1
          RETURNING ${ROOM_COLUMNS}`,
          [mediaMessage.roomId, mediaMessage.timestamp]
        );
        const roomResult = updatedRoom.rows[0] ? mapRoom(updatedRoom.rows[0]) : null;
        if (!roomResult) {
          throw new Error('Failed to update room after media message append');
        }

        const savedMessage = this.attachMediaAssetsFromAssets([mediaMessage], [savedAsset])[0];
        this.logger.debug('Media message and asset appended to PostgreSQL', { roomId: mediaMessage.roomId, messageId: mediaMessage.id, assetId: savedAsset.id, kind: savedAsset.kind });
        return { room: roomResult, message: savedMessage, asset: savedAsset };
      });
    } catch (error) {
      this.logger.error('Error appending PostgreSQL media message and asset', { error, roomId: mediaMessage.roomId, messageId: mediaMessage.id, assetId: mediaAsset.id });
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
            message_version = message_version + 1,
            room_version = room_version + 1, updated_at = NOW()
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
    let orphanedObjectKeys: string[] = [];
    try {
      const result = await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [roomId]
        );
        if (room.rows.length === 0) {
          this.logger.warn('Cannot delete message for missing PostgreSQL room', { roomId, messageId });
          return null;
        }

        // Remove the asset row first, while message_id still links it; the
        // room_messages FK would otherwise SET NULL and strand both the row and
        // its S3 object.
        const orphaned = await client.query<{ object_key: string }>(
          'DELETE FROM media_assets WHERE room_id = $1 AND message_id = $2 RETURNING object_key',
          [roomId, messageId]
        );

        const deleted = await client.query<{ id: string }>(
          'DELETE FROM room_messages WHERE room_id = $1 AND id = $2 RETURNING id',
          [roomId, messageId]
        );
        if (deleted.rows.length === 0) {
          return { room: mapRoom(room.rows[0]), deleted: false };
        }

        orphanedObjectKeys = orphaned.rows.map(row => row.object_key);

        const updatedRoom = await this.updateRoomLastActivityFromMessages(client, roomId, toIsoString(room.rows[0].created_at), true);
        if (!updatedRoom) {
          return null;
        }

        this.logger.debug('Message deleted from PostgreSQL', { roomId, messageId });
        return { room: updatedRoom, deleted: true };
      });

      await this.deleteOrphanedMediaObjects(orphanedObjectKeys);
      return result;
    } catch (error) {
      this.logger.error('Error deleting message from PostgreSQL', { error, roomId, messageId });
      return null;
    }
  }

  private async truncateMessages(roomId: string, messageId: string, mode: 'before' | 'after') {
    let orphanedObjectKeys: string[] = [];
    try {
      const result = await this.transaction(async client => {
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
        // Strand-free order: drop the asset rows for the doomed messages before
        // the messages themselves are removed.
        const orphaned = await client.query<{ object_key: string }>(
          `DELETE FROM media_assets
          WHERE room_id = $1 AND message_id IN (
            SELECT id FROM room_messages WHERE room_id = $1 AND position ${operator} $2
          )
          RETURNING object_key`,
          [roomId, Number(target.rows[0].position)]
        );
        orphanedObjectKeys = orphaned.rows.map(row => row.object_key);

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

      await this.deleteOrphanedMediaObjects(orphanedObjectKeys);
      return result;
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
    let orphanedObjectKeys: string[] = [];
    try {
      const result = await this.transaction(async client => {
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

        // Drop asset rows for the truncated tail before deleting those messages.
        const orphaned = await client.query<{ object_key: string }>(
          `DELETE FROM media_assets
          WHERE room_id = $1 AND message_id IN (
            SELECT id FROM room_messages WHERE room_id = $1 AND position > $2
          )
          RETURNING object_key`,
          [roomId, Number(target.rows[0].position)]
        );
        orphanedObjectKeys = orphaned.rows.map(row => row.object_key);

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

      await this.deleteOrphanedMediaObjects(orphanedObjectKeys);
      return result;
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
            message_version = message_version + 1,
            room_version = room_version + 1, updated_at = NOW()
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
    let orphanedObjectKeys: string[] = [];
    try {
      const deleted = await this.transaction(async client => {
        // Clearing removes every message, so every asset in the room is orphaned.
        const orphaned = await client.query<{ object_key: string }>(
          'DELETE FROM media_assets WHERE room_id = $1 RETURNING object_key',
          [roomId]
        );
        orphanedObjectKeys = orphaned.rows.map(row => row.object_key);

        const result = await client.query('DELETE FROM room_messages WHERE room_id = $1', [roomId]);
        const removed = result.rowCount || 0;
        if (removed > 0) {
          await client.query(
            `UPDATE rooms
            SET message_version = message_version + 1,
              last_activity_at = created_at,
              room_version = room_version + 1, updated_at = NOW()
            WHERE id = $1`,
            [roomId]
          );
        }
        return removed;
      });

      await this.deleteOrphanedMediaObjects(orphanedObjectKeys);
      return deleted;
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
      return this.attachMediaAssets(roomId, result.rows.map(mapMessage));
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
      const messages = await this.attachMediaAssets(roomId, rows.slice(0, limit).reverse().map(mapMessage));
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

  async saveMediaAsset(asset: MediaAsset): Promise<MediaAsset | null> {
    try {
      return await this.saveMediaAssetWithClient(this.pool, asset);
    } catch (error) {
      this.logger.error('Error saving PostgreSQL media asset', { error, assetId: asset.id, roomId: asset.roomId, kind: asset.kind });
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
      return await this.transaction(async client => {
        const room = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [roomId]
        );
        if (room.rows.length === 0) {
          this.logger.warn('Cannot replace media asset for missing PostgreSQL room', { roomId, messageId, assetId: asset.id });
          return null;
        }

        const updated = await client.query<MessageRow>(
          `UPDATE room_messages
          SET content = $3,
            message_type = 'media',
            mime_type = $4
          WHERE room_id = $1 AND id = $2
            AND message_type = 'media'
          RETURNING ${MESSAGE_COLUMNS}`,
          [roomId, messageId, '', mediaAsset.mimeType]
        );
        if (updated.rows.length === 0) {
          return { room: mapRoom(room.rows[0]), found: false };
        }

        const savedAsset = await this.saveMediaAssetWithClient(client, mediaAsset);
        if (!savedAsset) {
          return null;
        }

        const updatedMessage = this.attachMediaAssetsFromAssets([mapMessage(updated.rows[0])], [savedAsset])[0];
        this.logger.debug('Media message asset replaced in PostgreSQL', { roomId, messageId, assetId: mediaAsset.id, kind: mediaAsset.kind });
        return { room: mapRoom(room.rows[0]), found: true, updatedMessage };
      });
    } catch (error) {
      this.logger.error('Error replacing PostgreSQL media message asset', { error, roomId, messageId, assetId: asset.id });
      return null;
    }
  }

  async getMediaAsset(assetId: string): Promise<MediaAsset | null> {
    try {
      const result = await this.pool.query<MediaAssetRow>(
        `SELECT ${MEDIA_ASSET_COLUMNS}
        FROM media_assets
        WHERE id = $1`,
        [assetId]
      );
      return result.rows[0] ? mapMediaAsset(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL media asset', { error, assetId });
      return null;
    }
  }

  async getMediaAssetByMessageId(messageId: string): Promise<MediaAsset | null> {
    try {
      const result = await this.pool.query<MediaAssetRow>(
        `SELECT ${MEDIA_ASSET_COLUMNS}
        FROM media_assets
        WHERE message_id = $1`,
        [messageId]
      );
      return result.rows[0] ? mapMediaAsset(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL media asset by message id', { error, messageId });
      return null;
    }
  }

  async readMediaAssetsByRoom(roomId: string): Promise<MediaAsset[]> {
    try {
      const result = await this.pool.query<MediaAssetRow>(
        `SELECT ${MEDIA_ASSET_COLUMNS}
        FROM media_assets
        WHERE room_id = $1
        ORDER BY created_at ASC`,
        [roomId]
      );
      return result.rows.map(mapMediaAsset);
    } catch (error) {
      this.logger.error('Error reading PostgreSQL media assets by room', { error, roomId });
      return [];
    }
  }

  async readMediaHistoryPageByRoom(roomId: string, options: MediaHistoryPageOptions = {}): Promise<MediaHistoryPage> {
    const limit = normalizeMediaHistoryPageLimit(options.limit);
    const kinds = options.kinds?.length ? options.kinds : ['image', 'video', 'audio'];
    const params: unknown[] = [roomId, kinds];
    const conditions = ['room_id = $1', 'kind = ANY($2::text[])'];
    const sinceTime = Date.parse(options.since || '');
    const beforeTime = Date.parse(options.before?.createdAt || '');

    if (Number.isFinite(sinceTime)) {
      params.push(options.since);
      conditions.push(`created_at >= $${params.length}`);
    }

    if (options.before && Number.isFinite(beforeTime)) {
      params.push(options.before.createdAt, options.before.assetId);
      const createdAtParam = params.length - 1;
      const assetIdParam = params.length;
      conditions.push(`(created_at < $${createdAtParam} OR (created_at = $${createdAtParam} AND id < $${assetIdParam}))`);
    }

    params.push(limit + 1);

    try {
      const result = await this.pool.query<MediaAssetRow>(
        `SELECT ${MEDIA_ASSET_COLUMNS}
        FROM media_assets
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length}`,
        params
      );
      return {
        assets: result.rows.slice(0, limit).map(mapMediaAsset),
        hasMore: result.rows.length > limit,
      };
    } catch (error) {
      this.logger.error('Error reading PostgreSQL media history page by room', { error, roomId, options });
      return { assets: [], hasMore: false };
    }
  }

  async deleteMediaAsset(assetId: string): Promise<void> {
    try {
      await this.pool.query('DELETE FROM media_assets WHERE id = $1', [assetId]);
    } catch (error) {
      this.logger.error('Error deleting PostgreSQL media asset', { error, assetId });
    }
  }

  async savePendingMediaUpload(upload: PendingMediaUpload): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO pending_media_uploads (
          id,
          room_id,
          object_key,
          kind,
          mime_type,
          byte_size,
          filename,
          uploaded_by_client_id,
          expires_at,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO UPDATE SET
          room_id = EXCLUDED.room_id,
          object_key = EXCLUDED.object_key,
          kind = EXCLUDED.kind,
          mime_type = EXCLUDED.mime_type,
          byte_size = EXCLUDED.byte_size,
          filename = EXCLUDED.filename,
          uploaded_by_client_id = EXCLUDED.uploaded_by_client_id,
          expires_at = EXCLUDED.expires_at`,
        [
          upload.assetId,
          upload.roomId,
          upload.objectKey,
          upload.kind,
          upload.mimeType,
          upload.byteSize,
          upload.filename || null,
          upload.uploadedByClientId,
          upload.expiresAt,
          upload.createdAt,
        ]
      );
    } catch (error) {
      this.logger.error('Error saving PostgreSQL pending media upload', { error, assetId: upload.assetId, roomId: upload.roomId });
      throw error;
    }
  }

  async getPendingMediaUpload(assetId: string): Promise<PendingMediaUpload | null> {
    try {
      const result = await this.pool.query<PendingMediaUploadRow>(
        `SELECT ${PENDING_MEDIA_UPLOAD_COLUMNS}
        FROM pending_media_uploads
        WHERE id = $1`,
        [assetId]
      );
      return result.rows[0] ? mapPendingMediaUpload(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL pending media upload', { error, assetId });
      return null;
    }
  }

  async deletePendingMediaUpload(assetId: string): Promise<void> {
    try {
      await this.pool.query('DELETE FROM pending_media_uploads WHERE id = $1', [assetId]);
    } catch (error) {
      this.logger.error('Error deleting PostgreSQL pending media upload', { error, assetId });
    }
  }

  async claimExpiredPendingMediaUploads(now: string, limit = 50): Promise<PendingMediaUpload[]> {
    const safeLimit = Math.min(200, Math.max(1, Math.floor(limit)));
    try {
      const result = await this.pool.query<PendingMediaUploadRow>(
        `DELETE FROM pending_media_uploads
        WHERE id IN (
          SELECT id
          FROM pending_media_uploads
          WHERE expires_at <= $1
          ORDER BY expires_at ASC
          LIMIT $2
        )
        RETURNING ${PENDING_MEDIA_UPLOAD_COLUMNS}`,
        [now, safeLimit]
      );
      return result.rows.map(mapPendingMediaUpload);
    } catch (error) {
      this.logger.error('Error claiming expired PostgreSQL pending media uploads', { error, now, limit: safeLimit });
      return [];
    }
  }

  async getAudioTranscription(assetId: string): Promise<AudioTranscriptionRecord | null> {
    try {
      const result = await this.pool.query<AudioTranscriptionRow>(
        `SELECT ${AUDIO_TRANSCRIPTION_COLUMNS}
        FROM audio_transcriptions
        WHERE asset_id = $1`,
        [assetId]
      );
      return result.rows[0] ? mapAudioTranscription(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL audio transcription', { error, assetId });
      return null;
    }
  }

  async createAudioTranscription(record: AudioTranscriptionRecord): Promise<AudioTranscriptionRecord> {
    try {
      const result = await this.pool.query<AudioTranscriptionRow>(
        `INSERT INTO audio_transcriptions (
          asset_id,
          room_id,
          message_id,
          requested_by_client_id,
          status,
          transcript,
          language_code,
          provider,
          provider_transcript_id,
          error,
          created_at,
          updated_at,
          completed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (asset_id) DO NOTHING
        RETURNING ${AUDIO_TRANSCRIPTION_COLUMNS}`,
        [
          record.assetId,
          record.roomId,
          record.messageId,
          record.requestedByClientId,
          record.status,
          record.transcript ?? null,
          record.languageCode ?? null,
          record.provider,
          record.providerTranscriptId ?? null,
          record.error ?? null,
          record.createdAt,
          record.updatedAt,
          record.completedAt ?? null,
        ]
      );
      if (result.rows[0]) {
        return mapAudioTranscription(result.rows[0]);
      }

      const existing = await this.getAudioTranscription(record.assetId);
      if (existing) {
        return existing;
      }
      throw new Error('Audio transcription insert conflicted but no existing row was found');
    } catch (error) {
      this.logger.error('Error creating PostgreSQL audio transcription', { error, assetId: record.assetId, roomId: record.roomId, messageId: record.messageId });
      throw error;
    }
  }

  async updateAudioTranscription(assetId: string, updates: AudioTranscriptionUpdate): Promise<AudioTranscriptionRecord | null> {
    const assignments: string[] = [];
    const values: unknown[] = [assetId];
    const addAssignment = (column: string, value: unknown) => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };

    if (updates.status !== undefined) addAssignment('status', updates.status);
    if (updates.transcript !== undefined) addAssignment('transcript', updates.transcript);
    if (updates.languageCode !== undefined) addAssignment('language_code', updates.languageCode);
    if (updates.providerTranscriptId !== undefined) addAssignment('provider_transcript_id', updates.providerTranscriptId);
    if (updates.error !== undefined) addAssignment('error', updates.error);
    if (updates.completedAt !== undefined) addAssignment('completed_at', updates.completedAt);
    addAssignment('updated_at', updates.updatedAt || new Date().toISOString());

    try {
      const result = await this.pool.query<AudioTranscriptionRow>(
        `UPDATE audio_transcriptions
        SET ${assignments.join(', ')}
        WHERE asset_id = $1
        RETURNING ${AUDIO_TRANSCRIPTION_COLUMNS}`,
        values
      );
      return result.rows[0] ? mapAudioTranscription(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error updating PostgreSQL audio transcription', { error, assetId, updates });
      throw error;
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
          `INSERT INTO rooms (id, name, description, created_at, last_activity_at, creator_id, room_version, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, 1, NOW())
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            last_activity_at = GREATEST(rooms.last_activity_at, EXCLUDED.last_activity_at),
            room_version = rooms.room_version + 1, updated_at = NOW()
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

  async savePushSubscription(subscription: SavePushSubscriptionInput): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO push_subscriptions (endpoint, client_id, browser_instance_id, p256dh, auth, user_agent, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
        ON CONFLICT (endpoint) DO UPDATE SET
          client_id = EXCLUDED.client_id,
          browser_instance_id = EXCLUDED.browser_instance_id,
          p256dh = EXCLUDED.p256dh,
          auth = EXCLUDED.auth,
          user_agent = EXCLUDED.user_agent,
          updated_at = EXCLUDED.updated_at`,
        [
          subscription.endpoint,
          subscription.clientId,
          subscription.browserInstanceId || null,
          subscription.p256dh,
          subscription.auth,
          subscription.userAgent || null,
        ]
      );
    } catch (error) {
      this.logger.error('Error saving PostgreSQL push subscription', { error, clientId: subscription.clientId });
    }
  }

  async deletePushSubscription(clientId: string, endpoint: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        'DELETE FROM push_subscriptions WHERE client_id = $1 AND endpoint = $2',
        [clientId, endpoint]
      );
      return (result.rowCount || 0) > 0;
    } catch (error) {
      this.logger.error('Error deleting PostgreSQL push subscription', { error, clientId });
      return false;
    }
  }

  async readPushSubscriptionsByRoom(roomId: string): Promise<PushSubscriptionRecord[]> {
    try {
      const result = await this.pool.query<PushSubscriptionRow>(
        `SELECT ps.${PUSH_SUBSCRIPTION_COLUMNS.replace(/, /g, ', ps.')}
        FROM push_subscriptions ps
        INNER JOIN room_members rm ON rm.client_id = ps.client_id
        WHERE rm.room_id = $1
        ORDER BY ps.updated_at DESC`,
        [roomId]
      );
      return result.rows.map(mapPushSubscription);
    } catch (error) {
      this.logger.error('Error reading PostgreSQL room push subscriptions', { error, roomId });
      return [];
    }
  }

  async setClientPasswordHash(clientId: string, passwordHash: string): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO client_passwords (client_id, password_hash, created_at, updated_at)
        VALUES ($1, $2, NOW(), NOW())
        ON CONFLICT (client_id) DO UPDATE SET
          password_hash = EXCLUDED.password_hash,
          updated_at = EXCLUDED.updated_at`,
        [clientId, passwordHash]
      );
    } catch (error) {
      this.logger.error('Error setting PostgreSQL client password hash', { error, clientId });
    }
  }

  async getClientPasswordHash(clientId: string): Promise<string | null> {
    try {
      const result = await this.pool.query<{ password_hash: string }>(
        'SELECT password_hash FROM client_passwords WHERE client_id = $1',
        [clientId]
      );
      return result.rows[0]?.password_hash || null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL client password hash', { error, clientId });
      return null;
    }
  }

  async saveClientAuthToken(token: ClientAuthTokenRecord): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO client_auth_tokens (token_hash, client_id, created_at, last_used_at)
        VALUES ($1, $2, $3, $3)
        ON CONFLICT (token_hash) DO UPDATE SET
          client_id = EXCLUDED.client_id,
          last_used_at = EXCLUDED.last_used_at`,
        [token.tokenHash, token.clientId, token.createdAt]
      );
    } catch (error) {
      this.logger.error('Error saving PostgreSQL client auth token', { error, clientId: token.clientId });
    }
  }

  async isClientAuthTokenValid(clientId: string, tokenHash: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        `UPDATE client_auth_tokens
        SET last_used_at = NOW()
        WHERE client_id = $1 AND token_hash = $2`,
        [clientId, tokenHash]
      );
      return (result.rowCount || 0) > 0;
    } catch (error) {
      this.logger.error('Error checking PostgreSQL client auth token', { error, clientId });
      return false;
    }
  }

  async deleteClientAuthToken(clientId: string, tokenHash: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        'DELETE FROM client_auth_tokens WHERE client_id = $1 AND token_hash = $2',
        [clientId, tokenHash]
      );
      return (result.rowCount || 0) > 0;
    } catch (error) {
      this.logger.error('Error deleting PostgreSQL client auth token', { error, clientId });
      return false;
    }
  }

  async deleteClientAuthTokens(clientId: string): Promise<void> {
    try {
      await this.pool.query('DELETE FROM client_auth_tokens WHERE client_id = $1', [clientId]);
    } catch (error) {
      this.logger.error('Error deleting PostgreSQL client auth tokens', { error, clientId });
    }
  }

  async readRoomPasswordHash(roomId: string): Promise<string | null> {
    try {
      const result = await this.pool.query<{ password_hash: string | null }>(
        'SELECT password_hash FROM rooms WHERE id = $1',
        [roomId]
      );
      return result.rows[0]?.password_hash || null;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL room password hash', { error, roomId });
      return null;
    }
  }

  async updateRoomSettings(roomId: string, updates: RoomSettingsUpdate): Promise<Room | null> {
    const hasPasswordHashUpdate = Object.prototype.hasOwnProperty.call(updates, 'passwordHash');
    const hasPostingScheduleUpdate = Object.prototype.hasOwnProperty.call(updates, 'postingSchedule');

    try {
      const result = await this.pool.query<RoomRow>(
        `UPDATE rooms
        SET password_hash = CASE WHEN $2::boolean THEN $3 ELSE password_hash END,
          posting_schedule = CASE WHEN $4::boolean THEN $5::jsonb ELSE posting_schedule END,
          room_version = room_version + 1, updated_at = NOW()
        WHERE id = $1
        RETURNING ${ROOM_COLUMNS}`,
        [
          roomId,
          hasPasswordHashUpdate,
          updates.passwordHash ?? null,
          hasPostingScheduleUpdate,
          toJsonb(updates.postingSchedule ?? null),
        ]
      );
      return result.rows[0] ? mapRoom(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error updating PostgreSQL room settings', { error, roomId });
      return null;
    }
  }

  async updateRoomMemberRole(roomId: string, clientId: string, role: RoomMemberRole, joinedAt = new Date().toISOString()): Promise<RoomMember | null> {
    try {
      const result = await this.pool.query<RoomMemberRow>(
        `INSERT INTO room_members (room_id, client_id, role, joined_at)
        SELECT id, $2, $3, $4
        FROM rooms
        WHERE id = $1
        ON CONFLICT (room_id, client_id) DO UPDATE SET
          role = EXCLUDED.role
        RETURNING ${ROOM_MEMBER_COLUMNS}`,
        [roomId, clientId, role, joinedAt]
      );
      return result.rows[0] ? mapRoomMember(result.rows[0]) : null;
    } catch (error) {
      this.logger.error('Error updating PostgreSQL room member role', { error, roomId, clientId, role });
      return null;
    }
  }

  async transferRoomOwnership(
    roomId: string,
    newOwnerClientId: string,
    previousOwnerRole: Exclude<RoomMemberRole, 'owner'> = 'admin',
  ): Promise<Room | null> {
    try {
      return await this.transaction(async client => {
        const roomResult = await client.query<RoomRow>(
          `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1 FOR UPDATE`,
          [roomId]
        );
        if (roomResult.rows.length === 0) {
          return null;
        }

        const previousOwnerId = roomResult.rows[0].creator_id;

        await client.query(
          `UPDATE room_members
          SET role = $3
          WHERE room_id = $1 AND client_id = $2`,
          [roomId, previousOwnerId, previousOwnerRole]
        );

        await client.query(
          `INSERT INTO room_members (room_id, client_id, role, joined_at)
          VALUES ($1, $2, 'owner', NOW())
          ON CONFLICT (room_id, client_id) DO UPDATE SET
            role = 'owner'`,
          [roomId, newOwnerClientId]
        );

        const updated = await client.query<RoomRow>(
          `UPDATE rooms
          SET creator_id = $2, room_version = room_version + 1, updated_at = NOW()
          WHERE id = $1
          RETURNING ${ROOM_COLUMNS}`,
          [roomId, newOwnerClientId]
        );
        return updated.rows[0] ? mapRoom(updated.rows[0]) : null;
      });
    } catch (error) {
      this.logger.error('Error transferring PostgreSQL room ownership', { error, roomId, newOwnerClientId });
      return null;
    }
  }

  async setClientNickname(clientId: string, nickname: string): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO client_profiles (client_id, nickname, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (client_id) DO UPDATE SET
          nickname = EXCLUDED.nickname,
          updated_at = EXCLUDED.updated_at`,
        [clientId, nickname]
      );
    } catch (error) {
      this.logger.error('Error setting PostgreSQL client nickname', { error, clientId });
    }
  }

  async getClientNicknames(clientIds: string[]): Promise<Record<string, string>> {
    if (clientIds.length === 0) {
      return {};
    }
    try {
      const result = await this.pool.query<{ client_id: string; nickname: string }>(
        'SELECT client_id, nickname FROM client_profiles WHERE client_id = ANY($1)',
        [clientIds]
      );
      const nicknames: Record<string, string> = {};
      for (const row of result.rows) {
        nicknames[row.client_id] = row.nickname;
      }
      return nicknames;
    } catch (error) {
      this.logger.error('Error reading PostgreSQL client nicknames', { error });
      return {};
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
        SET name = $3, room_version = room_version + 1, updated_at = NOW()
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
    let orphanedObjectKeys: string[] = [];
    try {
      await this.transaction(async client => {
        // Only the owner may delete; gate the media cleanup on the same check so
        // we never strand objects for a room that wasn't actually removed.
        const owned = await client.query(
          'SELECT 1 FROM rooms WHERE id = $1 AND creator_id = $2',
          [roomId, creatorId]
        );
        if (owned.rows.length === 0) {
          return;
        }

        // Capture keys before deleting the room: the media_assets rows cascade
        // away with it, so we cannot read them afterward.
        const orphaned = await client.query<{ object_key: string }>(
          'DELETE FROM media_assets WHERE room_id = $1 RETURNING object_key',
          [roomId]
        );
        orphanedObjectKeys = orphaned.rows.map(row => row.object_key);

        await client.query('DELETE FROM rooms WHERE id = $1 AND creator_id = $2', [roomId, creatorId]);
      });

      await this.deleteOrphanedMediaObjects(orphanedObjectKeys);
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
    await this.pool.query('TRUNCATE room_ai_cost_totals, audio_transcriptions, pending_media_uploads, media_assets, image_assets, room_messages, room_saves, room_members, rooms, client_profiles RESTART IDENTITY CASCADE');
  }

  async failInterruptedStreamingMessages(content: string, options: InterruptedStreamingMessageRecoveryOptions = {}): Promise<number> {
    try {
      const result = await this.pool.query(
        `UPDATE room_messages
        SET status = 'error',
          content = $1,
          timestamp = NOW()
        WHERE status = 'streaming'
          AND ($2::text IS NULL OR ai_stream_owner_id = $2)`,
        [content, options.aiStreamOwnerId || null]
      );
      const updatedCount = result.rowCount || 0;
      if (updatedCount > 0) {
        this.logger.warn('Marked interrupted PostgreSQL streaming messages as error', { count: updatedCount, aiStreamOwnerId: options.aiStreamOwnerId });
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
        message_version = message_version + $3,
        room_version = room_version + 1, updated_at = NOW()
      WHERE id = $1
      RETURNING ${ROOM_COLUMNS}`,
      [roomId, lastActivityAt, incrementMessageVersion ? 1 : 0]
    );
    return updatedRoom.rows[0] ? mapRoom(updatedRoom.rows[0]) : null;
  }

  private async saveMediaAssetWithClient(client: Pick<PostgresPool, 'query'>, asset: MediaAsset): Promise<MediaAsset | null> {
    const result = await client.query<MediaAssetRow>(
      `INSERT INTO media_assets (
        id,
        room_id,
        message_id,
        object_key,
        kind,
        mime_type,
        byte_size,
        filename,
        width,
        height,
        duration_ms,
        uploaded_by_client_id,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (id) DO UPDATE SET
        message_id = EXCLUDED.message_id,
        object_key = EXCLUDED.object_key,
        kind = EXCLUDED.kind,
        mime_type = EXCLUDED.mime_type,
        byte_size = EXCLUDED.byte_size,
        filename = EXCLUDED.filename,
        width = EXCLUDED.width,
        height = EXCLUDED.height,
        duration_ms = EXCLUDED.duration_ms,
        uploaded_by_client_id = EXCLUDED.uploaded_by_client_id
      RETURNING ${MEDIA_ASSET_COLUMNS}`,
      [
        asset.id,
        asset.roomId,
        asset.messageId || null,
        asset.objectKey,
        asset.kind,
        asset.mimeType,
        asset.byteSize,
        asset.filename || null,
        asset.width ?? null,
        asset.height ?? null,
        asset.durationMs ?? null,
        asset.uploadedByClientId || null,
        asset.createdAt,
      ]
    );
    return result.rows[0] ? mapMediaAsset(result.rows[0]) : null;
  }

  private async attachMediaAssets(roomId: string, messages: Message[]): Promise<Message[]> {
    if (!messages.some(message => message.messageType === 'media')) {
      return messages;
    }

    const assets = await this.readMediaAssetsByRoom(roomId);
    if (assets.length === 0) {
      return messages;
    }

    return this.attachMediaAssetsFromAssets(messages, assets);
  }

  private attachMediaAssetsFromAssets(messages: Message[], assets: MediaAsset[]): Message[] {
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
        mimeType: asset.mimeType,
        mediaAsset: toMessageMediaAsset(asset),
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
    if (!messages.some(message => message.messageType === 'media')) {
      return messages;
    }

    const assets = await client.query<MediaAssetRow>(
      `SELECT ${MEDIA_ASSET_COLUMNS}
      FROM media_assets
      WHERE room_id = $1
      ORDER BY created_at ASC`,
      [roomId]
    );
    return this.attachMediaAssetsFromAssets(messages, assets.rows.map(mapMediaAsset));
  }
}
