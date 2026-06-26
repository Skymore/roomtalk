import { defineConfig, devices } from '@playwright/test';

const clientPort = Number(process.env.E2E_CLIENT_PORT || 3311);
const serverPort = Number(process.env.E2E_SERVER_PORT || 3312);
const clientURL = `http://127.0.0.1:${clientPort}`;
const serverURL = `http://127.0.0.1:${serverPort}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: {
    timeout: 8_000,
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
      name: 'chromium',
      testIgnore: /.*(mobile|postgres).*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chromium',
      testMatch: /.*mobile.*\.spec\.ts/,
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: [
    {
      command: [
        `PORT=${serverPort}`,
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
        'AI_MODEL=deepseek-v4-pro',
        'OPENAI_API_KEY=e2e',
        'OPENROUTER_API_KEY=e2e',
        'DEEPSEEK_API_KEY=e2e',
        'ANTHROPIC_API_KEY=e2e',
        'npm run start:e2e',
      ].join(' '),
      cwd: '../server',
      url: `${serverURL}/api/status`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: [
        `VITE_SOCKET_URL=${serverURL}`,
        `npm run dev -- --host 127.0.0.1 --port ${clientPort}`,
      ].join(' '),
      url: clientURL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
