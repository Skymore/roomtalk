import { defineConfig, devices } from '@playwright/test';

const clientPort = Number(process.env.E2E_CLIENT_PORT || 3321);
const serverPort = Number(process.env.E2E_SERVER_PORT || 3322);
const clientURL = `http://127.0.0.1:${clientPort}`;
const serverURL = `http://127.0.0.1:${serverPort}`;

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

const requireSafeE2EDatabaseUrl = () => {
  const databaseUrl = process.env.E2E_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'E2E_DATABASE_URL is required for npm run test:e2e:postgres. Use a dedicated test database whose name includes "test" or "e2e" as a separated token.'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('E2E_DATABASE_URL must be a valid PostgreSQL connection URL.');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('E2E_DATABASE_URL must use the postgres:// or postgresql:// protocol.');
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!/(^|[_-])(test|e2e)([_-]|$)/i.test(databaseName)) {
    throw new Error(
      `Refusing to run PostgreSQL E2E against database "${databaseName || '(missing)'}". The database name must include "test" or "e2e" as a separated token.`
    );
  }

  return databaseUrl;
};

const databaseUrl = requireSafeE2EDatabaseUrl();

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
        `CLIENT_URL=${clientURL}`,
        'REDIS_URL=redis://127.0.0.1:6379/15',
        'PERSISTENCE_STORE=postgres',
        `DATABASE_URL=${shellQuote(databaseUrl)}`,
        'E2E_TEST_MODE=true',
        'E2E_RESET_ON_START=true',
        'E2E_FAKE_AI=true',
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
        `VITE_SOCKET_URL=${serverURL}`,
        `npm run dev -- --host 127.0.0.1 --port ${clientPort}`,
      ].join(' '),
      url: clientURL,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
