import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CodexAuthCipher,
  CodexConnectionError,
  CodexConnectionService,
  CodexDeviceAuthDriver,
  CodexDeviceAuthInfo,
} from './codexConnection';
import { CodexDeviceAuthSessionManager } from './codexDeviceAuthSession';
import { InMemoryCodexConnectionStore } from './codexConnection';

const authJson = JSON.stringify({
  OPENAI_AUTH: {
    access_token: 'fake-access-token',
    refresh_token: 'fake-refresh-token',
  },
});

describe('CodexDeviceAuthSessionManager', () => {
  it('returns the device code before login completes and persists auth after completion', async () => {
    const driver = new DeferredDeviceAuthDriver();
    const service = makeService(driver);
    const manager = new CodexDeviceAuthSessionManager(service, { deviceCodeTimeoutMs: 1000 });

    const started = await manager.startDeviceAuth('client-1');

    assert.equal(started.status, 'pending');
    assert.deepEqual(started.deviceAuth, driver.deviceInfo);
    assert.equal((await service.getConnectionStatus('client-1')).status, 'pending');

    driver.complete();
    await waitForStatus(service, 'client-1', 'connected');

    const connected = await service.getConnectionStatus('client-1');
    assert.equal(connected.status, 'connected');
    assert.equal(connected.authVersion, 1);
  });

  it('rejects a second start while device auth is already active', async () => {
    const driver = new DeferredDeviceAuthDriver();
    const service = makeService(driver);
    const manager = new CodexDeviceAuthSessionManager(service, { deviceCodeTimeoutMs: 1000 });

    await manager.startDeviceAuth('client-1');
    await assert.rejects(
      () => manager.startDeviceAuth('client-1'),
      (error: unknown) => error instanceof CodexConnectionError && error.code === 'device_auth_in_progress'
    );

    driver.complete();
    await waitForStatus(service, 'client-1', 'connected');
  });

  it('cancels an active device auth session and clears pending status', async () => {
    const driver = new DeferredDeviceAuthDriver();
    const service = makeService(driver);
    const manager = new CodexDeviceAuthSessionManager(service, { deviceCodeTimeoutMs: 1000 });

    await manager.startDeviceAuth('client-1');
    assert.equal((await service.getConnectionStatus('client-1')).status, 'pending');

    const cancelled = await manager.cancelDeviceAuth('client-1');

    assert.deepEqual(cancelled, {
      clientId: 'client-1',
      provider: 'codex',
      cancelled: true,
    });
    assert.equal(driver.aborted, true);
    assert.equal((await service.getConnectionStatus('client-1')).status, 'disconnected');
    assert.deepEqual(await manager.cancelDeviceAuth('client-1'), {
      clientId: 'client-1',
      provider: 'codex',
      cancelled: false,
    });
  });

  it('surfaces failures before a device code is available', async () => {
    const driver = new DeferredDeviceAuthDriver({ failBeforeCode: true });
    const service = makeService(driver);
    const manager = new CodexDeviceAuthSessionManager(service, { deviceCodeTimeoutMs: 1000 });

    await assert.rejects(
      () => manager.startDeviceAuth('client-1'),
      (error: unknown) => error instanceof CodexConnectionError && error.code === 'device_auth_failed'
    );
  });
});

const makeService = (driver: CodexDeviceAuthDriver) => new CodexConnectionService(
  new InMemoryCodexConnectionStore(),
  new CodexAuthCipher('test-secret', 'key-v1'),
  driver,
  {
    authRefreshLockTtlMs: 60_000,
    now: () => new Date('2026-07-04T00:00:00.000Z'),
  }
);

const waitForStatus = async (
  service: CodexConnectionService,
  clientId: string,
  expected: string,
  timeoutMs = 1000
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await service.getConnectionStatus(clientId);
    if (status.status === expected) {
      return status;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for Codex connection status ${expected}`);
};

class DeferredDeviceAuthDriver implements CodexDeviceAuthDriver {
  aborted = false;
  readonly deviceInfo: CodexDeviceAuthInfo = {
    url: 'https://auth.openai.com/codex/device',
    code: 'ABCD-EFGH',
    expiresAt: '2026-07-04T00:15:00.000Z',
  };
  readonly completed: Promise<void>;
  private resolveComplete: () => void = () => undefined;

  constructor(private readonly options: { failBeforeCode?: boolean } = {}) {
    this.completed = new Promise(resolve => {
      this.resolveComplete = resolve;
    });
  }

  async runDeviceAuth(input: {
    clientId: string;
    onDeviceCode?: (info: CodexDeviceAuthInfo) => void | Promise<void>;
    signal?: AbortSignal;
  }) {
    if (this.options.failBeforeCode) {
      throw new Error('device auth failed');
    }
    await input.onDeviceCode?.(this.deviceInfo);
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.aborted = true;
        reject(new CodexConnectionError('device auth cancelled', 'device_auth_cancelled'));
      };
      if (input.signal?.aborted) {
        abort();
        return;
      }
      input.signal?.addEventListener('abort', abort, { once: true });
      this.completed.then(() => {
        input.signal?.removeEventListener('abort', abort);
        resolve();
      });
    });
    return {
      authJson,
      loginStatus: 'Logged in using ChatGPT',
    };
  }

  complete() {
    this.resolveComplete();
  }
}
