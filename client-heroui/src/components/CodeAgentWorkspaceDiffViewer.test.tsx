// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeAgentWorkspaceDiffViewer } from './CodeAgentWorkspaceDiffViewer';
import {
  readCodeAgentDiffPanelSelection,
  resetCodeAgentDiffPanelStoreForTests,
  selectCodeAgentDiffScope,
} from '../utils/codeAgentDiffPanelStore';
import { resetCodeAgentDiffFileVisibilityStoreForTests } from '../utils/codeAgentDiffFileVisibilityStore';
import {
  fnv1a32,
  resetCodeAgentRenderablePatchCacheForTests,
} from '../utils/codeAgentDiffRendering';
import {
  readCodeAgentRightPanelState,
  resetCodeAgentRightPanelStoreForTests,
} from '../utils/codeAgentRightPanelStore';
import type { ReviewCommentContext } from '../utils/codeAgentReviewComments';

const loadCodeAgentWorkspaceDiffMock = vi.hoisted(() => vi.fn());
const loadCodeAgentWorkspaceRefsMock = vi.hoisted(() => vi.fn());
const parsePatchFilesMock = vi.hoisted(() => vi.fn());
const codeViewScrollToMock = vi.hoisted(() => vi.fn());
const codeViewMountState = vi.hoisted(() => ({ nextId: 0 }));

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
    renderHeaderMetadata,
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
      maxLineDiffLength?: number;
      overflow: 'scroll' | 'wrap';
      enableLineSelection?: boolean;
      onLineSelectionEnd?: (range: { start: number; end: number; side?: 'additions' | 'deletions'; endSide?: 'additions' | 'deletions' }, context: { item: any }) => void;
      stickyHeaders?: boolean;
      unsafeCSS?: string;
      layout?: { paddingTop: number; paddingBottom: number; gap: number };
    };
    className?: string;
    renderHeaderPrefix?: (item: { id: string; type: 'diff'; fileDiff: { name?: string | null; prevName?: string | null; cacheKey?: string }; collapsed?: boolean }) => ReactNode;
    renderHeaderMetadata?: (item: { id: string; type: 'diff'; fileDiff: { name?: string | null; prevName?: string | null; cacheKey?: string }; collapsed?: boolean }) => ReactNode;
    renderAnnotation?: (annotation: { side: 'additions' | 'deletions'; lineNumber: number; metadata: { entries: Array<{ id: string; kind: 'draft' | 'comment'; rangeLabel: string; text: string }> } }) => ReactNode;
  }, ref) => {
    const [mountId] = React.useState(() => {
      codeViewMountState.nextId += 1;
      return codeViewMountState.nextId;
    });
    React.useImperativeHandle(ref, () => ({ scrollTo: codeViewScrollToMock }));
    return (
      <div
        data-testid="code-view"
        data-mount-id={String(mountId)}
        data-diff-style={options.diffStyle}
        data-line-diff-type={options.lineDiffType || ''}
        data-max-line-diff-length={String(options.maxLineDiffLength ?? '')}
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
              {renderHeaderMetadata?.(item)}
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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe('CodeAgentWorkspaceDiffViewer', () => {
  beforeEach(() => {
    resetCodeAgentRenderablePatchCacheForTests();
    resetCodeAgentDiffFileVisibilityStoreForTests();
    resetCodeAgentDiffPanelStoreForTests();
    resetCodeAgentRightPanelStoreForTests();
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
    codeViewMountState.nextId = 0;
    localStorage.clear();
    resetCodeAgentRenderablePatchCacheForTests();
    resetCodeAgentDiffFileVisibilityStoreForTests();
    resetCodeAgentDiffPanelStoreForTests();
    resetCodeAgentRightPanelStoreForTests();
  });

  it('renders the T3-style diff loading skeleton while the workspace patch is pending', async () => {
    loadCodeAgentWorkspaceDiffMock.mockReturnValue(new Promise(() => undefined));

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    const loading = await screen.findByTestId('code-agent-workspace-diff-loading');
    const status = screen.getByRole('status', { name: 'codeAgentLoadingBranchDiff' });
    expect(loading.contains(status)).toBe(true);
    const subheader = screen.getByTestId('code-agent-workspace-diff-viewer').querySelector('[data-surface-subheader]');
    expect(subheader).toBeTruthy();
    expect(subheader?.className).toContain('surface-subheader');
    expect(subheader?.className).toContain('h-9');
    expect(subheader?.className).toContain('border-b');
    expect(subheader?.children[0]?.className).toContain('flex-1');
    expect(subheader?.children[1]?.className).toContain('shrink-0');
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

  it('shows the T3-style resolved branch comparison from the workspace diff', async () => {
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'diff --git a/src/App.tsx b/src/App.tsx\n',
      byteSize: 42,
      truncated: false,
      headRef: 'feature/search',
      baseRef: 'origin/main',
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
    expect(screen.getByLabelText('codeAgentDiffComparing: feature/search -> origin/main')).toBeTruthy();
    expect(screen.getByText('origin/main')).toBeTruthy();
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
    expect(codeView.dataset.className).toContain('h-full');
    expect(codeView.dataset.className).toContain('min-h-0');
    expect(codeView.dataset.className).toContain('flex-1');
    expect(codeView.dataset.className).toContain('diff-render-surface');
    expect(codeView.dataset.className).toContain('overflow-auto');
    expect(codeView.dataset.className?.split(/\s+/)).not.toContain('min-h-80');
    expect(codeView.dataset.className?.split(/\s+/)).not.toContain('rounded-lg');
    expect(codeView.dataset.className?.split(/\s+/)).not.toContain('border');
    expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenCalledWith('room-1', expect.any(Object));
    expect(parsePatchFilesMock).toHaveBeenCalledWith(
      'diff --git a/src/App.tsx b/src/App.tsx',
      expect.stringMatching(/^workspace:room-1:snapshot-1:branch:auto:(light|dark):\d+:/),
    );
    expect(screen.getByTestId('code-view').dataset.overflow).toBe('scroll');
    expect(screen.getByTestId('code-view').dataset.diffStyle).toBe('unified');
    expect(screen.getByTestId('code-view').dataset.lineDiffType).toBe('none');
    expect(screen.getByTestId('code-view').dataset.maxLineDiffLength).toBe('');
    expect(screen.getByTestId('code-view').dataset.stickyHeaders).toBe('true');
    expect(screen.getByTestId('code-view').dataset.layout).toBe('8:8:8');
    expect(screen.getByTestId('code-view').dataset.unsafeCss).toContain('[data-diffs-header]');
    expect(screen.getByTestId('code-view').dataset.unsafeCss).toContain('[data-title]:hover');
  });

  it('uses a compact mobile diff toolbar with internally scrollable controls', async () => {
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'diff --git a/src/App.tsx b/src/App.tsx\n',
      byteSize: 42,
      truncated: false,
      headRef: 'feature/mobile',
      baseRef: 'origin/main',
    });
    parsePatchFilesMock.mockReturnValue([
      {
        files: [
          {
            name: 'src/App.tsx',
            hunks: [{ additionLines: 2, deletionLines: 1 }],
            additionLines: ['new one', 'new two'],
            deletionLines: ['old one'],
            type: 'modify',
          },
        ],
      },
    ]);
    const reviewComments: ReviewCommentContext[] = [
      {
        id: 'review-1',
        sectionId: 'file:src/App.tsx',
        sectionTitle: 'File comment',
        filePath: 'src/App.tsx',
        startIndex: 1,
        endIndex: 1,
        rangeLabel: 'L2',
        text: 'First pending review.',
        diff: 'new one',
        fenceLanguage: 'tsx',
      },
      {
        id: 'review-2',
        sectionId: 'file:src/App.tsx',
        sectionTitle: 'File comment',
        filePath: 'src/App.tsx',
        startIndex: 2,
        endIndex: 2,
        rangeLabel: 'L3',
        text: 'Second pending review.',
        diff: 'new two',
        fenceLanguage: 'tsx',
      },
    ];

    render(
      <CodeAgentWorkspaceDiffViewer
        roomId="room-1"
        enabled
        refreshKey="snapshot-1"
        mobileLayout
        reviewComments={reviewComments}
      />,
    );

    expect(await screen.findByTestId('code-view')).toBeTruthy();
    const subheader = screen.getByTestId('code-agent-workspace-diff-viewer').querySelector('[data-surface-subheader]');
    expect(subheader).toBeTruthy();
    expect(subheader?.className).toContain('min-h-10');
    expect(subheader?.className).not.toContain('min-h-[4.75rem]');
    expect(subheader?.className).not.toContain('h-9');

    const mobileHeader = screen.getByTestId('code-agent-mobile-workspace-diff-header');
    expect(mobileHeader.className).toContain('overflow-x-auto');
    expect(within(mobileHeader).queryByTestId('code-agent-mobile-workspace-diff-summary-row')).toBeNull();
    expect(within(mobileHeader).queryByText('codeAgentChangedFilesCount')).toBeNull();
    expect(within(mobileHeader).queryByText('codeAgentReviewFilesChanged')).toBeNull();
    const controlsRow = within(mobileHeader).getByTestId('code-agent-mobile-workspace-diff-controls-row');
    expect(controlsRow.className).toContain('min-w-max');
    expect(within(controlsRow).getByText('codeAgentReviewSectionBranchRange')).toBeTruthy();
    expect(within(controlsRow).getByText('+2')).toBeTruthy();
    expect(within(controlsRow).getByText('-1')).toBeTruthy();
    const pendingReviewCount = within(controlsRow).getByTestId('code-agent-mobile-workspace-diff-pending-review-count');
    expect(pendingReviewCount.dataset.count).toBe('2');
    expect(pendingReviewCount.textContent).toBe('codeAgentPendingReviewCommentCount');
    expect(within(mobileHeader).queryByText('feature/mobile -> origin/main')).toBeNull();

    expect(screen.getByTestId('code-view').dataset.lineDiffType).toBe('word-alt');
    expect(screen.getByTestId('code-view').dataset.maxLineDiffLength).toBe('1000');
    expect(controlsRow.contains(screen.getByLabelText('codeAgentRefreshWorkspaceDiff'))).toBe(true);
    const refreshButton = screen.getByLabelText('codeAgentRefreshWorkspaceDiff');
    expect(refreshButton.className).toContain('h-9');
    expect(refreshButton.className).toContain('w-9');
    expect(screen.queryByTestId('code-agent-mobile-diff-files-button')).toBeNull();
    const scopeButton = screen.getByLabelText('codeAgentReviewSection: codeAgentReviewSectionBranchRange');
    expect(controlsRow.contains(scopeButton)).toBe(true);
    expect(scopeButton.className).toContain('h-9');
    expect(scopeButton.className).toContain('rounded-lg');
    expect(scopeButton.className).toContain('text-sm');
    expect(screen.queryByTestId('code-agent-mobile-diff-scope-menu')).toBeNull();
    vi.spyOn(scopeButton, 'getBoundingClientRect').mockReturnValue({
      x: 18,
      y: 48,
      left: 18,
      top: 48,
      right: 146,
      bottom: 84,
      width: 128,
      height: 36,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent.click(scopeButton);
    const scopeMenu = screen.getByTestId('code-agent-mobile-diff-scope-menu');
    expect(scopeMenu.className).toContain('fixed');
    expect(scopeMenu.style.left).toBe('18px');
    expect(scopeMenu.style.top).toBe('88px');
    expect(scopeMenu.style.width).toBe('288px');
    expect(controlsRow.contains(scopeMenu)).toBe(false);
    expect(within(scopeMenu).getByText('codeAgentReviewSectionWorkingTree').closest('button')?.className).toContain('min-h-14');
    expect(within(scopeMenu).getByText('codeAgentReviewSectionWorkingTreeSubtitle')).toBeTruthy();
    expect(within(scopeMenu).queryByText('codeAgentRefreshCurrentDiff')).toBeNull();
    fireEvent.click(scopeButton);
    expect(screen.queryByTestId('code-agent-mobile-diff-scope-menu')).toBeNull();
    const baseRefButton = screen.getByLabelText('codeAgentDiffBaseRef: origin/main');
    vi.spyOn(baseRefButton, 'getBoundingClientRect').mockReturnValue({
      x: 156,
      y: 48,
      left: 156,
      top: 48,
      right: 276,
      bottom: 84,
      width: 120,
      height: 36,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent.click(baseRefButton);
    const baseRefMenu = screen.getByTestId('code-agent-mobile-diff-base-ref-menu');
    expect(baseRefMenu.className).toContain('fixed');
    expect(baseRefMenu.style.left).toBe('156px');
    expect(baseRefMenu.style.top).toBe('88px');
    expect(baseRefMenu.style.width).toBe('288px');
    expect(controlsRow.contains(baseRefMenu)).toBe(false);
    expect(within(baseRefMenu).getByLabelText('codeAgentDiffBaseRefSearch')).toBeTruthy();
    expect(controlsRow.contains(screen.getByRole('group', {
      name: 'codeAgentStackedDiffView / codeAgentSplitDiffView',
    }))).toBe(true);
    expect(screen.getByLabelText('codeAgentStackedDiffView').className).toContain('h-9');
    expect(screen.getByLabelText('codeAgentStackedDiffView').className).toContain('rounded-l-lg');
    expect(screen.getByLabelText('codeAgentSplitDiffView').className).toContain('h-9');
    expect(screen.getByLabelText('codeAgentSplitDiffView').className).toContain('rounded-r-lg');
  });

  it('places the mobile changed-files opener in the diff toolbar when provided', async () => {
    const onOpenChangedFiles = vi.fn();
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

    render(
      <CodeAgentWorkspaceDiffViewer
        roomId="room-1"
        enabled
        refreshKey="snapshot-1"
        mobileLayout
        onOpenChangedFiles={onOpenChangedFiles}
      />,
    );

    expect(await screen.findByTestId('code-view')).toBeTruthy();
    const mobileHeader = screen.getByTestId('code-agent-mobile-workspace-diff-header');
    const controlsRow = within(mobileHeader).getByTestId('code-agent-mobile-workspace-diff-controls-row');
    const changedFilesButton = screen.getByTestId('code-agent-mobile-diff-files-button');
    expect(controlsRow.contains(changedFilesButton)).toBe(true);
    expect(changedFilesButton.getAttribute('aria-label')).toBe('codeAgentChangedFiles');
    expect(changedFilesButton.className).toContain('h-9');
    expect(changedFilesButton.className).toContain('w-9');

    fireEvent.click(changedFilesButton);
    expect(onOpenChangedFiles).toHaveBeenCalledTimes(1);
  });

  it('shows the selected review section summary on mobile when the diff has no files', async () => {
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: '',
      byteSize: 0,
      truncated: false,
    });

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" mobileLayout />);

    expect(await screen.findByText('codeAgentNoNetWorkspaceChanges')).toBeTruthy();
    expect(screen.queryByTestId('code-agent-mobile-workspace-diff-summary-row')).toBeNull();
    const controlsRow = screen.getByTestId('code-agent-mobile-workspace-diff-controls-row');
    expect(within(controlsRow).queryByText('codeAgentReviewFilesChanged')).toBeNull();
    expect(within(controlsRow).getByText('codeAgentReviewSectionBranchRange')).toBeTruthy();
    await waitFor(() => {
      expect(controlsRow.textContent).toContain('codeAgentDiffBaseRefAutomatic');
    });
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
    expect(screen.getByLabelText('codeAgentReviewSection: codeAgentReviewSectionBranchRange')).toBeTruthy();

    fireEvent.click(screen.getByText('codeAgentReviewSectionWorkingTree'));

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
    expect(screen.getByTestId('code-agent-workspace-raw-diff-shell').className).toContain('p-2');
    expect(screen.getByTestId('code-agent-workspace-raw-diff-shell').className).not.toContain('rounded');
    expect(screen.getByTestId('code-agent-workspace-raw-diff').className).toContain('max-h-[72vh]');
    expect(screen.getByTestId('code-agent-workspace-raw-diff').className).not.toContain('min-h-80');
    expect(screen.getByTestId('code-agent-workspace-raw-diff').parentElement?.className).toContain('space-y-2');
    expect(screen.queryByTestId('code-view')).toBeNull();
  });

  it('uses the T3 raw excerpt reason when a truncated workspace diff cannot be parsed', async () => {
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'not a complete git patch\n+but still useful output\n',
      byteSize: 2_000_000,
      truncated: true,
    });
    parsePatchFilesMock.mockImplementation(() => {
      throw new Error('bad patch');
    });

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    expect((await screen.findByTestId('code-agent-workspace-raw-diff')).textContent).toBe('not a complete git patch\n+but still useful output');
    expect(screen.getByText('Diff was truncated before it could be parsed completely. Showing the raw excerpt.')).toBeTruthy();
    expect(screen.getByTestId('code-agent-workspace-diff-truncated')).toBeTruthy();
    expect(screen.queryByTestId('code-view')).toBeNull();
  });

  it('surfaces the T3 truncation marker even without workspace diff metadata', async () => {
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'not a complete git patch\n+but still useful output\n[truncated]\n',
      byteSize: 2_000_000,
      truncated: false,
    });
    parsePatchFilesMock.mockImplementation(() => {
      throw new Error('bad patch');
    });

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    expect((await screen.findByTestId('code-agent-workspace-raw-diff')).textContent).toBe('not a complete git patch\n+but still useful output');
    expect(parsePatchFilesMock).toHaveBeenCalledWith(
      'not a complete git patch\n+but still useful output',
      expect.any(String),
    );
    expect(screen.getByText('Diff was truncated before it could be parsed completely. Showing the raw excerpt.')).toBeTruthy();
    expect(screen.getByTestId('code-agent-workspace-diff-truncated')).toBeTruthy();
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
    expect(truncatedBar.textContent).toBe('Diff output hit the server size cap. Showing the available excerpt.');
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

    const initialCodeView = await screen.findByTestId('code-view');
    const initialMountId = initialCodeView.dataset.mountId;
    expect(screen.getByLabelText('codeAgentReviewSection: codeAgentReviewSectionBranchRange')).toBeTruthy();
    expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenLastCalledWith(
      'room-1',
      expect.objectContaining({ scope: 'branch' }),
    );

    fireEvent.click(screen.getByText('codeAgentReviewSectionWorkingTree'));

    await waitFor(() => {
      expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId('code-view').dataset.mountId).not.toBe(initialMountId);
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
    expect(screen.getByLabelText('codeAgentReviewSection: codeAgentReviewSectionWorkingTree')).toBeTruthy();
  });

  it('does not report stale file summaries while a newly selected diff scope is loading', async () => {
    const summaryReports: Array<readonly { id: string; path: string; additions: number; deletions: number }[]> = [];
    loadCodeAgentWorkspaceDiffMock
      .mockResolvedValueOnce({
        available: true,
        patch: 'diff --git a/src/App.tsx b/src/App.tsx\n',
        byteSize: 42,
        truncated: false,
      })
      .mockReturnValueOnce(new Promise(() => undefined));
    parsePatchFilesMock.mockReturnValue([
      {
        files: [
          {
            name: 'src/App.tsx',
            hunks: [],
            additionLines: ['next'],
            deletionLines: ['prev'],
            type: 'modify',
          },
        ],
      },
    ]);

    render(
      <CodeAgentWorkspaceDiffViewer
        roomId="room-1"
        enabled
        refreshKey="snapshot-1"
        onFileSummariesChange={(summaries) => summaryReports.push(summaries)}
      />,
    );

    expect(within(await screen.findByTestId('code-view')).getByText('src/App.tsx')).toBeTruthy();
    await waitFor(() => {
      expect(summaryReports.at(-1)?.map((summary) => summary.path)).toEqual(['src/App.tsx']);
    });

    fireEvent.click(screen.getByText('codeAgentReviewSectionWorkingTree'));

    await waitFor(() => {
      expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByTestId('code-view')).toBeNull();
    expect(screen.getByTestId('code-agent-workspace-diff-loading')).toBeTruthy();
    await waitFor(() => {
      expect(summaryReports.at(-1)).toEqual([]);
    });
    expect(parsePatchFilesMock).toHaveBeenCalledTimes(1);
  });

  it('reuses cached review section diffs while refreshing the selected section', async () => {
    const branchRefresh = createDeferred<{
      available: boolean;
      patch: string;
      byteSize: number;
      truncated: boolean;
    }>();
    loadCodeAgentWorkspaceDiffMock
      .mockResolvedValueOnce({
        available: true,
        patch: 'diff --git a/src/App.tsx b/src/App.tsx\n',
        byteSize: 42,
        truncated: false,
      })
      .mockResolvedValueOnce({
        available: true,
        patch: 'diff --git a/src/Worktree.tsx b/src/Worktree.tsx\n',
        byteSize: 24,
        truncated: false,
      })
      .mockReturnValueOnce(branchRefresh.promise);
    parsePatchFilesMock.mockImplementation((patch: string) => {
      const path = patch.includes('src/Worktree.tsx')
        ? 'src/Worktree.tsx'
        : patch.includes('src/Fresh.tsx')
          ? 'src/Fresh.tsx'
          : 'src/App.tsx';
      return [
        {
          files: [
            {
              name: path,
              hunks: [],
              additionLines: ['next'],
              deletionLines: ['prev'],
              type: 'modify',
            },
          ],
        },
      ];
    });

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    expect(within(await screen.findByTestId('code-view')).getByText('src/App.tsx')).toBeTruthy();

    fireEvent.click(screen.getByText('codeAgentReviewSectionWorkingTree'));

    await waitFor(() => {
      expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenCalledTimes(2);
    });
    expect(within(screen.getByTestId('code-view')).getByText('src/Worktree.tsx')).toBeTruthy();

    fireEvent.click(screen.getByText('codeAgentReviewSectionBranchRange'));

    await waitFor(() => {
      expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenCalledTimes(3);
    });
    expect(screen.queryByTestId('code-agent-workspace-diff-loading')).toBeNull();
    expect(within(screen.getByTestId('code-view')).getByText('src/App.tsx')).toBeTruthy();

    await act(async () => {
      branchRefresh.resolve({
        available: true,
        patch: 'diff --git a/src/Fresh.tsx b/src/Fresh.tsx\n',
        byteSize: 48,
        truncated: false,
      });
    });
    await waitFor(() => {
      expect(within(screen.getByTestId('code-view')).getByText('src/Fresh.tsx')).toBeTruthy();
    });
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
    fireEvent.click(await screen.findByText('main'));

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

  it('scopes branch base refs to the active workspace refresh', async () => {
    const nextRefs = createDeferred<{
      available: boolean;
      headRef: string;
      refs: Array<{ name: string; kind: 'local' | 'remote'; remoteName?: string }>;
    }>();
    loadCodeAgentWorkspaceRefsMock
      .mockResolvedValueOnce({
        available: true,
        headRef: 'feature/old',
        refs: [
          { name: 'old-main', kind: 'local' },
          { name: 'origin/old-main', kind: 'remote', remoteName: 'origin' },
        ],
      })
      .mockReturnValueOnce(nextRefs.promise);
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

    const { rerender } = render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    expect(await screen.findByText('old-main')).toBeTruthy();

    rerender(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-2" />);

    await waitFor(() => {
      expect(loadCodeAgentWorkspaceRefsMock).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByText('old-main')).toBeNull();
    expect(screen.getByText('codeAgentDiffBaseRefLoading')).toBeTruthy();

    await act(async () => {
      nextRefs.resolve({
        available: true,
        headRef: 'feature/new',
        refs: [
          { name: 'new-main', kind: 'local' },
          { name: 'origin/new-main', kind: 'remote', remoteName: 'origin' },
        ],
      });
    });

    expect(await screen.findByText('new-main')).toBeTruthy();
    expect(screen.queryByText('old-main')).toBeNull();
  });

  it('dismisses T3-style diff toolbar menus from outside interactions', async () => {
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
    const scopeDetails = screen
      .getByLabelText('codeAgentReviewSection: codeAgentReviewSectionBranchRange')
      .closest('details') as HTMLDetailsElement;
    const baseRefDetails = screen
      .getByLabelText('codeAgentDiffBaseRef: codeAgentDiffBaseRefAutomatic')
      .closest('details') as HTMLDetailsElement;

    scopeDetails.open = true;
    fireEvent(scopeDetails, new Event('toggle'));
    expect(scopeDetails.open).toBe(true);

    fireEvent.pointerDown(document.body);
    expect(scopeDetails.open).toBe(false);

    scopeDetails.open = true;
    fireEvent(scopeDetails, new Event('toggle'));
    baseRefDetails.open = true;
    fireEvent(baseRefDetails, new Event('toggle'));
    expect(baseRefDetails.open).toBe(true);
    expect(scopeDetails.open).toBe(false);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(baseRefDetails.open).toBe(false);
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
    const expandButton = screen.getByLabelText('codeAgentExpandDiffFile');
    expect(expandButton.getAttribute('aria-expanded')).toBe('false');
    expect(expandButton.className).toContain('h-5');
    expect(expandButton.className).toContain('w-5');
    expect(expandButton.className).toContain('rounded-sm');
  });

  it('uses touch-sized diff file header controls on mobile only', async () => {
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

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" mobileLayout />);

    await screen.findByTestId('diff-file-none:src/App.tsx');
    const collapseButton = screen.getByLabelText('codeAgentCollapseDiffFile');
    const viewedButton = screen.getByLabelText('codeAgentMarkDiffFileViewed');

    expect(collapseButton.className).toContain('h-8');
    expect(collapseButton.className).toContain('w-8');
    expect(collapseButton.className).toContain('rounded-md');
    expect(collapseButton.className).not.toContain('h-5');
    expect(viewedButton.className).toContain('h-8');
    expect(viewedButton.className).toContain('w-8');
    expect(viewedButton.className).toContain('rounded-md');
    expect(viewedButton.className).not.toContain('w-5');
  });

  it('marks T3-style diff files as viewed and collapses them', async () => {
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
          { name: 'src/utils.ts', cacheKey: 'file:utils', hunks: [], additionLines: [], deletionLines: [], type: 'new' },
        ],
      },
    ]);

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    expect((await screen.findByTestId('diff-file-file:app')).getAttribute('data-collapsed')).toBe('false');
    expect(screen.getByTestId('diff-file-file:utils').getAttribute('data-collapsed')).toBe('false');

    fireEvent.click(screen.getAllByLabelText('codeAgentMarkDiffFileViewed')[0]);

    expect(screen.getByTestId('diff-file-file:app').getAttribute('data-collapsed')).toBe('true');
    expect(screen.getByTestId('diff-file-file:utils').getAttribute('data-collapsed')).toBe('false');
    expect(screen.getByLabelText('codeAgentUnmarkDiffFileViewed').getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByLabelText('codeAgentUnmarkDiffFileViewed'));

    expect(screen.getByTestId('diff-file-file:app').getAttribute('data-collapsed')).toBe('true');
    expect(screen.getAllByLabelText('codeAgentMarkDiffFileViewed')[0].getAttribute('aria-pressed')).toBe('false');
  });

  it('suppresses non-text diff files like T3', async () => {
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'diff --git a/assets/icon.png b/assets/icon.png\n',
      byteSize: 42,
      truncated: false,
    });
    parsePatchFilesMock.mockReturnValue([
      {
        files: [
          {
            name: 'assets/icon.png',
            cacheKey: 'file:icon',
            hunks: [],
            additionLines: [],
            deletionLines: [],
            type: 'change',
          },
        ],
      },
    ]);

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    const file = await screen.findByTestId('diff-file-file:icon');
    expect(file.getAttribute('data-collapsed')).toBe('true');
    const suppression = within(file).getByTestId('code-agent-diff-file-suppression');
    expect(suppression.textContent).toContain('codeAgentNonTextDiff');
    expect(suppression.getAttribute('title')).toBe('codeAgentNonTextDiffSuppressedMessage');
    const expandButton = within(file).getByLabelText('codeAgentExpandDiffFile') as HTMLButtonElement;
    expect(expandButton.disabled).toBe(true);
    expect(expandButton.className).toContain('cursor-not-allowed');
    expect(expandButton.className).not.toContain('cursor-pointer');
    fireEvent.click(expandButton);
    expect(screen.getByTestId('diff-file-file:icon').getAttribute('data-collapsed')).toBe('true');
    const notice = within(file).getByTestId('code-agent-diff-file-suppression-notice');
    expect(notice.textContent).toContain('codeAgentNonTextDiffContentsUnavailable');
    expect(notice.getAttribute('title')).toBe('codeAgentNonTextDiffContentsUnavailable');
    expect(within(file).queryByText('codeAgentLoadDiff')).toBeNull();
  });

  it('suppresses large diff files until they are explicitly loaded like T3', async () => {
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'diff --git a/src/big.ts b/src/big.ts\n',
      byteSize: 42000,
      truncated: false,
    });
    parsePatchFilesMock.mockReturnValue([
      {
        files: [
          {
            name: 'src/big.ts',
            cacheKey: 'file:big',
            hunks: [{
              additionLines: 401,
              deletionLines: 0,
              hunkContent: [{ type: 'change', deletions: 0, additions: 401 }],
            }],
            additionLines: Array.from({ length: 401 }, (_, index) => `const line${index} = ${index};`),
            deletionLines: [],
            type: 'change',
          },
        ],
      },
    ]);

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    const file = await screen.findByTestId('diff-file-file:big');
    expect(file.getAttribute('data-collapsed')).toBe('true');
    const expandButton = within(file).getByLabelText('codeAgentExpandDiffFile') as HTMLButtonElement;
    expect(expandButton.disabled).toBe(false);
    const suppression = within(file).getByTestId('code-agent-diff-file-suppression-load');
    expect(suppression.textContent).toContain('codeAgentLargeDiffSuppressedMessage');
    expect(suppression.textContent).toContain('codeAgentLoadDiff');
    expect(suppression.getAttribute('title')).toBe('codeAgentLargeDiffSuppressedMessage');
    const notice = within(file).getByTestId('code-agent-diff-file-suppression-notice');
    expect(notice.textContent).toContain('codeAgentLargeDiffSuppressedMessage');
    expect(notice.getAttribute('title')).toBe('codeAgentLargeDiffSuppressedMessage');

    fireEvent.click(expandButton);

    expect(screen.getByTestId('diff-file-file:big').getAttribute('data-collapsed')).toBe('false');
    expect(within(screen.getByTestId('diff-file-file:big')).queryByTestId('code-agent-diff-file-suppression-load')).toBeNull();
    expect(within(screen.getByTestId('diff-file-file:big')).queryByTestId('code-agent-diff-file-suppression-notice')).toBeNull();
  });

  it('keeps the large diff reason visible in the mobile diff header before loading', async () => {
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'diff --git a/src/big.ts b/src/big.ts\n',
      byteSize: 42000,
      truncated: false,
    });
    parsePatchFilesMock.mockReturnValue([
      {
        files: [
          {
            name: 'src/big.ts',
            cacheKey: 'file:big',
            hunks: [{
              additionLines: 401,
              deletionLines: 0,
              hunkContent: [{ type: 'change', deletions: 0, additions: 401 }],
            }],
            additionLines: Array.from({ length: 401 }, (_, index) => `const line${index} = ${index};`),
            deletionLines: [],
            type: 'change',
          },
        ],
      },
    ]);

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" mobileLayout />);

    const file = await screen.findByTestId('diff-file-file:big');
    expect(file.getAttribute('data-collapsed')).toBe('true');
    const suppression = within(file).getByTestId('code-agent-diff-file-suppression-load');
    const mobileLabel = within(suppression).getByText('codeAgentLargeDiff');
    expect(mobileLabel.className).toContain('sm:hidden');
    expect(suppression.className).toContain('h-8');
    expect(suppression.className).toContain('rounded-md');
    expect(suppression.className).not.toContain('h-5');
    expect(suppression.textContent).toContain('codeAgentLoadDiff');
    const notice = within(file).getByTestId('code-agent-diff-file-suppression-notice');
    expect(notice.textContent).toContain('codeAgentLargeDiffSuppressedMessage');
    expect(notice.className).toContain('inline-flex');
    expect(notice.className).not.toContain('hidden sm:inline-flex');
  });

  it('shows T3-style notices for pure rename diff files', async () => {
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'diff --git a/src/Old.ts b/src/New.ts\nsimilarity index 100%\nrename from src/Old.ts\nrename to src/New.ts\n',
      byteSize: 98,
      truncated: false,
    });
    parsePatchFilesMock.mockReturnValue([
      {
        files: [
          {
            prevName: 'a/src/Old.ts',
            name: 'b/src/New.ts',
            cacheKey: 'file:rename',
            hunks: [],
            additionLines: [],
            deletionLines: [],
            type: 'rename-pure',
          },
        ],
      },
    ]);

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    const file = await screen.findByTestId('diff-file-file:rename');
    expect(file.getAttribute('data-collapsed')).toBe('false');
    expect(within(file).queryByTestId('code-agent-diff-file-suppression')).toBeNull();
    const notice = within(file).getByTestId('code-agent-diff-file-rename-notice');
    expect(notice.textContent).toContain('codeAgentRenameOnlyDiffMessage');
    expect(notice.getAttribute('title')).toBe('codeAgentRenameOnlyDiffMessage');
  });

  it('keeps T3-style collapsed diff files across workspace snapshot refreshes', async () => {
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

    const { rerender } = render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    expect((await screen.findByTestId('diff-file-none:src/App.tsx')).getAttribute('data-collapsed')).toBe('false');
    fireEvent.click(screen.getAllByLabelText('codeAgentCollapseDiffFile')[0]);
    expect(screen.getByTestId('diff-file-none:src/App.tsx').getAttribute('data-collapsed')).toBe('true');

    rerender(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-2" />);

    await waitFor(() => {
      expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByTestId('diff-file-none:src/App.tsx').getAttribute('data-collapsed')).toBe('true');
    expect(screen.getByTestId('diff-file-none:src/utils.ts').getAttribute('data-collapsed')).toBe('false');
  });

  it('keeps diff file visibility state across desktop and mobile remounts', async () => {
    loadCodeAgentWorkspaceDiffMock.mockResolvedValue({
      available: true,
      patch: 'diff --git a/src/App.tsx b/src/App.tsx\n',
      byteSize: 42000,
      truncated: false,
    });
    parsePatchFilesMock.mockReturnValue([
      {
        files: [
          { name: 'src/App.tsx', cacheKey: 'file:app', hunks: [], additionLines: [], deletionLines: [], type: 'change' },
          { name: 'src/utils.ts', cacheKey: 'file:utils', hunks: [], additionLines: [], deletionLines: [], type: 'new' },
          {
            name: 'src/big.ts',
            cacheKey: 'file:big',
            hunks: [{
              additionLines: 401,
              deletionLines: 0,
              hunkContent: [{ type: 'change', deletions: 0, additions: 401 }],
            }],
            additionLines: Array.from({ length: 401 }, (_, index) => `const line${index} = ${index};`),
            deletionLines: [],
            type: 'change',
          },
        ],
      },
    ]);

    const { unmount } = render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" />);

    const appFile = await screen.findByTestId('diff-file-file:app');
    const utilsFile = screen.getByTestId('diff-file-file:utils');
    const bigFile = screen.getByTestId('diff-file-file:big');
    expect(appFile.getAttribute('data-collapsed')).toBe('false');
    expect(utilsFile.getAttribute('data-collapsed')).toBe('false');
    expect(bigFile.getAttribute('data-collapsed')).toBe('true');

    fireEvent.click(within(appFile).getByLabelText('codeAgentCollapseDiffFile'));
    fireEvent.click(within(utilsFile).getByLabelText('codeAgentMarkDiffFileViewed'));
    fireEvent.click(within(bigFile).getByLabelText('codeAgentExpandDiffFile'));

    expect(screen.getByTestId('diff-file-file:app').getAttribute('data-collapsed')).toBe('true');
    expect(screen.getByTestId('diff-file-file:utils').getAttribute('data-collapsed')).toBe('true');
    expect(within(screen.getByTestId('diff-file-file:utils')).getByLabelText('codeAgentUnmarkDiffFileViewed')).toBeTruthy();
    expect(screen.getByTestId('diff-file-file:big').getAttribute('data-collapsed')).toBe('false');
    expect(within(screen.getByTestId('diff-file-file:big')).queryByTestId('code-agent-diff-file-suppression-load')).toBeNull();

    unmount();

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-2" mobileLayout />);

    await waitFor(() => {
      expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByTestId('diff-file-file:app').getAttribute('data-collapsed')).toBe('true');
    expect(screen.getByTestId('diff-file-file:utils').getAttribute('data-collapsed')).toBe('true');
    expect(within(screen.getByTestId('diff-file-file:utils')).getByLabelText('codeAgentUnmarkDiffFileViewed')).toBeTruthy();
    expect(screen.getByTestId('diff-file-file:big').getAttribute('data-collapsed')).toBe('false');
    expect(within(screen.getByTestId('diff-file-file:big')).queryByTestId('code-agent-diff-file-suppression-load')).toBeNull();
    expect(screen.getByTestId('code-agent-mobile-workspace-diff-header')).toBeTruthy();
  });

  it('keeps T3-style file visibility independently for each diff scope', async () => {
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
    fireEvent.click(screen.getAllByLabelText('codeAgentCollapseDiffFile')[0]);
    expect(screen.getByTestId('diff-file-none:src/App.tsx').getAttribute('data-collapsed')).toBe('true');

    fireEvent.click(screen.getByText('codeAgentReviewSectionWorkingTree'));
    await waitFor(() => {
      expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByTestId('diff-file-none:src/App.tsx').getAttribute('data-collapsed')).toBe('false');
    fireEvent.click(screen.getAllByLabelText('codeAgentCollapseDiffFile')[1]);
    expect(screen.getByTestId('diff-file-none:src/utils.ts').getAttribute('data-collapsed')).toBe('true');

    fireEvent.click(screen.getByText('codeAgentReviewSectionBranchRange'));
    await waitFor(() => {
      expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenCalledTimes(3);
    });
    expect(screen.getByTestId('diff-file-none:src/App.tsx').getAttribute('data-collapsed')).toBe('true');
    expect(screen.getByTestId('diff-file-none:src/utils.ts').getAttribute('data-collapsed')).toBe('false');
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

  it('adds review comments when selected diff lines are submitted', async () => {
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
      sectionId: 'workspace-diff:room-1:branch:auto',
      sectionTitle: 'codeAgentChanges',
      filePath: 'src/App.tsx',
      rangeLabel: '+2 to +4',
      text: 'Please revisit this diff.',
      diff: '@@ -0,0 +2,3 @@\n+added 2\n+added 3\n+added 4',
      fenceLanguage: 'diff',
    }));
  });

  it('uses a mobile selection action bar before opening a diff comment draft', async () => {
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
        mobileLayout
      />,
    );

    fireEvent.click(await screen.findByLabelText('select diff lines file:app'));

    const actionBar = await screen.findByTestId('code-agent-mobile-review-selection-action-bar');
    expect(actionBar.className).toContain('absolute');
    expect(actionBar.className).toContain('bottom-3');
    expect(screen.queryByLabelText('codeAgentCommentOnLines:+2 to +4')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'codeAgentCommentOnLines:+2 to +4' }));

    const mobileCommentSheet = await screen.findByTestId('code-agent-mobile-review-comment-sheet');
    expect(mobileCommentSheet.dataset.mobileCommentAnnotation).toBe('true');
    expect(mobileCommentSheet.parentElement).toBe(document.body);
    expect(mobileCommentSheet.style.getPropertyValue('--code-agent-mobile-comment-bottom')).toContain('var(--code-agent-composer-height');
    expect(within(mobileCommentSheet).getByText('src/App.tsx')).toBeTruthy();
    const selectionPreview = within(mobileCommentSheet).getByTestId('code-agent-mobile-review-comment-preview');
    expect(selectionPreview.className).toContain('overflow-auto');
    expect(within(selectionPreview).getByText('added 2')).toBeTruthy();
    expect(within(selectionPreview).getByText('added 3')).toBeTruthy();
    expect(within(selectionPreview).getByText('added 4')).toBeTruthy();
    expect(Array.from(selectionPreview.querySelectorAll('[data-review-comment-preview-line]')).map((row) => row.getAttribute('data-change'))).toEqual(['add', 'add', 'add']);
    const mobileCommentInput = within(mobileCommentSheet).getByTestId('code-agent-mobile-review-comment-textarea');
    expect(mobileCommentInput.className).toContain('min-h-[132px]');
    expect(within(mobileCommentSheet).getByRole('button', { name: 'codeAgentSubmitComment' }).className).toContain('min-h-11');
    const input = await screen.findByLabelText('codeAgentCommentOnLines:+2 to +4');
    fireEvent.change(input, { target: { value: 'Please revisit this diff.' } });
    fireEvent.click(screen.getByRole('button', { name: 'codeAgentSubmitComment' }));

    expect(onAddReviewComment).toHaveBeenCalledWith(expect.objectContaining({
      sectionId: 'workspace-diff:room-1:branch:auto',
      filePath: 'src/App.tsx',
      rangeLabel: '+2 to +4',
      text: 'Please revisit this diff.',
    }));
    expect(screen.queryByTestId('code-agent-mobile-review-selection-action-bar')).toBeNull();
  });

  it('keeps the mobile review comment sheet above the visual keyboard viewport', async () => {
    const originalInnerHeight = window.innerHeight;
    const originalVisualViewport = window.visualViewport;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        height: 500,
        offsetTop: 0,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as VisualViewport,
    });

    try {
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

      render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" mobileLayout />);

      fireEvent.click(await screen.findByLabelText('select diff lines file:app'));
      fireEvent.click(screen.getByRole('button', { name: 'codeAgentCommentOnLines:+2 to +4' }));

      const mobileCommentSheet = await screen.findByTestId('code-agent-mobile-review-comment-sheet');
      await waitFor(() => {
        expect(mobileCommentSheet.style.getPropertyValue('--code-agent-mobile-comment-bottom')).toContain('300px');
      });
    } finally {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: originalVisualViewport });
    }
  });

  it('clears a mobile diff comment selection without opening a draft', async () => {
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

    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled refreshKey="snapshot-1" mobileLayout />);

    fireEvent.click(await screen.findByLabelText('select diff lines file:app'));
    expect(await screen.findByTestId('code-agent-mobile-review-selection-action-bar')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('codeAgentCancelComment'));

    expect(screen.queryByTestId('code-agent-mobile-review-selection-action-bar')).toBeNull();
    expect(screen.queryByLabelText('codeAgentCommentOnLines:+2 to +4')).toBeNull();
  });

  it('keeps diff review annotations across workspace refreshes', async () => {
    const reviewComment: ReviewCommentContext = {
      id: 'comment-1',
      sectionId: 'workspace-diff:room-1:branch:auto',
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

    const { rerender } = render(
      <CodeAgentWorkspaceDiffViewer
        roomId="room-1"
        enabled
        refreshKey="snapshot-1"
        reviewComments={[reviewComment]}
      />,
    );

    expect(await screen.findByText('Please revisit this diff.')).toBeTruthy();

    rerender(
      <CodeAgentWorkspaceDiffViewer
        roomId="room-1"
        enabled
        refreshKey="snapshot-2"
        reviewComments={[reviewComment]}
      />,
    );

    await waitFor(() => expect(loadCodeAgentWorkspaceDiffMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Please revisit this diff.')).toBeTruthy();
    expect(screen.getByText('+2 to +4')).toBeTruthy();
  });

  it('matches diff annotation item versions without hashing entry kind', async () => {
    const reviewComment: ReviewCommentContext = {
      id: 'comment-1',
      sectionId: 'workspace-diff:room-1:branch:auto',
      sectionTitle: 'codeAgentChanges',
      filePath: 'src/App.tsx',
      startIndex: 1,
      endIndex: 3,
      rangeLabel: '+2 to +4',
      text: 'Please revisit this diff.',
      diff: '@@ -0,0 +2,3 @@\n+added 2\n+added 3\n+added 4',
      fenceLanguage: 'diff',
    };
    const secondReviewComment: ReviewCommentContext = {
      ...reviewComment,
      id: 'comment-2',
      text: 'Keep this aligned with the review state.',
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
        reviewComments={[reviewComment, secondReviewComment]}
      />,
    );

    expect(await screen.findByTestId('diff-line-annotation')).toBeTruthy();
    expect(screen.getByTestId('diff-file-file:app').dataset.version).toBe(String(
      fnv1a32('0:0:render:comment-1:+2 to +4:Please revisit this diff.:comment-2:+2 to +4:Keep this aligned with the review state.'),
    ));
    expect(screen.getByTestId('diff-file-file:app').dataset.version).not.toBe(String(
      fnv1a32('0:comment-1:comment:+2 to +4:Please revisit this diff.'),
    ));
    expect(screen.getByTestId('diff-file-file:app').dataset.version).not.toBe(String(
      fnv1a32('0:comment-1:+2 to +4:Please revisit this diff.|comment-2:+2 to +4:Keep this aligned with the review state.'),
    ));
  });

  it('does not create a draft for diff selections that review comments cannot map', async () => {
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

  it('renders parsed files directly in the T3 CodeView without a custom file nav', async () => {
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

    const codeView = await screen.findByTestId('code-view');
    expect(screen.queryByTestId('code-agent-diff-file-nav')).toBeNull();
    expect(within(codeView).getByText('src/App.tsx')).toBeTruthy();
    expect(within(codeView).getByText('src/utils.ts')).toBeTruthy();
    expect(codeView.parentElement?.className).toContain('min-h-0');
    expect(codeView.parentElement?.className).toContain('flex-1');
    expect(codeView.parentElement?.className).not.toContain('gap-2');
    expect(codeViewScrollToMock).not.toHaveBeenCalled();
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
      />,
    );

    const codeView = await screen.findByTestId('code-view');
    fireEvent.click(within(codeView).getByText('src/App.tsx'));

    expect(readCodeAgentRightPanelState('room-1')).toMatchObject({
      isOpen: true,
      activeSurfaceId: 'file:src/App.tsx',
      surfaces: [
        {
          id: 'file:src/App.tsx',
          kind: 'file',
          relativePath: 'src/App.tsx',
          revealLine: null,
        },
      ],
    });
  });

  it('opens a clicked diff line with a T3-style file reveal target', async () => {
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
      />,
    );

    const codeView = await screen.findByTestId('code-view');
    fireEvent.click(within(codeView).getByText('line 42'));

    expect(readCodeAgentRightPanelState('room-1')).toMatchObject({
      activeSurfaceId: 'file:src/App.tsx',
      surfaces: [
        {
          id: 'file:src/App.tsx',
          kind: 'file',
          relativePath: 'src/App.tsx',
          revealLine: 42,
        },
      ],
    });
  });

  it('does not open files from mobile diff line taps while keeping file title taps active', async () => {
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
        mobileLayout
      />,
    );

    const codeView = await screen.findByTestId('code-view');
    fireEvent.click(within(codeView).getByText('line 42'));

    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });

    fireEvent.click(within(codeView).getByText('src/App.tsx'));

    expect(readCodeAgentRightPanelState('room-1')).toMatchObject({
      activeSurfaceId: 'file:src/App.tsx',
      surfaces: [
        {
          id: 'file:src/App.tsx',
          kind: 'file',
          relativePath: 'src/App.tsx',
          revealLine: null,
        },
      ],
    });
  });

  it('resolves renamed diff line clicks to the next file reveal target', async () => {
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
      />,
    );

    fireEvent.click(await screen.findByText('gutter 24'));

    expect(readCodeAgentRightPanelState('room-1')).toMatchObject({
      activeSurfaceId: 'file:src/New.tsx',
      surfaces: [
        {
          id: 'file:src/New.tsx',
          kind: 'file',
          relativePath: 'src/New.tsx',
          revealLine: 24,
        },
      ],
    });
  });

  it('falls back to the only diff file when a line click has no file container', async () => {
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
      />,
    );

    const codeView = await screen.findByTestId('code-view');
    const file = codeView.querySelector('[data-diff]');
    file?.removeAttribute('data-diff');
    fireEvent.click(within(codeView).getByText('line 42'));

    expect(readCodeAgentRightPanelState('room-1')).toMatchObject({
      activeSurfaceId: 'file:src/App.tsx',
      surfaces: [
        {
          id: 'file:src/App.tsx',
          kind: 'file',
          relativePath: 'src/App.tsx',
          revealLine: 42,
        },
      ],
    });
  });

  it('does not guess the first diff title for unscoped line clicks in multi-file diffs', async () => {
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
      />,
    );

    const appFile = await screen.findByTestId('diff-file-file:app');
    appFile.removeAttribute('data-diff');
    screen.getByTestId('diff-file-file:utils').removeAttribute('data-diff');
    fireEvent.click(within(appFile).getByText('line 42'));

    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it('opens the resolved T3 diff path for renamed files', async () => {
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
      />,
    );

    fireEvent.click(await screen.findByText('src/Old.tsx → src/New.tsx'));

    expect(screen.getByTestId('diff-file-rename:src/New.tsx')).toBeTruthy();
    expect(readCodeAgentRightPanelState('room-1')).toMatchObject({
      activeSurfaceId: 'file:src/New.tsx',
      surfaces: [
        {
          id: 'file:src/New.tsx',
          kind: 'file',
          relativePath: 'src/New.tsx',
          revealLine: null,
        },
      ],
    });
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
    const renderModeGroup = screen.getByRole('group', {
      name: 'codeAgentStackedDiffView / codeAgentSplitDiffView',
    });
    expect(renderModeGroup.contains(screen.getByLabelText('codeAgentStackedDiffView'))).toBe(true);
    expect(renderModeGroup.contains(screen.getByLabelText('codeAgentSplitDiffView'))).toBe(true);
    expect(screen.getByLabelText('codeAgentStackedDiffView').className).toContain('h-7');
    expect(screen.getByLabelText('codeAgentSplitDiffView').className).toContain('h-7');
    expect(screen.getByLabelText('codeAgentStackedDiffView').className).toContain('rounded-r-none');
    expect(screen.getByLabelText('codeAgentSplitDiffView').className).toContain('rounded-l-none');
    fireEvent.click(within(renderModeGroup).getByLabelText('codeAgentSplitDiffView'));

    expect(screen.getByTestId('code-view').dataset.diffStyle).toBe('split');
    expect(localStorage.getItem('roomtalk.codeWorkspace.diffRenderMode')).toBe('split');
    expect(screen.getByLabelText('codeAgentSplitDiffView').getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(within(renderModeGroup).getByLabelText('codeAgentStackedDiffView'));

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
