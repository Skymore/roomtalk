import { expect, test } from '@playwright/test';
import {
  createRoomViaApi,
  expectChatRoom,
  expectMessage,
  openRoomFromCard,
  openRoomsPage,
  postMessageViaApi,
  resetE2EData,
  seedClient,
  sendTextMessage,
  shortName,
} from './helpers';

test.beforeEach(async ({ request }) => {
  await resetE2EData(request);
});

test('creates a room and sends a message on mobile', async ({ page, context }) => {
  await seedClient(context);
  const roomName = shortName('mobile');
  const message = shortName('msg');

  await openRoomsPage(page);
  await page.getByRole('button', { name: 'Create Room' }).click();
  await page.getByLabel('Room Name').fill(roomName);
  await page.locator('[role="dialog"]').getByRole('button', { name: 'Create Room' }).click();

  await expectChatRoom(page, roomName);
  await sendTextMessage(page, message);
});

test('keeps the chat scroller expanded behind the mobile input overlay', async ({ page, context, request }) => {
  const clientId = await seedClient(context);
  const room = await createRoomViaApi(request, clientId, shortName('mobile-layout'));

  await openRoomsPage(page);
  await openRoomFromCard(page, room);

  const messageList = page.getByTestId('message-list-scroll');
  const inputPanel = page.getByTestId('message-input-panel');
  const bottomNav = page.getByTestId('bottom-nav');

  await expect(messageList).toBeVisible();
  await expect(inputPanel).toBeVisible();
  await expect(bottomNav).toBeVisible();

  const layout = await page.evaluate(() => {
    const rectFor = (testId: string) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      if (!element) throw new Error(`Missing ${testId}`);
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
      };
    };

    return {
      viewportHeight: window.innerHeight,
      messageList: rectFor('message-list-scroll'),
      inputPanel: rectFor('message-input-panel'),
      bottomNav: rectFor('bottom-nav'),
    };
  });

  expect(layout.messageList.height).toBeGreaterThan(layout.viewportHeight * 0.2);
  expect(layout.inputPanel.top).toBeLessThan(layout.messageList.bottom);
  expect(layout.inputPanel.bottom).toBeCloseTo(layout.messageList.bottom, 1);
  expect(layout.bottomNav.top - layout.inputPanel.bottom).toBeLessThanOrEqual(4);
});

test('restores the active room after a mobile browser reload', async ({ page, context, request }) => {
  const clientId = await seedClient(context, shortName('mobile-restore-client'));
  const room = await createRoomViaApi(request, clientId, shortName('mobile-restore'));
  const message = shortName('mobile-restore-msg');

  await postMessageViaApi(request, room.id, clientId, message);
  await openRoomsPage(page);
  await openRoomFromCard(page, room);
  await expectMessage(page, message).toBeVisible();

  await page.reload();

  await expectChatRoom(page, room.name);
  await expectMessage(page, message).toBeVisible();
});
