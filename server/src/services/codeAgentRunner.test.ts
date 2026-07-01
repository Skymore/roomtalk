import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Readable, Writable } from 'node:stream';
import { COCO_RUNNER_SCHEMA_VERSION, CocoRunnerEvent, CocoRunnerRunRequest } from './cocoRunnerProtocol';
import { CocoCodeAgentRunner, createCodeAgentRunner } from './codeAgentRunner';
import {
  CocoRunnerClient,
  CocoRunnerHandlers,
  CocoRunnerRunContext,
  CocoRunnerRunResult,
  FakeCocoRunnerClient,
} from './fakeCocoRunner';

const request: CocoRunnerRunRequest = {
  schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
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
  it('delegates Coco runs through the backend boundary', async () => {
    const events: CocoRunnerEvent[] = [
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'status', turnId: 'turn-1', status: 'starting' },
      { schemaVersion: COCO_RUNNER_SCHEMA_VERSION, type: 'final', messageId: 'ai-1', answer: 'Done', sessionId: 'session-1' },
    ];
    const cocoClient = new FakeCocoRunnerClient(events);
    const runner = new CocoCodeAgentRunner(cocoClient);
    const emitted: CocoRunnerEvent[] = [];

    const result = await runner.run(request, {
      onEvent: event => {
        emitted.push(event);
      },
    });

    assert.equal(runner.backend, 'coco');
    assert.deepEqual(cocoClient.requests, [request]);
    assert.equal(result.finalEvent?.answer, 'Done');
    assert.deepEqual(emitted.map(event => event.type), ['status', 'final']);
  });

  it('forwards runner process and sandbox context to the Coco client', async () => {
    class ContextRecordingRunner implements CocoRunnerClient {
      context: CocoRunnerRunContext | undefined;

      async run(
        _request: CocoRunnerRunRequest,
        _handlers: CocoRunnerHandlers,
        context?: CocoRunnerRunContext
      ): Promise<CocoRunnerRunResult> {
        this.context = context;
        return { events: [] };
      }
    }

    const cocoClient = new ContextRecordingRunner();
    const runner = new CocoCodeAgentRunner(cocoClient);
    const context: CocoRunnerRunContext = {
      process: {
        command: 'python -m roomtalk_coco_runner',
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

    assert.equal(cocoClient.context, context);
  });

  it('creates only the implemented Coco backend', () => {
    const cocoClient = new FakeCocoRunnerClient([]);

    assert.equal(createCodeAgentRunner('coco', cocoClient).backend, 'coco');
    assert.throws(() => createCodeAgentRunner('codex', cocoClient), /not implemented: codex/);
  });
});
