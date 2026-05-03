import OpenAI from 'openai';
import { AIModelOption } from '../types';

export function createAIClients(env: NodeJS.ProcessEnv = process.env) {
  const openai = new OpenAI({
    apiKey: env.OPENAI_API_KEY || '',
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

  const getAIClientForModel = (model: AIModelOption): OpenAI => {
    if (model.provider === 'openrouter') {
      if (!env.OPENROUTER_API_KEY) {
        throw new Error('OPENROUTER_API_KEY is required for OpenRouter models');
      }

      return openrouter;
    }

    if (!env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required for OpenAI models');
    }

    return openai;
  };

  return {
    getAIClientForModel,
  };
}
