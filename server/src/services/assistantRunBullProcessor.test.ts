import assert from 'assert/strict';
import { describe, it } from 'node:test';
import type { AssistantRunClaim, AssistantRunRecord } from '../repositories/store';
import { processAssistantRunJob } from './assistantRunBullProcessor';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

const run = (overrides: Partial<AssistantRunRecord> = {}): AssistantRunRecord => ({
  id: 'run-1',
  roomId: 'room-1',
  requestedByClientId: 'client-1',
  aiMessageId: 'message-1',
  status: 'queued',
  modelId: 'model-1',
  apiModel: 'model-1',
  provider: 'openai',
  createdAt: '2026-07-22T00:00:00.000Z',
  queuedAt: '2026-07-22T00:00:00.000Z',
  updatedAt: '2026-07-22T00:00:00.000Z',
  generation: 0,
  attempt: 0,
  availableAt: '2026-07-22T00:00:00.000Z',
  ...overrides,
});

const claim = (phase: AssistantRunClaim['phase'] = 'execute'): AssistantRunClaim => ({
  phase,
  token: { workerId: 'worker-1', generation: 2 },
  run: run({
    status: phase === 'project' ? 'finalizing' : 'running',
    generation: 2,
    attempt: 1,
    leaseOwner: 'worker-1',
    leaseExpiresAt: '2026-07-22T00:01:00.000Z',
  }),
});

describe('processAssistantRunJob', () => {
  it('treats duplicate jobs for terminal runs as no-ops without calling the provider', async () => {
    let claims = 0;
    let executions = 0;
    const result = await processAssistantRunJob(
      { schemaVersion: 1, runId: 'run-1' },
      {
        store: {
          getAssistantRun: async () => run({ status: 'complete' }),
          claimAssistantRunById: async () => { claims += 1; return null; },
          renewAssistantRunLease: async () => true,
          releaseAssistantRunClaim: async () => true,
        },
        logger: logger as any,
        workerId: 'worker-1',
        execute: async () => { executions += 1; },
      },
    );

    assert.equal(result, 'already-terminal');
    assert.equal(claims, 0);
    assert.equal(executions, 0);
  });

  it('projects a staged terminal payload without starting another provider request', async () => {
    let observedPhase: AssistantRunClaim['phase'] | undefined;
    const projectionClaim = claim('project');
    const result = await processAssistantRunJob(
      { schemaVersion: 1, runId: 'run-1' },
      {
        store: {
          getAssistantRun: async () => projectionClaim.run,
          claimAssistantRunById: async () => projectionClaim,
          renewAssistantRunLease: async () => true,
          releaseAssistantRunClaim: async () => true,
        },
        logger: logger as any,
        workerId: 'worker-1',
        execute: async current => { observedPhase = current.phase; },
      },
    );

    assert.equal(result, 'executed');
    assert.equal(observedPhase, 'project');
  });

  it('returns the exact generation claim to PostgreSQL when execution fails so BullMQ can retry', async () => {
    const releases: unknown[][] = [];
    await assert.rejects(
      processAssistantRunJob(
        { schemaVersion: 1, runId: 'run-1' },
        {
          store: {
            getAssistantRun: async () => run(),
            claimAssistantRunById: async () => claim(),
            renewAssistantRunLease: async () => true,
            releaseAssistantRunClaim: async (...args: unknown[]) => {
              releases.push(args);
              return true;
            },
          },
          logger: logger as any,
          workerId: 'worker-1',
          execute: async () => { throw new Error('database unavailable'); },
        },
      ),
      /database unavailable/,
    );

    assert.deepEqual(releases[0], [
      'run-1',
      { workerId: 'worker-1', generation: 2 },
      'database unavailable',
      0,
    ]);
  });

  it('does not execute after a queued run is cancelled before the claim', async () => {
    let reads = 0;
    let executions = 0;
    const result = await processAssistantRunJob(
      { schemaVersion: 1, runId: 'run-1' },
      {
        store: {
          getAssistantRun: async () => (++reads === 1 ? run() : run({ status: 'cancelled' })),
          claimAssistantRunById: async () => null,
          renewAssistantRunLease: async () => true,
          releaseAssistantRunClaim: async () => true,
        },
        logger: logger as any,
        workerId: 'worker-1',
        execute: async () => { executions += 1; },
      },
    );

    assert.equal(result, 'already-terminal');
    assert.equal(executions, 0);
  });
});
