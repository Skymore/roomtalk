import { expect, test } from '@playwright/test';
import {
  editMessage,
  expectCodeAgentFeatureEnabled,
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

async function createCodeAgentRoom(page: Parameters<typeof openRoomsPage>[0], context: Parameters<typeof seedClient>[0], request: Parameters<typeof expectCodeAgentFeatureEnabled>[0]) {
  const seededClientId = await seedClient(context);
  await expectCodeAgentFeatureEnabled(request, seededClientId);
  const roomName = shortName('codeAgent');

  await openRoomsPage(page);
  await page.getByRole('button', { name: 'Create Room' }).first().click();
  await expect(page.getByText('Create New Room')).toBeVisible();
  await page.getByRole('radio', { name: /code agent/i }).click();
  await page.getByLabel('Room Name').fill(roomName);
  await page.locator('[role="dialog"]').getByRole('button', { name: 'Create Room' }).click();

  await expectChatRoom(page, roomName);
  await expect(page.getByTestId('code-agent-workspace')).toBeVisible();
  return roomName;
}

async function askCodeAgent(page: Parameters<typeof openRoomsPage>[0], prompt: string) {
  const editor = page.getByTestId('message-editor');
  await editor.click();
  await page.keyboard.insertText(prompt);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expectMessage(page, prompt).toBeVisible();
}

async function expectCodeAgentToolCall(page: Parameters<typeof openRoomsPage>[0]) {
  const toolCall = page.getByTestId('code-agent-tool-call').filter({ hasText: 'Shell' }).first();
  await expect(toolCall).toBeVisible();
  await expect(toolCall).toContainText('printf');
  return toolCall;
}

test('runs a fake code agent turn and restores tool history after refresh', async ({ page, context, request }) => {
  const roomName = await createCodeAgentRoom(page, context, request);
  const prompt = uniqueName('codeAgent-task');

  await askCodeAgent(page, prompt);

  await expect(page.getByTestId('code-agent-workspace')).toBeVisible();
  const refreshWorkspace = page.getByTestId('code-agent-refresh-workspace');
  await expect(refreshWorkspace).toBeVisible();
  await refreshWorkspace.click();
  await expect(page.getByText('Workspace refresh failed')).toHaveCount(0);
  await expect(page.getByTestId('code-agent-mode-toggle')).toContainText('Plan');
  await expect(page.getByText('Agent activity')).toHaveCount(0);
  await expect(page.getByText('Threads', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Artifacts', { exact: true })).toBeVisible();
  await expect(page.getByText('Changes', { exact: true })).toBeVisible();
  await expectMessage(page, 'Coco Agent fake runner received the task.').toBeVisible();
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Expand earlier work', exact: true }).click();
  const toolCall = await expectCodeAgentToolCall(page);
  await toolCall.click();
  await expect(page.getByText('Command')).toBeVisible();
  await expect(page.getByText('Tool failed')).toBeVisible();
  await expect(page.getByText('Exit 2')).toBeVisible();
  await expect(page.getByText(/stdout: hello from Coco Agent fake runner/)).toBeVisible();
  await expect(page.getByText('Show more')).toBeVisible();
  await page.getByText('Show more').click();
  await expect(page.getByText('Show less')).toBeVisible();
  await expect(page.getByText(/\[output truncated by runner\]/)).toBeVisible();

  await page.reload();
  await expectChatRoom(page, roomName);
  await expect(messageItem(page, 'Coco Agent fake runner received the task.')).toBeVisible();
  await page.getByRole('button', { name: 'Expand earlier work', exact: true }).click();
  await (await expectCodeAgentToolCall(page)).click();
  await expect(page.getByText('Tool failed')).toBeVisible();
});

test('exposes the stop control while a code agent turn is running', async ({ page, context, request }) => {
  await createCodeAgentRoom(page, context, request);

  const prompt = uniqueName('codeAgent-first');
  const editor = page.getByTestId('message-editor');
  const askButton = page.getByRole('button', { name: 'Run', exact: true });

  await editor.click();
  await page.keyboard.insertText(prompt);
  await askButton.click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  await expectMessage(page, prompt).toBeVisible();

  await expectCodeAgentToolCall(page);
  await expect(messageItem(page, 'Coco Agent fake runner received the task.')).toBeVisible();
  await expect(page.getByTestId('message-item').filter({ hasText: 'Coco Agent fake runner received the task.' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
});

test('edits a code agent prompt and starts a new code agent turn', async ({ page, context, request }) => {
  await createCodeAgentRoom(page, context, request);
  const originalPrompt = uniqueName('codeAgent-edit-original');
  const editedPrompt = uniqueName('codeAgent-edit-updated');
  const dialogs: string[] = [];
  page.on('dialog', async dialog => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });

  await askCodeAgent(page, originalPrompt);
  await expect(messageItem(page, 'Coco Agent fake runner received the task.')).toBeVisible();
  await expect(page.getByText('Running')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
  await editMessage(page, originalPrompt, editedPrompt, true);

  await expectMessage(page, editedPrompt).toBeVisible();
  await expect(messageItem(page, 'Coco Agent fake runner received the task.')).toBeVisible();
  // Edit-and-run truncates the previous answer before starting the replacement
  // turn, so only the new canonical answer should remain in the message log.
  await expect(page.getByTestId('message-item').filter({ hasText: 'Coco Agent fake runner received the task.' })).toHaveCount(1);
  await expectCodeAgentToolCall(page);
  expect(dialogs).toEqual([]);
});
