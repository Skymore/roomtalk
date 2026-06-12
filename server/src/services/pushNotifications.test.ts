import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PushSubscriptionRecord } from '../repositories/store';
import { selectPushRecipients } from './pushNotifications';

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

  it('deduplicates by endpoint using Map semantics', () => {
    const recipients = selectPushRecipients([
      subscription({ clientId: 'client-2', browserInstanceId: 'browser-1', endpoint: 'https://push.example/shared', p256dh: 'old-key' }),
      subscription({ clientId: 'client-2', browserInstanceId: 'browser-2', endpoint: 'https://push.example/shared', p256dh: 'new-key' }),
    ], new Set(), 'sender');

    assert.equal(recipients.size, 1);
    assert.equal(recipients.get('https://push.example/shared')?.p256dh, 'new-key');
  });
});
