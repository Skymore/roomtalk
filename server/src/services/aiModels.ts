import { AICost, AIModelOption, AIUsage, Message } from '../types';

export const DEFAULT_SYSTEM_MESSAGE = 'You are a helpful, creative, friendly assistant. Respond concisely and clearly.';
export const DEFAULT_AI_MODEL_ID = 'deepseek-v4-pro';

interface AIModelLogger {
  warn(message: string, meta?: unknown): void;
}

export const REQUESTED_AI_MODEL_CATALOG: AIModelOption[] = [
  {
    id: 'deepseek-v4-pro',
    apiModel: 'deepseek-chat',
    provider: 'deepseek',
    label: 'DeepSeek V4 Pro',
    description: 'DeepSeek V4 Pro via official API (with prompt caching)',
    pricing: { currency: 'USD', inputPerMillion: 0.27, cachedInputPerMillion: 0.07, outputPerMillion: 1.10 },
  },
  {
    id: 'gpt-5.5',
    apiModel: 'openai/gpt-5.5',
    provider: 'openrouter',
    label: 'GPT-5.5',
    description: 'OpenAI GPT-5.5 routed through OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 30 },
    isPremium: true,
  },
  {
    id: 'claude-sonnet-4.6',
    apiModel: 'claude-sonnet-4-6',
    provider: 'anthropic',
    label: 'Claude Sonnet 4.6',
    description: 'Anthropic Claude Sonnet 4.6 via official API (with prompt caching)',
    pricing: { currency: 'USD', inputPerMillion: 3, cachedInputPerMillion: 0.30, outputPerMillion: 15 },
    isPremium: true,
  },
  {
    id: 'claude-opus-4.7',
    apiModel: 'claude-opus-4-7',
    provider: 'anthropic',
    label: 'Claude Opus 4.7',
    description: 'Anthropic Claude Opus 4.7 via official API (with prompt caching)',
    pricing: { currency: 'USD', inputPerMillion: 15, cachedInputPerMillion: 1.50, outputPerMillion: 75 },
    isPremium: true,
  },
  {
    id: 'kimi-k2.6',
    apiModel: 'moonshotai/kimi-k2.6',
    provider: 'openrouter',
    label: 'Kimi K2.6',
    description: 'Moonshot Kimi model via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.74, outputPerMillion: 3.49 },
  },
  {
    id: 'glm-5.1',
    apiModel: 'z-ai/glm-5.1',
    provider: 'openrouter',
    label: 'GLM 5.1',
    description: 'Latest GLM model via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 1.05, outputPerMillion: 3.5 },
  },
  {
    id: 'minimax-m2.7',
    apiModel: 'minimax/minimax-m2.7',
    provider: 'openrouter',
    label: 'MiniMax M2.7',
    description: 'Latest MiniMax model via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.3, outputPerMillion: 1.2 },
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
    id: 'tencent/hy3-preview:free',
    apiModel: 'tencent/hy3-preview:free',
    provider: 'openrouter',
    label: 'Tencent Hy3 Preview',
    description: 'Tencent Hy3 preview free tier via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0, outputPerMillion: 0 },
  },
  {
    id: '~google/gemini-pro-latest',
    apiModel: '~google/gemini-pro-latest',
    provider: 'openrouter',
    label: 'Gemini Pro Latest',
    description: 'Google Gemini Pro Latest via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 12 },
    isPremium: true,
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
    isPremium: true,
  },
  {
    id: 'gpt-5-mini',
    apiModel: 'openai/gpt-5-mini',
    provider: 'openrouter',
    label: 'GPT-5 mini',
    description: 'OpenAI GPT-5 mini routed through OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.25, cachedInputPerMillion: 0.025, outputPerMillion: 2 },
    isPremium: true,
  },
  {
    id: 'gpt-5-nano',
    apiModel: 'openai/gpt-5-nano',
    provider: 'openrouter',
    label: 'GPT-5 nano',
    description: 'OpenAI GPT-5 nano routed through OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.05, cachedInputPerMillion: 0.005, outputPerMillion: 0.4 },
    isPremium: true,
  },
];

const AI_MODEL_CATALOG = [...REQUESTED_AI_MODEL_CATALOG, ...LEGACY_AI_MODEL_CATALOG];

const normalizeModelLookupKey = (value: string) => value.trim().toLowerCase();

export const isPremiumAIModel = (model: Pick<AIModelOption, 'id' | 'apiModel' | 'label' | 'isPremium'>): boolean => {
  if (typeof model.isPremium === 'boolean') {
    return model.isPremium;
  }

  const modelText = `${model.id} ${model.apiModel} ${model.label}`.toLowerCase();
  return (
    modelText.includes('gpt') ||
    modelText.includes('openai/') ||
    modelText.includes('claude') ||
    modelText.includes('anthropic/') ||
    modelText.includes('gemini') ||
    modelText.includes('google/') ||
    modelText.includes('~google/')
  );
};

const createConfiguredOpenRouterModel = (model: string): AIModelOption => ({
  id: model,
  apiModel: model,
  provider: 'openrouter',
  label: model,
  description: 'Configured OpenRouter model',
  isPremium: isPremiumAIModel({ id: model, apiModel: model, label: model }),
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

export const parseAIModelOptions = (defaultModelId: string, value?: string): AIModelOption[] => {
  const configuredModels = value
    ?.split(',')
    .map(model => model.trim())
    .filter(Boolean) ?? [];

  const models: AIModelOption[] = [];
  const defaultModel = resolveAIModelOption(defaultModelId);

  addUniqueModel(models, defaultModel);
  configuredModels.forEach(model => addUniqueModel(models, resolveAIModelOption(model)));
  REQUESTED_AI_MODEL_CATALOG.forEach(model => addUniqueModel(models, model));

  return models.map(model => ({
    ...model,
    isPremium: isPremiumAIModel(model),
    isDefault: model.id === defaultModel.id,
  }));
};

export function createAIModelRegistry(options: {
  defaultModelId?: string;
  configuredModelOptions?: string;
  logger?: AIModelLogger;
} = {}) {
  const modelOptions = parseAIModelOptions(options.defaultModelId || DEFAULT_AI_MODEL_ID, options.configuredModelOptions);
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

  // OpenAI / DeepSeek format: { prompt_tokens, completion_tokens, prompt_tokens_details.cached_tokens }
  if (apiUsage && typeof apiUsage.prompt_tokens === 'number' && typeof apiUsage.completion_tokens === 'number') {
    const cachedPromptTokens = apiUsage.prompt_tokens_details?.cached_tokens;
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
