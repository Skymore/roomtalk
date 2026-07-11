import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CodeAgentRunnerProcess, CodeAgentSandboxHandle } from './codeAgentSandboxService';
import { CodeAgentDaemonProcessRegistry } from './codeAgentDaemonRegistry';

const sandbox = (id: string): CodeAgentSandboxHandle => ({
  id,
  provider: 'fake',
  roomId: `room-${id}`,
  creatorId: 'client-1',
  workspace: '/workspace',
  createdAt: '2026-07-11T00:00:00.000Z',
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const processFor = (
  command: string,
  completed: Promise<{ exitCode: number | null; signal?: string | null }>
) => {
  let stopCalls = 0;
  const process: CodeAgentRunnerProcess = {
    command,
    completed,
    async stop() {
      stopCalls += 1;
    },
  };
  return { process, stopCalls: () => stopCalls };
};

describe('CodeAgentDaemonProcessRegistry', () => {
  it('serializes concurrent daemon startup for one sandbox', async () => {
    const registry = new CodeAgentDaemonProcessRegistry();
    const started = deferred<CodeAgentRunnerProcess>();
    let startCalls = 0;
    const input = {
      handle: sandbox('sandbox-1'),
      command: 'daemon',
      env: { SHARED: 'yes', ROOMTALK_MODEL_GATEWAY_TOKEN: 'secret' },
      start: async (env: Record<string, string>) => {
        startCalls += 1;
        assert.deepEqual(env, { SHARED: 'yes' });
        return started.promise;
      },
    };

    const first = registry.ensure(input);
    const second = registry.ensure(input);
    const running = processFor('real daemon', new Promise(() => {}));
    started.resolve(running.process);

    assert.equal(await first, await second);
    assert.equal(startCalls, 1);
  });

  it('stops the real daemon when its control connection fails', async () => {
    const registry = new CodeAgentDaemonProcessRegistry();
    const completed = deferred<{ exitCode: number | null }>();
    const running = processFor('real daemon', completed.promise);
    const input = {
      handle: sandbox('sandbox-1'),
      command: 'daemon',
      env: {},
      start: async () => running.process,
    };

    await registry.ensure(input);
    completed.reject(new Error('E2B command wait failed'));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(running.stopCalls(), 1);
    const replacement = processFor('replacement daemon', new Promise(() => {}));
    await registry.ensure({ ...input, start: async () => replacement.process });
    assert.equal(replacement.stopCalls(), 0);
  });

  it('stops every tracked daemon during service shutdown', async () => {
    const registry = new CodeAgentDaemonProcessRegistry();
    const first = processFor('daemon-1', new Promise(() => {}));
    const second = processFor('daemon-2', new Promise(() => {}));

    await registry.ensure({ handle: sandbox('sandbox-1'), command: 'daemon', env: {}, start: async () => first.process });
    await registry.ensure({ handle: sandbox('sandbox-2'), command: 'daemon', env: {}, start: async () => second.process });
    await registry.shutdownAll();

    assert.equal(first.stopCalls(), 1);
    assert.equal(second.stopCalls(), 1);
    await assert.rejects(
      registry.ensure({ handle: sandbox('sandbox-3'), command: 'daemon', env: {}, start: async () => first.process }),
      /registry is shutting down/
    );
  });
});
