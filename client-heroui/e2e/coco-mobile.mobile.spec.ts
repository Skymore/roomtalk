import { expect, test } from '@playwright/test';
import {
  expectChatRoom,
  expectCocoFeatureEnabled,
  openRoomsPage,
  resetE2EData,
  seedClient,
  shortName,
} from './helpers';

test.beforeEach(async ({ request }) => {
  await resetE2EData(request);
});

test('keeps Coco workspace and composer usable on mobile', async ({ page, context, request }) => {
  const seededClientId = await seedClient(context);
  await expectCocoFeatureEnabled(request, seededClientId);
  const roomName = shortName('coco-mobile');

  await openRoomsPage(page);
  await page.getByRole('button', { name: 'Create Room' }).click();
  await page.getByRole('radio', { name: /Coco/ }).click();
  await page.getByLabel('Room Name').fill(roomName);
  await page.locator('[role="dialog"]').getByRole('button', { name: 'Create Room' }).click();

  await expectChatRoom(page, roomName);
  await expect(page.getByTestId('code-agent-workspace')).toBeVisible();
  await expect(page.getByText('Plan mode')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run' })).toBeVisible();

  const layout = await page.evaluate(() => {
    const html = document.documentElement;
    const inputPanel = document.querySelector('[data-testid="message-input-panel"]');
    const bottomNav = document.querySelector('[data-testid="bottom-nav"]');
    if (!inputPanel || !bottomNav) throw new Error('Missing mobile chrome');
    const inputRect = inputPanel.getBoundingClientRect();
    const navRect = bottomNav.getBoundingClientRect();

    return {
      viewportWidth: window.innerWidth,
      documentWidth: html.scrollWidth,
      inputBottom: inputRect.bottom,
      navTop: navRect.top,
    };
  });

  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.navTop - layout.inputBottom).toBeLessThanOrEqual(4);
});
