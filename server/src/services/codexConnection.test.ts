import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CodexAuthCipher,
  CodexConnectionError,
  CodexConnectionService,
  CodexDeviceAuthDriver,
  CodexDeviceAuthInfo,
  InMemoryCodexConnectionStore,
  summarizeCodexAuthAccount,
} from './codexConnection';

const fakeJwt = (claims: Record<string, unknown>) => (
  [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'signature',
  ].join('.')
);

const authJson = JSON.stringify({
  tokens: {
    access_token: 'secret-access-token',
    refresh_token: 'secret-refresh-token',
    account_id: 'acct_token',
    id_token: fakeJwt({
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      sub: 'user_sub',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_claim',
        chatgpt_plan_type: 'pro',
        chatgpt_user_id: 'user_claim',
      },
    }),
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

class DeferredDeviceAuthDriver implements CodexDeviceAuthDriver {
  readonly started: Promise<void>;
  private reportStarted: () => void = () => undefined;
  private readonly result: Promise<{ authJson: string; loginStatus: string }>;
  private resolveResult: (result: { authJson: string; loginStatus: string }) => void = () => undefined;
  private rejectResult: (error: unknown) => void = () => undefined;

  constructor() {
    this.started = new Promise(resolve => {
      this.reportStarted = resolve;
    });
    this.result = new Promise((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
  }

  async runDeviceAuth(input: {
    clientId: string;
    onDeviceCode?: (info: CodexDeviceAuthInfo) => void | Promise<void>;
    signal?: AbortSignal;
  }) {
    await input.onDeviceCode?.({
      url: 'https://auth.openai.com/codex/device',
      code: 'ABCD-EFGH',
    });
    this.reportStarted();
    return this.result;
  }

  succeed(nextAuthJson: string) {
    this.resolveResult({ authJson: nextAuthJson, loginStatus: 'Logged in using ChatGPT' });
  }

  fail() {
    this.rejectResult(new Error('device auth failed'));
  }

  cancel() {
    this.rejectResult(new CodexConnectionError('device auth cancelled', 'device_auth_cancelled'));
  }
}

const makeServiceForStore = (
  store: InMemoryCodexConnectionStore,
  driver: CodexDeviceAuthDriver
) => new CodexConnectionService(
  store,
  new CodexAuthCipher('test-secret', 'test-key-v1'),
  driver,
  { now: () => new Date('2026-07-04T00:00:00.000Z') }
);

const makeService = (options: {
  driver?: FakeDeviceAuthDriver;
  now?: Date;
  fetch?: typeof globalThis.fetch;
  createId?: () => string;
  authRefreshPollMs?: number;
} = {}) => {
  let current = options.now || new Date('2026-07-04T00:00:00.000Z');
  const store = new InMemoryCodexConnectionStore();
  const driver = options.driver || new FakeDeviceAuthDriver();
  const service = new CodexConnectionService(
    store,
    new CodexAuthCipher('test-secret', 'test-key-v1'),
    driver,
    {
      authRefreshLockTtlMs: 5_000,
      authRefreshWaitMs: 1_000,
      authRefreshPollMs: options.authRefreshPollMs || 10,
      fetch: options.fetch,
      createId: options.createId,
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
  it('summarizes the connected ChatGPT account without exposing token material', () => {
    const summary = summarizeCodexAuthAccount(authJson);

    assert.deepEqual(summary, {
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      accountId: 'acct_token',
      userId: 'user_claim',
      planType: 'pro',
    });
    assert.equal(JSON.stringify(summary).includes('secret-access-token'), false);
    assert.equal(JSON.stringify(summary).includes('secret-refresh-token'), false);
  });

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
    assert.deepEqual(status.account, {
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      accountId: 'acct_token',
      userId: 'user_claim',
      planType: 'pro',
    });
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

  it('cancels only the requested device-auth generation', async () => {
    const store = new InMemoryCodexConnectionStore();
    const oldDriver = new DeferredDeviceAuthDriver();
    const newDriver = new DeferredDeviceAuthDriver();
    const oldService = makeServiceForStore(store, oldDriver);
    const newService = makeServiceForStore(store, newDriver);
    let oldAuthVersion = 0;
    let newAuthVersion = 0;
    const oldAttempt = oldService.connectWithDeviceAuth('client-1', undefined, {
      onAttemptStarted: authVersion => {
        oldAuthVersion = authVersion;
      },
    });
    await oldDriver.started;
    const newAttempt = newService.connectWithDeviceAuth('client-1', undefined, {
      onAttemptStarted: authVersion => {
        newAuthVersion = authVersion;
      },
    });
    await newDriver.started;

    assert.equal(oldAuthVersion, 1);
    assert.equal(newAuthVersion, 2);
    assert.equal(await oldService.cancelDeviceAuthAttempt('client-1', oldAuthVersion), false);
    assert.equal((await newService.getConnectionStatus('client-1')).status, 'pending');
    assert.equal((await newService.getConnectionStatus('client-1')).authVersion, 2);
    assert.equal(await newService.cancelDeviceAuthAttempt('client-1', newAuthVersion), true);
    assert.equal((await newService.getConnectionStatus('client-1')).status, 'disconnected');

    oldDriver.succeed(authJson);
    newDriver.succeed(authJson);
    await assert.rejects(oldAttempt, (error: unknown) => (
      error instanceof CodexConnectionError && error.code === 'device_auth_cancelled'
    ));
    await assert.rejects(newAttempt, (error: unknown) => (
      error instanceof CodexConnectionError && error.code === 'device_auth_cancelled'
    ));
  });

  it('does not let an old device-auth success revive credentials after disconnect', async () => {
    const store = new InMemoryCodexConnectionStore();
    const driver = new DeferredDeviceAuthDriver();
    const service = makeServiceForStore(store, driver);
    const oldAttempt = service.connectWithDeviceAuth('client-1');
    await driver.started;

    const disconnected = await service.disconnect('client-1');
    assert.equal(disconnected.authVersion, 2);
    driver.succeed(authJson);

    await assert.rejects(oldAttempt, (error: unknown) => (
      error instanceof CodexConnectionError && error.code === 'device_auth_cancelled'
    ));
    const stored = await store.getConnection('client-1');
    assert.equal(stored?.status, 'disconnected');
    assert.equal(stored?.authVersion, 2);
    assert.equal(stored?.encryptedAuthJson, undefined);
  });

  it('does not let an old device-auth failure overwrite disconnect', async () => {
    const store = new InMemoryCodexConnectionStore();
    const driver = new DeferredDeviceAuthDriver();
    const service = makeServiceForStore(store, driver);
    const oldAttempt = service.connectWithDeviceAuth('client-1');
    await driver.started;

    await service.disconnect('client-1');
    driver.fail();

    await assert.rejects(oldAttempt, (error: unknown) => (
      error instanceof CodexConnectionError && error.code === 'device_auth_cancelled'
    ));
    const stored = await store.getConnection('client-1');
    assert.equal(stored?.status, 'disconnected');
    assert.equal(stored?.lastError, undefined);
  });

  it('does not let an old device-auth cancellation overwrite disconnect', async () => {
    const store = new InMemoryCodexConnectionStore();
    const driver = new DeferredDeviceAuthDriver();
    const service = makeServiceForStore(store, driver);
    const oldAttempt = service.connectWithDeviceAuth('client-1');
    await driver.started;

    await service.disconnect('client-1');
    driver.cancel();

    await assert.rejects(oldAttempt, (error: unknown) => (
      error instanceof CodexConnectionError && error.code === 'device_auth_cancelled'
    ));
    const stored = await store.getConnection('client-1');
    assert.equal(stored?.status, 'disconnected');
    assert.equal(stored?.authVersion, 2);
  });

  it('does not let an old device-auth cancellation roll back a newer attempt', async () => {
    const store = new InMemoryCodexConnectionStore();
    const oldDriver = new DeferredDeviceAuthDriver();
    const newDriver = new DeferredDeviceAuthDriver();
    const oldService = makeServiceForStore(store, oldDriver);
    const newService = makeServiceForStore(store, newDriver);
    const oldAttempt = oldService.connectWithDeviceAuth('client-1');
    await oldDriver.started;
    const newAttempt = newService.connectWithDeviceAuth('client-1');
    await newDriver.started;

    oldDriver.cancel();
    await assert.rejects(oldAttempt, (error: unknown) => (
      error instanceof CodexConnectionError && error.code === 'device_auth_cancelled'
    ));
    const pending = await store.getConnection('client-1');
    assert.equal(pending?.status, 'pending');
    assert.equal(pending?.authVersion, 2);

    const newAuthJson = authJson.replace('secret-access-token', 'new-access-token');
    newDriver.succeed(newAuthJson);
    const connected = await newAttempt;
    assert.equal(connected.status, 'connected');
    assert.equal(connected.authVersion, 2);
  });

  it('lets only the newest cross-instance device-auth attempt publish credentials', async () => {
    const store = new InMemoryCodexConnectionStore();
    const oldDriver = new DeferredDeviceAuthDriver();
    const newDriver = new DeferredDeviceAuthDriver();
    const oldService = makeServiceForStore(store, oldDriver);
    const newService = makeServiceForStore(store, newDriver);
    const oldAttempt = oldService.connectWithDeviceAuth('client-1');
    await oldDriver.started;
    const newAttempt = newService.connectWithDeviceAuth('client-1');
    await newDriver.started;

    const newAuthJson = authJson.replace('secret-access-token', 'new-access-token');
    newDriver.succeed(newAuthJson);
    assert.equal((await newAttempt).authVersion, 2);

    oldDriver.succeed(authJson.replace('secret-access-token', 'stale-access-token'));
    await assert.rejects(oldAttempt, (error: unknown) => (
      error instanceof CodexConnectionError && error.code === 'device_auth_cancelled'
    ));
    await newService.withCodexAuth('client-1', 'current-run', async currentAuth => {
      assert.equal(currentAuth, newAuthJson);
      return { result: undefined };
    });
  });

  it('disconnects by clearing auth while preserving a monotonic connection version', async () => {
    const { service, store } = makeService();
    await service.connectWithDeviceAuth('client-1');

    const status = await service.disconnect('client-1');

    assert.equal(status.status, 'disconnected');
    assert.equal(status.authVersion, 2);
    const stored = await store.getConnection('client-1');
    assert.equal(stored?.status, 'disconnected');
    assert.equal(stored?.authVersion, 2);
    assert.equal(stored?.encryptedAuthJson, undefined);
  });

  it('runs work with decrypted auth and saves changed auth with a versioned update', async () => {
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
    assert.equal(stored?.authRefreshOwnerId, undefined);
    assert.equal(stored?.authRefreshLockedUntil, undefined);
    assert.equal(stored?.lastUsedAt, '2026-07-04T00:00:00.000Z');

    const secondResult = await service.withCodexAuth('client-1', 'run-2', async decrypted => {
      assert.equal(decrypted, refreshedAuthJson);
      return { result: 'ok-again' };
    });
    assert.equal(secondResult, 'ok-again');
  });

  it('allows concurrent runs for the same connected client', async () => {
    const { service } = makeService();
    await service.connectWithDeviceAuth('client-1');

    const result = await service.withCodexAuth('client-1', 'run-1', async decrypted => {
      assert.equal(decrypted, authJson);
      const concurrent = await service.withCodexAuth('client-1', 'run-2', async concurrentAuth => {
        assert.equal(concurrentAuth, authJson);
        return { result: 'concurrent' };
      });
      return { result: concurrent };
    });

    assert.equal(result, 'concurrent');
  });

  it('does not increment authVersion when the runner only copies unchanged credentials', async () => {
    const { service, store } = makeService();
    await service.connectWithDeviceAuth('client-1');

    await service.withCodexAuth('client-1', 'run-1', async () => ({
      result: undefined,
      refreshedAuthJson: JSON.stringify(JSON.parse(authJson)),
    }));

    assert.equal((await store.getConnection('client-1'))?.authVersion, 1);
  });

  it('marks the exact failing auth version as requiring a new sign-in', async () => {
    const { service, store } = makeService();
    await service.connectWithDeviceAuth('client-1');

    const result = await service.withCodexAuth('client-1', 'run-1', async () => ({
      result: 'failed turn',
      reauthRequired: true,
    }));

    assert.equal(result, 'failed turn');
    const stored = await store.getConnection('client-1');
    assert.equal(stored?.status, 'reauth_required');
    assert.equal(stored?.authVersion, 1);
    assert.equal(stored?.lastError, 'Codex sign-in expired');
  });

  it('does not let a stale concurrent auth write overwrite a newer version', async () => {
    const { service } = makeService();
    await service.connectWithDeviceAuth('client-1');
    const firstRefresh = authJson.replace('secret-access-token', 'first-access-token');
    const secondRefresh = authJson.replace('secret-access-token', 'second-access-token');

    await service.withCodexAuth('client-1', 'run-1', async () => {
      await service.withCodexAuth('client-1', 'run-2', async () => ({
        result: undefined,
        refreshedAuthJson: secondRefresh,
      }));
      return { result: undefined, refreshedAuthJson: firstRefresh };
    });

    await service.withCodexAuth('client-1', 'run-3', async currentAuth => {
      assert.equal(currentAuth, secondRefresh);
      return { result: undefined };
    });
  });

  it('does not let stale work mark a newly reconnected credential as expired', async () => {
    const driver = new FakeDeviceAuthDriver();
    const { service, store } = makeService({ driver });
    await service.connectWithDeviceAuth('client-1');
    let releaseStaleWork: () => void = () => {};
    let reportStaleWorkStarted: () => void = () => {};
    const staleWorkMayFinish = new Promise<void>(resolve => {
      releaseStaleWork = resolve;
    });
    const staleWorkStarted = new Promise<void>(resolve => {
      reportStaleWorkStarted = resolve;
    });
    const staleRun = service.withCodexAuth('client-1', 'stale-run', async () => {
      reportStaleWorkStarted();
      await staleWorkMayFinish;
      return { result: 'stale failure', reauthRequired: true };
    });
    await staleWorkStarted;

    await service.disconnect('client-1');
    driver.authJson = authJson.replace('secret-access-token', 'new-access-token');
    const reconnected = await service.connectWithDeviceAuth('client-1');
    assert.equal(reconnected.authVersion, 3);

    releaseStaleWork();
    assert.equal(await staleRun, 'stale failure');
    const stored = await store.getConnection('client-1');
    assert.equal(stored?.status, 'connected');
    assert.equal(stored?.authVersion, 3);
    await service.withCodexAuth('client-1', 'current-run', async currentAuth => {
      assert.equal(currentAuth, driver.authJson);
      return { result: undefined };
    });
  });

  it('does not let a stale refreshed credential overwrite a reconnect', async () => {
    const driver = new FakeDeviceAuthDriver();
    const { service, store } = makeService({ driver });
    await service.connectWithDeviceAuth('client-1');
    let releaseStaleWork: () => void = () => {};
    let reportStaleWorkStarted: () => void = () => {};
    const staleWorkMayFinish = new Promise<void>(resolve => {
      releaseStaleWork = resolve;
    });
    const staleWorkStarted = new Promise<void>(resolve => {
      reportStaleWorkStarted = resolve;
    });
    const staleRun = service.withCodexAuth('client-1', 'stale-run', async () => {
      reportStaleWorkStarted();
      await staleWorkMayFinish;
      return {
        result: 'stale success',
        refreshedAuthJson: authJson.replace('secret-access-token', 'stale-refreshed-token'),
      };
    });
    await staleWorkStarted;

    await service.disconnect('client-1');
    driver.authJson = authJson.replace('secret-access-token', 'new-access-token');
    await service.connectWithDeviceAuth('client-1');

    releaseStaleWork();
    assert.equal(await staleRun, 'stale success');
    const stored = await store.getConnection('client-1');
    assert.equal(stored?.status, 'connected');
    assert.equal(stored?.authVersion, 3);
    await service.withCodexAuth('client-1', 'current-run', async currentAuth => {
      assert.equal(currentAuth, driver.authJson);
      return { result: undefined };
    });
  });

  it('lets a successful same-version refresh recover from a concurrent auth failure', async () => {
    const { service, store } = makeService();
    await service.connectWithDeviceAuth('client-1');
    const refreshed = authJson.replace('secret-access-token', 'recovered-access-token');
    let releaseRefresh: () => void = () => {};
    const refreshMayFinish = new Promise<void>(resolve => {
      releaseRefresh = resolve;
    });

    const successfulRun = service.withCodexAuth('client-1', 'run-success', async () => {
      await refreshMayFinish;
      return { result: 'success', refreshedAuthJson: refreshed, loginStatus: 'connected' };
    });
    const failedRun = await service.withCodexAuth('client-1', 'run-failure', async () => ({
      result: 'failed',
      reauthRequired: true,
    }));
    assert.equal(failedRun, 'failed');
    assert.equal((await store.getConnection('client-1'))?.status, 'reauth_required');

    releaseRefresh();
    assert.equal(await successfulRun, 'success');
    const stored = await store.getConnection('client-1');
    assert.equal(stored?.status, 'connected');
    assert.equal(stored?.authVersion, 2);
    assert.equal(stored?.lastError, undefined);
    await service.withCodexAuth('client-1', 'run-after-race', async currentAuth => {
      assert.equal(currentAuth, refreshed);
      return { result: undefined };
    });
  });

  it('serializes real ChatGPT token refreshes and reuses the newer auth version', async () => {
    let refreshCalls = 0;
    const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
      refreshCalls += 1;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.refresh_token, 'secret-refresh-token');
      await new Promise(resolve => setTimeout(resolve, 20));
      return new Response(JSON.stringify({
        access_token: 'refreshed-access-token',
        refresh_token: 'rotated-refresh-token',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    let nextId = 0;
    const { service, store } = makeService({
      fetch: fetchImpl,
      createId: () => `refresh-${++nextId}`,
      authRefreshPollMs: 1,
    });
    await service.connectWithDeviceAuth('client-1');

    const [first, second] = await Promise.all([
      service.refreshChatgptAuth('client-1', 1),
      service.refreshChatgptAuth('client-1', 1),
    ]);

    assert.equal(refreshCalls, 1);
    assert.equal(first.authVersion, 2);
    assert.equal(second.authVersion, 2);
    assert.equal(first.accessToken, 'refreshed-access-token');
    assert.equal(second.accessToken, 'refreshed-access-token');
    assert.equal((await store.getConnection('client-1'))?.authRefreshOwnerId, undefined);
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
