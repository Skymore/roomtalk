// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import {
  readCodeAgentChangedFilesExpanded,
  resetCodeAgentChangedFilesExpansionStoreForTests,
  setCodeAgentChangedFilesExpanded,
} from './codeAgentChangedFilesExpansionStore';

const STORAGE_KEY = 'roomtalk.codeAgent.changedFilesExpanded.v1';

describe('codeAgentChangedFilesExpansionStore', () => {
  afterEach(() => {
    localStorage.clear();
    resetCodeAgentChangedFilesExpansionStoreForTests();
  });

  it('defaults changed-file scopes to expanded', () => {
    expect(readCodeAgentChangedFilesExpanded('room-1', 'ready:1:branch:auto')).toBe(true);
  });

  it('persists collapsed scopes by room and workspace scope', () => {
    setCodeAgentChangedFilesExpanded(' room-1 ', ' ready:1:branch:auto ', false);

    expect(readCodeAgentChangedFilesExpanded('room-1', 'ready:1:branch:auto')).toBe(false);
    expect(readCodeAgentChangedFilesExpanded('room-1', 'ready:2:branch:auto')).toBe(true);
    expect(readCodeAgentChangedFilesExpanded('room-2', 'ready:1:branch:auto')).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')).toEqual({
      'room-1': {
        'ready:1:branch:auto': false,
      },
    });
  });

  it('removes scopes from storage when expanded again', () => {
    setCodeAgentChangedFilesExpanded('room-1', 'ready:1:branch:auto', false);
    setCodeAgentChangedFilesExpanded('room-1', 'ready:1:unstaged', false);

    setCodeAgentChangedFilesExpanded('room-1', 'ready:1:branch:auto', true);

    expect(readCodeAgentChangedFilesExpanded('room-1', 'ready:1:branch:auto')).toBe(true);
    expect(readCodeAgentChangedFilesExpanded('room-1', 'ready:1:unstaged')).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')).toEqual({
      'room-1': {
        'ready:1:unstaged': false,
      },
    });

    setCodeAgentChangedFilesExpanded('room-1', 'ready:1:unstaged', true);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('sanitizes persisted expansion state', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      'room-1': {
        valid: false,
        ignoredTrue: true,
        ignoredText: 'false',
      },
      'room-2': null,
      ' ': { invalid: false },
    }));
    resetCodeAgentChangedFilesExpansionStoreForTests();

    expect(readCodeAgentChangedFilesExpanded('room-1', 'valid')).toBe(false);
    expect(readCodeAgentChangedFilesExpanded('room-1', 'ignoredTrue')).toBe(true);
    expect(readCodeAgentChangedFilesExpanded('room-1', 'ignoredText')).toBe(true);
  });
});
