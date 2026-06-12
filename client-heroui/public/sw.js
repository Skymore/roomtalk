self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload = {};
    try {
      payload = event.data ? event.data.json() : {};
    } catch {
      payload = {};
    }

    const title = typeof payload.title === 'string' && payload.title
      ? payload.title
      : 'RoomTalk';
    const body = typeof payload.body === 'string'
      ? payload.body
      : 'New message';
    const roomId = typeof payload.roomId === 'string' ? payload.roomId : '';
    const messageId = typeof payload.messageId === 'string' ? payload.messageId : '';
    const url = typeof payload.url === 'string' && payload.url ? payload.url : '/';

    await self.registration.showNotification(title, {
      body,
      icon: '/roomtalk-logo.svg',
      badge: '/roomtalk-logo.svg',
      tag: roomId ? `room-message-${roomId}` : undefined,
      renotify: Boolean(roomId),
      data: { url, roomId, messageId },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const targetUrl = new URL(event.notification.data?.url || '/', self.location.origin);
    const windowClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    for (const client of windowClients) {
      const clientUrl = new URL(client.url);
      if (clientUrl.origin === targetUrl.origin && 'focus' in client) {
        await client.focus();
        if ('navigate' in client && clientUrl.href !== targetUrl.href) {
          await client.navigate(targetUrl.href);
        }
        return;
      }
    }

    await self.clients.openWindow(targetUrl.href);
  })());
});
