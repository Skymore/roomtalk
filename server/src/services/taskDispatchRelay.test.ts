import assert from 'assert/strict';
import { describe, it } from 'node:test';
import type { TaskDispatchRecord } from '../repositories/store';
import { TaskDispatchRelay } from './taskDispatchRelay';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

const dispatch = (attempts = 1): TaskDispatchRecord => ({
  runId: 'run-1',
  status: 'processing',
  attempts,
  availableAt: '2026-07-22T00:00:00.000Z',
  createdAt: '2026-07-22T00:00:00.000Z',
  updatedAt: '2026-07-22T00:00:00.000Z',
  lockedAt: '2026-07-22T00:00:00.000Z',
  lockedBy: 'relay-1',
});

describe('TaskDispatchRelay', () => {
  it('keeps the PostgreSQL intent pending when Redis enqueue is unavailable', async () => {
    const releases: unknown[][] = [];
    let claims = 0;
    const relay = new TaskDispatchRelay({
      store: {
        claimTaskDispatches: async () => (++claims === 1 ? [dispatch()] : []),
        markTaskDispatchDispatched: async () => true,
        releaseTaskDispatch: async (...args: unknown[]) => {
          releases.push(args);
          return true;
        },
      },
      queue: {
        add: async () => { throw new Error('queue redis unavailable'); },
      },
      logger: logger as any,
      relayId: 'relay-1',
      pollIntervalMs: 60_000,
      retryDelayMs: 5_000,
    });

    relay.start();
    await relay.tick();
    await relay.stop();

    assert.equal(releases.length, 1);
    assert.deepEqual(releases[0].slice(0, 3), [
      'run-1',
      { workerId: 'relay-1', attempt: 1 },
      'queue redis unavailable',
    ]);
    assert.equal(releases[0][3], 5_000);
  });

  it('uses runId as the deterministic BullMQ job id before acknowledging dispatch', async () => {
    const calls: unknown[][] = [];
    const acknowledgements: unknown[][] = [];
    let claims = 0;
    const relay = new TaskDispatchRelay({
      store: {
        claimTaskDispatches: async () => (++claims === 1 ? [dispatch(4)] : []),
        markTaskDispatchDispatched: async (...args: unknown[]) => {
          acknowledgements.push(args);
          return true;
        },
        releaseTaskDispatch: async () => true,
      },
      queue: {
        add: async (...args: unknown[]) => { calls.push(args); },
      },
      logger: logger as any,
      relayId: 'relay-1',
      pollIntervalMs: 60_000,
    });

    relay.start();
    await relay.tick();
    await relay.stop();

    assert.equal(calls.length, 1);
    assert.equal((calls[0][1] as any).runId, 'run-1');
    assert.equal((calls[0][2] as any).jobId, 'run-1');
    assert.deepEqual(acknowledgements[0], ['run-1', { workerId: 'relay-1', attempt: 4 }]);
  });
});
