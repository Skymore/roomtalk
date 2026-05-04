import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateAICost, createAIModelRegistry, DEFAULT_AI_MODEL_ID, isPremiumAIModel, normalizeUsage, parseAIModelOptions } from './aiModels';
import { AIModelOption, AIUsage } from '../types';

describe('AI model registry', () => {
  it('keeps the configured default first and deduplicates configured models', () => {
    const models = parseAIModelOptions('custom/model', 'gpt-5.5, custom/model, gpt-5.5');

    assert.equal(models[0].id, 'custom/model');
    assert.equal(models[0].isDefault, true);
    assert.equal(models.filter(model => model.id === 'gpt-5.5').length, 1);
  });

  it('normalizes by id or api model and falls back to the default', () => {
    const registry = createAIModelRegistry({ defaultModelId: 'gpt-5.5' });

    assert.equal(registry.normalizeAIModel('openai/gpt-5.5').id, 'gpt-5.5');
    assert.equal(registry.normalizeAIModel('not-allowed').id, 'gpt-5.5');
  });

  it('uses DeepSeek V4 Pro as the built-in default and flags premium model families', () => {
    const registry = createAIModelRegistry();

    assert.equal(DEFAULT_AI_MODEL_ID, 'deepseek-v4-pro');
    assert.equal(registry.defaultModel.id, 'deepseek-v4-pro');
    assert.equal(registry.getAIModelResponse().defaultModel, 'deepseek-v4-pro');
    assert.equal(registry.modelOptions.find(model => model.id === 'gpt-5.5')?.isPremium, true);
    assert.equal(registry.modelOptions.find(model => model.id === 'claude-opus-4.7')?.isPremium, true);
    assert.equal(registry.modelOptions.find(model => model.id === '~google/gemini-pro-latest')?.isPremium, true);
    assert.equal(registry.modelOptions.find(model => model.id === 'deepseek-v4-pro')?.isPremium, false);
    assert.equal(isPremiumAIModel({ id: 'custom-gpt', apiModel: 'openai/custom-gpt', label: 'Custom GPT' }), true);
  });
});

describe('calculateAICost', () => {
  it('uses cached input pricing when reported', () => {
    const registry = createAIModelRegistry({ defaultModelId: 'gpt-5.5' });
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
    const registry = createAIModelRegistry({ defaultModelId: 'gpt-5.5' });
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
