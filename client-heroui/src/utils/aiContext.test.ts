// @vitest-environment jsdom

import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_AI_CONTEXT_MESSAGE_LIMIT,
  MAX_AI_CONTEXT_MESSAGE_LIMIT,
  normalizeAIContextMessageLimit,
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

  it('falls back for invalid values', () => {
    expect(normalizeAIContextMessageLimit('')).toBe(DEFAULT_AI_CONTEXT_MESSAGE_LIMIT);
    expect(normalizeAIContextMessageLimit('12')).toBe(12);
    expect(normalizeAIContextMessageLimit('12.9')).toBe(12);
  });
});
