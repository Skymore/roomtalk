import { expect, test } from '@playwright/test';
import {
  clearChat,
  createRoomViaApi,
  deleteMessage,
  editMessage,
  expectChatRoom,
  expectMessage,
  fakeAIResponseText,
  getClientRoomsViaApi,
  joinRoomById,
  openRoomFromCard,
  openRoomsPage,
  postMessageViaApi,
  resetE2EData,
  seedClient,
  sendTextMessage,
  serverURL,
  shortName,
  tinyPng,
  uniqueName,
} from './helpers';

test.beforeEach(async ({ request }) => {
  await resetE2EData(request);
});

async function expectPostgresMode(request: Parameters<typeof resetE2EData>[0]) {
  const response = await request.get(`${serverURL}/api/status`);
  expect(response.ok()).toBeTruthy();
  const status = await response.json() as { persistenceStore?: string; redis?: string };
  expect(`${status.persistenceStore}:${status.redis}`).toBe('postgres:connected');
}

async function createRoomThroughUiAndFetchRecord(
  page: Parameters<typeof openRoomsPage>[0],
  request: Parameters<typeof getClientRoomsViaApi>[0],
  clientId: string,
) {
  const roomName = shortName('pg-created');

  await openRoomsPage(page);
  await page.getByRole('button', { name: 'Create Room' }).click();
  await expect(page.getByText('Create New Room')).toBeVisible();
  await page.getByLabel('Room Name').fill(roomName);
  await page.locator('[role="dialog"]').getByRole('button', { name: 'Create Room' }).click();
  await expectChatRoom(page, roomName);

  const rooms = await getClientRoomsViaApi(request, clientId);
  const room = rooms.find(item => item.name === roomName);
  expect(room).toBeTruthy();
  return room!;
}

async function askAI(page: Parameters<typeof openRoomsPage>[0], prompt: string) {
  const editor = page.getByTestId('message-editor');
  await editor.click();
  await page.keyboard.insertText(prompt);
  await page.getByRole('button', { name: 'Ask AI' }).click();
  await expectMessage(page, prompt).toBeVisible();
  await expectMessage(page, fakeAIResponseText(prompt)).toBeVisible();
}

test('persists room and message operations across reloads and fresh contexts', async ({ page, context, request, browser }) => {
  await expectPostgresMode(request);
  const clientId = await seedClient(context, uniqueName('pg-client'));
  const room = await createRoomThroughUiAndFetchRecord(page, request, clientId);
  const firstMessage = uniqueName('pg-first-message');

  await sendTextMessage(page, firstMessage);
  await page.reload();
  await expectChatRoom(page, room.name);
  await expectMessage(page, firstMessage).toBeVisible();

  const externalMessage = uniqueName('pg-cache-miss-message');
  await postMessageViaApi(request, room.id, clientId, externalMessage);

  const freshContext = await browser.newContext();
  try {
    await seedClient(freshContext, clientId);
    const freshPage = await freshContext.newPage();

    await openRoomsPage(freshPage);
    await openRoomFromCard(freshPage, room);
    await expectMessage(freshPage, firstMessage).toBeVisible();
    await expectMessage(freshPage, externalMessage).toBeVisible();

    const editedMessage = uniqueName('pg-edited-message');
    await editMessage(freshPage, firstMessage, editedMessage);
    await expectMessage(freshPage, firstMessage).toHaveCount(0);
    await freshPage.reload();
    await expectChatRoom(freshPage, room.name);
    await expectMessage(freshPage, editedMessage).toBeVisible();

    await deleteMessage(freshPage, editedMessage);
    await expectMessage(freshPage, editedMessage).toHaveCount(0);
    await clearChat(freshPage);
    await expectMessage(freshPage, externalMessage).toHaveCount(0);
  } finally {
    await freshContext.close();
  }
});

test('persists fake AI, image messages, and shared room joins in PostgreSQL mode', async ({ page, context, request, browser }) => {
  await expectPostgresMode(request);
  const ownerId = await seedClient(context, uniqueName('pg-owner'));
  const room = await createRoomViaApi(request, ownerId, shortName('pg-ai-media'));

  await openRoomsPage(page);
  await openRoomFromCard(page, room);

  const prompt = uniqueName('pg-ai-prompt');
  const responseText = fakeAIResponseText(prompt);
  await askAI(page, prompt);
  await page.reload();
  await expectChatRoom(page, room.name);
  await expectMessage(page, responseText).toBeVisible();

  await page.getByTestId('message-editor').click();
  await page.getByTestId('image-upload-input').setInputFiles(tinyPng);
  await expect(page.getByTestId('message-editor').locator('img')).toHaveCount(1);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('img', { name: 'Shared image' }).first()).toBeVisible();
  await page.reload();
  await expectChatRoom(page, room.name);
  await expect(page.getByRole('img', { name: 'Shared image' }).first()).toBeVisible();

  const joinContext = await browser.newContext();
  try {
    await seedClient(joinContext, uniqueName('pg-share-joiner'));
    const joinPage = await joinContext.newPage();
    await joinPage.goto(`/?room=${room.id}`);
    await expect(joinPage.getByText('Join Room?')).toBeVisible();
    await expect(joinPage.getByText(`Would you like to join the room "${room.name}"?`)).toBeVisible();
    await joinPage.getByRole('button', { name: 'Join' }).click();
    await expectChatRoom(joinPage, room.name);
    await expectMessage(joinPage, responseText).toBeVisible();
  } finally {
    await joinContext.close();
  }
});

test('syncs PostgreSQL-backed room messages to a second client without refresh', async ({ page, context, request, browser }) => {
  await expectPostgresMode(request);
  const ownerId = await seedClient(context, uniqueName('pg-realtime-owner'));
  const room = await createRoomViaApi(request, ownerId, shortName('pg-realtime'));

  await openRoomsPage(page);
  await openRoomFromCard(page, room);

  const peerContext = await browser.newContext();
  try {
    await seedClient(peerContext, uniqueName('pg-realtime-peer'));
    const peerPage = await peerContext.newPage();
    await joinRoomById(peerPage, room);

    const ownerMessage = uniqueName('pg-owner-live');
    await sendTextMessage(page, ownerMessage);
    await expectMessage(peerPage, ownerMessage).toBeVisible();

    const peerMessage = uniqueName('pg-peer-live');
    await sendTextMessage(peerPage, peerMessage);
    await expectMessage(page, peerMessage).toBeVisible();

    const freshContext = await browser.newContext();
    try {
      await seedClient(freshContext, ownerId);
      const freshPage = await freshContext.newPage();
      await openRoomsPage(freshPage);
      await openRoomFromCard(freshPage, room);
      await expectMessage(freshPage, ownerMessage).toBeVisible();
      await expectMessage(freshPage, peerMessage).toBeVisible();
    } finally {
      await freshContext.close();
    }
  } finally {
    await peerContext.close();
  }
});
