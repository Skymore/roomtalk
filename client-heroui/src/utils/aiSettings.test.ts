// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  defaultRoomAISettings,
  getStoredRoomAISettings,
  saveRoomAISettings,
  updateStoredRoomAISettings,
} from './aiSettings';
import { MAX_AI_CONTEXT_MESSAGE_LIMIT } from './aiContext';

describe('room AI settings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults per room without reading legacy global model or context keys', () => {
    localStorage.setItem('roomtalk:selected-ai-model', 'gpt-5.5');
    localStorage.setItem('roomtalk:ai-context-message-limit', '1');

    expect(getStoredRoomAISettings('room-a', defaultRoomAISettings('deepseek-v4-pro'))).toEqual({
      selectedRoleId: 'default',
      selectedModel: 'deepseek-v4-pro',
      maxContextMessages: 100,
    });
  });

  it('stores independent settings per room', () => {
    saveRoomAISettings('room-a', {
      selectedRoleId: 'a2ui-demo',
      selectedModel: 'deepseek-v4-pro',
      maxContextMessages: 1,
    });
    saveRoomAISettings('room-b', {
      selectedRoleId: 'coder',
      selectedModel: 'claude-sonnet-5',
      maxContextMessages: 20,
    });

    expect(getStoredRoomAISettings('room-a').selectedRoleId).toBe('a2ui-demo');
    expect(getStoredRoomAISettings('room-a').maxContextMessages).toBe(1);
    expect(getStoredRoomAISettings('room-b').selectedModel).toBe('claude-sonnet-5');
  });

  it('normalizes partial updates and clamps context limits', () => {
    const updated = updateStoredRoomAISettings('room-a', {
      selectedModel: 'gpt-5.5',
      maxContextMessages: 9999,
    }, defaultRoomAISettings('deepseek-v4-pro'));

    expect(updated).toEqual({
      selectedRoleId: 'default',
      selectedModel: 'gpt-5.5',
      maxContextMessages: MAX_AI_CONTEXT_MESSAGE_LIMIT,
    });
    expect(getStoredRoomAISettings('room-a').maxContextMessages).toBe(MAX_AI_CONTEXT_MESSAGE_LIMIT);
  });
});
