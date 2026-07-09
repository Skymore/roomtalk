import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import express, { Express, Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { Logger } from '../logger';
import { AIModelOption, AIModelPricing, AIModelProvider, AIUsage } from '../types';
import { CodeAgentRunnerMode } from './codeAgentRunnerProtocol';
import { normalizeCodeAgentMode } from './codeAgentModes';
import { ObservabilityEventInput, ObservabilityEventRecorder } from './observabilityEvents';

export interface CodeAgentModelGatewayIssueInput {
  roomId: string;
  clientId: string;
  turnId: string;
  mode: CodeAgentRunnerMode;
  model: AIModelOption;
}

interface CodeAgentModelGatewayTokenClaims {
  v: 1;
  jti: string;
  roomId: string;
  clientId: string;
  turnId: string;
  mode: CodeAgentRunnerMode;
  provider: AIModelProvider;
  modelId: string;
  apiModel: string;
  exp: number;
  maxRequests: number;
  budgetUsd: number;
  pricing?: AIModelPricing;
}

export interface CodeAgentModelGatewayConsumeResult {
  ok: boolean;
  error?: 'request_limit_exceeded' | 'budget_exceeded';
  requestCount?: number;
  actualCostUsd?: number;
}

export interface CodeAgentModelGatewayRecordUsageResult {
  actualCostUsd: number;
}

export interface CodeAgentModelGatewayTokenStateStore {
  consumeRequest(input: {
    tokenId: string;
    ttlSeconds: number;
    maxRequests: number;
    budgetUsd: number;
  }): Promise<CodeAgentModelGatewayConsumeResult>;
  recordActualCost(input: {
    tokenId: string;
    ttlSeconds: number;
    costUsd: number;
  }): Promise<CodeAgentModelGatewayRecordUsageResult>;
}

export interface CodeAgentModelGatewayOptions {
  publicBaseUrl: string;
  tokenSecret: string;
  providerApiKeys: Partial<Record<AIModelProvider, string>>;
  providerBaseUrls?: Partial<Record<AIModelProvider, string>>;
  tokenTtlSeconds?: number;
  maxRequestsPerTurn?: number;
  turnBudgetUsd?: number;
  fetchFn?: typeof fetch;
  nowMs?: () => number;
  stateStore?: CodeAgentModelGatewayTokenStateStore;
  logger?: Logger;
  observability?: ObservabilityEventRecorder;
}

const DEFAULT_TOKEN_TTL_SECONDS = 15 * 60;
const DEFAULT_MAX_REQUESTS_PER_TURN = 0;
const DEFAULT_TURN_BUDGET_USD = 2;
export const DEFAULT_CODE_AGENT_MODEL_GATEWAY_BASE_PATH = '/api/code-agent/model-gateway';
export const DEFAULT_CODE_AGENT_MODEL_GATEWAY_BODY_LIMIT = '2mb';

const DEFAULT_PROVIDER_BASE_URLS: Record<AIModelProvider, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const base64UrlEncode = (value: string | Buffer) => (
  typeof value === 'string' ? Buffer.from(value).toString('base64url') : value.toString('base64url')
);

const base64UrlDecode = (value: string) => Buffer.from(value, 'base64url').toString('utf8');

const stableJson = (value: unknown) => JSON.stringify(value);

const signPayload = (payload: string, secret: string) => (
  createHmac('sha256', secret).update(payload).digest('base64url')
);

const safeEqual = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const readFiniteNumber = (value: unknown) => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

const parsePositiveInteger = (value: number | undefined, fallback: number) => (
  Number.isFinite(value) && value && value > 0 ? Math.floor(value) : fallback
);

const parseNonNegativeInteger = (value: number | undefined, fallback: number) => (
  Number.isFinite(value) && value !== undefined && value >= 0 ? Math.floor(value) : fallback
);

const parsePositiveNumber = (value: number | undefined, fallback: number) => (
  Number.isFinite(value) && value && value > 0 ? value : fallback
);

const normalizeBaseUrl = (value: string) => value.replace(/\/+$/, '');

const joinUrlPath = (baseUrl: string, path: string) => `${normalizeBaseUrl(baseUrl)}/${path.replace(/^\/+/, '')}`;

const normalizeRoutePath = (value: string) => {
  const path = value.replace(/^\/+/, '');
  return path.startsWith('v1/') ? path.slice(3) : path;
};

const readBearerToken = (req: Request) => {
  const authorization = req.header('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]) {
    return match[1].trim();
  }

  const anthropicApiKey = req.header('x-api-key');
  return anthropicApiKey?.trim() || '';
};

const calculateReportedUsageCostUsd = (usage: AIUsage, pricing?: AIModelPricing) => {
  if (!pricing) {
    return 0;
  }
  const cachedPromptTokens = Math.min(usage.cachedPromptTokens || 0, usage.promptTokens);
  const uncachedPromptTokens = Math.max(usage.promptTokens - cachedPromptTokens, 0);
  const cachedInputPerMillion = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;
  return (
    (uncachedPromptTokens / 1_000_000) * pricing.inputPerMillion +
    (cachedPromptTokens / 1_000_000) * cachedInputPerMillion +
    (usage.completionTokens / 1_000_000) * pricing.outputPerMillion
  );
};

export class InMemoryCodeAgentModelGatewayTokenStateStore implements CodeAgentModelGatewayTokenStateStore {
  private readonly usage = new Map<string, { requestCount: number; actualCostUsd: number; expiresAtMs: number }>();

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  async consumeRequest(input: {
    tokenId: string;
    ttlSeconds: number;
    maxRequests: number;
    budgetUsd: number;
  }): Promise<CodeAgentModelGatewayConsumeResult> {
    const now = this.nowMs();
    const existing = this.usage.get(input.tokenId);
    const current = existing && existing.expiresAtMs > now
      ? existing
      : { requestCount: 0, actualCostUsd: 0, expiresAtMs: now + input.ttlSeconds * 1000 };

    const requestCount = current.requestCount + 1;
    if (current.actualCostUsd > input.budgetUsd) {
      return { ok: false, error: 'budget_exceeded', requestCount: current.requestCount, actualCostUsd: current.actualCostUsd };
    }
    if (input.maxRequests > 0 && requestCount > input.maxRequests) {
      return { ok: false, error: 'request_limit_exceeded', requestCount: current.requestCount, actualCostUsd: current.actualCostUsd };
    }

    this.usage.set(input.tokenId, {
      requestCount,
      actualCostUsd: current.actualCostUsd,
      expiresAtMs: current.expiresAtMs,
    });
    return { ok: true, requestCount, actualCostUsd: current.actualCostUsd };
  }

  async recordActualCost(input: {
    tokenId: string;
    ttlSeconds: number;
    costUsd: number;
  }): Promise<CodeAgentModelGatewayRecordUsageResult> {
    const now = this.nowMs();
    const existing = this.usage.get(input.tokenId);
    const current = existing && existing.expiresAtMs > now
      ? existing
      : { requestCount: 0, actualCostUsd: 0, expiresAtMs: now + input.ttlSeconds * 1000 };
    const actualCostUsd = current.actualCostUsd + Math.max(input.costUsd, 0);
    this.usage.set(input.tokenId, {
      requestCount: current.requestCount,
      actualCostUsd,
      expiresAtMs: current.expiresAtMs,
    });
    return { actualCostUsd };
  }
}

export class RedisCodeAgentModelGatewayTokenStateStore implements CodeAgentModelGatewayTokenStateStore {
  constructor(private readonly redisClient: RedisClientType) {}

  async consumeRequest(input: {
    tokenId: string;
    ttlSeconds: number;
    maxRequests: number;
    budgetUsd: number;
  }): Promise<CodeAgentModelGatewayConsumeResult> {
    const key = `code-agent:model-gateway-token:${input.tokenId}`;
    const budgetMicroUsd = Math.floor(input.budgetUsd * 1_000_000);
    const result = await (this.redisClient as any).eval(REDIS_CONSUME_REQUEST_SCRIPT, {
      keys: [key],
      arguments: [
        String(input.maxRequests),
        String(budgetMicroUsd),
        String(input.ttlSeconds),
      ],
    }) as [number, string, number, number];
    const [ok, reason, requestCount, costMicroUsd] = result.map((item, index) => index === 1 ? String(item) : Number(item)) as [number, string, number, number];
    if (ok === 1) {
      return { ok: true, requestCount, actualCostUsd: costMicroUsd / 1_000_000 };
    }
    return {
      ok: false,
      error: reason === 'request_limit_exceeded' ? 'request_limit_exceeded' : 'budget_exceeded',
      requestCount,
      actualCostUsd: costMicroUsd / 1_000_000,
    };
  }

  async recordActualCost(input: {
    tokenId: string;
    ttlSeconds: number;
    costUsd: number;
  }): Promise<CodeAgentModelGatewayRecordUsageResult> {
    const key = `code-agent:model-gateway-token:${input.tokenId}`;
    const costMicroUsd = Math.ceil(Math.max(input.costUsd, 0) * 1_000_000);
    const result = await (this.redisClient as any).eval(REDIS_RECORD_ACTUAL_COST_SCRIPT, {
      keys: [key],
      arguments: [
        String(costMicroUsd),
        String(input.ttlSeconds),
      ],
    }) as number;
    return { actualCostUsd: Number(result) / 1_000_000 };
  }
}

const REDIS_CONSUME_REQUEST_SCRIPT = `
local request_count = tonumber(redis.call('HGET', KEYS[1], 'requestCount') or '0')
local actual_micro_usd = tonumber(redis.call('HGET', KEYS[1], 'actualMicroUsd') or '0')
local max_requests = tonumber(ARGV[1])
local budget_micro_usd = tonumber(ARGV[2])
local next_request_count = request_count + 1
if actual_micro_usd > budget_micro_usd then
  return {0, 'budget_exceeded', request_count, actual_micro_usd}
end
if max_requests > 0 and next_request_count > max_requests then
  return {0, 'request_limit_exceeded', request_count, actual_micro_usd}
end
redis.call('HSET', KEYS[1], 'requestCount', next_request_count, 'actualMicroUsd', actual_micro_usd)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return {1, 'ok', next_request_count, actual_micro_usd}
`;

const REDIS_RECORD_ACTUAL_COST_SCRIPT = `
local actual_micro_usd = tonumber(redis.call('HGET', KEYS[1], 'actualMicroUsd') or '0') + tonumber(ARGV[1])
redis.call('HSET', KEYS[1], 'actualMicroUsd', actual_micro_usd)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return actual_micro_usd
`;

interface ReportedUsageAccumulator {
  anthropic: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
  openAICompatible: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cachedPromptTokens?: number;
  };
}

interface SseUsageParserState {
  buffer: string;
}

const createReportedUsageAccumulator = (): ReportedUsageAccumulator => ({
  anthropic: {},
  openAICompatible: {},
});

const mergeMaxNumber = (current: number | undefined, next: unknown) => {
  const value = readFiniteNumber(next);
  if (value === undefined) {
    return current;
  }
  return Math.max(current ?? 0, value);
};

const addReportedUsageFragment = (accumulator: ReportedUsageAccumulator, usage: unknown) => {
  if (!isRecord(usage)) {
    return;
  }

  const inputTokens = readFiniteNumber(usage.input_tokens);
  const outputTokens = readFiniteNumber(usage.output_tokens);
  const cacheReadInputTokens = readFiniteNumber(usage.cache_read_input_tokens);
  const cacheCreationInputTokens = readFiniteNumber(usage.cache_creation_input_tokens);
  if (
    inputTokens !== undefined ||
    outputTokens !== undefined ||
    cacheReadInputTokens !== undefined ||
    cacheCreationInputTokens !== undefined
  ) {
    accumulator.anthropic.inputTokens = mergeMaxNumber(accumulator.anthropic.inputTokens, inputTokens);
    accumulator.anthropic.outputTokens = mergeMaxNumber(accumulator.anthropic.outputTokens, outputTokens);
    accumulator.anthropic.cacheReadInputTokens = mergeMaxNumber(accumulator.anthropic.cacheReadInputTokens, cacheReadInputTokens);
    accumulator.anthropic.cacheCreationInputTokens = mergeMaxNumber(accumulator.anthropic.cacheCreationInputTokens, cacheCreationInputTokens);
  }

  const promptTokens = readFiniteNumber(usage.prompt_tokens);
  const completionTokens = readFiniteNumber(usage.completion_tokens);
  const totalTokens = readFiniteNumber(usage.total_tokens);
  const promptTokenDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
  const cachedPromptTokens = readFiniteNumber(usage.prompt_cache_hit_tokens)
    ?? readFiniteNumber(promptTokenDetails?.cached_tokens);
  if (
    promptTokens !== undefined ||
    completionTokens !== undefined ||
    totalTokens !== undefined ||
    cachedPromptTokens !== undefined
  ) {
    accumulator.openAICompatible.promptTokens = mergeMaxNumber(accumulator.openAICompatible.promptTokens, promptTokens);
    accumulator.openAICompatible.completionTokens = mergeMaxNumber(accumulator.openAICompatible.completionTokens, completionTokens);
    accumulator.openAICompatible.totalTokens = mergeMaxNumber(accumulator.openAICompatible.totalTokens, totalTokens);
    accumulator.openAICompatible.cachedPromptTokens = mergeMaxNumber(accumulator.openAICompatible.cachedPromptTokens, cachedPromptTokens);
  }
};

const addReportedUsageFromPayload = (accumulator: ReportedUsageAccumulator, payload: unknown) => {
  if (!isRecord(payload)) {
    return;
  }
  addReportedUsageFragment(accumulator, payload.usage);
  if (isRecord(payload.message)) {
    addReportedUsageFragment(accumulator, payload.message.usage);
  }
};

const readUsageFromAccumulator = (accumulator: ReportedUsageAccumulator): AIUsage | undefined => {
  const openAIUsage = accumulator.openAICompatible;
  if (openAIUsage.promptTokens !== undefined && openAIUsage.completionTokens !== undefined) {
    const totalTokens = openAIUsage.totalTokens ?? openAIUsage.promptTokens + openAIUsage.completionTokens;
    const cachedPromptTokens = openAIUsage.cachedPromptTokens;
    const cacheHitRate = cachedPromptTokens !== undefined && openAIUsage.promptTokens > 0
      ? Math.min(Math.max(cachedPromptTokens / openAIUsage.promptTokens, 0), 1)
      : undefined;
    return {
      promptTokens: openAIUsage.promptTokens,
      completionTokens: openAIUsage.completionTokens,
      totalTokens,
      cachedPromptTokens,
      cacheHitRate,
      source: 'reported',
    };
  }

  const anthropicUsage = accumulator.anthropic;
  if (anthropicUsage.inputTokens !== undefined && anthropicUsage.outputTokens !== undefined) {
    const cacheReadInputTokens = anthropicUsage.cacheReadInputTokens ?? 0;
    const cacheCreationInputTokens = anthropicUsage.cacheCreationInputTokens ?? 0;
    const promptTokens = anthropicUsage.inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
    const cacheHitRate = promptTokens > 0
      ? Math.min(Math.max(cacheReadInputTokens / promptTokens, 0), 1)
      : undefined;
    return {
      promptTokens,
      completionTokens: anthropicUsage.outputTokens,
      totalTokens: promptTokens + anthropicUsage.outputTokens,
      cachedPromptTokens: cacheReadInputTokens,
      cacheHitRate,
      source: 'reported',
    };
  }

  return undefined;
};

const appendSseTextToUsage = (
  accumulator: ReportedUsageAccumulator,
  state: SseUsageParserState,
  text: string
) => {
  state.buffer += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  let eventBoundary = state.buffer.indexOf('\n\n');
  while (eventBoundary >= 0) {
    const rawEvent = state.buffer.slice(0, eventBoundary);
    state.buffer = state.buffer.slice(eventBoundary + 2);
    eventBoundary = state.buffer.indexOf('\n\n');

    const data = rawEvent
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data || data === '[DONE]') {
      continue;
    }

    try {
      addReportedUsageFromPayload(accumulator, JSON.parse(data));
    } catch {
      // Ignore malformed SSE payloads; the upstream response is still proxied unchanged.
    }
  }
};

const addJsonTextUsage = (accumulator: ReportedUsageAccumulator, text: string) => {
  if (!text.trim()) {
    return;
  }
  try {
    addReportedUsageFromPayload(accumulator, JSON.parse(text));
  } catch {
    // Ignore non-JSON bodies.
  }
};

export class CodeAgentModelGateway {
  readonly publicBaseUrl: string;
  private readonly tokenTtlSeconds: number;
  private readonly maxRequestsPerTurn: number;
  private readonly turnBudgetUsd: number;
  private readonly fetchFn: typeof fetch;
  private readonly nowMs: () => number;
  private readonly stateStore: CodeAgentModelGatewayTokenStateStore;

  constructor(private readonly options: CodeAgentModelGatewayOptions) {
    this.publicBaseUrl = normalizeBaseUrl(options.publicBaseUrl);
    this.tokenTtlSeconds = parsePositiveInteger(options.tokenTtlSeconds, DEFAULT_TOKEN_TTL_SECONDS);
    this.maxRequestsPerTurn = parseNonNegativeInteger(options.maxRequestsPerTurn, DEFAULT_MAX_REQUESTS_PER_TURN);
    this.turnBudgetUsd = parsePositiveNumber(options.turnBudgetUsd, DEFAULT_TURN_BUDGET_USD);
    this.fetchFn = options.fetchFn || fetch;
    this.nowMs = options.nowMs || (() => Date.now());
    this.stateStore = options.stateStore || new InMemoryCodeAgentModelGatewayTokenStateStore(this.nowMs);
  }

  issueTurnToken(input: CodeAgentModelGatewayIssueInput) {
    const claims: CodeAgentModelGatewayTokenClaims = {
      v: 1,
      jti: randomUUID(),
      roomId: input.roomId,
      clientId: input.clientId,
      turnId: input.turnId,
      mode: input.mode,
      provider: input.model.provider,
      modelId: input.model.id,
      apiModel: input.model.apiModel,
      exp: Math.floor(this.nowMs() / 1000) + this.tokenTtlSeconds,
      maxRequests: this.maxRequestsPerTurn,
      budgetUsd: this.turnBudgetUsd,
      pricing: input.model.pricing,
    };
    const payload = base64UrlEncode(stableJson(claims));
    return `${payload}.${signPayload(payload, this.options.tokenSecret)}`;
  }

  async handle(req: Request, res: Response) {
    const token = readBearerToken(req);
    const verification = this.verifyToken(token);
    if (!verification.ok) {
      return res.status(401).json({ error: verification.error });
    }

    const claims = verification.claims;
    const routePath = normalizeRoutePath(String(req.params[0] || ''));
    const route = this.resolveRoute(routePath, req.method, claims);
    if (!route.ok) {
      return res.status(route.status).json({ error: route.error });
    }

    const validation = this.validateBody(req.body, routePath, claims);
    if (!validation.ok) {
      return res.status(validation.status).json({ error: validation.error });
    }

    const consumeResult = await this.stateStore.consumeRequest({
      tokenId: claims.jti,
      ttlSeconds: this.ttlSecondsForClaims(claims),
      maxRequests: claims.maxRequests,
      budgetUsd: claims.budgetUsd,
    });
    if (!consumeResult.ok) {
      const status = consumeResult.error === 'budget_exceeded' ? 402 : 429;
      this.options.logger?.warn('Code agent model gateway request rejected', {
        reason: consumeResult.error,
        provider: claims.provider,
        modelId: claims.modelId,
        roomId: claims.roomId,
        turnId: claims.turnId,
        requestCount: consumeResult.requestCount,
        actualCostUsd: consumeResult.actualCostUsd,
        budgetUsd: claims.budgetUsd,
      });
      await this.recordObservabilityEvent(claims, {
        level: 'warn',
        event: 'code_agent.model_gateway.rejected',
        errorCode: consumeResult.error,
        payload: {
          path: routePath,
          method: req.method,
          statusCode: status,
          requestCount: consumeResult.requestCount,
          actualCostUsd: consumeResult.actualCostUsd,
          budgetUsd: claims.budgetUsd,
        },
      });
      return res.status(status).json({ error: consumeResult.error });
    }

    await this.recordObservabilityEvent(claims, {
      level: 'info',
      event: 'code_agent.model_gateway.request',
      payload: {
        path: routePath,
        method: req.method,
        countsBudget: route.countsBudget,
        requestCount: consumeResult.requestCount,
        actualCostUsd: consumeResult.actualCostUsd,
        budgetUsd: claims.budgetUsd,
      },
    });

    const providerKey = this.options.providerApiKeys[claims.provider];
    if (!providerKey) {
      this.options.logger?.warn('Code agent model gateway missing provider key', {
        provider: claims.provider,
        roomId: claims.roomId,
        turnId: claims.turnId,
      });
      await this.recordObservabilityEvent(claims, {
        level: 'error',
        event: 'code_agent.model_gateway.provider_missing',
        errorCode: 'provider_not_configured',
        errorMessage: 'Provider is not configured',
        payload: { path: routePath, method: req.method },
      });
      return res.status(502).json({ error: 'Provider is not configured' });
    }

    try {
      const upstream = await this.fetchFn(route.url, {
        method: req.method,
        headers: this.buildUpstreamHeaders(req, claims.provider, providerKey),
        body: req.method === 'GET' ? undefined : stableJson(req.body ?? {}),
      });
      res.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        if (!HOP_BY_HOP_RESPONSE_HEADERS.has(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });
      const contentType = upstream.headers.get('content-type') || '';
      if (!upstream.body) {
        const text = await upstream.text().catch(() => '');
        await this.recordUsageFromText(text, contentType, route.countsBudget, claims, upstream.status);
        return res.end(text);
      }
      if (contentType.toLowerCase().includes('text/event-stream')) {
        return this.proxySseResponse(upstream.body as ReadableStream<Uint8Array>, res, route.countsBudget, claims, upstream.status);
      }

      const text = await upstream.text();
      await this.recordUsageFromText(text, contentType, route.countsBudget, claims, upstream.status);
      return res.end(text);
    } catch (error) {
      this.options.logger?.error('Code agent model gateway upstream request failed', {
        error,
        provider: claims.provider,
        roomId: claims.roomId,
        turnId: claims.turnId,
        path: routePath,
      });
      await this.recordObservabilityEvent(claims, {
        level: 'error',
        event: 'code_agent.model_gateway.upstream_error',
        errorCode: 'upstream_request_failed',
        errorMessage: error instanceof Error ? error.message : String(error),
        payload: { path: routePath, method: req.method },
      });
      return res.status(502).json({ error: 'Model gateway upstream request failed' });
    }
  }

  private async recordObservabilityEvent(
    claims: CodeAgentModelGatewayTokenClaims,
    event: Omit<ObservabilityEventInput, 'roomId' | 'turnId' | 'clientId' | 'provider' | 'model'>
  ) {
    if (!this.options.observability) {
      return;
    }
    await this.options.observability.recordEvent({
      ...event,
      roomId: claims.roomId,
      turnId: claims.turnId,
      clientId: claims.clientId,
      provider: claims.provider,
      model: claims.modelId,
    }).catch(error => {
      this.options.logger?.error('Failed to record Code Agent model gateway observability event', {
        error,
        event: event.event,
        roomId: claims.roomId,
        turnId: claims.turnId,
      });
    });
  }

  private ttlSecondsForClaims(claims: CodeAgentModelGatewayTokenClaims) {
    return Math.max(1, claims.exp - Math.floor(this.nowMs() / 1000));
  }

  private async proxySseResponse(
    body: ReadableStream<Uint8Array>,
    res: Response,
    countsBudget: boolean,
    claims: CodeAgentModelGatewayTokenClaims,
    statusCode: number
  ) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const accumulator = createReportedUsageAccumulator();
    const sseState: SseUsageParserState = { buffer: '' };

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        if (!value) {
          continue;
        }
        if (countsBudget) {
          appendSseTextToUsage(accumulator, sseState, decoder.decode(value, { stream: true }));
        }
        res.write(Buffer.from(value));
      }

      if (countsBudget) {
        appendSseTextToUsage(accumulator, sseState, decoder.decode());
        if (sseState.buffer.trim()) {
          appendSseTextToUsage(accumulator, sseState, '\n\n');
        }
        await this.recordUsageAccumulator(accumulator, claims, statusCode);
      }
      return res.end();
    } catch (error) {
      this.options.logger?.error('Code agent model gateway streaming response failed', {
        error,
        provider: claims.provider,
        roomId: claims.roomId,
        turnId: claims.turnId,
      });
      if (res.headersSent) {
        return res.destroy(error instanceof Error ? error : undefined);
      }
      return res.status(502).json({ error: 'Model gateway streaming response failed' });
    }
  }

  private async recordUsageFromText(
    text: string,
    contentType: string,
    countsBudget: boolean,
    claims: CodeAgentModelGatewayTokenClaims,
    statusCode: number
  ) {
    if (!countsBudget) {
      return;
    }

    const accumulator = createReportedUsageAccumulator();
    if (contentType.toLowerCase().includes('text/event-stream')) {
      const sseState: SseUsageParserState = { buffer: '' };
      appendSseTextToUsage(accumulator, sseState, text);
      if (sseState.buffer.trim()) {
        appendSseTextToUsage(accumulator, sseState, '\n\n');
      }
    } else {
      addJsonTextUsage(accumulator, text);
    }
    await this.recordUsageAccumulator(accumulator, claims, statusCode);
  }

  private async recordUsageAccumulator(
    accumulator: ReportedUsageAccumulator,
    claims: CodeAgentModelGatewayTokenClaims,
    statusCode: number
  ) {
    const usage = readUsageFromAccumulator(accumulator);
    if (!usage) {
      if (statusCode < 400) {
        this.options.logger?.warn('Code agent model gateway response did not include reported usage', {
          provider: claims.provider,
          modelId: claims.modelId,
          roomId: claims.roomId,
          turnId: claims.turnId,
        });
        await this.recordObservabilityEvent(claims, {
          level: 'warn',
          event: 'code_agent.model_gateway.missing_usage',
          errorCode: 'missing_usage',
          payload: { statusCode },
        });
      }
      return;
    }

    const costUsd = calculateReportedUsageCostUsd(usage, claims.pricing);
    if (!(costUsd > 0)) {
      return;
    }

    try {
      const result = await this.stateStore.recordActualCost({
        tokenId: claims.jti,
        ttlSeconds: this.ttlSecondsForClaims(claims),
        costUsd,
      });
      await this.recordObservabilityEvent(claims, {
        level: 'info',
        event: 'code_agent.model_gateway.settled',
        costUsd,
        payload: {
          statusCode,
          requestCostUsd: costUsd,
          actualCostUsd: result.actualCostUsd,
          budgetUsd: claims.budgetUsd,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          cachedPromptTokens: usage.cachedPromptTokens,
          cacheHitRate: usage.cacheHitRate,
        },
      });
      if (result.actualCostUsd > claims.budgetUsd) {
        this.options.logger?.warn('Code agent model gateway actual budget exceeded', {
          provider: claims.provider,
          modelId: claims.modelId,
          roomId: claims.roomId,
          turnId: claims.turnId,
          requestCostUsd: costUsd,
          actualCostUsd: result.actualCostUsd,
          budgetUsd: claims.budgetUsd,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          cachedPromptTokens: usage.cachedPromptTokens,
        });
        await this.recordObservabilityEvent(claims, {
          level: 'warn',
          event: 'code_agent.model_gateway.budget_exceeded',
          costUsd,
          errorCode: 'budget_exceeded',
          payload: {
            statusCode,
            requestCostUsd: costUsd,
            actualCostUsd: result.actualCostUsd,
            budgetUsd: claims.budgetUsd,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            cachedPromptTokens: usage.cachedPromptTokens,
          },
        });
      }
    } catch (error) {
      this.options.logger?.error('Code agent model gateway failed to record reported usage', {
        error,
        provider: claims.provider,
        roomId: claims.roomId,
        turnId: claims.turnId,
      });
    }
  }

  private verifyToken(token: string): { ok: true; claims: CodeAgentModelGatewayTokenClaims } | { ok: false; error: string } {
    if (!token) {
      return { ok: false, error: 'Missing model gateway token' };
    }
    const [payload, signature] = token.split('.');
    if (!payload || !signature) {
      return { ok: false, error: 'Invalid model gateway token' };
    }
    const expected = signPayload(payload, this.options.tokenSecret);
    if (!safeEqual(signature, expected)) {
      return { ok: false, error: 'Invalid model gateway token' };
    }

    let claims: CodeAgentModelGatewayTokenClaims;
    try {
      claims = JSON.parse(base64UrlDecode(payload));
    } catch {
      return { ok: false, error: 'Invalid model gateway token' };
    }
    if (
      claims.v !== 1 ||
      !claims.jti ||
      !claims.roomId ||
      !claims.clientId ||
      !claims.turnId ||
      !claims.apiModel ||
      !['anthropic', 'deepseek', 'openai', 'openrouter'].includes(claims.provider) ||
      !normalizeCodeAgentMode(claims.mode)
    ) {
      return { ok: false, error: 'Invalid model gateway token' };
    }
    if (claims.exp <= Math.floor(this.nowMs() / 1000)) {
      return { ok: false, error: 'Expired model gateway token' };
    }
    return { ok: true, claims };
  }

  private resolveRoute(
    path: string,
    method: string,
    claims: CodeAgentModelGatewayTokenClaims
  ): { ok: true; url: string; countsBudget: boolean } | { ok: false; status: number; error: string } {
    if (path === 'models') {
      if (method !== 'GET') {
        return { ok: false, status: 405, error: 'Unsupported model gateway method' };
      }
      return { ok: true, url: joinUrlPath(this.providerBaseUrl(claims.provider), 'models'), countsBudget: false };
    }

    if (path === 'chat/completions') {
      if (method !== 'POST') {
        return { ok: false, status: 405, error: 'Unsupported model gateway method' };
      }
      if (claims.provider === 'anthropic') {
        return { ok: false, status: 403, error: 'Provider cannot use this endpoint' };
      }
      return { ok: true, url: joinUrlPath(this.providerBaseUrl(claims.provider), 'chat/completions'), countsBudget: true };
    }

    if (path === 'messages') {
      if (method !== 'POST') {
        return { ok: false, status: 405, error: 'Unsupported model gateway method' };
      }
      if (claims.provider !== 'anthropic') {
        return { ok: false, status: 403, error: 'Provider cannot use this endpoint' };
      }
      return { ok: true, url: joinUrlPath(this.providerBaseUrl(claims.provider), 'messages'), countsBudget: true };
    }

    return { ok: false, status: 404, error: 'Unsupported model gateway endpoint' };
  }

  private validateBody(
    body: unknown,
    path: string,
    claims: CodeAgentModelGatewayTokenClaims
  ): { ok: true } | { ok: false; status: number; error: string } {
    if (path === 'models') {
      return { ok: true };
    }
    if (!isRecord(body)) {
      return { ok: false, status: 400, error: 'Model gateway request body must be an object' };
    }
    if (body.model !== claims.apiModel) {
      return { ok: false, status: 403, error: 'Model gateway token is scoped to a different model' };
    }
    return { ok: true };
  }

  private providerBaseUrl(provider: AIModelProvider) {
    return normalizeBaseUrl(this.options.providerBaseUrls?.[provider] || DEFAULT_PROVIDER_BASE_URLS[provider]);
  }

  private buildUpstreamHeaders(req: Request, provider: AIModelProvider, providerKey: string): HeadersInit {
    const headers: Record<string, string> = {
      accept: req.header('accept') || 'application/json',
      'content-type': 'application/json',
    };
    if (provider === 'anthropic') {
      headers['x-api-key'] = providerKey;
      headers['anthropic-version'] = req.header('anthropic-version') || '2023-06-01';
      const anthropicBeta = req.header('anthropic-beta');
      if (anthropicBeta) {
        headers['anthropic-beta'] = anthropicBeta;
      }
    } else {
      headers.authorization = `Bearer ${providerKey}`;
      if (provider === 'openrouter') {
        headers['HTTP-Referer'] = req.header('HTTP-Referer') || req.header('Referer') || 'https://room.ruit.me';
        headers['X-Title'] = 'RoomTalk Coco Agent';
      }
    }
    return headers;
  }
}

export const registerCodeAgentModelGatewayRoutes = (
  app: Express,
  gateway: CodeAgentModelGateway,
  basePath = DEFAULT_CODE_AGENT_MODEL_GATEWAY_BASE_PATH,
  bodyLimit: string | number = DEFAULT_CODE_AGENT_MODEL_GATEWAY_BODY_LIMIT
) => {
  app.use(`${basePath}/v1`, express.json({ limit: bodyLimit }));
  app.all(`${basePath}/v1/*`, (req, res) => {
    void gateway.handle(req, res);
  });
};
