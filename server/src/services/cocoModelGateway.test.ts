import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'net';
import { afterEach, describe, it } from 'node:test';
import { Server as HttpServer } from 'http';
import {
  CocoModelGateway,
  InMemoryCocoModelGatewayTokenStateStore,
  registerCocoModelGatewayRoutes,
} from './cocoModelGateway';
import { AIModelOption } from '../types';

type FetchCall = {
  url: string;
  init: RequestInit;
};

const deepseekModel: AIModelOption = {
  id: 'deepseek-v4-pro',
  apiModel: 'deepseek-chat',
  provider: 'deepseek',
  label: 'DeepSeek V4 Pro',
  description: 'DeepSeek test model',
  pricing: { currency: 'USD', inputPerMillion: 0.27, cachedInputPerMillion: 0.07, outputPerMillion: 1.1 },
};

const anthropicModel: AIModelOption = {
  id: 'claude-sonnet-4.6',
  apiModel: 'claude-sonnet-4-6',
  provider: 'anthropic',
  label: 'Claude Sonnet 4.6',
  description: 'Anthropic test model',
  pricing: { currency: 'USD', inputPerMillion: 3, cachedInputPerMillion: 0.3, outputPerMillion: 15 },
};

const createTestServer = async (gateway: CocoModelGateway, options: { bodyLimit?: string | number } = {}) => {
  const app = express();
  const defaultJsonParser = express.json();
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/coco/model-gateway')) {
      next();
      return;
    }
    defaultJsonParser(req, res, next);
  });
  registerCocoModelGatewayRoutes(app, gateway, undefined, options.bodyLimit);
  const server = await new Promise<HttpServer>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
};

describe('CocoModelGateway', () => {
  let server: Awaited<ReturnType<typeof createTestServer>> | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it('proxies OpenAI-compatible requests with provider credentials, not sandbox tokens', async () => {
    const calls: FetchCall[] = [];
    const gateway = new CocoModelGateway({
      publicBaseUrl: 'https://room.example/api/coco/model-gateway',
      tokenSecret: 'test-secret',
      providerApiKeys: { deepseek: 'deepseek-provider-key' },
      nowMs: () => 1_800_000_000_000,
      fetchFn: async (url, init) => {
        calls.push({ url: String(url), init: init || {} });
        return new Response(JSON.stringify({ id: 'completion-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-upstream': 'ok' },
        });
      },
    });
    const token = gateway.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'plan',
      model: deepseekModel,
    });
    server = await createTestServer(gateway);

    const response = await fetch(`${server.baseUrl}/api/coco/model-gateway/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64 }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: 'completion-1' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer deepseek-provider-key');
    assert.notEqual((calls[0].init.headers as Record<string, string>).authorization, `Bearer ${token}`);
  });

  it('accepts Coco gateway bodies larger than the default Express JSON limit', async () => {
    const calls: FetchCall[] = [];
    const gateway = new CocoModelGateway({
      publicBaseUrl: 'https://room.example/api/coco/model-gateway',
      tokenSecret: 'test-secret',
      providerApiKeys: { deepseek: 'deepseek-provider-key' },
      nowMs: () => 1_800_000_000_000,
      fetchFn: async (url, init) => {
        calls.push({ url: String(url), init: init || {} });
        return new Response(JSON.stringify({ id: 'large-completion' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const token = gateway.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-large',
      mode: 'plan',
      model: deepseekModel,
    });
    server = await createTestServer(gateway, { bodyLimit: '1mb' });

    const response = await fetch(`${server.baseUrl}/api/coco/model-gateway/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'x'.repeat(150_000) }],
        max_tokens: 64,
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: 'large-completion' });
    assert.equal(calls.length, 1);
  });

  it('rejects requests for a model outside the per-turn token scope', async () => {
    let upstreamCalled = false;
    const gateway = new CocoModelGateway({
      publicBaseUrl: 'https://room.example/api/coco/model-gateway',
      tokenSecret: 'test-secret',
      providerApiKeys: { deepseek: 'deepseek-provider-key' },
      nowMs: () => 1_800_000_000_000,
      fetchFn: async () => {
        upstreamCalled = true;
        return new Response('{}');
      },
    });
    const token = gateway.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'acceptEdits',
      model: deepseekModel,
    });
    server = await createTestServer(gateway);

    const response = await fetch(`${server.baseUrl}/api/coco/model-gateway/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'other-model', messages: [] }),
    });

    assert.equal(response.status, 403);
    assert.equal(upstreamCalled, false);
  });

  it('enforces per-turn request limits and actual usage budgets', async () => {
    const gateway = new CocoModelGateway({
      publicBaseUrl: 'https://room.example/api/coco/model-gateway',
      tokenSecret: 'test-secret',
      providerApiKeys: { deepseek: 'deepseek-provider-key' },
      maxRequestsPerTurn: 1,
      turnBudgetUsd: 10,
      nowMs: () => 1_800_000_000_000,
      stateStore: new InMemoryCocoModelGatewayTokenStateStore(() => 1_800_000_000_000),
      fetchFn: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    const token = gateway.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'plan',
      model: deepseekModel,
    });
    server = await createTestServer(gateway);

    const first = await fetch(`${server.baseUrl}/api/coco/model-gateway/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const second = await fetch(`${server.baseUrl}/api/coco/model-gateway/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 429);

    await server.close();
    server = null;

    let expensiveCalls = 0;
    const expensiveGateway = new CocoModelGateway({
      publicBaseUrl: 'https://room.example/api/coco/model-gateway',
      tokenSecret: 'test-secret',
      providerApiKeys: { deepseek: 'deepseek-provider-key' },
      turnBudgetUsd: 0.000001,
      nowMs: () => 1_800_000_000_000,
      fetchFn: async () => {
        expensiveCalls += 1;
        return new Response(JSON.stringify({
          id: 'completion-expensive',
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const budgetToken = expensiveGateway.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-2',
      mode: 'plan',
      model: deepseekModel,
    });
    server = await createTestServer(expensiveGateway);

    const firstBudgetResponse = await fetch(`${server.baseUrl}/api/coco/model-gateway/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${budgetToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hello' }], max_tokens: 4096 }),
    });
    const secondBudgetResponse = await fetch(`${server.baseUrl}/api/coco/model-gateway/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${budgetToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hello again' }], max_tokens: 4096 }),
    });

    assert.equal(firstBudgetResponse.status, 200);
    assert.deepEqual(await firstBudgetResponse.json(), {
      id: 'completion-expensive',
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    });
    assert.equal(secondBudgetResponse.status, 402);
    assert.equal(expensiveCalls, 1);
  });

  it('does not charge Coco gateway budget without reported usage', async () => {
    let calls = 0;
    const gateway = new CocoModelGateway({
      publicBaseUrl: 'https://room.example/api/coco/model-gateway',
      tokenSecret: 'test-secret',
      providerApiKeys: { deepseek: 'deepseek-provider-key' },
      turnBudgetUsd: 0.000001,
      nowMs: () => 1_800_000_000_000,
      fetchFn: async () => {
        calls += 1;
        return new Response(JSON.stringify({ id: `completion-${calls}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const token = gateway.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-no-usage',
      mode: 'plan',
      model: deepseekModel,
    });
    server = await createTestServer(gateway);

    const first = await fetch(`${server.baseUrl}/api/coco/model-gateway/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hello' }], max_tokens: 4096 }),
    });
    const second = await fetch(`${server.baseUrl}/api/coco/model-gateway/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hello again' }], max_tokens: 4096 }),
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(calls, 2);
  });

  it('records streaming usage before enforcing the next gateway budget check', async () => {
    let calls = 0;
    const encoder = new TextEncoder();
    const gateway = new CocoModelGateway({
      publicBaseUrl: 'https://room.example/api/coco/model-gateway',
      tokenSecret: 'test-secret',
      providerApiKeys: { deepseek: 'deepseek-provider-key' },
      turnBudgetUsd: 0.000001,
      nowMs: () => 1_800_000_000_000,
      fetchFn: async () => {
        calls += 1;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
            controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    const token = gateway.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-stream',
      mode: 'plan',
      model: deepseekModel,
    });
    server = await createTestServer(gateway);

    const first = await fetch(`${server.baseUrl}/api/coco/model-gateway/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hello' }], stream: true }),
    });
    const firstText = await first.text();
    const second = await fetch(`${server.baseUrl}/api/coco/model-gateway/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hello again' }], stream: true }),
    });

    assert.equal(first.status, 200);
    assert.match(firstText, /"usage"/);
    assert.equal(second.status, 402);
    assert.equal(calls, 1);
  });

  it('records Anthropic streaming usage split across SSE events', async () => {
    let calls = 0;
    const encoder = new TextEncoder();
    const gateway = new CocoModelGateway({
      publicBaseUrl: 'https://room.example/api/coco/model-gateway',
      tokenSecret: 'test-secret',
      providerApiKeys: { anthropic: 'anthropic-provider-key' },
      turnBudgetUsd: 0.000001,
      nowMs: () => 1_800_000_000_000,
      fetchFn: async () => {
        calls += 1;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('event: message_start\n'));
            controller.enqueue(encoder.encode('data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":5}}}\n\n'));
            controller.enqueue(encoder.encode('event: message_delta\n'));
            controller.enqueue(encoder.encode('data: {"type":"message_delta","usage":{"output_tokens":1}}\n\n'));
            controller.close();
          },
        }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    const token = gateway.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-anthropic-stream',
      mode: 'plan',
      model: anthropicModel,
    });
    server = await createTestServer(gateway);

    const first = await fetch(`${server.baseUrl}/api/coco/model-gateway/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': token, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64, stream: true }),
    });
    await first.text();
    const second = await fetch(`${server.baseUrl}/api/coco/model-gateway/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': token, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello again' }], max_tokens: 64, stream: true }),
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 402);
    assert.equal(calls, 1);
  });

  it('proxies Anthropic requests through x-api-key with scoped sandbox token auth', async () => {
    const calls: FetchCall[] = [];
    const gateway = new CocoModelGateway({
      publicBaseUrl: 'https://room.example/api/coco/model-gateway',
      tokenSecret: 'test-secret',
      providerApiKeys: { anthropic: 'anthropic-provider-key' },
      nowMs: () => 1_800_000_000_000,
      fetchFn: async (url, init) => {
        calls.push({ url: String(url), init: init || {} });
        return new Response(JSON.stringify({ id: 'message-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const token = gateway.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'acceptEdits',
      model: anthropicModel,
    });
    server = await createTestServer(gateway);

    const response = await fetch(`${server.baseUrl}/api/coco/model-gateway/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': token,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64 }),
    });

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal((calls[0].init.headers as Record<string, string>)['x-api-key'], 'anthropic-provider-key');
    assert.equal((calls[0].init.headers as Record<string, string>)['anthropic-version'], '2023-06-01');
  });

  it('accepts Anthropic SDK paths when the sandbox proxy base URL already includes v1', async () => {
    const calls: FetchCall[] = [];
    const gateway = new CocoModelGateway({
      publicBaseUrl: 'https://room.example/api/coco/model-gateway',
      tokenSecret: 'test-secret',
      providerApiKeys: { anthropic: 'anthropic-provider-key' },
      nowMs: () => 1_800_000_000_000,
      fetchFn: async (url, init) => {
        calls.push({ url: String(url), init: init || {} });
        return new Response(JSON.stringify({ id: 'message-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const token = gateway.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'plan',
      model: anthropicModel,
    });
    server = await createTestServer(gateway);

    const response = await fetch(`${server.baseUrl}/api/coco/model-gateway/v1/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': token,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64 }),
    });

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  });
});
