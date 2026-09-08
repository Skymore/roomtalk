import { expect, test } from '@playwright/test';
import { createRoomViaApi, expectChatRoom, expectMessage, openRoomFromCard, openRoomsPage, resetE2EData, seedClient } from './helpers';

test('keeps room text drafts through navigation and reload, then clears an acknowledged send', async ({ page, context, request }) => {
  test.setTimeout(60_000);
  await resetE2EData(request);
  const clientId = await seedClient(context);
  const first = await createRoomViaApi(request, clientId);
  const second = await createRoomViaApi(request, clientId);
  await openRoomsPage(page);
  await openRoomFromCard(page, first);
  const editor = page.getByTestId('message-editor');
  const draft = 'Draft with 中文 and a second line\nKeep <b>literal text</b>.';
  await editor.fill(draft);
  await page.reload();
  await expectChatRoom(page, first.name);
  await expect(editor).toHaveText(draft);
  await expect(editor.locator('b')).toHaveCount(0);

  await page.getByRole('complementary').getByRole('button', { name: new RegExp(`^${second.name} `) }).click();
  await expectChatRoom(page, second.name);
  await expect(editor).toBeEmpty();
  await editor.fill('Second room draft');
  await page.getByRole('complementary').getByRole('button', { name: new RegExp(`^${first.name} `) }).click();
  await expectChatRoom(page, first.name);
  await expect(editor).toHaveText(draft);
  await editor.press('Enter');
  await expectMessage(page, 'Keep <b>literal text</b>.').toBeVisible();
  await expect(page.getByTestId('message-item').filter({ hasText: 'Keep <b>literal text</b>.' })).toHaveAttribute('aria-busy', 'false');
  await page.reload();
  await expectChatRoom(page, first.name);
  await expect(editor).toBeEmpty();
  await page.getByRole('complementary').getByRole('button', { name: new RegExp(`^${second.name} `) }).click();
  await expectChatRoom(page, second.name);
  await expect(editor).toHaveText('Second room draft');
});
