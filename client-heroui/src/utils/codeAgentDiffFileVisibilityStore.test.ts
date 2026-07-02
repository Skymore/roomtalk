// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readCodeAgentDiffFileVisibility,
  removeCodeAgentDiffFileVisibilityScope,
  resetCodeAgentDiffFileVisibilityStoreForTests,
  updateCodeAgentDiffFileVisibility,
} from './codeAgentDiffFileVisibilityStore';

describe('codeAgentDiffFileVisibilityStore', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCodeAgentDiffFileVisibilityStoreForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    resetCodeAgentDiffFileVisibilityStoreForTests();
  });

  it('persists diff file visibility by room and diff scope', () => {
    updateCodeAgentDiffFileVisibility('room-1:branch:auto', () => ({
      collapsedFileKeys: ['file:app', 'file:app', ''],
      viewedFileKeys: ['file:utils'],
      revealedLargeFileKeys: ['file:big'],
    }));

    expect(readCodeAgentDiffFileVisibility('room-1:branch:auto')).toEqual({
      collapsedFileKeys: ['file:app'],
      viewedFileKeys: ['file:utils'],
      revealedLargeFileKeys: ['file:big'],
    });
    expect(JSON.parse(localStorage.getItem('roomtalk.codeWorkspace.diffFileVisibility.v1') || '{}')).toMatchObject({
      version: 1,
      state: {
        byScopeKey: {
          'room-1:branch:auto': {
            collapsedFileKeys: ['file:app'],
            viewedFileKeys: ['file:utils'],
            revealedLargeFileKeys: ['file:big'],
          },
        },
      },
    });
  });

  it('keeps visibility isolated per scope and removes stale scopes', () => {
    updateCodeAgentDiffFileVisibility('room-1:branch:auto', () => ({
      collapsedFileKeys: ['file:branch'],
      viewedFileKeys: [],
      revealedLargeFileKeys: [],
    }));
    updateCodeAgentDiffFileVisibility('room-1:unstaged:working-tree', () => ({
      collapsedFileKeys: ['file:working-tree'],
      viewedFileKeys: [],
      revealedLargeFileKeys: [],
    }));

    expect(readCodeAgentDiffFileVisibility('room-1:branch:auto').collapsedFileKeys).toEqual(['file:branch']);
    expect(readCodeAgentDiffFileVisibility('room-1:unstaged:working-tree').collapsedFileKeys).toEqual(['file:working-tree']);

    removeCodeAgentDiffFileVisibilityScope('room-1:branch:auto');

    expect(readCodeAgentDiffFileVisibility('room-1:branch:auto').collapsedFileKeys).toEqual([]);
    expect(readCodeAgentDiffFileVisibility('room-1:unstaged:working-tree').collapsedFileKeys).toEqual(['file:working-tree']);
  });
});
