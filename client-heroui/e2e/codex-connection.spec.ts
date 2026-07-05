import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, rmSync } from 'fs';
import path from 'path';
import {
  openRoomsPage,
  resetE2EData,
  seedClient,
  serverURL,
  uniqueName,
} from './helpers';

test.beforeEach(async ({ request }) => {
  resetFakeCodexState();
  await resetE2EData(request);
});

test('connects, cancels, completes, and disconnects Codex through the settings UI', async ({ page, context, request }) => {
  test.setTimeout(70_000);
  const clientId = await seedClient(context, uniqueName('codex-ui'));
  await page.addInitScript(() => {
    window.open = () => null;
  });

  const featuresResponse = await request.get(`${serverURL}/api/features?clientId=${encodeURIComponent(clientId)}`);
  expect(featuresResponse.ok()).toBeTruthy();
  const features = await featuresResponse.json();
  expect(features.codex?.connections?.enabled).toBe(true);

  await openRoomsPage(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByText('Codex', { exact: true })).toBeVisible();
  await expect(page.getByText('Not connected').first()).toBeVisible();

  await startCodexLogin(page);
  await expect(page.getByText('ABCD-EFGH').first()).toBeVisible();
  await expect(page.getByText('Connecting').first()).toBeVisible();
  const cancelButton = page.getByRole('button', { name: 'Cancel login' }).first();
  await expect(cancelButton).toBeVisible();
  const [cancelResponse] = await Promise.all([
    page.waitForResponse(response =>
      response.url().includes('/api/codex/connection/device-auth') &&
      response.request().method() === 'DELETE'
    ),
    cancelButton.click(),
  ]);
  expect(cancelResponse.ok()).toBeTruthy();
  const cancelPayload = await cancelResponse.json();
  expect(cancelPayload.status?.status).toBe('disconnected');
  await expect(page.getByText('Codex login cancelled.')).toBeVisible();
  await expect(page.getByText('Not connected').first()).toBeVisible();

  await startCodexLogin(page);
  await expect(page.getByText('ABCD-EFGH').first()).toBeVisible();
  await expect.poll(async () => {
    const response = await request.get(`${serverURL}/api/codex/connection`, {
      headers: { 'X-Client-Id': clientId },
    });
    if (!response.ok()) {
      return `http-${response.status()}`;
    }
    const payload = await response.json() as { status?: string };
    return payload.status;
  }, { timeout: 12_000 }).toBe('connected');
  await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible();

  const connectedStatus = await request.get(`${serverURL}/api/codex/connection`, {
    headers: { 'X-Client-Id': clientId },
  });
  expect(connectedStatus.ok()).toBeTruthy();
  const connectedPayloadText = await connectedStatus.text();
  expect(connectedPayloadText).toContain('"status":"connected"');
  expect(connectedPayloadText).not.toContain('roomtalk-e2e-fake-access-value');
  expect(connectedPayloadText).not.toContain('roomtalk-e2e-fake-refresh-value');

  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByText('Codex disconnected.')).toBeVisible();
  await expect(page.getByText('Not connected').first()).toBeVisible();
});

const startCodexLogin = async (page: Page) => {
  await page.getByRole('button', { name: 'Connect Codex' }).click();
};

const resetFakeCodexState = () => {
  const serverPort = process.env.E2E_SERVER_PORT || '3332';
  const stateDir = path.join('/tmp', `roomtalk-codex-ui-e2e-${serverPort}`);
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
};
