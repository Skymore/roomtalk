export interface AIModelOption {
  id: string;
  apiModel?: string;
  provider?: 'openai' | 'openrouter' | 'deepseek' | 'anthropic';
  label: string;
  description?: string;
  pricing?: {
    currency: 'USD';
    inputPerMillion: number;
    outputPerMillion: number;
    cachedInputPerMillion?: number;
  };
  isPremium?: boolean;
  isDefault?: boolean;
}

interface AIModelResponse {
  defaultModel: string;
  models: AIModelOption[];
}

const PREMIUM_OUTPUT_PRICE_THRESHOLD = 10;

export const FALLBACK_AI_MODELS: AIModelOption[] = [
  {
    id: 'deepseek-v4-pro',
    isDefault: true,
    apiModel: 'deepseek-v4-pro',
    provider: 'deepseek',
    label: 'DeepSeek V4 Pro',
    description: 'DeepSeek V4 Pro via official API; peak rates shown, off-peak rates are half',
    pricing: { currency: 'USD', inputPerMillion: 1.32, cachedInputPerMillion: 0.044, outputPerMillion: 3.96 },
  },
  {
    id: 'deepseek-v4.1-flash',
    apiModel: 'deepseek-flash',
    provider: 'deepseek',
    label: 'DeepSeek V4.1 Flash',
    description: 'DeepSeek V4.1 Flash via official API; peak rates shown, off-peak rates are half',
    pricing: { currency: 'USD', inputPerMillion: 0.3, cachedInputPerMillion: 0.006, outputPerMillion: 1.2 },
  },
  {
    id: 'deepseek-v4.1-flash-openrouter',
    apiModel: 'deepseek/deepseek-v4.1-flash',
    provider: 'openrouter',
    label: 'DeepSeek V4.1 Flash (OpenRouter)',
    description: 'DeepSeek V4.1 Flash (OpenRouter) via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.008, cachedInputPerMillion: 0.008, outputPerMillion: 0.48 },
  },
  {
    id: 'cohere/north-mini-code:free',
    apiModel: 'cohere/north-mini-code:free',
    provider: 'openrouter',
    label: 'North Mini Code (Free)',
    description: 'Cohere North Mini Code free endpoint via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0, outputPerMillion: 0 },
  },
  {
    id: 'poolside/laguna-s-2.1:free',
    apiModel: 'poolside/laguna-s-2.1:free',
    provider: 'openrouter',
    label: 'Laguna S 2.1 (Free)',
    description: 'Poolside Laguna S 2.1 free endpoint via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0, outputPerMillion: 0 },
  },
  {
    id: 'mimo-v2.6-flash',
    apiModel: 'xiaomi/mimo-v2.6-flash',
    provider: 'openrouter',
    label: 'MiMo V2.6 Flash',
    description: 'MiMo V2.6 Flash via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.14, cachedInputPerMillion: 0.0028, outputPerMillion: 0.28 },
  },
  {
    id: 'gpt-6.1-sol',
    apiModel: 'openai/gpt-6.1-sol',
    provider: 'openrouter',
    label: 'GPT-6.1 Sol',
    description: 'GPT-6.1 Sol via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 2, cachedInputPerMillion: 0.1, outputPerMillion: 10 },
  },
  {
    id: 'gpt-6-sol',
    apiModel: 'openai/gpt-6-sol',
    provider: 'openrouter',
    label: 'GPT-6 Sol',
    description: 'GPT-6 Sol via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 10 },
  },
  {
    id: 'gpt-6-luna',
    apiModel: 'openai/gpt-6-luna',
    provider: 'openrouter',
    label: 'GPT-6 Luna',
    description: 'GPT-6 Luna via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.1, cachedInputPerMillion: 0.01, outputPerMillion: 0.5 },
  },
  {
    id: 'gpt-6-luna-pro',
    apiModel: 'openai/gpt-6-luna-pro',
    provider: 'openrouter',
    label: 'GPT-6 Luna Pro',
    description: 'GPT-6 Luna Pro via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.1, cachedInputPerMillion: 0.01, outputPerMillion: 0.5 },
  },
  {
    id: 'claude-sonnet-5.5',
    apiModel: 'claude-sonnet-5-5',
    provider: 'anthropic',
    label: 'Claude Sonnet 5.5',
    description: 'Claude Sonnet 5.5 via official API',
    pricing: { currency: 'USD', inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 10 },
  },
  {
    id: 'claude-opus-5.5',
    apiModel: 'claude-opus-5-5',
    provider: 'anthropic',
    label: 'Claude Opus 5.5',
    description: 'Claude Opus 5.5 via official API',
    pricing: { currency: 'USD', inputPerMillion: 4, cachedInputPerMillion: 0.2, outputPerMillion: 20 },
  },
  {
    id: 'kimi-k3',
    apiModel: 'moonshotai/kimi-k3',
    provider: 'openrouter',
    label: 'Kimi K3',
    description: 'Moonshot Kimi K3 via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 2.7, cachedInputPerMillion: 0.27, outputPerMillion: 13.5 },
  },
  {
    id: 'glm-5.3',
    apiModel: 'z-ai/glm-5.3',
    provider: 'openrouter',
    label: 'GLM 5.3',
    description: 'GLM 5.3 via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 1.4, cachedInputPerMillion: 0.14, outputPerMillion: 4.4 },
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
    id: 'x-ai/grok-4.7',
    apiModel: 'x-ai/grok-4.7',
    provider: 'openrouter',
    label: 'Grok 4.7',
    description: 'Grok 4.7 via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 6 },
  },
  {
    id: 'tencent/hy3',
    apiModel: 'tencent/hy3',
    provider: 'openrouter',
    label: 'Tencent Hy3',
    description: 'Tencent Hy3 via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.132, cachedInputPerMillion: 0.033, outputPerMillion: 0.528 },
  },
  {
    id: 'google/gemini-3.8-flash',
    apiModel: 'google/gemini-3.8-flash',
    provider: 'openrouter',
    label: 'Gemini 3.8 Flash',
    description: 'Gemini 3.8 Flash via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.75, cachedInputPerMillion: 0.075, outputPerMillion: 3.75 },
  },
  {
    id: 'google/gemini-3.5-flash-lite',
    apiModel: 'google/gemini-3.5-flash-lite',
    provider: 'openrouter',
    label: 'Gemini 3.5 Flash-Lite',
    description: 'Google Gemini 3.5 Flash-Lite via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.3, cachedInputPerMillion: 0.03, outputPerMillion: 2.5 },
  },
  {
    id: 'qwen/qwen3.8-flash',
    apiModel: 'qwen/qwen3.8-flash',
    provider: 'openrouter',
    label: 'Qwen 3.8 Flash',
    description: 'Qwen 3.8 Flash via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.15, cachedInputPerMillion: 0.016, outputPerMillion: 0.47 },
  },
  {
    id: 'gpt-6-astra',
    apiModel: 'openai/gpt-6-astra',
    provider: 'openrouter',
    label: 'GPT-6 Astra',
    description: 'GPT-6 Astra via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 10, cachedInputPerMillion: 1, outputPerMillion: 50 },
  },
  {
    id: 'claude-fable-5.1',
    apiModel: 'claude-fable-5-1',
    provider: 'anthropic',
    label: 'Claude Fable 5.1',
    description: 'Claude Fable 5.1 via official API',
    pricing: { currency: 'USD', inputPerMillion: 10, cachedInputPerMillion: 0.25, outputPerMillion: 50 },
  },
  {
    id: 'mimo-v2.6-pro',
    apiModel: 'xiaomi/mimo-v2.6-pro',
    provider: 'openrouter',
    label: 'MiMo V2.6 Pro',
    description: 'MiMo V2.6 Pro via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.435, cachedInputPerMillion: 0.0036, outputPerMillion: 0.87 },
  },
  {
    id: 'glm-5.3-flash',
    apiModel: 'z-ai/glm-5.3-flash',
    provider: 'openrouter',
    label: 'GLM 5.3 Flash',
    description: 'GLM 5.3 Flash via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.15, cachedInputPerMillion: 0.03, outputPerMillion: 0.5 },
  },
  {
    id: 'qwen/qwen3.8-max-0902',
    apiModel: 'qwen/qwen3.8-max-0902',
    provider: 'openrouter',
    label: 'Qwen 3.8 Max',
    description: 'Qwen 3.8 Max via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 2, cachedInputPerMillion: 0.25, outputPerMillion: 6 },
  },
  {
    id: 'tencent/hy4-preview',
    apiModel: 'tencent/hy4-preview',
    provider: 'openrouter',
    label: 'Tencent Hy4 (Preview)',
    description: 'Tencent Hy4 (Preview) via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.834, cachedInputPerMillion: 0.042, outputPerMillion: 2.501 },
  },
  {
    id: 'cohere/command-a-plus',
    apiModel: 'cohere/command-a-plus',
    provider: 'openrouter',
    label: 'Command A Plus',
    description: 'Command A Plus via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.3, cachedInputPerMillion: 0.15, outputPerMillion: 1.5 },
  },
];

export const FALLBACK_AI_MODEL = FALLBACK_AI_MODELS[0].id;

const getApiBaseUrl = () => {
  const socketUrl = import.meta.env.VITE_SOCKET_URL;

  if (!socketUrl || socketUrl === '/') {
    return '';
  }

  return socketUrl.replace(/\/$/, '');
};

export const resolveSelectedAIModel = (
  storedModel: string,
  defaultModel: string,
  models: AIModelOption[]
) => {
  return storedModel && models.some(model => model.id === storedModel)
    ? storedModel
    : defaultModel;
};

export const isPremiumAIModel = (model: Pick<AIModelOption, 'pricing' | 'isPremium'>) => {
  if (typeof model.isPremium === 'boolean') {
    return model.isPremium;
  }

  // Mirror the server rule while using fallback models before the API responds.
  if (!model.pricing || !Number.isFinite(model.pricing.outputPerMillion)) {
    return true;
  }

  return model.pricing.outputPerMillion > PREMIUM_OUTPUT_PRICE_THRESHOLD;
};

export const fetchAIModels = async (): Promise<AIModelResponse> => {
  const response = await fetch(`${getApiBaseUrl()}/api/ai-models`);

  if (!response.ok) {
    throw new Error(`Failed to load AI models: ${response.status}`);
  }

  const data = await response.json();

  if (!data?.defaultModel || !Array.isArray(data.models) || data.models.length === 0) {
    throw new Error('AI model response is invalid');
  }

  return data;
};

export const getProviderLabel = (provider?: string): string => {
  const labels: Record<string, string> = {
    anthropic: 'Anthropic',
    deepseek: 'DeepSeek',
    openai: 'OpenAI',
    openrouter: 'OpenRouter',
  };
  return labels[provider ?? ''] ?? provider ?? '';
};

const formatRate = (value: number) => {
  if (!Number.isFinite(value)) return '?';
  if (value >= 10) return value.toFixed(0);
  if (value >= 1) return value.toFixed(2).replace(/\.?0+$/, '');
  return value.toFixed(3).replace(/\.?0+$/, '');
};

export const formatModelPrice = (model: AIModelOption) => {
  if (!model.pricing) {
    return 'Price unavailable';
  }

  const cachedPrice = typeof model.pricing.cachedInputPerMillion === 'number'
    ? ` · $${formatRate(model.pricing.cachedInputPerMillion)}/M cached`
    : '';

  return `$${formatRate(model.pricing.inputPerMillion)}/M in${cachedPrice} · $${formatRate(model.pricing.outputPerMillion)}/M out`;
};

export const getAIModelAccessReason = (
  entitlement: { effectiveTier: string; creditBalanceUsd: number; creditUnlimited?: boolean } | null | undefined,
  model: { id: string; apiModel?: string; pricing?: { inputPerMillion: number } },
): string | undefined => {
  if (entitlement === undefined) return 'loading';
  if (entitlement?.creditUnlimited) return;
  if (!entitlement) return 'aiModelCreditsUnavailable';
  if (/(?:gpt-6-astra|claude-fable)/.test(`${model.id} ${model.apiModel || ''}`)
    && entitlement.effectiveTier !== 'pro' && entitlement.effectiveTier !== 'priority') return 'aiModelMembershipRequired';
  if (entitlement.creditBalanceUsd <= -5) return 'aiModelCreditLimitReached';
  if (entitlement.creditBalanceUsd <= 0
    && !(typeof model.pricing?.inputPerMillion === 'number' && model.pricing.inputPerMillion < 1)) {
    return 'aiModelCheapOnly';
  }
};
