import { expect, type APIRequestContext, type BrowserContext, type Locator, type Page } from '@playwright/test';

export const serverURL =
  process.env.E2E_SERVER_URL || `http://127.0.0.1:${process.env.E2E_SERVER_PORT || 3312}`;

export interface TestRoom {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  creatorId: string;
  type?: 'chat' | 'coco';
  sandboxStatus?: 'none' | 'creating' | 'ready' | 'expired' | 'error';
  cocoStatus?: 'idle' | 'running' | 'error';
}

export const uniqueName = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const shortName = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 20);

export const fakeAIResponseText = (prompt: string) =>
  `E2E AI response: I received "${prompt}"`;

export async function resetE2EData(request: APIRequestContext) {
  const response = await request.post(`${serverURL}/api/e2e/reset`);
  expect(response.ok()).toBeTruthy();
}

export async function expectCocoFeatureEnabled(request: APIRequestContext, clientId: string) {
  const response = await request.get(`${serverURL}/api/features?clientId=${encodeURIComponent(clientId)}`);
  expect(response.ok()).toBeTruthy();
  const features = await response.json();
  expect(
    features.coco?.enabled,
    `Coco E2E tests require the seeded client to be rollout-enabled. clientId=${clientId} response=${JSON.stringify(features.coco)}`,
  ).toBe(true);
}

export async function seedClient(context: BrowserContext, clientId = uniqueName('client')) {
  await context.addInitScript(({ seededClientId }) => {
    const existingClientId = window.localStorage.getItem('clientId');
    window.localStorage.setItem('clientId', seededClientId);
    window.localStorage.setItem('roomtalk_username', seededClientId);
    window.localStorage.setItem('i18nextLng', 'en');
    if (existingClientId !== seededClientId) {
      window.localStorage.setItem('roomtalk_current_view', 'rooms');
      window.localStorage.removeItem('roomtalk_current_room');
      window.localStorage.removeItem('roomtalk:selected-ai-model');
    }
  }, { seededClientId: clientId });

  return clientId;
}

export async function createRoomViaApi(
  request: APIRequestContext,
  clientId: string,
  name = shortName('room'),
  description = '',
  type: 'chat' | 'coco' = 'chat',
) {
  const response = await request.post(`${serverURL}/api/clients/${clientId}/rooms`, {
    data: { name, description, type },
  });

  expect(response.ok(), `create room failed: HTTP ${response.status()} ${await response.text()}`).toBeTruthy();
  return await response.json() as TestRoom;
}

export async function getClientRoomsViaApi(request: APIRequestContext, clientId: string) {
  const response = await request.get(`${serverURL}/api/clients/${clientId}/rooms`);
  expect(response.ok()).toBeTruthy();
  return await response.json() as TestRoom[];
}

export async function postMessageViaApi(
  request: APIRequestContext,
  roomId: string,
  clientId: string,
  content: string,
  messageType: 'text' | 'image' = 'text',
) {
  const response = await request.post(`${serverURL}/api/rooms/${roomId}/messages`, {
    data: { clientId, content, messageType },
  });

  expect(response.ok()).toBeTruthy();
  return await response.json();
}

export async function openRoomsPage(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create Room' })).toBeVisible();
}

export async function openRoomFromCard(page: Page, room: Pick<TestRoom, 'id' | 'name'>) {
  const card = page.getByTestId('room-card').filter({ hasText: room.name });
  await expect(card).toBeVisible();
  await card.getByRole('heading', { name: room.name }).click();
  await expectChatRoom(page, room.name);
}

export async function joinRoomById(page: Page, room: Pick<TestRoom, 'id' | 'name'>) {
  await openRoomsPage(page);
  await page.getByRole('textbox', { name: 'Enter Room ID' }).first().fill(room.id);
  await page.getByRole('button', { name: 'Join Room' }).click();
  await expectChatRoom(page, room.name);
}

export async function expectChatRoom(page: Page, roomName: string) {
  await expect(page.getByTestId('chat-room-title')).toHaveText(roomName);
  await expect(page.getByTestId('message-editor')).toBeVisible();
}

export async function expectMemberCount(page: Page, count: number) {
  await expect(page.getByTestId('room-member-count')).toContainText(String(count));
}

export async function sendTextMessage(page: Page, text: string) {
  const editor = page.getByTestId('message-editor');
  await editor.click();
  await page.keyboard.insertText(text);
  const sendButton = page.getByRole('button', { name: 'Send' });
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
  await expect(sendButton).not.toHaveAttribute('data-loading', 'true', { timeout: 20000 });
  await expectMessage(page, text).toBeVisible({ timeout: 10000 });
}

export function messageItem(page: Page, text: string): Locator {
  return page.getByTestId('message-item').filter({ hasText: text }).first();
}

export function expectMessage(page: Page, text: string) {
  return expect(messageItem(page, text));
}

export async function editMessage(page: Page, originalText: string, updatedText: string, askAI = false) {
  const item = messageItem(page, originalText);
  await item.hover();
  await item.getByLabel('Edit Message').click();
  await page.getByPlaceholder('Enter your message').fill(updatedText);
  await page.getByRole('button', { name: askAI ? 'Save & Ask AI' : 'Save', exact: true }).click();
  await expectMessage(page, updatedText).toBeVisible();
}

export async function deleteMessage(page: Page, text: string) {
  const item = messageItem(page, text);
  await item.hover();
  await item.getByLabel('Delete Message').click();
  const dialog = page.getByRole('dialog', { name: 'Confirm Deletion' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expectMessage(page, text).toHaveCount(0);
}

export async function clearChat(page: Page, roomName?: string) {
  const confirmationText = roomName ?? (await page.getByTestId('chat-room-title').textContent())?.trim();
  expect(confirmationText, 'room name is required to confirm clearing chat history').toBeTruthy();

  await page.getByLabel('Room Actions').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();

  const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(settingsDialog).toBeVisible();
  await settingsDialog.getByRole('button', { name: 'Clear Chat History' }).click();

  const confirmDialog = page.getByRole('dialog', { name: 'Clear chat history' });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByLabel('Confirm room name').fill(confirmationText!);
  await confirmDialog.getByRole('button', { name: 'Clear Chat History' }).click();
  await expect(confirmDialog).toBeHidden();

  await settingsDialog.getByRole('button', { name: 'Close' }).click();
  await expect(settingsDialog).toBeHidden();
}

export const tinyPng = {
  name: 'tiny.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
};
