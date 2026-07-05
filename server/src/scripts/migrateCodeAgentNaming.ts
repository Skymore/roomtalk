import dotenv from 'dotenv';
import { createClient } from 'redis';
import { Logger } from '../logger';
import { createPostgresPool } from '../repositories/postgresPool';
import { PostgresPool } from '../repositories/postgresStore';

dotenv.config();

type MigrationTarget = 'postgres' | 'redis' | 'both';

interface MigrationStats {
  dryRun: boolean;
  postgresStatements: number;
  redisRoomsRead: number;
  redisRoomsChanged: number;
  redisMessagesRead: number;
  redisMessagesChanged: number;
}

interface RedisHashClient {
  hKeys(key: string): Promise<string[]>;
  hGet(key: string, field: string): Promise<string | null>;
  hSet(key: string, field: string, value: string): Promise<unknown>;
  lLen?(key: string): Promise<number>;
  lRange?(key: string, start: number, stop: number): Promise<string[]>;
  lSet?(key: string, index: number, value: string): Promise<unknown>;
  del?(key: string): Promise<unknown>;
  rPush?(key: string, values: string[]): Promise<unknown>;
}

const logger = new Logger('CodeAgentNamingMigration');
const REDIS_MESSAGE_BATCH_SIZE = 1;

const parseTarget = (value?: string): MigrationTarget => {
  const normalized = (value || 'both').trim().toLowerCase();
  if (normalized === 'postgres' || normalized === 'redis' || normalized === 'both') {
    return normalized;
  }
  throw new Error(`Unsupported CODE_AGENT_NAMING_MIGRATION_TARGET: ${value}`);
};

const shouldRunPostgres = (target: MigrationTarget) => target === 'postgres' || target === 'both';
const shouldRunRedis = (target: MigrationTarget) => target === 'redis' || target === 'both';

const POSTGRES_CODE_AGENT_NAMING_SQL = [
  `ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_type_check`,
  `ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_coco_status_check`,
  `ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_code_agent_status_check`,
  `ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_coco_access_check`,
  `ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_code_agent_access_check`,
  `DROP INDEX IF EXISTS idx_rooms_coco_recovery`,
  `DROP INDEX IF EXISTS idx_rooms_code_agent_recovery`,
  `DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'rooms' AND column_name = 'sandbox_coco_source_ref')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'rooms' AND column_name = 'sandbox_code_agent_source_ref') THEN
      ALTER TABLE rooms RENAME COLUMN sandbox_coco_source_ref TO sandbox_code_agent_source_ref;
    END IF;
  END $$`,
  `DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'rooms' AND column_name = 'coco_session_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'rooms' AND column_name = 'code_agent_session_id') THEN
      ALTER TABLE rooms RENAME COLUMN coco_session_id TO code_agent_session_id;
    END IF;
  END $$`,
  `DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'rooms' AND column_name = 'coco_status')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'rooms' AND column_name = 'code_agent_status') THEN
      ALTER TABLE rooms RENAME COLUMN coco_status TO code_agent_status;
    END IF;
  END $$`,
  `DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'rooms' AND column_name = 'coco_access')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'rooms' AND column_name = 'code_agent_access') THEN
      ALTER TABLE rooms RENAME COLUMN coco_access TO code_agent_access;
    END IF;
  END $$`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS sandbox_code_agent_source_ref TEXT`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS code_agent_session_id TEXT`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS code_agent_status TEXT`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS code_agent_access TEXT`,
  `DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'rooms' AND column_name = 'sandbox_coco_source_ref') THEN
      UPDATE rooms
        SET sandbox_code_agent_source_ref = COALESCE(sandbox_code_agent_source_ref, sandbox_coco_source_ref)
        WHERE sandbox_coco_source_ref IS NOT NULL;
      ALTER TABLE rooms DROP COLUMN sandbox_coco_source_ref;
    END IF;
  END $$`,
  `DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'rooms' AND column_name = 'coco_session_id') THEN
      UPDATE rooms
        SET code_agent_session_id = COALESCE(code_agent_session_id, coco_session_id)
        WHERE coco_session_id IS NOT NULL;
      ALTER TABLE rooms DROP COLUMN coco_session_id;
    END IF;
  END $$`,
  `DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'rooms' AND column_name = 'coco_status') THEN
      UPDATE rooms
        SET code_agent_status = COALESCE(code_agent_status, coco_status)
        WHERE coco_status IS NOT NULL;
      ALTER TABLE rooms DROP COLUMN coco_status;
    END IF;
  END $$`,
  `DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'rooms' AND column_name = 'coco_access') THEN
      UPDATE rooms
        SET code_agent_access = COALESCE(code_agent_access, coco_access)
        WHERE coco_access IS NOT NULL;
      ALTER TABLE rooms DROP COLUMN coco_access;
    END IF;
  END $$`,
  `UPDATE rooms SET type = 'codeAgent' WHERE type = 'coco'`,
  `UPDATE rooms SET code_agent_backend = 'code-agent' WHERE code_agent_backend = 'coco'`,
  `UPDATE room_messages
    SET client_id = 'code_agent_runner'
    WHERE client_id = 'coco_runner'`,
  `UPDATE room_messages
    SET username = 'Coco'
    WHERE client_id = 'code_agent_runner'
      AND username IN ('Coco', 'Code Agent')`,
  `UPDATE room_messages
    SET username = 'Coco'
    WHERE client_id = 'ai_assistant'
      AND username IN ('Coco', 'Code Agent')`,
  `UPDATE room_messages
    SET content = replace(
      replace(
        replace(content, 'Unable to persist code-agent', 'Unable to persist agent'),
        'Unable to persist Coco Agent', 'Unable to persist agent'
      ),
      'Unable to persist Coco', 'Unable to persist agent'
    )
    WHERE client_id = 'code_agent_runner'
      AND (
        content LIKE 'Unable to persist code-agent%'
        OR content LIKE 'Unable to persist Coco Agent%'
        OR content LIKE 'Unable to persist Coco%'
      )`,
  `UPDATE observability_events
    SET event = 'code_agent.' || substring(event from 6)
    WHERE event LIKE 'coco.%'`,
  `UPDATE observability_events
    SET error_message = replace(
      replace(
        replace(
          replace(
            replace(
              replace(
                replace(
                  replace(
                    replace(
                      replace(
                        replace(
                          replace(
                            replace(
                              replace(
                                replace(
                                  replace(
                                    replace(
                                      replace(error_message, 'roomtalk_coco_runner', 'roomtalk_code_agent_runner'),
                                      'Coco runner', 'code agent runner'
                                    ),
                                    'coco runner', 'code agent runner'
                                  ),
                                  'Code agent is', 'Workspace is'
                                ),
                                'Coco Agent is', 'Workspace is'
                              ),
                              'Coco is', 'Workspace is'
                            ),
                            'Code agent requires', 'Workspace requires'
                          ),
                          'Coco Agent requires', 'Workspace requires'
                        ),
                        'Coco requires', 'Workspace requires'
                      ),
                      'Code agent mode', 'Agent mode'
                    ),
                    'Coco Agent mode', 'Agent mode'
                  ),
                  'Coco mode', 'Agent mode'
                ),
                'code-agent room', 'Workspace room'
              ),
              'Coco Agent room', 'Workspace room'
            ),
            'Coco room', 'Workspace room'
          ),
          'code-agent sandbox', 'Workspace sandbox'
        ),
        'Coco Agent sandbox', 'Workspace sandbox'
      ),
      'Coco sandbox', 'Workspace sandbox'
    )
    WHERE error_message IS NOT NULL
      AND (
        error_message LIKE '%Coco%'
        OR error_message LIKE '%Code agent%'
        OR error_message LIKE '%Coco Agent%'
        OR error_message LIKE '%code-agent room%'
        OR error_message LIKE '%code-agent sandbox%'
        OR error_message LIKE '%roomtalk_coco_runner%'
      )`,
  `UPDATE observability_events
    SET payload = replace(
      replace(
        replace(
          replace(
            replace(
              replace(
                replace(
                  replace(
                    replace(
                      replace(
                        replace(
                          payload::text,
                          'roomtalk_coco_runner',
                          'roomtalk_code_agent_runner'
                        ),
                        'Coco Agent runner starting',
                        'code agent runner starting'
                      ),
                      'Code agent runner starting',
                      'code agent runner starting'
                    ),
                    'Coco runner starting',
                    'code agent runner starting'
                  ),
                  'Coco Agent engine',
                  'code agent engine'
                ),
                'Code agent engine',
                'code agent engine'
              ),
              'Coco engine',
              'code agent engine'
            ),
            'Coco Agent runner',
            'code agent runner'
          ),
          'Code agent runner',
          'code agent runner'
        ),
        'Coco runner',
        'code agent runner'
      ),
      'coco runner',
      'code agent runner'
    )::jsonb
    WHERE payload::text LIKE '%roomtalk_coco_runner%'
      OR payload::text LIKE '%Coco Agent runner%'
      OR payload::text LIKE '%Coco Agent engine%'
      OR payload::text LIKE '%Coco runner%'
      OR payload::text LIKE '%Coco engine%'
      OR payload::text LIKE '%Code agent runner%'
      OR payload::text LIKE '%Code agent engine%'`,
  `UPDATE observability_events
    SET payload = replace(
      payload::text,
      '"backend": "coco"',
      '"backend": "code-agent"'
    )::jsonb
    WHERE payload::text LIKE '%"backend": "coco"%'`,
  `ALTER TABLE rooms ADD CONSTRAINT rooms_type_check
    CHECK (type IN ('chat', 'codeAgent'))`,
  `ALTER TABLE rooms ADD CONSTRAINT rooms_code_agent_status_check
    CHECK (code_agent_status IS NULL OR code_agent_status IN ('idle', 'running', 'error'))`,
  `ALTER TABLE rooms ADD CONSTRAINT rooms_code_agent_access_check
    CHECK (code_agent_access IS NULL OR code_agent_access IN ('owner', 'admin', 'member'))`,
  `CREATE INDEX IF NOT EXISTS idx_rooms_code_agent_recovery
    ON rooms (type, sandbox_status, code_agent_status)`,
];

export async function migratePostgresCodeAgentNaming(pool: PostgresPool, dryRun: boolean): Promise<number> {
  if (dryRun) {
    return POSTGRES_CODE_AGENT_NAMING_SQL.length;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const sql of POSTGRES_CODE_AGENT_NAMING_SQL) {
      await client.query(sql);
    }
    await client.query('COMMIT');
    return POSTGRES_CODE_AGENT_NAMING_SQL.length;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const migrateRoomPayload = (room: Record<string, any>): { changed: boolean; room: Record<string, any> } => {
  const next = { ...room };
  let changed = false;

  const move = (from: string, to: string) => {
    if (Object.prototype.hasOwnProperty.call(next, from)) {
      if (!Object.prototype.hasOwnProperty.call(next, to) || next[to] === undefined || next[to] === null) {
        next[to] = next[from];
      }
      delete next[from];
      changed = true;
    }
  };

  if (next.type === 'coco') {
    next.type = 'codeAgent';
    changed = true;
  }
  move('sandboxCocoSourceRef', 'sandboxCodeAgentSourceRef');
  move('cocoSessionId', 'codeAgentSessionId');
  move('cocoStatus', 'codeAgentStatus');
  move('cocoAccess', 'codeAgentAccess');
  if (next.codeAgentBackend === 'coco') {
    next.codeAgentBackend = 'code-agent';
    changed = true;
  }

  return { changed, room: next };
};

const migrateMessagePayload = (message: Record<string, any>): { changed: boolean; message: Record<string, any> } => {
  const next = { ...message };
  let changed = false;

  if (next.clientId === 'coco_runner') {
    next.clientId = 'code_agent_runner';
    changed = true;
  }
  if (
    (next.clientId === 'code_agent_runner' || next.clientId === 'ai_assistant')
    && (next.username === 'Coco' || next.username === 'Code Agent')
  ) {
    next.username = 'Coco';
    changed = true;
  }
  if (
    next.clientId === 'code_agent_runner'
    && typeof next.content === 'string'
    && (
      next.content.startsWith('Unable to persist Coco')
      || next.content.startsWith('Unable to persist code-agent')
    )
  ) {
    next.content = next.content
      .replace('Unable to persist code-agent', 'Unable to persist agent')
      .replace('Unable to persist Coco Agent', 'Unable to persist agent')
      .replace('Unable to persist Coco', 'Unable to persist agent');
    changed = true;
  }

  return { changed, message: next };
};

export async function migrateRedisCodeAgentNaming(redis: RedisHashClient, dryRun: boolean): Promise<Pick<MigrationStats, 'redisRoomsRead' | 'redisRoomsChanged' | 'redisMessagesRead' | 'redisMessagesChanged'>> {
  const roomIds = await redis.hKeys('rooms');
  let roomsChanged = 0;
  let messagesRead = 0;
  let messagesChanged = 0;

  for (const roomId of roomIds) {
    const payload = await redis.hGet('rooms', roomId);
    if (payload) {
      try {
        const migrated = migrateRoomPayload(JSON.parse(payload));
        if (migrated.changed) {
          roomsChanged++;
          if (!dryRun) {
            await redis.hSet('rooms', roomId, JSON.stringify(migrated.room));
          }
        }
      } catch (error) {
        logger.warn('Skipping room with invalid JSON during code agent naming migration', { roomId, error });
      }
    }

    const messageStats = await migrateRedisRoomMessages(redis, `room:${roomId}:messages`, roomId, dryRun);
    messagesRead += messageStats.read;
    messagesChanged += messageStats.changed;
  }

  return { redisRoomsRead: roomIds.length, redisRoomsChanged: roomsChanged, redisMessagesRead: messagesRead, redisMessagesChanged: messagesChanged };
}

const migrateRedisRoomMessages = async (
  redis: RedisHashClient,
  messageKey: string,
  roomId: string,
  dryRun: boolean
): Promise<{ read: number; changed: number }> => {
  if (!redis.lRange) {
    return { read: 0, changed: 0 };
  }

  if (redis.lLen && redis.lSet) {
    const messageCount = await redis.lLen(messageKey);
    let read = 0;
    let changed = 0;
    for (let start = 0; start < messageCount; start += REDIS_MESSAGE_BATCH_SIZE) {
      const stop = Math.min(start + REDIS_MESSAGE_BATCH_SIZE - 1, messageCount - 1);
      const rawMessages = await redis.lRange(messageKey, start, stop);
      read += rawMessages.length;
      for (let offset = 0; offset < rawMessages.length; offset++) {
        const rawMessage = rawMessages[offset];
        try {
          const migrated = migrateMessagePayload(JSON.parse(rawMessage));
          if (migrated.changed) {
            changed++;
            if (!dryRun) {
              await redis.lSet(messageKey, start + offset, JSON.stringify(migrated.message));
            }
          }
        } catch (error) {
          logger.warn('Skipping message with invalid JSON during code agent naming migration', { roomId, error });
        }
      }
    }
    return { read, changed };
  }

  const rawMessages = await redis.lRange(messageKey, 0, -1);
  let changed = 0;
  const migratedMessages = rawMessages.map((rawMessage: string) => {
    try {
      const migrated = migrateMessagePayload(JSON.parse(rawMessage));
      if (migrated.changed) {
        changed++;
      }
      return { changed: migrated.changed, serialized: JSON.stringify(migrated.message) };
    } catch (error) {
      logger.warn('Skipping message with invalid JSON during code agent naming migration', { roomId, error });
      return { changed: false, serialized: rawMessage };
    }
  });
  if (changed > 0 && !dryRun) {
    await redis.del?.(messageKey);
    if (migratedMessages.length > 0) {
      await redis.rPush?.(messageKey, migratedMessages.map(item => item.serialized));
    }
  }
  return { read: rawMessages.length, changed };
};

export async function runCodeAgentNamingMigration(env: NodeJS.ProcessEnv = process.env): Promise<MigrationStats> {
  const dryRun = env.CODE_AGENT_NAMING_MIGRATION_DRY_RUN !== 'false';
  const target = parseTarget(env.CODE_AGENT_NAMING_MIGRATION_TARGET);
  const stats: MigrationStats = {
    dryRun,
    postgresStatements: 0,
    redisRoomsRead: 0,
    redisRoomsChanged: 0,
    redisMessagesRead: 0,
    redisMessagesChanged: 0,
  };

  if (shouldRunPostgres(target)) {
    const databaseUrl = env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required for Postgres code agent naming migration');
    }
    const pool = createPostgresPool(databaseUrl, logger);
    try {
      stats.postgresStatements = await migratePostgresCodeAgentNaming(pool, dryRun);
    } finally {
      await pool.end?.();
    }
  }

  if (shouldRunRedis(target)) {
    const redisUrl = env.REDIS_URL || 'redis://localhost:6379';
    const redis = createClient({ url: redisUrl });
    try {
      await redis.connect();
      const redisStats = await migrateRedisCodeAgentNaming(redis as RedisHashClient, dryRun);
      stats.redisRoomsRead = redisStats.redisRoomsRead;
      stats.redisRoomsChanged = redisStats.redisRoomsChanged;
      stats.redisMessagesRead = redisStats.redisMessagesRead;
      stats.redisMessagesChanged = redisStats.redisMessagesChanged;
    } finally {
      await redis.quit().catch(() => undefined);
    }
  }

  return stats;
}

if (require.main === module) {
  runCodeAgentNamingMigration()
    .then(stats => {
      logger.info('Code agent naming migration finished', stats);
      if (stats.dryRun) {
        logger.warn('Dry run only. Set CODE_AGENT_NAMING_MIGRATION_DRY_RUN=false to write changes.');
      }
    })
    .catch(error => {
      logger.error('Code agent naming migration failed', { error });
      process.exitCode = 1;
    });
}
