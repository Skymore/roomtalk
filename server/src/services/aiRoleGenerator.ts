import { AIClientWrapper } from './aiClients';
import { AIModelOption } from '../types';

export const MAX_AI_ROLE_IDEA_LENGTH = 2000;
const MAX_AI_ROLE_NAME_LENGTH = 80;
const MAX_AI_ROLE_PROMPT_LENGTH = 4000;

export interface AIRoleDraft {
  name: string;
  systemPrompt: string;
}

interface AIRoleGeneratorOptions {
  model: AIModelOption;
  getAIClientForModel: (model: AIModelOption) => AIClientWrapper;
}

export function parseAIRoleDraft(value: string): AIRoleDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Role generator returned invalid JSON');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Role generator returned an invalid draft');
  }

  const draft = parsed as { name?: unknown; systemPrompt?: unknown };
  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  const systemPrompt = typeof draft.systemPrompt === 'string' ? draft.systemPrompt.trim() : '';

  if (!name || !systemPrompt) {
    throw new Error('Role generator returned an incomplete draft');
  }

  return {
    name: name.slice(0, MAX_AI_ROLE_NAME_LENGTH),
    systemPrompt: systemPrompt.slice(0, MAX_AI_ROLE_PROMPT_LENGTH),
  };
}

export function createAIRoleDraftGenerator({
  model,
  getAIClientForModel,
}: AIRoleGeneratorOptions) {
  return async (idea: string): Promise<AIRoleDraft> => {
    const clientWrapper = getAIClientForModel(model);
    if (clientWrapper.provider !== 'openrouter') {
      throw new Error('AI role generation requires the OpenRouter model');
    }

    const response = await clientWrapper.client.chat.completions.create({
      model: model.apiModel,
      messages: [
        {
          role: 'system',
          content: [
            'Create an AI chat role from the user request.',
            'Return JSON only with exactly two string fields: "name" and "systemPrompt".',
            'The name should be short. The systemPrompt should be actionable and ready to use.',
            'Write both fields in the same language as the user request unless the user specifies otherwise.',
          ].join(' '),
        },
        { role: 'user', content: idea.trim() },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    } as any);

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Role generator returned an empty response');
    }

    return parseAIRoleDraft(content);
  };
}
