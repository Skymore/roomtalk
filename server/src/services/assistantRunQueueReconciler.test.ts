import assert from 'assert/strict';
import { describe, it } from 'node:test';
import type { TaskDispatchRecord } from '../repositories/store';
import { AssistantRunQueueReconciler } from './assistantRunQueueReconciler';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

const dispatch = (runId: string): TaskDispatchRecord => ({
  runId,
  status: 'dispatched',
  attempts: 1,
  availableAt: '2026-07-22T00:00:00.000Z',
  createdAt: '2026-07-22T00:00:00.000Z',
  updatedAt: '2026-07-22T00:00:00.000Z',
  dispatchedAt: '2026-07-22T00:00:01.000Z',
});

describe('AssistantRunQueueReconciler', () => {
  it('re-adds missing jobs and retries failed or prematurely completed active jobs', async () => {
    const added: unknown[][] = [];
    const retried: unknown[][] = [];
    const states = new Map([
      ['run-failed', 'failed'],
      ['run-completed', 'completed'],
      ['run-waiting', 'waiting'],
    ]);
    const queries: unknown[] = [];
    const reconciler = new AssistantRunQueueReconciler({
      store: {
        withMaintenanceLock: async (_name, operation) => ({
          acquired: true,
          result: await operation(),
        }),
        readActiveDispatchedTaskDispatches: async options => {
          queries.push(options);
          return [
            dispatch('run-missing'),
            dispatch('run-failed'),
            dispatch('run-completed'),
            dispatch('run-waiting'),
          ];
        },
      },
      queue: {
        getJob: async runId => {
          const state = states.get(runId);
          if (!state) return undefined;
          return {
            getState: async () => state,
            retry: async (...args: unknown[]) => { retried.push([runId, ...args]); },
          };
        },
        add: async (...args: unknown[]) => { added.push(args); },
      },
      logger: logger as any,
      graceMs: 15_000,
      batchSize: 10,
      jobOptions: { attempts: 3 },
    });

    const metrics = await reconciler.reconcileOnce();

    assert.equal(metrics.examined, 4);
    assert.equal(metrics.missingRequeued, 1);
    assert.equal(metrics.failedRetried, 1);
    assert.equal(metrics.completedRetried, 1);
    assert.equal(metrics.healthy, 1);
    assert.equal(metrics.errors, 0);
    assert.equal((queries[0] as any).graceMs, 15_000);
    assert.equal((added[0][1] as any).runId, 'run-missing');
    assert.equal((added[0][2] as any).attempts, 3);
    assert.equal((added[0][2] as any).jobId, 'run-missing');
    assert.deepEqual(retried, [
      ['run-failed', 'failed', { resetAttemptsMade: true, resetAttemptsStarted: true }],
      ['run-completed', 'completed', { resetAttemptsMade: true, resetAttemptsStarted: true }],
    ]);
  });

  it('does not touch Redis when another app owns the PostgreSQL maintenance lock', async () => {
    let queueReads = 0;
    const reconciler = new AssistantRunQueueReconciler({
      store: {
        withMaintenanceLock: async () => ({ acquired: false }),
        readActiveDispatchedTaskDispatches: async () => [dispatch('run-1')],
      },
      queue: {
        getJob: async () => { queueReads += 1; return undefined; },
        add: async () => undefined,
      },
      logger: logger as any,
    });

    const metrics = await reconciler.reconcileOnce();

    assert.equal(queueReads, 0);
    assert.equal(metrics.examined, 0);
  });
});
