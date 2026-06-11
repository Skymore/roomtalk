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

const SELECTED_AI_MODEL_KEY = 'roomtalk:selected-ai-model';
const PREMIUM_OUTPUT_PRICE_THRESHOLD = 10;

export const FALLBACK_AI_MODELS: AIModelOption[] = [
  {
    id: 'deepseek-v4-pro',
    apiModel: 'deepseek-chat',
    provider: 'deepseek',
    label: 'DeepSeek V4 Pro',
    pricing: { currency: 'USD', inputPerMillion: 0.27, cachedInputPerMillion: 0.07, outputPerMillion: 1.10 },
    isDefault: true,
  },
  {
    id: 'gpt-5.5',
    apiModel: 'openai/gpt-5.5',
    provider: 'openrouter',
    label: 'GPT-5.5',
    pricing: { currency: 'USD', inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 30 },
  },
  {
    id: 'claude-sonnet-4.6',
    apiModel: 'claude-sonnet-4-6',
    provider: 'anthropic',
    label: 'Claude Sonnet 4.6',
    pricing: { currency: 'USD', inputPerMillion: 3, cachedInputPerMillion: 0.30, outputPerMillion: 15 },
  },
  {
    id: 'claude-opus-4.7',
    apiModel: 'claude-opus-4-7',
    provider: 'anthropic',
    label: 'Claude Opus 4.7',
    pricing: { currency: 'USD', inputPerMillion: 5, cachedInputPerMillion: 0.50, outputPerMillion: 25 },
  },
  {
    id: 'kimi-k2.6',
    apiModel: 'moonshotai/kimi-k2.6',
    provider: 'openrouter',
    label: 'Kimi K2.6',
    description: 'Moonshot via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.74, outputPerMillion: 3.49 },
  },
  {
    id: 'glm-5.1',
    apiModel: 'z-ai/glm-5.1',
    provider: 'openrouter',
    label: 'GLM 5.1',
    description: 'Z.ai via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 1.05, outputPerMillion: 3.5 },
  },
  {
    id: 'minimax-m2.7',
    apiModel: 'minimax/minimax-m2.7',
    provider: 'openrouter',
    label: 'MiniMax M2.7',
    description: 'MiniMax via OpenRouter',
    pricing: { currency: 'USD', inputPerMillion: 0.3, outputPerMillion: 1.2 },
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

export const getStoredAIModel = () => {
  try {
    return localStorage.getItem(SELECTED_AI_MODEL_KEY) || '';
  } catch {
    return '';
  }
};

export const saveStoredAIModel = (model: string) => {
  try {
    localStorage.setItem(SELECTED_AI_MODEL_KEY, model);
  } catch {
    // Storage can fail in private browsing or restricted contexts.
  }
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
