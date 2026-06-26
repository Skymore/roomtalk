import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { createServer } from 'net';
import path from 'path';

type PersistenceMode = 'redis' | 'postgres';

interface SmokeServer {
  name: string;
  port: number;
  baseUrl: string;
  process: ChildProcessWithoutNullStreams;
  logs: string[];
}

interface SmokeResult {
  name: string;
  skipped?: boolean;
}

const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379/15';
const STARTUP_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 12_000;
const SERVER_ROOT = path.resolve(__dirname, '../..');

const sleep = (delayMs: number) => new Promise(resolve => setTimeout(resolve, delayMs));

const log = (message: string) => {
  process.stdout.write(`${message}\n`);
};

const fail = (message: string): never => {
  throw new Error(message);
};

export function getSafeSmokeRedisUrl(env: NodeJS.ProcessEnv = process.env) {
  const redisUrl = env.PERSISTENCE_SMOKE_REDIS_URL || env.E2E_REDIS_URL || DEFAULT_REDIS_URL;
  const parsed = new URL(redisUrl);

  if (env.ALLOW_NONLOCAL_SMOKE_REDIS !== 'true' && !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    fail('Persistence smoke refuses non-local Redis. Set PERSISTENCE_SMOKE_REDIS_URL to a local test Redis URL or ALLOW_NONLOCAL_SMOKE_REDIS=true for a disposable test instance.');
  }

  return redisUrl;
}

export function getSafeSmokeDatabaseUrl(env: NodeJS.ProcessEnv = process.env) {
  const databaseUrl = env.TEST_DATABASE_URL || env.E2E_DATABASE_URL;
  if (!databaseUrl) {
    return null;
  }

  const parsed: URL = (() => {
    try {
      return new URL(databaseUrl);
    } catch {
      return fail('TEST_DATABASE_URL/E2E_DATABASE_URL must be a valid PostgreSQL connection URL.');
    }
  })();

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    fail('TEST_DATABASE_URL/E2E_DATABASE_URL must use postgres:// or postgresql://.');
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!/(^|[_-])(test|e2e)([_-]|$)/i.test(databaseName)) {
    fail(`Persistence smoke refuses database "${databaseName || '(missing)'}". The database name must include "test" or "e2e" as a separated token.`);
  }

  return databaseUrl;
}

async function getFreePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to resolve a free TCP port')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    fail(`Expected JSON response, got: ${text.slice(0, 500)}`);
  }
  throw new Error('unreachable');
}

export function buildRoomMessagesSmokeUrl(baseUrl: string, roomId: string, clientId: string) {
  const url = new URL(`/api/rooms/${encodeURIComponent(roomId)}/messages`, baseUrl);
  url.searchParams.set('clientId', clientId);
  return url.toString();
}

async function postJson<T>(url: string, body?: unknown): Promise<{ response: Response; json: T }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, json: await readJson<T>(response) };
}

async function startServer({
  name,
  mode,
  redisUrl,
  databaseUrl,
}: {
  name: string;
  mode: PersistenceMode;
  redisUrl: string;
  databaseUrl?: string;
}): Promise<SmokeServer> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];

  const child = spawn(process.execPath, ['-r', 'ts-node/register', 'src/server.ts'], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      CLIENT_URL: baseUrl,
      REDIS_URL: redisUrl,
      PERSISTENCE_STORE: mode,
      DATABASE_URL: databaseUrl || '',
      E2E_TEST_MODE: 'true',
      E2E_RESET_ON_START: 'true',
      E2E_FAKE_AI: 'true',
      AI_MODEL: 'deepseek-v4-pro',
      OPENAI_API_KEY: 'smoke',
      OPENROUTER_API_KEY: 'smoke',
      DEEPSEEK_API_KEY: 'smoke',
      ANTHROPIC_API_KEY: 'smoke',
    },
  });

  child.stdout.on('data', chunk => logs.push(String(chunk)));
  child.stderr.on('data', chunk => logs.push(String(chunk)));

  const startedAt = Date.now();
  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    if (child.exitCode !== null) {
      fail(`${name} server exited before readiness. Logs:\n${logs.join('')}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/status`);
      if (response.ok) {
        return { name, port, baseUrl, process: child, logs };
      }
    } catch {
      // Server is still starting.
    }
    await sleep(250);
  }

  await stopServer({ name, port, baseUrl, process: child, logs });
  fail(`${name} server did not become ready within ${STARTUP_TIMEOUT_MS}ms. Logs:\n${logs.join('')}`);
  throw new Error('unreachable');
}

async function stopServer(server: SmokeServer) {
  if (server.process.exitCode !== null) {
    return;
  }

  server.process.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => server.process.once('exit', resolve)),
    sleep(3_000).then(() => {
      if (server.process.exitCode === null) {
        server.process.kill('SIGKILL');
      }
    }),
  ]);
}

async function expectStatus(server: SmokeServer, mode: PersistenceMode) {
  const response = await fetch(`${server.baseUrl}/api/status`);
  if (!response.ok) {
    fail(`${server.name} /api/status failed with HTTP ${response.status}`);
  }

  const status = await readJson<{ status: string; persistenceStore: string; redis: string; rooms: number }>(response);
  if (status.status !== 'online' || status.persistenceStore !== mode || status.redis !== 'connected') {
    fail(`${server.name} returned unexpected status: ${JSON.stringify(status)}`);
  }
  return status;
}

async function exerciseBasicApi(server: SmokeServer, label: string) {
  const clientId = `smoke-${label}-${Date.now()}`;
  const roomName = `smoke-room-${label}`;
  const messageContent = `smoke message ${label}`;

  const roomResult = await postJson<{ id: string; name: string; creatorId: string }>(
    `${server.baseUrl}/api/clients/${clientId}/rooms`,
    { name: roomName }
  );
  if (roomResult.response.status !== 201 || roomResult.json.name !== roomName || roomResult.json.creatorId !== clientId) {
    fail(`${server.name} failed to create a room: HTTP ${roomResult.response.status} ${JSON.stringify(roomResult.json)}`);
  }

  const messageResult = await postJson<{ id: string; content: string; roomId: string }>(
    `${server.baseUrl}/api/rooms/${roomResult.json.id}/messages`,
    { clientId, content: messageContent }
  );
  if (messageResult.response.status !== 201 || messageResult.json.content !== messageContent) {
    fail(`${server.name} failed to create a message: HTTP ${messageResult.response.status} ${JSON.stringify(messageResult.json)}`);
  }

  const messagesResponse = await fetch(buildRoomMessagesSmokeUrl(server.baseUrl, roomResult.json.id, clientId));
  if (!messagesResponse.ok) {
    fail(`${server.name} failed to read messages: HTTP ${messagesResponse.status}`);
  }
  const messages = await readJson<Array<{ content: string; roomId: string }>>(messagesResponse);
  if (messages.length !== 1 || messages[0].content !== messageContent || messages[0].roomId !== roomResult.json.id) {
    fail(`${server.name} returned unexpected message history: ${JSON.stringify(messages)}`);
  }
}

async function runModeSmoke(mode: PersistenceMode, redisUrl: string, databaseUrl?: string): Promise<SmokeResult> {
  const name = `${mode}-mode`;
  const server = await startServer({ name, mode, redisUrl, databaseUrl });
  try {
    await expectStatus(server, mode);
    await exerciseBasicApi(server, mode);
    log(`✓ ${name} status and basic API smoke passed`);
    return { name };
  } finally {
    await stopServer(server);
  }
}

async function runPostgresUnavailableSmoke(redisUrl: string): Promise<SmokeResult> {
  const port = await getFreePort();
  const closedPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const databaseUrl = `postgres://127.0.0.1:${closedPort}/message_system_test`;
  const child = spawn(process.execPath, ['-r', 'ts-node/register', 'src/server.ts'], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      CLIENT_URL: baseUrl,
      REDIS_URL: redisUrl,
      PERSISTENCE_STORE: 'postgres',
      DATABASE_URL: databaseUrl,
      E2E_TEST_MODE: 'true',
      E2E_RESET_ON_START: 'true',
      E2E_FAKE_AI: 'true',
      OPENAI_API_KEY: 'smoke',
      OPENROUTER_API_KEY: 'smoke',
      DEEPSEEK_API_KEY: 'smoke',
      ANTHROPIC_API_KEY: 'smoke',
    },
  });

  child.stdout.on('data', chunk => logs.push(String(chunk)));
  child.stderr.on('data', chunk => logs.push(String(chunk)));

  const exitCode = await Promise.race([
    new Promise<number | null>(resolve => child.once('exit', code => resolve(code))),
    sleep(EXIT_TIMEOUT_MS).then(() => null),
  ]);

  if (exitCode === null) {
    child.kill('SIGKILL');
    fail(`postgres-unavailable server did not fail closed within ${EXIT_TIMEOUT_MS}ms`);
  }

  if (exitCode === 0) {
    fail(`postgres-unavailable smoke expected a non-zero startup failure. logs:\n${logs.join('')}`);
  }

  try {
    await fetch(`${baseUrl}/api/status`);
    fail(`postgres-unavailable smoke expected the server to fail closed before listening. exit=${exitCode} logs:\n${logs.join('')}`);
  } catch {
    // Expected: startup failed before accepting HTTP requests.
  }

  log(`✓ postgres-unavailable smoke failed closed before accepting writes (exit ${exitCode})`);
  return { name: 'postgres-unavailable' };
}

async function main() {
  const redisUrl = getSafeSmokeRedisUrl();
  const databaseUrl = getSafeSmokeDatabaseUrl();
  const results: SmokeResult[] = [];

  log(`Persistence smoke using Redis: ${redisUrl}`);
  results.push(await runModeSmoke('redis', redisUrl));

  if (databaseUrl) {
    results.push(await runModeSmoke('postgres', redisUrl, databaseUrl));
    results.push(await runModeSmoke('redis', redisUrl));
  } else {
    log('↷ postgres-mode smoke skipped: set TEST_DATABASE_URL or E2E_DATABASE_URL to a disposable test database whose name includes test/e2e.');
    results.push({ name: 'postgres-mode', skipped: true });
  }

  results.push(await runPostgresUnavailableSmoke(redisUrl));

  const skipped = results.filter(result => result.skipped).map(result => result.name);
  log(`Persistence smoke complete${skipped.length ? `; skipped: ${skipped.join(', ')}` : ''}.`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`Persistence smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
