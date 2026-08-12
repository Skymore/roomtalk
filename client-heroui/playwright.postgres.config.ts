import path from 'path';
import { tmpdir } from 'os';
import { defineConfig, devices } from '@playwright/test';
import { requireSafeE2EDatabaseUrl, requireSafeE2ERedisUrl, shellQuote } from './playwright.e2e-env';

const clientPort = Number(process.env.E2E_CLIENT_PORT || 3321);
const serverPort = Number(process.env.E2E_SERVER_PORT || 3322);
const clientURL = `http://127.0.0.1:${clientPort}`;
const serverURL = `http://127.0.0.1:${serverPort}`;
const workerPort = serverPort + 1;
const localMediaDir = path.join(tmpdir(), `roomtalk-postgres-e2e-media-${serverPort}`);

const databaseUrl = requireSafeE2EDatabaseUrl();
const redisUrl = requireSafeE2ERedisUrl();
const chromiumExecutablePath = process.env.E2E_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: clientURL,
    launchOptions: chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'postgres-chromium',
      testMatch: /.*postgres.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: [
        `PORT=${serverPort}`,
        'NODE_ENV=production',
        `CLIENT_URL=${clientURL}`,
        `REDIS_URL=${shellQuote(redisUrl)}`,
        `QUEUE_REDIS_URL=${shellQuote(redisUrl)}`,
        'PERSISTENCE_STORE=postgres',
        `DATABASE_URL=${shellQuote(databaseUrl)}`,
        'MEDIA_STORAGE_MODE=local',
        'LOCAL_MEDIA_SIGNING_SECRET=roomtalk-postgres-e2e-local-media-signing-secret',
        `LOCAL_MEDIA_DIR=${shellQuote(localMediaDir)}`,
        'DISABLE_LOCAL_MEDIA_STORAGE=false',
        'E2E_TEST_MODE=true',
        'E2E_RESET_ON_START=true',
        'E2E_FAKE_AI=true',
        'E2E_FAKE_AI_CHUNK_DELAY_MS=1000',
        'AI_MODEL=deepseek-v4-pro',
        'OPENAI_API_KEY=e2e',
        'OPENROUTER_API_KEY=e2e',
        'DEEPSEEK_API_KEY=e2e',
        'ANTHROPIC_API_KEY=e2e',
        'npm run start:e2e',
      ].join(' '),
      cwd: '../server',
      url: `${serverURL}/api/status`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: [
        `AI_WORKER_HEALTH_PORT=${workerPort}`,
        `REDIS_URL=${shellQuote(redisUrl)}`,
        `QUEUE_REDIS_URL=${shellQuote(redisUrl)}`,
        'PERSISTENCE_STORE=postgres',
        `DATABASE_URL=${shellQuote(databaseUrl)}`,
        'E2E_TEST_MODE=true',
        'E2E_FAKE_AI=true',
        'E2E_FAKE_AI_CHUNK_DELAY_MS=1000',
        'AI_MODEL=deepseek-v4-pro',
        'OPENAI_API_KEY=e2e',
        'OPENROUTER_API_KEY=e2e',
        'DEEPSEEK_API_KEY=e2e',
        'ANTHROPIC_API_KEY=e2e',
        'npm run start:e2e:ai-worker',
      ].join(' '),
      cwd: '../server',
      url: `http://127.0.0.1:${workerPort}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: [
        `VITE_SOCKET_URL=${serverURL}`,
        `npm run dev -- --host 127.0.0.1 --port ${clientPort}`,
      ].join(' '),
      url: clientURL,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
