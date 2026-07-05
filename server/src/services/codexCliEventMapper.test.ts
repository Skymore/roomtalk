import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { parseCodeAgentRunnerEventLine } from './codeAgentRunnerProtocol';
import {
  CodexCliDiagnosticsTail,
  CodexCliEventMapper,
  CodexCliEventMapperError,
  CodexExecJsonlParser,
  normalizeWorkspacePath,
  normalizeWorkspaceText,
} from './codexCliEventMapper';

const workspace = '/tmp/roomtalk-codex-workspace';

describe('CodexExecJsonlParser', () => {
  test('parses chunked stdout JSONL and flushes a trailing line', () => {
    const parser = new CodexExecJsonlParser();
    const first = parser.push('{"type":"thread.started","thread_id":"thread-1"}\n{"type":"turn.');
    const second = parser.push('started"}\n{"type":"turn.completed"}');
    const flushed = parser.flush();

    assert.deepEqual([...first, ...second, ...flushed].map(event => event.type), [
      'thread.started',
      'turn.started',
      'turn.completed',
    ]);
  });

  test('throws a mapper error for malformed stdout JSONL', () => {
    const parser = new CodexExecJsonlParser();
    assert.throws(() => parser.push('{"type":"turn.started"}\n{bad}\n'), CodexCliEventMapperError);
  });
});

describe('CodexCliEventMapper', () => {
  test('maps Codex JSONL events to code agent runner events with normalized workspace paths', () => {
    const mapper = new CodexCliEventMapper({
      turnId: 'turn-1',
      messageId: 'ai-1',
      workspace,
      fallbackSessionId: 'fallback-session',
    });

    const events = [
      ...mapper.mapEvent({ type: 'thread.started', thread_id: 'thread-1' }),
      ...mapper.mapEvent({ type: 'turn.started' }),
      ...mapper.mapEvent({
        type: 'item.completed',
        item: {
          id: 'msg-1',
          type: 'agent_message',
          text: `Updated ${workspace}/src/demo.js`,
        },
      }),
      ...mapper.mapEvent({
        type: 'item.started',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'npm test',
        },
      }),
      ...mapper.mapEvent({
        type: 'item.completed',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          status: 'completed',
          exit_code: 0,
          aggregated_output: `ok ${workspace}/src/demo.test.js`,
        },
      }),
      ...mapper.mapEvent({
        type: 'item.started',
        item: {
          id: 'file-1',
          type: 'file_change',
          changes: [{ path: `${workspace}/src/demo.js`, kind: 'modified' }],
        },
      }),
      ...mapper.mapEvent({
        type: 'item.completed',
        item: {
          id: 'file-1',
          type: 'file_change',
          status: 'completed',
          changes: [{ path: `${workspace}/src/demo.js`, kind: 'modified' }],
        },
      }),
      ...mapper.mapEvent({
        type: 'turn.completed',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          cached_input_tokens: 4,
        },
      }),
    ];
    const final = mapper.createFinalEvent(`Finished ${workspace}/src/demo.js`);

    for (const event of [...events, final]) {
      assert.equal(parseCodeAgentRunnerEventLine(JSON.stringify(event)).type, event.type);
    }
    assert.deepEqual(events.map(event => event.type), [
      'status',
      'status',
      'text_delta',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'status',
    ]);

    const textDelta = events.find(event => event.type === 'text_delta');
    assert.equal(textDelta?.type === 'text_delta' ? textDelta.delta : '', 'Updated src/demo.js\n\n');

    const shellResult = events.find(event => event.type === 'tool_result' && event.name === 'shell');
    assert.equal(shellResult?.type === 'tool_result' ? shellResult.output : '', 'ok src/demo.test.js');
    assert.equal(shellResult?.type === 'tool_result' ? shellResult.success : false, true);

    const fileCall = events.find(event => event.type === 'tool_call' && event.name === 'file_change');
    assert.deepEqual(fileCall?.type === 'tool_call' ? fileCall.args : {}, {
      changes: [{ path: 'src/demo.js', kind: 'modified' }],
    });

    assert.equal(final.answer, 'Finished src/demo.js');
    assert.equal(final.sessionId, 'thread-1');
    assert.deepEqual(final.usage, {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      source: 'reported',
      cachedPromptTokens: 4,
      cacheHitRate: 0.4,
    });
  });

  test('maps failed command execution to an errored shell result', () => {
    const mapper = new CodexCliEventMapper({ turnId: 'turn-1', messageId: 'ai-1', workspace });
    const events = mapper.mapEvent({
      type: 'item.completed',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        status: 'failed',
        exit_code: 2,
        aggregated_output: 'npm ERR',
      },
    });

    assert.equal(events.length, 1);
    const result = events[0];
    assert.equal(result.type, 'tool_result');
    assert.equal(result.type === 'tool_result' ? result.success : true, false);
    assert.equal(result.type === 'tool_result' ? result.exitCode : undefined, 2);
  });

  test('maps RoomTalk platform commands to named tool events', () => {
    const mapper = new CodexCliEventMapper({ turnId: 'turn-1', messageId: 'ai-1', workspace });
    const events = [
      ...mapper.mapEvent({
        type: 'item.started',
        item: {
          id: 'cmd-publish',
          type: 'command_execution',
          command: 'roomtalk publish-static-site --root site',
        },
      }),
      ...mapper.mapEvent({
        type: 'item.completed',
        item: {
          id: 'cmd-publish',
          type: 'command_execution',
          status: 'completed',
          exit_code: 0,
          aggregated_output: 'Published static site: https://room.example/p/demo/',
        },
      }),
    ];

    assert.deepEqual(events.map(event => event.type === 'tool_call' || event.type === 'tool_result' ? event.name : ''), [
      'PublishStaticSite',
      'PublishStaticSite',
    ]);
  });

  test('does not present removed RoomTalk background helper as a platform tool', () => {
    const mapper = new CodexCliEventMapper({ turnId: 'turn-1', messageId: 'ai-1', workspace });
    const events = mapper.mapEvent({
      type: 'item.started',
      item: {
        id: 'cmd-background',
        type: 'command_execution',
        command: 'roomtalk background-shell list',
      },
    });

    assert.equal(events.length, 1);
    const call = events[0];
    assert.equal(call.type, 'tool_call');
    assert.equal(call.type === 'tool_call' ? call.name : '', 'shell');
  });

  test('maps turn failures to Coco error events', () => {
    const mapper = new CodexCliEventMapper({ turnId: 'turn-1', messageId: 'ai-1', workspace });
    const events = mapper.mapEvent({ type: 'turn.failed', message: 'model failed' });

    assert.deepEqual(events, [{
      schemaVersion: 1,
      type: 'error',
      turnId: 'turn-1',
      message: 'model failed',
      code: 'codex_cli_error',
      retryable: false,
    }]);
  });

  test('counts unknown item types without crashing a turn', () => {
    const mapper = new CodexCliEventMapper({ turnId: 'turn-1', messageId: 'ai-1', workspace });
    assert.deepEqual(mapper.mapEvent({ type: 'item.started', item: { id: 'x', type: 'thinking' } }), []);
    assert.deepEqual(mapper.mapEvent({ type: 'item.completed', item: { id: 'x', type: 'thinking' } }), []);

    assert.deepEqual(mapper.snapshot().ignoredItemTypes, { thinking: 2 });
  });
});

describe('Codex CLI diagnostics and path normalization', () => {
  test('keeps stderr diagnostics separate from mapped stdout events', () => {
    const diagnostics = new CodexCliDiagnosticsTail(12);
    diagnostics.push('first warning\n');
    diagnostics.push('second warning\n');

    const mapper = new CodexCliEventMapper({ turnId: 'turn-1', messageId: 'ai-1', workspace });
    const events = mapper.mapEvent({
      type: 'item.completed',
      item: {
        id: 'msg-1',
        type: 'agent_message',
        text: 'stdout message only',
      },
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].type === 'text_delta' ? events[0].delta : '', 'stdout message only\n\n');
    assert.equal(diagnostics.getTail(), 'ond warning');
  });

  test('normalizes only paths inside the workspace', () => {
    assert.equal(normalizeWorkspacePath(workspace, `${workspace}/src/demo.js`), 'src/demo.js');
    assert.equal(normalizeWorkspacePath(workspace, '/tmp/other/demo.js'), '/tmp/other/demo.js');
    assert.equal(normalizeWorkspaceText(workspace, `see ${workspace}/src/demo.js and /tmp/other/demo.js`), 'see src/demo.js and /tmp/other/demo.js');
  });
});
