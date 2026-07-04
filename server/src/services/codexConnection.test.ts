import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CodexAuthCipher,
  CodexConnectionError,
  CodexConnectionService,
  CodexDeviceAuthDriver,
  CodexDeviceAuthInfo,
  InMemoryCodexConnectionStore,
} from './codexConnection';

const authJson = JSON.stringify({
  OPENAI_AUTH: {
    access_token: 'secret-access-token',
    refresh_token: 'secret-refresh-token',
  },
});

class FakeDeviceAuthDriver implements CodexDeviceAuthDriver {
  calls = 0;
  fail = false;
  authJson = authJson;
  loginStatus = 'Logged in using ChatGPT';
  deviceInfo: CodexDeviceAuthInfo = {
    url: 'https://auth.openai.com/codex/device',
    code: 'ABCD-EFGH',
    expiresAt: '2026-07-04T00:15:00.000Z',
  };

  async runDeviceAuth(input: {
    clientId: string;
    onDeviceCode?: (info: CodexDeviceAuthInfo) => void | Promise<void>;
  }) {
    this.calls += 1;
    await input.onDeviceCode?.(this.deviceInfo);
    if (this.fail) {
      throw new Error('device auth failed');
    }
    return {
      authJson: this.authJson,
      loginStatus: this.loginStatus,
    };
  }
}

const makeService = (options: {
  driver?: FakeDeviceAuthDriver;
  now?: Date;
  lockTtlMs?: number;
} = {}) => {
  let current = options.now || new Date('2026-07-04T00:00:00.000Z');
  const store = new InMemoryCodexConnectionStore();
  const driver = options.driver || new FakeDeviceAuthDriver();
  const service = new CodexConnectionService(
    store,
    new CodexAuthCipher('test-secret', 'test-key-v1'),
    driver,
    {
      lockTtlMs: options.lockTtlMs || 60_000,
      now: () => current,
    }
  );
  return {
    store,
    driver,
    service,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
};

describe('Codex auth cipher', () => {
  it('encrypts auth JSON without storing plaintext and decrypts it with the same key', () => {
    const cipher = new CodexAuthCipher('test-secret', 'key-1');
    const encrypted = cipher.encryptAuthJson(authJson);

    assert.equal(encrypted.algorithm, 'aes-256-gcm');
    assert.equal(encrypted.keyVersion, 'key-1');
    assert.doesNotMatch(encrypted.ciphertext, /secret-access-token/);
    assert.equal(cipher.decryptAuthJson(encrypted), authJson);
  });

  it('requires an encryption secret', () => {
    assert.throws(() => new CodexAuthCipher('', 'key-1'), (error: unknown) => (
      error instanceof CodexConnectionError && error.code === 'auth_secret_missing'
    ));
  });

  it('does not decrypt with a different key', () => {
    const encrypted = new CodexAuthCipher('secret-a', 'key-1').encryptAuthJson(authJson);

    assert.throws(() => new CodexAuthCipher('secret-b', 'key-1').decryptAuthJson(encrypted), (error: unknown) => (
      error instanceof CodexConnectionError && error.code === 'auth_decrypt_failed'
    ));
  });
});

describe('Codex connection service', () => {
  it('connects with device auth, stores encrypted auth, and returns public status only', async () => {
    const { service, store, driver } = makeService();
    const deviceCodes: CodexDeviceAuthInfo[] = [];

    const status = await service.connectWithDeviceAuth('client-1', info => {
      deviceCodes.push(info);
    });

    assert.equal(driver.calls, 1);
    assert.deepEqual(deviceCodes, [driver.deviceInfo]);
    assert.equal(status.status, 'connected');
    assert.equal(status.provider, 'codex');
    assert.equal(status.authVersion, 1);
    assert.equal(status.lastValidatedAt, '2026-07-04T00:00:00.000Z');
    assert.equal(JSON.stringify(status).includes('secret-access-token'), false);

    const stored = await store.getConnection('client-1');
    assert.equal(stored?.status, 'connected');
    assert.equal(stored?.encryptedAuthJson?.keyVersion, 'test-key-v1');
    assert.equal(JSON.stringify(stored).includes('secret-access-token'), false);
  });

  it('marks the connection as requiring reauth when device auth fails', async () => {
    const driver = new FakeDeviceAuthDriver();
    driver.fail = true;
    const { service, store } = makeService({ driver });

    await assert.rejects(
      () => service.connectWithDeviceAuth('client-1'),
      (error: unknown) => error instanceof CodexConnectionError && error.code === 'device_auth_failed'
    );

    const stored = await store.getConnection('client-1');
    assert.equal(stored?.status, 'reauth_required');
    assert.equal(stored?.lastError, 'Codex device auth failed');
    assert.equal(stored?.encryptedAuthJson, undefined);
  });

  it('disconnects by removing the stored auth record', async () => {
    const { service, store } = makeService();
    await service.connectWithDeviceAuth('client-1');

    const status = await service.disconnect('client-1');

    assert.equal(status.status, 'disconnected');
    assert.equal(await store.getConnection('client-1'), null);
  });

  it('runs work with decrypted auth, saves refreshed auth, and releases the lock', async () => {
    const { service, store } = makeService();
    await service.connectWithDeviceAuth('client-1');
    const refreshedAuthJson = authJson.replace('secret-access-token', 'refreshed-access-token');

    const result = await service.withCodexAuth('client-1', 'run-1', async decrypted => {
      assert.equal(decrypted, authJson);
      return {
        result: 'ok',
        refreshedAuthJson,
        loginStatus: 'Logged in using ChatGPT',
      };
    });

    assert.equal(result, 'ok');
    const stored = await store.getConnection('client-1');
    assert.equal(stored?.authVersion, 2);
    assert.equal(stored?.activeRunId, undefined);
    assert.equal(stored?.lockedUntil, undefined);
    assert.equal(stored?.lastUsedAt, '2026-07-04T00:00:00.000Z');

    const secondResult = await service.withCodexAuth('client-1', 'run-2', async decrypted => {
      assert.equal(decrypted, refreshedAuthJson);
      return { result: 'ok-again' };
    });
    assert.equal(secondResult, 'ok-again');
  });

  it('rejects concurrent runs for the same connected client', async () => {
    const { service } = makeService();
    await service.connectWithDeviceAuth('client-1');

    const result = await service.withCodexAuth('client-1', 'run-1', async () => {
      await assert.rejects(
        () => service.withCodexAuth('client-1', 'run-2', async () => ({ result: 'unexpected' })),
        (error: unknown) => error instanceof CodexConnectionError && error.code === 'connection_locked'
      );
      return { result: 'locked' };
    });

    assert.equal(result, 'locked');
  });

  it('does not allow work for missing or not-ready connections', async () => {
    const { service, store } = makeService();

    await assert.rejects(
      () => service.withCodexAuth('missing-client', 'run-1', async () => ({ result: 'unexpected' })),
      (error: unknown) => error instanceof CodexConnectionError && error.code === 'connection_not_found'
    );

    await store.saveConnection({
      clientId: 'client-1',
      provider: 'codex',
      status: 'reauth_required',
      authVersion: 0,
      keyVersion: 'test-key-v1',
      createdAt: '2026-07-04T00:00:00.000Z',
      updatedAt: '2026-07-04T00:00:00.000Z',
    });

    await assert.rejects(
      () => service.withCodexAuth('client-1', 'run-1', async () => ({ result: 'unexpected' })),
      (error: unknown) => error instanceof CodexConnectionError && error.code === 'connection_not_ready'
    );
  });
});
