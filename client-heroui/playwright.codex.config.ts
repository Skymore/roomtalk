import { defineConfig, devices } from '@playwright/test';

const clientPort = Number(process.env.E2E_CLIENT_PORT || 3331);
const serverPort = Number(process.env.E2E_SERVER_PORT || 3332);
const clientURL = `http://127.0.0.1:${clientPort}`;
const serverURL = `http://127.0.0.1:${serverPort}`;
const fakeCodexStateDir = `/tmp/roomtalk-codex-ui-e2e-${serverPort}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\/codex-connection\.spec\.ts/,
  timeout: 40_000,
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
      name: 'codex-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: [
        `PORT=${serverPort}`,
        'NODE_ENV=development',
        'DISABLE_LOCAL_MEDIA_STORAGE=false',
        `CLIENT_URL=${clientURL}`,
        'REDIS_URL=redis://127.0.0.1:6379/15',
        'E2E_TEST_MODE=true',
        'E2E_FAKE_AI=true',
        'E2E_FAKE_AI_CHUNK_DELAY_MS=1000',
        'COCO_ENABLED=true',
        'COCO_ALLOWED_USER_IDS=',
        'COCO_SANDBOX_PROVIDER=fake',
        'COCO_RUNNER_CLIENT=fake',
        'COCO_MODE=plan',
        'COCO_FAKE_RUNNER_EVENT_DELAY_MS=250',
        'CODEX_CONNECTIONS_ENABLED=true',
        'CODEX_AUTH_ENCRYPTION_KEY=e2e-codex-connection-secret',
        'CODEX_AUTH_LOGIN_TIMEOUT_MS=30000',
        'CODEX_DEVICE_CODE_TIMEOUT_MS=10000',
        'CODEX_CLI_BIN=./scripts/fake-codex-cli.mjs',
        'CODEX_DEVICE_AUTH_SCRIPT_BIN=./scripts/fake-script-bin.mjs',
        'ROOMTALK_FAKE_CODEX_LOGIN_PLAN=first-hold-then-success',
        `ROOMTALK_FAKE_CODEX_STATE_DIR=${fakeCodexStateDir}`,
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
