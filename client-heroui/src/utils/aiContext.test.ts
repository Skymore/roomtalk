// @vitest-environment jsdom

import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_AI_CONTEXT_MESSAGE_LIMIT,
  getStoredAIContextMessageLimit,
  MAX_AI_CONTEXT_MESSAGE_LIMIT,
  normalizeAIContextMessageLimit,
  saveStoredAIContextMessageLimit,
} from './aiContext';

describe('aiContext settings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to 100 and clamps values to 0 through 1000', () => {
    expect(normalizeAIContextMessageLimit(undefined)).toBe(DEFAULT_AI_CONTEXT_MESSAGE_LIMIT);
    expect(normalizeAIContextMessageLimit(0)).toBe(0);
    expect(normalizeAIContextMessageLimit(-1)).toBe(0);
    expect(normalizeAIContextMessageLimit(1001)).toBe(MAX_AI_CONTEXT_MESSAGE_LIMIT);
  });

  it('persists the local AI context message limit', () => {
    saveStoredAIContextMessageLimit(0);
    expect(getStoredAIContextMessageLimit()).toBe(0);

    saveStoredAIContextMessageLimit(2500);
    expect(getStoredAIContextMessageLimit()).toBe(MAX_AI_CONTEXT_MESSAGE_LIMIT);
  });
});
