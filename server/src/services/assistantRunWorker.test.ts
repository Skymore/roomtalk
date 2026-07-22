import assert from 'assert/strict';
import { describe, it } from 'node:test';
import type { AssistantRunClaim } from '../repositories/store';
import { AssistantRunWorker } from './assistantRunWorker';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

const claim = (): AssistantRunClaim => ({
  phase: 'execute',
  token: { workerId: 'worker-1', generation: 3 },
  run: {
    id: 'run-1',
    roomId: 'room-1',
    requestedByClientId: 'client-1',
    aiMessageId: 'message-1',
    status: 'running',
    modelId: 'model-1',
    apiModel: 'model-1',
    provider: 'openai',
    createdAt: '2026-07-22T00:00:00.000Z',
    queuedAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
    requestPayload: {
      schemaVersion: 1,
      model: {
        id: 'model-1',
        apiModel: 'model-1',
        provider: 'openai',
        label: 'Model 1',
        description: 'Worker test model',
      },
      roleName: 'AI Assistant',
      systemPrompt: 'Be helpful.',
      contextMessages: [],
    },
    generation: 3,
    attempt: 1,
    availableAt: '2026-07-22T00:00:00.000Z',
    leaseOwner: 'worker-1',
    leaseExpiresAt: '2026-07-22T00:01:00.000Z',
  },
});

describe('AssistantRunWorker', () => {
  it('drains queued runs one at a time without waiting for the idle poll interval', async () => {
    const queued = [
      claim(),
      {
        ...claim(),
        token: { workerId: 'worker-1', generation: 7 },
        run: {
          ...claim().run,
          id: 'run-2',
          aiMessageId: 'message-2',
          generation: 7,
        },
      },
    ];
    let active = 0;
    let maxActive = 0;
    let resolveDrained!: () => void;
    const drained = new Promise<void>(resolve => { resolveDrained = resolve; });
    const worker = new AssistantRunWorker({
      store: {
        claimAssistantRun: async () => queued.shift() || null,
        renewAssistantRunLease: async () => true,
        releaseAssistantRunClaim: async () => true,
      },
      logger: logger as any,
      workerId: 'worker-1',
      pollIntervalMs: 60_000,
      execute: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setImmediate(resolve));
        active -= 1;
        if (queued.length === 0) resolveDrained();
      },
    });

    worker.start();
    await Promise.race([
      drained,
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error('Assistant run backlog did not drain immediately')),
        1_000,
      )),
    ]);
    await worker.stop();

    assert.equal(queued.length, 0);
    assert.equal(maxActive, 1);
  });

  it('renews the single run it is executing instead of claiming a batch ahead', async () => {
    let claims = 0;
    let renewals = 0;
    let releases = 0;
    const worker = new AssistantRunWorker({
      store: {
        claimAssistantRun: async () => (++claims === 1 ? claim() : null),
        renewAssistantRunLease: async () => {
          renewals += 1;
          return true;
        },
        releaseAssistantRunClaim: async () => {
          releases += 1;
          return true;
        },
      },
      logger: logger as any,
      workerId: 'worker-1',
      leaseMs: 900,
      pollIntervalMs: 60_000,
      execute: async () => {
        await new Promise(resolve => setTimeout(resolve, 350));
      },
    });

    worker.start();
    await worker.tick();
    await worker.stop();

    assert.equal(claims, 1);
    assert.ok(renewals >= 1);
    assert.equal(releases, 0);
  });

  it('releases a failed claim with the same generation fence', async () => {
    const released: unknown[] = [];
    const worker = new AssistantRunWorker({
      store: {
        claimAssistantRun: async () => claim(),
        renewAssistantRunLease: async () => true,
        releaseAssistantRunClaim: async (...args: unknown[]) => {
          released.push(args);
          return true;
        },
      },
      logger: logger as any,
      workerId: 'worker-1',
      pollIntervalMs: 60_000,
      execute: async () => {
        throw new Error('database unavailable');
      },
    });

    worker.start();
    await worker.tick();
    await worker.stop();

    assert.equal(released.length, 1);
    assert.deepEqual((released[0] as unknown[]).slice(0, 3), [
      'run-1',
      { workerId: 'worker-1', generation: 3 },
      'database unavailable',
    ]);
  });

  it('aborts work after lease loss and never releases another generation', async () => {
    let releases = 0;
    const worker = new AssistantRunWorker({
      store: {
        claimAssistantRun: async () => claim(),
        renewAssistantRunLease: async () => false,
        releaseAssistantRunClaim: async () => {
          releases += 1;
          return true;
        },
      },
      logger: logger as any,
      workerId: 'worker-1',
      leaseMs: 900,
      pollIntervalMs: 60_000,
      execute: async (_claim, context) => {
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
        });
      },
    });

    worker.start();
    await worker.tick();
    await worker.stop();

    assert.equal(releases, 0);
  });

  it('returns an active claim immediately when graceful shutdown aborts execution', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const released: unknown[][] = [];
    const worker = new AssistantRunWorker({
      store: {
        claimAssistantRun: async () => claim(),
        renewAssistantRunLease: async () => true,
        releaseAssistantRunClaim: async (...args: unknown[]) => {
          released.push(args);
          return true;
        },
      },
      logger: logger as any,
      workerId: 'worker-1',
      pollIntervalMs: 60_000,
      retryDelayMs: 30_000,
      execute: async (_claim, context) => {
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
        });
      },
    });

    worker.start();
    const tick = worker.tick();
    await started;
    await worker.stop();
    await tick;

    assert.equal(released.length, 1);
    assert.equal(released[0][3], 0);
  });

  it('returns a claim that arrives after shutdown without starting provider work', async () => {
    let resolveClaim!: (value: AssistantRunClaim) => void;
    let markClaimStarted!: () => void;
    const claimStarted = new Promise<void>(resolve => { markClaimStarted = resolve; });
    const pendingClaim = new Promise<AssistantRunClaim>(resolve => { resolveClaim = resolve; });
    const released: unknown[][] = [];
    let executions = 0;
    const worker = new AssistantRunWorker({
      store: {
        claimAssistantRun: async () => {
          markClaimStarted();
          return pendingClaim;
        },
        renewAssistantRunLease: async () => true,
        releaseAssistantRunClaim: async (...args: unknown[]) => {
          released.push(args);
          return true;
        },
      },
      logger: logger as any,
      workerId: 'worker-1',
      pollIntervalMs: 60_000,
      execute: async () => { executions += 1; },
    });

    worker.start();
    const tick = worker.tick();
    await claimStarted;
    const stopping = worker.stop();
    resolveClaim(claim());
    await Promise.all([tick, stopping]);

    assert.equal(executions, 0);
    assert.equal(released.length, 1);
    assert.equal(released[0][3], 0);
  });
});
