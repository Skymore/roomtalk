import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CODE_AGENT_RUNNER_SCHEMA_VERSION,
  CodeAgentRunnerProtocolError,
  CodeAgentRunnerRunRequest,
} from './codeAgentRunnerProtocol';
import {
  CodeAgentDaemonJsonlParser,
  createCodeAgentDaemonRunRequest,
  createCodeAgentDaemonThreadQueryRequest,
  isCodeAgentDaemonControlEvent,
  isCodeAgentDaemonRunnerEvent,
  parseCodeAgentDaemonEventLine,
  serializeCodeAgentDaemonRequest,
} from './codeAgentDaemonProtocol';

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

describe('code agent daemon protocol', () => {
  it('serializes daemon run requests with an explicit backend', () => {
    const daemonRequest = createCodeAgentDaemonRunRequest(request, 'codex-app-server', {
      ROOMTALK_CODEX_AUTH_JSON_PATH: '/tmp/auth.json',
    });
    const serialized = serializeCodeAgentDaemonRequest(daemonRequest);

    assert.equal(serialized.endsWith('\n'), true);
    assert.deepEqual(JSON.parse(serialized), {
      ...request,
      backend: 'codex-app-server',
      env: {
        ROOMTALK_CODEX_AUTH_JSON_PATH: '/tmp/auth.json',
      },
    });
  });

  it('serializes daemon thread queries with per-request env', () => {
    const serialized = serializeCodeAgentDaemonRequest(createCodeAgentDaemonThreadQueryRequest({
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'thread_list',
      roomId: 'room-1',
      clientId: 'client-1',
      workspace: '/workspace',
      limit: 10,
    }, {
      ROOMTALK_CODEX_AUTH_JSON_PATH: '/tmp/auth.json',
    }));

    assert.equal(serialized.endsWith('\n'), true);
    assert.deepEqual(JSON.parse(serialized), {
      schemaVersion: 1,
      type: 'thread_list',
      roomId: 'room-1',
      clientId: 'client-1',
      workspace: '/workspace',
      limit: 10,
      backend: 'codex-app-server',
      env: {
        ROOMTALK_CODEX_AUTH_JSON_PATH: '/tmp/auth.json',
      },
    });
  });

  it('parses daemon control events separately from runner turn events', () => {
    const ready = parseCodeAgentDaemonEventLine(JSON.stringify({
      schemaVersion: 1,
      type: 'daemon_ready',
      daemonId: 'daemon-1',
      pid: 123,
      backends: ['code-agent', 'codex', 'codex-app-server'],
    }));
    const health = parseCodeAgentDaemonEventLine(JSON.stringify({
      schemaVersion: 1,
      type: 'health_result',
      requestId: 'health-1',
      status: 'ok',
      activeTurnId: null,
    }));
    const released = parseCodeAgentDaemonEventLine(JSON.stringify({
      schemaVersion: 1,
      type: 'turn_released',
      turnId: 'turn-1',
    }));
    const final = parseCodeAgentDaemonEventLine(JSON.stringify({
      schemaVersion: 1,
      type: 'final',
      messageId: 'ai-1',
      answer: 'done',
      sessionId: 'session-1',
    }));

    assert.equal(isCodeAgentDaemonControlEvent(ready), true);
    assert.equal(isCodeAgentDaemonControlEvent(health), true);
    assert.equal(isCodeAgentDaemonControlEvent(released), true);
    assert.equal(isCodeAgentDaemonRunnerEvent(final), true);
    assert.deepEqual(ready, {
      schemaVersion: 1,
      type: 'daemon_ready',
      daemonId: 'daemon-1',
      pid: 123,
      backends: ['code-agent', 'codex', 'codex-app-server'],
    });
    assert.deepEqual(health, {
      schemaVersion: 1,
      type: 'health_result',
      requestId: 'health-1',
      status: 'ok',
      activeTurnId: null,
    });
    assert.deepEqual(released, {
      schemaVersion: 1,
      type: 'turn_released',
      turnId: 'turn-1',
    });
    assert.deepEqual(final, {
      schemaVersion: 1,
      type: 'final',
      messageId: 'ai-1',
      answer: 'done',
      sessionId: 'session-1',
      usage: undefined,
    });
  });

  it('parses daemon JSONL chunks without losing partial lines', () => {
    const parser = new CodeAgentDaemonJsonlParser();
    const parsed = parser.push('{"schemaVersion":1,"type":"daemon_ready","daemonId":"daemon-1","backends":["code');
    assert.deepEqual(parsed, []);

    const more = parser.push('-agent"]}\n{"schemaVersion":1,"type":"health_result","status":"ok"}\n');
    assert.deepEqual(more.map(event => event.type), ['daemon_ready', 'health_result']);
    assert.deepEqual(parser.flush(), []);
  });

  it('rejects malformed daemon-only events', () => {
    assert.throws(() => parseCodeAgentDaemonEventLine(JSON.stringify({
      schemaVersion: 1,
      type: 'daemon_ready',
      daemonId: 'daemon-1',
      backends: ['unsupported'],
    })), CodeAgentRunnerProtocolError);
    assert.throws(() => parseCodeAgentDaemonEventLine(JSON.stringify({
      schemaVersion: 1,
      type: 'health_result',
      status: 'bad',
    })), /Invalid daemon health status/);
  });
});
