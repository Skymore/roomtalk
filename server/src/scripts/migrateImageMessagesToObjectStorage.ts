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
sharp.cache(false);
sharp.concurrency(1);

type MigrationLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

export interface LegacyImageMigrationCursor {
  roomId: string;
  position: number;
}

export interface LegacyImageMigrationCandidate {
  message: Message;
  cursor: LegacyImageMigrationCursor;
}

export interface ReadLegacyImageMessagesOptions {
  roomId?: string;
  after?: LegacyImageMigrationCursor;
  limit: number;
}

export interface LegacyImageMigrationStore {
  readLegacyImageMessages(options: ReadLegacyImageMessagesOptions): Promise<LegacyImageMigrationCandidate[]>;
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
  batchSize?: number;
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

type LegacyImageMessageRow = {
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
  reply_to: unknown;
  position: number | string;
};

const SUPPORTED_LEGACY_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
]);
const DEFAULT_BATCH_SIZE = 1;

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

const normalizeBatchSize = (value: number | undefined) => value && value > 0 ? value : DEFAULT_BATCH_SIZE;

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

const mapLegacyImageMessage = (row: LegacyImageMessageRow): Message => {
  const message: Message = {
    id: row.id,
    clientId: row.client_id,
    content: row.content,
    roomId: row.room_id,
    timestamp: toIsoString(row.timestamp),
    messageType: row.message_type,
  };

  if (row.username) message.username = row.username;
  const avatar = parseJsonValue<Message['avatar']>(row.avatar);
  if (avatar) message.avatar = avatar;
  if (row.mime_type) message.mimeType = row.mime_type;
  if (row.status) message.status = row.status;
  const aiModel = parseJsonValue<Message['aiModel']>(row.ai_model);
  if (aiModel) message.aiModel = aiModel;
  const usage = parseJsonValue<Message['usage']>(row.usage);
  if (usage) message.usage = usage;
  const cost = parseJsonValue<Message['cost']>(row.cost);
  if (cost) message.cost = cost;
  const replyTo = parseJsonValue<Message['replyTo']>(row.reply_to);
  if (replyTo) message.replyTo = replyTo;

  return message;
};

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
  const output = await sharp(parsed.buffer)
    .webp({ lossless: true })
    .toBuffer({ resolveWithObject: true });
  const assetId = uuidv4();

  const asset: ImageAsset = {
    id: assetId,
    roomId: message.roomId,
    messageId: message.id,
    objectKey: `rooms/${message.roomId}/${assetId}.webp`,
    mimeType: 'image/webp',
    byteSize: output.data.length,
    width: output.info.width,
    height: output.info.height,
    createdAt: message.timestamp,
  };

  return { asset, body: output.data };
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
  batchSize,
  logger,
}: LegacyImageMigrationOptions): Promise<LegacyImageMigrationStats> {
  if (!dryRun && !imageObjectStorage.isConfigured()) {
    throw new Error('Image object storage is not configured');
  }

  const stats = createEmptyStats(dryRun);
  const scannedRoomIds = new Set<string>();
  const normalizedBatchSize = normalizeBatchSize(batchSize);
  let cursor: LegacyImageMigrationCursor | undefined;
  let scannedCandidates = 0;

  logger?.info('Scanning legacy image messages', { dryRun, roomId, limit, batchSize: normalizedBatchSize });

  while (!limit || scannedCandidates < limit) {
    const remaining = limit ? limit - scannedCandidates : normalizedBatchSize;
    const candidates = await store.readLegacyImageMessages({
      roomId,
      after: cursor,
      limit: Math.min(normalizedBatchSize, remaining),
    });

    if (candidates.length === 0) {
      break;
    }

    for (const candidate of candidates) {
      cursor = candidate.cursor;
      scannedCandidates++;
      const message = candidate.message;
      scannedRoomIds.add(message.roomId);
      stats.roomsScanned = scannedRoomIds.size;
      stats.messagesScanned++;

      if (message.imageAsset || await store.getImageAssetByMessageId(message.id)) {
        stats.skippedExistingAssets++;
        continue;
      }

      let parsed: ParsedImagePayload | null;
      try {
        parsed = parseLegacyImagePayload(message);
      } catch (error) {
        stats.failures.push({ roomId: message.roomId, messageId: message.id, stage: 'parse', error: errorMessage(error) });
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
        stats.failures.push({ roomId: message.roomId, messageId: message.id, stage: 'convert', error: errorMessage(error) });
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
        stats.failures.push({ roomId: message.roomId, messageId: message.id, stage: 'upload', error: errorMessage(error) });
        continue;
      }

      const result = await store.replaceMessageImageAsset(message.roomId, message.id, prepared.asset);
      if (!result?.found) {
        await deleteImageObjectBestEffort(imageObjectStorage, prepared.asset.objectKey, logger, {
          roomId: message.roomId,
          messageId: message.id,
          assetId: prepared.asset.id,
        });
        stats.failures.push({
          roomId: message.roomId,
          messageId: message.id,
          stage: 'replace',
          error: result ? 'Image message was not found during replacement' : 'Failed to replace image message payload',
        });
        continue;
      }

      stats.imagesMigrated++;
      logger?.info('Migrated legacy image message to object storage', {
        roomId: message.roomId,
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

  async readLegacyImageMessages(options: ReadLegacyImageMessagesOptions): Promise<LegacyImageMigrationCandidate[]> {
    const params: unknown[] = [];
    const where = [
      `m.message_type = 'image'`,
      `a.id IS NULL`,
    ];

    if (options.roomId) {
      params.push(options.roomId);
      where.push(`m.room_id = $${params.length}`);
    }

    if (options.after) {
      params.push(options.after.roomId);
      const roomParam = params.length;
      params.push(options.after.position);
      const positionParam = params.length;
      where.push(`(m.room_id > $${roomParam} OR (m.room_id = $${roomParam} AND m.position > $${positionParam}))`);
    }

    params.push(options.limit);
    const limitParam = params.length;

    const result = await this.pool.query<LegacyImageMessageRow>(
      `SELECT
        m.id,
        m.room_id,
        m.client_id,
        m.content,
        m.timestamp,
        m.message_type,
        m.username,
        m.avatar,
        m.mime_type,
        m.status,
        m.ai_model,
        m.usage,
        m.cost,
        m.reply_to,
        m.position
      FROM room_messages m
      LEFT JOIN image_assets a ON a.message_id = m.id OR a.id = m.content
      WHERE ${where.join(' AND ')}
      ORDER BY m.room_id ASC, m.position ASC
      LIMIT $${limitParam}`,
      params
    );

    return result.rows.map(row => ({
      message: mapLegacyImageMessage(row),
      cursor: {
        roomId: row.room_id,
        position: Number(row.position) || 0,
      },
    }));
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
  const batchSize = parsePositiveInteger(findArgValue('--batch-size'));
  const backupFile = findArgValue('--backup-file') || process.env.ROOMTALK_DB_BACKUP_FILE;
  const databaseUrl = process.env.DATABASE_URL;

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
      batchSize,
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
