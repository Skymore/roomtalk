import fs from 'fs';
import dotenv from 'dotenv';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../logger';
import { createPostgresPool } from '../repositories/postgresPool';
import { PostgresPool, PostgresStore } from '../repositories/postgresStore';
import { MessageUpdateResult } from '../repositories/store';
import { createImageObjectStorageFromEnv, ImageObjectStorage } from '../services/imageObjectStorage';
import { ImageAsset, Message } from '../types';

dotenv.config();

type MigrationLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

export interface LegacyImageMigrationStore {
  readRoomIdsWithImageMessages(roomId?: string): Promise<string[]>;
  readMessagesByRoom(roomId: string): Promise<Message[]>;
  getImageAssetByMessageId(messageId: string): Promise<ImageAsset | null>;
  replaceMessageImageAsset(roomId: string, messageId: string, asset: ImageAsset): Promise<MessageUpdateResult | null>;
}

export interface LegacyImageMigrationFailure {
  roomId: string;
  messageId: string;
  stage: 'parse' | 'convert' | 'upload' | 'replace' | 'rollback';
  error: string;
}

export interface LegacyImageMigrationStats {
  dryRun: boolean;
  roomsScanned: number;
  messagesScanned: number;
  legacyImagesFound: number;
  skippedExistingAssets: number;
  skippedUnsupportedImages: number;
  imagesMigrated: number;
  originalBytes: number;
  objectBytes: number;
  failures: LegacyImageMigrationFailure[];
}

export interface LegacyImageMigrationOptions {
  store: LegacyImageMigrationStore;
  imageObjectStorage: ImageObjectStorage;
  dryRun?: boolean;
  roomId?: string;
  limit?: number;
  logger?: MigrationLogger;
}

type ParsedImagePayload = {
  buffer: Buffer;
  mimeType: string;
};

type PreparedImageAsset = {
  asset: ImageAsset;
  body: Buffer;
};

const SUPPORTED_LEGACY_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const createEmptyStats = (dryRun: boolean): LegacyImageMigrationStats => ({
  dryRun,
  roomsScanned: 0,
  messagesScanned: 0,
  legacyImagesFound: 0,
  skippedExistingAssets: 0,
  skippedUnsupportedImages: 0,
  imagesMigrated: 0,
  originalBytes: 0,
  objectBytes: 0,
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
  if (!env.FLY_APP_NAME || env.ALLOW_FLY_APP_VM_IMAGE_MIGRATION === 'true') {
    return;
  }

  throw new Error('Do not run legacy image migration on the Fly app VM. Run it from a local workstation or a dedicated migration host, or set ALLOW_FLY_APP_VM_IMAGE_MIGRATION=true if you intentionally provisioned a non-serving migration environment.');
};

const parseLegacyImagePayload = (message: Message): ParsedImagePayload | null => {
  if (message.messageType !== 'image' || message.imageAsset) {
    return null;
  }

  const dataUrlMatch = message.content.match(/^data:([^;,]+);base64,(.+)$/s);
  const mimeType = (dataUrlMatch?.[1] || message.mimeType || 'image/png').toLowerCase();
  if (!SUPPORTED_LEGACY_MIME_TYPES.has(mimeType)) {
    return null;
  }

  const base64Payload = (dataUrlMatch?.[2] || message.content).replace(/\s/g, '');
  if (!base64Payload || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64Payload)) {
    throw new Error('Image content is not valid base64');
  }

  const buffer = Buffer.from(base64Payload, 'base64');
  if (buffer.length === 0) {
    throw new Error('Image content decoded to an empty buffer');
  }

  return { buffer, mimeType };
};

const prepareImageAsset = async (message: Message, parsed: ParsedImagePayload): Promise<PreparedImageAsset> => {
  const body = await sharp(parsed.buffer)
    .webp({ lossless: true })
    .toBuffer();
  const metadata = await sharp(body).metadata();
  const assetId = uuidv4();

  const asset: ImageAsset = {
    id: assetId,
    roomId: message.roomId,
    messageId: message.id,
    objectKey: `rooms/${message.roomId}/${assetId}.webp`,
    mimeType: 'image/webp',
    byteSize: body.length,
    width: metadata.width,
    height: metadata.height,
    createdAt: message.timestamp,
  };

  return { asset, body };
};

const deleteImageObjectBestEffort = async (
  imageObjectStorage: ImageObjectStorage,
  objectKey: string,
  logger: MigrationLogger | undefined,
  context: Record<string, unknown>,
) => {
  try {
    await imageObjectStorage.deleteImageObject?.(objectKey);
  } catch (error) {
    logger?.error('Failed to delete uploaded image object after migration failure', { error, objectKey, ...context });
  }
};

export async function migrateLegacyImageMessagesToObjectStorage({
  store,
  imageObjectStorage,
  dryRun = true,
  roomId,
  limit,
  logger,
}: LegacyImageMigrationOptions): Promise<LegacyImageMigrationStats> {
  if (!dryRun && !imageObjectStorage.isConfigured()) {
    throw new Error('Image object storage is not configured');
  }

  const stats = createEmptyStats(dryRun);
  const roomIds = await store.readRoomIdsWithImageMessages(roomId);
  stats.roomsScanned = roomIds.length;

  logger?.info('Scanning rooms for legacy image messages', { roomCount: roomIds.length, dryRun, roomId, limit });

  for (const scannedRoomId of roomIds) {
    const messages = await store.readMessagesByRoom(scannedRoomId);
    stats.messagesScanned += messages.length;

    for (const message of messages) {
      if (limit && stats.imagesMigrated + (dryRun ? stats.legacyImagesFound : 0) >= limit) {
        return stats;
      }

      if (message.messageType !== 'image') {
        continue;
      }

      if (message.imageAsset || await store.getImageAssetByMessageId(message.id)) {
        stats.skippedExistingAssets++;
        continue;
      }

      let parsed: ParsedImagePayload | null;
      try {
        parsed = parseLegacyImagePayload(message);
      } catch (error) {
        stats.failures.push({ roomId: scannedRoomId, messageId: message.id, stage: 'parse', error: errorMessage(error) });
        continue;
      }

      if (!parsed) {
        stats.skippedUnsupportedImages++;
        continue;
      }

      stats.legacyImagesFound++;
      stats.originalBytes += parsed.buffer.length;

      let prepared: PreparedImageAsset;
      try {
        prepared = await prepareImageAsset(message, parsed);
      } catch (error) {
        stats.failures.push({ roomId: scannedRoomId, messageId: message.id, stage: 'convert', error: errorMessage(error) });
        continue;
      }

      stats.objectBytes += prepared.body.length;
      if (dryRun) {
        continue;
      }

      try {
        await imageObjectStorage.putImageObject({
          objectKey: prepared.asset.objectKey,
          body: prepared.body,
          mimeType: prepared.asset.mimeType,
          byteSize: prepared.asset.byteSize,
        });
      } catch (error) {
        stats.failures.push({ roomId: scannedRoomId, messageId: message.id, stage: 'upload', error: errorMessage(error) });
        continue;
      }

      const result = await store.replaceMessageImageAsset(scannedRoomId, message.id, prepared.asset);
      if (!result?.found) {
        await deleteImageObjectBestEffort(imageObjectStorage, prepared.asset.objectKey, logger, {
          roomId: scannedRoomId,
          messageId: message.id,
          assetId: prepared.asset.id,
        });
        stats.failures.push({
          roomId: scannedRoomId,
          messageId: message.id,
          stage: 'replace',
          error: result ? 'Image message was not found during replacement' : 'Failed to replace image message payload',
        });
        continue;
      }

      stats.imagesMigrated++;
      logger?.info('Migrated legacy image message to object storage', {
        roomId: scannedRoomId,
        messageId: message.id,
        assetId: prepared.asset.id,
        originalBytes: parsed.buffer.length,
        objectBytes: prepared.body.length,
      });
    }
  }

  return stats;
}

export class PostgresLegacyImageMigrationStore implements LegacyImageMigrationStore {
  constructor(
    private readonly pool: PostgresPool,
    private readonly store: PostgresStore,
  ) {}

  async readRoomIdsWithImageMessages(roomId?: string): Promise<string[]> {
    const params = roomId ? [roomId] : [];
    const result = await this.pool.query<{ room_id: string }>(
      `SELECT DISTINCT room_id
      FROM room_messages
      WHERE message_type = 'image'
      ${roomId ? 'AND room_id = $1' : ''}
      ORDER BY room_id ASC`,
      params
    );
    return result.rows.map(row => row.room_id);
  }

  readMessagesByRoom(roomId: string): Promise<Message[]> {
    return this.store.readMessagesByRoom(roomId);
  }

  getImageAssetByMessageId(messageId: string): Promise<ImageAsset | null> {
    return this.store.getImageAssetByMessageId(messageId);
  }

  replaceMessageImageAsset(roomId: string, messageId: string, asset: ImageAsset): Promise<MessageUpdateResult | null> {
    return this.store.replaceMessageImageAsset(roomId, messageId, asset);
  }
}

async function main() {
  const logger = new Logger('ImageMessageMigration');
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
  const imageObjectStorage = createImageObjectStorageFromEnv(logger);

  try {
    await postgresStore.initializeSchema();
    const stats = await migrateLegacyImageMessagesToObjectStorage({
      store: new PostgresLegacyImageMigrationStore(pool, postgresStore),
      imageObjectStorage,
      dryRun,
      roomId,
      limit,
      logger,
    });

    logger.info('Legacy image message migration finished', stats);
    if (stats.failures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end?.();
  }
}

if (require.main === module) {
  main().catch(error => {
    const logger = new Logger('ImageMessageMigration');
    logger.error('Legacy image message migration failed', {
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  });
}
