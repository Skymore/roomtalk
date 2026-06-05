import fs from 'fs';
import dotenv from 'dotenv';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../logger';
import { createPostgresPool } from '../repositories/postgresPool';
import { PostgresPool, PostgresStore } from '../repositories/postgresStore';
import { MessageUpdateResult } from '../repositories/store';
import { createMediaObjectStorageFromEnv, MediaObjectStorage } from '../services/mediaObjectStorage';
import { MediaAsset, MediaKind, Message } from '../types';

dotenv.config();

type MigrationLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

type LegacyImageAssetRecord = {
  id: string;
  roomId: string;
  messageId?: string;
  objectKey: string;
  mimeType: string;
  byteSize: number;
  width?: number;
  height?: number;
  createdAt: string;
};

export interface LegacyMediaMigrationStore {
  readRoomIdsWithLegacyMediaMessages(roomId?: string): Promise<string[]>;
  readMessagesByRoom(roomId: string): Promise<Message[]>;
  readLegacyImageAssetsByRoom(roomId: string): Promise<LegacyImageAssetRecord[]>;
  getMediaAssetByMessageId(messageId: string): Promise<MediaAsset | null>;
  replaceMessageMediaAsset(roomId: string, messageId: string, asset: MediaAsset): Promise<MessageUpdateResult | null>;
}

export interface LegacyMediaMigrationFailure {
  roomId: string;
  messageId: string;
  stage: 'parse' | 'convert' | 'upload' | 'replace' | 'rollback' | 'verify';
  error: string;
}

export interface LegacyMediaMigrationStats {
  dryRun: boolean;
  roomsScanned: number;
  messagesScanned: number;
  legacyImageMessagesFound: number;
  legacyAudioMessagesFound: number;
  existingImageAssetsFound: number;
  skippedExistingMediaAssets: number;
  skippedUnsupportedMedia: number;
  mediaMigrated: number;
  uploadBytesEstimated: number;
  uploadBytesCompleted: number;
  unableToParseMessageIds: string[];
  failures: LegacyMediaMigrationFailure[];
}

export interface LegacyMediaMigrationOptions {
  store: LegacyMediaMigrationStore;
  mediaObjectStorage: MediaObjectStorage;
  dryRun?: boolean;
  roomId?: string;
  limit?: number;
  logger?: MigrationLogger;
}

type ParsedMediaPayload = {
  kind: MediaKind;
  buffer: Buffer;
  mimeType: string;
};

type PreparedMediaAsset = {
  asset: MediaAsset;
  body?: Buffer;
};

const SUPPORTED_LEGACY_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const createEmptyStats = (dryRun: boolean): LegacyMediaMigrationStats => ({
  dryRun,
  roomsScanned: 0,
  messagesScanned: 0,
  legacyImageMessagesFound: 0,
  legacyAudioMessagesFound: 0,
  existingImageAssetsFound: 0,
  skippedExistingMediaAssets: 0,
  skippedUnsupportedMedia: 0,
  mediaMigrated: 0,
  uploadBytesEstimated: 0,
  uploadBytesCompleted: 0,
  unableToParseMessageIds: [],
  failures: [],
});

const parsePositiveInteger = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const findArgValue = (name: string): string | undefined => {
  const prefix = `${name}=`;
  const arg = process.argv.slice(2).find(item => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
};

const hasArg = (name: string) => process.argv.slice(2).includes(name);

export const assertBackupBeforeExecute = (dryRun: boolean, backupFile?: string) => {
  if (dryRun) {
    return;
  }

  if (!backupFile) {
    throw new Error('A verified database backup is required for --execute. Pass --backup-file=/path/to/pg_dump.dump or set ROOMTALK_DB_BACKUP_FILE.');
  }

  const stat = fs.statSync(backupFile);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Backup file is empty or invalid: ${backupFile}`);
  }
};

export const assertMigrationHost = (env: NodeJS.ProcessEnv = process.env) => {
  if (!env.FLY_APP_NAME || env.ALLOW_FLY_APP_VM_MEDIA_MIGRATION === 'true') {
    return;
  }

  throw new Error('Do not run legacy media migration on the Fly app VM. Run it from a local workstation or a dedicated migration host, or set ALLOW_FLY_APP_VM_MEDIA_MIGRATION=true if this is an intentional non-serving migration environment.');
};

const parseBase64Payload = (content: string, fallbackMimeType: string) => {
  // The media type may carry parameters (e.g. `data:audio/webm;codecs=opus;base64,...`),
  // so capture everything up to `;base64,` and strip parameters off the MIME type.
  const dataUrlMatch = content.match(/^data:([^,]*?);base64,(.+)$/s);
  const rawMimeType = dataUrlMatch?.[1] || fallbackMimeType;
  const mimeType = rawMimeType.split(';')[0].trim().toLowerCase();
  const base64Payload = (dataUrlMatch?.[2] || content).replace(/\s/g, '');
  if (!base64Payload || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64Payload)) {
    throw new Error('Media content is not valid base64');
  }

  const buffer = Buffer.from(base64Payload, 'base64');
  if (buffer.length === 0) {
    throw new Error('Media content decoded to an empty buffer');
  }

  return { buffer, mimeType };
};

const parseLegacyMediaPayload = (message: Message): ParsedMediaPayload | null => {
  if (message.messageType === 'image') {
    const parsed = parseBase64Payload(message.content, message.mimeType || 'image/png');
    if (!SUPPORTED_LEGACY_IMAGE_MIME_TYPES.has(parsed.mimeType)) {
      return null;
    }
    return { kind: 'image', buffer: parsed.buffer, mimeType: parsed.mimeType };
  }

  if (message.messageType === 'voice') {
    const parsed = parseBase64Payload(message.content, message.mimeType || 'audio/webm');
    if (!parsed.mimeType.startsWith('audio/')) {
      return null;
    }
    return { kind: 'audio', buffer: parsed.buffer, mimeType: parsed.mimeType };
  }

  return null;
};

const prepareMediaAssetFromPayload = async (message: Message, parsed: ParsedMediaPayload): Promise<PreparedMediaAsset> => {
  const assetId = uuidv4();

  if (parsed.kind === 'image') {
    const body = await sharp(parsed.buffer)
      .webp({ lossless: true })
      .toBuffer();
    const metadata = await sharp(body).metadata();
    return {
      body,
      asset: {
        id: assetId,
        roomId: message.roomId,
        messageId: message.id,
        objectKey: `rooms/${message.roomId}/media/image/${assetId}`,
        kind: 'image',
        mimeType: 'image/webp',
        byteSize: body.length,
        width: metadata.width,
        height: metadata.height,
        createdAt: message.timestamp,
        uploadedByClientId: message.clientId,
      },
    };
  }

  return {
    body: parsed.buffer,
    asset: {
      id: assetId,
      roomId: message.roomId,
      messageId: message.id,
      objectKey: `rooms/${message.roomId}/media/audio/${assetId}`,
      kind: 'audio',
      mimeType: parsed.mimeType,
      byteSize: parsed.buffer.length,
      createdAt: message.timestamp,
      uploadedByClientId: message.clientId,
    },
  };
};

const mediaAssetFromLegacyImageAsset = (message: Message, legacyAsset: LegacyImageAssetRecord): MediaAsset => ({
  id: legacyAsset.id,
  roomId: message.roomId,
  messageId: message.id,
  objectKey: legacyAsset.objectKey,
  kind: 'image',
  mimeType: legacyAsset.mimeType,
  byteSize: legacyAsset.byteSize,
  width: legacyAsset.width,
  height: legacyAsset.height,
  createdAt: legacyAsset.createdAt || message.timestamp,
  uploadedByClientId: message.clientId,
});

const deleteMediaObjectBestEffort = async (
  mediaObjectStorage: MediaObjectStorage,
  objectKey: string,
  logger: MigrationLogger | undefined,
  context: Record<string, unknown>,
) => {
  try {
    await mediaObjectStorage.deleteMediaObject?.(objectKey);
  } catch (error) {
    logger?.error('Failed to delete uploaded media object after migration failure', { error, objectKey, ...context });
  }
};

const replaceMessageWithMediaAsset = async (
  store: LegacyMediaMigrationStore,
  roomId: string,
  messageId: string,
  prepared: PreparedMediaAsset,
) => store.replaceMessageMediaAsset(roomId, messageId, prepared.asset);

export async function migrateLegacyMediaMessagesToObjectStorage({
  store,
  mediaObjectStorage,
  dryRun = true,
  roomId,
  limit,
  logger,
}: LegacyMediaMigrationOptions): Promise<LegacyMediaMigrationStats> {
  if (!dryRun && !mediaObjectStorage.isConfigured()) {
    throw new Error('Media object storage is not configured');
  }

  const stats = createEmptyStats(dryRun);
  const roomIds = await store.readRoomIdsWithLegacyMediaMessages(roomId);
  stats.roomsScanned = roomIds.length;

  logger?.info('Scanning rooms for legacy media messages', { roomCount: roomIds.length, dryRun, roomId, limit });

  for (const scannedRoomId of roomIds) {
    const messages = await store.readMessagesByRoom(scannedRoomId);
    const legacyImageAssets = await store.readLegacyImageAssetsByRoom(scannedRoomId);
    const legacyImageAssetsByMessageId = new Map(legacyImageAssets.filter(asset => asset.messageId).map(asset => [asset.messageId!, asset]));
    const legacyImageAssetsById = new Map(legacyImageAssets.map(asset => [asset.id, asset]));
    stats.messagesScanned += messages.length;

    for (const message of messages) {
      if (limit && stats.mediaMigrated + stats.legacyImageMessagesFound + stats.legacyAudioMessagesFound + stats.existingImageAssetsFound >= limit) {
        return stats;
      }

      if (message.messageType !== 'image' && message.messageType !== 'voice') {
        continue;
      }

      if (await store.getMediaAssetByMessageId(message.id)) {
        stats.skippedExistingMediaAssets++;
        continue;
      }

      let prepared: PreparedMediaAsset | null = null;
      const existingImageAsset = message.messageType === 'image'
        ? legacyImageAssetsByMessageId.get(message.id) || legacyImageAssetsById.get(message.content)
        : undefined;

      if (existingImageAsset) {
        stats.existingImageAssetsFound++;
        prepared = {
          asset: mediaAssetFromLegacyImageAsset(message, existingImageAsset),
        };
      } else {
        let parsed: ParsedMediaPayload | null;
        try {
          parsed = parseLegacyMediaPayload(message);
        } catch (error) {
          stats.unableToParseMessageIds.push(message.id);
          stats.failures.push({ roomId: scannedRoomId, messageId: message.id, stage: 'parse', error: errorMessage(error) });
          continue;
        }

        if (!parsed) {
          stats.skippedUnsupportedMedia++;
          continue;
        }

        if (parsed.kind === 'image') {
          stats.legacyImageMessagesFound++;
        } else {
          stats.legacyAudioMessagesFound++;
        }

        try {
          prepared = await prepareMediaAssetFromPayload(message, parsed);
        } catch (error) {
          stats.failures.push({ roomId: scannedRoomId, messageId: message.id, stage: 'convert', error: errorMessage(error) });
          continue;
        }

        stats.uploadBytesEstimated += prepared.body?.length || 0;
      }

      if (!prepared) {
        continue;
      }

      if (dryRun) {
        continue;
      }

      if (prepared.body) {
        try {
          await mediaObjectStorage.putMediaObject({
            objectKey: prepared.asset.objectKey,
            body: prepared.body,
            mimeType: prepared.asset.mimeType,
            byteSize: prepared.asset.byteSize,
          });
          stats.uploadBytesCompleted += prepared.body.length;
        } catch (error) {
          stats.failures.push({ roomId: scannedRoomId, messageId: message.id, stage: 'upload', error: errorMessage(error) });
          continue;
        }
      }

      try {
        await mediaObjectStorage.createReadUrl({ objectKey: prepared.asset.objectKey, expiresInSeconds: 60 });
      } catch (error) {
        if (prepared.body) {
          await deleteMediaObjectBestEffort(mediaObjectStorage, prepared.asset.objectKey, logger, {
            roomId: scannedRoomId,
            messageId: message.id,
            assetId: prepared.asset.id,
          });
        }
        stats.failures.push({ roomId: scannedRoomId, messageId: message.id, stage: 'verify', error: errorMessage(error) });
        continue;
      }

      const result = await replaceMessageWithMediaAsset(store, scannedRoomId, message.id, prepared);
      if (!result?.found) {
        if (prepared.body) {
          await deleteMediaObjectBestEffort(mediaObjectStorage, prepared.asset.objectKey, logger, {
            roomId: scannedRoomId,
            messageId: message.id,
            assetId: prepared.asset.id,
          });
        }
        stats.failures.push({
          roomId: scannedRoomId,
          messageId: message.id,
          stage: 'replace',
          error: result ? 'Media message was not found during replacement' : 'Failed to replace media message payload',
        });
        continue;
      }

      stats.mediaMigrated++;
      logger?.info('Migrated legacy media message to object storage', {
        roomId: scannedRoomId,
        messageId: message.id,
        assetId: prepared.asset.id,
        kind: prepared.asset.kind,
        byteSize: prepared.asset.byteSize,
        uploaded: !!prepared.body,
      });
    }
  }

  return stats;
}

const toIsoString = (value: string | Date): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
};

const optionalNumber = (value: number | string | null): number | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export class PostgresLegacyMediaMigrationStore implements LegacyMediaMigrationStore {
  constructor(
    private readonly pool: PostgresPool,
    private readonly store: PostgresStore,
  ) {}

  async readRoomIdsWithLegacyMediaMessages(roomId?: string): Promise<string[]> {
    const params = roomId ? [roomId] : [];
    const result = await this.pool.query<{ room_id: string }>(
      `SELECT DISTINCT room_id
      FROM room_messages
      WHERE message_type IN ('image', 'voice')
      ${roomId ? 'AND room_id = $1' : ''}
      ORDER BY room_id ASC`,
      params
    );
    return result.rows.map(row => row.room_id);
  }

  readMessagesByRoom(roomId: string): Promise<Message[]> {
    return this.store.readMessagesByRoom(roomId);
  }

  async readLegacyImageAssetsByRoom(roomId: string): Promise<LegacyImageAssetRecord[]> {
    const result = await this.pool.query<{
      id: string;
      room_id: string;
      message_id: string | null;
      object_key: string;
      mime_type: string;
      byte_size: number | string;
      width: number | string | null;
      height: number | string | null;
      created_at: string | Date;
    }>(
      `SELECT id, room_id, message_id, object_key, mime_type, byte_size, width, height, created_at
      FROM image_assets
      WHERE room_id = $1
      ORDER BY created_at ASC`,
      [roomId]
    );

    return result.rows.map(row => {
      const record: LegacyImageAssetRecord = {
        id: row.id,
        roomId: row.room_id,
        objectKey: row.object_key,
        mimeType: row.mime_type,
        byteSize: Number(row.byte_size) || 0,
        createdAt: toIsoString(row.created_at),
      };
      if (row.message_id) record.messageId = row.message_id;
      const width = optionalNumber(row.width);
      const height = optionalNumber(row.height);
      if (width !== undefined) record.width = width;
      if (height !== undefined) record.height = height;
      return record;
    });
  }

  getMediaAssetByMessageId(messageId: string): Promise<MediaAsset | null> {
    return this.store.getMediaAssetByMessageId(messageId);
  }

  replaceMessageMediaAsset(roomId: string, messageId: string, asset: MediaAsset): Promise<MessageUpdateResult | null> {
    return this.store.replaceMessageMediaAsset(roomId, messageId, asset);
  }
}

async function main() {
  const logger = new Logger('MediaMessageMigration');
  const execute = hasArg('--execute');
  const dryRun = !execute;
  const roomId = findArgValue('--room-id');
  const limit = parsePositiveInteger(findArgValue('--limit'));
  const backupFile = findArgValue('--backup-file') || process.env.ROOMTALK_DB_BACKUP_FILE;
  const databaseUrl = process.env.DATABASE_URL;

  assertMigrationHost();
  assertBackupBeforeExecute(dryRun, backupFile);

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = createPostgresPool(databaseUrl, logger);
  const postgresStore = new PostgresStore(pool, logger);
  const mediaObjectStorage = createMediaObjectStorageFromEnv(logger);

  try {
    await postgresStore.initializeSchema();
    const stats = await migrateLegacyMediaMessagesToObjectStorage({
      store: new PostgresLegacyMediaMigrationStore(pool, postgresStore),
      mediaObjectStorage,
      dryRun,
      roomId,
      limit,
      logger,
    });

    logger.info('Legacy media message migration finished', stats);
    if (stats.failures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end?.();
  }
}

if (require.main === module) {
  main().catch(error => {
    const logger = new Logger('MediaMessageMigration');
    logger.error('Legacy media message migration failed', {
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  });
}
