import { expect, test } from '@playwright/test';
import {
  createRoomViaApi,
  editMessage,
  expectChatRoom,
  expectMessage,
  messageItem,
  openRoomFromCard,
  openRoomsPage,
  resetE2EData,
  seedClient,
  sendTextMessage,
  shortName,
  tinyPng,
  uniqueName,
} from './helpers';

const hasMediaStorageConfig = () =>
  Boolean(
    process.env.MEDIA_BUCKET_NAME ||
      process.env.S3_BUCKET ||
      process.env.AWS_BUCKET_NAME ||
      process.env.BUCKET_NAME,
  );

test.beforeEach(async ({ request }) => {
  await resetE2EData(request);
});

async function openOwnedRoom(page: Parameters<typeof openRoomsPage>[0], context: Parameters<typeof seedClient>[0], request: Parameters<typeof createRoomViaApi>[0]) {
  const clientId = await seedClient(context);
  const room = await createRoomViaApi(request, clientId, uniqueName('ai-room'));
  await openRoomsPage(page);
  await openRoomFromCard(page, room);
  return room;
}

async function askAI(page: Parameters<typeof openRoomsPage>[0], prompt: string) {
  const editor = page.getByTestId('message-editor');
  await editor.click();
  await page.keyboard.insertText(prompt);
  await page.getByRole('button', { name: 'Ask AI' }).click();
  await expectMessage(page, prompt).toBeVisible();
  await expectMessage(page, `E2E AI response to: ${prompt}`).toBeVisible();
}

test('requires both confirmations before switching to a premium model', async ({ page, context, request }) => {
  await openOwnedRoom(page, context, request);

  await page.getByTestId('ai-model-select').click();
  await page.getByRole('option', { name: /GPT-5\.5/ }).click();

  const pricingDialog = page.getByRole('dialog', { name: 'Confirm premium model pricing' });
  await expect(pricingDialog).toBeVisible();
  await expect(pricingDialog.getByText('$5/M in · $0.5/M cached · $30/M out', { exact: true })).toBeVisible();
  await pricingDialog.getByRole('button', { name: 'I understand' }).click();

  const switchDialog = page.getByRole('dialog', { name: 'Confirm model switch' });
  await expect(switchDialog).toBeVisible();
  await switchDialog.getByRole('button', { name: 'Switch model' }).click();

  await expect(page.getByTestId('ai-model-select')).toContainText('GPT-5.5');
});

test('streams a fake AI response and shows cost and cache metadata', async ({ page, context, request }) => {
  await openOwnedRoom(page, context, request);
  const prompt = uniqueName('ai-prompt');

  await askAI(page, prompt);

  const aiMessage = messageItem(page, `E2E AI response to: ${prompt}`);
  await expect(aiMessage).toContainText('DeepSeek V4 Pro');
  await expect(aiMessage).toContainText(/\$0\.000/);
  await expect(aiMessage).toContainText('cache hit 25%');
});

test('retries a completed AI response without duplicating the old answer', async ({ page, context, request }) => {
  await openOwnedRoom(page, context, request);
  const prompt = uniqueName('retry-prompt');
  const responseText = `E2E AI response to: ${prompt}`;

  await askAI(page, prompt);
  const aiMessage = messageItem(page, responseText);
  await aiMessage.hover();
  await aiMessage.getByLabel('Retry').click();

  await expect(page.getByText(responseText)).toHaveCount(1);
  await expect(messageItem(page, responseText)).toContainText('cache hit 25%');
});

test('edits a user message and asks AI against the updated text', async ({ page, context, request }) => {
  await openOwnedRoom(page, context, request);
  const originalText = uniqueName('edit-ai-original');
  const updatedText = uniqueName('edit-ai-updated');

  await sendTextMessage(page, originalText);
  await editMessage(page, originalText, updatedText, true);

  await expectMessage(page, originalText).toHaveCount(0);
  await expectMessage(page, `E2E AI response to: ${updatedText}`).toBeVisible();
});

test('uploads and sends an image message', async ({ page, context, request }) => {
  test.skip(!hasMediaStorageConfig(), 'Media object storage is not configured for the default E2E server.');
  await openOwnedRoom(page, context, request);

  await page.getByTestId('message-editor').click();
  await page.getByTestId('image-upload-input').setInputFiles(tinyPng);
  await expect(page.getByTestId('message-editor').locator('img')).toHaveCount(1);
  const sendButton = page.getByRole('button', { name: 'Send' });
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
  await expect(sendButton).not.toHaveAttribute('data-loading', 'true', { timeout: 20000 });
  await expect(page.getByTestId('message-editor').locator('img')).toHaveCount(0, { timeout: 20000 });

  await expect(page.getByRole('img', { name: 'Shared image' }).first()).toBeVisible();
});

test('opens a shared room link and joins after confirmation', async ({ page, context, request }) => {
  await seedClient(context, uniqueName('share-joiner'));
  const room = await createRoomViaApi(request, uniqueName('share-owner'), shortName('shared'));

  await page.goto(`/?room=${room.id}`);
  await expect(page.getByText('Join Room?')).toBeVisible();
  await expect(page.getByText(`Would you like to join the room "${room.name}"?`)).toBeVisible();
  await page.getByRole('button', { name: 'Join' }).click();

  await expectChatRoom(page, room.name);
});
