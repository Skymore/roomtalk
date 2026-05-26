import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAIRoleDraftGenerator, parseAIRoleDraft } from './aiRoleGenerator';
import { AIModelOption } from '../types';

const model: AIModelOption = {
  id: 'google/gemini-3.5-flash',
  apiModel: 'google/gemini-3.5-flash',
  provider: 'openrouter',
  label: 'Gemini 3.5 Flash',
  description: 'Google Gemini 3.5 Flash via OpenRouter',
};

describe('AI role generator', () => {
  it('generates a structured draft with Gemini 3.5 Flash through OpenRouter', async () => {
    const requests: any[] = [];
    const generateDraft = createAIRoleDraftGenerator({
      model,
      getAIClientForModel: () => ({
        provider: 'openrouter',
        client: {
          chat: {
            completions: {
              create: async (request: unknown) => {
                requests.push(request);
                return { choices: [{ message: { content: '{"name":"Reviewer","systemPrompt":"Review code rigorously."}' } }] };
              },
            },
          },
        } as any,
      }),
    });

    assert.deepEqual(await generateDraft('Create a code reviewer'), {
      name: 'Reviewer',
      systemPrompt: 'Review code rigorously.',
    });
    assert.equal(requests[0].model, 'google/gemini-3.5-flash');
    assert.equal(requests[0].messages[1].content, 'Create a code reviewer');
    assert.deepEqual(requests[0].response_format, { type: 'json_object' });
  });

  it('rejects malformed or incomplete structured output', () => {
    assert.throws(() => parseAIRoleDraft('not json'), /invalid JSON/);
    assert.throws(() => parseAIRoleDraft('{"name":"Only a name"}'), /incomplete draft/);
  });
});
