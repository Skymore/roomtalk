import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COCO_RUNNER_SCHEMA_VERSION, CocoRunnerEvent, CocoRunnerRunRequest } from './cocoRunnerProtocol';
import { FakeCocoRunnerClient } from './fakeCocoRunner';

const request: CocoRunnerRunRequest = {
  schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
  type: 'run',
  roomId: 'room-1',
  turnId: 'turn-1',
  prompt: 'run tests',
  mode: 'acceptEdits',
  provider: 'openrouter',
  modelId: 'deepseek-v4-pro',
  apiModel: 'deepseek/deepseek-v4-pro',
  workspace: '/workspace',
  allowedPaths: ['.'],
};

describe('FakeCocoRunnerClient', () => {
  it('emits scripted events in order and records requests', async () => {
    const events: CocoRunnerEvent[] = [
      { schemaVersion: 1, type: 'text_delta', messageId: 'ai-1', delta: 'checking' },
      { schemaVersion: 1, type: 'tool_call', id: 'tool-1', name: 'Read', args: { file_path: 'README.md' } },
      { schemaVersion: 1, type: 'tool_result', id: 'tool-1', name: 'Read', success: true, output: '# RoomTalk' },
      { schemaVersion: 1, type: 'final', messageId: 'ai-1', answer: 'done', sessionId: 'session-1' },
    ];
    const runner = new FakeCocoRunnerClient(events);
    const emitted: CocoRunnerEvent[] = [];

    const result = await runner.run(request, { onEvent: event => { emitted.push(event); } });

    assert.deepEqual(runner.requests, [request]);
    assert.deepEqual(emitted.map(event => event.type), ['text_delta', 'tool_call', 'tool_result', 'final']);
    assert.equal(result.finalEvent?.sessionId, 'session-1');
    assert.equal(result.errorEvent, undefined);
  });

  it('returns the terminal error event when a script fails', async () => {
    const runner = new FakeCocoRunnerClient([
      { schemaVersion: 1, type: 'error', message: 'runner crashed', code: 'runner_exit', retryable: false },
      { schemaVersion: 1, type: 'text_delta', messageId: 'ai-1', delta: 'should not emit' },
    ]);
    const emitted: string[] = [];

    const result = await runner.run(request, { onEvent: event => { emitted.push(event.type); } });

    assert.equal(result.finalEvent, undefined);
    assert.equal(result.errorEvent?.message, 'runner crashed');
    assert.deepEqual(emitted, ['error']);
  });
});
