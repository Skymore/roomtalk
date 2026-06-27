import { expect, test } from '@playwright/test';
import {
  editMessage,
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
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expectMessage(page, prompt).toBeVisible();
}

async function expectCocoToolCall(page: Parameters<typeof openRoomsPage>[0]) {
  const toolCall = page.getByTestId('coco-tool-call').filter({ hasText: 'Shell' }).first();
  await expect(toolCall).toBeVisible();
  await expect(toolCall).toContainText('printf');
  return toolCall;
}

test('runs a fake Coco turn and restores tool history after refresh', async ({ page, context, request }) => {
  const roomName = await createCocoRoom(page, context, request);
  const prompt = uniqueName('coco-task');

  await askCoco(page, prompt);

  await expect(page.getByTestId('code-agent-workspace')).toBeVisible();
  const refreshWorkspace = page.getByTestId('code-agent-refresh-workspace');
  await expect(refreshWorkspace).toBeVisible();
  await refreshWorkspace.click();
  await expect(page.getByText('Workspace refresh failed')).toHaveCount(0);
  await expect(page.getByTestId('code-agent-workspace').getByText('Plan mode')).toBeVisible();
  await expect(page.getByText('Agent activity')).toBeVisible();
  await expectMessage(page, 'Coco fake runner received the task.').toBeVisible();
  const toolCall = await expectCocoToolCall(page);
  await toolCall.click();
  await expect(page.getByText('Tool call')).toBeVisible();
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
  await (await expectCocoToolCall(page)).click();
  await expect(page.getByText('Tool failed')).toBeVisible();
});

test('locks Coco ask controls while the room turn is running', async ({ page, context, request }) => {
  await createCocoRoom(page, context, request);

  const prompt = uniqueName('coco-first');
  const editor = page.getByTestId('message-editor');
  const askButton = page.getByRole('button', { name: 'Run', exact: true });

  await editor.click();
  await page.keyboard.insertText(prompt);
  await askButton.click();
  await expectMessage(page, prompt).toBeVisible();
  await expect(askButton).toBeDisabled();
  await expect(editor).toHaveAttribute('contenteditable', 'false');

  await expectCocoToolCall(page);
  await expect(messageItem(page, 'Coco fake runner received the task.')).toBeVisible();
  await expect(page.getByText('Coco fake runner received the task.')).toHaveCount(1);
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.click();
  await page.keyboard.insertText(uniqueName('coco-next'));
  await expect(askButton).toBeEnabled();
});

test('edits a Coco prompt and starts a new Coco turn', async ({ page, context, request }) => {
  await createCocoRoom(page, context, request);
  const originalPrompt = uniqueName('coco-edit-original');
  const editedPrompt = uniqueName('coco-edit-updated');
  const dialogs: string[] = [];
  page.on('dialog', async dialog => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });

  await askCoco(page, originalPrompt);
  await expect(messageItem(page, 'Coco fake runner received the task.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
  await editMessage(page, originalPrompt, editedPrompt, true);

  await expectMessage(page, editedPrompt).toBeVisible();
  await expect(messageItem(page, originalPrompt)).toHaveCount(0);
  await expect(messageItem(page, 'Coco fake runner received the task.')).toBeVisible();
  await expectCocoToolCall(page);
  expect(dialogs).toEqual([]);
});
