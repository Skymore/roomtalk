import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CODE_AGENT_RUNNER_SCHEMA_VERSION, CodeAgentRunnerEvent, CodeAgentRunnerRunRequest } from './codeAgentRunnerProtocol';
import { FakeCodeAgentRunnerClient } from './fakeCodeAgentRunner';

const request: CodeAgentRunnerRunRequest = {
  schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
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

describe('FakeCodeAgentRunnerClient', () => {
  it('emits scripted events in order and records requests', async () => {
    const events: CodeAgentRunnerEvent[] = [
      { schemaVersion: 1, type: 'text_delta', messageId: 'ai-1', delta: 'checking' },
      { schemaVersion: 1, type: 'tool_call', id: 'tool-1', name: 'Read', args: { file_path: 'README.md' } },
      { schemaVersion: 1, type: 'tool_result', id: 'tool-1', name: 'Read', success: true, output: '# RoomTalk' },
      { schemaVersion: 1, type: 'final', messageId: 'ai-1', answer: 'done', sessionId: 'session-1' },
    ];
    const runner = new FakeCodeAgentRunnerClient(events);
    const emitted: CodeAgentRunnerEvent[] = [];

    const result = await runner.run(request, { onEvent: event => { emitted.push(event); } });

    assert.deepEqual(runner.requests, [request]);
    assert.deepEqual(emitted.map(event => event.type), ['text_delta', 'tool_call', 'tool_result', 'final']);
    assert.equal(result.finalEvent?.sessionId, 'session-1');
    assert.equal(result.errorEvent, undefined);
  });

  it('returns the terminal error event when a script fails', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: 1, type: 'error', message: 'runner crashed', code: 'runner_exit', retryable: false },
      { schemaVersion: 1, type: 'text_delta', messageId: 'ai-1', delta: 'should not emit' },
    ]);
    const emitted: string[] = [];

    const result = await runner.run(request, { onEvent: event => { emitted.push(event.type); } });

    assert.equal(result.finalEvent, undefined);
    assert.equal(result.errorEvent?.message, 'runner crashed');
    assert.deepEqual(emitted, ['error']);
  });

  it('binds fake scripted turn ids to the current request', async () => {
    const runner = new FakeCodeAgentRunnerClient([
      { schemaVersion: 1, type: 'status', turnId: 'fake', status: 'starting' },
      {
        schemaVersion: 1,
        type: 'model_step',
        turnId: 'fake',
        stepId: 'fake:step:1',
        sequence: 1,
        hasText: false,
        toolCallIds: ['tool-1'],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, source: 'reported' },
      },
    ]);
    const emitted: CodeAgentRunnerEvent[] = [];

    await runner.run(request, { onEvent: event => { emitted.push(event); } });

    assert.deepEqual(
      emitted.map(event => ('turnId' in event ? event.turnId : null)),
      ['turn-1', 'turn-1'],
    );
  });
});
