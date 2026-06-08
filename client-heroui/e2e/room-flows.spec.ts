import { expect, test } from '@playwright/test';
import {
  createRoomViaApi,
  expectChatRoom,
  getClientRoomsViaApi,
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

test('renames an owned room from the room card and current room header', async ({ page, context, request }) => {
  const clientId = await seedClient(context);
  const room = await createRoomViaApi(request, clientId, uniqueName('rename-room'));
  const cardRename = shortName('card');
  const headerRename = shortName('header');

  await openRoomsPage(page);

  const card = page.getByTestId('room-card').filter({ hasText: room.name });
  await card.getByRole('button', { name: 'Edit Room Name' }).click();
  await expect(page.getByText('Rename Room')).toBeVisible();
  await page.getByRole('dialog').getByLabel('Room Name').fill(cardRename);
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('room-card').filter({ hasText: cardRename })).toBeVisible();

  await openRoomFromCard(page, { id: room.id, name: cardRename });
  await page.getByLabel('Room Actions').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(settingsDialog).toBeVisible();
  await settingsDialog.getByLabel('Room Name').fill(headerRename);
  await settingsDialog.getByRole('button', { name: 'Save' }).click();
  await settingsDialog.getByRole('button', { name: 'Close' }).click();
  await expect(settingsDialog).toBeHidden();

  await expectChatRoom(page, headerRename);
  const rooms = await getClientRoomsViaApi(request, clientId);
  expect(rooms.find(item => item.id === room.id)?.name).toBe(headerRename);
});

test('uses the desktop saved list without a separate saved navigation card', async ({ page, context, request }) => {
  const clientId = await seedClient(context);
  const room = await createRoomViaApi(request, clientId, uniqueName('saved-room'));

  await openRoomsPage(page);
  await openRoomFromCard(page, room);
  await page.getByRole('button', { name: 'Save Room' }).click();
  await expect(page.getByRole('button', { name: 'Unsave Room' })).toBeVisible();

  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toHaveCount(0);
  const savedSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Saved' }) });
  await expect(savedSection.getByRole('button', { name: new RegExp(room.name) })).toBeVisible();

  await savedSection.getByRole('button', { name: `Unsave ${room.id}` }).click();
  await expect(savedSection.getByRole('button', { name: new RegExp(room.name) })).toHaveCount(0);
  const rooms = await getClientRoomsViaApi(request, clientId);
  expect(rooms.find(item => item.id === room.id)?.name).toBe(room.name);
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
