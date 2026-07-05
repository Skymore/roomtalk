import { describe, expect, it } from 'vitest';
import { FALLBACK_FEATURE_FLAGS, FeatureFlags } from './features';
import {
  getCodeAgentBackend,
  getCodeAgentAvailableModes,
  getCodeAgentDefaultMode,
  getCodeAgentMode,
  getCodeAgentStatus,
  isCodeAgentRoom,
  isSupportedCodeAgentBackend,
} from './codeAgent';
import { Room } from './types';

const room = (overrides: Partial<Room> = {}): Room => ({
  id: 'room-1',
  name: 'Room',
  creatorId: 'client-1',
  createdAt: '2026-05-26T00:00:00.000Z',
  ...overrides,
});

describe('codeAgent room adapters', () => {
  it('leaves ordinary chat rooms outside the code-agent path', () => {
    const chatRoom = room({ type: 'chat' });

    expect(isCodeAgentRoom(chatRoom)).toBe(false);
    expect(getCodeAgentBackend(chatRoom)).toBeNull();
    expect(getCodeAgentStatus(chatRoom)).toBeUndefined();
    expect(isCodeAgentRoom(null)).toBe(false);
    expect(isCodeAgentRoom(undefined)).toBe(false);
    expect(getCodeAgentStatus(null)).toBeUndefined();
    expect(getCodeAgentBackend(room({ type: 'unknown' as Room['type'] }))).toBeNull();
  });

  it('adapts persisted code-agent rooms to the generic code-agent model', () => {
    const codeAgentRoom = room({ type: 'codeAgent', codeAgentStatus: 'running' });

    expect(isCodeAgentRoom(codeAgentRoom)).toBe(true);
    expect(getCodeAgentBackend(codeAgentRoom)).toBe('code-agent');
    expect(getCodeAgentStatus(codeAgentRoom)).toBe('running');
    expect(getCodeAgentStatus(room({ type: 'codeAgent' }))).toBe('idle');
  });

  it('reads code-agent mode from feature/config state', () => {
    expect(getCodeAgentMode(FALLBACK_FEATURE_FLAGS)).toBe('plan');
    const editCapableFlags: FeatureFlags = {
      codeAgent: {
        enabled: true,
        mode: 'acceptEdits',
        availableModes: ['plan', 'acceptEdits'],
        defaultMode: 'plan',
      },
      codex: {
        connections: {
          enabled: false,
        },
      },
    };
    expect(getCodeAgentMode(editCapableFlags)).toBe('edit');
    expect(getCodeAgentAvailableModes(editCapableFlags)).toEqual(['plan', 'edit']);
    expect(getCodeAgentDefaultMode(editCapableFlags)).toBe('plan');
  });

  it('recognizes Codex-backed code-agent rooms as supported', () => {
    const unsupportedRoom = room({ type: 'codex' as Room['type'] });
    const legacyCodexAppRoom = room({ type: 'codex' as Room['type'], codeAgentBackend: 'codex-app-server' });
    const codeAgentCodexRoom = room({ type: 'codeAgent', codeAgentBackend: 'codex', codeAgentStatus: 'running' });
    const codeAgentCodexAppRoom = room({ type: 'codeAgent', codeAgentBackend: 'codex-app-server' });

    expect(isCodeAgentRoom(unsupportedRoom)).toBe(true);
    expect(getCodeAgentBackend(unsupportedRoom)).toBe('codex');
    expect(getCodeAgentBackend(legacyCodexAppRoom)).toBe('codex-app-server');
    expect(isSupportedCodeAgentBackend('codex')).toBe(true);
    expect(isSupportedCodeAgentBackend('codex-app-server')).toBe(true);
    expect(isSupportedCodeAgentBackend('code-agent')).toBe(true);
    expect(getCodeAgentStatus(unsupportedRoom)).toBe('idle');
    expect(getCodeAgentBackend(codeAgentCodexRoom)).toBe('codex');
    expect(getCodeAgentBackend(codeAgentCodexAppRoom)).toBe('codex-app-server');
    expect(getCodeAgentStatus(codeAgentCodexRoom)).toBe('running');
  });
});
