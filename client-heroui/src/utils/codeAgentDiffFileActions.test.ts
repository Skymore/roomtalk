import { describe, expect, it, vi } from 'vitest';
import { openCodeAgentDiffFilePrimaryAction } from './codeAgentDiffFileActions';

describe('openCodeAgentDiffFilePrimaryAction', () => {
  it('opens diff files in the workspace file viewer when available', () => {
    const openInWorkspaceFileViewer = vi.fn();
    const openFallback = vi.fn();

    openCodeAgentDiffFilePrimaryAction({
      filePath: ' src/App.tsx ',
      openInWorkspaceFileViewer,
      openFallback,
    });

    expect(openInWorkspaceFileViewer).toHaveBeenCalledWith('src/App.tsx');
    expect(openFallback).not.toHaveBeenCalled();
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
