import { test } from '@playwright/test';
import {
  clearChat,
  createRoomViaApi,
  deleteMessage,
  editMessage,
  expectMessage,
  openRoomFromCard,
  openRoomsPage,
  postMessageViaApi,
  resetE2EData,
  seedClient,
  sendTextMessage,
  shortName,
  uniqueName,
} from './helpers';

test.beforeEach(async ({ request }) => {
  await resetE2EData(request);
});

async function openOwnedRoom(page: Parameters<typeof openRoomsPage>[0], context: Parameters<typeof seedClient>[0], request: Parameters<typeof createRoomViaApi>[0]) {
  const clientId = await seedClient(context);
  const room = await createRoomViaApi(request, clientId, shortName('message-room'));
  await openRoomsPage(page);
  await openRoomFromCard(page, room);
  return { clientId, room };
}

test('sends a message in a room', async ({ page, context, request }) => {
  await openOwnedRoom(page, context, request);
  await sendTextMessage(page, uniqueName('hello-message'));
});

test('edits and deletes a sent message', async ({ page, context, request }) => {
  await openOwnedRoom(page, context, request);
  const originalText = uniqueName('edit-original');
  const updatedText = uniqueName('edit-updated');

  await sendTextMessage(page, originalText);
  await editMessage(page, originalText, updatedText);
  await expectMessage(page, originalText).toHaveCount(0);
  await deleteMessage(page, updatedText);
});

test('clears chat messages from the room action menu', async ({ page, context, request }) => {
  await openOwnedRoom(page, context, request);
  const first = uniqueName('clear-first');
  const second = uniqueName('clear-second');

  await sendTextMessage(page, first);
  await sendTextMessage(page, second);
  await clearChat(page);

  await expectMessage(page, first).toHaveCount(0);
  await expectMessage(page, second).toHaveCount(0);
});

test('refreshes messages when the page becomes visible again', async ({ page, context, request }) => {
  const { room } = await openOwnedRoom(page, context, request);
  const externalMessage = uniqueName('visibility-message');

  await postMessageViaApi(request, room.id, uniqueName('external-client'), externalMessage);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await expectMessage(page, externalMessage).toBeVisible();
});
