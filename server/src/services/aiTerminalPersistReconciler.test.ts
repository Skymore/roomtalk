import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Logger } from '../logger';
import { Message, Room } from '../types';
import { AITerminalPersistReconciler } from './aiTerminalPersistReconciler';

const terminalMessage = (): Message => ({
  id: 'ai-message-1',
  roomId: 'room-1',
  clientId: 'assistant',
  content: 'The response could not be saved.',
  timestamp: '2026-07-21T00:00:00.000Z',
  messageType: 'ai',
  status: 'error',
});
const ownership = { ownerId: 'owner-1', fence: 7 };

describe('AITerminalPersistReconciler', () => {
  it('persists a terminal after-image after a multi-second database outage without restarting', async () => {
    let now = 0;
    let attempts = 0;
    const persisted: Message[] = [];
    const room = { id: 'room-1' } as Room;
    const store = {
      finalizeAIMessage: async (message: Message) => {
        attempts++;
        if (attempts <= 3) throw new Error('database unavailable');
        persisted.push(message);
        return { outcome: 'applied' as const, room, message };
      },
    };
    const reconciled: string[] = [];
    const reconciler = new AITerminalPersistReconciler(
      store as any,
      new Logger('AITerminalPersistReconcilerTest'),
      {
        minRetryMs: 1_000,
        maxRetryMs: 8_000,
        now: () => now,
        onPersisted: message => reconciled.push(message.id),
      },
    );

    try {
      reconciler.enqueue(terminalMessage(), { reason: 'test-outage', expectedOwnership: ownership });
      assert.equal(await reconciler.reconcileNow(), 0);
      now = 1_000;
      assert.equal(await reconciler.reconcileNow(), 0);
      now = 3_000;
      assert.equal(await reconciler.reconcileNow(), 0);
      now = 7_000;
      assert.equal(await reconciler.reconcileNow(), 1);

      assert.equal(attempts, 4);
      assert.equal(reconciler.pendingCount, 0);
      assert.deepEqual(persisted.map(message => [message.id, message.status]), [['ai-message-1', 'error']]);
      assert.deepEqual(reconciled, ['ai-message-1']);
    } finally {
      reconciler.stop();
    }
  });

  it('drops a deferred terminal after-image when its placeholder was deleted or superseded', async () => {
    let attempts = 0;
    const reconciler = new AITerminalPersistReconciler(
      {
        finalizeAIMessage: async () => {
          attempts++;
          return { outcome: 'obsolete' as const };
        },
      },
      new Logger('AITerminalPersistReconcilerTest'),
    );

    try {
      reconciler.enqueue(terminalMessage(), { reason: 'deleted-placeholder', expectedOwnership: ownership });
      assert.equal(await reconciler.reconcileNow(), 0);
      assert.equal(attempts, 1);
      assert.equal(reconciler.pendingCount, 0);
    } finally {
      reconciler.stop();
    }
  });

  it('rejects non-terminal messages', () => {
    const reconciler = new AITerminalPersistReconciler(
      { finalizeAIMessage: async () => ({ outcome: 'obsolete' as const }) } as any,
      new Logger('AITerminalPersistReconcilerTest'),
    );
    assert.throws(
      () => reconciler.enqueue(
        { ...terminalMessage(), status: 'streaming' },
        { reason: 'invalid', expectedOwnership: ownership },
      ),
      /Only terminal AI messages/,
    );
  });
});
