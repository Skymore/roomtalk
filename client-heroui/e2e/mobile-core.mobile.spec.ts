import { expect, test } from '@playwright/test';
import {
  createRoomViaApi,
  expectChatRoom,
  openRoomFromCard,
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

test('keeps the chat scroller stable while the mobile keyboard and input height change', async ({ page, context, request }) => {
  const clientId = await seedClient(context);
  const room = await createRoomViaApi(request, clientId, shortName('mobile-layout'));

  await openRoomsPage(page);
  await openRoomFromCard(page, room);

  const messageList = page.getByTestId('message-list-scroll');
  const inputPanel = page.getByTestId('message-input-panel');
  const bottomNav = page.getByTestId('bottom-nav');

  await expect(messageList).toBeVisible();
  await expect(inputPanel).toBeVisible();
  await expect(bottomNav).toBeVisible();

  const readLayout = () => page.evaluate(() => {
    const rectFor = (testId: string) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      if (!element) throw new Error(`Missing ${testId}`);
      const rect = element.getBoundingClientRect();
      const styles = getComputedStyle(element);
      return {
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        paddingBottom: styles.paddingBottom,
      };
    };

    return {
      viewportHeight: window.innerHeight,
      messageList: rectFor('message-list-scroll'),
      inputPanel: rectFor('message-input-panel'),
      bottomNav: rectFor('bottom-nav'),
    };
  });

  const baseline = await readLayout();

  await page.getByTestId('message-editor').click();
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--app-keyboard-inset', '324px');
  });
  await page.keyboard.insertText('line 1\nline 2\nline 3\nline 4\nline 5\nline 6');

  const keyboardOpen = await readLayout();

  expect(baseline.messageList.height).toBeGreaterThan(baseline.viewportHeight * 0.2);
  expect(keyboardOpen.messageList.top).toBeCloseTo(baseline.messageList.top, 1);
  expect(keyboardOpen.messageList.bottom).toBeCloseTo(baseline.messageList.bottom, 1);
  expect(keyboardOpen.messageList.height).toBeCloseTo(baseline.messageList.height, 1);
  expect(keyboardOpen.messageList.paddingBottom).toBe(baseline.messageList.paddingBottom);
  expect(keyboardOpen.inputPanel.bottom).toBeLessThan(baseline.inputPanel.bottom);
  expect(keyboardOpen.inputPanel.height).toBeGreaterThan(baseline.inputPanel.height);
});
