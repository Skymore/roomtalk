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
  await page.getByLabel('About you', { exact: true }).fill('I prefer Chinese and live in Seattle.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Agent preferences and memory saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('personal-agent-view')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Willow', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await expect(page.getByLabel('About you', { exact: true })).toHaveValue('I prefer Chinese and live in Seattle.');
  await expect(page.getByLabel('How to work with you', { exact: true })).toHaveValue('Give me concise, practical answers.');

  await page.getByRole('button', { name: 'Add a memory', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Answer language');
  await page.getByLabel('What to remember', { exact: true }).fill('Please answer in Chinese.');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('personal-memory-entry')).toContainText('Please answer in Chinese.');
  await page.reload();
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search memories', exact: true }).fill('language');
  await expect(page.getByTestId('personal-memory-entry')).toHaveCount(1);
  await page.getByTestId('personal-memory-entry').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('What to remember', { exact: true }).fill('Please answer in Chinese and keep it concise.');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('personal-memory-entry')).toContainText('keep it concise');
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('personal-agent-desktop.png'), fullPage: true });
  copyFileSync(testInfo.outputPath('personal-agent-desktop.png'), '/tmp/roomtalk-personal-agent-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('bottom-nav')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Talk to your agent', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('personal-agent-mobile.png'), fullPage: true });
  copyFileSync(testInfo.outputPath('personal-agent-mobile.png'), '/tmp/roomtalk-personal-agent-mobile.png');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('button', { name: 'Talk to your agent', exact: true }).click();
  await expect(page.getByTestId('message-editor')).toBeVisible();
  await page.screenshot({ path: '/tmp/roomtalk-personal-conversation-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/roomtalk-personal-conversation-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });

  await expect(page.getByTestId('personal-agent-conversation')).toBeVisible();
  await expect(page.getByRole('button', { name: /Overview|Artifacts|Changes|Codex|Permission|Context|Cost/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Room Actions', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to your agent', exact: true }).first().click();

  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page.getByLabel('Task name', { exact: true }).fill('Plan my week');
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  await expect(page.getByTestId('personal-agent-conversation').getByText('Plan my week', { exact: true })).toBeVisible();
  await page.getByTestId('message-editor').fill('Suggest a simple weekly plan.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByTestId('personal-agent-message').filter({ hasText: /fake runner received the task/ })).toBeVisible({ timeout: 20000 });
  const topicRoomId = await page.evaluate(() => JSON.parse(localStorage.getItem('roomtalk_current_room')!).id as string);
  await expectCompletedTurn(request, clientId, token!, topicRoomId);
  await page.screenshot({ path: '/tmp/roomtalk-personal-conversation-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/roomtalk-personal-conversation-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('button', { name: 'Back to your agent', exact: true }).first().click();

  // Organizing a topic keeps the same room, transcript, shared memory and main chat.
  const topicCard = page.getByTestId('personal-agent-chat-card').filter({ hasText: 'Plan my week' });
  await topicCard.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByLabel('Task name', { exact: true }).fill('My weekly plan');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  const renamedCard = page.getByTestId('personal-agent-chat-card').filter({ hasText: 'My weekly plan' });
  await expect(renamedCard).toBeVisible();
  await page.getByRole('textbox', { name: 'Search conversations', exact: true }).fill('no matching topic');
  await expect(page.getByTestId('personal-agent-chat-card')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Search conversations', exact: true }).fill('WEEKLY');
  await expect(renamedCard).toBeVisible();
  await renamedCard.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByTestId('personal-agent-chat-card')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Talk to your agent', exact: true })).toBeVisible();
  await expect(page.getByTestId('personal-agent-chat-card')).toHaveCount(0);
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await expect(renamedCard).toBeVisible();
  await page.screenshot({ path: '/tmp/roomtalk-personal-chats-archive-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/roomtalk-personal-chats-archive-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await renamedCard.getByRole('button').filter({ hasText: 'My weekly plan' }).click();
  await expect(page.getByTestId('personal-agent-message').filter({ hasText: /fake runner received the task/ })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('roomtalk_current_room')!).id)).toBe(topicRoomId);
  await page.getByRole('button', { name: 'Back to your agent', exact: true }).first().click();
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await renamedCard.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByTestId('personal-agent-chat-card')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show active', exact: true }).click();
  await expect(renamedCard).toBeVisible();
  await page.reload();
  await expect(renamedCard).toBeVisible();

  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page.getByLabel('Task name', { exact: true }).fill('Interrupt a task');
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  await page.getByTestId('message-editor').fill('Help me plan a long project.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.getByTestId('message-editor').fill('Keep this draft while stopping.');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByTestId('message-editor')).toHaveText('Keep this draft while stopping.');
  await page.reload();
  await expect(page.getByTestId('message-editor')).toHaveText('Keep this draft while stopping.');
  await page.getByRole('button', { name: 'Back to your agent', exact: true }).first().click();

  await page.getByRole('button', { name: 'Goals', exact: true }).click();
  await page.getByRole('button', { name: 'New goal', exact: true }).click();
  await page.getByLabel('Goal title', { exact: true }).fill('Daily planning');
  await page.getByLabel('What should your agent do?', { exact: true }).fill('Make a concise plan for today.');
  await page.getByRole('dialog').getByLabel('Milestones', { exact: true }).fill('Prepare a weekly plan');
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
  // Weekly and one-time schedules are created through the real independent form.
  await page.getByRole('button', { name: 'New goal', exact: true }).click();
  await page.getByLabel('Goal title', { exact: true }).fill('Friday review');
  await page.getByLabel('What should your agent do?', { exact: true }).fill('Review my weekly progress.');
  await page.getByRole('dialog').getByLabel('Schedule', { exact: true }).click();
  await page.getByRole('option', { name: 'Every week', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Friday', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  const fridayCard = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Friday review', exact: true }) });
  await expect(fridayCard).toContainText('Friday');
  await page.reload();
  await page.getByRole('button', { name: 'Goals', exact: true }).click();
  await expect(fridayCard).toContainText('Friday');
  await fridayCard.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(fridayCard).toHaveCount(0);
  await page.getByRole('button', { name: 'New goal', exact: true }).click();
  await page.getByLabel('Goal title', { exact: true }).fill('Tomorrow review');
  await page.getByLabel('What should your agent do?', { exact: true }).fill('Review tomorrow.');
  await page.getByRole('dialog').getByLabel('Schedule', { exact: true }).click();
  await page.getByRole('option', { name: 'One time', exact: true }).click();
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const localFuture = new Date(future.getTime() - future.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await page.getByLabel('Execution date', { exact: true }).fill(localFuture);
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  const onceCard = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Tomorrow review', exact: true }) });
  await expect(onceCard).toContainText('One time');
  await expect(onceCard).toContainText(/\d{1,2}:\d{2}/);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/roomtalk-personal-goal-schedules-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();
  await page.getByRole('button', { name: 'Goals', exact: true }).click();
  await expect(onceCard).toContainText('One time');
  await expect(onceCard).toContainText(/\d{1,2}:\d{2}/);
  await onceCard.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(onceCard).toHaveCount(0);

  const [runResponse] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/run') && response.url().includes('/api/personal-agent/goals/') && response.request().method() === 'POST'),
    goalCard.getByRole('button', { name: 'Run now', exact: true }).click(),
  ]);
  expect(runResponse.ok()).toBeTruthy();
  const goalRun = await runResponse.json() as { room: Room };
  await expect(page.getByTestId('personal-agent-conversation')).toBeVisible();
  await expect(page.getByRole('button', { name: /Overview|Artifacts|Changes|Codex|Permission|Context|Cost/ })).toHaveCount(0);
  await expect.poll(async () => {
    const response = await request.get(`${serverURL}/api/clients/${clientId}/rooms/${goalRun.room.id}`, { headers: accountHeaders(clientId, token!) });
    return (await response.json()).codeAgentStatus;
  }).toBe('running');
  await page.getByRole('button', { name: 'Back to your agent', exact: true }).first().click();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  const workingCard = page.getByTestId('personal-agent-chat-card').filter({ hasText: goalRun.room.name });
  await workingCard.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(workingCard).toHaveCount(0);
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(page.getByRole('button').filter({ hasText: goalRun.room.name }).first()).toContainText('Working');
  await page.reload();
  await expect(page.getByTestId('personal-agent-view')).toBeVisible();
  await expectCompletedTurn(request, clientId, token!, goalRun.room.id);
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByRole('button').filter({ hasText: goalRun.room.name }).first().click();
  await expect(page.getByTestId('personal-agent-message').filter({ hasText: /fake runner received the task/ })).toBeVisible({ timeout: 20000 });

  await page.getByRole('button', { name: 'Back to your agent', exact: true }).first().click();
  await page.getByRole('button', { name: 'Goals', exact: true }).click();
  await expect(goalCard).toContainText('Latest run: Finished');
  await goalCard.getByRole('checkbox', { name: 'Prepare a weekly plan', exact: true }).click();
  await expect(goalCard.getByRole('checkbox', { name: 'Prepare a weekly plan', exact: true })).toBeChecked();
  await goalCard.getByRole('button', { name: 'Mark complete', exact: true }).click();
  await expect(goalCard.getByText('Completed', { exact: true })).toBeVisible();
  await expect(goalCard.getByRole('button', { name: 'Run now', exact: true })).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: 'Goals', exact: true }).click();
  await expect(goalCard.getByText('Completed', { exact: true })).toBeVisible();
  await goalCard.getByRole('button', { name: 'Reopen', exact: true }).click();
  const [cancelRunResponse] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/run') && response.url().includes('/api/personal-agent/goals/') && response.request().method() === 'POST'),
    goalCard.getByRole('button', { name: 'Run now', exact: true }).click(),
  ]);
  expect(cancelRunResponse.ok()).toBeTruthy();
  const cancelRun = await cancelRunResponse.json() as { room: Room };
  await expect(page.getByTestId('personal-agent-conversation')).toBeVisible();
  await expect.poll(async () => {
    const response = await request.get(`${serverURL}/api/clients/${clientId}/rooms/${cancelRun.room.id}`, { headers: accountHeaders(clientId, token!) });
    return (await response.json()).codeAgentStatus;
  }).toBe('running');
  await page.getByRole('button', { name: 'Back to your agent', exact: true }).first().click();
  await page.getByRole('button', { name: 'Goals', exact: true }).click();
  await goalCard.getByRole('button', { name: 'Cancel work', exact: true }).click();
  await expect(page.getByText('Cancellation requested; checking actual progress.', { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const response = await request.get(`${serverURL}/api/personal-agent`, { headers: accountHeaders(clientId, token!) });
    return (await response.json()).goals.find((item: { lastRunRoomId: string }) => item.lastRunRoomId === cancelRun.room.id)?.lastRun?.status;
  }).toBe('cancelled');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(goalCard).toContainText('Latest run: Stopped');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/roomtalk-personal-goal-tools-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await page.getByTestId('personal-memory-entry').getByRole('button', { name: 'Forget', exact: true }).click();
  await expect(page.getByTestId('personal-memory-entry')).toHaveCount(0);

  const agentResponse = await request.get(`${serverURL}/api/personal-agent`, { headers: { 'X-Client-Id': clientId, 'X-Client-Auth-Token': token! } });
  expect(agentResponse.ok()).toBeTruthy();
  const snapshot = await agentResponse.json();
  expect(snapshot.rooms).toHaveLength(5);
  expect(snapshot.goals[0].lastRunRoomId).toBeTruthy();
  expect(snapshot.rooms.every((room: { personalAgentOwnerId: string; codeAgentBackend: string }) => room.personalAgentOwnerId === clientId && room.codeAgentBackend === 'codex-app-server' && (room as Room).codeAgentMode === 'fullAccess')).toBe(true);

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
    const deniedEdit = await request.patch(`${serverURL}/api/personal-agent/threads/${topicRoomId}`, {
      headers: accountHeaders(otherId, otherToken!), data: { name: 'Stolen topic', archived: true },
    });
    expect(deniedEdit.status()).toBe(404);
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

test('continues a topic and reviews conflicting memories before an atomic merge', async ({ page, context, request }) => {
  test.setTimeout(90_000);
  const clientId = await seedClient(context, uniqueName('topic-owner'));
  await page.addInitScript(() => { window.open = () => null; });
  await openRoomsPage(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByLabel('User ID password', { exact: true }).first().fill('Topic-agent-test-2026');
  await page.getByRole('button', { name: 'Set password', exact: true }).click();
  await expect(page.getByText('User ID password saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Connect Codex', exact: true }).click();
  await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible({ timeout: 15000 });
  const token = (await page.evaluate(() => localStorage.getItem('clientAuthToken')))!;
  const headers = accountHeaders(clientId, token);
  await openPersonalAgent(page);
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  const addTopic = async (title: string, content: string) => {
    await page.getByRole('button', { name: 'Add a memory', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Type', { exact: true }).click();
    await page.getByRole('option', { name: 'Topic note', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill(title);
    await page.getByLabel('What to remember', { exact: true }).fill(content);
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  };
  await addTopic('Project handoff', 'Brief: plan a trip.\nDecision: Seattle.\nVerified work: researched options.\nNext steps: compare dates.');
  await addTopic('Related research', 'Confirmed correction: Vancouver, not Seattle.\nNext steps: confirm dates.');
  const memories = (await (await request.get(`${serverURL}/api/personal-agent/memories`, { headers })).json()).memories as Array<{ id: string; title: string; kind: string; content: string; updatedAt: string }>;
  const first = memories.find(entry => entry.title === 'Project handoff')!, second = memories.find(entry => entry.title === 'Related research')!;
  const duplicate = await request.post(`${serverURL}/api/personal-agent/memories`, { headers, data: { kind: 'topic', title: '  PROJECT   HANDOFF  ', content: 'Conflicting copy' } });
  expect(duplicate.status()).toBe(409); expect((await duplicate.json()).existingMemory.id).toBe(first.id);
  const card = (title: string) => page.getByTestId('personal-memory-entry').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  const [threadResponse] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/personal-agent/threads') && response.request().method() === 'POST'),
    card(second.title).getByRole('button', { name: 'Continue this topic', exact: true }).click(),
  ]);
  const { room } = await threadResponse.json() as { room: Room };
  expect(room.personalAgentMemoryId).toBe(second.id);
  await expect(page.getByTestId('personal-agent-conversation')).toBeVisible();
  await page.getByTestId('message-editor').fill('Continue this topic from its saved handoff.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expectCompletedTurn(request, clientId, token, room.id);
  await page.getByRole('button', { name: 'Back to your agent', exact: true }).first().click();
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await page.getByRole('button', { name: 'Organize memories', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Project handoff', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Related research', exact: true }).click();
  await page.getByRole('button', { name: 'Merge 2 memories', exact: true }).click();
  await page.getByRole('dialog').getByLabel('What to remember', { exact: true }).fill('Confirmed destination: Vancouver. Next steps: compare dates.');
  // Another conversation corrects a selected note after the merge form was opened.
  const revised = await request.patch(`${serverURL}/api/personal-agent/memories/${second.id}`, { headers, data: { ...second, content: 'Vancouver confirmed. Dates now confirmed too.', expectedUpdatedAt: second.updatedAt } });
  expect(revised.ok()).toBeTruthy();
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('A selected memory changed or was removed. Read all selected memories again before merging.', { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(card(second.title)).toContainText('Dates now confirmed too.');
  await page.getByRole('button', { name: 'Merge 2 memories', exact: true }).click();
  await page.getByRole('dialog').getByLabel('What to remember', { exact: true }).fill('Brief: plan a trip.\nDecision: Vancouver. Dates confirmed.\nVerified work: compared options.\nNext steps: book the trip.');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('personal-memory-entry')).toHaveCount(1);
  await expect(card(first.title)).toContainText('Dates confirmed.');
  const merged = (await (await request.get(`${serverURL}/api/personal-agent/memories`, { headers })).json()).memories;
  expect(merged[0].id).toBe(first.id); expect(merged[0].provenance.length).toBeGreaterThanOrEqual(3);
  const rebound = await request.get(`${serverURL}/api/clients/${clientId}/rooms/${room.id}`, { headers });
  expect((await rebound.json()).personalAgentMemoryId).toBe(first.id);
  await page.reload(); await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await expect(card(first.title)).toContainText('book the trip');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/roomtalk-personal-topic-memory-mobile.png', fullPage: true });
  await card(first.title).getByRole('button', { name: 'Forget', exact: true }).click();
  await expect(page.getByTestId('personal-memory-entry')).toHaveCount(0);
  expect((await (await request.get(`${serverURL}/api/clients/${clientId}/rooms/${room.id}`, { headers })).json()).personalAgentMemoryId).toBeUndefined();
});
