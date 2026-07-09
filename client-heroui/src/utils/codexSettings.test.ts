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

  it('follows the Codex default model per room', () => {
    expect(getStoredRoomCodexSettings('room-a')).toEqual({
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      permissionMode: 'approveForMe',
      serviceTier: 'default',
    });
  });

  it('stores independent settings per room', () => {
    saveRoomCodexSettings('room-a', {
      model: 'gpt-5.4-mini',
      reasoningEffort: 'low',
      permissionMode: 'edit',
      serviceTier: 'priority',
    });
    saveRoomCodexSettings('room-b', {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      permissionMode: 'fullAccess',
      serviceTier: 'priority',
    });

    expect(getStoredRoomCodexSettings('room-a')).toEqual({
      model: 'gpt-5.4-mini',
      reasoningEffort: 'low',
      permissionMode: 'edit',
      serviceTier: 'default',
    });
    expect(getStoredRoomCodexSettings('room-b')).toEqual({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      permissionMode: 'fullAccess',
      serviceTier: 'priority',
    });
  });

  it('normalizes unknown models and reasoning efforts', () => {
    const updated = updateStoredRoomCodexSettings('room-a', {
      model: 'unknown-model',
      reasoningEffort: 'invalid' as never,
      permissionMode: 'invalid' as never,
      serviceTier: 'invalid' as never,
    }, defaultCodexRunSettings());

    expect(updated).toEqual({
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      permissionMode: 'approveForMe',
      serviceTier: 'default',
    });
  });
});
