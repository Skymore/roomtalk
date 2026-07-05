import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Readable, Writable } from 'node:stream';
import { CODE_AGENT_RUNNER_SCHEMA_VERSION, CodeAgentRunnerEvent, CodeAgentRunnerRunRequest } from './codeAgentRunnerProtocol';
import { CodeAgentRunnerAdapter, createCodeAgentRunner } from './codeAgentRunner';
import {
  CodeAgentRunnerClient,
  CodeAgentRunnerHandlers,
  CodeAgentRunnerRunContext,
  CodeAgentRunnerRunResult,
  FakeCodeAgentRunnerClient,
} from './fakeCodeAgentRunner';

const request: CodeAgentRunnerRunRequest = {
  schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
  type: 'run',
  roomId: 'room-1',
  turnId: 'turn-1',
  sessionId: null,
  prompt: 'inspect the workspace',
  mode: 'plan',
  provider: 'deepseek',
  modelId: 'deepseek-v4-pro',
  apiModel: 'deepseek-v4-pro',
  workspace: '/workspace/room-1',
  allowedPaths: ['.'],
};

describe('CodeAgentRunner', () => {
  it('delegates code-agent runs through the backend boundary', async () => {
    const events: CodeAgentRunnerEvent[] = [
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'status', turnId: 'turn-1', status: 'starting' },
      { schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ];
    const sharedClient = new FakeCodeAgentRunnerClient(events);
    const runner = new CodeAgentRunnerAdapter(sharedClient);
    const emitted: CodeAgentRunnerEvent[] = [];

    const result = await runner.run(request, {
      onEvent: event => {
        emitted.push(event);
      },
    });

    assert.equal(runner.backend, 'code-agent');
    assert.deepEqual(sharedClient.requests, [request]);
    assert.equal(result.finalEvent?.answer, 'Done');
    assert.deepEqual(emitted.map(event => event.type), ['status', 'final']);
  });

  it('forwards runner process and sandbox context to the code-agent client', async () => {
    class ContextRecordingRunner implements CodeAgentRunnerClient {
      context: CodeAgentRunnerRunContext | undefined;

      async run(
        _request: CodeAgentRunnerRunRequest,
        _handlers: CodeAgentRunnerHandlers,
        context?: CodeAgentRunnerRunContext
      ): Promise<CodeAgentRunnerRunResult> {
        this.context = context;
        return { events: [] };
      }
    }

    const sharedClient = new ContextRecordingRunner();
    const runner = new CodeAgentRunnerAdapter(sharedClient);
    const context: CodeAgentRunnerRunContext = {
      process: {
        command: 'python -m roomtalk_code_agent_runner',
        stdin: new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        completed: Promise.resolve({ exitCode: 0 }),
        stop: async () => {},
      },
      sandbox: {
        id: 'sandbox-1',
        provider: 'fake',
        roomId: 'room-1',
        creatorId: 'client-1',
        workspace: '/workspace/room-1',
        createdAt: '2026-05-26T00:00:00.000Z',
        expiresAt: '2026-05-26T01:00:00.000Z',
      },
    };

    await runner.run(request, { onEvent: () => {} }, context);

    assert.equal(sharedClient.context, context);
  });

  it('creates the code-agent backend by default and lets Codex reuse the shared runner client', () => {
    const sharedClient = new FakeCodeAgentRunnerClient([]);
    const codexRunner = {
      backend: 'codex' as const,
      run: async () => ({ events: [] }),
    };

    assert.equal(createCodeAgentRunner('code-agent', sharedClient).backend, 'code-agent');
    assert.equal(createCodeAgentRunner('codex', sharedClient).backend, 'codex');
    assert.equal(createCodeAgentRunner('codex-app-server', sharedClient).backend, 'codex-app-server');
    assert.equal(createCodeAgentRunner('codex', sharedClient, { codexRunner }).backend, 'codex');
    assert.throws(
      () => createCodeAgentRunner('codex', sharedClient, { codexRunner: createCodeAgentRunner('code-agent', sharedClient) }),
      /backend=codex/
    );
  });
});
