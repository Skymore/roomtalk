import { expect, test } from '@playwright/test';
import { createRoomViaApi, expectMessage, openRoomFromCard, openRoomsPage, postMessageViaApi, resetE2EData, seedClient, sendTextMessage } from './helpers';

test('preserves the reading position while loading history and receiving new messages in a long conversation', async ({ page, context, request }) => {
  test.setTimeout(120_000);
  await resetE2EData(request);
  const clientId = await seedClient(context);
  const room = await createRoomViaApi(request, clientId);
  // A reproducible workload, not production data. Mix wrapped text and markdown.
  for (let index = 0; index < 240; index++) {
    await postMessageViaApi(request, room.id, clientId, `History ${index}\n${'A longer paragraph for scrolling and layout. '.repeat(6)}\n\`\`\`ts\nconst entry = ${index};\n\`\`\``);
  }
  await openRoomsPage(page);
  await openRoomFromCard(page, room);
  await expectMessage(page, 'History 239').toBeVisible();
  const scroll = page.getByTestId('message-list-scroll');
  const items = page.getByTestId('message-item');
  const initialCount = await items.count();
  const anchor = await items.first().getAttribute('data-message-id');
  await scroll.evaluate(element => { element.scrollTop = 0; });
  await expect.poll(() => items.count()).toBeGreaterThan(initialCount);
  // Once the prepended batch settles, the formerly first message stays onscreen.
  const anchorItem = page.locator(`[data-message-id="${anchor}"]`);
  await expect(anchorItem).toBeInViewport();
  while (await items.count() < 240) {
    const count = await items.count();
    await scroll.evaluate(element => { element.scrollTop = 0; });
    await expect.poll(() => items.count()).toBeGreaterThan(count);
  }
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight / 2; });
  const before = await scroll.evaluate(element => element.scrollTop);
  await postMessageViaApi(request, room.id, clientId, 'Arrived while reading history');
  await expectMessage(page, 'Arrived while reading history').toHaveCount(1);
  expect(Math.abs(await scroll.evaluate(element => element.scrollTop) - before)).toBeLessThan(4);

  const session = await context.newCDPSession(page);
  await session.send('Performance.enable');
  const baseline = await session.send('Performance.getMetrics');
  await sendTextMessage(page, 'Reply from a long conversation');
  await expectMessage(page, 'Reply from a long conversation').toBeInViewport();
  const after = await session.send('Performance.getMetrics');
  const durations = Object.fromEntries(after.metrics.filter(metric => ['TaskDuration', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration'].includes(metric.name)).map(metric => [metric.name, (metric.value - (baseline.metrics.find(item => item.name === metric.name)?.value || 0)) * 1000]));
  await test.info().attach('long-conversation-performance', { body: JSON.stringify({ loadedMessages: await items.count(), milliseconds: durations }, null, 2), contentType: 'application/json' });
  console.log('Long conversation browser timings:', JSON.stringify(durations));
});
