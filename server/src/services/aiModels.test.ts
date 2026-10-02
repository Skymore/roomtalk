import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateAICost, createAIModelRegistry, DEFAULT_AI_MODEL_ID, getHistoricalAIModelOptions, isPremiumAIModel, normalizeUsage, parseAIModelOptions } from './aiModels';
import { AIModelOption, AIUsage } from '../types';

describe('AI model registry', () => {
  it('exposes current models, resolves API IDs, and preserves historical pricing', () => {
    const registry = createAIModelRegistry();
    assert.equal(registry.defaultModel.id, DEFAULT_AI_MODEL_ID);
    assert.equal(registry.normalizeAIModel('openai/gpt-6.1-sol').id, 'gpt-6.1-sol');
    assert.equal(registry.normalizeAIModel('claude-fable-5-1').id, 'claude-fable-5.1');
    assert.equal(registry.normalizeAIModel('deepseek-flash').id, 'deepseek-v4.1-flash');
    assert.equal(registry.normalizeAIModel('unknown-model').id, DEFAULT_AI_MODEL_ID);
    assert.equal(new Set(registry.modelOptions.map(m => m.id)).size, registry.modelOptions.length);
    assert.equal(registry.modelOptions.some(m => m.id === 'gpt-5.6-sol'), false);
    for (const id of ['gpt-6-astra', 'claude-opus-5.5', 'claude-sonnet-5.5', 'glm-5.3', 'mimo-v2.6-pro', 'qwen/qwen3.8-max-0902', 'google/gemini-3.8-flash', 'x-ai/grok-4.7', 'tencent/hy4-preview']) {
      assert.ok(registry.modelOptions.some(m => m.id === id), id);
    }
    assert.equal(registry.normalizeAIModel('gpt-6-luna').pricing?.inputPerMillion, 0.1);
    assert.equal(registry.normalizeAIModel('gpt-6-luna').pricing?.outputPerMillion, 0.5);
    assert.equal(registry.defaultModel.pricing?.inputPerMillion, 1.32);
    assert.equal(getHistoricalAIModelOptions().find(m => m.id === 'deepseek-v4-pro')?.pricing?.inputPerMillion, 0.435);
    assert.equal(getHistoricalAIModelOptions().find(m => m.id === 'gpt-5.6-sol')?.pricing?.inputPerMillion, 5);
    assert.equal(isPremiumAIModel(registry.normalizeAIModel('gpt-6-astra')), true);
    assert.equal(isPremiumAIModel(registry.normalizeAIModel('gpt-6.1-sol')), false);
    assert.equal(isPremiumAIModel({}), true);
    assert.equal(parseAIModelOptions('custom/model')[0].id, 'custom/model');
  });

  it('uses cached input pricing when reported', () => {
    const registry = createAIModelRegistry({ defaultModelId: 'gpt-5.6-sol' });
    const usage: AIUsage = {
      promptTokens: 1_000_000,
      cachedPromptTokens: 250_000,
      completionTokens: 100_000,
      totalTokens: 1_100_000,
      source: 'reported',
    };

    const cost = calculateAICost(registry.defaultModel, usage);

    assert.equal(cost?.inputUsd, 3.875);
    assert.equal(cost?.outputUsd, 3);
    assert.equal(cost?.totalUsd, 6.875);
    assert.equal(cost?.estimated, false);
  });

  it('prefers the reported provider cost over catalog estimates', () => {
    const model = createAIModelRegistry().normalizeAIModel('gpt-6.1-sol');
    const cost = calculateAICost(model, { promptTokens: 100, completionTokens: 20, totalTokens: 120, source: 'reported' }, 0.000123);
    assert.equal(cost?.totalUsd, 0.000123);
    assert.equal(cost!.inputUsd + cost!.outputUsd, cost!.totalUsd);
  });

  it('returns undefined for models without pricing', () => {
    const model: AIModelOption = {
      id: 'custom/model',
      apiModel: 'custom/model',
      provider: 'openrouter',
      label: 'Custom',
      description: 'Custom configured model',
    };
    const usage: AIUsage = {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      source: 'reported',
    };

    assert.equal(calculateAICost(model, usage), undefined);
  });

  it('caps cached prompt tokens at total prompt tokens', () => {
    const registry = createAIModelRegistry({ defaultModelId: 'gpt-5.6-sol' });
    const usage: AIUsage = {
      promptTokens: 100,
      cachedPromptTokens: 1_000,
      completionTokens: 0,
      totalTokens: 100,
      source: 'reported',
    };

    const cost = calculateAICost(registry.defaultModel, usage);

    assert.equal(cost?.inputUsd, 0.00005);
  });
});

describe('normalizeUsage', () => {
  it('uses reported usage and cached token details when provided', () => {
    const usage = normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 25,
      total_tokens: 125,
      prompt_tokens_details: { cached_tokens: 40 },
    }, [], '');

    assert.deepEqual(usage, {
      promptTokens: 100,
      completionTokens: 25,
      totalTokens: 125,
      cachedPromptTokens: 40,
      cacheHitRate: 0.4,
      source: 'reported',
    });
  });

  it('uses DeepSeek cache hit fields when provided', () => {
    const usage = normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_cache_hit_tokens: 64,
      prompt_cache_miss_tokens: 36,
    }, [], 'output');

    assert.deepEqual(usage, {
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cachedPromptTokens: 64,
      cacheHitRate: 0.64,
      source: 'reported',
    });
  });

  it('caps cache hit rate when cached tokens exceed prompt tokens', () => {
    const usage = normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 25,
      prompt_tokens_details: { cached_tokens: 400 },
    }, [], '');

    assert.equal(usage.cachedPromptTokens, 400);
    assert.equal(usage.cacheHitRate, 1);
  });

  it('estimates text and image prompt usage when provider usage is missing', () => {
    const usage = normalizeUsage(null, [
      { content: '12345678' },
      { content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] },
    ], '1234');

    assert.equal(usage.promptTokens, 1002);
    assert.equal(usage.completionTokens, 1);
    assert.equal(usage.totalTokens, 1003);
    assert.equal(usage.source, 'estimated');
  });
});
