import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import webPush from 'web-push';
import { PushSubscriptionRecord, RoomStore } from '../repositories/store';
import { Logger } from '../logger';
import { Message, Room } from '../types';
import { notifyPersonalAgentCompletion, notifyPersonalAgentUpdate, selectPushRecipients } from './pushNotifications';

const subscription = (overrides: Partial<PushSubscriptionRecord>): PushSubscriptionRecord => ({
  clientId: 'client-1',
  browserInstanceId: 'browser-1',
  endpoint: 'https://push.example/subscription-1',
  p256dh: 'p256dh-key',
  auth: 'auth-key',
  createdAt: '2026-05-03T00:00:00.000Z',
  updatedAt: '2026-05-03T00:00:00.000Z',
  ...overrides,
});

describe('personal agent completion notifications', () => {
  it('honors the saved push preference and opens the personal updates page', async t => {
    const previousPublic = process.env.WEB_PUSH_VAPID_PUBLIC_KEY, previousPrivate = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    t.after(() => {
      mock.restoreAll();
      if (previousPublic === undefined) delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY; else process.env.WEB_PUSH_VAPID_PUBLIC_KEY = previousPublic;
      if (previousPrivate === undefined) delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY; else process.env.WEB_PUSH_VAPID_PRIVATE_KEY = previousPrivate;
    });
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY = 'test-public'; process.env.WEB_PUSH_VAPID_PRIVATE_KEY = 'test-private';
    let enabled = false, deliveries = 0;
    mock.method(webPush, 'setVapidDetails', () => undefined);
    mock.method(webPush, 'sendNotification', async (_destination: unknown, payload: string) => {
      deliveries++; assert.equal(JSON.parse(payload).url, '/?personal=1&tab=activity'); return { statusCode: 201 };
    });
    const store = { getPersonalAgentProfile: async () => ({ pushEnabled: enabled }),
      readPushSubscriptionsByRoom: async () => [subscription({ clientId: 'owner' })],
      getRoomActiveBrowserInstanceIds: async () => [], readMutedNotificationClientIdsByRoom: async () => [] } as any;
    const notification = { id: 'notice', clientId: 'owner', roomId: 'private', title: 'Page changed', body: 'Actual source' } as any;
    await notifyPersonalAgentUpdate({ store, notification, logger: new Logger('PersonalUpdatesTest') }); assert.equal(deliveries, 0);
    enabled = true;
    await notifyPersonalAgentUpdate({ store, notification, logger: new Logger('PersonalUpdatesTest') }); assert.equal(deliveries, 1);
  });
  it('sends AI results to every inactive owner device without leaking to another client', async t => {
    const env = { ...process.env };
    t.after(() => {
      mock.restoreAll();
      for (const key of ['WEB_PUSH_VAPID_PUBLIC_KEY', 'WEB_PUSH_VAPID_PRIVATE_KEY']) {
        if (env[key] === undefined) delete process.env[key];
        else process.env[key] = env[key];
      }
    });
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY = 'test-public';
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY = 'test-private';
    mock.method(webPush, 'setVapidDetails', () => undefined);
    const sent: string[] = [];
    const removed: string[] = [];
    mock.method(webPush, 'sendNotification', async (destination: { endpoint: string }, payload: string) => {
      sent.push(destination.endpoint);
      assert.equal(JSON.parse(payload).roomId, 'personal-room');
      assert.equal(JSON.parse(payload).body, 'Your report is ready.');
      if (destination.endpoint.endsWith('/expired')) {
        throw Object.assign(new Error('Expired'), { statusCode: 410 });
      }
      return { statusCode: 201 };
    });
    const store = {
      readPushSubscriptionsByRoom: async () => [
        subscription({ clientId: 'owner', endpoint: 'https://push.example/phone', browserInstanceId: 'phone' }),
        subscription({ clientId: 'owner', endpoint: 'https://push.example/desktop', browserInstanceId: 'desktop' }),
        subscription({ clientId: 'owner', endpoint: 'https://push.example/expired', browserInstanceId: 'old' }),
        subscription({ clientId: 'owner', endpoint: 'https://push.example/active', browserInstanceId: 'active' }),
        subscription({ clientId: 'other', endpoint: 'https://push.example/other' }),
      ],
      getRoomActiveBrowserInstanceIds: async () => ['active'],
      readMutedNotificationClientIdsByRoom: async () => [],
      deletePushSubscription: async (clientId: string, endpoint: string) => {
        assert.equal(clientId, 'owner');
        removed.push(endpoint);
      },
    } as unknown as RoomStore;
    await notifyPersonalAgentCompletion({
      store,
      room: { id: 'personal-room', name: 'Research', personalAgentOwnerId: 'owner' } as Room,
      message: { id: 'result', roomId: 'personal-room', clientId: 'ai_assistant', content: 'Your report is ready.', messageType: 'ai' } as Message,
      logger: new Logger('PersonalAgentPushTest'),
    });
    assert.deepEqual(sent.sort(), ['https://push.example/desktop', 'https://push.example/expired', 'https://push.example/phone']);
    assert.deepEqual(removed, ['https://push.example/expired']);
  });
});

describe('push notification recipient selection', () => {
  it('excludes sender subscriptions', () => {
    const recipients = selectPushRecipients([
      subscription({ clientId: 'sender', endpoint: 'https://push.example/sender' }),
      subscription({ clientId: 'client-2', endpoint: 'https://push.example/client-2' }),
    ], new Set(), 'sender');

    assert.deepEqual([...recipients.keys()], ['https://push.example/client-2']);
  });

  it('excludes only subscriptions for browser instances active in the room', () => {
    const recipients = selectPushRecipients([
      subscription({ clientId: 'client-2', browserInstanceId: 'active-browser', endpoint: 'https://push.example/active' }),
      subscription({ clientId: 'client-2', browserInstanceId: 'inactive-browser', endpoint: 'https://push.example/inactive' }),
      subscription({ clientId: 'client-3', browserInstanceId: 'other-browser', endpoint: 'https://push.example/other' }),
    ], new Set(['active-browser']), 'sender');

    assert.deepEqual([...recipients.keys()].sort(), [
      'https://push.example/inactive',
      'https://push.example/other',
    ]);
  });

  it('keeps legacy subscriptions without browser instance IDs', () => {
    const recipients = selectPushRecipients([
      subscription({ clientId: 'client-2', browserInstanceId: undefined, endpoint: 'https://push.example/legacy' }),
      subscription({ clientId: 'client-2', browserInstanceId: 'active-browser', endpoint: 'https://push.example/active' }),
    ], new Set(['active-browser']), 'sender');

    assert.deepEqual([...recipients.keys()], ['https://push.example/legacy']);
  });

  it('excludes every subscription owned by a client that muted the room', () => {
    const recipients = selectPushRecipients([
      subscription({ clientId: 'muted-client', browserInstanceId: 'browser-1', endpoint: 'https://push.example/muted-1' }),
      subscription({ clientId: 'muted-client', browserInstanceId: 'browser-2', endpoint: 'https://push.example/muted-2' }),
      subscription({ clientId: 'client-3', browserInstanceId: 'browser-3', endpoint: 'https://push.example/client-3' }),
    ], new Set(), 'sender', new Set(['muted-client']));

    assert.deepEqual([...recipients.keys()], ['https://push.example/client-3']);
  });

  it('deduplicates by endpoint using Map semantics', () => {
    const recipients = selectPushRecipients([
      subscription({ clientId: 'client-2', browserInstanceId: 'browser-1', endpoint: 'https://push.example/shared', p256dh: 'old-key' }),
      subscription({ clientId: 'client-2', browserInstanceId: 'browser-2', endpoint: 'https://push.example/shared', p256dh: 'new-key' }),
    ], new Set(), 'sender');

    assert.equal(recipients.size, 1);
    assert.equal(recipients.get('https://push.example/shared')?.p256dh, 'new-key');
  });
});
