import { expect, test } from '@playwright/test';
import {
  clearChat,
  createRoomViaApi,
  deleteMessage,
  editMessage,
  expectMemberCount,
  expectMessage,
  joinRoomById,
  openRoomFromCard,
  openRoomsPage,
  resetE2EData,
  seedClient,
  sendTextMessage,
  shortName,
  uniqueName,
} from './helpers';

test.beforeEach(async ({ request }) => {
  await resetE2EData(request);
});

async function askAI(page: Parameters<typeof openRoomsPage>[0], prompt: string) {
  const editor = page.getByTestId('message-editor');
  await editor.click();
  await page.keyboard.insertText(prompt);
  await page.getByRole('button', { name: 'Ask AI' }).click();
  await expectMessage(page, prompt).toBeVisible();
  await expectMessage(page, `E2E AI response to: ${prompt}`).toBeVisible();
}

test('syncs room operations between two active clients without refresh', async ({ page, context, request, browser }) => {
  const ownerId = await seedClient(context, uniqueName('multi-owner'));
  const room = await createRoomViaApi(request, ownerId, shortName('multi-room'));

  await openRoomsPage(page);
  await openRoomFromCard(page, room);
  await expectMemberCount(page, 1);

  const peerContext = await browser.newContext();
  try {
    await seedClient(peerContext, uniqueName('multi-peer'));
    const peerPage = await peerContext.newPage();
    await joinRoomById(peerPage, room);
    await expectMemberCount(page, 2);
    await expectMemberCount(peerPage, 2);

    const firstMessage = uniqueName('multi-send');
    await sendTextMessage(page, firstMessage);
    await expectMessage(peerPage, firstMessage).toBeVisible();

    const editedMessage = uniqueName('multi-edit');
    await editMessage(page, firstMessage, editedMessage);
    await expectMessage(peerPage, editedMessage).toBeVisible();
    await expectMessage(peerPage, firstMessage).toHaveCount(0);

    await deleteMessage(page, editedMessage);
    await expectMessage(peerPage, editedMessage).toHaveCount(0);

    const clearOwnerMessage = uniqueName('multi-clear-owner');
    const clearPeerMessage = uniqueName('multi-clear-peer');
    await sendTextMessage(page, clearOwnerMessage);
    await sendTextMessage(peerPage, clearPeerMessage);
    await expectMessage(page, clearPeerMessage).toBeVisible();
    await expectMessage(peerPage, clearOwnerMessage).toBeVisible();

    await clearChat(page);
    await expectMessage(page, clearOwnerMessage).toHaveCount(0);
    await expectMessage(page, clearPeerMessage).toHaveCount(0);
    await expectMessage(peerPage, clearOwnerMessage).toHaveCount(0);
    await expectMessage(peerPage, clearPeerMessage).toHaveCount(0);

    const prompt = uniqueName('multi-ai');
    await askAI(page, prompt);
    await expectMessage(peerPage, prompt).toBeVisible();
    await expectMessage(peerPage, `E2E AI response to: ${prompt}`).toBeVisible();
  } finally {
    await peerContext.close();
  }
});

test('shows an in-flight AI response to a client that joins after streaming starts', async ({ page, context, request, browser }) => {
  const ownerId = await seedClient(context, uniqueName('late-owner'));
  const room = await createRoomViaApi(request, ownerId, shortName('late-ai-room'));

  await openRoomsPage(page);
  await openRoomFromCard(page, room);

  const peerContext = await browser.newContext();
  try {
    await seedClient(peerContext, uniqueName('late-peer'));
    const peerPage = await peerContext.newPage();
    await openRoomsPage(peerPage);
    await peerPage.getByRole('textbox', { name: 'Enter Room ID' }).first().fill(room.id);

    const prompt = uniqueName('late-ai-prompt');
    const editor = page.getByTestId('message-editor');
    await editor.click();
    await page.keyboard.insertText(prompt);
    await page.getByRole('button', { name: 'Ask AI' }).click();

    await peerPage.getByRole('button', { name: 'Join Room' }).click();
    await expectMessage(page, prompt).toBeVisible();
    await expectMessage(peerPage, prompt).toBeVisible();
    await expect(peerPage.getByText('Typing...').first()).toBeVisible();
    await expectMessage(peerPage, `E2E AI response to: ${prompt}`).toBeVisible();
  } finally {
    await peerContext.close();
  }
});
