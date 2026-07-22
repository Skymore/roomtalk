import type { AIModelOption, AIModelProvider, Message } from '../types';
import type { AssistantRunRequestPayloadV1, AssistantRunTerminalPayloadV1 } from './store';

const MESSAGE_TYPES = new Set<Message['messageType']>([
  'text',
  'ai',
  'media',
  'sticker',
  'tool_call',
  'tool_result',
  'sandbox_status',
]);
const AI_MODEL_PROVIDERS = new Set<AIModelProvider>([
  'openai',
  'openrouter',
  'deepseek',
  'anthropic',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const hasOnlyKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const keys = new Set([...required, ...optional]);
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every(key => keys.has(key));
};

const isNonNegativeFinite = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0
);

const isNonNegativeInteger = (value: unknown): value is number => (
  Number.isSafeInteger(value) && Number(value) >= 0
);

const hasValidUsageAndCost = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  const message = value;
  const hasUsage = message.usage !== undefined;
  const hasCost = message.cost !== undefined;
  if (!hasUsage) return !hasCost;
  if (!isRecord(message.usage)) return false;

  const usage = message.usage;
  if (
    !hasOnlyKeys(
      usage,
      ['promptTokens', 'completionTokens', 'totalTokens', 'source'],
      ['cachedPromptTokens', 'cacheHitRate', 'modelContextWindow'],
    )
    || !isNonNegativeInteger(usage.promptTokens)
    || !isNonNegativeInteger(usage.completionTokens)
    || !isNonNegativeInteger(usage.totalTokens)
    || usage.totalTokens !== usage.promptTokens + usage.completionTokens
    || (usage.source !== 'reported' && usage.source !== 'estimated')
    || (usage.cachedPromptTokens !== undefined && (
      !isNonNegativeInteger(usage.cachedPromptTokens)
      || usage.cachedPromptTokens > usage.promptTokens
    ))
    || (usage.cacheHitRate !== undefined && (
      !isNonNegativeFinite(usage.cacheHitRate)
      || usage.cacheHitRate > 1
    ))
    || (usage.modelContextWindow !== undefined && !isNonNegativeInteger(usage.modelContextWindow))
  ) return false;

  if (!hasCost) return true;
  if (!isRecord(message.cost)) return false;
  const cost = message.cost;
  if (
    !hasOnlyKeys(
      cost,
      ['currency', 'inputUsd', 'outputUsd', 'totalUsd', 'inputPerMillion', 'outputPerMillion', 'estimated'],
      ['cachedInputPerMillion'],
    )
    || cost.currency !== 'USD'
    || !isNonNegativeFinite(cost.inputUsd)
    || !isNonNegativeFinite(cost.outputUsd)
    || !isNonNegativeFinite(cost.totalUsd)
    || Math.abs(cost.totalUsd - (cost.inputUsd + cost.outputUsd)) > 1e-9
    || !isNonNegativeFinite(cost.inputPerMillion)
    || !isNonNegativeFinite(cost.outputPerMillion)
    || (cost.cachedInputPerMillion !== undefined && !isNonNegativeFinite(cost.cachedInputPerMillion))
    || typeof cost.estimated !== 'boolean'
  ) return false;
  return true;
};

const isAIModelSnapshot = (
  value: unknown,
  expected: { modelId: string; apiModel: string; provider: AIModelProvider },
): value is AIModelOption => {
  if (
    !isRecord(value)
    || !hasOnlyKeys(
      value,
      ['id', 'apiModel', 'provider', 'label', 'description'],
      ['pricing', 'isPremium', 'isDefault'],
    )
    || typeof value.id !== 'string'
    || value.id.length === 0
    || typeof value.apiModel !== 'string'
    || value.apiModel.length === 0
    || typeof value.provider !== 'string'
    || !AI_MODEL_PROVIDERS.has(value.provider as AIModelProvider)
    || value.id !== expected.modelId
    || value.apiModel !== expected.apiModel
    || value.provider !== expected.provider
    || typeof value.label !== 'string'
    || typeof value.description !== 'string'
    || (value.isPremium !== undefined && typeof value.isPremium !== 'boolean')
    || (value.isDefault !== undefined && typeof value.isDefault !== 'boolean')
  ) return false;

  if (value.pricing === undefined) return true;
  if (
    !isRecord(value.pricing)
    || !hasOnlyKeys(
      value.pricing,
      ['currency', 'inputPerMillion', 'outputPerMillion'],
      ['cachedInputPerMillion'],
    )
    || value.pricing.currency !== 'USD'
    || !isNonNegativeFinite(value.pricing.inputPerMillion)
    || !isNonNegativeFinite(value.pricing.outputPerMillion)
    || (value.pricing.cachedInputPerMillion !== undefined
      && !isNonNegativeFinite(value.pricing.cachedInputPerMillion))
  ) return false;
  return true;
};

const isMessageSnapshot = (value: unknown, roomId: string): value is Message => {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== 'string'
    || typeof value.clientId !== 'string'
    || typeof value.content !== 'string'
    || value.roomId !== roomId
    || typeof value.timestamp !== 'string'
    || typeof value.messageType !== 'string'
    || !MESSAGE_TYPES.has(value.messageType as Message['messageType'])
  ) {
    return false;
  }
  return value.status === undefined
    || value.status === 'streaming'
    || value.status === 'complete'
    || value.status === 'error';
};

const matchesModelAccounting = (message: Message, model: AIModelOption): boolean => {
  if (
    !message.aiModel
    || message.aiModel.id !== model.id
    || message.aiModel.apiModel !== model.apiModel
    || message.aiModel.provider !== model.provider
    || message.aiModel.label !== model.label
    || message.aiModel.isPremium !== model.isPremium
  ) return false;

  if (!message.usage) return message.cost === undefined;
  if (!model.pricing) return message.cost === undefined;
  if (!message.cost) return false;
  const cost = message.cost;
  const pricing = model.pricing;
  if (
    cost.currency !== pricing.currency
    || cost.inputPerMillion !== pricing.inputPerMillion
    || cost.outputPerMillion !== pricing.outputPerMillion
    || cost.cachedInputPerMillion !== pricing.cachedInputPerMillion
    || cost.estimated !== (message.usage.source === 'estimated')
  ) return false;

  const cachedPromptTokens = Math.min(
    message.usage.cachedPromptTokens || 0,
    message.usage.promptTokens,
  );
  const uncachedPromptTokens = Math.max(message.usage.promptTokens - cachedPromptTokens, 0);
  const expectedInput = (
    (uncachedPromptTokens / 1_000_000) * pricing.inputPerMillion
    + (cachedPromptTokens / 1_000_000) * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion)
  );
  const expectedOutput = (message.usage.completionTokens / 1_000_000) * pricing.outputPerMillion;
  return Math.abs(cost.inputUsd - expectedInput) <= 1e-9
    && Math.abs(cost.outputUsd - expectedOutput) <= 1e-9
    && Math.abs(cost.totalUsd - (expectedInput + expectedOutput)) <= 1e-9;
};

export const decodeAssistantRunRequestPayload = (
  value: unknown,
  expected: {
    roomId: string;
    modelId: string;
    apiModel: string;
    provider: AIModelProvider;
  },
): AssistantRunRequestPayloadV1 | null => {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['schemaVersion', 'model', 'roleName', 'systemPrompt', 'contextMessages'])
    || value.schemaVersion !== 1
    || !isAIModelSnapshot(value.model, expected)
    || typeof value.roleName !== 'string'
    || value.roleName.length === 0
    || typeof value.systemPrompt !== 'string'
    || !Array.isArray(value.contextMessages)
  ) {
    return null;
  }
  if (!value.contextMessages.every(message => isMessageSnapshot(message, expected.roomId))) {
    return null;
  }
  const messageIds = value.contextMessages.map(message => (message as Message).id);
  if (new Set(messageIds).size !== messageIds.length) return null;
  return value as unknown as AssistantRunRequestPayloadV1;
};

export const decodeAssistantRunTerminalPayload = (
  value: unknown,
  expected: { roomId: string; messageId: string; model?: AIModelOption },
): AssistantRunTerminalPayloadV1 | null => {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['schemaVersion', 'outcome', 'message'], ['error', 'metadata'])
    || value.schemaVersion !== 1
    || (value.outcome !== 'complete' && value.outcome !== 'error')
    || !isMessageSnapshot(value.message, expected.roomId)
    || value.message.id !== expected.messageId
    || value.message.messageType !== 'ai'
    || value.message.status !== value.outcome
    || !hasValidUsageAndCost(value.message)
    || (value.error !== undefined && typeof value.error !== 'string')
    || (value.outcome === 'error' && (typeof value.error !== 'string' || value.error.length === 0))
    || (value.outcome === 'complete' && value.error !== undefined)
    || (value.outcome === 'error' && value.message.isError !== true)
    || (value.outcome === 'complete' && value.message.isError === true)
    || (value.metadata !== undefined && !isRecord(value.metadata))
    || (expected.model !== undefined && !matchesModelAccounting(value.message, expected.model))
  ) {
    return null;
  }
  return value as unknown as AssistantRunTerminalPayloadV1;
};
