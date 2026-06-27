import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { Readable } from 'stream';
import { Express, Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { Logger } from '../logger';
import { AIModelOption, AIModelPricing, AIModelProvider } from '../types';
import { CocoRunnerMode } from './cocoRunnerProtocol';

export interface CocoModelGatewayIssueInput {
  roomId: string;
  clientId: string;
  turnId: string;
  mode: CocoRunnerMode;
  model: AIModelOption;
}

interface CocoModelGatewayTokenClaims {
  v: 1;
  jti: string;
  roomId: string;
  clientId: string;
  turnId: string;
  mode: CocoRunnerMode;
  provider: AIModelProvider;
  modelId: string;
  apiModel: string;
  exp: number;
  maxRequests: number;
  budgetUsd: number;
  pricing?: AIModelPricing;
}

export interface CocoModelGatewayConsumeResult {
  ok: boolean;
  error?: 'request_limit_exceeded' | 'budget_exceeded';
  requestCount?: number;
  estimatedCostUsd?: number;
}

export interface CocoModelGatewayTokenStateStore {
  consumeRequest(input: {
    tokenId: string;
    ttlSeconds: number;
    maxRequests: number;
    budgetUsd: number;
    estimatedCostUsd: number;
  }): Promise<CocoModelGatewayConsumeResult>;
}

export interface CocoModelGatewayOptions {
  publicBaseUrl: string;
  tokenSecret: string;
  providerApiKeys: Partial<Record<AIModelProvider, string>>;
  providerBaseUrls?: Partial<Record<AIModelProvider, string>>;
  tokenTtlSeconds?: number;
  maxRequestsPerTurn?: number;
  turnBudgetUsd?: number;
  fetchFn?: typeof fetch;
  nowMs?: () => number;
  stateStore?: CocoModelGatewayTokenStateStore;
  logger?: Logger;
}

const DEFAULT_TOKEN_TTL_SECONDS = 15 * 60;
const DEFAULT_MAX_REQUESTS_PER_TURN = 20;
const DEFAULT_TURN_BUDGET_USD = 2;

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

const parsePositiveInteger = (value: number | undefined, fallback: number) => (
  Number.isFinite(value) && value && value > 0 ? Math.floor(value) : fallback
);

const parsePositiveNumber = (value: number | undefined, fallback: number) => (
  Number.isFinite(value) && value && value > 0 ? value : fallback
);

const normalizeBaseUrl = (value: string) => value.replace(/\/+$/, '');

const joinUrlPath = (baseUrl: string, path: string) => `${normalizeBaseUrl(baseUrl)}/${path.replace(/^\/+/, '')}`;

const readBearerToken = (req: Request) => {
  const authorization = req.header('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]) {
    return match[1].trim();
  }

  const anthropicApiKey = req.header('x-api-key');
  return anthropicApiKey?.trim() || '';
};

const estimateTextTokens = (value: string) => {
  if (!value.trim()) return 0;
  return Math.max(1, Math.ceil(value.length / 4));
};

const estimateInputTokens = (body: unknown) => {
  if (!isRecord(body)) {
    return estimateTextTokens(stableJson(body) || '');
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) {
    return estimateTextTokens(stableJson(body) || '');
  }
  return estimateTextTokens(stableJson(messages) || '');
};

const estimateOutputTokens = (body: unknown) => {
  if (!isRecord(body)) {
    return 4096;
  }
  const maxTokens = body.max_tokens ?? body.max_completion_tokens;
  return typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0
    ? Math.ceil(maxTokens)
    : 4096;
};

export const estimateCocoModelGatewayRequestCostUsd = (body: unknown, pricing?: AIModelPricing) => {
  if (!pricing) {
    return 0;
  }
  const inputTokens = estimateInputTokens(body);
  const outputTokens = estimateOutputTokens(body);
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
};

export class InMemoryCocoModelGatewayTokenStateStore implements CocoModelGatewayTokenStateStore {
  private readonly usage = new Map<string, { requestCount: number; estimatedCostUsd: number; expiresAtMs: number }>();

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  async consumeRequest(input: {
    tokenId: string;
    ttlSeconds: number;
    maxRequests: number;
    budgetUsd: number;
    estimatedCostUsd: number;
  }): Promise<CocoModelGatewayConsumeResult> {
    const now = this.nowMs();
    const existing = this.usage.get(input.tokenId);
    const current = existing && existing.expiresAtMs > now
      ? existing
      : { requestCount: 0, estimatedCostUsd: 0, expiresAtMs: now + input.ttlSeconds * 1000 };

    const requestCount = current.requestCount + 1;
    const estimatedCostUsd = current.estimatedCostUsd + input.estimatedCostUsd;
    if (requestCount > input.maxRequests) {
      return { ok: false, error: 'request_limit_exceeded', requestCount: current.requestCount, estimatedCostUsd: current.estimatedCostUsd };
    }
    if (estimatedCostUsd > input.budgetUsd) {
      return { ok: false, error: 'budget_exceeded', requestCount: current.requestCount, estimatedCostUsd: current.estimatedCostUsd };
    }

    this.usage.set(input.tokenId, {
      requestCount,
      estimatedCostUsd,
      expiresAtMs: current.expiresAtMs,
    });
    return { ok: true, requestCount, estimatedCostUsd };
  }
}

export class RedisCocoModelGatewayTokenStateStore implements CocoModelGatewayTokenStateStore {
  constructor(private readonly redisClient: RedisClientType) {}

  async consumeRequest(input: {
    tokenId: string;
    ttlSeconds: number;
    maxRequests: number;
    budgetUsd: number;
    estimatedCostUsd: number;
  }): Promise<CocoModelGatewayConsumeResult> {
    const key = `coco:model-gateway-token:${input.tokenId}`;
    const estimatedMicroUsd = Math.ceil(input.estimatedCostUsd * 1_000_000);
    const budgetMicroUsd = Math.floor(input.budgetUsd * 1_000_000);
    const result = await (this.redisClient as any).eval(REDIS_CONSUME_REQUEST_SCRIPT, {
      keys: [key],
      arguments: [
        String(input.maxRequests),
        String(budgetMicroUsd),
        String(estimatedMicroUsd),
        String(input.ttlSeconds),
      ],
    }) as [number, string, number, number];
    const [ok, reason, requestCount, costMicroUsd] = result.map((item, index) => index === 1 ? String(item) : Number(item)) as [number, string, number, number];
    if (ok === 1) {
      return { ok: true, requestCount, estimatedCostUsd: costMicroUsd / 1_000_000 };
    }
    return {
      ok: false,
      error: reason === 'request_limit_exceeded' ? 'request_limit_exceeded' : 'budget_exceeded',
      requestCount,
      estimatedCostUsd: costMicroUsd / 1_000_000,
    };
  }
}

const REDIS_CONSUME_REQUEST_SCRIPT = `
local request_count = tonumber(redis.call('HGET', KEYS[1], 'requestCount') or '0')
local estimated_micro_usd = tonumber(redis.call('HGET', KEYS[1], 'estimatedMicroUsd') or '0')
local max_requests = tonumber(ARGV[1])
local budget_micro_usd = tonumber(ARGV[2])
local next_estimated_micro_usd = estimated_micro_usd + tonumber(ARGV[3])
local next_request_count = request_count + 1
if next_request_count > max_requests then
  return {0, 'request_limit_exceeded', request_count, estimated_micro_usd}
end
if next_estimated_micro_usd > budget_micro_usd then
  return {0, 'budget_exceeded', request_count, estimated_micro_usd}
end
redis.call('HSET', KEYS[1], 'requestCount', next_request_count, 'estimatedMicroUsd', next_estimated_micro_usd)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
return {1, 'ok', next_request_count, next_estimated_micro_usd}
`;

export class CocoModelGateway {
  readonly publicBaseUrl: string;
  private readonly tokenTtlSeconds: number;
  private readonly maxRequestsPerTurn: number;
  private readonly turnBudgetUsd: number;
  private readonly fetchFn: typeof fetch;
  private readonly nowMs: () => number;
  private readonly stateStore: CocoModelGatewayTokenStateStore;

  constructor(private readonly options: CocoModelGatewayOptions) {
    this.publicBaseUrl = normalizeBaseUrl(options.publicBaseUrl);
    this.tokenTtlSeconds = parsePositiveInteger(options.tokenTtlSeconds, DEFAULT_TOKEN_TTL_SECONDS);
    this.maxRequestsPerTurn = parsePositiveInteger(options.maxRequestsPerTurn, DEFAULT_MAX_REQUESTS_PER_TURN);
    this.turnBudgetUsd = parsePositiveNumber(options.turnBudgetUsd, DEFAULT_TURN_BUDGET_USD);
    this.fetchFn = options.fetchFn || fetch;
    this.nowMs = options.nowMs || (() => Date.now());
    this.stateStore = options.stateStore || new InMemoryCocoModelGatewayTokenStateStore(this.nowMs);
  }

  issueTurnToken(input: CocoModelGatewayIssueInput) {
    const claims: CocoModelGatewayTokenClaims = {
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
    const routePath = String(req.params[0] || '').replace(/^\/+/, '');
    const route = this.resolveRoute(routePath, req.method, claims);
    if (!route.ok) {
      return res.status(route.status).json({ error: route.error });
    }

    const validation = this.validateBody(req.body, routePath, claims);
    if (!validation.ok) {
      return res.status(validation.status).json({ error: validation.error });
    }

    const estimatedCostUsd = route.countsBudget
      ? estimateCocoModelGatewayRequestCostUsd(req.body, claims.pricing)
      : 0;
    const consumeResult = await this.stateStore.consumeRequest({
      tokenId: claims.jti,
      ttlSeconds: Math.max(1, claims.exp - Math.floor(this.nowMs() / 1000)),
      maxRequests: claims.maxRequests,
      budgetUsd: claims.budgetUsd,
      estimatedCostUsd,
    });
    if (!consumeResult.ok) {
      const status = consumeResult.error === 'budget_exceeded' ? 402 : 429;
      return res.status(status).json({ error: consumeResult.error });
    }

    const providerKey = this.options.providerApiKeys[claims.provider];
    if (!providerKey) {
      this.options.logger?.warn('Coco model gateway missing provider key', {
        provider: claims.provider,
        roomId: claims.roomId,
        turnId: claims.turnId,
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
      if (!upstream.body) {
        const text = await upstream.text().catch(() => '');
        return res.end(text);
      }
      return Readable.fromWeb(upstream.body as any).pipe(res);
    } catch (error) {
      this.options.logger?.error('Coco model gateway upstream request failed', {
        error,
        provider: claims.provider,
        roomId: claims.roomId,
        turnId: claims.turnId,
        path: routePath,
      });
      return res.status(502).json({ error: 'Model gateway upstream request failed' });
    }
  }

  private verifyToken(token: string): { ok: true; claims: CocoModelGatewayTokenClaims } | { ok: false; error: string } {
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

    let claims: CocoModelGatewayTokenClaims;
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
      !['plan', 'acceptEdits'].includes(claims.mode)
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
    claims: CocoModelGatewayTokenClaims
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
    claims: CocoModelGatewayTokenClaims
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
        headers['X-Title'] = 'RoomTalk Coco';
      }
    }
    return headers;
  }
}

export const registerCocoModelGatewayRoutes = (
  app: Express,
  gateway: CocoModelGateway,
  basePath = '/api/coco/model-gateway'
) => {
  app.all(`${basePath}/v1/*`, (req, res) => {
    void gateway.handle(req, res);
  });
};
