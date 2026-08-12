import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CodexAuthCipher,
  CodexConnectionRecord,
  CodexConnectionService,
  CodexDeviceAuthDriver,
  CodexDeviceAuthInfo,
} from './codexConnection';
import { PostgresCodexConnectionStore, RedisCodexConnectionStore } from './codexConnectionStore';

const encryptedAuthJson = {
  algorithm: 'aes-256-gcm' as const,
  keyVersion: 'key-v1',
  iv: 'iv',
  tag: 'tag',
  ciphertext: 'ciphertext',
};

const refreshedEncryptedAuthJson = {
  ...encryptedAuthJson,
  ciphertext: 'refreshed-ciphertext',
};

const makeRecord = (clientId = 'client-1'): CodexConnectionRecord => ({
  clientId,
  provider: 'codex',
  status: 'connected',
  encryptedAuthJson,
  authVersion: 1,
  keyVersion: 'key-v1',
  createdAt: '2026-07-04T00:00:00.000Z',
  updatedAt: '2026-07-04T00:00:00.000Z',
  lastValidatedAt: '2026-07-04T00:00:00.000Z',
});

describe('PostgresCodexConnectionStore', () => {
  it('persists, restores, CAS-updates auth, leases refresh, and deletes connections', async () => {
    const pool = new MemoryPostgresPool();
    const store = new PostgresCodexConnectionStore(pool);

    const saved = await store.saveConnection(makeRecord());
    assert.equal(saved.clientId, 'client-1');
    assert.equal(saved.provider, 'codex');
    assert.deepEqual(saved.encryptedAuthJson, encryptedAuthJson);

    assert.deepEqual(await store.getConnection('client-1'), saved);

    const leased = await store.acquireAuthRefreshLease(
      'client-1',
      'refresh-1',
      '2026-07-04T00:10:00.000Z',
      '2026-07-04T00:00:00.000Z'
    );
    assert.equal(leased?.authRefreshOwnerId, 'refresh-1');
    assert.equal(leased?.authRefreshLockedUntil, '2026-07-04T00:10:00.000Z');

    const denied = await store.acquireAuthRefreshLease(
      'client-1',
      'refresh-2',
      '2026-07-04T00:11:00.000Z',
      '2026-07-04T00:01:00.000Z'
    );
    assert.equal(denied, null);

    const updated = await store.compareAndSwapAuth('client-1', 1, {
      encryptedAuthJson: refreshedEncryptedAuthJson,
      keyVersion: 'key-v2',
      updatedAt: '2026-07-04T00:02:00.000Z',
      lastUsedAt: '2026-07-04T00:02:00.000Z',
      lastValidatedAt: '2026-07-04T00:02:00.000Z',
    });
    assert.equal(updated?.authVersion, 2);
    assert.deepEqual(updated?.encryptedAuthJson, refreshedEncryptedAuthJson);
    assert.equal(await store.compareAndSwapAuth('client-1', 1, {
      encryptedAuthJson,
      keyVersion: 'key-v1',
      updatedAt: '2026-07-04T00:03:00.000Z',
      lastUsedAt: '2026-07-04T00:03:00.000Z',
    }), null);

    const wrongRelease = await store.releaseAuthRefreshLease('client-1', 'refresh-2', '2026-07-04T00:03:00.000Z');
    assert.equal(wrongRelease?.authRefreshOwnerId, 'refresh-1');

    const released = await store.releaseAuthRefreshLease('client-1', 'refresh-1', '2026-07-04T00:04:00.000Z');
    assert.equal(released?.authRefreshOwnerId, undefined);
    assert.equal(released?.authRefreshLockedUntil, undefined);

    const touched = await store.touchConnection('client-1', 2, '2026-07-04T00:05:00.000Z');
    assert.equal(touched?.lastUsedAt, '2026-07-04T00:05:00.000Z');

    assert.equal(await store.markReauthRequired('client-1', 1, {
      updatedAt: '2026-07-04T00:06:00.000Z',
      lastUsedAt: '2026-07-04T00:06:00.000Z',
      lastError: 'Codex sign-in expired',
    }), null);
    const reauth = await store.markReauthRequired('client-1', 2, {
      updatedAt: '2026-07-04T00:06:00.000Z',
      lastUsedAt: '2026-07-04T00:06:00.000Z',
      lastError: 'Codex sign-in expired',
    });
    assert.equal(reauth?.status, 'reauth_required');
    assert.equal(reauth?.lastError, 'Codex sign-in expired');
    const recovered = await store.compareAndSwapAuth('client-1', 2, {
      encryptedAuthJson: refreshedEncryptedAuthJson,
      keyVersion: 'key-v2',
      updatedAt: '2026-07-04T00:07:00.000Z',
      lastUsedAt: '2026-07-04T00:07:00.000Z',
      lastValidatedAt: '2026-07-04T00:07:00.000Z',
    });
    assert.equal(recovered?.status, 'connected');
    assert.equal(recovered?.authVersion, 3);

    const disconnected = await store.disconnectConnection('client-1', '2026-07-04T00:08:00.000Z');
    assert.equal(disconnected?.status, 'disconnected');
    assert.equal(disconnected?.authVersion, 4);
    assert.equal(disconnected?.encryptedAuthJson, undefined);

    assert.equal(await store.deleteConnection('client-1'), true);
    assert.equal(await store.getConnection('client-1'), null);
    assert.ok(pool.queries.some(query => query.includes('ON CONFLICT (client_id) DO UPDATE')));
  });

  it('does not lease refresh for disconnected or auth-less rows', async () => {
    const pool = new MemoryPostgresPool();
    const store = new PostgresCodexConnectionStore(pool);
    await store.saveConnection({
      ...makeRecord(),
      status: 'reauth_required',
      encryptedAuthJson: undefined,
      authVersion: 0,
    });

    assert.equal(await store.acquireAuthRefreshLease(
      'client-1',
      'refresh-1',
      '2026-07-04T00:10:00.000Z',
      '2026-07-04T00:00:00.000Z'
    ), null);
  });

  it('settles only the current device-auth generation', async () => {
    const store = new PostgresCodexConnectionStore(new MemoryPostgresPool());
    const first = await store.beginDeviceAuthAttempt(
      'client-1', 'key-v1', '2026-07-04T00:00:00.000Z', '2026-07-04T00:00:00.000Z'
    );
    const second = await store.beginDeviceAuthAttempt(
      'client-1', 'key-v1', '2026-07-04T00:00:00.000Z', '2026-07-04T00:01:00.000Z'
    );
    assert.equal(first.authVersion, 1);
    assert.equal(second.authVersion, 2);

    assert.equal(await store.settleDeviceAuthAttempt('client-1', first.authVersion, {
      outcome: 'connected',
      encryptedAuthJson,
      keyVersion: 'key-v1',
      updatedAt: '2026-07-04T00:02:00.000Z',
      lastValidatedAt: '2026-07-04T00:02:00.000Z',
    }), null);
    const connected = await store.settleDeviceAuthAttempt('client-1', second.authVersion, {
      outcome: 'connected',
      encryptedAuthJson: refreshedEncryptedAuthJson,
      keyVersion: 'key-v2',
      updatedAt: '2026-07-04T00:03:00.000Z',
      lastValidatedAt: '2026-07-04T00:03:00.000Z',
    });
    assert.equal(connected?.status, 'connected');
    assert.equal(connected?.authVersion, 2);
    assert.deepEqual(connected?.encryptedAuthJson, refreshedEncryptedAuthJson);

    const pending = await store.beginDeviceAuthAttempt(
      'client-1', 'key-v2', connected!.createdAt, '2026-07-04T00:04:00.000Z'
    );
    await store.disconnectConnection('client-1', '2026-07-04T00:05:00.000Z');
    assert.equal(await store.settleDeviceAuthAttempt('client-1', pending.authVersion, {
      outcome: 'failed',
      updatedAt: '2026-07-04T00:06:00.000Z',
      lastError: 'stale failure',
    }), null);
    assert.equal((await store.getConnection('client-1'))?.status, 'disconnected');
  });
});

describe('RedisCodexConnectionStore', () => {
  it('persists, restores, CAS-updates auth, leases refresh, and deletes connections', async () => {
    const redis = new MemoryRedisClient();
    const store = new RedisCodexConnectionStore(redis as any);

    const saved = await store.saveConnection(makeRecord());
    assert.deepEqual(await store.getConnection('client-1'), saved);

    const leased = await store.acquireAuthRefreshLease(
      'client-1',
      'refresh-1',
      '2026-07-04T00:10:00.000Z',
      '2026-07-04T00:00:00.000Z'
    );
    assert.equal(leased?.authRefreshOwnerId, 'refresh-1');

    assert.equal(await store.acquireAuthRefreshLease(
      'client-1',
      'refresh-2',
      '2026-07-04T00:11:00.000Z',
      '2026-07-04T00:01:00.000Z'
    ), null);

    const expiredLease = await store.acquireAuthRefreshLease(
      'client-1',
      'refresh-2',
      '2026-07-04T00:21:00.000Z',
      '2026-07-04T00:20:00.000Z'
    );
    assert.equal(expiredLease?.authRefreshOwnerId, 'refresh-2');

    const updated = await store.compareAndSwapAuth('client-1', 1, {
      encryptedAuthJson: refreshedEncryptedAuthJson,
      keyVersion: 'key-v2',
      updatedAt: '2026-07-04T00:21:00.000Z',
      lastUsedAt: '2026-07-04T00:21:00.000Z',
    });
    assert.equal(updated?.authVersion, 2);

    const released = await store.releaseAuthRefreshLease('client-1', 'refresh-2', '2026-07-04T00:22:00.000Z');
    assert.equal(released?.authRefreshOwnerId, undefined);
    assert.equal(released?.authRefreshLockedUntil, undefined);

    const reauth = await store.markReauthRequired('client-1', 2, {
      updatedAt: '2026-07-04T00:23:00.000Z',
      lastUsedAt: '2026-07-04T00:23:00.000Z',
      lastError: 'Codex sign-in expired',
    });
    assert.equal(reauth?.status, 'reauth_required');
    assert.equal(reauth?.lastError, 'Codex sign-in expired');
    const recovered = await store.compareAndSwapAuth('client-1', 2, {
      encryptedAuthJson: refreshedEncryptedAuthJson,
      keyVersion: 'key-v2',
      updatedAt: '2026-07-04T00:24:00.000Z',
      lastUsedAt: '2026-07-04T00:24:00.000Z',
      lastValidatedAt: '2026-07-04T00:24:00.000Z',
    });
    assert.equal(recovered?.status, 'connected');
    assert.equal(recovered?.authVersion, 3);

    const disconnected = await store.disconnectConnection('client-1', '2026-07-04T00:25:00.000Z');
    assert.equal(disconnected?.status, 'disconnected');
    assert.equal(disconnected?.authVersion, 4);
    assert.equal(disconnected?.encryptedAuthJson, undefined);

    assert.equal(await store.deleteConnection('client-1'), true);
    assert.equal(await store.getConnection('client-1'), null);
  });

  it('handles corrupt Redis rows safely', async () => {
    const redis = new MemoryRedisClient();
    const store = new RedisCodexConnectionStore(redis as any);
    await redis.hSet('codex:connections', 'client-1', '{not json');

    assert.equal(await store.getConnection('client-1'), null);
    assert.equal(await store.acquireAuthRefreshLease(
      'client-1',
      'refresh-1',
      '2026-07-04T00:10:00.000Z',
      '2026-07-04T00:00:00.000Z'
    ), null);
  });

  it('settles only the current device-auth generation', async () => {
    const store = new RedisCodexConnectionStore(new MemoryRedisClient() as any);
    const first = await store.beginDeviceAuthAttempt(
      'client-1', 'key-v1', '2026-07-04T00:00:00.000Z', '2026-07-04T00:00:00.000Z'
    );
    const second = await store.beginDeviceAuthAttempt(
      'client-1', 'key-v1', '2026-07-04T00:00:00.000Z', '2026-07-04T00:01:00.000Z'
    );
    assert.equal(first.authVersion, 1);
    assert.equal(second.authVersion, 2);

    assert.equal(await store.settleDeviceAuthAttempt('client-1', first.authVersion, {
      outcome: 'cancelled',
      updatedAt: '2026-07-04T00:02:00.000Z',
    }), null);
    const connected = await store.settleDeviceAuthAttempt('client-1', second.authVersion, {
      outcome: 'connected',
      encryptedAuthJson: refreshedEncryptedAuthJson,
      keyVersion: 'key-v2',
      updatedAt: '2026-07-04T00:03:00.000Z',
      lastValidatedAt: '2026-07-04T00:03:00.000Z',
    });
    assert.equal(connected?.status, 'connected');
    assert.equal(connected?.authVersion, 2);
    assert.deepEqual(connected?.encryptedAuthJson, refreshedEncryptedAuthJson);

    const pending = await store.beginDeviceAuthAttempt(
      'client-1', 'key-v2', connected!.createdAt, '2026-07-04T00:04:00.000Z'
    );
    await store.disconnectConnection('client-1', '2026-07-04T00:05:00.000Z');
    assert.equal(await store.settleDeviceAuthAttempt('client-1', pending.authVersion, {
      outcome: 'connected',
      encryptedAuthJson,
      keyVersion: 'key-v1',
      updatedAt: '2026-07-04T00:06:00.000Z',
      lastValidatedAt: '2026-07-04T00:06:00.000Z',
    }), null);
    assert.equal((await store.getConnection('client-1'))?.status, 'disconnected');
  });
});

describe('CodexConnectionService durable store integration', () => {
  it('connects, restores auth, and disconnects through the PostgreSQL store', async () => {
    const store = new PostgresCodexConnectionStore(new MemoryPostgresPool());
    const service = makeDurableService(store);

    const connected = await service.connectWithDeviceAuth('client-1');
    assert.equal(connected.status, 'connected');

    const result = await service.withCodexAuth('client-1', 'run-1', async authJson => {
      assert.equal(authJson, authJsonFixture);
      return { result: 'ok' };
    });
    assert.equal(result, 'ok');

    const disconnected = await service.disconnect('client-1');
    assert.equal(disconnected.status, 'disconnected');
  });

  it('connects, restores auth, and disconnects through the Redis store', async () => {
    const store = new RedisCodexConnectionStore(new MemoryRedisClient() as any);
    const service = makeDurableService(store);

    const connected = await service.connectWithDeviceAuth('client-1');
    assert.equal(connected.status, 'connected');

    const result = await service.withCodexAuth('client-1', 'run-1', async authJson => {
      assert.equal(authJson, authJsonFixture);
      return { result: 'ok' };
    });
    assert.equal(result, 'ok');

    const disconnected = await service.disconnect('client-1');
    assert.equal(disconnected.status, 'disconnected');
  });
});

const authJsonFixture = JSON.stringify({
  OPENAI_AUTH: {
    access_token: 'fake-access-token',
    refresh_token: 'fake-refresh-token',
  },
});

class FakeDeviceAuthDriver implements CodexDeviceAuthDriver {
  async runDeviceAuth(input: {
    clientId: string;
    onDeviceCode?: (info: CodexDeviceAuthInfo) => void | Promise<void>;
  }) {
    await input.onDeviceCode?.({
      url: 'https://auth.openai.com/codex/device',
      code: 'ABCD-EFGH',
      expiresAt: '2026-07-04T00:15:00.000Z',
    });
    return {
      authJson: authJsonFixture,
      loginStatus: 'Logged in using ChatGPT',
    };
  }
}

const makeDurableService = (store: ConstructorParameters<typeof CodexConnectionService>[0]) => (
  new CodexConnectionService(
    store,
    new CodexAuthCipher('test-secret', 'key-v1'),
    new FakeDeviceAuthDriver(),
    {
      now: () => new Date('2026-07-04T00:00:00.000Z'),
      authRefreshLockTtlMs: 60_000,
    }
  )
);

type PostgresRow = {
  client_id: string;
  provider: 'codex';
  status: CodexConnectionRecord['status'];
  encrypted_auth_json: unknown;
  auth_version: number;
  key_version: string;
  created_at: string;
  updated_at: string;
  last_validated_at: string | null;
  last_used_at: string | null;
  auth_refresh_owner_id: string | null;
  auth_refresh_locked_until: string | null;
  device_auth_restore_status: CodexConnectionRecord['deviceAuthRestoreStatus'] | null;
  last_error: string | null;
};

class MemoryPostgresPool {
  readonly rows = new Map<string, PostgresRow>();
  readonly queries: string[] = [];

  async query<T = any>(sql: string, params: unknown[] = []) {
    this.queries.push(sql);
    const normalizedSql = sql.trim();
    if (normalizedSql.startsWith('SELECT')) {
      const row = this.rows.get(String(params[0]));
      return { rows: row ? [clone(row) as T] : [], rowCount: row ? 1 : 0 };
    }
    if (normalizedSql.startsWith('INSERT') && normalizedSql.includes("'pending', 1")) {
      return this.beginDeviceAuthAttempt<T>(params);
    }
    if (normalizedSql.startsWith('INSERT')) {
      const row: PostgresRow = {
        client_id: String(params[0]),
        provider: 'codex',
        status: params[1] as CodexConnectionRecord['status'],
        encrypted_auth_json: params[2] || null,
        auth_version: Number(params[3]) || 0,
        key_version: String(params[4]),
        created_at: String(params[5]),
        updated_at: String(params[6]),
        last_validated_at: params[7] ? String(params[7]) : null,
        last_used_at: params[8] ? String(params[8]) : null,
        auth_refresh_owner_id: params[9] ? String(params[9]) : null,
        auth_refresh_locked_until: params[10] ? String(params[10]) : null,
        device_auth_restore_status: params[11] as CodexConnectionRecord['deviceAuthRestoreStatus'] || null,
        last_error: params[12] ? String(params[12]) : null,
      };
      this.rows.set(row.client_id, row);
      return { rows: [clone(row) as T], rowCount: 1 };
    }
    if (normalizedSql.startsWith('DELETE')) {
      const deleted = this.rows.delete(String(params[0]));
      return { rows: [], rowCount: deleted ? 1 : 0 };
    }
    if (normalizedSql.startsWith('UPDATE codex_connections') && normalizedSql.includes("status = 'disconnected'")) {
      return this.disconnect<T>(params);
    }
    if (normalizedSql.startsWith('UPDATE codex_connections') && normalizedSql.includes("AND status = 'pending'")) {
      return this.settleDeviceAuthAttempt<T>(normalizedSql, params);
    }
    if (normalizedSql.startsWith('UPDATE codex_connections') && normalizedSql.includes('auth_version = auth_version + 1')) {
      return this.compareAndSwapAuth<T>(params);
    }
    if (normalizedSql.startsWith('UPDATE codex_connections') && normalizedSql.includes("status = 'reauth_required'")) {
      return this.markReauthRequired<T>(params);
    }
    if (normalizedSql.startsWith('UPDATE codex_connections') && normalizedSql.includes('auth_refresh_owner_id = NULL')) {
      return this.releaseLease<T>(params);
    }
    if (normalizedSql.startsWith('UPDATE codex_connections') && normalizedSql.includes('auth_refresh_owner_id = $2')) {
      return this.acquireLease<T>(params);
    }
    if (normalizedSql.startsWith('UPDATE codex_connections') && normalizedSql.includes('last_used_at = $3')) {
      return this.touch<T>(params);
    }
    throw new Error(`Unhandled SQL in test: ${sql}`);
  }

  private compareAndSwapAuth<T>(params: unknown[]) {
    const clientId = String(params[0]);
    const expectedAuthVersion = Number(params[1]);
    const row = this.rows.get(clientId);
    if (!row || !['connected', 'reauth_required'].includes(row.status) || row.auth_version !== expectedAuthVersion) {
      return { rows: [], rowCount: 0 };
    }
    row.encrypted_auth_json = params[2];
    row.status = 'connected';
    row.auth_version += 1;
    row.key_version = String(params[3]);
    row.updated_at = String(params[4]);
    row.last_used_at = String(params[5]);
    if (params[6]) row.last_validated_at = String(params[6]);
    row.last_error = null;
    return { rows: [clone(row) as T], rowCount: 1 };
  }

  private beginDeviceAuthAttempt<T>(params: unknown[]) {
    const [clientIdValue, keyVersionValue, createdAtValue, updatedAtValue] = params.map(String);
    const existing = this.rows.get(clientIdValue);
    if (existing) {
      existing.device_auth_restore_status = existing.status === 'pending'
        ? existing.device_auth_restore_status || 'disconnected'
        : existing.status;
      existing.status = 'pending';
      existing.auth_version += 1;
      existing.key_version = keyVersionValue;
      existing.updated_at = updatedAtValue;
      existing.auth_refresh_owner_id = null;
      existing.auth_refresh_locked_until = null;
      return { rows: [clone(existing) as T], rowCount: 1 };
    }
    const created: PostgresRow = {
      client_id: clientIdValue,
      provider: 'codex',
      status: 'pending',
      encrypted_auth_json: null,
      auth_version: 1,
      key_version: keyVersionValue,
      created_at: createdAtValue,
      updated_at: updatedAtValue,
      last_validated_at: null,
      last_used_at: null,
      auth_refresh_owner_id: null,
      auth_refresh_locked_until: null,
      device_auth_restore_status: 'disconnected',
      last_error: null,
    };
    this.rows.set(clientIdValue, created);
    return { rows: [clone(created) as T], rowCount: 1 };
  }

  private settleDeviceAuthAttempt<T>(sql: string, params: unknown[]) {
    const clientId = String(params[0]);
    const expectedAuthVersion = Number(params[1]);
    const row = this.rows.get(clientId);
    if (!row || row.status !== 'pending' || row.auth_version !== expectedAuthVersion) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SET status = 'connected'")) {
      row.status = 'connected';
      row.encrypted_auth_json = params[2];
      row.key_version = String(params[3]);
      row.updated_at = String(params[4]);
      row.last_validated_at = String(params[5]);
      row.last_error = null;
    } else if (sql.includes("SET status = 'reauth_required'")) {
      row.status = 'reauth_required';
      row.updated_at = String(params[2]);
      row.last_error = String(params[3]);
    } else {
      row.status = row.device_auth_restore_status || 'disconnected';
      row.updated_at = String(params[2]);
    }
    row.auth_refresh_owner_id = null;
    row.auth_refresh_locked_until = null;
    row.device_auth_restore_status = null;
    return { rows: [clone(row) as T], rowCount: 1 };
  }

  private disconnect<T>(params: unknown[]) {
    const clientId = String(params[0]);
    const row = this.rows.get(clientId);
    if (!row) return { rows: [], rowCount: 0 };
    row.status = 'disconnected';
    row.encrypted_auth_json = null;
    row.auth_version += 1;
    row.updated_at = String(params[1]);
    row.auth_refresh_owner_id = null;
    row.auth_refresh_locked_until = null;
    row.device_auth_restore_status = null;
    row.last_error = null;
    return { rows: [clone(row) as T], rowCount: 1 };
  }

  private markReauthRequired<T>(params: unknown[]) {
    const clientId = String(params[0]);
    const expectedAuthVersion = Number(params[1]);
    const row = this.rows.get(clientId);
    if (!row || row.status !== 'connected' || row.auth_version !== expectedAuthVersion) {
      return { rows: [], rowCount: 0 };
    }
    row.status = 'reauth_required';
    row.updated_at = String(params[2]);
    row.last_used_at = String(params[3]);
    row.last_error = String(params[4]);
    row.auth_refresh_owner_id = null;
    row.auth_refresh_locked_until = null;
    return { rows: [clone(row) as T], rowCount: 1 };
  }

  private acquireLease<T>(params: unknown[]) {
    const [clientId, ownerId, lockedUntil, now] = params.map(String);
    const row = this.rows.get(clientId);
    if (!row || row.status !== 'connected' || !row.encrypted_auth_json) {
      return { rows: [], rowCount: 0 };
    }
    if (
      row.auth_refresh_owner_id &&
      row.auth_refresh_locked_until &&
      row.auth_refresh_locked_until > now &&
      row.auth_refresh_owner_id !== ownerId
    ) {
      return { rows: [], rowCount: 0 };
    }
    row.auth_refresh_owner_id = ownerId;
    row.auth_refresh_locked_until = lockedUntil;
    return { rows: [clone(row) as T], rowCount: 1 };
  }

  private releaseLease<T>(params: unknown[]) {
    const [clientId, ownerId, now] = params.map(String);
    const row = this.rows.get(clientId);
    if (!row || row.auth_refresh_owner_id !== ownerId) {
      return { rows: [], rowCount: 0 };
    }
    row.auth_refresh_owner_id = null;
    row.auth_refresh_locked_until = null;
    row.updated_at = now;
    return { rows: [clone(row) as T], rowCount: 1 };
  }

  private touch<T>(params: unknown[]) {
    const clientId = String(params[0]);
    const expectedAuthVersion = Number(params[1]);
    const row = this.rows.get(clientId);
    if (!row || row.status !== 'connected' || row.auth_version !== expectedAuthVersion) {
      return { rows: [], rowCount: 0 };
    }
    row.updated_at = String(params[2]);
    row.last_used_at = String(params[2]);
    if (params[3]) row.last_validated_at = String(params[3]);
    return { rows: [clone(row) as T], rowCount: 1 };
  }
}

class MemoryRedisClient {
  private readonly hashes = new Map<string, Map<string, string>>();

  async hGet(key: string, field: string) {
    return this.hashes.get(key)?.get(field) || null;
  }

  async hSet(key: string, field: string, value: string) {
    const hash = this.hashes.get(key) || new Map<string, string>();
    const existed = hash.has(field);
    hash.set(field, value);
    this.hashes.set(key, hash);
    return existed ? 0 : 1;
  }

  async hDel(key: string, field: string) {
    return this.hashes.get(key)?.delete(field) ? 1 : 0;
  }

  async eval(script: string, options: { keys: string[]; arguments: string[] }) {
    if (script.includes("record['deviceAuthRestoreStatus'] = record['status']")) {
      return this.beginDeviceAuthAttempt(options.keys[0], options.arguments);
    }
    if (script.includes("ARGV[3] == 'connected'")) {
      return this.settleDeviceAuthAttempt(options.keys[0], options.arguments);
    }
    if (script.includes("record['status'] = 'disconnected'")) {
      return this.disconnect(options.keys[0], options.arguments);
    }
    if (script.includes("record['authVersion'] = tonumber")) {
      return this.compareAndSwapAuth(options.keys[0], options.arguments);
    }
    if (script.includes("record['status'] = 'reauth_required'")) {
      return this.markReauthRequired(options.keys[0], options.arguments);
    }
    if (script.includes("record['lastUsedAt'] = ARGV[3]")) {
      return this.touch(options.keys[0], options.arguments);
    }
    if (script.includes("record['authRefreshOwnerId'] = nil")) {
      return this.releaseLease(options.keys[0], options.arguments);
    }
    return this.acquireLease(options.keys[0], options.arguments);
  }

  private async compareAndSwapAuth(key: string, args: string[]) {
    const [clientId, expectedAuthVersion, encryptedAuthJson, keyVersion, updatedAt, lastUsedAt, lastValidatedAt] = args;
    const raw = await this.hGet(key, clientId);
    if (!raw) {
      return '';
    }
    let record: CodexConnectionRecord;
    try {
      record = JSON.parse(raw) as CodexConnectionRecord;
    } catch {
      return '';
    }
    if (!['connected', 'reauth_required'].includes(record.status) || record.authVersion !== Number(expectedAuthVersion)) {
      return '';
    }
    const next = {
      ...record,
      status: 'connected' as const,
      encryptedAuthJson: JSON.parse(encryptedAuthJson),
      authVersion: record.authVersion + 1,
      keyVersion,
      updatedAt,
      lastUsedAt,
      ...(lastValidatedAt ? { lastValidatedAt } : {}),
      lastError: undefined,
    };
    await this.hSet(key, clientId, JSON.stringify(next));
    return JSON.stringify(next);
  }

  private async beginDeviceAuthAttempt(key: string, args: string[]) {
    const [clientId, keyVersion, createdAt, updatedAt] = args;
    const raw = await this.hGet(key, clientId);
    const existing = raw ? JSON.parse(raw) as CodexConnectionRecord : undefined;
    const next: CodexConnectionRecord = {
      ...(existing || {
        clientId,
        provider: 'codex' as const,
        createdAt,
      }),
      status: 'pending',
      authVersion: (existing?.authVersion || 0) + 1,
      keyVersion,
      updatedAt,
      authRefreshOwnerId: undefined,
      authRefreshLockedUntil: undefined,
      deviceAuthRestoreStatus: existing?.status === 'pending'
        ? existing.deviceAuthRestoreStatus || 'disconnected'
        : existing?.status || 'disconnected',
    };
    await this.hSet(key, clientId, JSON.stringify(next));
    return JSON.stringify(next);
  }

  private async settleDeviceAuthAttempt(key: string, args: string[]) {
    const [clientId, expectedAuthVersion, outcome, updatedAt, encryptedAuthJson, keyVersion, lastValidatedAt, lastError] = args;
    const raw = await this.hGet(key, clientId);
    if (!raw) return '';
    const record = JSON.parse(raw) as CodexConnectionRecord;
    if (record.status !== 'pending' || record.authVersion !== Number(expectedAuthVersion)) return '';
    const next: CodexConnectionRecord = {
      ...record,
      status: outcome === 'connected'
        ? 'connected'
        : outcome === 'failed'
          ? 'reauth_required'
          : record.deviceAuthRestoreStatus || 'disconnected',
      updatedAt,
      ...(outcome === 'connected' ? {
        encryptedAuthJson: JSON.parse(encryptedAuthJson),
        keyVersion,
        lastValidatedAt,
      } : {}),
      authRefreshOwnerId: undefined,
      authRefreshLockedUntil: undefined,
      deviceAuthRestoreStatus: undefined,
      lastError: outcome === 'failed' ? lastError : undefined,
    };
    await this.hSet(key, clientId, JSON.stringify(next));
    return JSON.stringify(next);
  }

  private async disconnect(key: string, args: string[]) {
    const [clientId, updatedAt] = args;
    const raw = await this.hGet(key, clientId);
    if (!raw) return '';
    const record = JSON.parse(raw) as CodexConnectionRecord;
    const next = {
      ...record,
      status: 'disconnected' as const,
      encryptedAuthJson: undefined,
      authVersion: record.authVersion + 1,
      updatedAt,
      authRefreshOwnerId: undefined,
      authRefreshLockedUntil: undefined,
      deviceAuthRestoreStatus: undefined,
      lastError: undefined,
    };
    await this.hSet(key, clientId, JSON.stringify(next));
    return JSON.stringify(next);
  }

  private async markReauthRequired(key: string, args: string[]) {
    const [clientId, expectedAuthVersion, updatedAt, lastUsedAt, lastError] = args;
    const raw = await this.hGet(key, clientId);
    if (!raw) return '';
    const record = JSON.parse(raw) as CodexConnectionRecord;
    if (record.status !== 'connected' || record.authVersion !== Number(expectedAuthVersion)) {
      return '';
    }
    const next = {
      ...record,
      status: 'reauth_required' as const,
      updatedAt,
      lastUsedAt,
      lastError,
      authRefreshOwnerId: undefined,
      authRefreshLockedUntil: undefined,
    };
    await this.hSet(key, clientId, JSON.stringify(next));
    return JSON.stringify(next);
  }

  private async touch(key: string, args: string[]) {
    const [clientId, expectedAuthVersion, lastUsedAt, lastValidatedAt] = args;
    const raw = await this.hGet(key, clientId);
    if (!raw) {
      return '';
    }
    const record = JSON.parse(raw) as CodexConnectionRecord;
    if (record.status !== 'connected' || record.authVersion !== Number(expectedAuthVersion)) {
      return '';
    }
    const next = {
      ...record,
      updatedAt: lastUsedAt,
      lastUsedAt,
      ...(lastValidatedAt ? { lastValidatedAt } : {}),
    };
    await this.hSet(key, clientId, JSON.stringify(next));
    return JSON.stringify(next);
  }

  private async acquireLease(key: string, args: string[]) {
    const [clientId, ownerId, lockedUntil, now] = args;
    const raw = await this.hGet(key, clientId);
    if (!raw) {
      return '';
    }
    let record: CodexConnectionRecord;
    try {
      record = JSON.parse(raw) as CodexConnectionRecord;
    } catch {
      return '';
    }
    if (record.status !== 'connected' || !record.encryptedAuthJson) {
      return '';
    }
    if (
      record.authRefreshOwnerId &&
      record.authRefreshLockedUntil &&
      record.authRefreshLockedUntil > now &&
      record.authRefreshOwnerId !== ownerId
    ) {
      return '';
    }
    const next = {
      ...record,
      authRefreshOwnerId: ownerId,
      authRefreshLockedUntil: lockedUntil,
    };
    await this.hSet(key, clientId, JSON.stringify(next));
    return JSON.stringify(next);
  }

  private async releaseLease(key: string, args: string[]) {
    const [clientId, ownerId, now] = args;
    const raw = await this.hGet(key, clientId);
    if (!raw) {
      return '';
    }
    const record = JSON.parse(raw) as CodexConnectionRecord;
    if (record.authRefreshOwnerId !== ownerId) {
      return raw;
    }
    const next = {
      ...record,
      authRefreshOwnerId: undefined,
      authRefreshLockedUntil: undefined,
      updatedAt: now,
    };
    await this.hSet(key, clientId, JSON.stringify(next));
    return JSON.stringify(next);
  }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
