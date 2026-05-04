import { expect, test } from '@playwright/test';
import {
  createRoomViaApi,
  expectChatRoom,
  openRoomFromCard,
  openRoomsPage,
  resetE2EData,
  seedClient,
  shortName,
  uniqueName,
} from './helpers';

test.beforeEach(async ({ request }) => {
  await resetE2EData(request);
});

test('opens an existing room from a room card', async ({ page, context, request }) => {
  const clientId = await seedClient(context);
  const room = await createRoomViaApi(request, clientId, uniqueName('card-room'));

  await openRoomsPage(page);
  await openRoomFromCard(page, room);
});

test('creates a room through the UI and enters chat', async ({ page, context }) => {
  await seedClient(context);
  const roomName = shortName('created');

  await openRoomsPage(page);
  await page.getByRole('button', { name: 'Create Room' }).click();
  await expect(page.getByText('Create New Room')).toBeVisible();
  await page.getByLabel('Room Name').fill(roomName);
  await page.locator('[role="dialog"]').getByRole('button', { name: 'Create Room' }).click();

  await expectChatRoom(page, roomName);
});

test('joins a room by ID from a separate client', async ({ page, context, request }) => {
  const ownerId = uniqueName('owner');
  const joinerId = await seedClient(context, uniqueName('joiner'));
  expect(joinerId).not.toBe(ownerId);
  const room = await createRoomViaApi(request, ownerId, uniqueName('join-room'));

  await openRoomsPage(page);
  await page.getByRole('textbox', { name: 'Enter Room ID' }).first().fill(room.id);
  await page.getByRole('button', { name: 'Join Room' }).click();

  await expectChatRoom(page, room.name);
});
