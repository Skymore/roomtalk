// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openCodeAgentDiffFilePrimaryAction } from './codeAgentDiffFileActions';
import {
  readCodeAgentRightPanelState,
  resetCodeAgentRightPanelStoreForTests,
} from './codeAgentRightPanelStore';

describe('openCodeAgentDiffFilePrimaryAction', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCodeAgentRightPanelStoreForTests();
  });

  afterEach(() => {
    localStorage.clear();
    resetCodeAgentRightPanelStoreForTests();
  });

  it('opens diff files in the right panel file viewer like T3 when a room is available', () => {
    const openInWorkspaceFileViewer = vi.fn();
    const openFallback = vi.fn();

    openCodeAgentDiffFilePrimaryAction({
      roomId: ' room-1 ',
      filePath: ' src/App.tsx#L12 ',
      openInWorkspaceFileViewer,
      openFallback,
    });

    expect(readCodeAgentRightPanelState('room-1')).toMatchObject({
      isOpen: true,
      activeSurfaceId: 'file:src/App.tsx',
      surfaces: [
        {
          id: 'file:src/App.tsx',
          kind: 'file',
          relativePath: 'src/App.tsx',
          revealLine: 12,
        },
      ],
    });
    expect(openInWorkspaceFileViewer).not.toHaveBeenCalled();
    expect(openFallback).not.toHaveBeenCalled();
  });

  it('opens through the workspace viewer callback when no right panel room is available', () => {
    const openInWorkspaceFileViewer = vi.fn();

    openCodeAgentDiffFilePrimaryAction({
      filePath: ' src/App.tsx#L7 ',
      openInWorkspaceFileViewer,
    });

    expect(openInWorkspaceFileViewer).toHaveBeenCalledWith('src/App.tsx#L7');
  });

  it('falls back when the right file viewer is not wired for the surface', () => {
    const openFallback = vi.fn();

    openCodeAgentDiffFilePrimaryAction({
      filePath: 'src/App.tsx',
      openFallback,
    });

    expect(openFallback).toHaveBeenCalledWith('src/App.tsx');
  });

  it('ignores empty diff paths', () => {
    const openInWorkspaceFileViewer = vi.fn();
    const openFallback = vi.fn();

    openCodeAgentDiffFilePrimaryAction({
      filePath: '   ',
      openInWorkspaceFileViewer,
      openFallback,
    });

    expect(openInWorkspaceFileViewer).not.toHaveBeenCalled();
    expect(openFallback).not.toHaveBeenCalled();
  });
});
