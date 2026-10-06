import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openRoomsPage, resetE2EData, seedClient, serverURL, uniqueName } from './helpers';
import type { Message, Room } from '../src/utils/types';

test.beforeEach(async ({ request }) => {
  await resetE2EData(request);
  const stateDir = path.join('/tmp', `roomtalk-codex-ui-e2e-${process.env.E2E_SERVER_PORT || '3332'}`);
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  // The test server uses the existing deterministic Codex login double.
  writeFileSync(path.join(stateDir, 'device-auth-attempts.txt'), '1\n');
});

const openPersonalAgent = async (page: Page) => {
  await page.getByRole('button', { name: 'Personal Agent', exact: true }).first().click();
  await expect(page.getByTestId('personal-agent-view')).toBeVisible();
};

const accountHeaders = (clientId: string, token: string) => ({ 'X-Client-Id': clientId, 'X-Client-Auth-Token': token });

const expectCompletedTurn = async (request: APIRequestContext, clientId: string, token: string, roomId: string) => {
  await expect.poll(async () => {
    const [roomResponse, messagesResponse] = await Promise.all([
      request.get(`${serverURL}/api/clients/${clientId}/rooms/${roomId}`, { headers: accountHeaders(clientId, token) }),
      request.get(`${serverURL}/api/rooms/${roomId}/messages?clientId=${encodeURIComponent(clientId)}`, { headers: accountHeaders(clientId, token) }),
    ]);
    if (!roomResponse.ok() || !messagesResponse.ok()) return 'unavailable';
    const room = await roomResponse.json() as Room;
    const messages = await messagesResponse.json() as Message[];
    const answers = messages.filter(message => message.messageType === 'ai');
    const complete = answers.some(message => message.status === 'complete' && message.content.includes('fake runner received the task'));
    return room.codeAgentStatus === 'idle' && room.codeAgentSessionId && complete && answers.every(message => message.status !== 'error') ? 'complete' : room.codeAgentStatus;
  }, { timeout: 20000 }).toBe('complete');
};

test('shows account sign-in guidance to guests', async ({ page, context }) => {
  await seedClient(context, uniqueName('personal-guest'));
  await openRoomsPage(page);
  await page.getByRole('button', { name: 'Personal Agent', exact: true }).first().click();
  await expect(page.getByText('Sign in to your RoomTalk account in Settings to create a private personal agent.', { exact: true })).toBeVisible();
});

test('creates a private Codex agent, persists memory, runs a task and goal, and denies another account', async ({ page, context, request, browser }, testInfo) => {
  test.setTimeout(120_000);
  const clientId = await seedClient(context, uniqueName('personal-owner'));
  console.log(`Personal agent UI fixture owner: ${clientId}`);
  await page.addInitScript(() => { window.open = () => null; });
  await openRoomsPage(page);

  // Provision a real password account through RoomTalk's existing settings UI.
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByLabel('User ID password', { exact: true }).first().fill('Personal-agent-test-2026');
  await page.getByRole('button', { name: 'Set password', exact: true }).click();
  await expect(page.getByText('User ID password saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Connect Codex', exact: true }).click();
  await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible({ timeout: 15000 });
  const token = await page.evaluate(() => localStorage.getItem('clientAuthToken'));
  expect(token).toBeTruthy();

  await openPersonalAgent(page);
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await page.getByLabel('Agent name', { exact: true }).fill('Willow');
  await page.getByLabel('How to work with you', { exact: true }).fill('Give me concise, practical answers.');
  await page.getByLabel('Memory', { exact: true }).fill('I prefer Chinese and live in Seattle.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Agent preferences and memory saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('personal-agent-view')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Willow', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await expect(page.getByLabel('Memory', { exact: true })).toHaveValue('I prefer Chinese and live in Seattle.');
  await expect(page.getByLabel('How to work with you', { exact: true })).toHaveValue('Give me concise, practical answers.');

  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('personal-agent-desktop.png'), fullPage: true });
  copyFileSync(testInfo.outputPath('personal-agent-desktop.png'), '/tmp/roomtalk-personal-agent-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('bottom-nav')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Talk to your agent', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('personal-agent-mobile.png'), fullPage: true });
  copyFileSync(testInfo.outputPath('personal-agent-mobile.png'), '/tmp/roomtalk-personal-agent-mobile.png');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('button', { name: 'Talk to your agent', exact: true }).click();
  await expect(page.getByTestId('message-editor')).toBeVisible();
  await expect(page.getByText('Private conversation · Codex', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Room Actions', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to personal agent', exact: true }).click();

  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page.getByLabel('Task name', { exact: true }).fill('Plan my week');
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  await expect(page.getByTestId('chat-room-title')).toHaveText('Plan my week');
  await page.getByTestId('message-editor').fill('Suggest a simple weekly plan.');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('message-item').filter({ hasText: /fake runner received the task/ })).toBeVisible({ timeout: 20000 });
  const topicRoomId = await page.evaluate(() => JSON.parse(localStorage.getItem('roomtalk_current_room')!).id as string);
  await expectCompletedTurn(request, clientId, token!, topicRoomId);
  await page.getByRole('button', { name: 'Back to personal agent', exact: true }).click();

  await page.getByRole('button', { name: 'Goals', exact: true }).click();
  await page.getByRole('button', { name: 'New goal', exact: true }).click();
  await page.getByLabel('Goal title', { exact: true }).fill('Daily planning');
  await page.getByLabel('What should your agent do?', { exact: true }).fill('Make a concise plan for today.');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Daily planning', exact: true })).toBeVisible();
  const goalCard = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Daily planning', exact: true }) });
  await goalCard.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(goalCard.getByText('Paused', { exact: true })).toBeVisible();
  await goalCard.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('What should your agent do?', { exact: true }).fill('Make a short plan for today.');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(goalCard.getByText('Make a short plan for today.', { exact: true })).toBeVisible();
  await goalCard.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(goalCard.getByText('Active', { exact: true })).toBeVisible();
  const [runResponse] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/run') && response.url().includes('/api/personal-agent/goals/') && response.request().method() === 'POST'),
    goalCard.getByRole('button', { name: 'Run now', exact: true }).click(),
  ]);
  expect(runResponse.ok()).toBeTruthy();
  const goalRun = await runResponse.json() as { room: Room };
  await expect(page.getByText('Private conversation · Codex', { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const response = await request.get(`${serverURL}/api/clients/${clientId}/rooms/${goalRun.room.id}`, { headers: accountHeaders(clientId, token!) });
    return (await response.json()).codeAgentStatus;
  }).toBe('running');
  await page.getByRole('button', { name: 'Back to personal agent', exact: true }).click();
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(page.getByRole('button').filter({ hasText: goalRun.room.name }).first()).toContainText('Working');
  await page.reload();
  await expect(page.getByTestId('personal-agent-view')).toBeVisible();
  await expectCompletedTurn(request, clientId, token!, goalRun.room.id);
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByRole('button').filter({ hasText: goalRun.room.name }).first().click();
  await expect(page.getByTestId('message-item').filter({ hasText: /fake runner received the task/ })).toBeVisible({ timeout: 20000 });

  const agentResponse = await request.get(`${serverURL}/api/personal-agent`, { headers: { 'X-Client-Id': clientId, 'X-Client-Auth-Token': token! } });
  expect(agentResponse.ok()).toBeTruthy();
  const snapshot = await agentResponse.json();
  expect(snapshot.rooms).toHaveLength(3);
  expect(snapshot.goals[0].lastRunRoomId).toBeTruthy();
  expect(snapshot.rooms.every((room: { personalAgentOwnerId: string; codeAgentBackend: string }) => room.personalAgentOwnerId === clientId && room.codeAgentBackend === 'codex-app-server')).toBe(true);

  const otherContext = await browser.newContext();
  try {
    const otherId = await seedClient(otherContext, uniqueName('personal-other'));
    const otherPage = await otherContext.newPage();
    await openRoomsPage(otherPage);
    await otherPage.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await otherPage.getByLabel('User ID password', { exact: true }).first().fill('Personal-agent-other-2026');
    await otherPage.getByRole('button', { name: 'Set password', exact: true }).click();
    await expect(otherPage.getByText('User ID password saved.', { exact: true })).toBeVisible();
    const otherToken = await otherPage.evaluate(() => localStorage.getItem('clientAuthToken'));
    const metadata = await request.get(`${serverURL}/api/clients/${otherId}/rooms/${snapshot.profile.mainRoomId}`, { headers: { 'X-Client-Id': otherId, 'X-Client-Auth-Token': otherToken! } });
    expect(metadata.status()).toBe(404);
    const denied = await request.get(`${serverURL}/api/rooms/${snapshot.profile.mainRoomId}/messages?clientId=${encodeURIComponent(otherId)}`, { headers: { 'X-Client-Id': otherId, 'X-Client-Auth-Token': otherToken! } });
    expect(denied.status()).toBe(403);
    await otherPage.goto(`/?room=${snapshot.profile.mainRoomId}`);
    await expect(otherPage.getByTestId('message-editor')).toHaveCount(0);
    await expect(otherPage.getByTestId('personal-agent-view')).toHaveCount(0);
    await expect(otherPage.getByTestId('chat-room-title')).toHaveCount(0);
    const privateRoom = snapshot.rooms.find((room: { id: string }) => room.id === snapshot.profile.mainRoomId);
    await otherPage.evaluate(room => {
      localStorage.setItem('roomtalk_current_room', JSON.stringify(room));
      localStorage.setItem('roomtalk_current_view', 'chat');
    }, privateRoom);
    await otherPage.goto('/');
    await expect.poll(() => otherPage.evaluate(() => localStorage.getItem('roomtalk_current_room'))).toBeNull();
    await expect(otherPage.getByTestId('chat-room-title')).toHaveCount(0);
    await expect(otherPage.getByTestId('message-editor')).toHaveCount(0);
  } finally { await otherContext.close(); }
});
