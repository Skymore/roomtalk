import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { AIModelOption } from '../types';

export type AIClientWrapper =
  | { provider: 'openai' | 'deepseek' | 'openrouter'; client: OpenAI }
  | { provider: 'anthropic'; client: Anthropic };

export function createAIClients(env: NodeJS.ProcessEnv = process.env) {
  const openai = new OpenAI({
    apiKey: env.OPENAI_API_KEY || '',
  });

  const deepseek = new OpenAI({
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: env.DEEPSEEK_API_KEY || '',
  });

  const anthropic = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY || '',
  });

  const openrouterHeaders: Record<string, string> = {
    'X-Title': env.OPENROUTER_APP_NAME || 'RoomTalk',
  };
  const openrouterReferer = env.OPENROUTER_HTTP_REFERER || env.CLIENT_URL;
  if (openrouterReferer) {
    openrouterHeaders['HTTP-Referer'] = openrouterReferer;
  }

  const openrouter = new OpenAI({
    apiKey: env.OPENROUTER_API_KEY || 'missing-openrouter-api-key',
    baseURL: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    defaultHeaders: openrouterHeaders,
  });

  const getAIClientForModel = (model: AIModelOption): AIClientWrapper => {
    switch (model.provider) {
      case 'anthropic':
        if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required for Anthropic models');
        return { provider: 'anthropic', client: anthropic };
      case 'deepseek':
        if (!env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required for DeepSeek models');
        return { provider: 'deepseek', client: deepseek };
      case 'openai':
        if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for OpenAI models');
        return { provider: 'openai', client: openai };
      case 'openrouter':
      default:
        if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required for OpenRouter models');
        return { provider: 'openrouter', client: openrouter };
    }
  };

  return { getAIClientForModel };
}
