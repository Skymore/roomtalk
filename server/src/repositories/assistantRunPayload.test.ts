import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { decodeAssistantRunRequestPayload, decodeAssistantRunTerminalPayload } from './assistantRunPayload';

const message = (overrides: Record<string, unknown> = {}) => ({
  id: 'message-1',
  roomId: 'room-1',
  clientId: 'ai_assistant',
  content: '',
  timestamp: '2026-07-22T00:00:00.000Z',
  messageType: 'ai',
  status: 'streaming',
  ...overrides,
});

const model = {
  id: 'test-model',
  apiModel: 'provider/test-model',
  provider: 'openrouter' as const,
  label: 'Test Model',
  description: 'Stable execution snapshot',
  pricing: {
    currency: 'USD' as const,
    inputPerMillion: 1,
    outputPerMillion: 2,
  },
};

const expectedRequest = {
  roomId: 'room-1',
  modelId: model.id,
  apiModel: model.apiModel,
  provider: model.provider,
};

const request = (contextMessages: unknown[] = [message()]) => ({
  schemaVersion: 1,
  model,
  roleName: 'AI Assistant',
  systemPrompt: 'Be helpful.',
  contextMessages,
});

describe('assistant run payload protocol', () => {
  it('accepts a versioned context snapshot including an empty AI placeholder', () => {
    const payload = request();
    assert.deepEqual(decodeAssistantRunRequestPayload(payload, expectedRequest), payload);
  });

  it('rejects mutable model lookups, cross-room context, duplicates, and extra fields', () => {
    assert.equal(decodeAssistantRunRequestPayload(request([
      message({ roomId: 'room-2' }),
    ]), expectedRequest), null);
    assert.equal(decodeAssistantRunRequestPayload(request([
      message(),
      message(),
    ]), expectedRequest), null);
    assert.equal(decodeAssistantRunRequestPayload({
      ...request([]),
      unexpected: true,
    }, expectedRequest), null);
    assert.equal(decodeAssistantRunRequestPayload({
      ...request([]),
      model: { ...model, apiModel: 'changed-after-queue' },
    }, expectedRequest), null);
  });

  it('accepts a terminal after-image only for the run message and outcome', () => {
    const payload = {
      schemaVersion: 1,
      outcome: 'complete',
      message: message({ status: 'complete', content: 'done' }),
      metadata: { contentLength: 4 },
    };
    assert.deepEqual(decodeAssistantRunTerminalPayload(payload, {
      roomId: 'room-1',
      messageId: 'message-1',
    }), payload);
    assert.equal(decodeAssistantRunTerminalPayload({
      ...payload,
      message: message({ status: 'error' }),
    }, { roomId: 'room-1', messageId: 'message-1' }), null);
    assert.equal(decodeAssistantRunTerminalPayload(payload, {
      roomId: 'room-1',
      messageId: 'different-message',
    }), null);
  });

  it('requires terminal error and accounting fields to agree with the after-image', () => {
    const usage = {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      source: 'reported',
    };
    const cost = {
      currency: 'USD',
      inputUsd: 0.001,
      outputUsd: 0.002,
      totalUsd: 0.003,
      inputPerMillion: 1,
      outputPerMillion: 2,
      estimated: false,
    };
    const payload = {
      schemaVersion: 1,
      outcome: 'error',
      error: 'provider failed',
      message: message({ status: 'error', isError: true, usage, cost }),
    };
    assert.deepEqual(decodeAssistantRunTerminalPayload(payload, {
      roomId: 'room-1',
      messageId: 'message-1',
    }), payload);
    assert.equal(decodeAssistantRunTerminalPayload({
      ...payload,
      error: undefined,
    }, { roomId: 'room-1', messageId: 'message-1' }), null);
    assert.equal(decodeAssistantRunTerminalPayload({
      ...payload,
      message: message({ status: 'error', isError: true, usage, cost: { ...cost, totalUsd: 10 } }),
    }, { roomId: 'room-1', messageId: 'message-1' }), null);
    assert.equal(decodeAssistantRunTerminalPayload({
      ...payload,
      message: message({ status: 'error', isError: false, usage, cost }),
    }, { roomId: 'room-1', messageId: 'message-1' }), null);
    assert.ok(decodeAssistantRunTerminalPayload({
      ...payload,
      message: message({ status: 'error', isError: true, usage }),
    }, { roomId: 'room-1', messageId: 'message-1' }));
    assert.equal(decodeAssistantRunTerminalPayload({
      ...payload,
      message: message({ status: 'error', isError: true, cost }),
    }, { roomId: 'room-1', messageId: 'message-1' }), null);
  });

  it('binds new terminal accounting to the queued model snapshot', () => {
    const usage = {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      source: 'reported',
    };
    const cost = {
      currency: 'USD',
      inputUsd: 0.00001,
      outputUsd: 0.00001,
      totalUsd: 0.00002,
      inputPerMillion: 1,
      outputPerMillion: 2,
      estimated: false,
    };
    const terminal = {
      schemaVersion: 1,
      outcome: 'complete',
      message: message({
        status: 'complete',
        content: 'done',
        aiModel: {
          id: model.id,
          apiModel: model.apiModel,
          provider: model.provider,
          label: model.label,
        },
        usage,
        cost,
      }),
    };
    const expected = { roomId: 'room-1', messageId: 'message-1', model };
    assert.ok(decodeAssistantRunTerminalPayload(terminal, expected));
    assert.equal(decodeAssistantRunTerminalPayload({
      ...terminal,
      message: {
        ...terminal.message,
        cost: { ...cost, inputPerMillion: 99 },
      },
    }, expected), null);
    assert.equal(decodeAssistantRunTerminalPayload({
      ...terminal,
      message: { ...terminal.message, cost: undefined },
    }, expected), null);
  });
});
