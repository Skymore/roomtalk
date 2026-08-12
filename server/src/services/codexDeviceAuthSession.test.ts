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
    assert.equal(started.authVersion, 1);
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

    const started = await manager.startDeviceAuth('client-1');
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

    const started = await manager.startDeviceAuth('client-1');
    assert.equal((await service.getConnectionStatus('client-1')).status, 'pending');

    const cancelled = await manager.cancelDeviceAuth('client-1', started.authVersion);

    assert.deepEqual(cancelled, {
      clientId: 'client-1',
      provider: 'codex',
      cancelled: true,
    });
    assert.equal(driver.aborted, true);
    assert.equal((await service.getConnectionStatus('client-1')).status, 'disconnected');
    assert.deepEqual(await manager.cancelDeviceAuth('client-1', started.authVersion), {
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

  it('aborts and cancels a device-auth attempt when no code arrives before the timeout', async () => {
    const driver = new DeferredDeviceAuthDriver({ withholdCode: true });
    const service = makeService(driver);
    const manager = new CodexDeviceAuthSessionManager(service, { deviceCodeTimeoutMs: 10 });

    await assert.rejects(
      () => manager.startDeviceAuth('client-1'),
      (error: unknown) => error instanceof CodexConnectionError && error.code === 'device_auth_code_unavailable'
    );
    await waitForStatus(service, 'client-1', 'disconnected');

    assert.equal(driver.aborted, true);
    assert.equal((await service.getConnectionStatus('client-1')).status, 'disconnected');
  });

  it('cancels a device-auth attempt from a manager without the local session', async () => {
    const store = new InMemoryCodexConnectionStore();
    const firstDriver = new DeferredDeviceAuthDriver();
    const secondDriver = new DeferredDeviceAuthDriver();
    const firstService = makeService(firstDriver, store);
    const secondService = makeService(secondDriver, store);
    const firstManager = new CodexDeviceAuthSessionManager(firstService, { deviceCodeTimeoutMs: 1000 });
    const secondManager = new CodexDeviceAuthSessionManager(secondService, { deviceCodeTimeoutMs: 1000 });

    const started = await firstManager.startDeviceAuth('client-1');
    const cancelled = await secondManager.cancelDeviceAuth('client-1', started.authVersion);

    assert.equal(cancelled.cancelled, true);
    assert.equal(firstDriver.aborted, false);
    assert.equal((await firstService.getConnectionStatus('client-1')).status, 'disconnected');

    firstDriver.complete();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await firstService.getConnectionStatus('client-1')).status, 'disconnected');
  });

  it('restarts immediately after cross-instance cancellation before the device code arrives', async () => {
    const store = new InMemoryCodexConnectionStore();
    const firstDriver = new DeferredDeviceAuthDriver({ withholdCode: true });
    const secondDriver = new DeferredDeviceAuthDriver();
    const firstService = makeService(firstDriver, store);
    const secondService = makeService(secondDriver, store);
    const firstManager = new CodexDeviceAuthSessionManager(firstService, { deviceCodeTimeoutMs: 1000 });
    const secondManager = new CodexDeviceAuthSessionManager(secondService, { deviceCodeTimeoutMs: 1000 });

    const firstStart = firstManager.startDeviceAuth('client-1');
    const firstCancelled = assert.rejects(firstStart, (error: unknown) => (
      error instanceof CodexConnectionError && error.code === 'device_auth_cancelled'
    ));
    const firstPending = await waitForStatus(firstService, 'client-1', 'pending');
    assert.equal(firstPending.authVersion, 1);
    assert.equal((await secondManager.cancelDeviceAuth('client-1', firstPending.authVersion)).cancelled, true);

    const replacementStart = firstManager.startDeviceAuth('client-1');
    const replacementCancelled = assert.rejects(replacementStart, (error: unknown) => (
      error instanceof CodexConnectionError && error.code === 'device_auth_cancelled'
    ));
    await waitFor(() => firstDriver.calls === 2);
    const replacementPending = await waitForStatus(firstService, 'client-1', 'pending');

    assert.equal(firstDriver.aborted, true);
    assert.equal(replacementPending.authVersion, 2);

    await firstManager.cancelDeviceAuth('client-1', replacementPending.authVersion);
    await Promise.all([firstCancelled, replacementCancelled]);
  });

  it('does not let a stale local cancellation cancel a newer cross-manager attempt', async () => {
    const store = new InMemoryCodexConnectionStore();
    const firstDriver = new DeferredDeviceAuthDriver();
    const secondDriver = new DeferredDeviceAuthDriver();
    const firstService = makeService(firstDriver, store);
    const secondService = makeService(secondDriver, store);
    const firstManager = new CodexDeviceAuthSessionManager(firstService, { deviceCodeTimeoutMs: 1000 });
    const secondManager = new CodexDeviceAuthSessionManager(secondService, { deviceCodeTimeoutMs: 1000 });

    const first = await firstManager.startDeviceAuth('client-1');
    const second = await secondManager.startDeviceAuth('client-1');
    const staleCancellation = await firstManager.cancelDeviceAuth('client-1', first.authVersion);

    assert.equal(staleCancellation.cancelled, false);
    assert.equal(firstDriver.aborted, true);
    assert.equal((await secondService.getConnectionStatus('client-1')).authVersion, second.authVersion);
    assert.equal((await secondService.getConnectionStatus('client-1')).status, 'pending');

    secondDriver.complete();
    await waitForStatus(secondService, 'client-1', 'connected');
  });

  it('replaces a stale local session after another manager advances and cancels the generation', async () => {
    const store = new InMemoryCodexConnectionStore();
    const firstDriver = new DeferredDeviceAuthDriver();
    const secondDriver = new DeferredDeviceAuthDriver();
    const firstService = makeService(firstDriver, store);
    const secondService = makeService(secondDriver, store);
    const firstManager = new CodexDeviceAuthSessionManager(firstService, { deviceCodeTimeoutMs: 1000 });
    const secondManager = new CodexDeviceAuthSessionManager(secondService, { deviceCodeTimeoutMs: 1000 });

    const first = await firstManager.startDeviceAuth('client-1');
    const second = await secondManager.startDeviceAuth('client-1');
    assert.equal(first.authVersion, 1);
    assert.equal(second.authVersion, 2);
    assert.equal((await secondManager.cancelDeviceAuth('client-1', second.authVersion)).cancelled, true);

    const replacement = await firstManager.startDeviceAuth('client-1');

    assert.equal(firstDriver.aborted, true);
    assert.equal(replacement.authVersion, 3);
    assert.equal((await firstService.getConnectionStatus('client-1')).status, 'pending');

    firstDriver.complete();
    await waitForStatus(firstService, 'client-1', 'connected');
  });

  it('serializes concurrent starts that both observe the same stale local session', async () => {
    const store = new InMemoryCodexConnectionStore();
    const firstDriver = new DeferredDeviceAuthDriver();
    const secondDriver = new DeferredDeviceAuthDriver();
    const firstService = makeService(firstDriver, store);
    const secondService = makeService(secondDriver, store);
    const firstManager = new CodexDeviceAuthSessionManager(firstService, { deviceCodeTimeoutMs: 1000 });
    const secondManager = new CodexDeviceAuthSessionManager(secondService, { deviceCodeTimeoutMs: 1000 });

    await firstManager.startDeviceAuth('client-1');
    const second = await secondManager.startDeviceAuth('client-1');
    await secondManager.cancelDeviceAuth('client-1', second.authVersion);

    const originalGetStatus = firstService.getConnectionStatus.bind(firstService);
    let statusReads = 0;
    let releaseStatusReads: () => void = () => undefined;
    const statusReadBarrier = new Promise<void>(resolve => {
      releaseStatusReads = resolve;
    });
    firstService.getConnectionStatus = async clientId => {
      statusReads += 1;
      await statusReadBarrier;
      return originalGetStatus(clientId);
    };

    const replacements = [
      firstManager.startDeviceAuth('client-1'),
      firstManager.startDeviceAuth('client-1'),
    ];
    await waitFor(() => statusReads === 2);
    releaseStatusReads();
    const results = await Promise.allSettled(replacements);

    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof CodexConnectionError);
    assert.equal(rejected.reason.code, 'device_auth_in_progress');
    assert.equal(firstDriver.calls, 2);
    assert.equal((await originalGetStatus('client-1')).authVersion, 3);

    firstDriver.complete();
    await waitForStatus(firstService, 'client-1', 'connected');
  });
});

const makeService = (
  driver: CodexDeviceAuthDriver,
  store: InMemoryCodexConnectionStore = new InMemoryCodexConnectionStore()
) => new CodexConnectionService(
  store,
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

const waitFor = async (predicate: () => boolean, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail('Timed out waiting for condition');
};

class DeferredDeviceAuthDriver implements CodexDeviceAuthDriver {
  calls = 0;
  aborted = false;
  readonly deviceInfo: CodexDeviceAuthInfo = {
    url: 'https://auth.openai.com/codex/device',
    code: 'ABCD-EFGH',
    expiresAt: '2026-07-04T00:15:00.000Z',
  };
  readonly completed: Promise<void>;
  private resolveComplete: () => void = () => undefined;

  constructor(private readonly options: { failBeforeCode?: boolean; withholdCode?: boolean } = {}) {
    this.completed = new Promise(resolve => {
      this.resolveComplete = resolve;
    });
  }

  async runDeviceAuth(input: {
    clientId: string;
    onDeviceCode?: (info: CodexDeviceAuthInfo) => void | Promise<void>;
    signal?: AbortSignal;
  }) {
    this.calls += 1;
    if (this.options.failBeforeCode) {
      throw new Error('device auth failed');
    }
    if (!this.options.withholdCode) {
      await input.onDeviceCode?.(this.deviceInfo);
    }
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
