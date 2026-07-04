// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  defaultCodexRunSettings,
  getStoredRoomCodexSettings,
  saveRoomCodexSettings,
  updateStoredRoomCodexSettings,
} from './codexSettings';

describe('room Codex settings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to GPT-5.5 Extra High per room', () => {
    expect(getStoredRoomCodexSettings('room-a')).toEqual({
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      permissionMode: 'approveForMe',
    });
  });

  it('stores independent settings per room', () => {
    saveRoomCodexSettings('room-a', {
      model: 'gpt-5.4-mini',
      reasoningEffort: 'low',
      permissionMode: 'edit',
    });
    saveRoomCodexSettings('room-b', {
      model: 'gpt-5.3-codex-spark',
      reasoningEffort: 'high',
      permissionMode: 'fullAccess',
    });

    expect(getStoredRoomCodexSettings('room-a')).toEqual({
      model: 'gpt-5.4-mini',
      reasoningEffort: 'low',
      permissionMode: 'edit',
    });
    expect(getStoredRoomCodexSettings('room-b')).toEqual({
      model: 'gpt-5.3-codex-spark',
      reasoningEffort: 'high',
      permissionMode: 'fullAccess',
    });
  });

  it('normalizes unknown models and reasoning efforts', () => {
    const updated = updateStoredRoomCodexSettings('room-a', {
      model: 'unknown-model',
      reasoningEffort: 'invalid' as never,
      permissionMode: 'invalid' as never,
    }, defaultCodexRunSettings());

    expect(updated).toEqual({
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      permissionMode: 'approveForMe',
    });
  });
});
