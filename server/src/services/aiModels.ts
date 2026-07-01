import { AICost, AIModelOption, AIUsage, Message } from '../types';

export const DEFAULT_SYSTEM_MESSAGE = 'You are a helpful, creative, friendly assistant. Respond concisely and clearly.';
export const DEFAULT_AI_MODEL_ID = 'deepseek-v4-pro';
export const AI_ROLE_GENERATOR_MODEL_ID = 'google/gemini-3.5-flash';
export const PREMIUM_OUTPUT_PRICE_THRESHOLD = 10;

interface AIModelLogger {
  warn(message: string, meta?: unknown): void;
}

export const REQUESTED_AI_MODEL_CATALOG: AIModelOption[] = [
  {
    id: 'deepseek-v4-pro',
    apiModel: 'deepseek-v4-pro',
    provider: 'deepseek',
    label: 'DeepSeek V4 Pro',
    description: 'DeepSeek V4 Pro via official API (with prompt caching)',
    pricing: { currency: 'USD', inputPerMillion: 0.435, cachedInputPerMillion: 0.003625, outputPerMillion: 0.87 },
  },
  {
    id: 'deepseek-v4-flash',
    apiModel: 'deepseek-v4-flash',
    provider: 'deepseek',
    label: 'DeepSeek V4 Flash',
    description: 'DeepSeek V4 Flash via official API (with prompt caching)',
    pricing: { currency: 'USD', inputPerMillion: 0.14, cachedInputPerMillion: 0.0028, outputPerMillion: 0.28 },
  },
  {
    id: 'deepseek-v4-flash-openrouter',
    apiModel: 'deepseek/deepseek-v4-flash',
    provider: 'openrouter',
    label: 'DeepSeek V4 Flash (OpenRouter)',
    description: 'DeepSeek V4 Flash via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.098, cachedInputPerMillion: 0.02, outputPerMillion: 0.196 },
  },
  {
    id: 'mimo-v2.5',
    apiModel: 'xiaomi/mimo-v2.5',
    provider: 'openrouter',
    label: 'MiMo V2.5',
    description: 'Xiaomi MiMo V2.5 via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.105, outputPerMillion: 0.28 },
  },
  {
    id: 'gpt-5.5',
    apiModel: 'openai/gpt-5.5',
    provider: 'openrouter',
    label: 'GPT-5.5',
    description: 'OpenAI GPT-5.5 routed through OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 30 },
  },
  {
    id: 'claude-sonnet-5',
    apiModel: 'claude-sonnet-5',
    provider: 'anthropic',
    label: 'Claude Sonnet 5',
    description: 'Anthropic Claude Sonnet 5 via official API (with prompt caching)',
    pricing: { currency: 'USD', inputPerMillion: 2, cachedInputPerMillion: 0.20, outputPerMillion: 10 },
  },
  {
    id: 'claude-opus-4.8',
    apiModel: 'claude-opus-4-8',
    provider: 'anthropic',
    label: 'Claude Opus 4.8',
    description: 'Anthropic Claude Opus 4.8 via official API (with prompt caching)',
    pricing: { currency: 'USD', inputPerMillion: 5, cachedInputPerMillion: 0.50, outputPerMillion: 25 },
  },
  {
    id: 'kimi-k2.7-code',
    apiModel: 'moonshotai/kimi-k2.7-code',
    provider: 'openrouter',
    label: 'Kimi K2.7 Code',
    description: 'Moonshot Kimi model via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.74, cachedInputPerMillion: 0.15, outputPerMillion: 3.5 },
  },
  {
    id: 'glm-5.2',
    apiModel: 'z-ai/glm-5.2',
    provider: 'openrouter',
    label: 'GLM 5.2',
    description: 'Latest GLM model via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.93, cachedInputPerMillion: 0.18, outputPerMillion: 3 },
  },
  {
    id: 'minimax-m3',
    apiModel: 'minimax/minimax-m3',
    provider: 'openrouter',
    label: 'MiniMax M3',
    description: 'Latest MiniMax model via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.3, cachedInputPerMillion: 0.06, outputPerMillion: 1.2 },
  },
  {
    id: 'x-ai/grok-4.3',
    apiModel: 'x-ai/grok-4.3',
    provider: 'openrouter',
    label: 'Grok 4.3',
    description: 'xAI Grok 4.3 via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 1.25, cachedInputPerMillion: 0.2, outputPerMillion: 2.5 },
  },
  {
    id: 'tencent/hy3-preview',
    apiModel: 'tencent/hy3-preview',
    provider: 'openrouter',
    label: 'Tencent Hy3 Preview',
    description: 'Tencent Hy3 preview via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.066, cachedInputPerMillion: 0.029, outputPerMillion: 0.26 },
  },
  {
    id: 'google/gemini-3.5-flash',
    apiModel: 'google/gemini-3.5-flash',
    provider: 'openrouter',
    label: 'Gemini 3.5 Flash',
    description: 'Google Gemini 3.5 Flash via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 1.5, cachedInputPerMillion: 0.15, outputPerMillion: 9 },
  },
  {
    id: '~google/gemini-pro-latest',
    apiModel: '~google/gemini-pro-latest',
    provider: 'openrouter',
    label: 'Gemini Pro Latest',
    description: 'Google Gemini Pro Latest via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 12 },
  },
];

export const LEGACY_AI_MODEL_CATALOG: AIModelOption[] = [
  {
    id: 'gpt-5',
    apiModel: 'openai/gpt-5',
    provider: 'openrouter',
    label: 'GPT-5',
    description: 'OpenAI GPT-5 routed through OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 },
  },
  {
    id: 'gpt-5-mini',
    apiModel: 'openai/gpt-5-mini',
    provider: 'openrouter',
    label: 'GPT-5 mini',
    description: 'OpenAI GPT-5 mini routed through OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.25, cachedInputPerMillion: 0.025, outputPerMillion: 2 },
  },
  {
    id: 'gpt-5-nano',
    apiModel: 'openai/gpt-5-nano',
    provider: 'openrouter',
    label: 'GPT-5 nano',
    description: 'OpenAI GPT-5 nano routed through OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.05, cachedInputPerMillion: 0.005, outputPerMillion: 0.4 },
  },
];

const AI_MODEL_CATALOG = [...REQUESTED_AI_MODEL_CATALOG, ...LEGACY_AI_MODEL_CATALOG];

const normalizeModelLookupKey = (value: string) => value.trim().toLowerCase();

export const isPremiumAIModel = (model: Pick<AIModelOption, 'pricing'>): boolean => {
  // Unknown prices require confirmation because configured models can point to
  // expensive provider models outside the built-in catalog.
  if (!model.pricing || !Number.isFinite(model.pricing.outputPerMillion)) {
    return true;
  }

  return model.pricing.outputPerMillion > PREMIUM_OUTPUT_PRICE_THRESHOLD;
};

const createConfiguredOpenRouterModel = (model: string): AIModelOption => ({
  id: model,
  apiModel: model,
  provider: 'openrouter',
  label: model,
  description: 'Configured OpenRouter model',
});

const resolveCatalogModel = (model: string): AIModelOption | undefined => {
  const key = normalizeModelLookupKey(model);
  return AI_MODEL_CATALOG.find(option =>
    normalizeModelLookupKey(option.id) === key ||
    normalizeModelLookupKey(option.apiModel) === key
  );
};

const resolveAIModelOption = (model: string): AIModelOption => {
  return resolveCatalogModel(model) || createConfiguredOpenRouterModel(model);
};

const addUniqueModel = (models: AIModelOption[], model: AIModelOption) => {
  if (!models.some(existing => existing.id === model.id)) {
    models.push({ ...model });
  }
};

export const parseAIModelOptions = (defaultModelId: string): AIModelOption[] => {
  const models: AIModelOption[] = [];
  const defaultModel = resolveAIModelOption(defaultModelId);

  addUniqueModel(models, defaultModel);
  REQUESTED_AI_MODEL_CATALOG.forEach(model => addUniqueModel(models, model));

  return models.map(model => ({
    ...model,
    isPremium: isPremiumAIModel(model),
    isDefault: model.id === defaultModel.id,
  }));
};

export function createAIModelRegistry(options: {
  defaultModelId?: string;
  logger?: AIModelLogger;
} = {}) {
  const modelOptions = parseAIModelOptions(options.defaultModelId || DEFAULT_AI_MODEL_ID);
  const defaultModel = modelOptions.find(model => model.isDefault) || modelOptions[0];

  const normalizeAIModel = (requestedModel?: string): AIModelOption => {
    if (requestedModel) {
      const requested = normalizeModelLookupKey(requestedModel);
      const selectedModel = modelOptions.find(model =>
        normalizeModelLookupKey(model.id) === requested ||
        normalizeModelLookupKey(model.apiModel) === requested
      );

      if (selectedModel) {
        return selectedModel;
      }

      options.logger?.warn('Requested AI model is not allowed, using default model', {
        requestedModel,
        defaultModel: defaultModel.id,
      });
    }

    return defaultModel;
  };

  const getAIModelResponse = () => ({
    defaultModel: defaultModel.id,
    models: modelOptions.map(model => ({
      id: model.id,
      apiModel: model.apiModel,
      provider: model.provider,
      label: model.label,
      description: model.description,
      pricing: model.pricing,
      isPremium: model.isPremium,
      isDefault: model.isDefault,
    })),
  });

  return {
    defaultModel,
    modelOptions,
    normalizeAIModel,
    getAIModelResponse,
  };
}

function estimateTokenCount(text: string): number {
  if (!text.trim()) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimatePromptTokens(messages: Array<{ content: any }>): number {
  return messages.reduce((total, message) => {
    if (typeof message.content === 'string') {
      return total + estimateTokenCount(message.content);
    }

    if (Array.isArray(message.content)) {
      return total + message.content.reduce((itemTotal: number, item: any) => {
        if (item.type === 'text' && typeof item.text === 'string') {
          return itemTotal + estimateTokenCount(item.text);
        }

        if (item.type === 'image_url') {
          return itemTotal + 1000;
        }

        return itemTotal;
      }, 0);
    }

    return total;
  }, 0);
}

export function normalizeUsage(apiUsage: any, messages: Array<{ content: any }>, outputContent: string): AIUsage {
  // Anthropic native format: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
  if (apiUsage && typeof apiUsage.input_tokens === 'number' && typeof apiUsage.output_tokens === 'number') {
    const cacheRead = apiUsage.cache_read_input_tokens || 0;
    const cacheCreated = apiUsage.cache_creation_input_tokens || 0;
    const promptTokens = apiUsage.input_tokens + cacheRead + cacheCreated;
    const completionTokens = apiUsage.output_tokens;
    const cacheHitRate = promptTokens > 0 && cacheRead > 0
      ? Math.min(cacheRead / promptTokens, 1)
      : undefined;

    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cachedPromptTokens: cacheRead > 0 ? cacheRead : undefined,
      cacheHitRate,
      source: 'reported',
    };
  }

  // OpenAI / DeepSeek format:
  // OpenAI: { prompt_tokens, completion_tokens, prompt_tokens_details.cached_tokens }
  // DeepSeek: { prompt_tokens, completion_tokens, prompt_cache_hit_tokens, prompt_cache_miss_tokens }
  if (apiUsage && typeof apiUsage.prompt_tokens === 'number' && typeof apiUsage.completion_tokens === 'number') {
    const deepSeekCacheHitTokens = apiUsage.prompt_cache_hit_tokens;
    const openAICachedTokens = apiUsage.prompt_tokens_details?.cached_tokens;
    const cachedPromptTokens = typeof deepSeekCacheHitTokens === 'number'
      ? deepSeekCacheHitTokens
      : openAICachedTokens;
    const cacheHitRate = typeof cachedPromptTokens === 'number' && apiUsage.prompt_tokens > 0
      ? Math.min(Math.max(cachedPromptTokens / apiUsage.prompt_tokens, 0), 1)
      : undefined;

    return {
      promptTokens: apiUsage.prompt_tokens,
      completionTokens: apiUsage.completion_tokens,
      totalTokens: typeof apiUsage.total_tokens === 'number'
        ? apiUsage.total_tokens
        : apiUsage.prompt_tokens + apiUsage.completion_tokens,
      cachedPromptTokens: typeof cachedPromptTokens === 'number' ? cachedPromptTokens : undefined,
      cacheHitRate,
      source: 'reported',
    };
  }

  const promptTokens = estimatePromptTokens(messages);
  const completionTokens = estimateTokenCount(outputContent);

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    source: 'estimated',
  };
}

export function calculateAICost(model: AIModelOption, usage: AIUsage): AICost | undefined {
  if (!model.pricing) {
    return undefined;
  }

  const cachedPromptTokens = Math.min(usage.cachedPromptTokens || 0, usage.promptTokens);
  const uncachedPromptTokens = Math.max(usage.promptTokens - cachedPromptTokens, 0);
  const cachedInputPerMillion = model.pricing.cachedInputPerMillion;
  const inputUsd =
    (uncachedPromptTokens / 1_000_000) * model.pricing.inputPerMillion +
    (cachedPromptTokens / 1_000_000) * (cachedInputPerMillion ?? model.pricing.inputPerMillion);
  const outputUsd = (usage.completionTokens / 1_000_000) * model.pricing.outputPerMillion;

  return {
    currency: model.pricing.currency,
    inputUsd,
    outputUsd,
    totalUsd: inputUsd + outputUsd,
    inputPerMillion: model.pricing.inputPerMillion,
    outputPerMillion: model.pricing.outputPerMillion,
    cachedInputPerMillion,
    estimated: usage.source === 'estimated',
  };
}

export function getMessageAIModel(model: AIModelOption): Message['aiModel'] {
  return {
    id: model.id,
    apiModel: model.apiModel,
    provider: model.provider,
    label: model.label,
    isPremium: model.isPremium,
  };
}
