// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeAgentFileBrowserPanel } from './CodeAgentFileBrowserPanel';
import { resetCodeAgentRightPanelStoreForTests } from '../utils/codeAgentRightPanelStore';
import {
  getOptimisticCodeAgentProjectFileQueryData,
  resetCodeAgentProjectFilesQueryStateForTests,
} from './codeAgentProjectFilesQueryState';

const loadCodeWorkspaceEntriesMock = vi.hoisted(() => vi.fn());
const searchCodeWorkspaceEntriesMock = vi.hoisted(() => vi.fn());
const loadCodeWorkspaceFileMock = vi.hoisted(() => vi.fn());
const createCodeWorkspaceAssetUrlMock = vi.hoisted(() => vi.fn());
const resolveCodeWorkspaceAssetUrlMock = vi.hoisted(() => vi.fn());
const writeCodeWorkspaceFileMock = vi.hoisted(() => vi.fn());
const createCodeWorkspaceDirectoryMock = vi.hoisted(() => vi.fn());
const renameCodeWorkspaceEntryMock = vi.hoisted(() => vi.fn());
const deleteCodeWorkspaceEntryMock = vi.hoisted(() => vi.fn());
const openSearchMock = vi.hoisted(() => vi.fn());
const resetPathsMock = vi.hoisted(() => vi.fn());
const focusPathMock = vi.hoisted(() => vi.fn());
const scrollToPathMock = vi.hoisted(() => vi.fn());
const fileTreeSelectedPathsRef = vi.hoisted(() => ({ current: [] as string[] }));
const getSelectedPathsMock = vi.hoisted(() => vi.fn<() => readonly string[]>(() => fileTreeSelectedPathsRef.current));
const selectTreeItemMock = vi.hoisted(() => vi.fn());
const deselectTreeItemMock = vi.hoisted(() => vi.fn());
const getItemMock = vi.hoisted(() => vi.fn((path: string) => ({
  deselect: () => {
    fileTreeSelectedPathsRef.current = fileTreeSelectedPathsRef.current.filter((selectedPath) => selectedPath !== path);
    deselectTreeItemMock(path);
  },
  select: () => {
    fileTreeSelectedPathsRef.current = [path];
    selectTreeItemMock(path);
  },
})));
const selectionHandlerRef = vi.hoisted(() => ({ current: null as null | ((paths: readonly string[]) => void) }));
const fileTreeSelectionPathRef = vi.hoisted(() => ({ current: 'src/App.tsx' }));
const fileTreeSearchStateRef = vi.hoisted(() => ({
  current: { isOpen: false, value: '' },
}));
const editorOptionsRef = vi.hoisted(() => ({ current: null as null | { onChange?: (file: { name: string; contents: string }, annotations?: unknown[]) => void } }));
const diffFileOptionsRef = vi.hoisted(() => ({
  current: null as null | {
    overflow?: 'scroll' | 'wrap';
    theme?: string;
    themeType?: string;
    unsafeCSS?: string;
    enableLineSelection?: boolean;
    onLineSelectionEnd?: (range: { start: number; end: number }) => void;
    onPostRender?: (container: HTMLElement, instance: { setSelectedLines: (range: unknown, options?: unknown) => void }, phase: 'mount' | 'update' | 'unmount') => void;
  },
}));
const nextEditorContentsRef = vi.hoisted(() => ({ current: 'export const changed = true;' }));
const editorSetSelectionsMock = vi.hoisted(() => vi.fn());
const fileInstanceSetSelectedLinesMock = vi.hoisted(() => vi.fn());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      if (key === 'codeAgentWorkspaceIndexing') return 'Indexing...';
      if (key === 'codeAgentWorkspaceFileCount') return `${params?.formattedCount} files`;
      if (key === 'codeAgentWorkspacePartial') return 'partial';
      if (params?.shown && params?.total) return `${key}:${params.shown}:${params.total}`;
      if (params?.path) return `${key}:${params.path}`;
      if (params?.range) return `${key}:${params.range}`;
      return key;
    },
  }),
}));

vi.mock('../utils/codeWorkspaceFiles', () => ({
  loadCodeWorkspaceEntries: loadCodeWorkspaceEntriesMock,
  searchCodeWorkspaceEntries: searchCodeWorkspaceEntriesMock,
  loadCodeWorkspaceFile: loadCodeWorkspaceFileMock,
  createCodeWorkspaceAssetUrl: createCodeWorkspaceAssetUrlMock,
  resolveCodeWorkspaceAssetUrl: resolveCodeWorkspaceAssetUrlMock,
  writeCodeWorkspaceFile: writeCodeWorkspaceFileMock,
  createCodeWorkspaceDirectory: createCodeWorkspaceDirectoryMock,
  renameCodeWorkspaceEntry: renameCodeWorkspaceEntryMock,
  deleteCodeWorkspaceEntry: deleteCodeWorkspaceEntryMock,
}));

vi.mock('./MarkdownContent', () => ({
  MarkdownContent: ({
    content,
    onTaskListChange,
    onOpenWorkspaceFile,
    onOpenWorkspaceFileInBrowserPreview,
  }: {
    content: string;
    onTaskListChange?: (change: { markerOffset: number; checked: boolean }) => void;
    onOpenWorkspaceFile?: (path: string) => void;
    onOpenWorkspaceFileInBrowserPreview?: (path: string) => void;
  }) => {
    const taskLines = content.split('\n').flatMap((line, lineIndex, lines) => {
      const lineStart = lines.slice(0, lineIndex).reduce((offset, previousLine) => offset + previousLine.length + 1, 0);
      const markerIndex = line.indexOf('[');
      return markerIndex >= 0 ? [{
        checked: /\[[xX]\]/.test(line),
        markerOffset: lineStart + markerIndex,
        label: line.replace(/^.*\]\s*/, ''),
      }] : [];
    });

    return (
      <div>
        {content.includes('Guide.md') ? (
          <button type="button" aria-label="open-guide-link" onClick={() => onOpenWorkspaceFile?.('docs/Guide.md#L2')}>
            open guide
          </button>
        ) : null}
        {content.includes('report.html') ? (
          <button type="button" aria-label="open-report-preview-link" onClick={() => onOpenWorkspaceFileInBrowserPreview?.('/workspace/output/report.html')}>
            open report preview
          </button>
        ) : null}
        {taskLines.map((task) => (
          <label key={task.markerOffset}>
            <input
              type="checkbox"
              checked={task.checked}
              onChange={(event) => onTaskListChange?.({
                markerOffset: task.markerOffset,
                checked: event.currentTarget.checked,
              })}
            />
            {task.label}
          </label>
        ))}
      </div>
    );
  },
}));

vi.mock('./CodeAgentWorkspaceDiffViewer', () => ({
  CodeAgentWorkspaceDiffViewer: ({
    enabled,
    onOpenFile,
    onFileSummariesChange,
    selectedFilePath,
    selectedFileRevealRequestId,
  }: {
    enabled: boolean;
    onOpenFile?: (path: string) => void;
    onFileSummariesChange?: (summaries: readonly { id: string; path: string; additions: number; deletions: number }[]) => void;
    selectedFilePath?: string | null;
    selectedFileRevealRequestId?: number;
  }) => (
    <div
      data-testid="code-agent-workspace-diff-viewer"
      data-enabled={String(enabled)}
      data-selected-file={selectedFilePath || ''}
      data-selected-file-request-id={String(selectedFileRevealRequestId || '')}
    >
      <button type="button" aria-label="open-diff-file" onClick={() => onOpenFile?.('src/App.tsx#L3')}>
        open diff file
      </button>
      <button
        type="button"
        data-testid="emit-diff-file-summaries"
        onClick={() => onFileSummariesChange?.([
          { id: 'file:app', path: 'src/App.tsx', additions: 7, deletions: 3 },
          { id: 'file:utils', path: 'src/utils.ts', additions: 1, deletions: 0 },
        ])}
      >
        emit summaries
      </button>
      <button
        type="button"
        data-testid="emit-empty-diff-file-summaries"
        onClick={() => onFileSummariesChange?.([])}
      >
        emit empty summaries
      </button>
    </div>
  ),
}));

vi.mock('@pierre/diffs', () => ({
  VirtualizedFile: class {},
}));

vi.mock('@pierre/trees/react', () => ({
  useFileTree: (options: { onSelectionChange?: (paths: readonly string[]) => void }) => {
    selectionHandlerRef.current = options.onSelectionChange || null;
    return {
      model: {
        openSearch: openSearchMock,
        resetPaths: resetPathsMock,
        focusPath: focusPathMock,
        scrollToPath: scrollToPathMock,
        getSelectedPaths: getSelectedPathsMock,
        getItem: getItemMock,
      },
    };
  },
  useFileTreeSearch: () => ({
    ...fileTreeSearchStateRef.current,
    close: vi.fn(),
    focusNextMatch: vi.fn(),
    focusPreviousMatch: vi.fn(),
    open: vi.fn(),
    setValue: vi.fn(),
  }),
  FileTree: ({ 'aria-label': ariaLabel }: { 'aria-label': string }) => (
    <button type="button" aria-label={ariaLabel} onClick={() => selectionHandlerRef.current?.([fileTreeSelectionPathRef.current])}>
      file-tree
    </button>
  ),
}));

vi.mock('@pierre/diffs/editor', () => ({
  Editor: class {
    constructor(options: { onChange?: (file: { name: string; contents: string }, annotations?: unknown[]) => void }) {
      editorOptionsRef.current = options;
    }

    setSelections(selections: []) {
      editorSetSelectionsMock(selections);
    }

    cleanUp() {}
  },
}));

vi.mock('@pierre/diffs/react', () => ({
  EditorProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Virtualizer: ({ children }: { children: React.ReactNode }) => <div data-testid="virtualizer">{children}</div>,
  File: ({
    file,
    options,
    selectedLines,
    lineAnnotations = [],
    renderAnnotation,
  }: {
    file: { name: string; contents: string; cacheKey?: string };
    options: {
      overflow?: 'scroll' | 'wrap';
      enableLineSelection?: boolean;
      onLineSelectionEnd?: (range: { start: number; end: number }) => void;
      onPostRender?: (container: HTMLElement, instance: { setSelectedLines: (range: unknown, options?: unknown) => void }, phase: 'mount' | 'update' | 'unmount') => void;
      theme?: string;
      themeType?: string;
      unsafeCSS?: string;
    };
    selectedLines?: { start: number; end: number } | null;
    lineAnnotations?: Array<{ lineNumber: number; metadata: { entries: Array<{ id: string; kind: 'draft' | 'comment'; startLine: number; endLine: number; text: string }> } }>;
    renderAnnotation?: (annotation: { lineNumber: number; metadata: { entries: Array<{ id: string; kind: 'draft' | 'comment'; startLine: number; endLine: number; text: string }> } }) => React.ReactNode;
  }) => {
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    diffFileOptionsRef.current = options;
    React.useEffect(() => {
      const container = containerRef.current;
      if (!container) {
        return undefined;
      }
      const instance = {
        setSelectedLines: fileInstanceSetSelectedLinesMock,
      };
      options.onPostRender?.(container, instance, 'update');
      return () => options.onPostRender?.(container, instance, 'unmount');
    }, [options, selectedLines]);

    return (
    <div ref={containerRef}>
      <button
        type="button"
        data-testid="diff-file"
        data-cache-key={file.cacheKey}
        data-overflow={options.overflow}
        onClick={() => editorOptionsRef.current?.onChange?.({ ...file, contents: nextEditorContentsRef.current })}
      >
        {file.name}:{file.contents}
      </button>
      <button
        type="button"
        aria-label="select-lines"
        disabled={!options.enableLineSelection}
        onClick={() => options.onLineSelectionEnd?.({ start: 2, end: 4 })}
      >
        select lines
      </button>
      {lineAnnotations.map((annotation) => (
        <div key={annotation.lineNumber} data-testid="line-annotation">
          {renderAnnotation?.(annotation)}
        </div>
      ))}
    </div>
  );
  },
}));

const dispatchPointer = (
  target: EventTarget,
  type: string,
  values: { pointerId: number; clientX: number; buttons: number; button?: number; clientY?: number },
) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: values.pointerId },
    clientX: { value: values.clientX },
    clientY: { value: values.clientY ?? 100 },
    buttons: { value: values.buttons },
    button: { value: values.button ?? 0 },
  });
  target.dispatchEvent(event);
};

describe('CodeAgentFileBrowserPanel', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    loadCodeWorkspaceEntriesMock.mockReset();
    searchCodeWorkspaceEntriesMock.mockReset();
    loadCodeWorkspaceFileMock.mockReset();
    createCodeWorkspaceAssetUrlMock.mockReset();
    resolveCodeWorkspaceAssetUrlMock.mockReset();
    writeCodeWorkspaceFileMock.mockReset();
    createCodeWorkspaceDirectoryMock.mockReset();
    renameCodeWorkspaceEntryMock.mockReset();
    deleteCodeWorkspaceEntryMock.mockReset();
    openSearchMock.mockReset();
    resetPathsMock.mockReset();
    focusPathMock.mockReset();
    scrollToPathMock.mockReset();
    getSelectedPathsMock.mockReset();
    fileTreeSelectedPathsRef.current = [];
    getSelectedPathsMock.mockImplementation(() => fileTreeSelectedPathsRef.current);
    getItemMock.mockReset();
    getItemMock.mockImplementation((path: string) => ({
      deselect: () => {
        fileTreeSelectedPathsRef.current = fileTreeSelectedPathsRef.current.filter((selectedPath) => selectedPath !== path);
        deselectTreeItemMock(path);
      },
      select: () => {
        fileTreeSelectedPathsRef.current = [path];
        selectTreeItemMock(path);
      },
    }));
    selectTreeItemMock.mockReset();
    deselectTreeItemMock.mockReset();
    selectionHandlerRef.current = null;
    fileTreeSelectionPathRef.current = 'src/App.tsx';
    fileTreeSearchStateRef.current = { isOpen: false, value: '' };
    editorOptionsRef.current = null;
    diffFileOptionsRef.current = null;
    nextEditorContentsRef.current = 'export const changed = true;';
    editorSetSelectionsMock.mockReset();
    fileInstanceSetSelectedLinesMock.mockReset();
    document.documentElement.classList.remove('dark');
    localStorage.clear();
    resetCodeAgentRightPanelStoreForTests();
    resetCodeAgentProjectFilesQueryStateForTests();
  });

  it('uses the T3-style tree plus embedded file preview instead of opening a download tab', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'src/App.tsx',
      content: 'export default function App() {}',
      byteSize: 32,
      truncated: false,
      encoding: 'utf-8',
    });
    writeCodeWorkspaceFileMock.mockResolvedValue({ path: 'src/App.tsx', name: 'App.tsx', type: 'file' });
    const open = vi.spyOn(window, 'open');

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    expect(await screen.findByText(/files/)).toBeTruthy();
    await waitFor(() => {
      expect(resetPathsMock).toHaveBeenCalledWith(['src/', 'src/App.tsx']);
    });

    fireEvent.click(screen.getByLabelText('codeAgentSearchWorkspaceFiles'));
    expect(openSearchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('Coco files'));
    const diffFile = await screen.findByTestId('diff-file');
    expect(diffFile.textContent).toBe('src/App.tsx:export default function App() {}');
    expect(diffFile.dataset.cacheKey).toMatch(/^room-1:src\/App\.tsx:/);
    expect(loadCodeWorkspaceFileMock).toHaveBeenCalledWith('room-1', 'src/App.tsx', expect.any(Object));
    const explorerResizeHandle = screen.getByLabelText('codeAgentResizeFileExplorer');
    const explorer = explorerResizeHandle.closest('aside') as HTMLElement;
    expect(explorer.style.width).toBe('var(--workspace-file-explorer-width)');
    expect(explorer.style.maxWidth).toBe('calc(100% - 220px)');
    expect(explorer.className).not.toContain('50%');
    expect(explorerResizeHandle.className).toContain('w-8');
    expect(explorerResizeHandle.className).not.toContain('hover:bg');
    const highlight = explorerResizeHandle.querySelector('[data-code-agent-resize-highlight="file-explorer"]');
    expect(highlight?.className).toContain('w-0.5');
    expect(highlight?.className).toContain('-ml-px');
    expect(highlight?.className).toContain('z-50');
    expect(open).not.toHaveBeenCalled();
  });

  it('resizes the file explorer against the looser preview-preserving cap', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'src/App.tsx',
      content: 'export default function App() {}',
      byteSize: 32,
      truncated: false,
      encoding: 'utf-8',
    });

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('1 files');
    fireEvent.click(screen.getByLabelText('Coco files'));
    expect(await screen.findByTestId('diff-file')).toBeTruthy();

    const panel = document.querySelector<HTMLElement>('[data-file-browser-panel="room-1:workspace"]');
    expect(panel).toBeTruthy();
    vi.spyOn(panel!, 'getBoundingClientRect').mockReturnValue({
      width: 700,
      height: 900,
      top: 0,
      right: 700,
      bottom: 900,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const explorerResizeHandle = screen.getByLabelText('codeAgentResizeFileExplorer');
    dispatchPointer(explorerResizeHandle, 'pointerdown', { pointerId: 11, clientX: 500, buttons: 1 });
    dispatchPointer(window, 'pointermove', { pointerId: 11, clientX: 0, buttons: 1 });
    dispatchPointer(window, 'pointerup', { pointerId: 11, clientX: 0, buttons: 0 });

    expect(panel!.style.getPropertyValue('--workspace-file-explorer-width')).toBe('480px');
    expect(localStorage.getItem('roomtalk.codeWorkspace.fileExplorerWidth')).toBe('480');
  });

  it('tracks T3-style file surfaces as switchable preview tabs', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
        { path: 'docs/Guide.md', name: 'Guide.md', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockImplementation((_roomId: string, path: string) => Promise.resolve({
      path,
      content: `contents:${path}`,
      byteSize: 64,
      truncated: false,
      encoding: 'utf-8',
    }));

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('2 files');

    fileTreeSelectionPathRef.current = 'src/App.tsx';
    fireEvent.click(screen.getByLabelText('Coco files'));
    expect((await screen.findByTestId('diff-file')).textContent).toBe('src/App.tsx:contents:src/App.tsx');

    fileTreeSelectionPathRef.current = 'docs/Guide.md';
    fireEvent.click(screen.getByLabelText('Coco files'));
    await waitFor(() => {
      expect(screen.getByTestId('diff-file').textContent).toBe('docs/Guide.md:contents:docs/Guide.md');
    });

    const tabs = screen.getByTestId('code-agent-file-surface-tabs');
    expect(tabs.className).toContain('overflow-x-auto');
    expect(tabs.firstElementChild?.className).toContain('w-max');
    expect(tabs.firstElementChild?.className).toContain('min-w-full');
    expect(tabs.textContent).toContain('App.tsx');
    expect(tabs.textContent).toContain('Guide.md');
    expect(tabs.querySelector('[data-pierre-icon]')).toBeTruthy();
    expect(screen.getByLabelText('close src/App.tsx').className).toContain('opacity-0');
    expect(screen.getByLabelText('close src/App.tsx').className).toContain('group-hover:opacity-100');

    fireEvent.click(screen.getByText('App.tsx'));
    await waitFor(() => {
      expect(screen.getByTestId('diff-file').textContent).toBe('src/App.tsx:contents:src/App.tsx');
    });

    fireEvent.click(screen.getByLabelText('close src/App.tsx'));
    await waitFor(() => {
      expect(screen.getByTestId('diff-file').textContent).toBe('docs/Guide.md:contents:docs/Guide.md');
    });
  });

  it('keeps the T3-style active file surface tab scrolled into view', async () => {
    const scrolledTabTexts: string[] = [];
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value(this: HTMLElement) {
        scrolledTabTexts.push(this.textContent ?? '');
      },
    });
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
        { path: 'docs/Guide.md', name: 'Guide.md', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockImplementation((_roomId: string, path: string) => Promise.resolve({
      path,
      content: `contents:${path}`,
      byteSize: 64,
      truncated: false,
      encoding: 'utf-8',
    }));

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('2 files');

    fileTreeSelectionPathRef.current = 'src/App.tsx';
    fireEvent.click(screen.getByLabelText('Coco files'));
    expect((await screen.findByTestId('diff-file')).textContent).toBe('src/App.tsx:contents:src/App.tsx');

    fileTreeSelectionPathRef.current = 'docs/Guide.md';
    fireEvent.click(screen.getByLabelText('Coco files'));

    await waitFor(() => {
      const tabs = within(screen.getByTestId('code-agent-file-surface-tabs'));
      const guideTab = tabs.getByText('Guide.md').closest('[role="tab"]');
      expect(guideTab?.getAttribute('data-active-tab')).toBe('true');
      expect(scrolledTabTexts.some((text) => text.includes('Guide.md'))).toBe(true);
    });
  });

  it('opens and restores the T3-style Files surface from the right panel tabs', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'src/App.tsx',
      content: 'contents:src/App.tsx',
      byteSize: 64,
      truncated: false,
      encoding: 'utf-8',
    });

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('1 files');
    expect(screen.getByTestId('code-agent-file-surface-tabs').textContent).toContain('codeAgentWorkspaceFiles');
    expect(screen.queryByTestId('diff-file')).toBeNull();

    fileTreeSelectionPathRef.current = 'src/App.tsx';
    fireEvent.click(screen.getByLabelText('Coco files'));
    await waitFor(() => {
      expect(screen.getByTestId('diff-file').textContent).toBe('src/App.tsx:contents:src/App.tsx');
    });
    expect(screen.getByTestId('code-agent-file-surface-tabs').textContent).not.toContain('codeAgentWorkspaceFiles');

    fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
    const addMenuElement = screen.getByTestId('code-agent-file-surface-add-menu');
    expect(screen.getByTestId('code-agent-file-surface-tabs').contains(addMenuElement)).toBe(false);
    expect(addMenuElement.className).toContain('fixed');
    const addMenu = within(addMenuElement);
    const browserSurfaceButton = addMenu.getByText('codeAgentBrowserSurface').closest('button')!;
    const terminalSurfaceButton = addMenu.getByText('codeAgentTerminalSurface').closest('button')!;
    expect(browserSurfaceButton.disabled).toBe(false);
    expect(browserSurfaceButton.getAttribute('aria-disabled')).toBeNull();
    expect(browserSurfaceButton.getAttribute('title')).toBeNull();
    expect(terminalSurfaceButton.disabled).toBe(true);
    expect(terminalSurfaceButton.getAttribute('aria-disabled')).toBe('true');
    expect(terminalSurfaceButton.getAttribute('title')).toBe('codeAgentTerminalSurfaceUnavailable');
    fireEvent.click(browserSurfaceButton);
    await waitFor(() => {
      expect(screen.getByTestId('code-agent-browser-surface-empty')).toBeTruthy();
      expect(within(screen.getByTestId('code-agent-file-surface-tabs')).getByText('codeAgentBrowserSurface')).toBeTruthy();
      expect(screen.queryByTestId('diff-file')).toBeNull();
    });

    fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentWorkspaceFiles'));
    await waitFor(() => {
      expect(screen.queryByTestId('diff-file')).toBeNull();
      expect(screen.getByTestId('code-agent-file-surface-tabs').textContent).toContain('codeAgentWorkspaceFiles');
    });
  });

  it('opens a T3-style Diff surface in the right panel and can jump to file surfaces', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'src/App.tsx',
      content: 'contents:src/App.tsx',
      byteSize: 64,
      truncated: false,
      encoding: 'utf-8',
    });

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('1 files');
    fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentChanges'));

    expect(screen.getByTestId('code-agent-workspace-diff-viewer').dataset.enabled).toBe('true');
    expect(screen.getByTestId('code-agent-file-surface-tabs').textContent).toContain('codeAgentChanges');
    expect(screen.queryByTestId('diff-file')).toBeNull();

    fireEvent.click(screen.getByLabelText('open-diff-file'));

    await waitFor(() => {
      expect(screen.getByTestId('diff-file').textContent).toBe('src/App.tsx:contents:src/App.tsx');
    });
    expect(screen.getByTestId('code-agent-file-surface-tabs').textContent).toContain('codeAgentChanges');
    expect(screen.getByTestId('code-agent-file-surface-tabs').textContent).toContain('App.tsx');
  });

  it('renders a T3-style changed-files tree for the active Diff surface and selects diff items', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
        { path: 'src/utils.ts', name: 'utils.ts', type: 'file' },
      ],
      truncated: false,
    });

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('2 files');
    fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentChanges'));

    expect(screen.queryByTestId('code-agent-diff-changed-files-sidebar')).toBeNull();
    fireEvent.click(screen.getByTestId('emit-diff-file-summaries'));

    const sidebar = await screen.findByTestId('code-agent-diff-changed-files-sidebar');
    expect(within(sidebar).getByTestId('code-agent-changed-files-tree')).toBeTruthy();
    expect(within(sidebar).getByText('codeAgentChangedFilesCount')).toBeTruthy();
    expect(within(sidebar).getByText('+7')).toBeTruthy();
    expect(within(sidebar).getAllByText('-3').length).toBeGreaterThan(0);
    expect(within(sidebar).getByText('codeAgentCollapseChangedFileTree').hasAttribute('data-scroll-anchor-ignore')).toBe(true);

    fireEvent.click(within(sidebar).getByText('App.tsx'));
    expect(screen.getByTestId('code-agent-workspace-diff-viewer').dataset.selectedFile).toBe('src/App.tsx');
    expect(screen.getByTestId('code-agent-workspace-diff-viewer').dataset.selectedFileRequestId).toBe('1');
    expect(screen.queryByTestId('diff-file')).toBeNull();

    fireEvent.click(within(sidebar).getByText('App.tsx'));
    expect(screen.getByTestId('code-agent-workspace-diff-viewer').dataset.selectedFile).toBe('src/App.tsx');
    expect(screen.getByTestId('code-agent-workspace-diff-viewer').dataset.selectedFileRequestId).toBe('2');

    fireEvent.click(screen.getByTestId('emit-empty-diff-file-summaries'));
    expect(screen.queryByTestId('code-agent-diff-changed-files-sidebar')).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId('code-agent-workspace-diff-viewer').dataset.selectedFile).toBe('');
    });
  });

  it('supports T3-style file tab menu and middle-click close actions', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeTextMock },
    });
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
        { path: 'docs/Guide.md', name: 'Guide.md', type: 'file' },
        { path: 'docs/Notes.md', name: 'Notes.md', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockImplementation((_roomId: string, path: string) => Promise.resolve({
      path,
      content: `contents:${path}`,
      byteSize: 64,
      truncated: false,
      encoding: 'utf-8',
    }));

    const openFile = async (path: string) => {
      fileTreeSelectionPathRef.current = path;
      fireEvent.click(screen.getByLabelText('Coco files'));
      await waitFor(() => {
        expect(screen.getByTestId('diff-file').textContent).toBe(`${path}:contents:${path}`);
      });
    };

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('3 files');
    await openFile('src/App.tsx');
    await openFile('docs/Guide.md');
    await openFile('docs/Notes.md');

    let tabs = within(screen.getByTestId('code-agent-file-surface-tabs'));
    fireEvent.contextMenu(tabs.getByText('Guide.md'), { clientX: 12, clientY: 34 });
    fireEvent.click(screen.getByText('codeAgentCopyFilePath'));
    expect(writeTextMock).toHaveBeenCalledWith('docs/Guide.md');

    tabs = within(screen.getByTestId('code-agent-file-surface-tabs'));
    fireEvent.contextMenu(tabs.getByText('Guide.md'), { clientX: 12, clientY: 34 });
    fireEvent.click(screen.getByText('codeAgentCloseFileTabsToRight'));
    await waitFor(() => {
      const tabList = screen.getByTestId('code-agent-file-surface-tabs');
      expect(tabList.textContent).toContain('App.tsx');
      expect(tabList.textContent).toContain('Guide.md');
      expect(tabList.textContent).not.toContain('Notes.md');
      expect(screen.getByTestId('diff-file').textContent).toBe('docs/Guide.md:contents:docs/Guide.md');
    });

    await openFile('docs/Notes.md');
    tabs = within(screen.getByTestId('code-agent-file-surface-tabs'));
    const appTab = tabs.getByText('App.tsx').closest('[role="tab"]')!;
    fireEvent.mouseDown(appTab, { button: 1 });
    fireEvent(appTab, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    await waitFor(() => {
      expect(screen.getByTestId('code-agent-file-surface-tabs').textContent).not.toContain('App.tsx');
    });

    tabs = within(screen.getByTestId('code-agent-file-surface-tabs'));
    fireEvent.contextMenu(tabs.getByText('Guide.md'), { clientX: 12, clientY: 34 });
    fireEvent.click(screen.getByText('codeAgentCloseOtherFileTabs'));
    await waitFor(() => {
      const tabList = screen.getByTestId('code-agent-file-surface-tabs');
      expect(tabList.textContent).toContain('Guide.md');
      expect(tabList.textContent).not.toContain('Notes.md');
      expect(screen.getByTestId('diff-file').textContent).toBe('docs/Guide.md:contents:docs/Guide.md');
    });

    tabs = within(screen.getByTestId('code-agent-file-surface-tabs'));
    fireEvent.contextMenu(tabs.getByText('Guide.md'), { clientX: 12, clientY: 34 });
    fireEvent.click(screen.getByText('codeAgentCloseAllFileTabs'));
    await waitFor(() => {
      expect(screen.queryByTestId('code-agent-file-surface-tabs')).toBeNull();
      expect(screen.queryByTestId('diff-file')).toBeNull();
    });

    const emptyState = screen.getByTestId('code-agent-file-surface-empty');
    expect(emptyState.textContent).toContain('codeAgentOpenWorkspaceSurface');
    expect(screen.queryByText('3 files')).toBeNull();
    const browserSurfaceButton = within(emptyState).getByText('codeAgentBrowserSurface').closest('button')!;
    const terminalSurfaceButton = within(emptyState).getByText('codeAgentTerminalSurface').closest('button')!;
    expect(browserSurfaceButton.disabled).toBe(false);
    expect(browserSurfaceButton.getAttribute('title')).toBeNull();
    expect(terminalSurfaceButton.disabled).toBe(true);
    expect(terminalSurfaceButton.getAttribute('title')).toBe('codeAgentTerminalSurfaceUnavailable');

    fireEvent.click(within(emptyState).getByText('codeAgentChanges'));
    await waitFor(() => {
      expect(screen.getByTestId('code-agent-workspace-diff-viewer').dataset.enabled).toBe('true');
      expect(screen.getByTestId('code-agent-file-surface-tabs').textContent).toContain('codeAgentChanges');
    });
  });

  it('keeps T3-style file surface menus inside the viewport', async () => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 180,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: 120,
    });
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'src/App.tsx',
      content: 'contents:src/App.tsx',
      byteSize: 64,
      truncated: false,
      encoding: 'utf-8',
    });

    try {
      render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
      await screen.findByText('1 files');

      fileTreeSelectionPathRef.current = 'src/App.tsx';
      fireEvent.click(screen.getByLabelText('Coco files'));
      expect((await screen.findByTestId('diff-file')).textContent).toBe('src/App.tsx:contents:src/App.tsx');

      const addSurfaceButton = screen.getByLabelText('codeAgentAddWorkspaceSurface') as HTMLButtonElement;
      addSurfaceButton.getBoundingClientRect = () => ({
        x: 500,
        y: 500,
        left: 500,
        top: 500,
        right: 524,
        bottom: 524,
        width: 24,
        height: 24,
        toJSON: () => ({}),
      });
      fireEvent.click(addSurfaceButton);
      const addMenuElement = screen.getByTestId('code-agent-file-surface-add-menu');
      expect(addMenuElement.className).toContain('fixed');
      expect(addMenuElement.style.left).toBe('12px');
      expect(addMenuElement.style.top).toBe('8px');
      fireEvent.click(addSurfaceButton);

      const tabs = within(screen.getByTestId('code-agent-file-surface-tabs'));
      fireEvent.contextMenu(tabs.getByText('App.tsx'), { clientX: 500, clientY: 500 });
      const tabMenuElement = screen.getByTestId('code-agent-file-surface-menu');
      expect(tabMenuElement.className).toContain('fixed');
      expect(tabMenuElement.style.left).toBe('12px');
      expect(tabMenuElement.style.top).toBe('8px');
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: originalInnerWidth,
      });
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        writable: true,
        value: originalInnerHeight,
      });
    }
  });

  it('keeps the current file preview when a directory is selected for file operations', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
        { path: 'src/components', name: 'components', type: 'directory' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'src/App.tsx',
      content: 'export default function App() {}',
      byteSize: 32,
      truncated: false,
      encoding: 'utf-8',
    });
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    expect(await screen.findByText('1 files')).toBeTruthy();
    fileTreeSelectionPathRef.current = 'src/App.tsx';
    fireEvent.click(screen.getByLabelText('Coco files'));
    expect((await screen.findByTestId('diff-file')).textContent).toBe('src/App.tsx:export default function App() {}');

    fileTreeSelectionPathRef.current = 'src/components/';
    fireEvent.click(screen.getByLabelText('Coco files'));

    expect(screen.getByTestId('diff-file').textContent).toBe('src/App.tsx:export default function App() {}');
    fireEvent.click(screen.getByLabelText('codeAgentNewFile'));
    expect(prompt).toHaveBeenCalledWith('codeAgentNewFilePrompt', 'src/components/untitled.txt');
  });

  it('toggles T3-style file source line wrapping and persists the preference', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'src/App.tsx',
      content: 'export default function App() {}',
      byteSize: 32,
      truncated: false,
      encoding: 'utf-8',
    });

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('1 files');
    fireEvent.click(screen.getByLabelText('Coco files'));

    expect((await screen.findByTestId('diff-file')).dataset.overflow).toBe('scroll');

    fireEvent.click(screen.getByLabelText('codeAgentEnableFileLineWrapping'));

    expect(screen.getByTestId('diff-file').dataset.overflow).toBe('wrap');
    expect(screen.getByLabelText('codeAgentDisableFileLineWrapping')).toBeTruthy();
    expect(localStorage.getItem('roomtalk.codeWorkspace.fileWordWrap')).toBe('true');
  });

  it('passes T3-style theme and file reveal CSS into editable file previews', async () => {
    document.documentElement.classList.add('dark');
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'src/App.tsx',
      content: 'export default function App() {}',
      byteSize: 32,
      truncated: false,
      encoding: 'utf-8',
    });

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('1 files');
    fireEvent.click(screen.getByLabelText('Coco files'));
    await screen.findByTestId('diff-file');

    expect(diffFileOptionsRef.current?.theme).toBe('pierre-dark');
    expect(diffFileOptionsRef.current?.themeType).toBe('dark');
    expect(diffFileOptionsRef.current?.unsafeCSS).toContain('[data-file-link-reveal][data-line]');
    expect(diffFileOptionsRef.current?.unsafeCSS).toContain('light-dark(');
    expect(diffFileOptionsRef.current?.unsafeCSS).toContain('in lab');
  });

  it('uses a signed workspace-file asset URL for HTML previews', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'output/report.html', name: 'report.html', type: 'file' },
      ],
      truncated: false,
    });
    const assetUrl = deferred<{
      relativeUrl: string;
      expiresAt: string;
    }>();
    createCodeWorkspaceAssetUrlMock.mockReturnValue(assetUrl.promise);
    resolveCodeWorkspaceAssetUrlMock.mockReturnValue('/api/coco/workspace-assets/token/report.html');

    const { container } = render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    expect(await screen.findByText('1 files')).toBeTruthy();
    selectionHandlerRef.current?.(['output/report.html']);

    await waitFor(() => {
      expect(createCodeWorkspaceAssetUrlMock).toHaveBeenCalledWith('room-1', 'output/report.html', expect.any(Object));
    });
    expect(screen.getByRole('status', { name: 'codeAgentPreparingBrowserPreview' })).toBeTruthy();
    expect(container.querySelector('iframe')).toBeNull();

    await act(async () => {
      assetUrl.resolve({
        relativeUrl: '/api/coco/workspace-assets/token/report.html',
        expiresAt: '2026-06-30T12:15:00.000Z',
      });
    });

    const iframe = container.querySelector('iframe') as HTMLIFrameElement | null;
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute('src')).toBe('/api/coco/workspace-assets/token/report.html');
    expect(screen.getByRole('status', { name: 'codeAgentLoadingBrowserPreview' })).toBeTruthy();
    fireEvent.load(iframe as HTMLIFrameElement);
    await waitFor(() => {
      expect(screen.queryByRole('status', { name: 'codeAgentLoadingBrowserPreview' })).toBeNull();
    });
    expect(loadCodeWorkspaceFileMock).not.toHaveBeenCalled();
  });

  it('shows T3-style image preview loading and failure states for signed asset URLs', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'assets/logo.png', name: 'logo.png', type: 'file' },
      ],
      truncated: false,
    });
    const assetUrl = deferred<{
      relativeUrl: string;
      expiresAt: string;
    }>();
    createCodeWorkspaceAssetUrlMock.mockReturnValue(assetUrl.promise);
    resolveCodeWorkspaceAssetUrlMock.mockReturnValue('/api/coco/workspace-assets/token/logo.png');

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    expect(await screen.findByText('1 files')).toBeTruthy();
    selectionHandlerRef.current?.(['assets/logo.png']);

    expect(await screen.findByRole('status', { name: 'codeAgentPreparingImagePreview' })).toBeTruthy();
    await act(async () => {
      assetUrl.resolve({
        relativeUrl: '/api/coco/workspace-assets/token/logo.png',
        expiresAt: '2026-06-30T12:15:00.000Z',
      });
    });

    const image = await screen.findByAltText('assets/logo.png') as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('/api/coco/workspace-assets/token/logo.png');
    expect(screen.queryByLabelText('codeAgentShowSource')).toBeNull();
    expect(screen.getByRole('status', { name: 'codeAgentLoadingImagePreview' })).toBeTruthy();

    fireEvent.load(image);
    fireEvent.click(screen.getByLabelText('codeAgentOpenImagePreviewFullscreen:assets/logo.png'));
    let fullScreenPreview = screen.getByTestId('code-agent-image-fullscreen-preview');
    expect(fullScreenPreview.getAttribute('role')).toBe('dialog');
    expect(screen.getAllByAltText('assets/logo.png')).toHaveLength(2);

    fireEvent.click(within(fullScreenPreview).getByLabelText('close'));
    await waitFor(() => {
      expect(screen.queryByTestId('code-agent-image-fullscreen-preview')).toBeNull();
    });

    fireEvent.click(screen.getByLabelText('codeAgentOpenImagePreviewFullscreen:assets/logo.png'));
    fullScreenPreview = screen.getByTestId('code-agent-image-fullscreen-preview');
    expect(fullScreenPreview.getAttribute('aria-label')).toBe('codeAgentImagePreviewFullscreen:assets/logo.png');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('code-agent-image-fullscreen-preview')).toBeNull();
    });

    fireEvent.click(screen.getByLabelText('codeAgentRefreshWorkspaceFile'));
    await waitFor(() => {
      expect(image.getAttribute('src')).toBe('/api/coco/workspace-assets/token/logo.png?revision=1');
    });

    fireEvent.error(image);

    expect(screen.getByText('codeAgentImagePreviewUnavailable')).toBeTruthy();
    expect(screen.getByText('codeAgentImagePreviewLoadFailed')).toBeTruthy();
    expect(loadCodeWorkspaceFileMock).not.toHaveBeenCalled();
  });

  it('renders SVG image previews through the T3-style web preview surface', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'assets/diagram.svg', name: 'diagram.svg', type: 'file' },
      ],
      truncated: false,
    });
    createCodeWorkspaceAssetUrlMock.mockResolvedValue({
      relativeUrl: '/api/coco/workspace-assets/token/diagram.svg',
      expiresAt: '2026-06-30T12:15:00.000Z',
    });
    resolveCodeWorkspaceAssetUrlMock.mockReturnValue('/api/coco/workspace-assets/token/diagram.svg');

    const { container } = render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    expect(await screen.findByText('1 files')).toBeTruthy();
    selectionHandlerRef.current?.(['assets/diagram.svg']);

    await waitFor(() => {
      expect(createCodeWorkspaceAssetUrlMock).toHaveBeenCalledWith('room-1', 'assets/diagram.svg', expect.any(Object));
    });
    expect(screen.queryByAltText('assets/diagram.svg')).toBeNull();
    expect(screen.queryByLabelText('codeAgentShowSource')).toBeNull();
    const iframe = container.querySelector('iframe') as HTMLIFrameElement | null;
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute('src')).toBe('/api/coco/workspace-assets/token/diagram.svg');
    fireEvent.error(iframe as HTMLIFrameElement);
    await waitFor(() => {
      expect(screen.getByText('codeAgentBrowserPreviewFailed')).toBeTruthy();
    });
    expect(screen.getByText('codeAgentBrowserPreviewLoadFailed')).toBeTruthy();
    expect(loadCodeWorkspaceFileMock).not.toHaveBeenCalled();
  });

  it('refreshes T3-style asset previews without reading file contents', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'output/report.html', name: 'report.html', type: 'file' },
      ],
      truncated: false,
    });
    createCodeWorkspaceAssetUrlMock.mockResolvedValue({
      relativeUrl: '/api/coco/workspace-assets/token/report.html',
      expiresAt: '2026-06-30T12:15:00.000Z',
    });
    resolveCodeWorkspaceAssetUrlMock.mockReturnValue('/api/coco/workspace-assets/token/report.html');

    const { container } = render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    expect(await screen.findByText('1 files')).toBeTruthy();
    selectionHandlerRef.current?.(['output/report.html']);
    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('/api/coco/workspace-assets/token/report.html');
    });

    fireEvent.click(screen.getByLabelText('codeAgentRefreshWorkspaceFile'));

    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('/api/coco/workspace-assets/token/report.html?revision=1');
    });
    expect(loadCodeWorkspaceFileMock).not.toHaveBeenCalled();
    expect(createCodeWorkspaceAssetUrlMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes the current source file through the workspace read API', async () => {
    let fileContent = 'old content';
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockImplementation((_roomId: string, path: string) => Promise.resolve({
      path,
      content: fileContent,
      byteSize: fileContent.length,
      truncated: false,
      encoding: 'utf-8',
    }));

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    expect(await screen.findByText('1 files')).toBeTruthy();
    selectionHandlerRef.current?.(['src/App.tsx']);
    expect((await screen.findByTestId('diff-file')).textContent).toBe('src/App.tsx:old content');

    fileContent = 'new content';
    fireEvent.click(screen.getByLabelText('codeAgentRefreshWorkspaceFile'));

    await waitFor(() => {
      expect(loadCodeWorkspaceFileMock).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId('diff-file').textContent).toBe('src/App.tsx:new content');
    });
  });

  it('refreshes T3-style asset previews with a revision after saving source changes', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'output/report.html', name: 'report.html', type: 'file' },
      ],
      truncated: false,
    });
    createCodeWorkspaceAssetUrlMock.mockResolvedValue({
      relativeUrl: '/api/coco/workspace-assets/token/report.html',
      expiresAt: '2026-06-30T12:15:00.000Z',
    });
    resolveCodeWorkspaceAssetUrlMock.mockReturnValue('/api/coco/workspace-assets/token/report.html');
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'output/report.html',
      content: '<!doctype html><main>Report</main>',
      byteSize: 35,
      truncated: false,
      encoding: 'utf-8',
    });
    writeCodeWorkspaceFileMock.mockResolvedValue({ path: 'output/report.html', name: 'report.html', type: 'file' });

    const { container } = render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    expect(await screen.findByText('1 files')).toBeTruthy();
    selectionHandlerRef.current?.(['output/report.html']);
    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('/api/coco/workspace-assets/token/report.html');
    });

    fireEvent.click(screen.getByLabelText('codeAgentShowSource'));
    const diffFile = await screen.findByTestId('diff-file');

    fireEvent.click(diffFile);
    fireEvent.click(screen.getByLabelText('codeAgentShowPreview'));

    await waitFor(() => {
      expect(writeCodeWorkspaceFileMock).toHaveBeenCalledWith(
        'room-1',
        'output/report.html',
        'export const changed = true;',
        'utf-8',
      );
    });

    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('/api/coco/workspace-assets/token/report.html?revision=1');
    });
  });

  it('uses generic source and preview labels for non-markdown asset previews', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'output/report.html', name: 'report.html', type: 'file' },
      ],
      truncated: false,
    });
    createCodeWorkspaceAssetUrlMock.mockResolvedValue({
      relativeUrl: '/api/coco/workspace-assets/token/report.html',
      expiresAt: '2026-06-30T12:15:00.000Z',
    });
    resolveCodeWorkspaceAssetUrlMock.mockReturnValue('/api/coco/workspace-assets/token/report.html');
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'output/report.html',
      content: '<!doctype html><main>Report</main>',
      byteSize: 35,
      truncated: false,
      encoding: 'utf-8',
    });

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    expect(await screen.findByText('1 files')).toBeTruthy();
    selectionHandlerRef.current?.(['output/report.html']);

    await waitFor(() => {
      expect(createCodeWorkspaceAssetUrlMock).toHaveBeenCalledWith('room-1', 'output/report.html', expect.any(Object));
    });
    expect(screen.getByLabelText('codeAgentShowSource')).toBeTruthy();
    expect(screen.queryByLabelText('codeAgentShowMarkdownSource')).toBeNull();

    fireEvent.click(screen.getByLabelText('codeAgentShowSource'));

    expect(await screen.findByTestId('diff-file')).toBeTruthy();
    expect(screen.getByLabelText('codeAgentShowPreview')).toBeTruthy();
    expect(screen.queryByLabelText('codeAgentShowRenderedMarkdown')).toBeNull();
  });

  it('opens T3-style browser preview files with a fresh signed asset URL', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'output/report.html', name: 'report.html', type: 'file' },
      ],
      truncated: false,
    });
    createCodeWorkspaceAssetUrlMock.mockResolvedValue({
      relativeUrl: '/api/coco/workspace-assets/token/report.html',
      expiresAt: '2026-06-30T12:15:00.000Z',
    });
    resolveCodeWorkspaceAssetUrlMock.mockReturnValue('/api/coco/workspace-assets/token/report.html');
    const open = vi.spyOn(window, 'open');

    const { container } = render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    expect(await screen.findByText('1 files')).toBeTruthy();
    selectionHandlerRef.current?.(['output/report.html']);
    await waitFor(() => {
      expect(createCodeWorkspaceAssetUrlMock).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByLabelText('codeAgentOpenFileInPreview'));

    expect(open).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(createCodeWorkspaceAssetUrlMock).toHaveBeenCalledTimes(2);
    });
    expect(createCodeWorkspaceAssetUrlMock).toHaveBeenLastCalledWith('room-1', 'output/report.html', expect.any(Object));
    expect(screen.queryByLabelText('codeAgentShowSource')).toBeNull();
    expect(screen.getByTestId('code-agent-file-surface-tabs').textContent).toContain('report.html');
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe('/api/coco/workspace-assets/token/report.html');
  });

  it('opens a requested workspace file from an external diff action', async () => {
    fileTreeSelectedPathsRef.current = ['README.md'];
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'README.md', name: 'README.md', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'src/App.tsx',
      content: 'export default function App() {}',
      byteSize: 32,
      truncated: false,
      encoding: 'utf-8',
    });

    render(
      <CodeAgentFileBrowserPanel
        roomId="room-1"
        projectName="Coco"
        openFileRequest={{ path: '/workspace/src/App.tsx', requestId: 1 }}
      />,
    );

    expect((await screen.findByTestId('diff-file')).textContent).toBe('src/App.tsx:export default function App() {}');
    expect(loadCodeWorkspaceFileMock).toHaveBeenCalledWith('room-1', 'src/App.tsx', expect.any(Object));
    await waitFor(() => {
      expect(resetPathsMock).toHaveBeenLastCalledWith(['src/', 'README.md', 'src/App.tsx']);
    });
    expect(deselectTreeItemMock).toHaveBeenCalledWith('README.md');
    expect(selectTreeItemMock).toHaveBeenCalledWith('src/App.tsx');
    expect(fileTreeSelectedPathsRef.current).toEqual(['src/App.tsx']);
    expect(focusPathMock).toHaveBeenCalledWith('src/App.tsx');
    expect(scrollToPathMock).toHaveBeenCalledWith('src/App.tsx', { offset: 'nearest' });
  });

  it('keeps the T3 indexing label until the base workspace entries load', async () => {
    loadCodeWorkspaceEntriesMock.mockReturnValue(new Promise(() => {}));
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'src/App.tsx',
      content: 'export default function App() {}',
      byteSize: 32,
      truncated: false,
      encoding: 'utf-8',
    });

    render(
      <CodeAgentFileBrowserPanel
        roomId="room-1"
        projectName="Coco"
        openFileRequest={{ path: '/workspace/src/App.tsx', requestId: 1 }}
      />,
    );

    expect(await screen.findByText('Indexing...')).toBeTruthy();
    expect(screen.queryByText('1 files')).toBeNull();
    await waitFor(() => {
      expect(resetPathsMock).toHaveBeenLastCalledWith(['src/', 'src/App.tsx']);
    });
  });

  it('reopens cached files immediately and keeps them visible when a refresh fails', async () => {
    let appReadCount = 0;
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
        { path: 'src/Other.ts', name: 'Other.ts', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockImplementation((_roomId: string, path: string) => {
      if (path === 'src/App.tsx') {
        appReadCount += 1;
        return appReadCount === 1
          ? Promise.resolve({
            path: 'src/App.tsx',
            content: 'cached app',
            byteSize: 10,
            truncated: false,
            encoding: 'utf-8',
          })
          : Promise.reject(new Error('socket read failed'));
      }
      return new Promise(() => undefined);
    });

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('2 files');

    fileTreeSelectionPathRef.current = 'src/App.tsx';
    fireEvent.click(screen.getByLabelText('Coco files'));
    expect((await screen.findByTestId('diff-file')).textContent).toBe('src/App.tsx:cached app');

    fileTreeSelectionPathRef.current = 'src/Other.ts';
    fireEvent.click(screen.getByLabelText('Coco files'));
    await waitFor(() => {
      expect(screen.queryByText('src/App.tsx:cached app')).toBeNull();
    });

    fileTreeSelectionPathRef.current = 'src/App.tsx';
    fireEvent.click(screen.getByLabelText('Coco files'));

    expect((await screen.findByTestId('diff-file')).textContent).toBe('src/App.tsx:cached app');
    expect(await screen.findByText('socket read failed')).toBeTruthy();
    expect(loadCodeWorkspaceFileMock).toHaveBeenCalledWith('room-1', 'src/App.tsx', expect.any(Object));
    expect(loadCodeWorkspaceFileMock).toHaveBeenCalledWith('room-1', 'src/Other.ts', expect.any(Object));
  });

  it('keeps background save failures scoped to the edited file after switching previews', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
        { path: 'src/Other.ts', name: 'Other.ts', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockImplementation((_roomId: string, path: string) => Promise.resolve({
      path,
      content: path === 'src/App.tsx' ? 'app content' : 'other content',
      byteSize: 20,
      truncated: false,
      encoding: 'utf-8',
    }));
    writeCodeWorkspaceFileMock.mockRejectedValue(new Error('save failed for app'));

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('2 files');

    fileTreeSelectionPathRef.current = 'src/App.tsx';
    fireEvent.click(screen.getByLabelText('Coco files'));
    const appFile = await screen.findByTestId('diff-file');
    expect(appFile.textContent).toBe('src/App.tsx:app content');
    fireEvent.click(appFile);

    fileTreeSelectionPathRef.current = 'src/Other.ts';
    fireEvent.click(screen.getByLabelText('Coco files'));

    expect((await screen.findByTestId('diff-file')).textContent).toBe('src/Other.ts:other content');
    await waitFor(() => {
      expect(writeCodeWorkspaceFileMock).toHaveBeenCalledWith(
        'room-1',
        'src/App.tsx',
        'export const changed = true;',
        'utf-8',
      );
    });
    expect(screen.queryByText('save failed for app')).toBeNull();
  });

  it('keeps the T3-style current file breadcrumb scrolled into view', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const deepPath = 'src/components/deep/Button.tsx';
    fileTreeSelectionPathRef.current = deepPath;
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: deepPath, name: 'Button.tsx', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: deepPath,
      content: 'export function Button() {}',
      byteSize: 27,
      truncated: false,
      encoding: 'utf-8',
    });

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('1 files');
    fireEvent.click(screen.getByLabelText('Coco files'));

    expect((await screen.findByTestId('diff-file')).textContent).toBe(`${deepPath}:export function Button() {}`);
    const breadcrumbs = screen.getByTestId('code-agent-file-breadcrumbs');
    expect(breadcrumbs.getAttribute('data-file-breadcrumbs')).toBe('true');
    const currentCrumb = within(breadcrumbs).getByText('Button.tsx').closest('[data-current-file-crumb]');
    expect(currentCrumb?.getAttribute('data-current-file-crumb')).toBe('true');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'end' });
  });

  it('merges remote workspace search matches into the T3 tree', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'README.md', name: 'README.md', type: 'file' },
      ],
      truncated: true,
    });
    searchCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/components/Composer.tsx', name: 'Composer.tsx', type: 'file' },
      ],
      truncated: false,
    });
    fileTreeSearchStateRef.current = { isOpen: true, value: 'cmp' };

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    expect(await screen.findByText(/^2 files · partial/)).toBeTruthy();
    await waitFor(() => {
      expect(searchCodeWorkspaceEntriesMock).toHaveBeenCalledWith('room-1', 'cmp', {
        limit: 200,
        signal: expect.any(AbortSignal),
      });
    });
    await waitFor(() => {
      expect(resetPathsMock).toHaveBeenLastCalledWith([
        'src/',
        'src/components/',
        'README.md',
        'src/components/Composer.tsx',
      ]);
    });
  });

  it('reloads workspace files when the room sandbox becomes ready', async () => {
    loadCodeWorkspaceEntriesMock
      .mockRejectedValueOnce(new Error('Workspace sandbox is not ready'))
      .mockResolvedValueOnce({
        entries: [
          { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
        ],
        truncated: false,
      });

    const { rerender } = render(
      <CodeAgentFileBrowserPanel
        roomId="room-1"
        projectName="Coco"
        sandboxStatus="none"
      />,
    );

    expect(await screen.findByText('Workspace sandbox is not ready')).toBeTruthy();

    rerender(
      <CodeAgentFileBrowserPanel
        roomId="room-1"
        projectName="Coco"
        sandboxStatus="ready"
        sandboxUpdatedAt="2026-06-30T10:00:00.000Z"
      />,
    );

    expect(await screen.findByText('1 files')).toBeTruthy();
    expect(loadCodeWorkspaceEntriesMock).toHaveBeenCalledTimes(2);
  });

  it('debounces edits through the workspace write API', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'src/App.tsx',
      content: 'export default function App() {}',
      byteSize: 32,
      truncated: false,
      encoding: 'utf-8',
    });
    writeCodeWorkspaceFileMock.mockResolvedValue({ path: 'src/App.tsx', name: 'App.tsx', type: 'file' });

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('1 files');
    fireEvent.click(screen.getByLabelText('Coco files'));
    const diffFile = await screen.findByTestId('diff-file');

    vi.useFakeTimers();
    fireEvent.click(diffFile);
    expect(writeCodeWorkspaceFileMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);

    expect(writeCodeWorkspaceFileMock).toHaveBeenCalledWith(
      'room-1',
      'src/App.tsx',
      'export const changed = true;',
      'utf-8',
    );
  });

  it('shows T3-style pending file tab markers while saving edits', async () => {
    const pendingWrite = deferred<{ path: string; name: string; type: 'file' }>();
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'src/App.tsx',
      content: 'export default function App() {}',
      byteSize: 32,
      truncated: false,
      encoding: 'utf-8',
    });
    writeCodeWorkspaceFileMock.mockReturnValue(pendingWrite.promise);

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('1 files');
    fireEvent.click(screen.getByLabelText('Coco files'));
    await screen.findByTestId('diff-file');

    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('diff-file'));
    expect(screen.getByTestId('code-agent-file-tab-pending-indicator')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(500);
    expect(screen.getByTestId('code-agent-file-tab-pending-indicator')).toBeTruthy();

    await act(async () => {
      pendingWrite.resolve({ path: 'src/App.tsx', name: 'App.tsx', type: 'file' });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByTestId('code-agent-file-tab-pending-indicator')).toBeNull();
  });

  it('installs T3-style editor dismissal for outside pointer interactions', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'src/App.tsx',
      content: 'export default function App() {}',
      byteSize: 32,
      truncated: false,
      encoding: 'utf-8',
    });

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('1 files');
    fireEvent.click(screen.getByLabelText('Coco files'));
    expect((await screen.findByTestId('diff-file')).textContent).toBe('src/App.tsx:export default function App() {}');

    fireEvent.pointerDown(document.body);

    expect(editorSetSelectionsMock).toHaveBeenCalledWith([]);
  });

  it('supports T3-style local file comments from selected file lines', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'src/App.tsx',
      content: 'line 1\nline 2\nline 3\nline 4',
      byteSize: 27,
      truncated: false,
      encoding: 'utf-8',
    });

    const onAddReviewComment = vi.fn();
    render(
      <CodeAgentFileBrowserPanel
        roomId="room-1"
        projectName="Coco"
        onAddReviewComment={onAddReviewComment}
      />,
    );
    await screen.findByText('1 files');
    fireEvent.click(screen.getByLabelText('Coco files'));
    expect((await screen.findByTestId('diff-file')).textContent).toBe('src/App.tsx:line 1\nline 2\nline 3\nline 4');

    fireEvent.click(screen.getByLabelText('select-lines'));

    const input = await screen.findByLabelText('codeAgentCommentOnLines:L2 to L4');
    fireEvent.change(input, { target: { value: 'Please adjust this range.' } });
    fireEvent.click(screen.getByRole('button', { name: 'codeAgentSubmitComment' }));

    expect(screen.getByText('codeAgentLocalComment')).toBeTruthy();
    expect(screen.getByText('L2 to L4')).toBeTruthy();
    expect(screen.getByText('Please adjust this range.')).toBeTruthy();
    expect(onAddReviewComment).toHaveBeenCalledWith(expect.objectContaining({
      filePath: 'src/App.tsx',
      rangeLabel: 'L2 to L4',
      text: 'Please adjust this range.',
      diff: 'line 2\nline 3\nline 4',
      fenceLanguage: 'tsx',
    }));
  });

  it('updates T3-style file review comments after Pierre remaps annotation lines', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'src/App.tsx',
      content: 'line 1\nline 2\nline 3\nline 4',
      byteSize: 27,
      truncated: false,
      encoding: 'utf-8',
    });

    const onAddReviewComment = vi.fn();
    render(
      <CodeAgentFileBrowserPanel
        roomId="room-1"
        projectName="Coco"
        onAddReviewComment={onAddReviewComment}
      />,
    );
    await screen.findByText('1 files');
    fireEvent.click(screen.getByLabelText('Coco files'));
    await screen.findByTestId('diff-file');

    fireEvent.click(screen.getByLabelText('select-lines'));
    const input = await screen.findByLabelText('codeAgentCommentOnLines:L2 to L4');
    fireEvent.change(input, { target: { value: 'Please adjust this range.' } });
    fireEvent.click(screen.getByRole('button', { name: 'codeAgentSubmitComment' }));

    const commentId = onAddReviewComment.mock.calls[0]?.[0]?.id;
    expect(commentId).toBeTruthy();
    onAddReviewComment.mockClear();

    act(() => {
      editorOptionsRef.current?.onChange?.(
        {
          name: 'src/App.tsx',
          contents: 'line 0\nline 1\nline 2\nline 3\nline 4\nline 5',
        },
        [{
          lineNumber: 5,
          metadata: {
            entries: [{
              id: commentId,
              kind: 'comment',
              startLine: 2,
              endLine: 4,
              text: 'Please adjust this range.',
            }],
          },
        }],
      );
    });

    expect(onAddReviewComment).toHaveBeenCalledWith(expect.objectContaining({
      id: commentId,
      filePath: 'src/App.tsx',
      rangeLabel: 'L3 to L5',
      startIndex: 2,
      endIndex: 4,
      text: 'Please adjust this range.',
      diff: 'line 2\nline 3\nline 4',
      fenceLanguage: 'tsx',
    }));
  });

  it('keeps selected file lines synced after T3-style virtualized file renders', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'src/App.tsx',
      content: 'line 1\nline 2\nline 3\nline 4',
      byteSize: 27,
      truncated: false,
      encoding: 'utf-8',
    });

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('1 files');
    fireEvent.click(screen.getByLabelText('Coco files'));
    await screen.findByTestId('diff-file');

    fireEvent.click(screen.getByLabelText('select-lines'));

    await waitFor(() => {
      expect(fileInstanceSetSelectedLinesMock).toHaveBeenCalledWith(
        { start: 2, end: 4 },
        { notify: false },
      );
    });
  });

  it('keeps the latest T3-style optimistic edit when an older save confirms late', async () => {
    const firstWrite = deferred<{ path: string; name: string; type: 'file' }>();
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'src/App.tsx',
      content: 'export default function App() {}',
      byteSize: 32,
      truncated: false,
      encoding: 'utf-8',
    });
    writeCodeWorkspaceFileMock
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce({ path: 'src/App.tsx', name: 'App.tsx', type: 'file' });

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('1 files');
    fireEvent.click(screen.getByLabelText('Coco files'));
    await screen.findByTestId('diff-file');

    vi.useFakeTimers();
    nextEditorContentsRef.current = 'export const first = true;';
    fireEvent.click(screen.getByTestId('diff-file'));
    expect(screen.getByTestId('diff-file').textContent).toBe('src/App.tsx:export const first = true;');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(writeCodeWorkspaceFileMock).toHaveBeenCalledWith(
      'room-1',
      'src/App.tsx',
      'export const first = true;',
      'utf-8',
    );

    nextEditorContentsRef.current = 'export const latest = true;';
    fireEvent.click(screen.getByTestId('diff-file'));
    expect(screen.getByTestId('diff-file').textContent).toBe('src/App.tsx:export const latest = true;');

    await act(async () => {
      firstWrite.resolve({ path: 'src/App.tsx', name: 'App.tsx', type: 'file' });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('diff-file').textContent).toBe('src/App.tsx:export const latest = true;');

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(writeCodeWorkspaceFileMock).toHaveBeenCalledWith(
      'room-1',
      'src/App.tsx',
      'export const latest = true;',
      'utf-8',
    );
  });

  it('keeps T3-style optimistic file contents when a pending edit surface is reopened', async () => {
    const pendingWrite = deferred<{ path: string; name: string; type: 'file' }>();
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'src/App.tsx',
      content: 'export default function App() {}',
      byteSize: 32,
      truncated: false,
      encoding: 'utf-8',
    });
    writeCodeWorkspaceFileMock.mockReturnValue(pendingWrite.promise);

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('1 files');
    fireEvent.click(screen.getByLabelText('Coco files'));
    expect((await screen.findByTestId('diff-file')).textContent).toBe('src/App.tsx:export default function App() {}');

    vi.useFakeTimers();
    nextEditorContentsRef.current = 'export const pending = true;';
    fireEvent.click(screen.getByTestId('diff-file'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(writeCodeWorkspaceFileMock).toHaveBeenCalledWith(
      'room-1',
      'src/App.tsx',
      'export const pending = true;',
      'utf-8',
    );
    expect(screen.getByTestId('code-agent-file-tab-pending-indicator')).toBeTruthy();
    vi.useRealTimers();

    fireEvent.click(screen.getByLabelText('close src/App.tsx'));
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-empty')).getByText('codeAgentWorkspaceFiles'));
    fireEvent.click(await screen.findByLabelText('Coco files'));

    await waitFor(() => {
      expect(screen.getByTestId('diff-file').textContent).toBe('src/App.tsx:export const pending = true;');
    });

    await act(async () => {
      pendingWrite.resolve({ path: 'src/App.tsx', name: 'App.tsx', type: 'file' });
      await Promise.resolve();
    });
  });

  it('keeps confirmed optimistic file contents when the refreshed workspace read is still stale', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'src/App.tsx',
      content: 'export default function App() {}',
      byteSize: 32,
      truncated: false,
      encoding: 'utf-8',
    });
    writeCodeWorkspaceFileMock.mockResolvedValue({ path: 'src/App.tsx', name: 'App.tsx', type: 'file' });

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('1 files');
    fireEvent.click(screen.getByLabelText('Coco files'));
    expect((await screen.findByTestId('diff-file')).textContent).toBe('src/App.tsx:export default function App() {}');

    vi.useFakeTimers();
    nextEditorContentsRef.current = 'export const saved = true;';
    fireEvent.click(screen.getByTestId('diff-file'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    await act(async () => {
      await Promise.resolve();
    });
    vi.useRealTimers();

    expect(writeCodeWorkspaceFileMock).toHaveBeenCalledWith(
      'room-1',
      'src/App.tsx',
      'export const saved = true;',
      'utf-8',
    );
    expect(screen.getByTestId('diff-file').textContent).toBe('src/App.tsx:export const saved = true;');

    await waitFor(() => {
      expect(loadCodeWorkspaceFileMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getByTestId('diff-file').textContent).toBe('src/App.tsx:export const saved = true;');
    expect(getOptimisticCodeAgentProjectFileQueryData('room-1', 'src/App.tsx')?.content).toBe(
      'export const saved = true;',
    );
  });

  it('clears confirmed optimistic file contents once the refreshed workspace read matches', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock
      .mockResolvedValueOnce({
        path: 'src/App.tsx',
        content: 'export default function App() {}',
        byteSize: 32,
        truncated: false,
        encoding: 'utf-8',
      })
      .mockResolvedValueOnce({
        path: 'src/App.tsx',
        content: 'export const saved = true;',
        byteSize: 26,
        truncated: false,
        encoding: 'utf-8',
      })
      .mockResolvedValue({
        path: 'src/App.tsx',
        content: 'export const saved = true;',
        byteSize: 26,
        truncated: false,
        encoding: 'utf-8',
      });
    writeCodeWorkspaceFileMock.mockResolvedValue({ path: 'src/App.tsx', name: 'App.tsx', type: 'file' });

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('1 files');
    fireEvent.click(screen.getByLabelText('Coco files'));
    expect((await screen.findByTestId('diff-file')).textContent).toBe('src/App.tsx:export default function App() {}');

    vi.useFakeTimers();
    nextEditorContentsRef.current = 'export const saved = true;';
    fireEvent.click(screen.getByTestId('diff-file'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    await act(async () => {
      await Promise.resolve();
    });
    vi.useRealTimers();

    await waitFor(() => {
      expect(loadCodeWorkspaceFileMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getByTestId('diff-file').textContent).toBe('src/App.tsx:export const saved = true;');
    expect(getOptimisticCodeAgentProjectFileQueryData('room-1', 'src/App.tsx')).toBeNull();
  });

  it('does not let a late save confirmation overwrite another open file preview', async () => {
    const appWrite = deferred<{ path: string; name: string; type: 'file' }>();
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
        { path: 'src/Other.ts', name: 'Other.ts', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockImplementation((_roomId: string, path: string) => Promise.resolve({
      path,
      content: path === 'src/App.tsx' ? 'app content' : 'other content',
      byteSize: 20,
      truncated: false,
      encoding: 'utf-8',
    }));
    writeCodeWorkspaceFileMock.mockReturnValueOnce(appWrite.promise);

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('2 files');

    fileTreeSelectionPathRef.current = 'src/App.tsx';
    fireEvent.click(screen.getByLabelText('Coco files'));
    expect((await screen.findByTestId('diff-file')).textContent).toBe('src/App.tsx:app content');
    vi.useFakeTimers();
    nextEditorContentsRef.current = 'export const app = true;';
    fireEvent.click(screen.getByTestId('diff-file'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    vi.useRealTimers();

    fileTreeSelectionPathRef.current = 'src/Other.ts';
    fireEvent.click(screen.getByLabelText('Coco files'));
    expect((await screen.findByTestId('diff-file')).textContent).toBe('src/Other.ts:other content');

    await act(async () => {
      appWrite.resolve({ path: 'src/App.tsx', name: 'App.tsx', type: 'file' });
      await Promise.resolve();
    });

    expect(screen.getByTestId('diff-file').textContent).toBe('src/Other.ts:other content');
  });

  it('saves rendered markdown task checkbox changes through the workspace write API', async () => {
    fileTreeSelectionPathRef.current = 'README.md';
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'README.md', name: 'README.md', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'README.md',
      content: '- [ ] First\n- [x] Second\n',
      byteSize: 25,
      truncated: false,
      encoding: 'utf-8',
    });
    writeCodeWorkspaceFileMock.mockResolvedValue({ path: 'README.md', name: 'README.md', type: 'file' });

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('1 files');
    fireEvent.click(screen.getByLabelText('Coco files'));
    expect((await screen.findByTestId('diff-file')).textContent).toBe('README.md:- [ ] First\n- [x] Second\n');
    expect(screen.queryByRole('checkbox')).toBeNull();

    fireEvent.click(screen.getByLabelText('codeAgentShowRenderedMarkdown'));
    const checkboxes = await screen.findAllByRole('checkbox') as HTMLInputElement[];

    vi.useFakeTimers();
    expect(checkboxes[0].checked).toBe(false);
    fireEvent.click(checkboxes[0]);
    expect(writeCodeWorkspaceFileMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);

    expect(writeCodeWorkspaceFileMock).toHaveBeenCalledWith(
      'room-1',
      'README.md',
      '- [x] First\n- [x] Second\n',
      'utf-8',
    );
  });

  it('opens workspace links from rendered markdown in the file viewer', async () => {
    fileTreeSelectionPathRef.current = 'README.md';
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'README.md', name: 'README.md', type: 'file' },
        { path: 'docs/Guide.md', name: 'Guide.md', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockImplementation((_roomId: string, path: string) => Promise.resolve({
      path,
      content: path === 'README.md'
        ? '[Guide](docs/Guide.md#L2)'
        : 'line 1\nline 2\nline 3',
      byteSize: 24,
      truncated: false,
      encoding: 'utf-8',
    }));

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('2 files');
    fireEvent.click(screen.getByLabelText('Coco files'));
    expect((await screen.findByTestId('diff-file')).textContent).toBe('README.md:[Guide](docs/Guide.md#L2)');

    fireEvent.click(screen.getByLabelText('codeAgentShowRenderedMarkdown'));
    fireEvent.click(await screen.findByLabelText('open-guide-link'));

    await waitFor(() => {
      expect(loadCodeWorkspaceFileMock).toHaveBeenCalledWith('room-1', 'docs/Guide.md', expect.any(Object));
    });
    expect((await screen.findByTestId('diff-file')).textContent).toBe('docs/Guide.md:line 1\nline 2\nline 3');
  });

  it('opens browser-preview links from rendered markdown with a fresh signed asset URL', async () => {
    fileTreeSelectionPathRef.current = 'README.md';
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'README.md', name: 'README.md', type: 'file' },
        { path: 'output/report.html', name: 'report.html', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'README.md',
      content: '[Report](output/report.html)',
      byteSize: 28,
      truncated: false,
      encoding: 'utf-8',
    });
    createCodeWorkspaceAssetUrlMock.mockResolvedValue({
      relativeUrl: '/api/coco/workspace-assets/token/report.html',
      expiresAt: '2026-06-30T12:15:00.000Z',
    });
    resolveCodeWorkspaceAssetUrlMock.mockReturnValue('/api/coco/workspace-assets/token/report.html');
    const open = vi.spyOn(window, 'open');

    const { container } = render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('2 files');
    fireEvent.click(screen.getByLabelText('Coco files'));
    expect((await screen.findByTestId('diff-file')).textContent).toBe('README.md:[Report](output/report.html)');

    fireEvent.click(screen.getByLabelText('codeAgentShowRenderedMarkdown'));
    fireEvent.click(await screen.findByLabelText('open-report-preview-link'));

    expect(open).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(createCodeWorkspaceAssetUrlMock).toHaveBeenCalledWith('room-1', 'output/report.html', expect.any(Object));
    });
    expect(screen.getByTestId('code-agent-file-surface-tabs').textContent).toContain('report.html');
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe('/api/coco/workspace-assets/token/report.html');
    expect(loadCodeWorkspaceFileMock).toHaveBeenCalledTimes(1);
    expect(loadCodeWorkspaceFileMock).not.toHaveBeenCalledWith('room-1', 'output/report.html', expect.any(Object));
  });

  it('renders truncated text files as read-only previews', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'logs/big.log', name: 'big.log', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'logs/big.log',
      content: 'partial log',
      byteSize: 2_000_000,
      truncated: true,
      encoding: 'utf-8',
    });

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('1 files');
    selectionHandlerRef.current?.(['logs/big.log']);

    const diffFile = await screen.findByTestId('diff-file');
    expect(diffFile.textContent).toBe('logs/big.log:partial log');
    expect(diffFile.dataset.cacheKey).toMatch(/^room-1:logs\/big\.log:/);
    const truncatedBanner = screen.getByTestId('code-agent-file-preview-truncated');
    expect(truncatedBanner.textContent).toBe('codeAgentFilePreviewTruncated:11:2,000,000');
    expect(truncatedBanner.nextElementSibling).toBe(screen.getByTestId('code-agent-file-preview-body'));
    expect(diffFileOptionsRef.current?.theme).toBe('pierre-light');
    expect(diffFileOptionsRef.current?.themeType).toBe('light');
    expect(diffFileOptionsRef.current?.unsafeCSS).toContain('light-dark(');
    expect(diffFileOptionsRef.current?.unsafeCSS).toContain('in lab');

    vi.useFakeTimers();
    fireEvent.click(diffFile);
    await vi.advanceTimersByTimeAsync(500);

    expect(writeCodeWorkspaceFileMock).not.toHaveBeenCalled();
  });

  it('wires file manager create, rename, and delete actions to workspace mutations', async () => {
    let workspaceEntries = [
      { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
    ];
    loadCodeWorkspaceEntriesMock.mockImplementation(() => Promise.resolve({
      entries: workspaceEntries,
      truncated: false,
    }));
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: 'src/App.tsx',
      content: 'export default function App() {}',
      byteSize: 32,
      truncated: false,
      encoding: 'utf-8',
    });
    writeCodeWorkspaceFileMock.mockImplementation((_roomId: string, path: string) => {
      const entry = { path, name: path.split('/').pop() || path, type: 'file' };
      workspaceEntries = [...workspaceEntries.filter((candidate) => candidate.path !== path), entry];
      return Promise.resolve(entry);
    });
    createCodeWorkspaceDirectoryMock.mockImplementation((_roomId: string, path: string) => {
      const entry = { path, name: path.split('/').pop() || path, type: 'directory' };
      workspaceEntries = [...workspaceEntries.filter((candidate) => candidate.path !== path), entry];
      return Promise.resolve(entry);
    });
    renameCodeWorkspaceEntryMock.mockImplementation((_roomId: string, fromPath: string, toPath: string) => {
      const renamedEntry = { path: toPath, name: toPath.split('/').pop() || toPath, type: 'file' };
      workspaceEntries = workspaceEntries
        .filter((candidate) => candidate.path !== fromPath)
        .concat(renamedEntry);
      return Promise.resolve(renamedEntry);
    });
    deleteCodeWorkspaceEntryMock.mockImplementation((_roomId: string, path: string) => {
      workspaceEntries = workspaceEntries.filter((candidate) => candidate.path !== path);
      return Promise.resolve(undefined);
    });
    vi.spyOn(window, 'prompt')
      .mockReturnValueOnce('src/New.tsx')
      .mockReturnValueOnce('src/components')
      .mockReturnValueOnce('src/Main.tsx');
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('1 files');
    fireEvent.click(screen.getByLabelText('Coco files'));

    fireEvent.click(screen.getByLabelText('codeAgentNewFile'));
    fireEvent.click(screen.getByLabelText('codeAgentNewFolder'));
    await waitFor(() => {
      expect(writeCodeWorkspaceFileMock).toHaveBeenCalledWith('room-1', 'src/New.tsx', '', 'utf-8');
      expect(createCodeWorkspaceDirectoryMock).toHaveBeenCalledWith('room-1', 'src/components');
    });

    fireEvent.click(screen.getByLabelText('Coco files'));
    fireEvent.click(screen.getByLabelText('codeAgentRenameFile'));
    await waitFor(() => {
      expect(renameCodeWorkspaceEntryMock).toHaveBeenCalledWith('room-1', 'src/App.tsx', 'src/Main.tsx');
    });
    await waitFor(() => {
      expect((screen.getByLabelText('codeAgentDeleteFile') as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(screen.getByLabelText('codeAgentDeleteFile'));

    await waitFor(() => {
      expect(deleteCodeWorkspaceEntryMock).toHaveBeenCalledWith('room-1', 'src/Main.tsx');
    });
  });
});
