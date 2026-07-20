import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../logger';
import { createPostgresPool } from '../repositories/postgresPool';
import { PostgresPool, PostgresStore } from '../repositories/postgresStore';
import { MessageUpdateResult } from '../repositories/store';
import { createMediaObjectStorageFromEnv, MediaObjectStorage } from '../services/mediaObjectStorage';
import { MediaAsset, Message, Room, RoomCodeAgentStatus, RoomSandboxStatus, RoomType } from '../types';

dotenv.config();

type MigrationLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

type RoomRow = {
  id: string;
  name: string;
  description: string | null;
  created_at: string | Date;
  last_activity_at: string | Date;
  creator_id: string;
  password_hash?: string | null;
  posting_schedule?: unknown;
  type?: RoomType | null;
  sandbox_id?: string | null;
  sandbox_status?: RoomSandboxStatus | null;
  sandbox_updated_at?: string | Date | null;
  code_agent_session_id?: string | null;
  code_agent_status?: RoomCodeAgentStatus | null;
  updated_at?: string | Date | null;
};

export interface LegacyMediaMigrationSource {
  readRooms(): Promise<Room[]>;
  readMessagesByRoom(roomId: string): Promise<Message[]>;
  getMediaAssetByMessageId?(messageId: string): Promise<MediaAsset | null>;
}

export interface LegacyMediaMigrationTarget {
  replaceMessageMediaAsset(roomId: string, messageId: string, asset: MediaAsset): Promise<MessageUpdateResult | null>;
}

export interface LegacyImageConversion {
  body: Buffer;
  mimeType: 'image/webp';
  byteSize: number;
  width?: number;
  height?: number;
}

export interface LegacyMediaMigrationFailure {
  roomId: string;
  messageId?: string;
  stage: 'read_messages' | 'decode' | 'convert' | 'upload' | 'replace' | 'cleanup';
  error: string;
}

export interface LegacyMediaMigrationStats {
  dryRun: boolean;
  roomsRead: number;
  messagesRead: number;
  legacyImagesFound: number;
  skippedAlreadyAssetBacked: number;
  converted: number;
  uploaded: number;
  replaced: number;
  failed: number;
  failures: LegacyMediaMigrationFailure[];
}

export interface LegacyMediaMigrationOptions {
  source: LegacyMediaMigrationSource;
  storage?: Pick<MediaObjectStorage, 'putMediaObject' | 'deleteMediaObject'>;
  target?: LegacyMediaMigrationTarget;
  dryRun?: boolean;
  convertImage?: (input: Buffer, sourceMimeType: string) => Promise<LegacyImageConversion>;
  idFactory?: () => string;
  logger?: MigrationLogger;
}

type ParsedDataUrl = {
  mimeType: string;
  body: Buffer;
};

const ROOM_COLUMNS = 'id, name, description, created_at, last_activity_at, creator_id, password_hash, posting_schedule, type, sandbox_id, sandbox_status, sandbox_updated_at, code_agent_session_id, code_agent_status, updated_at';

const LEGACY_IMAGE_DATA_URL_RE = /^data:(image\/[A-Za-z0-9.+-]+);base64,([\s\S]+)$/;

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const createEmptyStats = (dryRun: boolean): LegacyMediaMigrationStats => ({
  dryRun,
  roomsRead: 0,
  messagesRead: 0,
  legacyImagesFound: 0,
  skippedAlreadyAssetBacked: 0,
  converted: 0,
  uploaded: 0,
  replaced: 0,
  failed: 0,
  failures: [],
});

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

const mapRoom = (row: RoomRow): Room => {
  const room: Room = {
    id: row.id,
    name: row.name,
    description: row.description || '',
    createdAt: toIsoString(row.created_at),
    lastActivityAt: toIsoString(row.last_activity_at || row.created_at),
    creatorId: row.creator_id,
  };
  if (row.password_hash) room.hasPassword = true;
  const postingSchedule = parseJsonValue<Room['postingSchedule']>(row.posting_schedule);
  if (postingSchedule) room.postingSchedule = postingSchedule;
  if (row.type && row.type !== 'chat') room.type = row.type;
  if (row.sandbox_id) room.sandboxId = row.sandbox_id;
  if (row.sandbox_status) room.sandboxStatus = row.sandbox_status;
  if (row.sandbox_updated_at) room.sandboxUpdatedAt = toIsoString(row.sandbox_updated_at);
  if (row.code_agent_session_id) room.codeAgentSessionId = row.code_agent_session_id;
  if (row.code_agent_status) room.codeAgentStatus = row.code_agent_status;
  if (row.updated_at) room.updatedAt = toIsoString(row.updated_at);
  return room;
};

export const buildMediaObjectKey = (roomId: string, assetId: string) => (
  `rooms/${roomId}/media/image/${assetId}`
);

export const parseLegacyImageDataUrl = (content: string): ParsedDataUrl | null => {
  const match = content.match(LEGACY_IMAGE_DATA_URL_RE);
  if (!match) {
    return null;
  }

  const mimeType = match[1].toLowerCase();
  const encoded = match[2].replace(/\s+/g, '');
  if (!encoded) {
    return null;
  }

  const body = Buffer.from(encoded, 'base64');
  if (body.length === 0) {
    return null;
  }

  return { mimeType, body };
};

export const convertLegacyImageToWebP = async (input: Buffer): Promise<LegacyImageConversion> => {
  const { data, info } = await sharp(input, { animated: false })
    .rotate()
    .webp({ lossless: true })
    .toBuffer({ resolveWithObject: true });

  return {
    body: data,
    mimeType: 'image/webp',
    byteSize: data.length,
    width: info.width,
    height: info.height,
  };
};

const hasExistingAsset = async (source: LegacyMediaMigrationSource, message: Message) => {
  if (message.mediaAsset) {
    return true;
  }

  if (!source.getMediaAssetByMessageId) {
    return false;
  }

  return Boolean(await source.getMediaAssetByMessageId(message.id));
};

export async function migrateLegacyMediaMessagesToObjectStorage({
  source,
  storage,
  target,
  dryRun = true,
  convertImage = convertLegacyImageToWebP,
  idFactory = uuidv4,
  logger,
}: LegacyMediaMigrationOptions): Promise<LegacyMediaMigrationStats> {
  if (!dryRun && (!storage || !target)) {
    throw new Error('Legacy media migration requires storage and target in execute mode');
  }

  const stats = createEmptyStats(dryRun);
  const rooms = await source.readRooms();
  stats.roomsRead = rooms.length;
  logger?.info('Read rooms for legacy media migration', { count: rooms.length, dryRun });

  for (const room of rooms) {
    let messages: Message[];
    try {
      messages = await source.readMessagesByRoom(room.id);
    } catch (error) {
      stats.failed++;
      stats.failures.push({ roomId: room.id, stage: 'read_messages', error: errorMessage(error) });
      logger?.error('Failed to read room messages for legacy media migration', { error, roomId: room.id });
      continue;
    }

    stats.messagesRead += messages.length;

    for (const message of messages) {
      if (message.messageType !== 'media') {
        continue;
      }

      if (await hasExistingAsset(source, message)) {
        stats.skippedAlreadyAssetBacked++;
        continue;
      }

      const parsed = parseLegacyImageDataUrl(message.content);
      if (!parsed) {
        continue;
      }

      stats.legacyImagesFound++;
      let converted: LegacyImageConversion;
      try {
        converted = await convertImage(parsed.body, parsed.mimeType);
      } catch (error) {
        stats.failed++;
        stats.failures.push({ roomId: room.id, messageId: message.id, stage: 'convert', error: errorMessage(error) });
        logger?.error('Failed to convert legacy image during media migration', { error, roomId: room.id, messageId: message.id });
        continue;
      }
      stats.converted++;

      if (dryRun) {
        continue;
      }

      const assetId = idFactory();
      const objectKey = buildMediaObjectKey(room.id, assetId);
      const asset: MediaAsset = {
        id: assetId,
        roomId: room.id,
        messageId: message.id,
        objectKey,
        kind: 'image',
        mimeType: converted.mimeType,
        byteSize: converted.byteSize,
        uploadedByClientId: message.clientId,
        createdAt: message.timestamp,
      };
      if (converted.width !== undefined) asset.width = converted.width;
      if (converted.height !== undefined) asset.height = converted.height;

      try {
        await storage!.putMediaObject({
          objectKey,
          body: converted.body,
          mimeType: converted.mimeType,
          byteSize: converted.byteSize,
        });
      } catch (error) {
        stats.failed++;
        stats.failures.push({ roomId: room.id, messageId: message.id, stage: 'upload', error: errorMessage(error) });
        logger?.error('Failed to upload converted legacy image during media migration', { error, roomId: room.id, messageId: message.id, objectKey });
        continue;
      }
      stats.uploaded++;

      try {
        const result = await target!.replaceMessageMediaAsset(room.id, message.id, asset);
        if (!result?.found) {
          throw new Error(result ? 'Target message was not found or was not a media message' : 'Target rejected media asset replacement');
        }
      } catch (error) {
        stats.failed++;
        stats.failures.push({ roomId: room.id, messageId: message.id, stage: 'replace', error: errorMessage(error) });
        logger?.error('Failed to replace legacy media message after upload', { error, roomId: room.id, messageId: message.id, objectKey });
        if (storage!.deleteMediaObject) {
          try {
            await storage!.deleteMediaObject(objectKey);
          } catch (cleanupError) {
            stats.failures.push({ roomId: room.id, messageId: message.id, stage: 'cleanup', error: errorMessage(cleanupError) });
            logger?.error('Failed to clean up uploaded object after replacement failure', { error: cleanupError, roomId: room.id, messageId: message.id, objectKey });
          }
        }
        continue;
      }

      stats.replaced++;
    }
  }

  return stats;
}

export class PostgresLegacyMediaMigrationSource implements LegacyMediaMigrationSource {
  constructor(
    private readonly pool: PostgresPool,
    private readonly store: PostgresStore,
    private readonly roomId?: string
  ) {}

  async readRooms(): Promise<Room[]> {
    if (this.roomId) {
      const room = await this.store.getRoomById(this.roomId);
      return room ? [room] : [];
    }

    const result = await this.pool.query<RoomRow>(
      `SELECT DISTINCT ${ROOM_COLUMNS.split(', ').map(column => `r.${column}`).join(', ')}
      FROM rooms r
      JOIN room_messages m ON m.room_id = r.id
      LEFT JOIN media_assets a ON a.message_id = m.id
      WHERE m.message_type = 'media'
        AND m.content LIKE 'data:image/%;base64,%'
        AND a.id IS NULL
      ORDER BY r.created_at ASC, r.id ASC`
    );
    return result.rows.map(mapRoom);
  }

  readMessagesByRoom(roomId: string): Promise<Message[]> {
    return this.store.readMessagesByRoom(roomId);
  }

  getMediaAssetByMessageId(messageId: string): Promise<MediaAsset | null> {
    return this.store.getMediaAssetByMessageId(messageId);
  }
}

type CliOptions = {
  execute: boolean;
  roomId?: string;
  backupFile?: string;
  help: boolean;
};

const readOptionValue = (args: string[], name: string): string | undefined => {
  const prefix = `${name}=`;
  const inline = args.find(arg => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

export const parseCliOptions = (args: string[]): CliOptions => ({
  help: args.includes('--help') || args.includes('-h'),
  execute: args.includes('--execute'),
  roomId: readOptionValue(args, '--room-id'),
  backupFile: readOptionValue(args, '--backup-file') || process.env.ROOMTALK_DB_BACKUP_FILE,
});

export const isServingFlyAppVm = (env: NodeJS.ProcessEnv = process.env) => (
  Boolean(env.FLY_APP_NAME || env.FLY_MACHINE_ID || env.FLY_ALLOC_ID) &&
  env.ALLOW_FLY_APP_VM_IMAGE_MIGRATION !== 'true'
);

export const assertMayRunExecuteMigration = async (
  options: CliOptions,
  env: NodeJS.ProcessEnv = process.env
) => {
  if (!options.execute) {
    return;
  }

  if (isServingFlyAppVm(env)) {
    throw new Error('Refusing to run legacy media migration on a Fly app VM. Use a local workstation or set ALLOW_FLY_APP_VM_IMAGE_MIGRATION=true only on a dedicated migration machine.');
  }

  if (!options.backupFile) {
    throw new Error('Execute mode requires --backup-file or ROOMTALK_DB_BACKUP_FILE');
  }

  if (!path.isAbsolute(options.backupFile)) {
    throw new Error('Backup file path must be absolute');
  }

  const backupStats = await fs.stat(options.backupFile);
  if (!backupStats.isFile()) {
    throw new Error('Backup file path must point to a file');
  }
};

async function main() {
  const logger = new Logger('LegacyMediaMigration');
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`Usage: npm run migrate:media-to-object-storage -- [--execute] [--room-id=<ROOM_ID>] [--backup-file=<ABSOLUTE_BACKUP_FILE>]\n\nDefault mode is dry-run. Execute mode uploads converted WebP objects and replaces legacy base64 image message payloads with media asset metadata.\n`);
    return;
  }
  await assertMayRunExecuteMigration(options);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const storage = createMediaObjectStorageFromEnv(new Logger('LegacyMediaMigrationStorage'));
  if (options.execute && !storage.isConfigured()) {
    throw new Error('Media object storage must be configured in execute mode');
  }

  const pool = createPostgresPool(databaseUrl, logger);
  const store = new PostgresStore(pool, logger);

  try {
    await store.initializeSchema();
    const stats = await migrateLegacyMediaMessagesToObjectStorage({
      source: new PostgresLegacyMediaMigrationSource(pool, store, options.roomId),
      target: store,
      storage,
      dryRun: !options.execute,
      logger,
    });

    logger.info('Legacy media object-storage migration finished', stats);
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    if (stats.failures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end?.();
  }
}

if (require.main === module) {
  main().catch(error => {
    const logger = new Logger('LegacyMediaMigration');
    logger.error('Legacy media object-storage migration failed', {
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.stderr.write(`Legacy media object-storage migration failed: ${errorMessage(error)}\n`);
    process.exit(1);
  });
}
