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
    apiModel: 'deepseek-v4-pro',
    provider: 'deepseek',
    label: 'DeepSeek V4 Pro',
    pricing: { currency: 'USD', inputPerMillion: 0.435, cachedInputPerMillion: 0.003625, outputPerMillion: 0.87 },
    isDefault: true,
  },
  {
    id: 'deepseek-v4-flash',
    apiModel: 'deepseek-v4-flash',
    provider: 'deepseek',
    label: 'DeepSeek V4 Flash',
    description: 'DeepSeek official API',
    pricing: { currency: 'USD', inputPerMillion: 0.14, cachedInputPerMillion: 0.0028, outputPerMillion: 0.28 },
  },
  {
    id: 'deepseek-v4-flash-openrouter',
    apiModel: 'deepseek/deepseek-v4-flash',
    provider: 'openrouter',
    label: 'DeepSeek V4 Flash (OpenRouter)',
    description: 'DeepSeek via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.098, cachedInputPerMillion: 0.02, outputPerMillion: 0.196 },
  },
  {
    id: 'mimo-v2.5',
    apiModel: 'xiaomi/mimo-v2.5',
    provider: 'openrouter',
    label: 'MiMo V2.5',
    description: 'Xiaomi via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.105, outputPerMillion: 0.28 },
  },
  {
    id: 'gpt-5.5',
    apiModel: 'openai/gpt-5.5',
    provider: 'openrouter',
    label: 'GPT-5.5',
    pricing: { currency: 'USD', inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 30 },
  },
  {
    id: 'claude-sonnet-5',
    apiModel: 'claude-sonnet-5',
    provider: 'anthropic',
    label: 'Claude Sonnet 5',
    pricing: { currency: 'USD', inputPerMillion: 2, cachedInputPerMillion: 0.20, outputPerMillion: 10 },
  },
  {
    id: 'claude-opus-4.8',
    apiModel: 'claude-opus-4-8',
    provider: 'anthropic',
    label: 'Claude Opus 4.8',
    pricing: { currency: 'USD', inputPerMillion: 5, cachedInputPerMillion: 0.50, outputPerMillion: 25 },
  },
  {
    id: 'kimi-k2.7-code',
    apiModel: 'moonshotai/kimi-k2.7-code',
    provider: 'openrouter',
    label: 'Kimi K2.7 Code',
    description: 'Moonshot via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.74, cachedInputPerMillion: 0.15, outputPerMillion: 3.5 },
  },
  {
    id: 'glm-5.2',
    apiModel: 'z-ai/glm-5.2',
    provider: 'openrouter',
    label: 'GLM 5.2',
    description: 'Z.ai via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.93, cachedInputPerMillion: 0.18, outputPerMillion: 3 },
  },
  {
    id: 'minimax-m3',
    apiModel: 'minimax/minimax-m3',
    provider: 'openrouter',
    label: 'MiniMax M3',
    description: 'MiniMax via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.3, cachedInputPerMillion: 0.06, outputPerMillion: 1.2 },
  },
  {
    id: 'x-ai/grok-4.3',
    apiModel: 'x-ai/grok-4.3',
    provider: 'openrouter',
    label: 'Grok 4.3',
    description: 'xAI via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 1.25, cachedInputPerMillion: 0.2, outputPerMillion: 2.5 },
  },
  {
    id: 'tencent/hy3-preview',
    apiModel: 'tencent/hy3-preview',
    provider: 'openrouter',
    label: 'Tencent Hy3 Preview',
    description: 'Tencent via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.066, cachedInputPerMillion: 0.029, outputPerMillion: 0.26 },
  },
  {
    id: 'google/gemini-3.5-flash',
    apiModel: 'google/gemini-3.5-flash',
    provider: 'openrouter',
    label: 'Gemini 3.5 Flash',
    description: 'Google via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 1.5, cachedInputPerMillion: 0.15, outputPerMillion: 9 },
  },
  {
    id: '~google/gemini-pro-latest',
    apiModel: '~google/gemini-pro-latest',
    provider: 'openrouter',
    label: 'Gemini Pro Latest',
    description: 'Google via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 12 },
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
