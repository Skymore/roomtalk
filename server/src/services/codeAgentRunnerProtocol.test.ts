import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CODE_AGENT_RUNNER_SCHEMA_VERSION,
  CodeAgentRunnerJsonlParser,
  CodeAgentRunnerProtocolError,
  CodeAgentRunnerRunRequest,
  parseCodeAgentRunnerEventLine,
  serializeCodeAgentRunnerRequest,
} from './codeAgentRunnerProtocol';

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

describe('code agent runner protocol', () => {
  it('serializes run requests as one JSONL line', () => {
    const serialized = serializeCodeAgentRunnerRequest(request);
    assert.equal(serialized.endsWith('\n'), true);
    assert.deepEqual(JSON.parse(serialized), request);
  });

  it('serializes code-agent prior messages in run requests', () => {
    const withPrior: CodeAgentRunnerRunRequest = {
      ...request,
      codexModel: 'gpt-5.5',
      codexReasoningEffort: 'xhigh',
      codexPermissionMode: 'approveForMe',
      codexServiceTier: 'priority',
      priorMessages: [
        { role: 'user', content: 'list files' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will inspect.' },
            { type: 'tool_use', id: 'tool-1', name: 'Glob', input: { pattern: '**/*' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'No files found.' },
          ],
        },
      ],
    };

    assert.deepEqual(JSON.parse(serializeCodeAgentRunnerRequest(withPrior)), withPrior);
  });

  it('parses all runner event shapes', () => {
    assert.deepEqual(parseCodeAgentRunnerEventLine(JSON.stringify({
      schemaVersion: 1,
      type: 'text_delta',
      messageId: 'ai-1',
      delta: '',
    })), {
      schemaVersion: 1,
      type: 'text_delta',
      messageId: 'ai-1',
      delta: '',
    });

    assert.deepEqual(parseCodeAgentRunnerEventLine(JSON.stringify({
      schemaVersion: 1,
      type: 'status',
      turnId: 'turn-1',
      status: 'starting',
    })), {
      schemaVersion: 1,
      type: 'status',
      turnId: 'turn-1',
      status: 'starting',
      message: undefined,
    });

    assert.deepEqual(parseCodeAgentRunnerEventLine(JSON.stringify({
      schemaVersion: 1,
      type: 'tool_call',
      id: 'tool-1',
      name: 'Read',
      args: { file_path: 'README.md' },
      messageId: 'tool-message-1',
    })), {
      schemaVersion: 1,
      type: 'tool_call',
      id: 'tool-1',
      name: 'Read',
      args: { file_path: 'README.md' },
      messageId: 'tool-message-1',
    });

    assert.deepEqual(parseCodeAgentRunnerEventLine(JSON.stringify({
      schemaVersion: 1,
      type: 'tool_result',
      id: 'tool-1',
      name: 'Shell',
      success: true,
      output: '',
      exitCode: 2,
      elapsedMs: 12,
      truncated: true,
    })), {
      schemaVersion: 1,
      type: 'tool_result',
      id: 'tool-1',
      name: 'Shell',
      success: true,
      output: '',
      messageId: undefined,
      exitCode: 2,
      elapsedMs: 12,
      truncated: true,
    });

    assert.deepEqual(parseCodeAgentRunnerEventLine(JSON.stringify({
      schemaVersion: 1,
      type: 'final',
      messageId: 'ai-1',
      answer: 'done',
      sessionId: 'session-1',
      usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7, source: 'reported' },
    })), {
      schemaVersion: 1,
      type: 'final',
      messageId: 'ai-1',
      answer: 'done',
      sessionId: 'session-1',
      usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7, source: 'reported' },
    });

    assert.deepEqual(parseCodeAgentRunnerEventLine(JSON.stringify({
      schemaVersion: 1,
      type: 'usage',
      turnId: 'turn-1',
      usage: {
        promptTokens: 106000,
        completionTokens: 0,
        totalTokens: 106000,
        modelContextWindow: 200000,
        source: 'reported',
      },
    })), {
      schemaVersion: 1,
      type: 'usage',
      turnId: 'turn-1',
      usage: {
        promptTokens: 106000,
        completionTokens: 0,
        totalTokens: 106000,
        modelContextWindow: 200000,
        source: 'reported',
      },
    });
  });

  it('rejects unsupported schema versions and malformed JSON', () => {
    assert.throws(() => parseCodeAgentRunnerEventLine('{bad'), CodeAgentRunnerProtocolError);
    assert.throws(() => parseCodeAgentRunnerEventLine(JSON.stringify({
      schemaVersion: 2,
      type: 'status',
      turnId: 'turn-1',
      status: 'starting',
    })), /Unsupported code agent runner schemaVersion/);
    assert.throws(() => parseCodeAgentRunnerEventLine(JSON.stringify({
      schemaVersion: 1,
      type: 'tool_result',
      id: 'tool-1',
      name: 'Shell',
      success: 'true',
      output: '',
    })), /Expected boolean field "success"/);
    assert.throws(() => parseCodeAgentRunnerEventLine(JSON.stringify({
      schemaVersion: 1,
      type: 'tool_call',
      id: 'tool-1',
      name: 'Read',
      args: 'README.md',
    })), /Expected object field "args"/);
    assert.throws(() => parseCodeAgentRunnerEventLine(JSON.stringify({
      schemaVersion: 1,
      type: 'tool_call',
      id: 'tool-1',
      name: 'Read',
    })), /Expected object field "args"/);
    assert.throws(() => parseCodeAgentRunnerEventLine(JSON.stringify({
      schemaVersion: 1,
      type: 'error',
      message: 'boom',
      code: '',
    })), /Expected non-empty string field "code"/);
  });

  it('parses JSONL chunks without losing partial lines', () => {
    const parser = new CodeAgentRunnerJsonlParser();
    const first = '{"schemaVersion":1,"type":"text_delta","messageId":"ai","delta":"hel';
    const second = 'lo"}\n{"schemaVersion":1,"type":"error","message":"boom"}\n';

    assert.deepEqual(parser.push(first), []);
    const parsed = parser.push(second);

    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].type, 'text_delta');
    assert.deepEqual(parsed[1], {
      schemaVersion: 1,
      type: 'error',
      message: 'boom',
      turnId: undefined,
      code: undefined,
      retryable: undefined,
    });
    assert.deepEqual(parser.flush(), []);
  });

  it('flushes a final line even when the stream has no trailing newline', () => {
    const parser = new CodeAgentRunnerJsonlParser();
    assert.deepEqual(parser.push('{"schemaVersion":1,"type":"error","message":"boom"}'), []);
    const parsed = parser.flush();
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].type, 'error');
  });
});
