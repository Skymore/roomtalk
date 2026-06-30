// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeAgentWorkspaceDiffViewer } from './CodeAgentWorkspaceDiffViewer';

const loadCodeAgentWorkspaceDiffMock = vi.hoisted(() => vi.fn());
const parsePatchFilesMock = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../utils/cocoWorkspace', () => ({
  loadCodeAgentWorkspaceDiff: loadCodeAgentWorkspaceDiffMock,
}));

vi.mock('@pierre/diffs', () => ({
  parsePatchFiles: parsePatchFilesMock,
}));

vi.mock('@pierre/diffs/react', () => ({
  CodeView: ({
    items,
    options,
    renderHeaderPrefix,
  }: {
    items: Array<{ id: string; type: 'diff'; fileDiff: { name: string }; collapsed?: boolean }>;
    options: { diffStyle: 'unified' | 'split'; overflow: 'scroll' | 'wrap' };
    renderHeaderPrefix?: (item: { id: string; type: 'diff'; fileDiff: { name: string }; collapsed?: boolean }) => ReactNode;
  }) => (
    <div data-testid="code-view" data-diff-style={options.diffStyle} data-overflow={options.overflow}>
      {items.map((item) => (
        <div key={item.id} data-testid={`diff-file-${item.fileDiff.name}`} data-collapsed={String(item.collapsed === true)}>
          {renderHeaderPrefix?.(item)}
          <span>{item.fileDiff.name}</span>
        </div>
      ))}
    </div>
  ),
}));

describe('CodeAgentWorkspaceDiffViewer', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    loadCodeAgentWorkspaceDiffMock.mockReset();
    parsePatchFilesMock.mockReset();
    localStorage.clear();
  });

  it('loads a workspace patch and renders it through the Pierre CodeView', async () => {
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'diff --git a/src/App.tsx b/src/App.tsx\n',
      byteSize: 42,
      truncated: false,
    });
    parsePatchFilesMock.mockReturnValue([
      {
        files: [
          { name: 'src/App.tsx', hunks: [], additionLines: [], deletionLines: [], type: 'modify' },
        ],
      },
    ]);

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    expect(await screen.findByTestId('code-view')).toBeTruthy();
    expect(screen.getByText('src/App.tsx')).toBeTruthy();
    expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenCalledWith('room-1', expect.any(Object));
    expect(parsePatchFilesMock).toHaveBeenCalledWith(
      'diff --git a/src/App.tsx b/src/App.tsx\n',
      'workspace:room-1:snapshot-1',
      false,
    );
    expect(screen.getByTestId('code-view').dataset.overflow).toBe('scroll');
    expect(screen.getByTestId('code-view').dataset.diffStyle).toBe('unified');
  });

  it('toggles T3-style diff line wrapping and persists the preference', async () => {
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'diff --git a/src/App.tsx b/src/App.tsx\n',
      byteSize: 42,
      truncated: false,
    });
    parsePatchFilesMock.mockReturnValue([
      {
        files: [
          { name: 'src/App.tsx', hunks: [], additionLines: [], deletionLines: [], type: 'modify' },
        ],
      },
    ]);

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    expect((await screen.findByTestId('code-view')).dataset.overflow).toBe('scroll');
    fireEvent.click(screen.getByLabelText('codeAgentEnableDiffLineWrapping'));

    expect(screen.getByTestId('code-view').dataset.overflow).toBe('wrap');
    expect(localStorage.getItem('roomtalk.codeWorkspace.diffWordWrap')).toBe('true');
    expect(screen.getByLabelText('codeAgentDisableDiffLineWrapping')).toBeTruthy();
  });

  it('toggles T3-style whitespace filtering and reloads the workspace patch', async () => {
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'diff --git a/src/App.tsx b/src/App.tsx\n',
      byteSize: 42,
      truncated: false,
    });
    parsePatchFilesMock.mockReturnValue([
      {
        files: [
          { name: 'src/App.tsx', hunks: [], additionLines: [], deletionLines: [], type: 'modify' },
        ],
      },
    ]);

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    expect(await screen.findByTestId('code-view')).toBeTruthy();
    expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenLastCalledWith(
      'room-1',
      expect.objectContaining({ ignoreWhitespace: false }),
    );

    fireEvent.click(screen.getByLabelText('codeAgentHideWhitespaceChanges'));

    await waitFor(() => {
      expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenCalledTimes(2);
    });
    expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenLastCalledWith(
      'room-1',
      expect.objectContaining({ ignoreWhitespace: true }),
    );
    expect(localStorage.getItem('roomtalk.codeWorkspace.diffIgnoreWhitespace')).toBe('true');
    expect(screen.getByLabelText('codeAgentShowWhitespaceChanges').getAttribute('aria-pressed')).toBe('true');
  });

  it('toggles T3-style file diff collapsing through the CodeView header prefix', async () => {
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'diff --git a/src/App.tsx b/src/App.tsx\n',
      byteSize: 42,
      truncated: false,
    });
    parsePatchFilesMock.mockReturnValue([
      {
        files: [
          { name: 'src/App.tsx', hunks: [], additionLines: [], deletionLines: [], type: 'change' },
          { name: 'src/utils.ts', hunks: [], additionLines: [], deletionLines: [], type: 'new' },
        ],
      },
    ]);

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    expect((await screen.findByTestId('diff-file-src/App.tsx')).getAttribute('data-collapsed')).toBe('false');
    expect(screen.getByTestId('diff-file-src/utils.ts').getAttribute('data-collapsed')).toBe('false');

    fireEvent.click(screen.getAllByLabelText('codeAgentCollapseDiffFile')[0]);

    expect(screen.getByTestId('diff-file-src/App.tsx').getAttribute('data-collapsed')).toBe('true');
    expect(screen.getByTestId('diff-file-src/utils.ts').getAttribute('data-collapsed')).toBe('false');
    expect(screen.getByLabelText('codeAgentExpandDiffFile').getAttribute('aria-expanded')).toBe('false');
  });

  it('toggles T3-style stacked and split diff rendering and persists the preference', async () => {
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'diff --git a/src/App.tsx b/src/App.tsx\n',
      byteSize: 42,
      truncated: false,
    });
    parsePatchFilesMock.mockReturnValue([
      {
        files: [
          { name: 'src/App.tsx', hunks: [], additionLines: [], deletionLines: [], type: 'modify' },
        ],
      },
    ]);

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    expect((await screen.findByTestId('code-view')).dataset.diffStyle).toBe('unified');
    fireEvent.click(screen.getByLabelText('codeAgentSplitDiffView'));

    expect(screen.getByTestId('code-view').dataset.diffStyle).toBe('split');
    expect(localStorage.getItem('roomtalk.codeWorkspace.diffRenderMode')).toBe('split');
    expect(screen.getByLabelText('codeAgentSplitDiffView').getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByLabelText('codeAgentStackedDiffView'));

    expect(screen.getByTestId('code-view').dataset.diffStyle).toBe('unified');
    expect(localStorage.getItem('roomtalk.codeWorkspace.diffRenderMode')).toBe('stacked');
  });

  it('does not request the patch until the changes tab enables it', async () => {
    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled={false} />);

    await waitFor(() => {
      expect(loadCodeAgentWorkspaceDiffMock).not.toHaveBeenCalled();
    });
    expect(screen.queryByTestId('code-view')).toBeNull();
  });
});
