import { test } from '@playwright/test';
import {
  expectChatRoom,
  openRoomsPage,
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
