import { expect, type APIRequestContext, type BrowserContext, type Locator, type Page } from '@playwright/test';

export const serverURL =
  process.env.E2E_SERVER_URL || `http://127.0.0.1:${process.env.E2E_SERVER_PORT || 3312}`;

export interface TestRoom {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  creatorId: string;
}

export const uniqueName = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const shortName = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

export async function resetE2EData(request: APIRequestContext) {
  const response = await request.post(`${serverURL}/api/e2e/reset`);
  expect(response.ok()).toBeTruthy();
}

export async function seedClient(context: BrowserContext, clientId = uniqueName('client')) {
  await context.addInitScript(({ seededClientId }) => {
    window.localStorage.setItem('clientId', seededClientId);
    window.localStorage.setItem('roomtalk_username', seededClientId);
    window.localStorage.setItem('roomtalk_current_view', 'rooms');
    window.localStorage.setItem('i18nextLng', 'en');
    window.localStorage.removeItem('roomtalk_current_room');
    window.localStorage.removeItem('roomtalk:selected-ai-model');
  }, { seededClientId: clientId });

  return clientId;
}

export async function createRoomViaApi(
  request: APIRequestContext,
  clientId: string,
  name = uniqueName('room'),
  description = '',
) {
  const response = await request.post(`${serverURL}/api/clients/${clientId}/rooms`, {
    data: { name, description },
  });

  expect(response.ok()).toBeTruthy();
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
  await card.click();
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
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
  await page.getByRole('button', { name: 'Send' }).click();
  await expectMessage(page, text).toBeVisible();
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
  await expect(page.getByRole('dialog', { name: 'Confirm Deletion' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete' }).click();
  await expectMessage(page, text).toHaveCount(0);
}

export async function clearChat(page: Page) {
  await page.getByLabel('Room Actions').click();
  await page.getByRole('menuitem', { name: 'Clear Chat History' }).click();
}

export const tinyPng = {
  name: 'tiny.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
};
