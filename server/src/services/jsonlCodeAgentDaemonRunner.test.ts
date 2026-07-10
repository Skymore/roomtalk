import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PassThrough } from 'stream';
import {
  CODE_AGENT_RUNNER_SCHEMA_VERSION,
  CodeAgentRunnerEvent,
  CodeAgentRunnerRunRequest,
  CodeAgentRunnerThreadListResultEvent,
} from './codeAgentRunnerProtocol';
import { CodeAgentRunnerProcess, CodeAgentRunnerProcessExit, CodeAgentSandboxHandle } from './codeAgentSandboxService';
import { JsonlCodeAgentDaemonRunnerClient } from './jsonlCodeAgentDaemonRunner';

const request: CodeAgentRunnerRunRequest = {
  schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
  type: 'run',
  roomId: 'room-1',
  turnId: 'turn-1',
  sessionId: null,
  prompt: 'inspect the project',
  mode: 'plan',
  provider: 'openrouter',
  modelId: 'deepseek-v4-pro',
  apiModel: 'deepseek/deepseek-v4-pro',
  workspace: '/workspace',
  allowedPaths: ['.'],
};

const sandbox: CodeAgentSandboxHandle = {
  id: 'sandbox-1',
  provider: 'fake',
  roomId: 'room-1',
  creatorId: 'client-1',
  workspace: '/workspace',
  createdAt: '2026-05-03T00:00:00.000Z',
};

class MemoryDaemonProcess implements CodeAgentRunnerProcess {
  readonly command = 'python -m roomtalk_code_agent_runner.daemon';
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: string[] = [];
  private readonly chunks: Buffer[] = [];
  private resolveExit!: (exit: CodeAgentRunnerProcessExit) => void;
  readonly completed: Promise<CodeAgentRunnerProcessExit>;
  stopCalled = false;

  constructor() {
    this.completed = new Promise<CodeAgentRunnerProcessExit>(resolve => {
      this.resolveExit = resolve;
    });
    this.stdin.on('data', chunk => {
      this.chunks.push(Buffer.from(chunk));
      const lines = Buffer.concat(this.chunks).toString('utf8').split(/\n/);
      const trailing = lines.pop() || '';
      this.chunks.length = 0;
      if (trailing) {
        this.chunks.push(Buffer.from(trailing));
      }
      this.written.push(...lines.filter(line => line.trim()));
    });
  }

  emit(event: Record<string, unknown>) {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }

  complete(exitCode = 0) {
    this.stdout.end();
    this.stderr.end();
    this.resolveExit({ exitCode, signal: null });
  }

  async stop() {
    this.stopCalled = true;
  }
}

const createContext = (
  process: CodeAgentRunnerProcess,
  overrides: Partial<Parameters<JsonlCodeAgentDaemonRunnerClient['run']>[2]> = {}
) => ({
  process,
  sandbox,
  backend: 'codex-app-server' as const,
  runnerEnv: {
    ROOMTALK_CODEX_AUTH_JSON_PATH: '/tmp/auth.json',
  },
  ...overrides,
});

describe('JsonlCodeAgentDaemonRunnerClient', () => {
  it('runs multiple turns through one daemon process without waiting for stdout end', async () => {
    const process = new MemoryDaemonProcess();
    const runner = new JsonlCodeAgentDaemonRunnerClient();
    const emitted: CodeAgentRunnerEvent[] = [];

    const firstRun = runner.run(request, {
      onEvent: event => {
        emitted.push(event);
      },
    }, createContext(process));

    process.emit({ schemaVersion: 1, type: 'daemon_ready', daemonId: 'daemon-1', pid: 123, backends: ['code-agent', 'codex', 'codex-app-server'] });
    await waitFor(() => process.written.length === 1);
    process.emit({ schemaVersion: 1, type: 'text_delta', messageId: 'ai-1', delta: 'done' });
    process.emit({ schemaVersion: 1, type: 'final', messageId: 'ai-1', answer: 'done', sessionId: 'session-1' });
    let firstSettled = false;
    void firstRun.then(() => { firstSettled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(firstSettled, false);
    process.emit({ schemaVersion: 1, type: 'turn_released', turnId: 'turn-1' });

    const first = await firstRun;
    assert.equal(first.finalEvent?.sessionId, 'session-1');

    const secondRun = runner.run({ ...request, turnId: 'turn-2', prompt: 'next' }, {
      onEvent: event => {
        emitted.push(event);
      },
    }, createContext(process, {
      backend: 'codex',
      runnerEnv: {
        ROOMTALK_CODEX_AUTH_JSON_PATH: '/tmp/auth-2.json',
      },
    }));
    await waitFor(() => process.written.length === 2);
    process.emit({ schemaVersion: 1, type: 'final', messageId: 'ai-2', answer: 'next', sessionId: 'session-2' });
    process.emit({ schemaVersion: 1, type: 'turn_released', turnId: 'turn-2' });

    const second = await secondRun;
    assert.equal(second.finalEvent?.sessionId, 'session-2');
    assert.deepEqual(emitted.map(event => event.type), ['text_delta', 'final', 'final']);

    const written = process.written.map(line => JSON.parse(line));
    assert.equal(written[0].backend, 'codex-app-server');
    assert.equal(written[0].env.ROOMTALK_CODEX_AUTH_JSON_PATH, '/tmp/auth.json');
    assert.equal(written[1].backend, 'codex');
    assert.equal(written[1].env.ROOMTALK_CODEX_AUTH_JSON_PATH, '/tmp/auth-2.json');
  });

  it('turns daemon process failure into a runner error event for the active turn', async () => {
    const process = new MemoryDaemonProcess();
    const runner = new JsonlCodeAgentDaemonRunnerClient();
    const emitted: CodeAgentRunnerEvent[] = [];

    const run = runner.run(request, {
      onEvent: event => {
        emitted.push(event);
      },
    }, createContext(process));

    process.emit({ schemaVersion: 1, type: 'daemon_ready', daemonId: 'daemon-1', backends: ['code-agent'] });
    await waitFor(() => process.written.length === 1);
    process.stderr.write('daemon stderr tail');
    process.complete(2);

    const result = await run;
    assert.equal(result.errorEvent?.code, 'daemon_process_error');
    assert.match(result.errorEvent?.message || '', /daemon stderr tail/);
    assert.deepEqual(emitted.map(event => event.type), ['error']);
  });

  it('finishes a terminal turn when the daemon release event is lost', async () => {
    const process = new MemoryDaemonProcess();
    const runner = new JsonlCodeAgentDaemonRunnerClient(10);

    const run = runner.run(request, { onEvent: () => undefined }, createContext(process));
    process.emit({ schemaVersion: 1, type: 'daemon_ready', daemonId: 'daemon-1', backends: ['codex-app-server'] });
    await waitFor(() => process.written.length === 1);
    process.emit({ schemaVersion: 1, type: 'final', messageId: 'ai-1', answer: '', sessionId: 'session-1' });

    const result = await run;
    assert.equal(result.finalEvent?.sessionId, 'session-1');
  });

  it('waits for terminal event handling even when release arrives first', async () => {
    const process = new MemoryDaemonProcess();
    const runner = new JsonlCodeAgentDaemonRunnerClient();
    let finishHandler!: () => void;
    let handlerStarted = false;
    const handlerBlock = new Promise<void>(resolve => { finishHandler = resolve; });

    const run = runner.run(request, {
      onEvent: async event => {
        if (event.type === 'final') {
          handlerStarted = true;
          await handlerBlock;
        }
      },
    }, createContext(process));
    process.emit({ schemaVersion: 1, type: 'daemon_ready', daemonId: 'daemon-1', backends: ['codex-app-server'] });
    await waitFor(() => process.written.length === 1);
    process.emit({ schemaVersion: 1, type: 'final', messageId: 'ai-1', answer: '', sessionId: 'session-1' });
    await waitFor(() => handlerStarted);
    process.emit({ schemaVersion: 1, type: 'turn_released', turnId: 'turn-1' });
    let settled = false;
    void run.then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);

    finishHandler();
    assert.equal((await run).finalEvent?.sessionId, 'session-1');
  });

  it('fails instead of hanging when a terminal event handler rejects', async () => {
    const process = new MemoryDaemonProcess();
    const runner = new JsonlCodeAgentDaemonRunnerClient();

    const run = runner.run(request, {
      onEvent: event => {
        if (event.type === 'final') throw new Error('persist final failed');
      },
    }, createContext(process));
    process.emit({ schemaVersion: 1, type: 'daemon_ready', daemonId: 'daemon-1', backends: ['codex-app-server'] });
    await waitFor(() => process.written.length === 1);
    process.emit({ schemaVersion: 1, type: 'final', messageId: 'ai-1', answer: '', sessionId: 'session-1' });
    process.emit({ schemaVersion: 1, type: 'turn_released', turnId: 'turn-1' });

    const result = await run;
    assert.equal(result.errorEvent?.code, 'daemon_process_error');
    assert.match(result.errorEvent?.message || '', /persist final failed/);
  });

  it('returns a daemon rejection without waiting for a turn release', async () => {
    const process = new MemoryDaemonProcess();
    const runner = new JsonlCodeAgentDaemonRunnerClient();

    const run = runner.run(request, { onEvent: () => undefined }, createContext(process));
    process.emit({ schemaVersion: 1, type: 'daemon_ready', daemonId: 'daemon-1', backends: ['codex-app-server'] });
    await waitFor(() => process.written.length === 1);
    process.emit({
      schemaVersion: 1,
      type: 'error',
      turnId: 'turn-1',
      message: 'Sandbox daemon is busy with turn old-turn',
      code: 'daemon_busy',
      retryable: false,
    });

    const result = await run;
    assert.equal(result.errorEvent?.code, 'daemon_busy');
  });

  it('runs a thread query through the daemon connection', async () => {
    const process = new MemoryDaemonProcess();
    const runner = new JsonlCodeAgentDaemonRunnerClient();

    const query = runner.query<CodeAgentRunnerThreadListResultEvent>(process, {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'thread_list',
      roomId: 'room-1',
      clientId: 'client-1',
      workspace: '/workspace',
      limit: 10,
    }, 'thread_list_result', {
      ROOMTALK_CODEX_AUTH_JSON_PATH: '/tmp/thread-auth.json',
    });

    process.emit({ schemaVersion: 1, type: 'daemon_ready', daemonId: 'daemon-1', backends: ['codex-app-server'] });
    await waitFor(() => process.written.length === 1);
    process.emit({
      schemaVersion: 1,
      type: 'thread_list_result',
      roomId: 'room-1',
      threads: [{ id: 'thread-1' }],
      nextCursor: null,
      backwardsCursor: null,
    });

    const result = await query;
    assert.deepEqual(result.threads, [{ id: 'thread-1' }]);

    const written = JSON.parse(process.written[0]);
    assert.equal(written.type, 'thread_list');
    assert.equal(written.backend, 'codex-app-server');
    assert.equal(written.env.ROOMTALK_CODEX_AUTH_JSON_PATH, '/tmp/thread-auth.json');
  });
});

const waitFor = async (predicate: () => boolean, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
};
