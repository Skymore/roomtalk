// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { getRoomAIRequestSettings, getRoomAIRequestSettingsForKind, selectRoomAIRequestSettings } from './aiRequestSettings';

describe('AI request settings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('resolves current room role, model, and context settings', () => {
    localStorage.setItem('aiRoles', JSON.stringify([
      { id: 'default', name: 'Assistant', systemPrompt: 'You are helpful', color: 'secondary', icon: 'lucide:bot' },
      { id: 'coder', name: 'Code Expert', systemPrompt: 'Review code', color: 'primary', icon: 'lucide:code' },
    ]));
    localStorage.setItem('roomtalk:ai-settings:room-1', JSON.stringify({
      selectedRoleId: 'coder',
      selectedModel: 'deepseek-v4-pro',
      maxContextMessages: 1,
    }));

    expect(getRoomAIRequestSettings('room-1')).toEqual({
      systemPrompt: 'Review code',
      roleName: 'Code Expert',
      model: 'deepseek-v4-pro',
      maxContextMessages: 1,
    });
  });

  it('falls back to the default role and supplied default model', () => {
    expect(getRoomAIRequestSettings('new-room', 'deepseek-v4-pro')).toMatchObject({
      roleName: 'Assistant',
      model: 'deepseek-v4-pro',
      maxContextMessages: 100,
    });
  });

  it('keeps ordinary role prompts for chat rooms and strips them for code-agent rooms', () => {
    const settings = {
      systemPrompt: 'Use A2UI',
      roleName: 'A2UI Demo',
      model: 'deepseek-v4-pro',
      maxContextMessages: 2,
    };

    expect(selectRoomAIRequestSettings(settings, 'chat')).toEqual(settings);
    expect(selectRoomAIRequestSettings(settings, 'codeAgent')).toEqual({
      model: 'deepseek-v4-pro',
      maxContextMessages: 2,
    });
  });

  it('resolves code-agent room request settings without ordinary role prompts', () => {
    localStorage.setItem('aiRoles', JSON.stringify([
      { id: 'default', name: 'Assistant', systemPrompt: 'You are helpful', color: 'secondary', icon: 'lucide:bot' },
      { id: 'coder', name: 'Code Expert', systemPrompt: 'Review code', color: 'primary', icon: 'lucide:code' },
    ]));
    localStorage.setItem('roomtalk:ai-settings:code-agent-room', JSON.stringify({
      selectedRoleId: 'coder',
      selectedModel: 'deepseek-v4-pro',
      maxContextMessages: 1,
    }));

    expect(getRoomAIRequestSettingsForKind('code-agent-room', 'codeAgent')).toEqual({
      model: 'deepseek-v4-pro',
      maxContextMessages: 1,
    });
  });
});
