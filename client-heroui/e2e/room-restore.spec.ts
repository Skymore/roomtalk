import { expect, test } from '@playwright/test';
import {
  createRoomViaApi,
  expectChatRoom,
  expectMemberCount,
  expectMessage,
  openRoomFromCard,
  openRoomsPage,
  postMessageViaApi,
  resetE2EData,
  seedClient,
  uniqueName,
} from './helpers';

test.beforeEach(async ({ request }) => {
  await resetE2EData(request);
});

async function openOwnedRoom(
  page: Parameters<typeof openRoomsPage>[0],
  context: Parameters<typeof seedClient>[0],
  request: Parameters<typeof createRoomViaApi>[0],
  roomName = uniqueName('restore-room'),
) {
  const clientId = await seedClient(context, uniqueName('restore-client'));
  const room = await createRoomViaApi(request, clientId, roomName);
  await openRoomsPage(page);
  await openRoomFromCard(page, room);
  await expectMemberCount(page, 1);
  return { clientId, room };
}

test('restores the current room from local storage after a hard page reload', async ({ page, context, request }) => {
  const { room } = await openOwnedRoom(page, context, request);

  await page.reload();

  await expectChatRoom(page, room.name);
  await expectMemberCount(page, 1);
});

test('restores the current room in a new tab with the same browser storage', async ({ page, context, request }) => {
  const { room } = await openOwnedRoom(page, context, request);
  await page.close();

  const restoredPage = await context.newPage();
  await restoredPage.goto('/');

  await expectChatRoom(restoredPage, room.name);
  await expectMemberCount(restoredPage, 1);
});

test('refreshes the room session and messages after offline then online recovery', async ({ page, context, request }) => {
  const { clientId, room } = await openOwnedRoom(page, context, request);
  const offlineMessage = uniqueName('offline-message');

  await context.setOffline(true);
  await postMessageViaApi(request, room.id, clientId, offlineMessage);
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  await expectChatRoom(page, room.name);
  await expectMessage(page, offlineMessage).toBeVisible();
  await expectMemberCount(page, 1);
});

test('restores room state after browser back navigation returns to the chat page', async ({ page, context, request }) => {
  const { clientId, room } = await openOwnedRoom(page, context, request);
  const awayMessage = uniqueName('back-forward-message');

  await page.goto('about:blank');
  await postMessageViaApi(request, room.id, clientId, awayMessage);
  await page.goBack();

  await expectChatRoom(page, room.name);
  await expectMessage(page, awayMessage).toBeVisible();
  await expectMemberCount(page, 1);
});

test('keeps same-client tabs counted as one online room member', async ({ page, context, request }) => {
  const { room } = await openOwnedRoom(page, context, request);
  const secondTab = await context.newPage();

  await secondTab.goto('/');
  await expectChatRoom(secondTab, room.name);

  await expectMemberCount(page, 1);
  await expectMemberCount(secondTab, 1);

  await secondTab.close();
  await expectMemberCount(page, 1);
});

test('recovers messages posted while another tab was the active foreground page', async ({ page, context, request }) => {
  const { clientId, room } = await openOwnedRoom(page, context, request);
  const foregroundPage = await context.newPage();
  const foregroundMessage = uniqueName('foreground-tab-message');

  await foregroundPage.goto('/');
  await expectChatRoom(foregroundPage, room.name);
  await postMessageViaApi(request, room.id, clientId, foregroundMessage);
  await page.bringToFront();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await expectMessage(page, foregroundMessage).toBeVisible();
  await expectMemberCount(page, 1);
  await foregroundPage.close();
});
