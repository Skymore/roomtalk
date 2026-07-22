import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Logger } from '../logger';
import { OutboxEventRecord } from '../repositories/store';
import { OutboxWorker } from './outboxWorker';

const event = (overrides: Partial<OutboxEventRecord> = {}): OutboxEventRecord => ({
  id: 'evt-1',
  eventType: 'test.event',
  aggregateType: 'test',
  aggregateId: 'agg-1',
  payload: {},
  status: 'processing',
  attempts: 1,
  availableAt: '2026-06-22T00:00:00.000Z',
  createdAt: '2026-06-22T00:00:00.000Z',
  updatedAt: '2026-06-22T00:00:00.000Z',
  ...overrides,
});

describe('OutboxWorker', () => {
  it('claims events, runs handlers, and marks processed', async () => {
    const calls: string[] = [];
    const claimed = [event()];
    const store = {
      claimOutboxEvents: async () => {
        calls.push('claim');
        return claimed;
      },
      renewOutboxEventLease: async () => true,
      markOutboxEventProcessed: async (eventId: string) => {
        calls.push(`processed:${eventId}`);
        return claimed[0];
      },
      markOutboxEventFailed: async () => {
        calls.push('failed');
        return null;
      },
    };
    const worker = new OutboxWorker({
      store: store as any,
      logger: new Logger('OutboxWorkerTest'),
      workerId: 'worker-1',
      handlers: {
        'test.event': async handledEvent => {
          calls.push(`handle:${handledEvent.id}`);
        },
      },
    });

    (worker as any).stopped = false;
    await worker.tick();
    worker.stop();

    assert.deepEqual(calls, ['claim', 'handle:evt-1', 'processed:evt-1']);
  });

  it('marks events without handlers as failed', async () => {
    const calls: unknown[][] = [];
    const claimed = [event({ eventType: 'missing.event' })];
    const store = {
      claimOutboxEvents: async () => claimed,
      markOutboxEventProcessed: async () => null,
      markOutboxEventFailed: async (...args: unknown[]) => {
        calls.push(args);
        return claimed[0];
      },
    };
    const worker = new OutboxWorker({
      store: store as any,
      logger: new Logger('OutboxWorkerTest'),
      workerId: 'worker-1',
      handlers: {},
    });

    (worker as any).stopped = false;
    await worker.tick();
    worker.stop();

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'evt-1');
    assert.match(String(calls[0][1]), /No handler registered/);
    assert.deepEqual(calls[0][2], { workerId: 'worker-1', attempt: 1 });
    assert.deepEqual(calls[0][3], { retryDelayMs: undefined, maxAttempts: 1 });
  });

  it('aborts work and rejects a stale completion after losing its lease', async () => {
    const calls: string[] = [];
    const claimed = [event()];
    const store = {
      claimOutboxEvents: async () => claimed,
      renewOutboxEventLease: async () => {
        calls.push('renew');
        return false;
      },
      markOutboxEventProcessed: async () => {
        calls.push('processed');
        return claimed[0];
      },
      markOutboxEventFailed: async () => {
        calls.push('failed');
        return claimed[0];
      },
    };
    const worker = new OutboxWorker({
      store: store as any,
      logger: new Logger('OutboxWorkerTest'),
      workerId: 'worker-1',
      lockMs: 300,
      handlers: {
        'test.event': async (_handledEvent, { signal }) => {
          await new Promise<void>(resolve => {
            signal.addEventListener('abort', () => {
              calls.push('aborted');
              resolve();
            }, { once: true });
          });
        },
      },
    });

    (worker as any).stopped = false;
    await worker.tick();
    worker.stop();

    assert.deepEqual(calls, ['renew', 'aborted']);
  });
});
