import assert from 'node:assert/strict';
import express, { Request, Response } from 'express';
import { AddressInfo } from 'net';
import { Server as HttpServer } from 'http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  CodexAuthCipher,
  CodexConnectionService,
  CodexDeviceAuthDriver,
  CodexDeviceAuthInfo,
  InMemoryCodexConnectionStore,
} from '../services/codexConnection';
import { CodexDeviceAuthSessionManager } from '../services/codexDeviceAuthSession';
import { registerCodexConnectionRoutes } from './codexConnectionRoutes';

type TestServer = {
  baseUrl: string;
  close: () => Promise<void>;
  driver: DeferredDeviceAuthDriver;
  service: CodexConnectionService;
  setAuthorized: (authorized: boolean) => void;
};

const authJson = JSON.stringify({
  OPENAI_AUTH: {
    access_token: 'fake-access-token',
    refresh_token: 'fake-refresh-token',
  },
});

describe('Codex connection routes', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await createTestServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('hides connection routes when the feature is disabled', async () => {
    await server.close();
    server = await createTestServer({ enabled: false });

    const response = await fetch(`${server.baseUrl}/api/codex/connection?clientId=client-1`);

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Codex connections are not enabled' });
  });

  it('starts device auth, exposes public status, and disconnects', async () => {
    const startResponse = await fetch(`${server.baseUrl}/api/codex/connection/device-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1' }),
    });

    assert.equal(startResponse.status, 202);
    assert.deepEqual(await startResponse.json(), {
      clientId: 'client-1',
      provider: 'codex',
      status: 'pending',
      deviceAuth: server.driver.deviceInfo,
    });

    const pendingResponse = await fetch(`${server.baseUrl}/api/codex/connection?clientId=client-1`);
    assert.equal(pendingResponse.status, 200);
    assert.equal((await pendingResponse.json() as { status: string }).status, 'pending');

    server.driver.complete();
    await waitForStatus(server.service, 'client-1', 'connected');

    const connectedResponse = await fetch(`${server.baseUrl}/api/codex/connection?clientId=client-1`);
    assert.equal(connectedResponse.status, 200);
    const connected = await connectedResponse.json() as Record<string, unknown>;
    assert.equal(connected.status, 'connected');
    assert.equal(JSON.stringify(connected).includes('fake-access-token'), false);

    const disconnectResponse = await fetch(`${server.baseUrl}/api/codex/connection`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1' }),
    });
    assert.equal(disconnectResponse.status, 200);
    assert.equal((await disconnectResponse.json() as { status: string }).status, 'disconnected');
  });

  it('requires an authorized client request', async () => {
    server.setAuthorized(false);

    const response = await fetch(`${server.baseUrl}/api/codex/connection/device-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1' }),
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'login required' });
    assert.equal(server.driver.calls, 0);
  });

  it('returns 409 while another device auth session is active', async () => {
    const first = await fetch(`${server.baseUrl}/api/codex/connection/device-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1' }),
    });
    assert.equal(first.status, 202);

    const second = await fetch(`${server.baseUrl}/api/codex/connection/device-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1' }),
    });

    assert.equal(second.status, 409);
    assert.deepEqual(await second.json(), { error: 'Codex device auth is already in progress' });

    server.driver.complete();
    await waitForStatus(server.service, 'client-1', 'connected');
  });

  it('cancels an active device auth session without disconnecting a completed connection', async () => {
    const first = await fetch(`${server.baseUrl}/api/codex/connection/device-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1' }),
    });
    assert.equal(first.status, 202);

    const cancel = await fetch(`${server.baseUrl}/api/codex/connection/device-auth`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1' }),
    });

    assert.equal(cancel.status, 200);
    const cancelPayload = await cancel.json() as {
      cancelled: boolean;
      status: { status: string };
    };
    assert.equal(cancelPayload.cancelled, true);
    assert.equal(cancelPayload.status.status, 'disconnected');
    assert.equal(server.driver.aborted, true);

    const second = await fetch(`${server.baseUrl}/api/codex/connection/device-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1' }),
    });
    assert.equal(second.status, 202);
    server.driver.complete();
    await waitForStatus(server.service, 'client-1', 'connected');

    const idleCancel = await fetch(`${server.baseUrl}/api/codex/connection/device-auth`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1' }),
    });
    assert.equal(idleCancel.status, 200);
    const idlePayload = await idleCancel.json() as {
      cancelled: boolean;
      status: { status: string };
    };
    assert.equal(idlePayload.cancelled, false);
    assert.equal(idlePayload.status.status, 'connected');
  });

  it('aborts a pending device auth session before disconnecting the connection', async () => {
    const start = await fetch(`${server.baseUrl}/api/codex/connection/device-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1' }),
    });
    assert.equal(start.status, 202);

    const disconnect = await fetch(`${server.baseUrl}/api/codex/connection`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1' }),
    });

    assert.equal(disconnect.status, 200);
    assert.equal((await disconnect.json() as { status: string }).status, 'disconnected');
    assert.equal(server.driver.aborted, true);
  });
});

const createTestServer = async (options: { enabled?: boolean } = {}): Promise<TestServer> => {
  const app = express();
  app.use(express.json());

  const driver = new DeferredDeviceAuthDriver();
  const service = new CodexConnectionService(
    new InMemoryCodexConnectionStore(),
    new CodexAuthCipher('test-secret', 'key-v1'),
    driver,
    {
      now: () => new Date('2026-07-04T00:00:00.000Z'),
      authRefreshLockTtlMs: 60_000,
    }
  );
  const sessions = new CodexDeviceAuthSessionManager(service, { deviceCodeTimeoutMs: 1000 });
  let authorized = true;

  registerCodexConnectionRoutes(app, {
    enabled: options.enabled ?? true,
    service,
    deviceAuthSessions: sessions,
    routeLogger: {
      warn() {},
      error() {},
    },
    getQueryClientId: req => {
      const value = req.query.clientId;
      return typeof value === 'string' ? value : null;
    },
    getBodyClientId: req => {
      const value = req.body?.clientId;
      return typeof value === 'string' ? value : null;
    },
    authorizeClientRequest: async (_req: Request, res: Response) => {
      if (authorized) {
        return true;
      }
      res.status(401).json({ error: 'login required' });
      return false;
    },
  });

  const listener = await new Promise<HttpServer>(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  const { port } = listener.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      listener.close(error => error ? reject(error) : resolve());
    }),
    driver,
    service,
    setAuthorized(nextAuthorized: boolean) {
      authorized = nextAuthorized;
    },
  };
};

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
  calls = 0;
  aborted = false;
  readonly deviceInfo: CodexDeviceAuthInfo = {
    url: 'https://auth.openai.com/codex/device',
    code: 'ABCD-EFGH',
    expiresAt: '2026-07-04T00:15:00.000Z',
  };
  private readonly completed: Promise<void>;
  private resolveComplete: () => void = () => undefined;

  constructor() {
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
    await input.onDeviceCode?.(this.deviceInfo);
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.aborted = true;
        reject(new Error('device auth cancelled'));
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
