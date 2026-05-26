import { expect, test } from '@playwright/test';
import {
  expectCocoFeatureEnabled,
  expectChatRoom,
  expectMessage,
  messageItem,
  openRoomsPage,
  resetE2EData,
  seedClient,
  shortName,
  uniqueName,
} from './helpers';

test.beforeEach(async ({ request }) => {
  await resetE2EData(request);
});

async function createCocoRoom(page: Parameters<typeof openRoomsPage>[0], context: Parameters<typeof seedClient>[0], request: Parameters<typeof expectCocoFeatureEnabled>[0]) {
  const seededClientId = await seedClient(context);
  await expectCocoFeatureEnabled(request, seededClientId);
  const roomName = shortName('coco');

  await openRoomsPage(page);
  await page.getByRole('button', { name: 'Create Room' }).first().click();
  await expect(page.getByText('Create New Room')).toBeVisible();
  await page.getByRole('radio', { name: /Coco/ }).click();
  await page.getByLabel('Room Name').fill(roomName);
  await page.locator('[role="dialog"]').getByRole('button', { name: 'Create Room' }).click();

  await expectChatRoom(page, roomName);
  await expect(page.getByText('Coco').first()).toBeVisible();
  return roomName;
}

async function askCoco(page: Parameters<typeof openRoomsPage>[0], prompt: string) {
  const editor = page.getByTestId('message-editor');
  await editor.click();
  await page.keyboard.insertText(prompt);
  await page.getByRole('button', { name: 'Ask AI' }).click();
  await expectMessage(page, prompt).toBeVisible();
}

test('runs a fake Coco turn and restores tool history after refresh', async ({ page, context, request }) => {
  const roomName = await createCocoRoom(page, context, request);
  const prompt = uniqueName('coco-task');

  await askCoco(page, prompt);

  await expectMessage(page, 'Coco fake runner received the task.').toBeVisible();
  await expect(page.getByText('Tool call')).toBeVisible();
  await expect(page.getByText('Shell').first()).toBeVisible();
  await expect(page.getByText(/printf/)).toBeVisible();
  await expect(page.getByText('Tool failed')).toBeVisible();
  await expect(page.getByText('Exit 2')).toBeVisible();
  await expect(page.getByText(/stdout: hello from Coco fake runner/)).toBeVisible();
  await expect(page.getByText('Show more')).toBeVisible();
  await page.getByText('Show more').click();
  await expect(page.getByText('Show less')).toBeVisible();
  await expect(page.getByText(/\[output truncated by runner\]/)).toBeVisible();

  await page.reload();
  await expectChatRoom(page, roomName);
  await expect(messageItem(page, 'Coco fake runner received the task.')).toBeVisible();
  await expect(page.getByText('Tool failed')).toBeVisible();
});

test('locks Coco ask controls while the room turn is running', async ({ page, context, request }) => {
  await createCocoRoom(page, context, request);

  const prompt = uniqueName('coco-first');
  const editor = page.getByTestId('message-editor');
  const askButton = page.getByRole('button', { name: 'Ask AI' });

  await editor.click();
  await page.keyboard.insertText(prompt);
  await askButton.click();
  await expectMessage(page, prompt).toBeVisible();
  await expect(askButton).toBeDisabled();
  await expect(editor).toHaveAttribute('contenteditable', 'false');

  await expect(page.getByText('Tool call')).toBeVisible();
  await expect(messageItem(page, 'Coco fake runner received the task.')).toBeVisible();
  await expect(page.getByText('Coco fake runner received the task.')).toHaveCount(1);
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.click();
  await page.keyboard.insertText(uniqueName('coco-next'));
  await expect(askButton).toBeEnabled();
});
