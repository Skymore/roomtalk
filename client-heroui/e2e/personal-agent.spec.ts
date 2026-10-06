import { createHmac, randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
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

const openMemorySettings = async (page: Page) => {
  await page.getByRole('button', {name:'Apps',exact:true}).click();
  await page.getByRole('button', {name:/^Personality & memory/}).click();
  await expect(page.getByTestId('personal-memory-library')).toBeVisible();
  await expect(page.getByLabel('Agent name',{exact:true})).toHaveCount(0);
  await page.getByTestId('personal-agent-profile-summary').getByRole('button',{name:'Edit',exact:true}).click();
};
const openFiles = async (page: Page) => {
  await page.getByRole('button',{name:'Apps',exact:true}).click();
  await page.getByRole('button',{name:/^Files/}).click();
};


const openThreads=async(page:Page)=>{
  if(await page.getByRole('dialog').getByRole('button',{name:'New side chat',exact:true}).first().isVisible())return;
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'Conversations',exact:true}).first().click();
  await expect(page.getByRole('dialog').getByRole('button',{name:'New side chat',exact:true})).toBeVisible();
};
const closeThreads=async(page:Page)=>{await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).first().click();await expect(page.getByRole('dialog')).toHaveCount(0);};
const createSideChat=async(page:Page,name:string)=>{
  await openThreads(page);await page.getByRole('button',{name:'New side chat',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('personal-agent-conversation')).toBeVisible();
  await openThreads(page);
  const row=page.getByTestId('personal-agent-chat-card').filter({hasText:'Side chat'}).first();
  await row.getByRole('button',{name:'Rename',exact:true}).click();await page.getByLabel('Conversation name',{exact:true}).fill(name);
  await page.getByRole('button',{name:'Save name',exact:true}).click();await page.getByTestId('personal-agent-chat-card').filter({hasText:name}).getByRole('button').first().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
};

const accountHeaders = (clientId: string, token: string) => ({ 'X-Client-Id': clientId, 'X-Client-Auth-Token': token });

const expectCompletedTurn = async (request: APIRequestContext, clientId: string, token: string, roomId: string) => {
  await expect.poll(async () => {
    const [roomResponse, messagesResponse,taskResponse] = await Promise.all([
      request.get(`${serverURL}/api/clients/${clientId}/rooms/${roomId}`, { headers: accountHeaders(clientId, token) }),
      request.get(`${serverURL}/api/rooms/${roomId}/messages?clientId=${encodeURIComponent(clientId)}`, { headers: accountHeaders(clientId, token) }),
      request.get(`${serverURL}/api/personal-agent/tasks/${roomId}`,{headers:accountHeaders(clientId,token)}),
    ]);
    if (!roomResponse.ok() || !messagesResponse.ok() || !taskResponse.ok()) return 'unavailable';
    const room = await roomResponse.json() as Room;
    const messages = await messagesResponse.json() as Message[];
    const answers = messages.filter(message => message.messageType === 'ai');
    const task=await taskResponse.json();
    const latest=answers.at(-1);
    const complete=task.turns.at(-1)?.status==='complete' && !['queued','running','paused','cancelled','error'].includes(task.room.personalAgentTaskStatus) && latest?.status==='complete' && latest.content.includes('fake runner received the task');
    return room.codeAgentStatus==='idle' && room.codeAgentSessionId && complete?'complete':room.codeAgentStatus;
  }, { timeout: 20000 }).toBe('complete');
};

test('shows account sign-in guidance to guests', async ({ page, context }) => {
  await seedClient(context, uniqueName('personal-guest'));
  await openRoomsPage(page);
  await page.getByRole('button', { name: 'Personal Agent', exact: true }).first().click();
  await expect(page.getByText('Sign in to your RoomTalk account in Settings to create a private personal agent.', { exact: true })).toBeVisible();
});

test('tracks a real page, deduplicates updates, pauses and preserves read/preferences across reload', async ({ page, context, request }) => {
  test.setTimeout(120_000);
  const { createServer } = await import('node:http');
  let text = 'Sold out';
  const fixture = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<title>Actual stock</title><h1>${text}</h1>`); });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address(); if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
  try {
    const clientId = await seedClient(context, uniqueName('tracking-owner'));
    await openRoomsPage(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await page.getByLabel('User ID password', { exact: true }).first().fill('Personal-tracking-test-2026');
    await page.getByRole('button', { name: 'Set password', exact: true }).click();
    await expect(page.getByText('User ID password saved.', { exact: true })).toBeVisible();
    await openPersonalAgent(page);
    const token = (await page.evaluate(() => localStorage.getItem('clientAuthToken')))!;
    const headers = accountHeaders(clientId, token);
    const readWatch = async () => (await (await request.get(`${serverURL}/api/personal-agent/watches`, { headers })).json()).watches[0];
    await page.getByRole('button', { name: 'Goals', exact: true }).click();
    await page.getByRole('button', { name: 'Track', exact: true }).click();
    await page.getByLabel('What are you watching?', { exact: true }).fill('Stock availability');
    await page.getByLabel('Public page URL', { exact: true }).fill(`http://127.0.0.1:${address.port}/`);
    await page.getByRole('button', { name: 'Start tracking', exact: true }).click();
    await expect(page.getByTestId('personal-watch-card')).toBeVisible();
    await expect.poll(async () => (await readWatch())?.checks || 0, { timeout: 30000 }).toBe(1);
    const baseline = await readWatch(); expect(baseline.lastExcerpt).toBe('Sold out');
    expect((await (await request.get(`${serverURL}/api/personal-agent/notifications`, { headers })).json()).total).toBe(0);
    text = 'Available for $90';
    await page.getByTestId('personal-watch-card').click();
    await expect(page.getByRole('dialog').getByText(/^Last checked:/)).toBeVisible();
    await page.getByRole('dialog').getByRole('button',{name:'Check now',exact:true}).click();
    await expect.poll(async () => (await readWatch()).checks, { timeout: 20000 }).toBe(2);
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
    await page.getByRole('button', { name: 'Updates for you', exact: true }).click();
    const update = page.getByTestId('personal-update-card');
    await expect(update).toContainText('Available for $90');
    await update.getByRole('button', { name: 'View task', exact: true }).click();
    await expect(page.getByRole('dialog').getByText('Tracking', { exact: true })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Updates for you', exact: true }).click();
    await expect(update.getByText('New', {exact:true})).toHaveCount(0);
    await page.reload(); await page.getByRole('button', { name: 'Updates for you', exact: true }).click();
    await expect(update).toContainText('Available for $90');
    await expect(update.getByText('New', {exact:true})).toHaveCount(0);
    const changed = await readWatch();
    expect((await request.patch(`${serverURL}/api/personal-agent/watches/${changed.id}`, { headers, data: { action: 'check', expectedUpdatedAt: changed.updatedAt } })).ok()).toBe(true);
    await expect.poll(async () => (await readWatch()).checks, { timeout: 20000 }).toBe(3);
    expect((await (await request.get(`${serverURL}/api/personal-agent/notifications`, { headers })).json()).total).toBe(1);
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
    await page.getByRole('button', { name: 'Goals', exact: true }).click();
    await page.getByTestId('personal-watch-card').click();
    await page.getByRole('dialog').getByRole('button',{name:'Pause',exact:true}).click();
    await expect(page.getByRole('dialog').getByRole('button',{name:'Resume',exact:true})).toBeVisible();
    await page.reload(); await page.getByRole('button', { name: 'Goals', exact: true }).click();
    await expect(page.getByTestId('personal-watch-card')).toContainText('Paused');
    await page.getByRole('button',{name:'Activity',exact:true}).click();
    const monitorTask=page.getByTestId('personal-activity-room').filter({hasText:'Stock availability'});
    await expect(monitorTask).toContainText('Paused');await monitorTask.click();
    await expect(page.getByRole('dialog').getByText('Available for $90',{exact:true})).toBeVisible();
    await page.getByRole('dialog').getByRole('button',{name:'Resume',exact:true}).click();
    await expect(page.getByRole('dialog').getByRole('button',{name:'Pause',exact:true})).toBeVisible();
    await page.getByRole('dialog').getByRole('button',{name:'Pause',exact:true}).click();
    await expect(page.getByRole('dialog').getByRole('button',{name:'Resume',exact:true})).toBeVisible();
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
    await page.getByRole('button',{name:'Goals',exact:true}).click();
    await page.getByTestId('personal-watch-card').click();
    await page.getByRole('dialog').getByRole('button',{name:'View task',exact:true}).click();
    await expect(page.getByRole('dialog').getByText('Tracking',{exact:true})).toBeVisible();
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: 'Apps', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '/tmp/roomtalk-personal-tracking-mobile.png', fullPage: true });
    await openMemorySettings(page);
    await page.getByRole('checkbox', { name: 'Show background updates on your agent page', exact: true }).uncheck();

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Agent preferences and memory saved', { exact: true })).toBeVisible();
    await page.reload(); await openMemorySettings(page);
    await expect(page.getByRole('checkbox', { name: 'Show background updates on your agent page', exact: true })).not.toBeChecked();
    await page.getByRole('button', { name: 'Goals', exact: true }).click();
    await page.getByTestId('personal-watch-card').click();
    await page.getByRole('dialog').getByRole('button',{name:'Stop tracking',exact:true}).click();
    await expect(page.getByRole('dialog').getByText('Stopped',{exact:true})).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('button',{name:'Resume',exact:true})).toHaveCount(0);
    await page.reload();await page.getByRole('button',{name:'Goals',exact:true}).click();
    await expect(page.getByTestId('personal-watch-card')).toContainText('Stopped');
    expect((await readWatch()).lastExcerpt).toBe('Available for $90');
  } finally { const closed=new Promise<void>(resolve=>fixture.close(()=>resolve()));fixture.closeAllConnections();await closed; }
});

test('accepts an edited sourced suggestion exactly once and preserves dismissed decisions', async ({ page, context, request }, testInfo) => {
  test.setTimeout(90_000);
  const clientId = await seedClient(context, uniqueName('idea-owner'));
  await page.addInitScript(() => { window.open = () => null; });
  await openRoomsPage(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByLabel('User ID password', { exact: true }).first().fill('Personal-ideas-test-2026');
  await page.getByRole('button', { name: 'Set password', exact: true }).click();
  await expect(page.getByText('User ID password saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Connect Codex', exact: true }).click();
  await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible({ timeout: 15000 });
  const token = (await page.evaluate(() => localStorage.getItem('clientAuthToken')))!;
  await openPersonalAgent(page);
  const headers = accountHeaders(clientId, token);
  for (const title of ['Prepare my trip', 'Review my reading']) {
    const saved = await request.post(`${serverURL}/api/personal-agent/goals`, { headers,
      data: { title, prompt: `Create steps for ${title}`, schedule: 'manual', time: '09:00', timezone: 'UTC' } });
    expect(saved.status()).toBe(201);
  }
  await page.getByRole('button', { name: 'Ideas', exact: true }).click();
  await page.getByRole('button', { name: 'Find ideas', exact: true }).click();
  const card = page.getByTestId('personal-idea-card').filter({ hasText: 'Prepare my trip' });
  await expect(card).toBeVisible();
  await card.getByRole('button',{name:/^View idea:/}).click();
  await expect(card.getByText('Create steps for Prepare my trip', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await card.getByLabel('What should the agent do?', { exact: true }).fill('Prepare a concise itinerary for my trip.');
  const before = await request.get(`${serverURL}/api/personal-agent/ideas`, { headers });
  const original = (await before.json()).ideas.find((idea: any) => idea.source.title === 'Prepare my trip');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('personal-ideas-mobile.png'), fullPage: true });
  copyFileSync(testInfo.outputPath('personal-ideas-mobile.png'), '/tmp/roomtalk-personal-ideas-mobile.png');
  const [accepted]=await Promise.all([page.waitForResponse(response=>response.url().endsWith(`/ideas/${original.id}`) && response.request().method()==='PATCH'),card.getByRole('button',{name:'Start this',exact:true}).click()]);
  const roomId=(await accepted.json()).room.id;
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectCompletedTurn(request, clientId, token, roomId);
  const replay = await request.patch(`${serverURL}/api/personal-agent/ideas/${original.id}`, { headers,
    data: { action: 'accept', prompt: 'Retry must not create another task', expectedUpdatedAt: original.updatedAt } });
  expect(replay.status()).toBe(200); expect((await replay.json()).room.id).toBe(roomId);
  await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Ideas', exact: true }).click();
  const reading=page.getByTestId('personal-idea-card').filter({hasText:'Review my reading'});
  await expect(reading).toBeVisible();await reading.getByRole('button',{name:/^View idea:/}).click();
  await reading.getByRole('button', { name: 'Dismiss', exact: true }).click();await expect(reading).toHaveCount(0);
  await page.reload();await page.getByRole('button', { name: 'Ideas', exact: true }).click();
  await expect(reading).toHaveCount(0);
  const final = await request.get(`${serverURL}/api/personal-agent/ideas?status=all`, { headers });
  const finalIdeas=(await final.json()).ideas;
  expect(finalIdeas.find((idea:any)=>idea.id===original.id).status).toBe('accepted');
  expect(finalIdeas.find((idea:any)=>idea.source.title==='Review my reading').status).toBe('dismissed');
  // Accepting an idea creates a separate goal, as OpenMuse does. Its plan may generate a new suggestion.
  const snapshot = await request.get(`${serverURL}/api/personal-agent`, { headers });
  const rooms = (await snapshot.json()).rooms;
  expect(rooms.filter((room: Room) => room.personalAgentThreadKind === 'task')).toHaveLength(1);
  expect(rooms.find((room: Room) => room.id === roomId).codeAgentMode).toBe('fullAccess');
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
  await openMemorySettings(page);
  await page.getByLabel('Agent name', { exact: true }).fill('Willow');
  await page.getByRole('radio',{name:'Lilac avatar',exact:true}).click();
  await page.getByRole('button',{name:'Concise',exact:true}).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Agent preferences and memory saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('personal-agent-view')).toBeVisible();
  await expect(page.getByTestId('personal-agent-view').getByRole('button',{name:/Open Willow activity/})).toBeVisible();
  await openMemorySettings(page);
  await expect(page.getByLabel('Agent name',{exact:true})).toHaveValue('Willow');
  await expect(page.getByRole('radio',{name:'Lilac avatar',exact:true})).toHaveAttribute('aria-checked','true');

  await page.getByLabel('Remember something about me',{exact:true}).fill('Please answer in Chinese.');
  await page.getByRole('button',{name:'Remember',exact:true}).click();
  await expect(page.getByTestId('personal-memory-entry')).toContainText('Please answer in Chinese.');
  await page.reload();await openMemorySettings(page);
  await page.getByTestId('personal-memory-entry').getByRole('button',{name:'Edit',exact:true}).click();
  await page.getByTestId('personal-memory-entry').getByLabel('Memory',{exact:true}).fill('Please answer in Chinese and keep it concise.');
  await page.getByTestId('personal-memory-entry').getByRole('button',{name:'Save correction',exact:true}).click();
  await expect(page.getByTestId('personal-memory-entry')).toContainText('keep it concise');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('personal-agent-desktop.png'), fullPage: true });
  copyFileSync(testInfo.outputPath('personal-agent-desktop.png'), '/tmp/roomtalk-personal-agent-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('bottom-nav')).toHaveCount(0);
  await expect(page.getByTestId('personal-agent-conversation')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('personal-agent-mobile.png'), fullPage: true });
  copyFileSync(testInfo.outputPath('personal-agent-mobile.png'), '/tmp/roomtalk-personal-agent-mobile.png');
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByRole('button', { name: 'Talk to your agent', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('message-editor')).toBeVisible();
  await page.screenshot({ path: '/tmp/roomtalk-personal-conversation-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/roomtalk-personal-conversation-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });

  await expect(page.getByTestId('personal-agent-conversation')).toBeVisible();
  await expect(page.getByRole('button', { name: /Overview|Artifacts|Changes|Codex|Permission|Context|Cost/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Room Actions', exact: true })).toHaveCount(0);
  await openThreads(page);

  await createSideChat(page,'Plan my week');
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
  await openThreads(page);

  // Organizing a topic keeps the same room, transcript, shared memory and main chat.
  const topicCard = page.getByTestId('personal-agent-chat-card').filter({ hasText: 'Plan my week' });
  await topicCard.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByLabel('Conversation name', { exact: true }).fill('My weekly plan');
  await page.getByRole('dialog').getByRole('button', { name: 'Save name', exact: true }).click();
  const renamedCard = page.getByTestId('personal-agent-chat-card').filter({ hasText: 'My weekly plan' });
  await expect(renamedCard).toBeVisible();
  await renamedCard.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByTestId('personal-agent-chat-card')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('personal-agent-conversation')).toBeVisible();
  await expect(page.getByTestId('personal-agent-chat-card')).toHaveCount(0);
  await openThreads(page);
  const archiveToggle=page.getByRole('button',{name:/^(Archived|Show active)$/});
  if(await archiveToggle.textContent()==='Archived')await archiveToggle.click();
  await expect(renamedCard).toBeVisible();
  await page.screenshot({ path: '/tmp/roomtalk-personal-chats-archive-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/roomtalk-personal-chats-archive-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await renamedCard.getByRole('button').filter({ hasText: 'My weekly plan' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('personal-agent-message').filter({ hasText: /fake runner received the task/ })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('roomtalk_current_room')!).id)).toBe(topicRoomId);
  await openThreads(page);
  if(await page.getByRole('button',{name:'Archived',exact:true}).count())await page.getByRole('button',{name:'Archived',exact:true}).click();
  await renamedCard.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByTestId('personal-agent-chat-card')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show active', exact: true }).click();
  await expect(renamedCard).toBeVisible();
  await page.reload();await openThreads(page);
  await expect(renamedCard).toBeVisible();

  await createSideChat(page,'Interrupt a task');
  await page.getByTestId('message-editor').fill('Help me plan a long project.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.getByTestId('message-editor').fill('Keep this draft while stopping.');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByTestId('message-editor')).toHaveText('Keep this draft while stopping.');
  await page.reload();
  await expect(page.getByTestId('message-editor')).toHaveText('Keep this draft while stopping.');
  await openThreads(page);await closeThreads(page);

  await page.getByRole('button', { name: 'Goals', exact: true }).click();
  await page.getByRole('button',{name:'Create Finances goal',exact:true}).click();
  const sheet=page.getByRole('dialog');
  await sheet.getByLabel('Your goal',{exact:true}).fill('Daily planning');
  await sheet.getByLabel('What does success look like?',{exact:true}).fill('Make a concise plan for today.');
  await sheet.getByLabel('Milestones (one per line)',{exact:true}).fill('Prepare a weekly plan');
  await sheet.getByRole('button',{name:'Create goal',exact:true}).click();
  const goalRow=page.getByRole('button',{name:'Open goal: Daily planning',exact:true});
  await expect(goalRow).toBeVisible();
  await expect(page.getByRole('checkbox',{name:'Prepare a weekly plan',exact:true})).toHaveCount(0);
  await goalRow.click();
  await sheet.getByRole('button',{name:'Pause',exact:true}).click();await expect(sheet.getByText('Paused',{exact:true})).toBeVisible();
  await sheet.getByRole('button',{name:'Resume',exact:true}).click();await expect(sheet.getByText('Active',{exact:true})).toBeVisible();
  await sheet.getByRole('button',{name:'Complete goal',exact:true}).click();
  await expect(sheet.getByText('Completed',{exact:true})).toBeVisible();
  await expect(sheet.getByRole('checkbox',{name:'Prepare a weekly plan',exact:true})).not.toBeChecked();
  await sheet.getByRole('button',{name:'Close',exact:true}).click();await page.reload();
  await page.getByRole('button',{name:'Goals',exact:true}).click();await goalRow.click();
  await expect(sheet.getByText('Completed',{exact:true})).toBeVisible();
  await expect(sheet.getByRole('checkbox',{name:'Prepare a weekly plan',exact:true})).not.toBeChecked();
  await sheet.getByRole('button',{name:'Resume',exact:true}).click();
  const [runResponse]=await Promise.all([
    page.waitForResponse(response=>response.url().endsWith('/api/personal-agent/tasks') && response.request().method()==='POST'),
    sheet.getByRole('button',{name:'Plan next steps',exact:true}).click(),
  ]);
  expect(runResponse.ok()).toBe(true);const goalRun=await runResponse.json() as {room:Room};
  await expect(sheet.getByRole('banner').filter({hasText:'Plan: Daily planning'})).toBeVisible();
  await expectCompletedTurn(request,clientId,token!,goalRun.room.id);
  await sheet.getByRole('button',{name:'Close',exact:true}).click();
  await page.reload();await page.getByRole('button',{name:'Goals',exact:true}).click();await goalRow.click();
  await expect(sheet.getByRole('button').filter({hasText:'Plan: Daily planning'})).toBeVisible();
  await sheet.getByRole('checkbox',{name:'Prepare a weekly plan',exact:true}).click();
  await expect(sheet.getByRole('checkbox',{name:'Prepare a weekly plan',exact:true})).toBeChecked();
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'/tmp/roomtalk-openmuse-goal-detail-mobile.png',fullPage:true});
  await sheet.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Create Health goal',exact:true}).click();
  await sheet.getByLabel('Your goal',{exact:true}).fill('A short walk');
  await sheet.getByRole('button',{name:'Create goal',exact:true}).click();
  await expect(page.getByRole('button',{name:'Open goal: A short walk',exact:true})).toBeVisible();
  await page.screenshot({path:'/tmp/roomtalk-openmuse-goals-mobile.png',fullPage:true});
  await page.setViewportSize({width:1280,height:720});

  await openMemorySettings(page);
  await page.getByTestId('personal-memory-entry').getByRole('button', { name: 'Forget', exact: true }).click();
  await expect(page.getByTestId('personal-memory-entry')).toHaveCount(0);

  const agentResponse = await request.get(`${serverURL}/api/personal-agent`, { headers: { 'X-Client-Id': clientId, 'X-Client-Auth-Token': token! } });
  expect(agentResponse.ok()).toBeTruthy();
  const snapshot = await agentResponse.json();
  expect(snapshot.rooms).toHaveLength(4);
  expect(snapshot.rooms.some((room:Room)=>room.id===goalRun.room.id && room.personalAgentGoalId)).toBe(true);
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

test('inspects and corrects source memory inline, preserves conflicting drafts, and forgets it',async({page,context,request})=>{
  const clientId=await seedClient(context,uniqueName('memory-source-owner'));
  await openRoomsPage(page);await page.getByRole('button',{name:'Settings',exact:true}).first().click();
  await page.getByLabel('User ID password',{exact:true}).first().fill('Memory-source-test-2026');
  await page.getByRole('button',{name:'Set password',exact:true}).click();
  await expect(page.getByText('User ID password saved.',{exact:true})).toBeVisible();await openPersonalAgent(page);
  const token=(await page.evaluate(()=>localStorage.getItem('clientAuthToken')))!;const headers=accountHeaders(clientId,token);
  const original=(await (await request.post(`${serverURL}/api/personal-agent/memories`,{headers,data:{kind:'fact',title:'Preference',content:'Morning meetings work best.'}})).json()).memory;
  await openMemorySettings(page);const row=page.getByTestId('personal-memory-entry');
  await expect(row).toContainText(original.content);
  await row.getByRole('button',{name:'Edit',exact:true}).click();await row.getByLabel('Memory',{exact:true}).fill('Afternoons now work best.');
  const corrected=await request.patch(`${serverURL}/api/personal-agent/memories/${original.id}`,{headers,data:{...original,content:'Evenings confirmed.',expectedUpdatedAt:original.updatedAt}});expect(corrected.ok()).toBe(true);
  await row.getByRole('button',{name:'Save correction',exact:true}).click();
  await expect(row.getByRole('alert')).toBeVisible();await expect(row.getByLabel('Memory',{exact:true})).toHaveValue('Afternoons now work best.');
  await openMemorySettings(page);await expect(row).toContainText('Evenings confirmed.');
  await row.getByRole('button',{name:'Edit',exact:true}).click();await row.getByLabel('Memory',{exact:true}).fill('Late afternoons confirmed.');
  await row.getByRole('button',{name:'Save correction',exact:true}).click();await expect(row).toContainText('Late afternoons confirmed.');
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'/tmp/roomtalk-openmuse-memory-inline-mobile.png',fullPage:true});
  await row.getByRole('button',{name:'Forget',exact:true}).click();await expect(row).toHaveCount(0);
});

test('replays private plan, document and interactive web cards and downloads persisted files', async ({ page, context, request }) => {
  test.setTimeout(120_000);
  const clientId = await seedClient(context, uniqueName('result-owner'));
  await page.addInitScript(() => { window.open = () => null; });
  await openRoomsPage(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByLabel('User ID password', { exact: true }).first().fill('Personal-result-test-2026');
  await page.getByRole('button', { name: 'Set password', exact: true }).click();
  await expect(page.getByText('User ID password saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Connect Codex', exact: true }).click();
  await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible({ timeout: 15000 });
  const token = (await page.evaluate(() => localStorage.getItem('clientAuthToken')))!;
  const headers = accountHeaders(clientId, token);
  await openPersonalAgent(page);
  await createSideChat(page,'Reusable results');
  await expect(page.getByTestId('personal-agent-conversation').getByText('Reusable results', { exact: true })).toBeVisible();
  const roomId = await page.evaluate(() => JSON.parse(localStorage.getItem('roomtalk_current_room')!).id as string);
  await page.getByTestId('message-editor').fill('Create reusable results.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  let turnId = '';
  await expect.poll(async () => {
    const response = await request.get(`${serverURL}/api/rooms/${roomId}/messages?clientId=${clientId}`, { headers });
    const messages = await response.json() as Message[];
    turnId = messages.find(message => message.turnId)?.turnId || '';
    return Boolean(turnId);
  }).toBe(true);
  // Exercise the real broker while the deterministic test executor owns this turn.
  const claims = { v: 1, jti: randomUUID(), roomId, clientId, turnId, mode: 'fullAccess', exp: Math.floor(Date.now() / 1000) + 60 };
  const payload = Buffer.from(JSON.stringify(claims, Object.keys(claims).sort())).toString('base64url');
  const authorization = `Bearer ${payload}.${createHmac('sha256', 'e2e-personal-result-context-secret').update(payload).digest('base64url')}`;
  const plan = '# Confirmed week plan\n\n- [ ] Monday: finish the confirmed draft.\n- [ ] Tuesday: review the result.\n';
  const web = '<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:system-ui;padding:24px}button{padding:12px}</style></head><body><h1>Saved week page</h1><button id="next">Complete one step</button><p id="count">0 completed</p><script>let count=0;document.getElementById("next").onclick=()=>document.getElementById("count").textContent=(++count)+" completed";</script></body></html>';
  const stream = 'BT /F1 18 Tf 20 80 Td (Confirmed report) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const records = [];
  for (const item of [ { kind: 'plan', title: 'Confirmed week plan', filename: 'week.md', body: plan },
    { kind: 'document', title: 'Confirmed report', filename: 'report.pdf', body: pdf },
    { kind: 'web', title: 'Saved week page', filename: 'week.html', body: web } ]) {
    const saved = await request.patch(`${serverURL}/api/code-agent/room-context/personal-results`, { headers: { authorization }, data: {
      kind: item.kind, title: item.title, summary: 'A saved result from this conversation.', filename: item.filename, content: Buffer.from(item.body).toString('base64'),
    } });
    expect(saved.status()).toBe(200);
    const payload = await saved.json(); records.push({ ...item, result: payload.result });
    expect(payload.result.objectKey).toBeUndefined();
  }
  await expectCompletedTurn(request, clientId, token, roomId);
  await expect(page.getByTestId('personal-result-card')).toHaveCount(3);
  await page.reload();
  await expect(page.getByTestId('personal-result-card')).toHaveCount(3);
  await page.getByTestId('personal-result-card').filter({ hasText: 'Confirmed week plan' }).getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('Monday: finish the confirmed draft.', { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click();
  const pdfCard = page.getByTestId('personal-result-card').filter({ hasText: 'Confirmed report' });
  const downloadWait = page.waitForEvent('download');
  await pdfCard.getByRole('button', { name: 'Download', exact: true }).click();
  const download = await downloadWait;
  expect(download.suggestedFilename()).toBe('report.pdf');
  expect(readFileSync((await download.path())!, 'utf8')).toBe(pdf);
  await pdfCard.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('dialog').locator('iframe[title="Confirmed report"]')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.getByTestId('personal-result-card').filter({ hasText: 'Saved week page' }).getByRole('button', { name: 'Open', exact: true }).click();
  const frame = page.frameLocator('iframe[title="Saved week page"]');
  await expect(frame.getByRole('heading', { name: 'Saved week page' })).toBeVisible();
  await frame.getByRole('button', { name: 'Complete one step' }).click();
  await expect(frame.getByText('1 completed', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/roomtalk-personal-result-web-mobile.png', fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/roomtalk-personal-result-cards-mobile.png', fullPage: true });
  const lateSave = await request.patch(`${serverURL}/api/code-agent/room-context/personal-results`, { headers: { authorization }, data: {
    kind: 'plan', title: 'Too late', filename: 'late.md', content: Buffer.from(plan).toString('base64'),
  } });
  expect(lateSave.status()).toBe(403);
  expect((await request.get(`${serverURL}/api/personal-agent/results/${records[0].result.id}/content?clientId=${clientId}`)).status()).toBe(401);
  await expect(page.getByRole('button', { name: /Overview|Artifacts|Changes|Codex|Permission|Context|Cost/ })).toHaveCount(0);
});

test('shares a real browser with user takeover, sourced replay and restored login state', async ({ page, context, request }) => {
  test.setTimeout(120_000);
  const { createServer } = await import('node:http');
  const {PDFDocument}=createRequire(path.resolve('../server/package.json'))('pdf-lib');
  const pdf=await PDFDocument.create(),sheet=pdf.addPage();pdf.getForm().createTextField('Full name').addToPage(sheet,{x:40,y:550,width:300,height:30});const originalPdf=Buffer.from(await pdf.save());
  let clicks = 0, loginName = '', signedInVisits = 0;
  const fixture = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if(url.pathname==='/form.pdf'){res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename=browser-form.pdf'});res.end(originalPdf);return;}
    if (url.pathname === '/clicked') { clicks++; res.end('ok'); return; }
    if (url.pathname === '/login') { loginName = url.searchParams.get('name') || ''; res.writeHead(302, { 'Set-Cookie': 'session=confirmed; HttpOnly; Path=/', Location: '/' }); res.end(); return; }
    const signedIn = req.headers.cookie?.includes('session=confirmed');
    if (signedIn) signedInVisits++;
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>${url.pathname === '/other' ? 'Second page' : 'Confirmed browser page'}</title><style>body{margin:0;font:20px sans-serif}h1{position:absolute;left:40px;top:20px}#counter{position:absolute;left:40px;top:100px;width:160px;height:50px}input{position:absolute;left:40px;top:180px;width:220px;height:40px}p{position:absolute;left:40px;top:250px}</style><h1>Actual shared browser</h1><button id="counter" onclick="this.textContent=Number(this.textContent)+1;fetch('/clicked')">0</button><form action="/login"><input name="name" aria-label="Name"><button style="display:none">Submit</button></form><p>${signedIn ? 'Signed in' : 'Signed out'}</p><a id="pdf" style="position:absolute;left:40px;top:320px" href="/form.pdf">Download PDF form</a>`);
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address(); if (!address || typeof address === 'string') throw new Error('Browser fixture did not listen');
  const url = `http://127.0.0.1:${address.port}/`;
  try {
    const clientId = await seedClient(context, uniqueName('browser-owner'));
    await page.addInitScript(() => { window.open = () => null; });
    await openRoomsPage(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await page.getByLabel('User ID password', { exact: true }).first().fill('Personal-browser-test-2026');
    await page.getByRole('button', { name: 'Set password', exact: true }).click();
    await expect(page.getByText('User ID password saved.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Connect Codex', exact: true }).click();
    await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible({ timeout: 15000 });
    await openPersonalAgent(page);
    const token = await page.evaluate(() => localStorage.getItem('clientAuthToken')!);
    const headers = accountHeaders(clientId, token);
    await createSideChat(page,'Shared browsing');
    await expect(page.getByTestId('personal-agent-conversation').getByText('Shared browsing', { exact: true })).toBeVisible();
    const roomId = await page.evaluate(() => JSON.parse(localStorage.getItem('roomtalk_current_room')!).id as string);
    // Start Chromium through the same user control path before the short fake
    // model turn. Cold browser startup must not race its fixed event script.
    await page.getByRole('button',{name:'Agent computer',exact:true}).click();
    await page.getByRole('dialog').getByLabel('Website address',{exact:true}).fill(url);
    await page.getByRole('button',{name:'Open a browser session',exact:true}).click();
    await expect(page.getByRole('dialog').getByTestId('personal-browser-screen').locator('img')).toBeVisible({ timeout: 20000 });
    await page.getByRole('dialog').getByRole('button', { name: 'Return to chat', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const created=(await (await request.get(`${serverURL}/api/personal-agent/browsers`,{headers})).json()).sessions;
    expect(created).toHaveLength(1);
    const browserRoomId=created[0].roomId,sessionId=created[0].id;
    expect(browserRoomId).not.toBe(roomId);
    expect(created[0].previewUrl).toBeTruthy();
    expect((await request.get(`${serverURL}${created[0].previewUrl}`,{headers})).status()).toBe(200);
    let previousTurnId = '';
    async function browserAgentAction(action: Record<string, unknown>) {
      let turnId = '';
      await page.getByTestId('message-editor').fill(`Browser operation ${action.action}`);
      await page.getByTestId('personal-agent-conversation').getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(async () => {
        const messages = await (await request.get(`${serverURL}/api/rooms/${roomId}/messages?clientId=${clientId}`, { headers })).json() as Message[];
        turnId = messages.filter(message => message.turnId).at(-1)?.turnId || '';
        return Boolean(turnId) && turnId !== previousTurnId;
      }).toBe(true);
      const claims = { v: 1, jti: randomUUID(), roomId, clientId, turnId, mode: 'fullAccess', exp: Math.floor(Date.now() / 1000) + 60 };
      const payload = Buffer.from(JSON.stringify(claims, Object.keys(claims).sort())).toString('base64url');
      const authorization = `Bearer ${payload}.${createHmac('sha256', 'e2e-personal-result-context-secret').update(payload).digest('base64url')}`;
      const response = await request.patch(`${serverURL}/api/code-agent/room-context/personal-browser`, { headers: { authorization }, data: {...action,sessionId} });
      expect(response.ok(), await response.text()).toBe(true);
      previousTurnId = turnId;
      const observed = await response.json();
      expect(observed.session.encryptedState).toBeUndefined(); expect(observed.storageState).toBeUndefined();
      await expectCompletedTurn(request, clientId, token, roomId);
      return observed;
    }
    const observed = await browserAgentAction({ action: 'open', url });
    expect(observed.text).toContain('Actual shared browser');
    expect(observed.observation.url).toBe(url);
    expect(observed.observation.sessionId).toBe(sessionId);
    expect(observed.observation.browserRoomId).toBe(browserRoomId);
    expect(observed.observation.roomId).toBe(roomId);
    const taskDetail=await (await request.get(`${serverURL}/api/personal-agent/tasks/${roomId}`,{headers})).json();
    expect(taskDetail.browsers[0].id).toBe(sessionId);
    const visit = page.getByTestId('personal-browser-visit').first();
    await expect(visit.getByText(url, { exact: true })).toBeVisible();
    await page.reload(); await expect(visit.getByText(url, { exact: true })).toBeVisible();
    await visit.getByRole('button', { name: 'Take control', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const image = dialog.getByTestId('personal-browser-screen').locator('img');
    await expect(image).toBeVisible({ timeout: 20000 });
    expect((await request.post(`${serverURL}/api/personal-agent/browser/${browserRoomId}/take-control`, { headers, data: {} })).status()).toBe(409);
    const clickAt = async (x: number, y: number) => {
      const rect = await image.boundingBox(); if (!rect) throw new Error('Actual browser screenshot missing');
      await page.mouse.click(rect.x + x * rect.width / 1280, rect.y + y * rect.height / 800);
    };
    await clickAt(120, 125); await expect.poll(() => clicks).toBe(1);
    await expect(dialog.getByRole('button', { name: 'Enter', exact: true })).toBeEnabled();
    await clickAt(150, 200);
    await expect(dialog.getByLabel('Text for the selected field')).toBeEnabled();
    await dialog.getByLabel('Text for the selected field').fill('confirmed-user');
    await dialog.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(dialog.getByLabel('Text for the selected field')).toHaveValue('');
    await dialog.getByRole('button', { name: 'Enter', exact: true }).click();
    await expect.poll(() => loginName).toBe('confirmed-user'); await expect.poll(() => signedInVisits).toBeGreaterThan(0);
    await expect(dialog.getByLabel('Page address')).toBeEnabled();
    await dialog.getByLabel('Page address').fill(`${url}other`);
    await dialog.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(dialog.getByText('Second page', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Zoom out', exact: true })).toBeVisible();
    expect(await dialog.getByTestId('personal-browser-screen').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await clickAt(100, 125);
    await expect.poll(() => clicks).toBe(2);
    await page.screenshot({ path: '/tmp/roomtalk-personal-browser-control-mobile.png', fullPage: true });
    await dialog.getByRole('button', { name: 'Return to chat', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(visit.getByText(url, { exact: true })).toBeVisible();
    await browserAgentAction({ action: 'close' });
    const beforeReopen = signedInVisits;
    await visit.getByRole('button',{name:'Take control',exact:true}).click();
    await expect(image).toBeVisible({ timeout: 20000 });
    await expect(dialog.getByText('Second page', { exact: true })).toBeVisible();
    await expect.poll(() => signedInVisits).toBeGreaterThan(beforeReopen);
    await dialog.getByRole('button', { name: 'Return to chat', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await browserAgentAction({action:'click',selector:'#pdf'});
    await visit.getByRole('button',{name:'Take control',exact:true}).click();
    await expect(dialog.getByText('browser-form.pdf',{exact:true})).toBeVisible();
    await dialog.getByRole('button',{name:'Import PDF to files',exact:true}).click();
    await expect(dialog.getByRole('button',{name:'PDF saved in Files',exact:true})).toBeDisabled();
    await dialog.getByRole('button',{name:'Return to chat',exact:true}).click();
    await openFiles(page);await page.getByTestId('personal-file-card').filter({hasText:'browser-form.pdf'}).click();
    await dialog.getByLabel('Full name',{exact:true}).fill('Browser PDF User');
    await dialog.getByRole('button',{name:'Save filled copy',exact:true}).click();
    await expect(dialog).toContainText('browser-form — filled.pdf');
    const downloadPromise=page.waitForEvent('download');await dialog.getByRole('button',{name:'Open / download',exact:true}).click();
    const file=await downloadPromise,filled=await PDFDocument.load(readFileSync((await file.path())!));
    expect(filled.getForm().getTextField('Full name').getText()).toBe('Browser PDF User');
    expect((await request.get(`${serverURL}/api/personal-agent/browser-observations/${observed.observation.id}/image?clientId=${clientId}`)).status()).toBe(401);
    expect((await request.get(`${serverURL}/api/personal-agent/browser-observations/${observed.observation.id}/image`, { headers })).status()).toBe(200);
  } finally { const closing=new Promise<void>(resolve=>fixture.close(()=>resolve()));fixture.closeAllConnections();await closing; }
});


test('imports a real fillable PDF and downloads a distinct saved copy on mobile', async ({ page, context, request }) => {
  const requireServer = createRequire(path.resolve('../server/package.json'));
  const { PDFDocument } = requireServer('pdf-lib');
  const document = await PDFDocument.create();
  const sheet = document.addPage([500, 700]);
  const form = document.getForm();
  form.createTextField('Full name').addToPage(sheet, { x: 40, y: 550, width: 300, height: 30 });
  form.createCheckBox('Confirmed').addToPage(sheet, { x: 40, y: 500, width: 20, height: 20 });
  const original = Buffer.from(await document.save());
  const clientId = await seedClient(context, uniqueName('pdf-owner'));
  await openRoomsPage(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByLabel('User ID password', { exact: true }).first().fill('Personal-files-test-2026');
  await page.getByRole('button', { name: 'Set password', exact: true }).click();
  await expect(page.getByText('User ID password saved.', { exact: true })).toBeVisible();
  const token = (await page.evaluate(() => localStorage.getItem('clientAuthToken')))!;
  const headers = accountHeaders(clientId, token);
  await openPersonalAgent(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openFiles(page);
  await page.locator('input[type="file"]').setInputFiles({ name: 'real-form.pdf', mimeType: 'application/pdf', buffer: original });
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Full name', { exact: true })).toBeVisible();
  await dialog.getByLabel('Full name', { exact: true }).fill('Actual PDF User');
  await dialog.getByRole('checkbox', { name: 'Confirmed', exact: true }).check();
  await dialog.getByRole('button', { name: 'Save filled copy', exact: true }).click();
  await expect(dialog).toContainText('real-form — filled.pdf');
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Open / download', exact: true }).click();
  const download = await downloadPromise;
  const savedPath = await download.path();
  const filled = await PDFDocument.load(readFileSync(savedPath!));
  expect(filled.getForm().getTextField('Full name').getText()).toBe('Actual PDF User');
  expect(filled.getForm().getCheckBox('Confirmed').isChecked()).toBe(true);
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(page.getByTestId('personal-file-card')).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/roomtalk-personal-files-mobile.png', fullPage: true, animations: 'disabled' });
  await page.reload();
  await openFiles(page);
  await expect(page.getByTestId('personal-file-card')).toHaveCount(2);
  const list = await (await request.get(`${serverURL}/api/personal-agent/files`, { headers })).json();
  const source = list.files.find((file: { parentId?: string }) => !file.parentId);
  const originalRead = await request.get(`${serverURL}/api/personal-agent/files/${source.id}/content`, { headers });
  expect(await originalRead.body()).toEqual(original);
  const forbidden = await request.get(`${serverURL}/api/personal-agent/files/${source.id}/content`, { headers: accountHeaders('other-owner',token) });
  expect(forbidden.status()).toBe(401);
});

test('ports OpenMuse mail/thread/review UI with Google response fixtures and persists real drafts', async ({page,context,request})=>{
  test.setTimeout(90000);
  const clientId = await seedClient(context,uniqueName('google-ui-owner'));
  const message = {id:'message-1',threadId:'thread-1',from:'sender@example.com',sender:'Sender',to:['owner@example.com'],subject:'Complete conversation',body:'The first actual fixture message.',date:'2026-10-06T10:00:00Z',unread:true,label:'Inbox',attachments:[]};
  await page.route('**/api/personal-agent/google',route=>route.fulfill({json:{configured:true,connected:true,account:'owner@example.com',canSend:true,canEditCalendar:true}}));
  await page.route('**/api/personal-agent/mail',route=>route.fulfill({json:{mail:[message]}}));
  await page.route('**/api/personal-agent/mail/threads/thread-1',route=>route.fulfill({json:{mail:[message,{...message,id:'message-2',sender:'You',from:'owner@example.com',body:'A second message outside the inbox.',date:'2026-10-06T11:00:00Z'}]}}));
  let proposed:Record<string,unknown> | undefined;
  const action = {id:randomUUID(),kind:'email.send',title:'Reviewed reply',account:'owner@example.com',status:'awaiting_review',updatedAt:'2026-10-06T18:00:00.000Z',expiresAt:'2026-10-06T18:30:00.000Z',data:{}};
  await page.route('**/api/personal-agent/actions',async route=>{
    if(route.request().method() === 'GET')return route.fulfill({json:{actions:[]}});
    proposed = route.request().postDataJSON();
    return route.fulfill({json:{action:{...action,data:proposed!.data}},status:201});
  });
  await page.route(`**/api/personal-agent/actions/${action.id}/decide`,async route=>{
    const decision=route.request().postDataJSON();
    expect(decision.decision).toBe('deny');
    return route.fulfill({json:{action:{...action,data:proposed!.data,status:'denied'}}});
  });
  await openRoomsPage(page);
  await page.getByRole('button',{name:'Settings',exact:true}).first().click();
  await page.getByLabel('User ID password',{exact:true}).first().fill('Personal-google-ui-2026');
  await page.getByRole('button',{name:'Set password',exact:true}).click();
  await expect(page.getByText('User ID password saved.',{exact:true})).toBeVisible();
  await openPersonalAgent(page);
  await page.getByRole('button',{name:'Apps',exact:true}).click();
  await page.getByRole('button',{name:'Gmail',exact:true}).click();
  await expect(page.getByRole('dialog').getByText('owner@example.com',{exact:true})).toBeVisible();
  await page.getByRole('dialog').getByRole('button',{name:'Gmail',exact:true}).click();
  await page.getByRole('button').filter({hasText:'Complete conversation'}).click();
  await expect(page.getByText('A second message outside the inbox.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Write a reply',exact:true}).click();
  await page.getByLabel('Message',{exact:true}).fill('A privately saved reply.');
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'Drafts',exact:true}).click();
  await page.getByRole('button').filter({hasText:'Re: Complete conversation'}).click();
  await expect(page.getByLabel('Message',{exact:true})).toHaveValue('A privately saved reply.');
  // Typing commas must retain raw editor text until save, including multiple recipients.
  await page.getByLabel('To',{exact:true}).fill('first@example.com, second@example.com');
  await page.getByRole('button',{name:'Review email',exact:true}).click();
  await expect(page.getByRole('dialog').getByText('One last look',{exact:true})).toBeVisible();
  expect((proposed!.data as {to:string[]}).to).toEqual(['first@example.com','second@example.com']);
  expect((proposed!.data as {threadId:string}).threadId).toBe('thread-1');
  await page.getByRole('button',{name:'Decline',exact:true}).click();
  await expect(page.getByText('Declined; no changes made',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Close',exact:true}).last().click();
  const token = (await page.evaluate(()=>localStorage.getItem('clientAuthToken')))!;
  const durable = await request.get(`${serverURL}/api/personal-agent/drafts`,{headers:accountHeaders(clientId,token)});
  const drafts = (await durable.json()).drafts;
  expect(drafts).toHaveLength(1);expect(drafts[0].body).toBe('A privately saved reply.');expect(drafts[0].threadId).toBe('thread-1');
  await page.reload();await page.getByRole('button',{name:'Apps',exact:true}).click();
  await page.getByRole('button',{name:'Gmail',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Gmail',exact:true}).click();
  await page.getByRole('button',{name:'Drafts',exact:true}).click();await expect(page.getByRole('button').filter({hasText:'Re: Complete conversation'})).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:'/tmp/roomtalk-openmuse-mail-mobile.png',fullPage:true});
});

test('resumes a persisted PDF input request and replays a real computed finance result',async({page,context,request})=>{
  test.setTimeout(120000);
  const {createRequire} = await import('node:module');
  const {PDFDocument} = createRequire(new URL('../../server/package.json',import.meta.url))('pdf-lib') as typeof import('pdf-lib');
  const document = await PDFDocument.create(),sheet=document.addPage(),form=document.getForm();
  form.createTextField('Full name').addToPage(sheet,{x:40,y:400,width:200,height:30});
  form.createCheckBox('Confirmed').addToPage(sheet,{x:40,y:350,width:20,height:20});
  const bytes=Buffer.from(await document.save());
  const clientId=await seedClient(context,uniqueName('task-input-owner'));
  await page.addInitScript(()=>{window.open=()=>null;});
  await openRoomsPage(page);await page.getByRole('button',{name:'Settings',exact:true}).first().click();
  await page.getByLabel('User ID password',{exact:true}).first().fill('Task-input-ui-2026');await page.getByRole('button',{name:'Set password',exact:true}).click();
  await expect(page.getByText('User ID password saved.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Connect Codex',exact:true}).click();await expect(page.getByText('Connected',{exact:true}).first()).toBeVisible({timeout:15000});
  const token=(await page.evaluate(()=>localStorage.getItem('clientAuthToken')))!;const headers=accountHeaders(clientId,token);
  await openPersonalAgent(page);
  const imported=await request.post(`${serverURL}/api/personal-agent/files?name=verified-form.pdf`,{headers:{...headers,'content-type':'application/pdf'},data:bytes});
  expect(imported.status()).toBe(201);const file=(await imported.json()).file;
  const created=await request.post(`${serverURL}/api/personal-agent/threads`,{headers,data:{name:'Confirmed inputs and spending'}});
  const room=(await created.json()).room;
  await page.reload();await openThreads(page);await page.getByTestId('personal-agent-chat-card').filter({hasText:room.name}).getByRole('button').first().click();
  await page.getByTestId('message-editor').fill('Prepare my form and spending summary.');await page.getByRole('button',{name:'Send message',exact:true}).click();
  let turnId='';
  await expect.poll(async()=>{
    const messages=await (await request.get(`${serverURL}/api/rooms/${room.id}/messages?clientId=${clientId}`,{headers})).json() as Message[];
    turnId=messages.find(message=>message.turnId)?.turnId || '';return Boolean(turnId);
  }).toBe(true);
  const claims={v:1,jti:randomUUID(),roomId:room.id,clientId,turnId,mode:'fullAccess',exp:Math.floor(Date.now()/1000)+60};
  const payload=Buffer.from(JSON.stringify(claims,Object.keys(claims).sort())).toString('base64url');
  const authorization=`Bearer ${payload}.${createHmac('sha256','e2e-personal-result-context-secret').update(payload).digest('base64url')}`;
  const needed=await request.patch(`${serverURL}/api/code-agent/room-context/personal-task`,{headers:{authorization},data:{question:'What name should be used on the form?',fileId:file.id,fields:['Full name','Confirmed']}});
  expect(needed.status()).toBe(200);const requested=(await needed.json()).request;
  const csv='date,description,amount,category\n2026-10-01,Salary,-2000,Income\n2026-10-02,Groceries,100,Food\n2026-10-03,Coffee,5,Food\n';
  const saved=await request.patch(`${serverURL}/api/code-agent/room-context/personal-results`,{headers:{authorization},data:{kind:'finance',title:'Imported spending',summary:'Three actual imported rows.',filename:'spending.csv',content:Buffer.from(csv).toString('base64')}});
  expect(saved.status()).toBe(200);const result=(await saved.json()).result;
  expect(result.data.spending).toBe(105);expect(result.data.income).toBe(2000);
  await expectCompletedTurn(request,clientId,token,room.id);
  await page.reload();await expect(page.getByTestId('personal-agent-conversation')).toBeVisible();
  await page.getByRole('button',{name:'Task details',exact:true}).click();
  await expect(page.getByRole('heading',{name:'What name should be used on the form?',exact:true})).toBeVisible();
  await page.getByLabel('Full name',{exact:true}).fill('Confirmed PDF User');
  // Leave Confirmed unchecked: false is a valid explicit checkbox answer.
  await page.getByRole('button',{name:'Continue task',exact:true}).click();
  await expect(page.getByRole('heading',{name:'What name should be used on the form?',exact:true})).toHaveCount(0);
  const detail=await (await request.get(`${serverURL}/api/personal-agent/tasks/${room.id}`,{headers})).json();
  const answer=detail.requests.find((item:{id:string})=>item.id===requested.id).answer;
  expect(answer.fields).toEqual({'Full name':'Confirmed PDF User',Confirmed:false});
  await expect.poll(async()=>((await (await request.get(`${serverURL}/api/personal-agent/tasks/${room.id}`,{headers})).json()).turns.length)).toBe(2);
  await expect(page.getByTestId('personal-file-thread-card')).toContainText('verified-form.pdf');
  await page.getByTestId('personal-finance-result').getByRole('button',{name:/Read from your imported transactions/}).click();
  await expect(page.getByText('Where your money went',{exact:true})).toBeVisible();
  await expect(page.getByRole('dialog').last()).toContainText('105.00');
  await page.getByLabel('Turn this into a savings goal',{exact:true}).fill('Actual spending review');
  await page.getByRole('button',{name:'Create savings goal',exact:true}).click();
  await expect(page.getByText('Your savings goal is saved in Goals.',{exact:true})).toBeVisible();
  const goals=(await (await request.get(`${serverURL}/api/personal-agent`,{headers})).json()).goals;
  expect(goals.find((goal:{title:string})=>goal.title==='Actual spending review').schedule).toBe('manual');
});

test('ports calendar zone-aware editing and read-only choices with explicit Google response fixtures',async({page,context})=>{
  test.setTimeout(90000);
  await seedClient(context,uniqueName('calendar-ui-owner'));
  const event={id:'event-1',calendarId:'primary',title:'Calendar zone meeting',start:'2026-10-06T13:00:00-04:00',end:'2026-10-06T14:00:00-04:00',allDay:false,timeZone:'America/New_York',location:'Studio',description:'Confirmed fixture event',attendees:[]};
  await page.route('**/api/personal-agent/google',route=>route.fulfill({json:{configured:true,connected:true,account:'owner@example.com',canSend:true,canEditCalendar:true}}));
  await page.route('**/api/personal-agent/calendars',route=>route.fulfill({json:{calendars:[{id:'primary',name:'Work calendar',timeZone:'America/New_York',accessRole:'writer'},{id:'readonly',name:'Shared read only',timeZone:'UTC',accessRole:'reader'}]}}));
  await page.route('**/api/personal-agent/calendar/events?**',route=>route.fulfill({json:{events:[event,{...event,id:'overlap',title:'Confirmed neighbor',start:'2026-10-06T14:00:00-04:00',end:'2026-10-06T15:00:00-04:00'}]}}));
  let proposal:Record<string,unknown> | undefined;
  await page.route('**/api/personal-agent/actions',async route=>{
    if(route.request().method()==='GET')return route.fulfill({json:{actions:[]}});
    proposal=route.request().postDataJSON();
    return route.fulfill({status:201,json:{action:{id:randomUUID(),kind:proposal!.kind,title:'Updated meeting',data:proposal!.data,target:event,status:'awaiting_review',account:'owner@example.com',updatedAt:'2026-10-06T18:00:00.000Z',expiresAt:'2026-10-06T18:30:00.000Z'}}});
  });
  await openRoomsPage(page);await page.getByRole('button',{name:'Settings',exact:true}).first().click();
  await page.getByLabel('User ID password',{exact:true}).first().fill('Calendar-ui-2026');await page.getByRole('button',{name:'Set password',exact:true}).click();
  await expect(page.getByText('User ID password saved.',{exact:true})).toBeVisible();
  await openPersonalAgent(page);await page.getByRole('button',{name:'Apps',exact:true}).click();
  await page.getByRole('button',{name:'Google Calendar',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Google Calendar',exact:true}).click();
  await expect(page.getByRole('button',{name:'New event',exact:true})).toBeEnabled();
  await page.getByRole('button').filter({hasText:'Calendar zone meeting'}).click();
  await expect(page.getByLabel('Start time',{exact:true})).toHaveValue('13:00');
  await expect(page.getByLabel('Time zone',{exact:true})).toHaveValue('America/New_York');
  await page.getByLabel('End time',{exact:true}).fill('14:30');await expect(page.getByText('This time overlaps',{exact:true})).toBeVisible();await expect(page.getByRole('dialog').getByText(/Confirmed neighbor/)).toBeVisible();await page.getByLabel('End time',{exact:true}).fill('14:00');await expect(page.getByText('This time overlaps',{exact:true})).toHaveCount(0);
  await page.getByLabel('Title',{exact:true}).fill('Updated meeting');
  await page.getByRole('button',{name:'Review event',exact:true}).click();
  await expect(page.getByText('One last look',{exact:true})).toBeVisible();
  expect(proposal!.kind).toBe('calendar.update');
  expect((proposal!.data as {start:string}).start).toBe('2026-10-06T17:00:00.000Z');
  expect((proposal!.data as {eventId:string}).eventId).toBe('event-1');
  await expect(page.getByText('Current event',{exact:true})).toBeVisible();
  await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).first().click();
  await page.getByRole('button',{name:/Shared read only/}).click();
  await expect(page.getByRole('button',{name:'New event',exact:true})).toBeDisabled();
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:'/tmp/roomtalk-openmuse-calendar-mobile.png',fullPage:true,animations:'disabled'});
});


test('uses the personal computer source tabs and preserves unsent work on mobile',async({page,context,request})=>{
  const clientId=await seedClient(context,uniqueName('computer-owner'));
  await page.setViewportSize({width:390,height:844});await openRoomsPage(page);
  await page.getByRole('button',{name:'Settings',exact:true}).first().click();
  await page.getByLabel('User ID password',{exact:true}).first().fill('Computer-source-ui-2026');
  await page.getByRole('button',{name:'Set password',exact:true}).click();
  await expect(page.getByText('User ID password saved.',{exact:true})).toBeVisible();
  await openPersonalAgent(page);const token=(await page.evaluate(()=>localStorage.getItem('clientAuthToken')))!;
  expect((await request.get(`${serverURL}/api/personal-agent/computer?operation=status`,{headers:accountHeaders(clientId,token)})).ok()).toBe(true);
  expect((await request.get(`${serverURL}/api/personal-agent/computer?operation=status`)).status()).toBe(401);
  await page.getByRole('button',{name:'Agent computer',exact:true}).click();
  const sheet=page.getByRole('dialog');await expect(sheet.getByRole('heading',{name:'Agent computer',exact:true})).toBeVisible();
  await expect(sheet.getByRole('tab',{name:'Browser',exact:true})).toHaveAttribute('aria-selected','true');
  await sheet.getByRole('tab',{name:'Terminal',exact:true}).click();
  await expect(sheet.getByText('Set up the computer to get started',{exact:true})).toBeVisible();
  await expect(sheet.getByRole('button',{name:'Start computer',exact:true})).toHaveCount(0);
  await expect(sheet.getByRole('tab',{name:'Desktop',exact:true})).toHaveCount(0);
  await sheet.getByRole('tab',{name:'Files',exact:true}).click();
  await expect(sheet.getByRole('heading',{name:'Documents',exact:true})).toBeVisible();
  await sheet.getByRole('tab',{name:'Browser',exact:true}).click();
  await sheet.getByLabel('Website address',{exact:true}).fill('https://example.org/unfinished');
  await expect(sheet.getByRole('button',{name:'Open a browser session',exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'/tmp/roomtalk-openmuse-computer-unconfigured-mobile.png',fullPage:true});
  await sheet.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Agent computer',exact:true}).click();
  await expect(sheet.getByLabel('Website address',{exact:true})).toHaveValue('https://example.org/unfinished');
  await sheet.getByRole('button',{name:'Close',exact:true}).click();
  await openThreads(page);await sheet.getByRole('button',{name:'Agent computer',exact:true}).click();
  await expect(sheet.getByRole('tab',{name:'Browser',exact:true})).toBeVisible();
});


test('controls the real personal desktop, terminal and persisted files through the source UI',async({page,context})=>{
  test.skip(process.env.ROOMTALK_COMPUTER_REAL_E2E!=='true','Explicit real desktop acceptance only');
  test.setTimeout(180000);
  const clientId=await seedClient(context,uniqueName('desktop-real-ui'));
  const require=createRequire(new URL('../../server/package.json',import.meta.url));
  const {Sandbox}=require('@e2b/desktop') as typeof import('@e2b/desktop');
  const {computerIdentity}=require('./dist/src/services/personalComputer/computer.js') as typeof import('../../server/src/services/personalComputer/computer');
  const apiKey=process.env.E2B_API_KEY!;
  const metadata=computerIdentity({publicUrl:'unused',computerDeploymentId:process.env.COMPUTER_DEPLOYMENT_ID},clientId).labels;
  try{
    await page.setViewportSize({width:390,height:844});await openRoomsPage(page);
    await page.getByRole('button',{name:'Settings',exact:true}).first().click();
    await page.getByLabel('User ID password',{exact:true}).first().fill('Desktop-real-ui-2026');await page.getByRole('button',{name:'Set password',exact:true}).click();
    await expect(page.getByText('User ID password saved.',{exact:true})).toBeVisible();await openPersonalAgent(page);
    await page.getByRole('button',{name:'Agent computer',exact:true}).click();
    const sheet=page.getByRole('dialog');await sheet.getByRole('tab',{name:'Terminal',exact:true}).click();
    await sheet.getByRole('button',{name:'Start computer',exact:true}).click();
    await expect(sheet.getByText('Running · files persist when stopped',{exact:true})).toBeVisible({timeout:30000});
    await sheet.getByRole('tab',{name:'Desktop',exact:true}).click();
    const canvas=sheet.frameLocator('iframe').locator('#noVNC_container canvas');
    await expect(canvas).toBeVisible({timeout:30000});await page.screenshot({path:'/tmp/roomtalk-openmuse-real-desktop-mobile.png',fullPage:true});
    await sheet.getByRole('tab',{name:'Terminal',exact:true}).click();
    await sheet.getByLabel('Command',{exact:true}).fill("printf 'actual UI command' > /workspace/verified-ui.txt; cat /workspace/verified-ui.txt");
    await sheet.getByRole('button',{name:'Run command',exact:true}).click();
    await expect(sheet.getByTestId('personal-computer-command').getByText('actual UI command',{exact:true})).toBeVisible({timeout:20000});
    await sheet.getByRole('tab',{name:'Files',exact:true}).click();
    await sheet.getByRole('button',{name:/verified-ui.txt/}).click();
    await expect(sheet.getByLabel('File contents',{exact:true})).toHaveValue('actual UI command');
    await sheet.getByLabel('File contents',{exact:true}).fill('Edited through the source file UI');await sheet.getByRole('button',{name:'Save file',exact:true}).click();
    await expect(sheet.getByText('File saved to your computer.',{exact:true})).toBeVisible();
    await sheet.getByRole('button',{name:'Back to files',exact:true}).click();
    await sheet.getByRole('button',{name:'New folder',exact:true}).click();await sheet.getByLabel('Folder name',{exact:true}).fill('verified-folder');await sheet.getByRole('button',{name:'Create folder',exact:true}).click();
    await expect(sheet.getByRole('button',{name:/verified-folder/})).toBeVisible();
    await sheet.getByRole('button',{name:'Stop computer',exact:true}).click();await expect(sheet.getByText('Stopped · your files are saved',{exact:true})).toBeVisible({timeout:30000});
    await sheet.getByRole('button',{name:'Start computer',exact:true}).click();await expect(sheet.getByText('Running · files persist when stopped',{exact:true})).toBeVisible({timeout:30000});
    await sheet.getByRole('button',{name:/verified-ui.txt/}).click();await expect(sheet.getByLabel('File contents',{exact:true})).toHaveValue('Edited through the source file UI');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'/tmp/roomtalk-openmuse-real-files-mobile.png',fullPage:true});
    await sheet.getByRole('button',{name:'Stop computer',exact:true}).click();await expect(sheet.getByText('Stopped · your files are saved',{exact:true})).toBeVisible({timeout:30000});
  }finally{
    const sandboxes=await Sandbox.list({apiKey,query:{metadata,state:['running','paused']}}).nextItems();
    assertDesktopCleanup(await Promise.all(sandboxes.map(box=>Sandbox.kill(box.sandboxId,{apiKey}))));
  }
});
const assertDesktopCleanup=(results:boolean[])=>{expect(results.length).toBeGreaterThan(0);expect(results.every(Boolean)).toBe(true);};


test('uses the source goal categories, read-only list and milestone-preserving completion on mobile',async({page,context,request})=>{
  test.setTimeout(60000);const clientId=await seedClient(context,uniqueName('goal-source-owner'));
  await page.setViewportSize({width:390,height:844});await openRoomsPage(page);
  await page.getByRole('button',{name:'Settings',exact:true}).first().click();
  await page.getByLabel('User ID password',{exact:true}).first().fill('Goal-source-test-2026');await page.getByRole('button',{name:'Set password',exact:true}).click();
  await expect(page.getByText('User ID password saved.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Connect Codex',exact:true}).click();await expect(page.getByText('Connected',{exact:true}).first()).toBeVisible({timeout:15000});
  await openPersonalAgent(page);await page.getByRole('button',{name:'Goals',exact:true}).click();
  for(const category of ['Health','Relationships','Finances','Something else'])await expect(page.getByRole('button',{name:`Create ${category} goal`,exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Create Finances goal',exact:true}).click();const sheet=page.getByRole('dialog');
  await sheet.getByLabel('Your goal',{exact:true}).fill('Emergency fund');await sheet.getByLabel('Milestones (one per line)',{exact:true}).fill('Review my budget');
  await expect(sheet.getByLabel('Schedule',{exact:true})).toHaveCount(0);await sheet.getByRole('button',{name:'Create goal',exact:true}).click();
  const row=page.getByRole('button',{name:'Open goal: Emergency fund',exact:true});await expect(row).toBeVisible();
  await expect(page.getByRole('checkbox',{name:'Review my budget',exact:true})).toHaveCount(0);await row.click();
  await sheet.getByRole('button',{name:'Complete goal',exact:true}).click();await expect(sheet.getByText('Completed',{exact:true})).toBeVisible();
  await expect(sheet.getByRole('checkbox',{name:'Review my budget',exact:true})).not.toBeChecked();
  await sheet.getByRole('button',{name:'Close',exact:true}).click();await page.reload();await page.getByRole('button',{name:'Goals',exact:true}).click();await row.click();
  await expect(sheet.getByText('Completed',{exact:true})).toBeVisible();await sheet.getByRole('button',{name:'Resume',exact:true}).click();
  await expect(sheet.getByText('Active',{exact:true})).toBeVisible();
  const [response]=await Promise.all([page.waitForResponse(response=>response.url().endsWith('/api/personal-agent/tasks') && response.request().method()==='POST'),sheet.getByRole('button',{name:'Plan next steps',exact:true}).click()]);
  expect(response.ok()).toBe(true);const task=(await response.json()).room as Room;
  await expect(sheet.getByRole('banner').filter({hasText:'Plan: Emergency fund'})).toBeVisible();
  const token=(await page.evaluate(()=>localStorage.getItem('clientAuthToken')))!;await expectCompletedTurn(request,clientId,token,task.id);
  await sheet.getByRole('button',{name:'Close',exact:true}).click();await page.reload();await page.getByRole('button',{name:'Goals',exact:true}).click();await row.click();
  await expect(sheet.getByRole('button').filter({hasText:'Plan: Emergency fund'})).toBeVisible();
  const snapshot=await (await request.get(`${serverURL}/api/personal-agent`,{headers:accountHeaders(clientId,token)})).json();
  expect(snapshot.goals[0].category).toBe('Finances');expect(snapshot.goals[0].prompt).toBe('');expect(snapshot.goals[0].milestones[0].done).toBe(false);expect(task.personalAgentGoalId).toBe(snapshot.goals[0].id);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'/tmp/roomtalk-openmuse-goal-detail-mobile.png',fullPage:true});
});

test('uses source task sheets and activity filters to pause, resume and cancel durable delegated work on mobile',async({page,context,request})=>{
  test.setTimeout(90000);const clientId=await seedClient(context,uniqueName('task-controls-ui'));
  await page.setViewportSize({width:390,height:844});await openRoomsPage(page);
  await page.getByRole('button',{name:'Settings',exact:true}).first().click();
  await page.getByLabel('User ID password',{exact:true}).first().fill('Task-controls-source-2026');await page.getByRole('button',{name:'Set password',exact:true}).click();
  await expect(page.getByText('User ID password saved.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Connect Codex',exact:true}).click();await expect(page.getByText('Connected',{exact:true}).first()).toBeVisible({timeout:15000});
  await openPersonalAgent(page);const token=(await page.evaluate(()=>localStorage.getItem('clientAuthToken')))!;
  const sheet=page.getByRole('dialog');
  const delegate=async(prompt:string)=>{
    await openThreads(page);await sheet.getByRole('button',{name:'Delegate task',exact:true}).click();
    await sheet.getByLabel('What would you like done?',{exact:true}).fill(prompt);
    const [response]=await Promise.all([page.waitForResponse(response=>response.url().endsWith('/api/personal-agent/tasks') && response.request().method()==='POST'),sheet.getByRole('button',{name:'Delegate task',exact:true}).click()]);
    expect(response.status()).toBe(201);const room=(await response.json()).room as Room;
    await expect(sheet.getByRole('banner').filter({hasText:prompt})).toBeVisible();return room;
  };
  const room=await delegate('Prepare a practical weekend plan');
  await sheet.getByRole('button',{name:'Pause',exact:true}).click();await expect(sheet.getByText('Paused',{exact:true}).first()).toBeVisible();
  await page.reload();await page.getByRole('button',{name:'Activity',exact:true}).click();
  const card=page.getByRole('button',{name:`Open task: ${room.name}`,exact:true});await expect(card).toContainText('Paused');
  await page.getByRole('button',{name:'Finished',exact:true}).click();await expect(card).toHaveCount(0);
  await page.getByRole('button',{name:'In progress',exact:true}).click();await card.click();
  await sheet.getByRole('button',{name:'Resume',exact:true}).click();await expectCompletedTurn(request,clientId,token,room.id);
  await sheet.getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('button',{name:'Finished',exact:true}).click();
  await expect(card).toContainText('Completed');
  await page.getByRole('button',{name:'Chat',exact:true}).click();
  const cancelled=await delegate('Prepare a second saved plan');
  await sheet.getByRole('button',{name:'Pause',exact:true}).click();await expect(sheet.getByText('Paused',{exact:true}).first()).toBeVisible();
  await sheet.getByRole('button',{name:'Cancel task',exact:true}).click();await expect(sheet.getByText('Stopped',{exact:true}).first()).toBeVisible();
  await expect(sheet.getByRole('button',{name:'Resume',exact:true})).toHaveCount(0);
  await sheet.getByRole('button',{name:'Close',exact:true}).click();await page.reload();await page.getByRole('button',{name:'Activity',exact:true}).click();
  const stopped=page.getByRole('button',{name:`Open task: ${cancelled.name}`,exact:true});await expect(stopped).toContainText('Stopped');
  await stopped.click();await expect(sheet.getByRole('button',{name:'Resume',exact:true})).toHaveCount(0);await expect(sheet.getByRole('button',{name:'Continue task',exact:true})).toHaveCount(0);
  const saved=await (await request.get(`${serverURL}/api/personal-agent/tasks/${cancelled.id}`,{headers:accountHeaders(clientId,token)})).json();expect(saved.room.personalAgentTaskControl).toBe('cancelled');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'/tmp/roomtalk-openmuse-task-controls-mobile.png',fullPage:true});
});
