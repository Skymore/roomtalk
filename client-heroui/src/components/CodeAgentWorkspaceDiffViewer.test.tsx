// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeAgentWorkspaceDiffViewer } from './CodeAgentWorkspaceDiffViewer';

const loadCodeAgentWorkspaceDiffMock = vi.hoisted(() => vi.fn());
const parsePatchFilesMock = vi.hoisted(() => vi.fn());
const codeViewScrollToMock = vi.hoisted(() => vi.fn());

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
  CodeView: React.forwardRef(({
    items,
    options,
    renderHeaderPrefix,
  }: {
    items: Array<{ id: string; type: 'diff'; fileDiff: { name?: string | null; prevName?: string | null; cacheKey?: string }; collapsed?: boolean }>;
    options: { diffStyle: 'unified' | 'split'; overflow: 'scroll' | 'wrap' };
    renderHeaderPrefix?: (item: { id: string; type: 'diff'; fileDiff: { name?: string | null; prevName?: string | null; cacheKey?: string }; collapsed?: boolean }) => ReactNode;
  }, ref) => {
    React.useImperativeHandle(ref, () => ({ scrollTo: codeViewScrollToMock }));
    return (
      <div data-testid="code-view" data-diff-style={options.diffStyle} data-overflow={options.overflow}>
        {items.map((item) => {
          const title = item.fileDiff.prevName && item.fileDiff.name
            ? `${item.fileDiff.prevName.replace(/^[ab]\//, '')} → ${item.fileDiff.name.replace(/^[ab]\//, '')}`
            : item.fileDiff.name ?? item.fileDiff.prevName ?? 'diff';
          return (
            <div key={item.id} data-testid={`diff-file-${item.id}`} data-collapsed={String(item.collapsed === true)}>
              {renderHeaderPrefix?.(item)}
              <span data-title>{title}</span>
            </div>
          );
        })}
      </div>
    );
  }),
}));

describe('CodeAgentWorkspaceDiffViewer', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    loadCodeAgentWorkspaceDiffMock.mockReset();
    parsePatchFilesMock.mockReset();
    codeViewScrollToMock.mockReset();
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
      'diff --git a/src/App.tsx b/src/App.tsx',
      expect.stringMatching(/^workspace:room-1:snapshot-1:(light|dark):\d+:/),
    );
    expect(screen.getByTestId('code-view').dataset.overflow).toBe('scroll');
    expect(screen.getByTestId('code-view').dataset.diffStyle).toBe('unified');
  });

  it('falls back to the T3 raw patch viewer when Pierre cannot parse the workspace diff', async () => {
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'not a git patch\n+but still useful output\n',
      byteSize: 42,
      truncated: false,
    });
    parsePatchFilesMock.mockImplementation(() => {
      throw new Error('bad patch');
    });

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    expect((await screen.findByTestId('code-agent-workspace-raw-diff')).textContent).toBe('not a git patch\n+but still useful output');
    expect(screen.getByText('Failed to parse patch. Showing raw patch.')).toBeTruthy();
    expect(screen.queryByTestId('code-view')).toBeNull();
  });

  it('falls back to the T3 raw patch viewer when a parsed patch has no files', async () => {
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'plain output',
      byteSize: 12,
      truncated: false,
    });
    parsePatchFilesMock.mockReturnValue([{ files: [] }]);

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    expect((await screen.findByTestId('code-agent-workspace-raw-diff')).textContent).toBe('plain output');
    expect(screen.getByText('Unsupported diff format. Showing raw patch.')).toBeTruthy();
    expect(screen.queryByTestId('code-view')).toBeNull();
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

    expect((await screen.findByTestId('diff-file-none:src/App.tsx')).getAttribute('data-collapsed')).toBe('false');
    expect(screen.getByTestId('diff-file-none:src/utils.ts').getAttribute('data-collapsed')).toBe('false');

    fireEvent.click(screen.getAllByLabelText('codeAgentCollapseDiffFile')[0]);

    expect(screen.getByTestId('diff-file-none:src/App.tsx').getAttribute('data-collapsed')).toBe('true');
    expect(screen.getByTestId('diff-file-none:src/utils.ts').getAttribute('data-collapsed')).toBe('false');
    expect(screen.getByLabelText('codeAgentExpandDiffFile').getAttribute('aria-expanded')).toBe('false');
  });

  it('opens a diff file through the T3 title click action', async () => {
    const onOpenFile = vi.fn();
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
        ],
      },
    ]);

    render(
      <CodeAgentWorkspaceDiffViewer
        roomId="room-1"
        enabled
        refreshKey="snapshot-1"
        onOpenFile={onOpenFile}
      />,
    );

    fireEvent.click(await screen.findByText('src/App.tsx'));

    expect(onOpenFile).toHaveBeenCalledWith('src/App.tsx');
  });

  it('opens the resolved T3 diff path for renamed files', async () => {
    const onOpenFile = vi.fn();
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'diff --git a/src/Old.tsx b/src/New.tsx\n',
      byteSize: 42,
      truncated: false,
    });
    parsePatchFilesMock.mockReturnValue([
      {
        files: [
          {
            prevName: 'a/src/Old.tsx',
            name: 'b/src/New.tsx',
            cacheKey: 'rename:src/New.tsx',
            hunks: [],
            additionLines: [],
            deletionLines: [],
            type: 'rename-changed',
          },
        ],
      },
    ]);

    render(
      <CodeAgentWorkspaceDiffViewer
        roomId="room-1"
        enabled
        refreshKey="snapshot-1"
        onOpenFile={onOpenFile}
      />,
    );

    fireEvent.click(await screen.findByText('src/Old.tsx → src/New.tsx'));

    expect(screen.getByTestId('diff-file-rename:src/New.tsx')).toBeTruthy();
    expect(onOpenFile).toHaveBeenCalledWith('src/New.tsx');
  });

  it('scrolls to a selected changed file like the T3 diff panel', async () => {
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'diff --git a/src/App.tsx b/src/App.tsx\n',
      byteSize: 42,
      truncated: false,
    });
    parsePatchFilesMock.mockReturnValue([
      {
        files: [
          { name: 'src/App.tsx', cacheKey: 'file:app', hunks: [], additionLines: [], deletionLines: [], type: 'change' },
          { name: 'src/utils.ts', cacheKey: 'file:utils', hunks: [], additionLines: [], deletionLines: [], type: 'change' },
        ],
      },
    ]);

    const { rerender } = render(
      <CodeAgentWorkspaceDiffViewer
        roomId="room-1"
        enabled
        refreshKey="snapshot-1"
        selectedFilePath="src/utils.ts"
        selectedFileRevealRequestId={1}
      />,
    );

    await waitFor(() => {
      expect(codeViewScrollToMock).toHaveBeenCalledWith({ type: 'item', id: 'file:utils', align: 'start' });
    });

    codeViewScrollToMock.mockClear();
    rerender(
      <CodeAgentWorkspaceDiffViewer
        roomId="room-1"
        enabled
        refreshKey="snapshot-1"
        selectedFilePath="src/App.tsx"
        selectedFileRevealRequestId={2}
      />,
    );

    expect(codeViewScrollToMock).toHaveBeenCalledWith({ type: 'item', id: 'file:app', align: 'start' });
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
