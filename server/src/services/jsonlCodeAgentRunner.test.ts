import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PassThrough, Writable } from 'stream';
import { CODE_AGENT_RUNNER_SCHEMA_VERSION, CodeAgentRunnerEvent, CodeAgentRunnerRunRequest } from './codeAgentRunnerProtocol';
import { CodeAgentRunnerProcess, CodeAgentRunnerProcessExit, CodeAgentSandboxHandle } from './codeAgentSandboxService';
import { JsonlCodeAgentRunnerClient } from './jsonlCodeAgentRunner';

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

class MemoryRunnerProcess implements CodeAgentRunnerProcess {
  readonly command = 'python -m roomtalk_code_agent_runner';
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writtenInput: Promise<string>;
  private resolveExit!: (exit: CodeAgentRunnerProcessExit) => void;
  private rejectExit!: (error: unknown) => void;
  readonly completed: Promise<CodeAgentRunnerProcessExit>;
  stopCalled = false;

  constructor() {
    const completionSuccess = new Promise<CodeAgentRunnerProcessExit>(resolve => {
      this.resolveExit = resolve;
    });
    const completionFailure = new Promise<never>((_, reject) => {
      this.rejectExit = reject;
    });
    this.completed = Promise.race([completionSuccess, completionFailure]);
    const chunks: Buffer[] = [];
    this.stdin.on('data', chunk => chunks.push(Buffer.from(chunk)));
    this.writtenInput = new Promise(resolve => {
      this.stdin.on('finish', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }

  complete(exitCode = 0, signal: string | null = null) {
    this.stdin.end();
    this.stdout.end();
    this.stderr.end();
    this.resolveExit({ exitCode, signal });
  }

  failCompletion(error: unknown) {
    this.stdin.end();
    this.stdout.end();
    this.stderr.end();
    this.rejectExit(error);
  }

  async stop() {
    this.stopCalled = true;
  }
}

class StdinFailureRunnerProcess implements CodeAgentRunnerProcess {
  readonly command = 'python -m roomtalk_code_agent_runner';
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private resolveExit!: (exit: CodeAgentRunnerProcessExit) => void;
  readonly completed: Promise<CodeAgentRunnerProcessExit>;

  constructor(error: Error) {
    this.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback(error);
      },
    });
    this.completed = new Promise<CodeAgentRunnerProcessExit>(resolve => {
      this.resolveExit = resolve;
    });
  }

  complete(exitCode = 1, signal: string | null = null) {
    this.stdout.end();
    this.stderr.end();
    this.resolveExit({ exitCode, signal });
  }

  async stop() {}
}

const createContext = (process: CodeAgentRunnerProcess = new MemoryRunnerProcess()) => ({
  process,
  sandbox,
});

describe('JsonlCodeAgentRunnerClient', () => {
  it('writes one JSONL request and returns final events in order', async () => {
    const process = new MemoryRunnerProcess();
    const runner = new JsonlCodeAgentRunnerClient();
    const emitted: CodeAgentRunnerEvent[] = [];

    const run = runner.run(request, {
      onEvent: event => {
        emitted.push(event);
      },
    }, createContext(process));

    process.stdout.write('{"schemaVersion":1,"type":"tool_call","id":"tool-1","name":"Read","args":{"file_path":"README.md"}}\n');
    process.stdout.write('{"schemaVersion":1,"type":"tool_result","id":"tool-1","name":"Read","success":true,"output":"# RoomTalk"}\n');
    process.stdout.write('{"schemaVersion":1,"type":"final","messageId":"ai-1","answer":"done","sessionId":"session-1"}\n');
    process.complete(0);

    const result = await run;
    assert.deepEqual(JSON.parse(await process.writtenInput), request);
    assert.deepEqual(emitted.map(event => event.type), ['tool_call', 'tool_result', 'final']);
    assert.equal(result.finalEvent?.sessionId, 'session-1');
    assert.equal(result.errorEvent, undefined);
  });

  it('turns malformed stdout into a runner protocol error event', async () => {
    const process = new MemoryRunnerProcess();
    const runner = new JsonlCodeAgentRunnerClient();
    const emitted: CodeAgentRunnerEvent[] = [];

    const run = runner.run(request, {
      onEvent: event => {
        emitted.push(event);
      },
    }, createContext(process));

    process.stdout.write('{bad json}\n');
    process.complete(0);

    const result = await run;
    assert.equal(result.errorEvent?.code, 'protocol_error');
    assert.match(result.errorEvent?.message || '', /Invalid code agent runner JSON event/);
    assert.deepEqual(emitted.map(event => event.type), ['error']);
  });

  it('turns process failure before final into a runner exit error event with stderr tail', async () => {
    const process = new MemoryRunnerProcess();
    const runner = new JsonlCodeAgentRunnerClient();
    const emitted: CodeAgentRunnerEvent[] = [];

    const run = runner.run(request, {
      onEvent: event => {
        emitted.push(event);
      },
    }, createContext(process));

    process.stderr.write('provider failed');
    process.complete(7);

    const result = await run;
    assert.equal(result.errorEvent?.code, 'runner_exit');
    assert.match(result.errorEvent?.message || '', /provider failed/);
    assert.deepEqual(emitted.map(event => event.type), ['error']);
  });

  it('turns stdin write failures into a runner error event with stderr tail', async () => {
    const process = new StdinFailureRunnerProcess(new Error('write |1: broken pipe'));
    const runner = new JsonlCodeAgentRunnerClient();
    const emitted: CodeAgentRunnerEvent[] = [];

    const run = runner.run(request, {
      onEvent: event => {
        emitted.push(event);
      },
    }, createContext(process));

    process.stderr.write('ModuleNotFoundError: roomtalk_code_agent_runner.codex_cli');
    process.complete(1);

    const result = await run;
    assert.equal(result.errorEvent?.code, 'runner_stdin_write_failed');
    assert.match(result.errorEvent?.message || '', /broken pipe/);
    assert.match(result.errorEvent?.message || '', /roomtalk_code_agent_runner\.codex_cli/);
    assert.deepEqual(emitted.map(event => event.type), ['error']);
  });

  it('reports clean exit without final as a protocol-level missing final error', async () => {
    const process = new MemoryRunnerProcess();
    const runner = new JsonlCodeAgentRunnerClient();

    const run = runner.run(request, { onEvent: () => {} }, createContext(process));
    process.complete(0);

    const result = await run;
    assert.equal(result.errorEvent?.code, 'missing_final');
    assert.match(result.errorEvent?.message || '', /without a final event/);
  });

  it('turns completion promise failures into runner process errors', async () => {
    const process = new MemoryRunnerProcess();
    const runner = new JsonlCodeAgentRunnerClient();

    const run = runner.run(request, { onEvent: () => {} }, createContext(process));
    process.failCompletion(new Error('completion rejected'));

    const result = await run;
    assert.equal(result.errorEvent?.code, 'runner_process_error');
    assert.match(result.errorEvent?.message || '', /completion rejected/);
  });

  it('propagates handler failures so the session can stop the owned runner process', async () => {
    const process = new MemoryRunnerProcess();
    const runner = new JsonlCodeAgentRunnerClient();

    const run = runner.run(request, {
      onEvent: () => {
        throw new Error('persist failed');
      },
    }, createContext(process));

    process.stdout.write('{"schemaVersion":1,"type":"tool_call","id":"tool-1","name":"Read","args":{}}\n');
    process.complete(0);

    await assert.rejects(run, /persist failed/);
  });

  it('requires a process created by the sandbox service', async () => {
    const runner = new JsonlCodeAgentRunnerClient();

    await assert.rejects(
      () => runner.run(request, { onEvent: () => {} }),
      /requires a started runner process/
    );
  });
});
