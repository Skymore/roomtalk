import { RedisClientType } from 'redis';
import { PostgresPool } from '../repositories/postgresStore';
import {
  CodexConnectionAuthUpdate,
  CodexConnectionRecord,
  CodexConnectionReauthUpdate,
  CodexConnectionStatus,
  CodexConnectionStore,
  CodexDeviceAuthAttemptUpdate,
  CodexEncryptedAuthJson,
} from './codexConnection';

const CODEX_CONNECTION_COLUMNS = [
  'client_id',
  'provider',
  'status',
  'encrypted_auth_json',
  'auth_version',
  'key_version',
  'created_at',
  'updated_at',
  'last_validated_at',
  'last_used_at',
  'auth_refresh_owner_id',
  'auth_refresh_locked_until',
  'device_auth_restore_status',
  'last_error',
].join(', ');

type CodexConnectionRow = {
  client_id: string;
  provider: 'codex';
  status: CodexConnectionStatus;
  encrypted_auth_json: unknown;
  auth_version: number | string;
  key_version: string;
  created_at: string | Date;
  updated_at: string | Date;
  last_validated_at: string | Date | null;
  last_used_at: string | Date | null;
  auth_refresh_owner_id: string | null;
  auth_refresh_locked_until: string | Date | null;
  device_auth_restore_status: Exclude<CodexConnectionStatus, 'pending'> | null;
  last_error: string | null;
};

export class PostgresCodexConnectionStore implements CodexConnectionStore {
  constructor(private readonly pool: Pick<PostgresPool, 'query'>) {}

  async getConnection(clientId: string): Promise<CodexConnectionRecord | null> {
    const result = await this.pool.query<CodexConnectionRow>(
      `SELECT ${CODEX_CONNECTION_COLUMNS}
      FROM codex_connections
      WHERE client_id = $1`,
      [clientId]
    );
    return mapPostgresConnectionRow(result.rows[0]);
  }

  async saveConnection(record: CodexConnectionRecord): Promise<CodexConnectionRecord> {
    const result = await this.pool.query<CodexConnectionRow>(
      `INSERT INTO codex_connections (
        client_id,
        provider,
        status,
        encrypted_auth_json,
        auth_version,
        key_version,
        created_at,
        updated_at,
        last_validated_at,
        last_used_at,
        auth_refresh_owner_id,
        auth_refresh_locked_until,
        device_auth_restore_status,
        last_error
      )
      VALUES ($1, 'codex', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (client_id) DO UPDATE SET
        status = EXCLUDED.status,
        encrypted_auth_json = EXCLUDED.encrypted_auth_json,
        auth_version = EXCLUDED.auth_version,
        key_version = EXCLUDED.key_version,
        updated_at = EXCLUDED.updated_at,
        last_validated_at = EXCLUDED.last_validated_at,
        last_used_at = EXCLUDED.last_used_at,
        auth_refresh_owner_id = EXCLUDED.auth_refresh_owner_id,
        auth_refresh_locked_until = EXCLUDED.auth_refresh_locked_until,
        device_auth_restore_status = EXCLUDED.device_auth_restore_status,
        last_error = EXCLUDED.last_error
      RETURNING ${CODEX_CONNECTION_COLUMNS}`,
      [
        record.clientId,
        record.status,
        record.encryptedAuthJson || null,
        record.authVersion,
        record.keyVersion,
        record.createdAt,
        record.updatedAt,
        record.lastValidatedAt || null,
        record.lastUsedAt || null,
        record.authRefreshOwnerId || null,
        record.authRefreshLockedUntil || null,
        record.deviceAuthRestoreStatus || null,
        record.lastError || null,
      ]
    );
    const saved = mapPostgresConnectionRow(result.rows[0]);
    if (!saved) {
      throw new Error(`PostgreSQL did not return saved Codex connection for client ${record.clientId}`);
    }
    return saved;
  }

  async deleteConnection(clientId: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM codex_connections WHERE client_id = $1',
      [clientId]
    );
    return (result.rowCount || 0) > 0;
  }

  async beginDeviceAuthAttempt(
    clientId: string,
    keyVersion: string,
    createdAt: string,
    updatedAt: string
  ): Promise<CodexConnectionRecord> {
    const result = await this.pool.query<CodexConnectionRow>(
      `INSERT INTO codex_connections (
        client_id,
        provider,
        status,
        auth_version,
        key_version,
        created_at,
        updated_at,
        device_auth_restore_status
      )
      VALUES ($1, 'codex', 'pending', 1, $2, $3, $4, 'disconnected')
      ON CONFLICT (client_id) DO UPDATE SET
        status = 'pending',
        auth_version = codex_connections.auth_version + 1,
        key_version = EXCLUDED.key_version,
        updated_at = EXCLUDED.updated_at,
        auth_refresh_owner_id = NULL,
        auth_refresh_locked_until = NULL,
        device_auth_restore_status = CASE
          WHEN codex_connections.status = 'pending'
            THEN COALESCE(codex_connections.device_auth_restore_status, 'disconnected')
          ELSE codex_connections.status
        END
      RETURNING ${CODEX_CONNECTION_COLUMNS}`,
      [clientId, keyVersion, createdAt, updatedAt]
    );
    const pending = mapPostgresConnectionRow(result.rows[0]);
    if (!pending) {
      throw new Error(`PostgreSQL did not start Codex device auth for client ${clientId}`);
    }
    return pending;
  }

  async settleDeviceAuthAttempt(
    clientId: string,
    expectedAuthVersion: number,
    update: CodexDeviceAuthAttemptUpdate
  ): Promise<CodexConnectionRecord | null> {
    if (update.outcome === 'connected') {
      const result = await this.pool.query<CodexConnectionRow>(
        `UPDATE codex_connections
        SET status = 'connected',
            encrypted_auth_json = $3,
            key_version = $4,
            updated_at = $5,
            last_validated_at = $6,
            auth_refresh_owner_id = NULL,
            auth_refresh_locked_until = NULL,
            device_auth_restore_status = NULL,
            last_error = NULL
        WHERE client_id = $1
          AND status = 'pending'
          AND auth_version = $2
        RETURNING ${CODEX_CONNECTION_COLUMNS}`,
        [
          clientId,
          expectedAuthVersion,
          update.encryptedAuthJson,
          update.keyVersion,
          update.updatedAt,
          update.lastValidatedAt,
        ]
      );
      return mapPostgresConnectionRow(result.rows[0]);
    }

    if (update.outcome === 'failed') {
      const result = await this.pool.query<CodexConnectionRow>(
        `UPDATE codex_connections
        SET status = 'reauth_required',
            updated_at = $3,
            auth_refresh_owner_id = NULL,
            auth_refresh_locked_until = NULL,
            device_auth_restore_status = NULL,
            last_error = $4
        WHERE client_id = $1
          AND status = 'pending'
          AND auth_version = $2
        RETURNING ${CODEX_CONNECTION_COLUMNS}`,
        [clientId, expectedAuthVersion, update.updatedAt, update.lastError]
      );
      return mapPostgresConnectionRow(result.rows[0]);
    }

    const result = await this.pool.query<CodexConnectionRow>(
      `UPDATE codex_connections
      SET status = COALESCE(device_auth_restore_status, 'disconnected'),
          updated_at = $3,
          auth_refresh_owner_id = NULL,
          auth_refresh_locked_until = NULL,
          device_auth_restore_status = NULL
      WHERE client_id = $1
        AND status = 'pending'
        AND auth_version = $2
      RETURNING ${CODEX_CONNECTION_COLUMNS}`,
      [clientId, expectedAuthVersion, update.updatedAt]
    );
    return mapPostgresConnectionRow(result.rows[0]);
  }

  async disconnectConnection(clientId: string, updatedAt: string): Promise<CodexConnectionRecord | null> {
    const result = await this.pool.query<CodexConnectionRow>(
      `UPDATE codex_connections
      SET status = 'disconnected',
          encrypted_auth_json = NULL,
          auth_version = auth_version + 1,
          updated_at = $2,
          auth_refresh_owner_id = NULL,
          auth_refresh_locked_until = NULL,
          device_auth_restore_status = NULL,
          last_error = NULL
      WHERE client_id = $1
      RETURNING ${CODEX_CONNECTION_COLUMNS}`,
      [clientId, updatedAt]
    );
    return mapPostgresConnectionRow(result.rows[0]);
  }

  async compareAndSwapAuth(
    clientId: string,
    expectedAuthVersion: number,
    update: CodexConnectionAuthUpdate
  ): Promise<CodexConnectionRecord | null> {
    const result = await this.pool.query<CodexConnectionRow>(
      `UPDATE codex_connections
      SET encrypted_auth_json = $3,
          status = 'connected',
          auth_version = auth_version + 1,
          key_version = $4,
          updated_at = $5,
          last_used_at = $6,
          last_validated_at = COALESCE($7, last_validated_at),
          last_error = NULL
      WHERE client_id = $1
        AND status IN ('connected', 'reauth_required')
        AND auth_version = $2
      RETURNING ${CODEX_CONNECTION_COLUMNS}`,
      [
        clientId,
        expectedAuthVersion,
        update.encryptedAuthJson,
        update.keyVersion,
        update.updatedAt,
        update.lastUsedAt,
        update.lastValidatedAt || null,
      ]
    );
    return mapPostgresConnectionRow(result.rows[0]);
  }

  async markReauthRequired(
    clientId: string,
    expectedAuthVersion: number,
    update: CodexConnectionReauthUpdate
  ): Promise<CodexConnectionRecord | null> {
    const result = await this.pool.query<CodexConnectionRow>(
      `UPDATE codex_connections
      SET status = 'reauth_required',
          updated_at = $3,
          last_used_at = $4,
          last_error = $5,
          auth_refresh_owner_id = NULL,
          auth_refresh_locked_until = NULL
      WHERE client_id = $1
        AND status = 'connected'
        AND auth_version = $2
      RETURNING ${CODEX_CONNECTION_COLUMNS}`,
      [clientId, expectedAuthVersion, update.updatedAt, update.lastUsedAt, update.lastError]
    );
    return mapPostgresConnectionRow(result.rows[0]);
  }

  async touchConnection(
    clientId: string,
    expectedAuthVersion: number,
    lastUsedAt: string,
    lastValidatedAt?: string
  ): Promise<CodexConnectionRecord | null> {
    const result = await this.pool.query<CodexConnectionRow>(
      `UPDATE codex_connections
      SET updated_at = $3,
          last_used_at = $3,
          last_validated_at = COALESCE($4, last_validated_at)
      WHERE client_id = $1
        AND status = 'connected'
        AND auth_version = $2
      RETURNING ${CODEX_CONNECTION_COLUMNS}`,
      [clientId, expectedAuthVersion, lastUsedAt, lastValidatedAt || null]
    );
    return mapPostgresConnectionRow(result.rows[0]);
  }

  async acquireAuthRefreshLease(
    clientId: string,
    ownerId: string,
    lockedUntil: string,
    now: string
  ): Promise<CodexConnectionRecord | null> {
    const result = await this.pool.query<CodexConnectionRow>(
      `UPDATE codex_connections
      SET auth_refresh_owner_id = $2,
          auth_refresh_locked_until = $3
      WHERE client_id = $1
        AND status = 'connected'
        AND encrypted_auth_json IS NOT NULL
        AND (
          auth_refresh_owner_id IS NULL
          OR auth_refresh_locked_until IS NULL
          OR auth_refresh_locked_until <= $4
          OR auth_refresh_owner_id = $2
        )
      RETURNING ${CODEX_CONNECTION_COLUMNS}`,
      [clientId, ownerId, lockedUntil, now]
    );
    return mapPostgresConnectionRow(result.rows[0]);
  }

  async releaseAuthRefreshLease(clientId: string, ownerId: string, now: string): Promise<CodexConnectionRecord | null> {
    const result = await this.pool.query<CodexConnectionRow>(
      `UPDATE codex_connections
      SET auth_refresh_owner_id = NULL,
          auth_refresh_locked_until = NULL,
          updated_at = $3
      WHERE client_id = $1
        AND auth_refresh_owner_id = $2
      RETURNING ${CODEX_CONNECTION_COLUMNS}`,
      [clientId, ownerId, now]
    );
    return mapPostgresConnectionRow(result.rows[0]) || this.getConnection(clientId);
  }
}

const REDIS_CODEX_CONNECTIONS_KEY = 'codex:connections';

export class RedisCodexConnectionStore implements CodexConnectionStore {
  constructor(private readonly redisClient: RedisClientType) {}

  async getConnection(clientId: string): Promise<CodexConnectionRecord | null> {
    const raw = await this.redisClient.hGet(REDIS_CODEX_CONNECTIONS_KEY, clientId);
    return parseRedisConnectionRecord(raw);
  }

  async saveConnection(record: CodexConnectionRecord): Promise<CodexConnectionRecord> {
    await this.redisClient.hSet(REDIS_CODEX_CONNECTIONS_KEY, record.clientId, JSON.stringify(record));
    return cloneRecord(record)!;
  }

  async deleteConnection(clientId: string): Promise<boolean> {
    const deleted = await this.redisClient.hDel(REDIS_CODEX_CONNECTIONS_KEY, clientId);
    return deleted > 0;
  }

  async beginDeviceAuthAttempt(
    clientId: string,
    keyVersion: string,
    createdAt: string,
    updatedAt: string
  ): Promise<CodexConnectionRecord> {
    const raw = await (this.redisClient as any).eval(REDIS_BEGIN_CODEX_DEVICE_AUTH_SCRIPT, {
      keys: [REDIS_CODEX_CONNECTIONS_KEY],
      arguments: [clientId, keyVersion, createdAt, updatedAt],
    }) as string | null;
    const pending = parseRedisConnectionRecord(raw);
    if (!pending) {
      throw new Error(`Redis did not start Codex device auth for client ${clientId}`);
    }
    return pending;
  }

  async settleDeviceAuthAttempt(
    clientId: string,
    expectedAuthVersion: number,
    update: CodexDeviceAuthAttemptUpdate
  ): Promise<CodexConnectionRecord | null> {
    const raw = await (this.redisClient as any).eval(REDIS_SETTLE_CODEX_DEVICE_AUTH_SCRIPT, {
      keys: [REDIS_CODEX_CONNECTIONS_KEY],
      arguments: [
        clientId,
        String(expectedAuthVersion),
        update.outcome,
        update.updatedAt,
        update.outcome === 'connected' ? JSON.stringify(update.encryptedAuthJson) : '',
        update.outcome === 'connected' ? update.keyVersion : '',
        update.outcome === 'connected' ? update.lastValidatedAt : '',
        update.outcome === 'failed' ? update.lastError : '',
      ],
    }) as string | null;
    return parseRedisConnectionRecord(raw);
  }

  async disconnectConnection(clientId: string, updatedAt: string): Promise<CodexConnectionRecord | null> {
    const raw = await (this.redisClient as any).eval(REDIS_DISCONNECT_CODEX_CONNECTION_SCRIPT, {
      keys: [REDIS_CODEX_CONNECTIONS_KEY],
      arguments: [clientId, updatedAt],
    }) as string | null;
    return parseRedisConnectionRecord(raw);
  }

  async compareAndSwapAuth(
    clientId: string,
    expectedAuthVersion: number,
    update: CodexConnectionAuthUpdate
  ): Promise<CodexConnectionRecord | null> {
    const raw = await (this.redisClient as any).eval(REDIS_COMPARE_AND_SWAP_CODEX_AUTH_SCRIPT, {
      keys: [REDIS_CODEX_CONNECTIONS_KEY],
      arguments: [
        clientId,
        String(expectedAuthVersion),
        JSON.stringify(update.encryptedAuthJson),
        update.keyVersion,
        update.updatedAt,
        update.lastUsedAt,
        update.lastValidatedAt || '',
      ],
    }) as string | null;
    return parseRedisConnectionRecord(raw);
  }

  async markReauthRequired(
    clientId: string,
    expectedAuthVersion: number,
    update: CodexConnectionReauthUpdate
  ): Promise<CodexConnectionRecord | null> {
    const raw = await (this.redisClient as any).eval(REDIS_MARK_CODEX_REAUTH_REQUIRED_SCRIPT, {
      keys: [REDIS_CODEX_CONNECTIONS_KEY],
      arguments: [
        clientId,
        String(expectedAuthVersion),
        update.updatedAt,
        update.lastUsedAt,
        update.lastError,
      ],
    }) as string | null;
    return parseRedisConnectionRecord(raw);
  }

  async touchConnection(
    clientId: string,
    expectedAuthVersion: number,
    lastUsedAt: string,
    lastValidatedAt?: string
  ): Promise<CodexConnectionRecord | null> {
    const raw = await (this.redisClient as any).eval(REDIS_TOUCH_CODEX_CONNECTION_SCRIPT, {
      keys: [REDIS_CODEX_CONNECTIONS_KEY],
      arguments: [clientId, String(expectedAuthVersion), lastUsedAt, lastValidatedAt || ''],
    }) as string | null;
    return parseRedisConnectionRecord(raw);
  }

  async acquireAuthRefreshLease(
    clientId: string,
    ownerId: string,
    lockedUntil: string,
    now: string
  ): Promise<CodexConnectionRecord | null> {
    const raw = await (this.redisClient as any).eval(REDIS_ACQUIRE_CODEX_AUTH_REFRESH_LEASE_SCRIPT, {
      keys: [REDIS_CODEX_CONNECTIONS_KEY],
      arguments: [clientId, ownerId, lockedUntil, now],
    }) as string | null;
    return parseRedisConnectionRecord(raw);
  }

  async releaseAuthRefreshLease(clientId: string, ownerId: string, now: string): Promise<CodexConnectionRecord | null> {
    const raw = await (this.redisClient as any).eval(REDIS_RELEASE_CODEX_AUTH_REFRESH_LEASE_SCRIPT, {
      keys: [REDIS_CODEX_CONNECTIONS_KEY],
      arguments: [clientId, ownerId, now],
    }) as string | null;
    return parseRedisConnectionRecord(raw);
  }
}

const REDIS_BEGIN_CODEX_DEVICE_AUTH_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
local record

if raw then
  local ok, parsed = pcall(cjson.decode, raw)
  if not ok then
    return ''
  end
  record = parsed
  if record['status'] == 'pending' then
    record['deviceAuthRestoreStatus'] = record['deviceAuthRestoreStatus'] or 'disconnected'
  else
    record['deviceAuthRestoreStatus'] = record['status'] or 'disconnected'
  end
  record['authVersion'] = tonumber(record['authVersion'] or 0) + 1
else
  record = {
    clientId = ARGV[1],
    provider = 'codex',
    authVersion = 1,
    createdAt = ARGV[3],
    deviceAuthRestoreStatus = 'disconnected'
  }
end

record['status'] = 'pending'
record['keyVersion'] = ARGV[2]
record['updatedAt'] = ARGV[4]
record['authRefreshOwnerId'] = nil
record['authRefreshLockedUntil'] = nil

local encoded = cjson.encode(record)
redis.call('HSET', KEYS[1], ARGV[1], encoded)
return encoded
`;

const REDIS_SETTLE_CODEX_DEVICE_AUTH_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then
  return ''
end

local ok, record = pcall(cjson.decode, raw)
if not ok then
  return ''
end

if record['status'] ~= 'pending' or tonumber(record['authVersion']) ~= tonumber(ARGV[2]) then
  return ''
end

if ARGV[3] == 'connected' then
  local auth_ok, encrypted_auth_json = pcall(cjson.decode, ARGV[5])
  if not auth_ok then
    return ''
  end
  record['status'] = 'connected'
  record['encryptedAuthJson'] = encrypted_auth_json
  record['keyVersion'] = ARGV[6]
  record['lastValidatedAt'] = ARGV[7]
  record['lastError'] = nil
elseif ARGV[3] == 'failed' then
  record['status'] = 'reauth_required'
  record['lastError'] = ARGV[8]
elseif ARGV[3] == 'cancelled' then
  record['status'] = record['deviceAuthRestoreStatus'] or 'disconnected'
else
  return ''
end

record['updatedAt'] = ARGV[4]
record['authRefreshOwnerId'] = nil
record['authRefreshLockedUntil'] = nil
record['deviceAuthRestoreStatus'] = nil

local encoded = cjson.encode(record)
redis.call('HSET', KEYS[1], ARGV[1], encoded)
return encoded
`;

const REDIS_COMPARE_AND_SWAP_CODEX_AUTH_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then
  return ''
end

local ok, record = pcall(cjson.decode, raw)
if not ok then
  return ''
end

if (record['status'] ~= 'connected' and record['status'] ~= 'reauth_required')
  or tonumber(record['authVersion']) ~= tonumber(ARGV[2]) then
  return ''
end

local auth_ok, encrypted_auth_json = pcall(cjson.decode, ARGV[3])
if not auth_ok then
  return ''
end

record['encryptedAuthJson'] = encrypted_auth_json
record['status'] = 'connected'
record['authVersion'] = tonumber(ARGV[2]) + 1
record['keyVersion'] = ARGV[4]
record['updatedAt'] = ARGV[5]
record['lastUsedAt'] = ARGV[6]
if ARGV[7] ~= '' then
  record['lastValidatedAt'] = ARGV[7]
end
record['lastError'] = nil

local encoded = cjson.encode(record)
redis.call('HSET', KEYS[1], ARGV[1], encoded)
return encoded
`;

const REDIS_DISCONNECT_CODEX_CONNECTION_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then
  return ''
end

local ok, record = pcall(cjson.decode, raw)
if not ok then
  return ''
end

record['status'] = 'disconnected'
record['encryptedAuthJson'] = nil
record['authVersion'] = tonumber(record['authVersion'] or 0) + 1
record['updatedAt'] = ARGV[2]
record['authRefreshOwnerId'] = nil
record['authRefreshLockedUntil'] = nil
record['deviceAuthRestoreStatus'] = nil
record['lastError'] = nil

local encoded = cjson.encode(record)
redis.call('HSET', KEYS[1], ARGV[1], encoded)
return encoded
`;

const REDIS_MARK_CODEX_REAUTH_REQUIRED_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then
  return ''
end

local ok, record = pcall(cjson.decode, raw)
if not ok then
  return ''
end

if record['status'] ~= 'connected' or tonumber(record['authVersion']) ~= tonumber(ARGV[2]) then
  return ''
end

record['status'] = 'reauth_required'
record['updatedAt'] = ARGV[3]
record['lastUsedAt'] = ARGV[4]
record['lastError'] = ARGV[5]
record['authRefreshOwnerId'] = nil
record['authRefreshLockedUntil'] = nil

local encoded = cjson.encode(record)
redis.call('HSET', KEYS[1], ARGV[1], encoded)
return encoded
`;

const REDIS_TOUCH_CODEX_CONNECTION_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then
  return ''
end

local ok, record = pcall(cjson.decode, raw)
if not ok then
  return ''
end

if record['status'] ~= 'connected' or tonumber(record['authVersion']) ~= tonumber(ARGV[2]) then
  return ''
end

record['updatedAt'] = ARGV[3]
record['lastUsedAt'] = ARGV[3]
if ARGV[4] ~= '' then
  record['lastValidatedAt'] = ARGV[4]
end

local encoded = cjson.encode(record)
redis.call('HSET', KEYS[1], ARGV[1], encoded)
return encoded
`;

const REDIS_ACQUIRE_CODEX_AUTH_REFRESH_LEASE_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then
  return ''
end

local ok, record = pcall(cjson.decode, raw)
if not ok then
  return ''
end

if record['status'] ~= 'connected' or not record['encryptedAuthJson'] then
  return ''
end

local owner_id = record['authRefreshOwnerId']
local locked_until = record['authRefreshLockedUntil']
if owner_id and locked_until and tostring(locked_until) > ARGV[4] and owner_id ~= ARGV[2] then
  return ''
end

record['authRefreshOwnerId'] = ARGV[2]
record['authRefreshLockedUntil'] = ARGV[3]

local encoded = cjson.encode(record)
redis.call('HSET', KEYS[1], ARGV[1], encoded)
return encoded
`;

const REDIS_RELEASE_CODEX_AUTH_REFRESH_LEASE_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then
  return ''
end

local ok, record = pcall(cjson.decode, raw)
if not ok then
  return ''
end

if record['authRefreshOwnerId'] ~= ARGV[2] then
  return raw
end

record['authRefreshOwnerId'] = nil
record['authRefreshLockedUntil'] = nil
record['updatedAt'] = ARGV[3]

local encoded = cjson.encode(record)
redis.call('HSET', KEYS[1], ARGV[1], encoded)
return encoded
`;

const mapPostgresConnectionRow = (row?: CodexConnectionRow): CodexConnectionRecord | null => {
  if (!row) {
    return null;
  }
  return {
    clientId: row.client_id,
    provider: 'codex',
    status: row.status,
    encryptedAuthJson: parseEncryptedAuthJson(row.encrypted_auth_json),
    authVersion: Number(row.auth_version) || 0,
    keyVersion: row.key_version,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    lastValidatedAt: toOptionalIsoString(row.last_validated_at),
    lastUsedAt: toOptionalIsoString(row.last_used_at),
    authRefreshOwnerId: row.auth_refresh_owner_id || undefined,
    authRefreshLockedUntil: toOptionalIsoString(row.auth_refresh_locked_until),
    deviceAuthRestoreStatus: row.device_auth_restore_status || undefined,
    lastError: row.last_error || undefined,
  };
};

const parseEncryptedAuthJson = (value: unknown): CodexEncryptedAuthJson | undefined => {
  if (!value) {
    return undefined;
  }
  if (typeof value === 'string') {
    return JSON.parse(value) as CodexEncryptedAuthJson;
  }
  return value as CodexEncryptedAuthJson;
};

const parseRedisConnectionRecord = (raw: string | null | undefined): CodexConnectionRecord | null => {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CodexConnectionRecord>;
    if (
      typeof parsed.clientId !== 'string' ||
      parsed.provider !== 'codex' ||
      !isCodexConnectionStatus(parsed.status) ||
      typeof parsed.authVersion !== 'number' ||
      typeof parsed.keyVersion !== 'string' ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.updatedAt !== 'string'
    ) {
      return null;
    }
    return parsed as CodexConnectionRecord;
  } catch {
    return null;
  }
};

const isCodexConnectionStatus = (status: unknown): status is CodexConnectionStatus => (
  status === 'pending' ||
  status === 'connected' ||
  status === 'reauth_required' ||
  status === 'disconnected'
);

const toIsoString = (value: string | Date): string => (
  value instanceof Date ? value.toISOString() : value
);

const toOptionalIsoString = (value: string | Date | null): string | undefined => {
  if (!value) {
    return undefined;
  }
  return toIsoString(value);
};

const cloneRecord = (record: CodexConnectionRecord | null): CodexConnectionRecord | null => {
  if (!record) {
    return null;
  }
  return JSON.parse(JSON.stringify(record)) as CodexConnectionRecord;
};
