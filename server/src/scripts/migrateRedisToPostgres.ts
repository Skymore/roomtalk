import dotenv from 'dotenv';
import { createClient, RedisClientType } from 'redis';
import { Logger } from '../logger';
import { RedisStore } from '../repositories/redisStore';
import { createPostgresPool } from '../repositories/postgresPool';
import { PostgresPool, PostgresStore } from '../repositories/postgresStore';
import { Message, Room, RoomAICostTotal } from '../types';

dotenv.config();

type MigrationLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

export interface RedisToPostgresMigrationSource {
  readRooms(): Promise<Room[]>;
  readMessagesByRoom(roomId: string): Promise<Message[]>;
  readRoomAICost(roomId: string): Promise<RoomAICostTotal>;
}

export interface RedisToPostgresMigrationTarget {
  saveRoom(room: Room): Promise<Room | null>;
  saveMessageHistory(roomId: string, messages: Message[]): Promise<Room | null>;
  setRoomAICostTotal(roomId: string, totalUsd: number): Promise<RoomAICostTotal>;
}

export interface RedisToPostgresMigrationFailure {
  roomId?: string;
  stage: 'read_rooms' | 'read_room_data' | 'save_room' | 'save_messages' | 'set_cost';
  error: string;
}

export interface RedisToPostgresMigrationStats {
  dryRun: boolean;
  roomsRead: number;
  roomsWritten: number;
  roomsFailed: number;
  messagesRead: number;
  messagesWritten: number;
  costsRead: number;
  costsWritten: number;
  failures: RedisToPostgresMigrationFailure[];
}

export interface RedisToPostgresMigrationOptions {
  source: RedisToPostgresMigrationSource;
  target?: RedisToPostgresMigrationTarget;
  dryRun?: boolean;
  logger?: MigrationLogger;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const createEmptyStats = (dryRun: boolean): RedisToPostgresMigrationStats => ({
  dryRun,
  roomsRead: 0,
  roomsWritten: 0,
  roomsFailed: 0,
  messagesRead: 0,
  messagesWritten: 0,
  costsRead: 0,
  costsWritten: 0,
  failures: [],
});

export async function migrateRedisToPostgres({
  source,
  target,
  dryRun = false,
  logger,
}: RedisToPostgresMigrationOptions): Promise<RedisToPostgresMigrationStats> {
  if (!dryRun && !target) {
    throw new Error('Redis to PostgreSQL migration requires a target unless dryRun is enabled');
  }

  const stats = createEmptyStats(dryRun);
  let rooms: Room[];

  try {
    rooms = await source.readRooms();
  } catch (error) {
    stats.failures.push({ stage: 'read_rooms', error: errorMessage(error) });
    logger?.error('Failed to read Redis rooms for migration', { error });
    return stats;
  }

  stats.roomsRead = rooms.length;
  logger?.info('Read Redis rooms for migration', { count: rooms.length, dryRun });

  for (const room of rooms) {
    let messages: Message[];
    let roomCost: RoomAICostTotal;

    try {
      messages = await source.readMessagesByRoom(room.id);
      roomCost = await source.readRoomAICost(room.id);
    } catch (error) {
      stats.roomsFailed++;
      stats.failures.push({ roomId: room.id, stage: 'read_room_data', error: errorMessage(error) });
      logger?.error('Failed to read Redis room data for migration', { error, roomId: room.id });
      continue;
    }

    stats.messagesRead += messages.length;
    stats.costsRead++;

    if (dryRun) {
      continue;
    }

    const migrationTarget = target!;
    let savedRoom: Room | null;
    try {
      savedRoom = await migrationTarget.saveRoom(room);
    } catch (error) {
      stats.roomsFailed++;
      stats.failures.push({ roomId: room.id, stage: 'save_room', error: errorMessage(error) });
      logger?.error('Failed to save PostgreSQL room during migration', { error, roomId: room.id });
      continue;
    }

    if (!savedRoom) {
      stats.roomsFailed++;
      stats.failures.push({ roomId: room.id, stage: 'save_room', error: 'Target rejected room save' });
      logger?.error('Failed to save PostgreSQL room during migration', { roomId: room.id });
      continue;
    }

    let savedMessages: Room | null;
    try {
      savedMessages = await migrationTarget.saveMessageHistory(room.id, messages);
    } catch (error) {
      stats.roomsFailed++;
      stats.failures.push({ roomId: room.id, stage: 'save_messages', error: errorMessage(error) });
      logger?.error('Failed to save PostgreSQL room messages during migration', { error, roomId: room.id, count: messages.length });
      continue;
    }

    if (!savedMessages) {
      stats.roomsFailed++;
      stats.failures.push({ roomId: room.id, stage: 'save_messages', error: 'Target rejected message history save' });
      logger?.error('Failed to save PostgreSQL room messages during migration', { roomId: room.id, count: messages.length });
      continue;
    }

    try {
      await migrationTarget.setRoomAICostTotal(room.id, roomCost.totalUsd);
    } catch (error) {
      stats.roomsFailed++;
      stats.failures.push({ roomId: room.id, stage: 'set_cost', error: errorMessage(error) });
      logger?.error('Failed to set PostgreSQL room AI cost during migration', { error, roomId: room.id, totalUsd: roomCost.totalUsd });
      continue;
    }

    stats.roomsWritten++;
    stats.messagesWritten += messages.length;
    stats.costsWritten++;
  }

  return stats;
}

export class RedisMigrationSource implements RedisToPostgresMigrationSource {
  constructor(
    private readonly redisClient: RedisClientType,
    private readonly redisStore: RedisStore,
    private readonly logger: MigrationLogger
  ) {}

  async readRooms(): Promise<Room[]> {
    const roomIds = await this.redisClient.hKeys('rooms');
    const rooms = await Promise.all(
      roomIds.map(async roomId => {
        const roomJson = await this.redisClient.hGet('rooms', roomId);
        if (!roomJson) {
          return null;
        }

        try {
          return JSON.parse(roomJson) as Room;
        } catch (error) {
          this.logger.warn('Skipping Redis room with invalid JSON during migration', { error, roomId });
          return null;
        }
      })
    );

    return rooms.filter((room): room is Room => Boolean(room));
  }

  readMessagesByRoom(roomId: string): Promise<Message[]> {
    return this.redisStore.readMessagesByRoom(roomId);
  }

  readRoomAICost(roomId: string): Promise<RoomAICostTotal> {
    return this.redisStore.readRoomAICost(roomId);
  }
}

const hasArg = (name: string) => process.argv.slice(2).includes(name);

async function main() {
  const logger = new Logger('RedisToPostgresMigration');
  const dryRun = hasArg('--dry-run');
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const databaseUrl = process.env.DATABASE_URL;

  if (!dryRun && !databaseUrl) {
    throw new Error('DATABASE_URL is required unless --dry-run is used');
  }

  const redisClient: RedisClientType = createClient({ url: redisUrl });
  const redisStore = new RedisStore(redisClient, logger);
  let postgresPool: PostgresPool | undefined;
  let postgresStore: PostgresStore | undefined;

  await redisClient.connect();
  try {
    if (!dryRun) {
      postgresPool = createPostgresPool(databaseUrl!, logger);
      postgresStore = new PostgresStore(postgresPool, logger);
      await postgresStore.initializeSchema();
    }

    const stats = await migrateRedisToPostgres({
      source: new RedisMigrationSource(redisClient, redisStore, logger),
      target: postgresStore,
      dryRun,
      logger,
    });

    logger.info('Redis to PostgreSQL migration finished', stats);
    if (stats.failures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await redisClient.quit();
    await postgresPool?.end?.();
  }
}

if (require.main === module) {
  main().catch(error => {
    const logger = new Logger('RedisToPostgresMigration');
    logger.error('Redis to PostgreSQL migration failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  });
}
