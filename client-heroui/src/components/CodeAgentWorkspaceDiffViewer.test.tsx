// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeAgentWorkspaceDiffViewer } from './CodeAgentWorkspaceDiffViewer';
import {
  readCodeAgentDiffPanelSelection,
  resetCodeAgentDiffPanelStoreForTests,
  selectCodeAgentDiffScope,
} from '../utils/codeAgentDiffPanelStore';
import { fnv1a32 } from '../utils/codeAgentDiffRendering';
import type { ReviewCommentContext } from '../utils/codeAgentReviewComments';

const loadCodeAgentWorkspaceDiffMock = vi.hoisted(() => vi.fn());
const loadCodeAgentWorkspaceRefsMock = vi.hoisted(() => vi.fn());
const parsePatchFilesMock = vi.hoisted(() => vi.fn());
const codeViewScrollToMock = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (
      params?.range ? `${key}:${params.range}` : key
    ),
  }),
}));

vi.mock('../utils/cocoWorkspace', () => ({
  loadCodeAgentWorkspaceDiff: loadCodeAgentWorkspaceDiffMock,
  loadCodeAgentWorkspaceRefs: loadCodeAgentWorkspaceRefsMock,
}));

vi.mock('@pierre/diffs', () => ({
  parsePatchFiles: parsePatchFilesMock,
}));

vi.mock('@pierre/diffs/react', () => ({
  CodeView: React.forwardRef(({
    items,
    options,
    className,
    renderHeaderPrefix,
    renderAnnotation,
  }: {
    items: Array<{
      id: string;
      type: 'diff';
      fileDiff: { name?: string | null; prevName?: string | null; cacheKey?: string };
      collapsed?: boolean;
      version?: number;
      annotations?: Array<{ side: 'additions' | 'deletions'; lineNumber: number; metadata: { entries: Array<{ id: string; kind: 'draft' | 'comment'; rangeLabel: string; text: string }> } }>;
    }>;
    options: {
      diffStyle: 'unified' | 'split';
      lineDiffType?: 'none' | 'word' | 'word-alt' | 'char';
      overflow: 'scroll' | 'wrap';
      enableLineSelection?: boolean;
      onLineSelectionEnd?: (range: { start: number; end: number; side?: 'additions' | 'deletions'; endSide?: 'additions' | 'deletions' }, context: { item: any }) => void;
      stickyHeaders?: boolean;
      unsafeCSS?: string;
      layout?: { paddingTop: number; paddingBottom: number; gap: number };
    };
    className?: string;
    renderHeaderPrefix?: (item: { id: string; type: 'diff'; fileDiff: { name?: string | null; prevName?: string | null; cacheKey?: string }; collapsed?: boolean }) => ReactNode;
    renderAnnotation?: (annotation: { side: 'additions' | 'deletions'; lineNumber: number; metadata: { entries: Array<{ id: string; kind: 'draft' | 'comment'; rangeLabel: string; text: string }> } }) => ReactNode;
  }, ref) => {
    React.useImperativeHandle(ref, () => ({ scrollTo: codeViewScrollToMock }));
    return (
      <div
        data-testid="code-view"
        data-diff-style={options.diffStyle}
        data-line-diff-type={options.lineDiffType || ''}
        data-overflow={options.overflow}
        data-sticky-headers={String(options.stickyHeaders === true)}
        data-layout={options.layout ? `${options.layout.paddingTop}:${options.layout.paddingBottom}:${options.layout.gap}` : ''}
        data-unsafe-css={options.unsafeCSS || ''}
        data-class-name={className || ''}
      >
        {items.map((item) => {
          const title = item.fileDiff.prevName && item.fileDiff.name
            ? `${item.fileDiff.prevName.replace(/^[ab]\//, '')} → ${item.fileDiff.name.replace(/^[ab]\//, '')}`
            : item.fileDiff.name ?? item.fileDiff.prevName ?? 'diff';
          return (
            <div key={item.id} data-diff data-testid={`diff-file-${item.id}`} data-collapsed={String(item.collapsed === true)} data-version={String(item.version ?? '')}>
              {renderHeaderPrefix?.(item)}
              <span data-title>
                <span>{title}</span>
                <span> +2 -1</span>
              </span>
              <button type="button" data-line="42">line 42</button>
              <button type="button" data-column-number="24">gutter 24</button>
              <button
                type="button"
                aria-label={`select diff lines ${item.id}`}
                disabled={!options.enableLineSelection}
                onClick={() => options.onLineSelectionEnd?.({ start: 2, end: 4, side: 'additions', endSide: 'additions' }, { item })}
              >
                select diff lines
              </button>
              <button
                type="button"
                aria-label={`select invalid diff lines ${item.id}`}
                disabled={!options.enableLineSelection}
                onClick={() => options.onLineSelectionEnd?.({ start: 99, end: 100, side: 'additions', endSide: 'additions' }, { item })}
              >
                select invalid diff lines
              </button>
              {item.annotations?.map((annotation) => (
                <div key={`${annotation.side}:${annotation.lineNumber}`} data-testid="diff-line-annotation">
                  {renderAnnotation?.(annotation)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    );
  }),
}));

describe('CodeAgentWorkspaceDiffViewer', () => {
  beforeEach(() => {
    resetCodeAgentDiffPanelStoreForTests();
    loadCodeAgentWorkspaceRefsMock.mockResolvedValue({
      available: true,
      headRef: 'feature/search',
      refs: [],
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    loadCodeAgentWorkspaceDiffMock.mockReset();
    loadCodeAgentWorkspaceRefsMock.mockReset();
    parsePatchFilesMock.mockReset();
    codeViewScrollToMock.mockReset();
    localStorage.clear();
    resetCodeAgentDiffPanelStoreForTests();
  });

  it('renders the T3-style diff loading skeleton while the workspace patch is pending', async () => {
    loadCodeAgentWorkspaceDiffMock.mockReturnValue(new Promise(() => undefined));

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    const loading = await screen.findByTestId('code-agent-workspace-diff-loading');
    const status = screen.getByRole('status', { name: 'codeAgentLoadingBranchDiff' });
    expect(loading.contains(status)).toBe(true);
    expect(screen.getByTestId('code-agent-workspace-diff-viewer').querySelector('[data-surface-subheader]')).toBeTruthy();
    const viewport = screen.getByTestId('code-agent-workspace-diff-viewer').querySelector('.diff-panel-viewport');
    expect(viewport).toBeTruthy();
    expect(viewport?.contains(loading)).toBe(true);
    expect(viewport?.className).not.toContain('gap-2');
    expect(screen.getByTestId('code-agent-workspace-diff-viewer').className).not.toContain('gap-2');
    expect(screen.getByLabelText('codeAgentRefreshWorkspaceDiff')).toBeTruthy();
    expect(loading.querySelectorAll('.animate-pulse').length).toBeGreaterThanOrEqual(7);
    expect(screen.queryByTestId('code-view')).toBeNull();
  });

  it('uses the T3-style working tree loading label for unstaged diffs', async () => {
    selectCodeAgentDiffScope('room-1', 'unstaged');
    loadCodeAgentWorkspaceDiffMock.mockReturnValue(new Promise(() => undefined));

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    expect(await screen.findByRole('status', { name: 'codeAgentLoadingWorkingTreeDiff' })).toBeTruthy();
    expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenCalledWith(
      'room-1',
      expect.objectContaining({ scope: 'unstaged' }),
    );
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

    const codeView = await screen.findByTestId('code-view');
    expect(codeView).toBeTruthy();
    expect(within(codeView).getByText('src/App.tsx')).toBeTruthy();
    expect(screen.getByTestId('code-agent-workspace-diff-viewer').className).toContain('flex-1');
    expect(codeView.dataset.className).toContain('min-h-80');
    expect(codeView.dataset.className).toContain('flex-1');
    expect(codeView.dataset.className).toContain('diff-render-surface');
    expect(codeView.dataset.className?.split(/\s+/)).not.toContain('h-80');
    expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenCalledWith('room-1', expect.any(Object));
    expect(parsePatchFilesMock).toHaveBeenCalledWith(
      'diff --git a/src/App.tsx b/src/App.tsx',
      expect.stringMatching(/^workspace:room-1:snapshot-1:branch:auto:(light|dark):\d+:/),
    );
    expect(screen.getByTestId('code-view').dataset.overflow).toBe('scroll');
    expect(screen.getByTestId('code-view').dataset.diffStyle).toBe('unified');
    expect(screen.getByTestId('code-view').dataset.lineDiffType).toBe('none');
    expect(screen.getByTestId('code-view').dataset.stickyHeaders).toBe('true');
    expect(screen.getByTestId('code-view').dataset.layout).toBe('8:8:8');
    expect(screen.getByTestId('code-view').dataset.unsafeCss).toContain('[data-diffs-header]');
    expect(screen.getByTestId('code-view').dataset.unsafeCss).toContain('[data-title]:hover');
  });

  it('refreshes the T3-style workspace diff and refs from the toolbar', async () => {
    let patchPath = 'src/App.tsx';
    loadCodeAgentWorkspaceDiffMock.mockImplementation(() => Promise.resolve({
      available: true,
      patch: `diff --git a/${patchPath} b/${patchPath}\n`,
      byteSize: 42,
      truncated: false,
    }));
    parsePatchFilesMock.mockImplementation((patch: string) => {
      const path = patch.includes('src/Other.ts') ? 'src/Other.ts' : 'src/App.tsx';
      return [
        {
          files: [
            { name: path, hunks: [], additionLines: [], deletionLines: [], type: 'modify' },
          ],
        },
      ];
    });

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    const codeView = await screen.findByTestId('code-view');
    expect(within(codeView).getByText('src/App.tsx')).toBeTruthy();
    await waitFor(() => {
      expect(loadCodeAgentWorkspaceRefsMock).toHaveBeenCalledTimes(1);
    });

    patchPath = 'src/Other.ts';
    fireEvent.click(screen.getByLabelText('codeAgentRefreshWorkspaceDiff'));

    await waitFor(() => {
      expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(loadCodeAgentWorkspaceRefsMock).toHaveBeenCalledTimes(2);
    });
    expect(within(screen.getByTestId('code-view')).getByText('src/Other.ts')).toBeTruthy();
  });

  it('keeps the current T3-style workspace diff visible when a manual refresh fails', async () => {
    let readCount = 0;
    loadCodeAgentWorkspaceDiffMock.mockImplementation(() => {
      readCount += 1;
      return readCount === 1
        ? Promise.resolve({
          available: true,
          patch: 'diff --git a/src/App.tsx b/src/App.tsx\n',
          byteSize: 42,
          truncated: false,
        })
        : Promise.reject(new Error('socket diff failed'));
    });
    parsePatchFilesMock.mockReturnValue([
      {
        files: [
          { name: 'src/App.tsx', hunks: [], additionLines: [], deletionLines: [], type: 'modify' },
        ],
      },
    ]);

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    expect(within(await screen.findByTestId('code-view')).getByText('src/App.tsx')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('codeAgentRefreshWorkspaceDiff'));

    await waitFor(() => {
      expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenCalledTimes(2);
    });
    const errorBar = screen.getByTestId('code-agent-workspace-diff-error-bar');
    expect(errorBar.textContent).toBe('socket diff failed');
    expect(errorBar.className).toContain('border-b');
    expect(errorBar.className).not.toContain('rounded');
    expect(errorBar.parentElement?.className).toContain('diff-panel-viewport');
    expect(within(screen.getByTestId('code-view')).getByText('src/App.tsx')).toBeTruthy();
  });

  it('keeps the T3-style diff toolbar available when there are no workspace changes', async () => {
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: '',
      byteSize: 0,
      truncated: false,
    });

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    expect(await screen.findByText('codeAgentNoNetWorkspaceChanges')).toBeTruthy();
    expect(screen.getByLabelText('codeAgentRefreshWorkspaceDiff')).toBeTruthy();
    expect(screen.getByLabelText('codeAgentDiffScope: codeAgentDiffScopeBranch')).toBeTruthy();

    fireEvent.click(screen.getByText('codeAgentDiffScopeWorkingTree'));

    await waitFor(() => {
      expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenCalledTimes(2);
    });
    expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenLastCalledWith(
      'room-1',
      expect.objectContaining({ scope: 'unstaged' }),
    );
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

  it('renders the T3-style truncated diff warning when the workspace patch is partial', async () => {
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'diff --git a/src/App.tsx b/src/App.tsx\n',
      byteSize: 2_000_000,
      truncated: true,
    });
    parsePatchFilesMock.mockReturnValue([
      {
        files: [
          { name: 'src/App.tsx', hunks: [], additionLines: [], deletionLines: [], type: 'modify' },
        ],
      },
    ]);

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    const truncatedBar = await screen.findByTestId('code-agent-workspace-diff-truncated');
    expect(truncatedBar.textContent).toBe('codeAgentDiffPreviewTruncated');
    expect(truncatedBar.className).toContain('border-b');
    expect(truncatedBar.className).not.toContain('rounded');
    expect(truncatedBar.parentElement?.className).toContain('diff-panel-viewport');
    expect(screen.getByTestId('code-view')).toBeTruthy();
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
      expect.objectContaining({ ignoreWhitespace: false, scope: 'branch' }),
    );

    fireEvent.click(screen.getByLabelText('codeAgentHideWhitespaceChanges'));

    await waitFor(() => {
      expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenCalledTimes(2);
    });
    expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenLastCalledWith(
      'room-1',
      expect.objectContaining({ ignoreWhitespace: true, scope: 'branch' }),
    );
    expect(localStorage.getItem('roomtalk.codeWorkspace.diffIgnoreWhitespace')).toBe('true');
    expect(screen.getByLabelText('codeAgentShowWhitespaceChanges').getAttribute('aria-pressed')).toBe('true');
  });

  it('toggles the T3-style working tree diff scope and reloads the workspace patch', async () => {
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
    expect(screen.getByLabelText('codeAgentDiffScope: codeAgentDiffScopeBranch')).toBeTruthy();
    expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenLastCalledWith(
      'room-1',
      expect.objectContaining({ scope: 'branch' }),
    );

    fireEvent.click(screen.getByText('codeAgentDiffScopeWorkingTree'));

    await waitFor(() => {
      expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenCalledTimes(2);
    });
    expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenLastCalledWith(
      'room-1',
      expect.objectContaining({ scope: 'unstaged' }),
    );
    expect(readCodeAgentDiffPanelSelection('room-1')).toEqual({
      kind: 'unstaged',
      filePath: null,
      revealRequestId: 0,
    });
    expect(screen.getByLabelText('codeAgentDiffScope: codeAgentDiffScopeWorkingTree')).toBeTruthy();
  });

  it('selects T3-style branch base refs and toggles remote refs', async () => {
    loadCodeAgentWorkspaceRefsMock.mockResolvedValue({
      available: true,
      headRef: 'feature/search',
      refs: [
        { name: 'main', kind: 'local' },
        { name: 'origin/main', kind: 'remote', remoteName: 'origin' },
        { name: 'origin/release', kind: 'remote', remoteName: 'origin' },
      ],
    });
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
    await waitFor(() => {
      expect(loadCodeAgentWorkspaceRefsMock).toHaveBeenCalledWith('room-1', expect.objectContaining({ limit: 200 }));
    });

    fireEvent.change(screen.getByLabelText('codeAgentDiffBaseRefSearch'), { target: { value: 'main' } });
    fireEvent.click(screen.getByText('main'));

    await waitFor(() => {
      expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenCalledTimes(2);
    });
    expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenLastCalledWith(
      'room-1',
      expect.objectContaining({ scope: 'branch', baseRef: 'main' }),
    );
    expect(readCodeAgentDiffPanelSelection('room-1')).toEqual({
      kind: 'branch',
      baseRef: 'main',
      filePath: null,
      revealRequestId: 0,
    });

    fireEvent.click(screen.getByLabelText('codeAgentDiffBaseRefUseRemote'));

    await waitFor(() => {
      expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenCalledTimes(3);
    });
    expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenLastCalledWith(
      'room-1',
      expect.objectContaining({ scope: 'branch', baseRef: 'origin/main' }),
    );
    expect(readCodeAgentDiffPanelSelection('room-1')).toEqual({
      kind: 'branch',
      baseRef: 'origin/main',
      filePath: null,
      revealRequestId: 0,
    });
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

  it('supports T3-style draft and persisted comments from selected diff lines', async () => {
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'diff --git a/src/App.tsx b/src/App.tsx\n',
      byteSize: 42,
      truncated: false,
    });
    parsePatchFilesMock.mockReturnValue([
      {
        files: [
          {
            name: 'src/App.tsx',
            cacheKey: 'file:app',
            hunks: [{
              additionStart: 1,
              deletionStart: 1,
              additionLines: 3,
              deletionLines: 0,
              hunkContent: [
                { type: 'context', lines: 1 },
                { type: 'change', deletions: 0, additions: 3 },
              ],
            }],
            additionLines: ['same', 'added 2', 'added 3', 'added 4'],
            deletionLines: ['same'],
            type: 'change',
          },
        ],
      },
    ]);

    function StatefulDiffViewer() {
      const [comments, setComments] = React.useState<ReviewCommentContext[]>([]);
      return (
        <CodeAgentWorkspaceDiffViewer
          roomId="room-1"
          enabled
          refreshKey="snapshot-1"
          reviewComments={comments}
          onAddReviewComment={(comment) => {
            setComments((current) => [
              ...current.filter((entry) => entry.id !== comment.id),
              comment,
            ]);
          }}
        />
      );
    }

    render(<StatefulDiffViewer />);

    fireEvent.click(await screen.findByLabelText('select diff lines file:app'));

    const input = await screen.findByLabelText('codeAgentCommentOnLines:+2 to +4');
    fireEvent.change(input, { target: { value: 'Please revisit this diff.' } });
    fireEvent.click(screen.getByRole('button', { name: 'codeAgentSubmitComment' }));

    expect(screen.getByText('codeAgentLocalComment')).toBeTruthy();
    expect(screen.getByText('+2 to +4')).toBeTruthy();
    expect(screen.getByText('Please revisit this diff.')).toBeTruthy();
  });

  it('adds T3 review comments when selected diff lines are submitted', async () => {
    const onAddReviewComment = vi.fn();
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'diff --git a/src/App.tsx b/src/App.tsx\n',
      byteSize: 42,
      truncated: false,
    });
    parsePatchFilesMock.mockReturnValue([
      {
        files: [
          {
            name: 'src/App.tsx',
            cacheKey: 'file:app',
            hunks: [{
              additionStart: 1,
              deletionStart: 1,
              deletionLineIndex: 0,
              additionLineIndex: 0,
              additionLines: 3,
              deletionLines: 0,
              hunkContent: [
                { type: 'context', lines: 1 },
                { type: 'change', deletions: 0, additions: 3 },
              ],
            }],
            additionLines: ['same', 'added 2', 'added 3', 'added 4'],
            deletionLines: ['same'],
            type: 'change',
          },
        ],
      },
    ]);

    render(
      <CodeAgentWorkspaceDiffViewer
        roomId="room-1"
        enabled
        refreshKey="snapshot-1"
        onAddReviewComment={onAddReviewComment}
      />,
    );

    fireEvent.click(await screen.findByLabelText('select diff lines file:app'));

    const input = await screen.findByLabelText('codeAgentCommentOnLines:+2 to +4');
    fireEvent.change(input, { target: { value: 'Please revisit this diff.' } });
    fireEvent.click(screen.getByRole('button', { name: 'codeAgentSubmitComment' }));

    expect(onAddReviewComment).toHaveBeenCalledWith(expect.objectContaining({
      sectionId: 'workspace-diff:room-1:snapshot-1:branch:auto',
      sectionTitle: 'codeAgentChanges',
      filePath: 'src/App.tsx',
      rangeLabel: '+2 to +4',
      text: 'Please revisit this diff.',
      diff: '@@ -0,0 +2,3 @@\n+added 2\n+added 3\n+added 4',
      fenceLanguage: 'diff',
    }));
  });

  it('matches T3 diff annotation item versions without hashing entry kind', async () => {
    const reviewComment: ReviewCommentContext = {
      id: 'comment-1',
      sectionId: 'workspace-diff:room-1:snapshot-1:branch:auto',
      sectionTitle: 'codeAgentChanges',
      filePath: 'src/App.tsx',
      startIndex: 1,
      endIndex: 3,
      rangeLabel: '+2 to +4',
      text: 'Please revisit this diff.',
      diff: '@@ -0,0 +2,3 @@\n+added 2\n+added 3\n+added 4',
      fenceLanguage: 'diff',
    };
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'diff --git a/src/App.tsx b/src/App.tsx\n',
      byteSize: 42,
      truncated: false,
    });
    parsePatchFilesMock.mockReturnValue([
      {
        files: [
          {
            name: 'src/App.tsx',
            cacheKey: 'file:app',
            hunks: [{
              additionStart: 1,
              deletionStart: 1,
              deletionLineIndex: 0,
              additionLineIndex: 0,
              additionLines: 3,
              deletionLines: 0,
              hunkContent: [
                { type: 'context', lines: 1 },
                { type: 'change', deletions: 0, additions: 3 },
              ],
            }],
            additionLines: ['same', 'added 2', 'added 3', 'added 4'],
            deletionLines: ['same'],
            type: 'change',
          },
        ],
      },
    ]);

    render(
      <CodeAgentWorkspaceDiffViewer
        roomId="room-1"
        enabled
        refreshKey="snapshot-1"
        reviewComments={[reviewComment]}
      />,
    );

    expect(await screen.findByTestId('diff-line-annotation')).toBeTruthy();
    expect(screen.getByTestId('diff-file-file:app').dataset.version).toBe(String(
      fnv1a32('0:comment-1:+2 to +4:Please revisit this diff.'),
    ));
    expect(screen.getByTestId('diff-file-file:app').dataset.version).not.toBe(String(
      fnv1a32('0:comment-1:comment:+2 to +4:Please revisit this diff.'),
    ));
  });

  it('does not create a draft for diff selections that T3 review comments cannot map', async () => {
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'diff --git a/src/App.tsx b/src/App.tsx\n',
      byteSize: 42,
      truncated: false,
    });
    parsePatchFilesMock.mockReturnValue([
      {
        files: [
          {
            name: 'src/App.tsx',
            cacheKey: 'file:app',
            hunks: [{
              additionStart: 1,
              deletionStart: 1,
              deletionLineIndex: 0,
              additionLineIndex: 0,
              additionLines: 1,
              deletionLines: 0,
              hunkContent: [
                { type: 'context', lines: 1 },
              ],
            }],
            additionLines: ['same'],
            deletionLines: ['same'],
            type: 'change',
          },
        ],
      },
    ]);

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    fireEvent.click(await screen.findByLabelText('select invalid diff lines file:app'));

    expect(screen.queryByLabelText(/^codeAgentCommentOnLines:/)).toBeNull();
    expect(screen.queryByTestId('diff-line-annotation')).toBeNull();
  });

  it('renders T3-style changed file navigation and scrolls to a diff file', async () => {
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'diff --git a/src/App.tsx b/src/App.tsx\n',
      byteSize: 42,
      truncated: false,
    });
    parsePatchFilesMock.mockReturnValue([
      {
        files: [
          {
            name: 'src/App.tsx',
            cacheKey: 'file:app',
            hunks: [{ additionLines: 2, deletionLines: 1 }],
            additionLines: [],
            deletionLines: [],
            type: 'change',
          },
          {
            name: 'src/utils.ts',
            cacheKey: 'file:utils',
            hunks: [{ additionLines: 1000, deletionLines: 0 }],
            additionLines: [],
            deletionLines: [],
            type: 'new',
          },
        ],
      },
    ]);

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    const nav = await screen.findByTestId('code-agent-diff-file-nav');
    expect(within(nav).getByText('codeAgentChangedFilesCount')).toBeTruthy();
    expect(within(nav).getByText('src/App.tsx')).toBeTruthy();
    expect(within(nav).getByText('src/utils.ts')).toBeTruthy();
    expect(within(nav).getByText('+2')).toBeTruthy();
    expect(within(nav).getByText('-1')).toBeTruthy();
    expect(within(nav).getByText('+1k')).toBeTruthy();

    fireEvent.click(within(nav).getByLabelText('Scroll to diff file src/utils.ts'));

    expect(codeViewScrollToMock).toHaveBeenCalledWith({ type: 'item', id: 'file:utils', align: 'start' });
  });

  it('opens a changed file nav item through the T3 primary file action', async () => {
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
          {
            name: 'src/App.tsx',
            cacheKey: 'file:app',
            hunks: [{ additionLines: 2, deletionLines: 1 }],
            additionLines: [],
            deletionLines: [],
            type: 'change',
          },
          {
            name: 'src/utils.ts',
            cacheKey: 'file:utils',
            hunks: [{ additionLines: 1000, deletionLines: 0 }],
            additionLines: [],
            deletionLines: [],
            type: 'new',
          },
        ],
      },
    ]);

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" onOpenFile={onOpenFile} />);

    const nav = await screen.findByTestId('code-agent-diff-file-nav');
    fireEvent.click(within(nav).getByLabelText('Open diff file src/utils.ts'));

    expect(onOpenFile).toHaveBeenCalledWith('src/utils.ts');
    expect(codeViewScrollToMock).not.toHaveBeenCalled();

    fireEvent.click(within(nav).getByLabelText('Scroll to diff file src/utils.ts'));

    expect(codeViewScrollToMock).toHaveBeenCalledWith({ type: 'item', id: 'file:utils', align: 'start' });
  });

  it('reports parsed diff file summaries for the changed-files tree', async () => {
    const onFileSummariesChange = vi.fn();
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'diff --git a/src/App.tsx b/src/App.tsx\n',
      byteSize: 42,
      truncated: false,
    });
    parsePatchFilesMock.mockReturnValue([
      {
        files: [
          {
            name: 'src/App.tsx',
            cacheKey: 'file:app',
            hunks: [{ additionLines: 4, deletionLines: 2 }],
            additionLines: [],
            deletionLines: [],
            type: 'change',
          },
          {
            name: 'src/utils.ts',
            cacheKey: 'file:utils',
            hunks: [{ additionLines: 1, deletionLines: 0 }],
            additionLines: [],
            deletionLines: [],
            type: 'new',
          },
        ],
      },
    ]);

    render(
      <CodeAgentWorkspaceDiffViewer
        roomId="room-1"
        enabled
        refreshKey="snapshot-1"
        onFileSummariesChange={onFileSummariesChange}
      />,
    );

    await waitFor(() => {
      expect(onFileSummariesChange).toHaveBeenLastCalledWith([
        { id: 'file:app', path: 'src/App.tsx', additions: 4, deletions: 2 },
        { id: 'file:utils', path: 'src/utils.ts', additions: 1, deletions: 0 },
      ]);
    });
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

    const codeView = await screen.findByTestId('code-view');
    fireEvent.click(within(codeView).getByText('src/App.tsx'));

    expect(onOpenFile).toHaveBeenCalledWith('src/App.tsx');
  });

  it('opens a clicked diff line with a T3-style file reveal target', async () => {
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

    const codeView = await screen.findByTestId('code-view');
    fireEvent.click(within(codeView).getByText('line 42'));

    expect(onOpenFile).toHaveBeenCalledWith('src/App.tsx#L42');
  });

  it('resolves renamed diff line clicks to the next file reveal target', async () => {
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

    fireEvent.click(await screen.findByText('gutter 24'));

    expect(onOpenFile).toHaveBeenCalledWith('src/New.tsx#L24');
  });

  it('falls back to the only diff file when a line click has no file container', async () => {
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

    const codeView = await screen.findByTestId('code-view');
    const file = codeView.querySelector('[data-diff]');
    file?.removeAttribute('data-diff');
    fireEvent.click(within(codeView).getByText('line 42'));

    expect(onOpenFile).toHaveBeenCalledWith('src/App.tsx#L42');
  });

  it('does not guess the first diff title for unscoped line clicks in multi-file diffs', async () => {
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
          { name: 'src/App.tsx', cacheKey: 'file:app', hunks: [], additionLines: [], deletionLines: [], type: 'change' },
          { name: 'src/utils.ts', cacheKey: 'file:utils', hunks: [], additionLines: [], deletionLines: [], type: 'change' },
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

    const appFile = await screen.findByTestId('diff-file-file:app');
    appFile.removeAttribute('data-diff');
    screen.getByTestId('diff-file-file:utils').removeAttribute('data-diff');
    fireEvent.click(within(appFile).getByText('line 42'));

    expect(onOpenFile).not.toHaveBeenCalled();
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
