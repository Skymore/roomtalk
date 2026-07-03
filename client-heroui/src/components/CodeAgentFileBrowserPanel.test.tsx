// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeAgentFileBrowserPanel } from './CodeAgentFileBrowserPanel';
import {
  openCodeAgentRightPanel,
  openCodeAgentRightPanelFile,
  openCodeAgentRightPanelPreview,
  readCodeAgentRightPanelState,
  resetCodeAgentRightPanelStoreForTests,
} from '../utils/codeAgentRightPanelStore';
import {
  getOptimisticCodeAgentProjectFileQueryData,
  resetCodeAgentProjectFilesQueryStateForTests,
} from './codeAgentProjectFilesQueryState';
import { resetCodeAgentDiffPanelStoreForTests } from '../utils/codeAgentDiffPanelStore';
import {
  resetCodeAgentChangedFilesExpansionStoreForTests,
  setCodeAgentChangedFilesExpanded,
} from '../utils/codeAgentChangedFilesExpansionStore';

const loadCodeWorkspaceEntriesMock = vi.hoisted(() => vi.fn());
const searchCodeWorkspaceEntriesMock = vi.hoisted(() => vi.fn());
const loadCodeWorkspaceFileMock = vi.hoisted(() => vi.fn());
const createCodeWorkspaceAssetUrlMock = vi.hoisted(() => vi.fn());
const resolveCodeWorkspaceAssetUrlMock = vi.hoisted(() => vi.fn());
const writeCodeWorkspaceFileMock = vi.hoisted(() => vi.fn());
const createCodeWorkspaceDirectoryMock = vi.hoisted(() => vi.fn());
const renameCodeWorkspaceEntryMock = vi.hoisted(() => vi.fn());
const deleteCodeWorkspaceEntryMock = vi.hoisted(() => vi.fn());
const openPreviewSessionMock = vi.hoisted(() => vi.fn());
const navigatePreviewSessionMock = vi.hoisted(() => vi.fn());
const resizePreviewSessionMock = vi.hoisted(() => vi.fn());
const listPreviewSessionsMock = vi.hoisted(() => vi.fn());
const reportPreviewSessionMock = vi.hoisted(() => vi.fn());
const resolvePreviewTargetMock = vi.hoisted(() => vi.fn());
const refreshPreviewSessionMock = vi.hoisted(() => vi.fn());
const closePreviewSessionMock = vi.hoisted(() => vi.fn());
const subscribePreviewEventsMock = vi.hoisted(() => vi.fn());
const connectPreviewAutomationHostMock = vi.hoisted(() => vi.fn());
const runPreviewAutomationRequestMock = vi.hoisted(() => vi.fn());
const previewAutomationHandleRef = vi.hoisted(() => ({ current: null as null | ((request: any) => unknown) }));
const getRoomMediaHistoryMock = vi.hoisted(() => vi.fn());
const requestCodeWorkspacePreviewServersMock = vi.hoisted(() => vi.fn());
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
    i18n: { language: 'en' },
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

vi.mock('../utils/codeWorkspacePreviewSessions', () => {
  const session = (payload: {
    roomId: string;
    tabId: string;
    url?: string | null;
    title?: string;
    viewport?: unknown;
    navStatus?: unknown;
    renderedViewport?: { width: number; height: number };
  }) => ({
    roomId: payload.roomId,
    tabId: payload.tabId,
    navStatus: payload.navStatus ?? (
      payload.url
        ? { _tag: 'Loading', url: payload.url, title: payload.title ?? '' }
        : { _tag: 'Idle' }
    ),
    canGoBack: false,
    canGoForward: false,
    viewport: payload.viewport ?? { _tag: 'fill' },
    ...(payload.renderedViewport ? { renderedViewport: payload.renderedViewport } : {}),
    updatedAt: '2026-07-02T00:00:00.000Z',
  });

  return {
    codeWorkspacePreviewUrlFromStatus: (status: { _tag: string; url?: string }) => (
      status._tag === 'Idle' ? null : status.url ?? null
    ),
    navigateCodeWorkspacePreviewSession: navigatePreviewSessionMock.mockImplementation((payload) => Promise.resolve(session(payload))),
    openCodeWorkspacePreviewSession: openPreviewSessionMock.mockImplementation((payload) => Promise.resolve(session({
      ...payload,
      tabId: payload.tabId ?? 'browser:new',
    }))),
    refreshCodeWorkspacePreviewSession: refreshPreviewSessionMock.mockImplementation((payload) => Promise.resolve(session(payload))),
    closeCodeWorkspacePreviewSession: closePreviewSessionMock.mockImplementation(() => Promise.resolve([])),
    listCodeWorkspacePreviewSessions: listPreviewSessionsMock.mockImplementation(() => Promise.resolve([])),
    reportCodeWorkspacePreviewSession: reportPreviewSessionMock.mockImplementation((payload) => Promise.resolve(session(payload))),
    resolveCodeWorkspacePreviewTarget: resolvePreviewTargetMock.mockImplementation(({ target }) => Promise.resolve({
      requestedUrl: `http://localhost:${target.port}${target.path ?? '/'}`,
      resolvedUrl: `https://${target.port}-sandbox.e2b.dev${target.path ?? '/'}`,
      resolutionKind: 'e2b-port-host',
    })),
    resizeCodeWorkspacePreviewSession: resizePreviewSessionMock.mockImplementation((payload) => Promise.resolve(session(payload))),
    subscribeCodeWorkspacePreviewEvents: subscribePreviewEventsMock.mockImplementation(() => () => {}),
  };
});

vi.mock('../utils/codeWorkspacePreviewAutomation', () => ({
  CODE_WORKSPACE_PREVIEW_AUTOMATION_SESSION_OPERATIONS: [
    'status',
    'open',
    'navigate',
    'resize',
  ],
  CODE_WORKSPACE_PREVIEW_AUTOMATION_CLOUD_BROWSER_OPERATIONS: [
    'status',
    'open',
    'navigate',
    'resize',
    'snapshot',
    'click',
    'type',
    'press',
    'scroll',
    'evaluate',
    'waitFor',
    'previewAnnotation',
    'clearCookies',
    'clearCache',
    'recordingStart',
    'recordingStop',
  ],
  runCodeWorkspacePreviewAutomationRequest: runPreviewAutomationRequestMock.mockImplementation((request) => {
    if (!previewAutomationHandleRef.current) {
      return Promise.reject(new Error('Workspace preview automation is not ready.'));
    }
    return Promise.resolve(previewAutomationHandleRef.current({
      requestId: request.requestId ?? 'preview-request:test',
      roomId: request.roomId,
      tabId: request.tabId,
      operation: request.operation,
      input: request.input ?? {},
      timeoutMs: request.timeoutMs ?? 15000,
    }));
  }),
  connectCodeWorkspacePreviewAutomationHost: connectPreviewAutomationHostMock.mockImplementation((options) => {
    previewAutomationHandleRef.current = options.handle;
    return Promise.resolve({
      host: {
        roomId: 'room-1',
        clientId: 'client-1',
        connectionId: 'preview-automation:test',
        socketId: 'socket-1',
        ...(options.tabId ? { tabId: options.tabId } : {}),
        focused: true,
        supportedOperations: ['status', 'open', 'navigate', 'resize', 'snapshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'waitFor', 'previewAnnotation', 'clearCookies', 'clearCache', 'recordingStart', 'recordingStop'],
        connectedAt: '2026-05-03T00:00:00.000Z',
        updatedAt: '2026-05-03T00:00:00.000Z',
      },
      setFocused: vi.fn().mockResolvedValue({}),
      dispose: vi.fn(),
    });
  }),
}));

vi.mock('../utils/socket', () => ({
  getRoomMediaHistory: getRoomMediaHistoryMock,
  requestCodeWorkspacePreviewServers: requestCodeWorkspacePreviewServersMock,
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
    mobileLayout,
    onOpenChangedFiles,
  }: {
    enabled: boolean;
    onOpenFile?: (path: string) => void;
    onFileSummariesChange?: (summaries: readonly { id: string; path: string; additions: number; deletions: number }[]) => void;
    selectedFilePath?: string | null;
    selectedFileRevealRequestId?: number;
    mobileLayout?: boolean;
    onOpenChangedFiles?: () => void;
  }) => (
    <div
      data-testid="code-agent-workspace-diff-viewer"
      data-enabled={String(enabled)}
      data-selected-file={selectedFilePath || ''}
      data-selected-file-request-id={String(selectedFileRevealRequestId || '')}
      data-mobile-layout={String(mobileLayout === true)}
    >
      {mobileLayout && onOpenChangedFiles ? (
        <button
          type="button"
          data-testid="code-agent-mobile-diff-files-button"
          onClick={onOpenChangedFiles}
        >
          codeAgentChangedFiles
        </button>
      ) : null}
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
  beforeEach(() => {
    if (typeof HTMLElement.prototype.scrollIntoView !== 'function') {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        value: vi.fn(),
      });
    }
  });

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
    openPreviewSessionMock.mockClear();
    navigatePreviewSessionMock.mockClear();
    resizePreviewSessionMock.mockClear();
    listPreviewSessionsMock.mockReset();
    listPreviewSessionsMock.mockResolvedValue([]);
    reportPreviewSessionMock.mockClear();
    resolvePreviewTargetMock.mockClear();
    refreshPreviewSessionMock.mockClear();
    closePreviewSessionMock.mockClear();
    subscribePreviewEventsMock.mockClear();
    connectPreviewAutomationHostMock.mockClear();
    runPreviewAutomationRequestMock.mockClear();
    previewAutomationHandleRef.current = null;
    getRoomMediaHistoryMock.mockReset();
    getRoomMediaHistoryMock.mockResolvedValue({
      roomId: 'room-1',
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    requestCodeWorkspacePreviewServersMock.mockReset();
    requestCodeWorkspacePreviewServersMock.mockResolvedValue([]);
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
    resetCodeAgentChangedFilesExpansionStoreForTests();
    resetCodeAgentDiffPanelStoreForTests();
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

  it('exposes touch-friendly file tab actions on mobile surfaces', async () => {
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

    openCodeAgentRightPanelFile('room-1', 'src/App.tsx');
    openCodeAgentRightPanelFile('room-1', 'docs/Guide.md');
    openCodeAgentRightPanelFile('room-1', 'docs/Notes.md');

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" surface="mobile" />);
    await waitFor(() => {
      expect(screen.getByTestId('diff-file').textContent).toBe('docs/Notes.md:contents:docs/Notes.md');
    });

    const tabList = screen.getByTestId('code-agent-file-surface-tabs');
    const appCloseButton = screen.getByLabelText('close src/App.tsx');
    expect(appCloseButton.className).toContain('opacity-100');
    expect(appCloseButton.className).toContain('h-6');
    expect(appCloseButton.className).toContain('w-6');
    expect(appCloseButton.className).not.toContain('opacity-0');

    const guideTab = within(tabList).getByText('Guide.md').closest('[role="tab"]') as HTMLElement;
    const guideActions = within(guideTab).getByTestId('code-agent-mobile-file-tab-actions');
    expect(guideActions.className).toContain('h-6');
    fireEvent.click(guideActions);

    const firstMenu = screen.getByTestId('code-agent-file-surface-menu');
    expect(tabList.contains(firstMenu)).toBe(false);
    fireEvent.click(screen.getByText('codeAgentCopyFilePath'));
    expect(writeTextMock).toHaveBeenCalledWith('docs/Guide.md');

    fireEvent.click(guideActions);
    fireEvent.click(screen.getByText('codeAgentCloseFileTabsToRight'));
    await waitFor(() => {
      expect(screen.getByTestId('code-agent-file-surface-tabs').textContent).toContain('App.tsx');
      expect(screen.getByTestId('code-agent-file-surface-tabs').textContent).toContain('Guide.md');
      expect(screen.getByTestId('code-agent-file-surface-tabs').textContent).not.toContain('Notes.md');
      expect(screen.getByTestId('diff-file').textContent).toBe('docs/Guide.md:contents:docs/Guide.md');
    });
  });

  it('uses a focused single-column file preview layout on mobile surfaces', async () => {
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
    openCodeAgentRightPanelFile('room-1', 'src/App.tsx');

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" surface="mobile" />);
    await waitFor(() => {
      expect(screen.getByTestId('diff-file').textContent).toBe('src/App.tsx:contents:src/App.tsx');
    });

    const previewBody = screen.getByTestId('code-agent-file-preview-body');
    const previewContent = screen.getByTestId('code-agent-file-preview-content');
    const previewHeader = screen.getByTestId('code-agent-mobile-file-preview-header');
    expect(previewHeader.dataset.mobileFilePreviewHeader).toBe('true');
    const mobileBreadcrumbRow = screen.getByTestId('code-agent-mobile-file-preview-breadcrumb-row');
    expect(within(mobileBreadcrumbRow).queryByText('Coco')).toBeNull();
    expect(within(mobileBreadcrumbRow).getByText('src')).toBeTruthy();
    expect(within(mobileBreadcrumbRow).getByText('App.tsx')).toBeTruthy();
    const mobilePreviewActionRow = screen.getByTestId('code-agent-mobile-file-preview-action-row');
    expect(previewHeader.contains(mobileBreadcrumbRow)).toBe(true);
    expect(previewHeader.contains(mobilePreviewActionRow)).toBe(true);
    expect(previewHeader.className).toContain('overflow-x-auto');
    const mobileCopyPathButton = within(previewHeader).getByTestId('code-agent-file-copy-path-button');
    expect(mobileCopyPathButton.className).toContain('h-8');
    expect(mobileCopyPathButton.className).toContain('w-8');
    expect(mobileCopyPathButton.className).not.toContain('p-1.5');
    expect(previewBody.dataset.mobileLayout).toBe('true');
    expect(previewBody.dataset.mobileView).toBe('preview');
    expect(previewContent.classList.contains('flex')).toBe(true);
    expect(previewContent.classList.contains('hidden')).toBe(false);
    expect(screen.queryByLabelText('Coco files')).toBeNull();
    expect(screen.queryByLabelText('codeAgentResizeFileExplorer')).toBeNull();

    fireEvent.click(screen.getByLabelText('codeAgentShowFileExplorer'));
    await waitFor(() => {
      expect(previewBody.dataset.mobileView).toBe('explorer');
      expect(previewContent.classList.contains('hidden')).toBe(true);
    });
    expect(screen.queryByTestId('code-agent-mobile-file-preview-header')).toBeNull();
    expect(screen.queryByTestId('code-agent-file-preview-truncated')).toBeNull();
    let mobileExplorer = screen.getByTestId('code-agent-mobile-file-tree-header').closest('aside') as HTMLElement;
    expect(mobileExplorer.dataset.mobileFileExplorer).toBe('true');
    expect(mobileExplorer.style.width).toBe('');
    expect(mobileExplorer.style.maxWidth).toBe('');
    expect(screen.queryByLabelText('codeAgentResizeFileExplorer')).toBeNull();
    let mobileFileTreeHeader = screen.getByTestId('code-agent-mobile-file-tree-header');
    let mobileFileTreeActions = screen.getByTestId('code-agent-mobile-file-tree-actions');
    expect(mobileFileTreeHeader.className).toContain('min-h-10');
    expect(mobileFileTreeHeader.className).toContain('overflow-x-auto');
    expect(mobileFileTreeHeader.contains(mobileFileTreeActions)).toBe(true);
    expect(within(mobileFileTreeHeader).queryByText('Coco')).toBeNull();
    expect(within(mobileFileTreeHeader).getByText('2 files')).toBeTruthy();
    const mobileBackToPreview = within(mobileFileTreeHeader).getByLabelText('codeAgentBackToFilePreview');
    expect(mobileBackToPreview.className).toContain('h-8');
    expect(mobileBackToPreview.className).toContain('w-8');
    fireEvent.click(mobileBackToPreview);
    await waitFor(() => {
      expect(previewBody.dataset.mobileView).toBe('preview');
      expect(previewContent.classList.contains('hidden')).toBe(false);
    });
    expect(screen.getByTestId('code-agent-mobile-file-preview-header')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('codeAgentShowFileExplorer'));
    await waitFor(() => {
      expect(previewBody.dataset.mobileView).toBe('explorer');
    });
    expect(screen.queryByTestId('code-agent-mobile-file-preview-header')).toBeNull();
    mobileExplorer = screen.getByTestId('code-agent-mobile-file-tree-header').closest('aside') as HTMLElement;
    mobileFileTreeHeader = screen.getByTestId('code-agent-mobile-file-tree-header');
    mobileFileTreeActions = screen.getByTestId('code-agent-mobile-file-tree-actions');
    expect(mobileFileTreeHeader.contains(mobileFileTreeActions)).toBe(true);
    expect(mobileFileTreeActions.className).toContain('min-w-max');
    expect(screen.getByLabelText('codeAgentSearchWorkspaceFiles').className).toContain('h-8');
    expect(screen.getByLabelText('codeAgentSearchWorkspaceFiles').className).toContain('w-8');
    expect(screen.getByLabelText('codeAgentNewFile').className).toContain('h-8');
    expect(screen.getByLabelText('codeAgentRenameFile').className).toContain('h-8');
    fireEvent.click(screen.getByLabelText('codeAgentSearchWorkspaceFiles'));
    expect(openSearchMock).not.toHaveBeenCalled();
    const mobileSearchRow = screen.getByTestId('code-agent-mobile-file-tree-search-row');
    expect(mobileSearchRow).toBeTruthy();
    const mobileRows = within(mobileExplorer).getAllByTestId('code-agent-mobile-file-tree-row');
    expect(mobileRows.length).toBeGreaterThan(0);
    expect(mobileRows.every((row) => row.className.includes('min-h-[42px]'))).toBe(true);
    const docsRow = within(mobileExplorer).getByLabelText('docs');
    expect(docsRow.dataset.kind).toBe('directory');
    expect(docsRow.textContent).toContain('1');
    const mobileSearchInput = within(mobileSearchRow).getByRole('textbox', { name: 'codeAgentSearchWorkspaceFiles' });
    fireEvent.change(mobileSearchInput, { target: { value: 'guide' } });
    expect(within(mobileExplorer).getByLabelText('docs/Guide.md')).toBeTruthy();
    expect(within(mobileExplorer).queryByLabelText('src/App.tsx')).toBeNull();

    fireEvent.click(within(mobileExplorer).getByLabelText('docs/Guide.md'));
    await waitFor(() => {
      expect(screen.getByTestId('diff-file').textContent).toBe('docs/Guide.md:contents:docs/Guide.md');
      expect(screen.getByTestId('code-agent-file-preview-body').dataset.mobileView).toBe('preview');
    });
  });

  it('scrolls the selected mobile file tree row into view and supports pull refresh', async () => {
    const scrolledPaths: string[] = [];
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value(this: HTMLElement) {
        if (this.dataset.path) {
          scrolledPaths.push(this.dataset.path);
        }
      },
    });
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/nested/Deep.tsx', name: 'Deep.tsx', type: 'file' },
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
    openCodeAgentRightPanelFile('room-1', 'src/nested/Deep.tsx');

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" surface="mobile" />);
    await waitFor(() => {
      expect(screen.getByTestId('diff-file').textContent).toBe('src/nested/Deep.tsx:contents:src/nested/Deep.tsx');
    });

    fireEvent.click(screen.getByLabelText('codeAgentShowFileExplorer'));
    const mobileExplorer = await screen.findByTestId('code-agent-mobile-file-tree-list');
    await waitFor(() => {
      expect(scrolledPaths).toContain('src/nested/Deep.tsx');
    });

    const refreshCallCount = loadCodeWorkspaceEntriesMock.mock.calls.length;
    fireEvent.touchStart(mobileExplorer, {
      touches: [{ clientY: 12 }],
    });
    fireEvent.touchMove(mobileExplorer, {
      touches: [{ clientY: 160 }],
    });
    await waitFor(() => {
      expect(screen.getByTestId('code-agent-mobile-file-tree-pull-refresh').dataset.pullReady).toBe('true');
    });
    fireEvent.touchEnd(mobileExplorer);
    await waitFor(() => {
      expect(loadCodeWorkspaceEntriesMock).toHaveBeenCalledTimes(refreshCallCount + 1);
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
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('codeAgentBrowserAddressLabel'));
    });

    fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentWorkspaceFiles'));
    await waitFor(() => {
      expect(screen.queryByTestId('diff-file')).toBeNull();
      expect(screen.getByTestId('code-agent-file-surface-tabs').textContent).toContain('codeAgentWorkspaceFiles');
    });
  });

  it('opens a browser surface from panel-level preview automation before a tab host exists', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [],
      truncated: false,
    });

    const { container } = render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    await screen.findByText('0 files');
    const panelConnectCall = await waitFor(() => {
      const call = connectPreviewAutomationHostMock.mock.calls.find(([options]) => (
        !options.tabId
        && JSON.stringify(options.supportedOperations) === JSON.stringify(['status', 'open', 'navigate', 'resize'])
      ));
      expect(call).toBeTruthy();
      return call!;
    });
    const panelHandle = panelConnectCall[0].handle;

    await expect(panelHandle({
      requestId: 'panel-status',
      roomId: 'room-1',
      operation: 'status',
      input: {},
      timeoutMs: 1000,
    })).resolves.toMatchObject({
      available: true,
      visible: false,
      tabId: null,
      url: null,
      loading: false,
    });

    await expect(panelHandle({
      requestId: 'panel-navigate',
      roomId: 'room-1',
      operation: 'navigate',
      input: {
        target: {
          kind: 'environment-port',
          port: 5173,
          path: '/dashboard',
        },
      },
      timeoutMs: 1000,
    })).resolves.toMatchObject({
      available: true,
      visible: true,
      tabId: 'browser:new',
      url: 'https://5173-sandbox.e2b.dev/dashboard',
      loading: false,
    });

    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://5173-sandbox.e2b.dev/dashboard');
      expect(screen.getByLabelText('codeAgentBrowserAddressLabel')).toBeTruthy();
    });
    expect(resolvePreviewTargetMock).toHaveBeenCalledWith({
      roomId: 'room-1',
      target: {
        kind: 'environment-port',
        port: 5173,
        path: '/dashboard',
      },
    });
    await waitFor(() => {
      expect(openPreviewSessionMock).toHaveBeenCalledWith(expect.objectContaining({
        roomId: 'room-1',
        tabId: 'browser:new',
        url: 'https://5173-sandbox.e2b.dev/dashboard',
      }));
      expect(connectPreviewAutomationHostMock).toHaveBeenCalledWith(expect.objectContaining({
        roomId: 'room-1',
        tabId: 'browser:new',
      }));
    });
  });

  it('syncs requested preview automation sessions before targeting a browser surface', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [],
      truncated: false,
    });
    const serverSession = {
      roomId: 'room-1',
      tabId: 'browser:agent',
      navStatus: {
        _tag: 'Success',
        url: 'https://5173-sandbox.e2b.dev/dashboard',
        title: 'Dashboard',
      },
      canGoBack: false,
      canGoForward: false,
      viewport: { _tag: 'fill' },
      updatedAt: '2026-07-02T00:00:00.000Z',
    };
    listPreviewSessionsMock.mockResolvedValue([serverSession]);

    const { container } = render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    await screen.findByText('0 files');
    const panelConnectCall = await waitFor(() => {
      const call = connectPreviewAutomationHostMock.mock.calls.find(([options]) => (
        !options.tabId
        && JSON.stringify(options.supportedOperations) === JSON.stringify(['status', 'open', 'navigate', 'resize'])
      ));
      expect(call).toBeTruthy();
      return call!;
    });
    const panelHandle = panelConnectCall[0].handle;

    await expect(panelHandle({
      requestId: 'panel-status-existing',
      roomId: 'room-1',
      tabId: 'browser:agent',
      tabIdExplicit: true,
      operation: 'status',
      input: {},
      timeoutMs: 1000,
    })).resolves.toMatchObject({
      available: true,
      visible: false,
      tabId: 'browser:agent',
      url: 'https://5173-sandbox.e2b.dev/dashboard',
      title: 'Dashboard',
      loading: false,
    });
    expect(container.querySelector('iframe')).toBeNull();

    await expect(panelHandle({
      requestId: 'panel-resize-existing',
      roomId: 'room-1',
      tabId: 'browser:agent',
      tabIdExplicit: true,
      operation: 'resize',
      input: { mode: 'freeform', width: 390, height: 844 },
      timeoutMs: 1000,
    })).resolves.toMatchObject({
      tabId: 'browser:agent',
      setting: { _tag: 'freeform', width: 390, height: 844 },
      viewport: { width: 390, height: 844 },
    });

    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://5173-sandbox.e2b.dev/dashboard');
    });
    expect(resizePreviewSessionMock).toHaveBeenCalledWith({
      roomId: 'room-1',
      tabId: 'browser:agent',
      viewport: { _tag: 'freeform', width: 390, height: 844 },
    });
    const syncedSurface = readCodeAgentRightPanelState('room-1').surfaces.find((candidate) => (
      candidate.kind === 'preview' && candidate.previewSessionId === 'browser:agent'
    ));
    expect(syncedSurface).toMatchObject({
      kind: 'preview',
      previewSessionId: 'browser:agent',
      url: 'https://5173-sandbox.e2b.dev/dashboard',
    });
  });

  it('restores cloud preview sessions into desktop browser tabs on mount', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [],
      truncated: false,
    });
    listPreviewSessionsMock.mockResolvedValue([{
      roomId: 'room-1',
      tabId: 'preview-tab-1',
      navStatus: {
        _tag: 'Success',
        url: 'https://5173-sandbox.e2b.dev/dashboard',
        title: 'Dashboard',
      },
      canGoBack: false,
      canGoForward: false,
      viewport: { _tag: 'freeform', width: 390, height: 844 },
      updatedAt: '2026-07-02T00:00:00.000Z',
    }]);

    const { container } = render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    await screen.findByText('0 files');
    await waitFor(() => {
      expect(listPreviewSessionsMock).toHaveBeenCalledWith('room-1');
      expect(screen.getByTestId('code-agent-file-surface-tabs').textContent).toContain('5173-sandbox.e2b.dev');
    });
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-tabs')).getByTitle('https://5173-sandbox.e2b.dev/dashboard'));
    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://5173-sandbox.e2b.dev/dashboard');
    });
    expect(readCodeAgentRightPanelState('room-1').surfaces).toEqual([
      expect.objectContaining({ kind: 'files' }),
      expect.objectContaining({
        kind: 'preview',
        previewSessionId: 'preview-tab-1',
        url: 'https://5173-sandbox.e2b.dev/dashboard',
        viewport: { _tag: 'freeform', width: 390, height: 844 },
      }),
    ]);
  });

  it('restores cloud preview sessions into mobile browser tabs on mount', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [],
      truncated: false,
    });
    listPreviewSessionsMock.mockResolvedValue([{
      roomId: 'room-1',
      tabId: 'preview-tab-mobile',
      navStatus: {
        _tag: 'Success',
        url: 'https://5173-sandbox.e2b.dev/mobile',
        title: 'Mobile preview',
      },
      canGoBack: false,
      canGoForward: false,
      viewport: { _tag: 'fill' },
      updatedAt: '2026-07-02T00:00:00.000Z',
    }]);

    const { container } = render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" surface="mobile" />);

    await screen.findByText('0 files');
    await waitFor(() => {
      expect(screen.getByTestId('code-agent-file-surface-tabs').textContent).toContain('5173-sandbox.e2b.dev');
    });
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-tabs')).getByTitle('https://5173-sandbox.e2b.dev/mobile'));
    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://5173-sandbox.e2b.dev/mobile');
    });
    const mobileChrome = screen.getByTestId('code-agent-mobile-browser-chrome');
    expect(mobileChrome.dataset.mobileBrowserChrome).toBe('true');
    expect(screen.getByTestId('code-agent-file-surface-tabs').textContent).toContain('5173-sandbox.e2b.dev');
    const mobilePreviewSurface = readCodeAgentRightPanelState('room-1').surfaces.find((candidate) => (
      candidate.kind === 'preview' && candidate.previewSessionId === 'preview-tab-mobile'
    ));
    expect(mobilePreviewSurface).toMatchObject({
      kind: 'preview',
      previewSessionId: 'preview-tab-mobile',
      url: 'https://5173-sandbox.e2b.dev/mobile',
    });
  });

  it('recovers desktop preview sessions from local URL tabs when the server list is empty', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [],
      truncated: false,
    });
    const localPreviewUrl = 'https://example.com/app';
    resetCodeAgentRightPanelStoreForTests({
      byRoomId: {
        'room-1': {
          isOpen: true,
          activeSurfaceId: 'files',
          surfaces: [
            { id: 'files', kind: 'files' },
            {
              id: `browser:url:${encodeURIComponent(localPreviewUrl)}`,
              kind: 'preview',
              relativePath: null,
              url: localPreviewUrl,
              navigationHistory: [{ kind: 'url', url: localPreviewUrl }],
              navigationIndex: 0,
              previewSessionId: 'preview-tab-local',
              viewport: { _tag: 'freeform', width: 390, height: 844 },
            },
          ],
        },
      },
    });

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    await screen.findByText('0 files');
    await waitFor(() => {
      expect(openPreviewSessionMock).toHaveBeenCalledWith({
        roomId: 'room-1',
        tabId: 'preview-tab-local',
        url: localPreviewUrl,
        title: localPreviewUrl,
        viewport: { _tag: 'freeform', width: 390, height: 844 },
      });
    });
    expect(readCodeAgentRightPanelState('room-1').activeSurfaceId).toBe('files');
  });

  it('recovers mobile preview sessions from local URL tabs when the server list is empty', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [],
      truncated: false,
    });
    const localPreviewUrl = 'https://example.com/mobile';
    resetCodeAgentRightPanelStoreForTests({
      byRoomId: {
        'room-1': {
          isOpen: true,
          activeSurfaceId: 'files',
          surfaces: [
            { id: 'files', kind: 'files' },
            {
              id: `browser:url:${encodeURIComponent(localPreviewUrl)}`,
              kind: 'preview',
              relativePath: null,
              url: localPreviewUrl,
              navigationHistory: [{ kind: 'url', url: localPreviewUrl }],
              navigationIndex: 0,
              previewSessionId: 'preview-tab-mobile-local',
            },
          ],
        },
      },
    });

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" surface="mobile" />);

    await screen.findByText('0 files');
    await waitFor(() => {
      expect(openPreviewSessionMock).toHaveBeenCalledWith(expect.objectContaining({
        roomId: 'room-1',
        tabId: 'preview-tab-mobile-local',
        url: localPreviewUrl,
      }));
    });
    expect(readCodeAgentRightPanelState('room-1').activeSurfaceId).toBe('files');
    expect(screen.getByTestId('code-agent-file-surface-tabs').textContent).toContain('example.com');
  });

  it('closes cloud preview sessions when browser surfaces are closed in bulk', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [],
      truncated: false,
    });

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);
    await screen.findByText('0 files');

    fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentBrowserSurface'));
    fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentBrowserSurface'));

    const tabs = screen.getByTestId('code-agent-file-surface-tabs');
    expect(within(tabs).getAllByText('codeAgentBrowserSurface')).toHaveLength(2);

    fireEvent.contextMenu(within(tabs).getAllByRole('tab')[0], { clientX: 12, clientY: 24 });
    fireEvent.click(screen.getByText('codeAgentCloseAllFileTabs'));

    await waitFor(() => {
      expect(closePreviewSessionMock).toHaveBeenCalledWith({ roomId: 'room-1', tabId: 'browser:new' });
      expect(closePreviewSessionMock).toHaveBeenCalledWith({ roomId: 'room-1', tabId: 'browser:new:2' });
    });
    expect(screen.queryByTestId('code-agent-file-surface-tabs')).toBeNull();
  });

  it('closes cloud preview sessions from mobile browser tabs', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [],
      truncated: false,
    });

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" surface="mobile" />);
    await screen.findByText('0 files');

    fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentBrowserSurface'));

    const tabs = screen.getByTestId('code-agent-file-surface-tabs');
    fireEvent.click(within(tabs).getByLabelText('close codeAgentBrowserSurface'));

    await waitFor(() => {
      expect(closePreviewSessionMock).toHaveBeenCalledWith({ roomId: 'room-1', tabId: 'browser:new' });
    });
    await waitFor(() => {
      expect(screen.getByTestId('code-agent-file-surface-tabs').textContent).toContain('codeAgentWorkspaceFiles');
      expect(screen.getByTestId('code-agent-file-surface-tabs').textContent).not.toContain('codeAgentBrowserSurface');
    });
  });

  it('navigates browser surfaces to http URLs without creating workspace asset URLs', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [],
      truncated: false,
    });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);

    const { container } = render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    await screen.findByText('0 files');
    fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentBrowserSurface'));

    const address = screen.getByLabelText('codeAgentBrowserAddressLabel') as HTMLInputElement;
    fireEvent.change(address, { target: { value: 'https://example.com/report' } });
    fireEvent.submit(address.closest('form') as HTMLFormElement);

    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://example.com/report');
    });
    await waitFor(() => {
      expect(navigatePreviewSessionMock).toHaveBeenCalledWith(expect.objectContaining({
        roomId: 'room-1',
        tabId: 'browser:new',
        url: 'https://example.com/report',
      }));
      expect(openPreviewSessionMock).toHaveBeenCalledWith(expect.objectContaining({
        roomId: 'room-1',
        tabId: 'browser:new',
        url: 'https://example.com/report',
      }));
    });
    const firstIframe = container.querySelector('iframe') as HTMLIFrameElement;
    await waitFor(() => {
      expect(screen.getByTestId('code-agent-browser-loading-progress').style.width).not.toBe('0%');
    });
    fireEvent.load(firstIframe);
    await waitFor(() => {
      expect(reportPreviewSessionMock).toHaveBeenCalledWith(expect.objectContaining({
        roomId: 'room-1',
        tabId: 'browser:new',
        navStatus: expect.objectContaining({
          _tag: 'Success',
          url: 'https://example.com/report',
        }),
      }));
    });
    await waitFor(() => {
      expect(screen.getByTestId('code-agent-browser-loading-progress').style.width).toBe('100%');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('code-agent-browser-loading-progress')).toBeNull();
    });
    await waitFor(() => {
      expect(address.value).toBe('example.com');
    });
    expect(address.getAttribute('title')).toBe('https://example.com/report');
    expect((screen.getByLabelText('codeAgentBrowserBack') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('codeAgentBrowserForward') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.focus(address);
    await waitFor(() => {
      expect(address.value).toBe('https://example.com/report');
      expect(address.selectionStart).toBe(0);
      expect(address.selectionEnd).toBe('https://example.com/report'.length);
    });
    fireEvent.change(address, { target: { value: 'notaurl' } });
    fireEvent.keyDown(address, { key: 'Escape' });
    await waitFor(() => {
      expect(address.value).toBe('example.com');
    });

    fireEvent.focus(address);
    fireEvent.change(address, { target: { value: 'https://example.org/next' } });
    fireEvent.submit(address.closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://example.org/next');
      expect(address.value).toBe('example.org');
    });
    await waitFor(() => {
      expect(navigatePreviewSessionMock).toHaveBeenCalledWith(expect.objectContaining({
        roomId: 'room-1',
        tabId: 'browser:new',
        url: 'https://example.org/next',
      }));
    });
    expect((screen.getByLabelText('codeAgentBrowserBack') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText('codeAgentBrowserForward') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('codeAgentBrowserBack'));
    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://example.com/report');
      expect(address.value).toBe('example.com');
    });
    expect((screen.getByLabelText('codeAgentBrowserBack') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('codeAgentBrowserForward') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByLabelText('codeAgentBrowserForward'));
    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://example.org/next');
      expect(address.value).toBe('example.org');
    });
    expect(createCodeWorkspaceAssetUrlMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('code-agent-file-surface-tabs').textContent).toContain('example.org');
    const browserTabFavicon = within(screen.getByTestId('code-agent-file-surface-tabs')).getByTestId(
      'code-agent-browser-tab-favicon',
    ) as HTMLImageElement;
    expect(browserTabFavicon.src).toBe('https://www.google.com/s2/favicons?domain=example.org&sz=32');
    fireEvent.error(browserTabFavicon);
    expect(
      within(screen.getByTestId('code-agent-file-surface-tabs')).getByTestId(
        'code-agent-browser-tab-favicon-fallback',
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByLabelText('codeAgentOpenBrowserPreviewExternally'));
    expect(open).toHaveBeenCalledWith('https://example.org/next', '_blank', 'noopener,noreferrer');

    fireEvent.click(screen.getByLabelText('codeAgentBrowserRefresh'));
    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://example.org/next');
    });

    const iframeBeforeHardReload = container.querySelector('iframe');
    fireEvent.click(screen.getByLabelText('moreActions'));
    let browserMoreMenu = screen.getByTestId('code-agent-browser-more-menu');
    fireEvent.click(within(browserMoreMenu).getByText('codeAgentBrowserHardReload'));
    await waitFor(() => {
      expect(container.querySelector('iframe')).not.toBe(iframeBeforeHardReload);
    });

    const iframeBeforeClearCookies = container.querySelector('iframe');
    fireEvent.click(screen.getByLabelText('moreActions'));
    browserMoreMenu = screen.getByTestId('code-agent-browser-more-menu');
    fireEvent.click(within(browserMoreMenu).getByText('codeAgentBrowserClearCookies'));
    await waitFor(() => {
      expect(runPreviewAutomationRequestMock).toHaveBeenCalledWith(expect.objectContaining({
        roomId: 'room-1',
        tabId: 'browser:new',
        operation: 'clearCookies',
        input: {},
        timeoutMs: 10000,
      }));
      expect(container.querySelector('iframe')).not.toBe(iframeBeforeClearCookies);
    });

    const iframeBeforeClearCache = container.querySelector('iframe');
    fireEvent.click(screen.getByLabelText('moreActions'));
    browserMoreMenu = screen.getByTestId('code-agent-browser-more-menu');
    fireEvent.click(within(browserMoreMenu).getByText('codeAgentBrowserClearCache'));
    await waitFor(() => {
      expect(runPreviewAutomationRequestMock).toHaveBeenCalledWith(expect.objectContaining({
        roomId: 'room-1',
        tabId: 'browser:new',
        operation: 'clearCache',
        input: {},
        timeoutMs: 10000,
      }));
      expect(container.querySelector('iframe')).not.toBe(iframeBeforeClearCache);
    });

    fireEvent.click(screen.getByLabelText('moreActions'));
    browserMoreMenu = screen.getByTestId('code-agent-browser-more-menu');
    fireEvent.click(within(browserMoreMenu).getByLabelText('codeAgentBrowserZoomIn'));
    await waitFor(() => {
      const zoomFrame = screen.getByTestId('code-agent-browser-preview-zoom-frame');
      expect(zoomFrame.style.transform).toBe('scale(1.1)');
      expect(zoomFrame.style.width).toBe('90.9090909090909%');
      expect(screen.getByTestId('code-agent-browser-zoom-indicator').textContent).toBe('110%');
      expect(screen.getByTestId('code-agent-browser-zoom-indicator').getAttribute('aria-hidden')).toBe('false');
    });
    const browserSurface = readCodeAgentRightPanelState('room-1').surfaces.find(
      (surface) => surface.id === 'browser:url:https%3A%2F%2Fexample.org%2Fnext',
    );
    expect(browserSurface).toMatchObject({ zoomFactor: 1.1 });

    fireEvent.click(within(browserMoreMenu).getByLabelText('codeAgentBrowserResetZoom'));
    await waitFor(() => {
      const zoomFrame = screen.getByTestId('code-agent-browser-preview-zoom-frame');
      expect(zoomFrame.style.transform).toBe('scale(1)');
      expect(screen.getByTestId('code-agent-browser-zoom-indicator').textContent).toBe('100%');
    });
    const resetBrowserSurface = readCodeAgentRightPanelState('room-1').surfaces.find(
      (surface) => surface.id === 'browser:url:https%3A%2F%2Fexample.org%2Fnext',
    );
    expect(resetBrowserSurface).not.toHaveProperty('zoomFactor');
    expect(resetBrowserSurface).toMatchObject({ previewSessionId: 'browser:new' });

    browserMoreMenu = screen.getByTestId('code-agent-browser-more-menu');
    fireEvent.click(within(browserMoreMenu).getByText('codeAgentBrowserShowDeviceToolbar'));
    const deviceToolbar = await screen.findByTestId('code-agent-browser-device-toolbar');
    expect(deviceToolbar).toBeTruthy();
    await waitFor(() => {
      expect(resizePreviewSessionMock).toHaveBeenCalledWith(expect.objectContaining({
        roomId: 'room-1',
        tabId: 'browser:new',
        viewport: expect.objectContaining({ _tag: 'freeform' }),
      }));
    });

    fireEvent.change(screen.getByLabelText('codeAgentBrowserDevicePreset'), {
      target: { value: 'iphone-12-pro' },
    });
    await waitFor(() => {
      expect(resizePreviewSessionMock).toHaveBeenCalledWith(expect.objectContaining({
        roomId: 'room-1',
        tabId: 'browser:new',
        viewport: {
          _tag: 'preset',
          presetId: 'iphone-12-pro',
          width: 390,
          height: 844,
        },
      }));
    });
  });

  it('registers cloud browser automation with DOM operations and executes them in the iframe', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [],
      truncated: false,
    });

    const { container } = render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    await screen.findByText('0 files');
    fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentBrowserSurface'));

    const address = screen.getByLabelText('codeAgentBrowserAddressLabel') as HTMLInputElement;
    fireEvent.change(address, { target: { value: 'https://example.com/app' } });
    fireEvent.submit(address.closest('form') as HTMLFormElement);

    let iframe = await waitFor(() => {
      const frame = container.querySelector('iframe');
      expect(frame).toBeTruthy();
      return frame as HTMLIFrameElement;
    });

    await waitFor(() => {
      expect(connectPreviewAutomationHostMock).toHaveBeenCalledWith(expect.objectContaining({
        roomId: 'room-1',
        tabId: 'browser:new',
        supportedOperations: ['status', 'open', 'navigate', 'resize', 'snapshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'waitFor', 'previewAnnotation', 'clearCookies', 'clearCache', 'recordingStart', 'recordingStop'],
        handle: expect.any(Function),
      }));
      expect(previewAutomationHandleRef.current).toEqual(expect.any(Function));
    });

    await expect(previewAutomationHandleRef.current?.({
      requestId: 'request-resize',
      roomId: 'room-1',
      tabId: 'browser:new',
      operation: 'resize',
      input: { mode: 'freeform', width: 390, height: 844 },
      timeoutMs: 1000,
    })).resolves.toMatchObject({
      tabId: 'browser:new',
      setting: { _tag: 'freeform', width: 390, height: 844 },
      viewport: { width: 390, height: 844 },
    });

    iframe = await waitFor(() => {
      const frame = container.querySelector('iframe');
      expect(frame).toBeTruthy();
      return frame as HTMLIFrameElement;
    });
    const frameDocument = iframe.contentDocument!;
    frameDocument.open();
    frameDocument.write('<button id="save" type="button" aria-label="Save changes">Save</button><input id="title" aria-label="Title" />');
    frameDocument.close();
    frameDocument.getElementById('save')?.addEventListener('click', () => {
      frameDocument.body.setAttribute('data-saved', 'true');
    });

    await expect(previewAutomationHandleRef.current?.({
      requestId: 'request-click',
      roomId: 'room-1',
      tabId: 'browser:new',
      operation: 'click',
      input: { locator: 'role=button[name="Save"]' },
      timeoutMs: 1000,
    })).resolves.toMatchObject({ clicked: true });
    expect(frameDocument.body.getAttribute('data-saved')).toBe('true');
    const automationCursor = await screen.findByTestId('code-agent-browser-automation-cursor');
    expect(automationCursor.dataset.phase).toBe('click');
    expect(automationCursor.dataset.sequence).toBe('1');
    expect(screen.getByTestId('code-agent-browser-automation-cursor-ping')).toBeTruthy();

    await expect(previewAutomationHandleRef.current?.({
      requestId: 'request-type',
      roomId: 'room-1',
      tabId: 'browser:new',
      operation: 'type',
      input: { selector: '#title', text: 'Launch', clear: true },
      timeoutMs: 1000,
    })).resolves.toMatchObject({ typed: true });
    expect((frameDocument.querySelector('#title') as HTMLInputElement).value).toBe('Launch');

    await expect(previewAutomationHandleRef.current?.({
      requestId: 'request-snapshot',
      roomId: 'room-1',
      tabId: 'browser:new',
      operation: 'snapshot',
      input: {},
      timeoutMs: 1000,
    })).resolves.toMatchObject({
      visibleText: expect.stringContaining('Save'),
      interactiveElements: expect.arrayContaining([
        expect.objectContaining({ role: 'button', name: 'Save changes' }),
      ]),
    });

    const navigateRequest = Promise.resolve(previewAutomationHandleRef.current?.({
      requestId: 'request-port',
      roomId: 'room-1',
      tabId: 'browser:new',
      operation: 'navigate',
      input: {
        target: {
          kind: 'environment-port',
          port: 5173,
          path: '/dashboard?tab=preview',
        },
      },
      timeoutMs: 1000,
    }));
    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://5173-sandbox.e2b.dev/dashboard?tab=preview');
    });
    fireEvent.load(container.querySelector('iframe') as HTMLIFrameElement);
    await expect(navigateRequest).resolves.toMatchObject({
      url: 'https://5173-sandbox.e2b.dev/dashboard?tab=preview',
      loading: false,
    });
    expect(resolvePreviewTargetMock).toHaveBeenCalledWith({
      roomId: 'room-1',
      target: {
        kind: 'environment-port',
        port: 5173,
        path: '/dashboard?tab=preview',
      },
    });
    expect(navigatePreviewSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      roomId: 'room-1',
      tabId: 'browser:new',
      url: 'https://5173-sandbox.e2b.dev/dashboard?tab=preview',
    }));

    await expect(previewAutomationHandleRef.current?.({
      requestId: 'request-fast-navigation',
      roomId: 'room-1',
      tabId: 'browser:new',
      operation: 'navigate',
      input: {
        url: 'https://example.com/fast',
        readiness: 'none',
      },
      timeoutMs: 1000,
    })).resolves.toMatchObject({
      url: 'https://example.com/fast',
      loading: true,
    });
  });

  it('rejects cloud browser automation navigation readiness when the preview load fails', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [],
      truncated: false,
    });

    const { container } = render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    await screen.findByText('0 files');
    fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentBrowserSurface'));

    const address = screen.getByLabelText('codeAgentBrowserAddressLabel') as HTMLInputElement;
    fireEvent.change(address, { target: { value: 'https://example.com/app' } });
    fireEvent.submit(address.closest('form') as HTMLFormElement);

    await waitFor(() => {
      expect(previewAutomationHandleRef.current).toEqual(expect.any(Function));
    });

    const navigationRequest = Promise.resolve(previewAutomationHandleRef.current?.({
      requestId: 'request-failed-navigation',
      roomId: 'room-1',
      tabId: 'browser:new',
      operation: 'navigate',
      input: { url: 'https://example.com/unreachable' },
      timeoutMs: 1000,
    }));
    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://example.com/unreachable');
    });

    fireEvent.error(container.querySelector('iframe') as HTMLIFrameElement);

    await expect(navigationRequest).rejects.toThrow('codeAgentBrowserPreviewFailed');
    expect(await screen.findByTestId('code-agent-browser-preview-unreachable')).toBeTruthy();
  });

  it('captures cloud browser preview screenshots from the chrome action', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [],
      truncated: false,
    });
    class TestImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    const originalImage = window.Image;
    Object.defineProperty(window, 'Image', {
      configurable: true,
      value: TestImage,
    });
    let downloadedHref = '';
    let downloadedFilename = '';
    const clickMock = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
      downloadedHref = this.href;
      downloadedFilename = this.download;
    });

    try {
      const { container } = render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

      await screen.findByText('0 files');
      fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
      fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentBrowserSurface'));

      const address = screen.getByLabelText('codeAgentBrowserAddressLabel') as HTMLInputElement;
      expect((screen.getByLabelText('codeAgentBrowserCaptureScreenshot') as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(address, { target: { value: 'https://example.com/app' } });
      fireEvent.submit(address.closest('form') as HTMLFormElement);

      const iframe = await waitFor(() => {
        const frame = container.querySelector('iframe');
        expect(frame).toBeTruthy();
        return frame as HTMLIFrameElement;
      });
      const frameWindow = iframe.contentWindow as Window & typeof globalThis;
      Object.defineProperties(frameWindow, {
        Image: { configurable: true, value: TestImage },
        innerWidth: { configurable: true, value: 1440 },
        innerHeight: { configurable: true, value: 900 },
      });
      vi.spyOn(frameWindow.HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
        drawImage: vi.fn(),
      } as unknown as CanvasRenderingContext2D);
      vi.spyOn(frameWindow.HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,c2NyZWVuc2hvdA==');
      iframe.contentDocument?.open();
      iframe.contentDocument?.write('<main><h1>Preview report</h1></main>');
      iframe.contentDocument?.close();

      fireEvent.click(screen.getByLabelText('codeAgentBrowserCaptureScreenshot'));

      await waitFor(() => {
        expect(clickMock).toHaveBeenCalled();
        expect(downloadedHref).toContain('data:image/png;base64,c2NyZWVuc2hvdA==');
        expect(downloadedFilename).toMatch(/^roomtalk-preview-example\.com-app-.*\.png$/);
      });
      expect(runPreviewAutomationRequestMock).toHaveBeenCalledWith(expect.objectContaining({
        roomId: 'room-1',
        tabId: expect.any(String),
        operation: 'snapshot',
        input: {},
        timeoutMs: 5000,
      }));
    } finally {
      clickMock.mockRestore();
      Object.defineProperty(window, 'Image', {
        configurable: true,
        value: originalImage,
      });
    }
  });

  it('captures preview annotations through the cloud browser automation path', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [],
      truncated: false,
    });
    const annotation = {
      id: 'annotation-1',
      pageUrl: 'https://example.com/app',
      pageTitle: 'Preview app',
      comment: '',
      elements: [{
        id: 'element-1',
        element: {
          pageUrl: 'https://example.com/app',
          pageTitle: 'Preview app',
          tagName: 'button',
          selector: '#save',
          htmlPreview: '<button id="save">Save</button>',
          componentName: null,
          source: null,
          stack: [],
          styles: 'display: inline-flex;',
          pickedAt: '2026-07-02T00:00:00.000Z',
        },
        rect: { x: 12, y: 16, width: 96, height: 32 },
      }],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: null,
      createdAt: '2026-07-02T00:00:00.000Z',
    };
    runPreviewAutomationRequestMock.mockResolvedValueOnce(annotation);
    const onAddPreviewAnnotation = vi.fn();

    render(
      <CodeAgentFileBrowserPanel
        roomId="room-1"
        projectName="Coco"
        surface="mobile"
        onAddPreviewAnnotation={onAddPreviewAnnotation}
      />,
    );

    await screen.findByText('0 files');
    fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentBrowserSurface'));

    const address = screen.getByLabelText('codeAgentBrowserAddressLabel') as HTMLInputElement;
    fireEvent.change(address, { target: { value: 'https://example.com/app' } });
    fireEvent.submit(address.closest('form') as HTMLFormElement);

    fireEvent.click(await screen.findByLabelText('codeAgentBrowserAnnotatePreview'));
    const overlay = await screen.findByTestId('code-agent-preview-annotation-overlay');
    fireEvent(overlay, new MouseEvent('pointerdown', {
      bubbles: true,
      clientX: 120,
      clientY: 180,
    }));

    await waitFor(() => {
      expect(runPreviewAutomationRequestMock).toHaveBeenCalledWith(expect.objectContaining({
        roomId: 'room-1',
        tabId: expect.any(String),
        operation: 'previewAnnotation',
        input: { clientX: 120, clientY: 180 },
        timeoutMs: 10000,
      }));
    });
    expect(onAddPreviewAnnotation).not.toHaveBeenCalled();

    const editor = await screen.findByTestId('code-agent-preview-annotation-editor');
    expect(editor.className).toContain('w-full');
    expect(editor.className).toContain('rounded-xl');
    const comment = within(editor).getByLabelText('codeAgentPreviewAnnotationCommentLabel');
    fireEvent.change(comment, { target: { value: 'Make the save button primary' } });
    fireEvent.click(within(editor).getByText('codeAgentAttachPreviewAnnotation'));

    await waitFor(() => {
      expect(onAddPreviewAnnotation).toHaveBeenCalledWith({
        ...annotation,
        comment: 'Make the save button primary',
      });
    });
    expect(screen.queryByTestId('code-agent-preview-annotation-overlay')).toBeNull();
  });

  it('records cloud browser previews and exposes the saved workspace artifact', async () => {
    const recordingPath = '.roomtalk/preview-recordings/preview-recording-browser-new.webm';
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [],
      truncated: false,
    });
    loadCodeWorkspaceFileMock.mockResolvedValue({
      path: recordingPath,
      content: 'cmVjb3JkaW5n',
      byteSize: 9,
      truncated: false,
      encoding: 'base64',
    });
    createCodeWorkspaceAssetUrlMock.mockResolvedValue({
      relativeUrl: '/api/coco/workspace-assets/token/preview-recording-browser-new.webm',
      expiresAt: '2026-07-02T00:30:00.000Z',
    });
    resolveCodeWorkspaceAssetUrlMock.mockReturnValue('/api/coco/workspace-assets/token/preview-recording-browser-new.webm');
    runPreviewAutomationRequestMock
      .mockResolvedValueOnce({
        tabId: 'browser:new',
        recording: true,
        startedAt: '2026-07-02T00:00:00.000Z',
      })
      .mockResolvedValueOnce({
        id: 'preview-recording-browser-new',
        tabId: 'browser:new',
        path: recordingPath,
        mimeType: 'video/webm',
        sizeBytes: 9,
        createdAt: '2026-07-02T00:00:05.000Z',
      });
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    let downloadedHref = '';
    let downloadedFilename = '';
    const clickMock = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
      downloadedHref = this.href;
      downloadedFilename = this.download;
    });

    try {
      render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

      await screen.findByText('0 files');
      fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
      fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentBrowserSurface'));

      const address = screen.getByLabelText('codeAgentBrowserAddressLabel') as HTMLInputElement;
      expect((screen.getByLabelText('codeAgentBrowserStartRecording') as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(address, { target: { value: 'https://example.com/app' } });
      fireEvent.submit(address.closest('form') as HTMLFormElement);

      await waitFor(() => {
        expect(screen.getByLabelText('codeAgentBrowserStartRecording')).toBeTruthy();
        expect((screen.getByLabelText('codeAgentBrowserStartRecording') as HTMLButtonElement).disabled).toBe(false);
      });

      fireEvent.click(screen.getByLabelText('codeAgentBrowserStartRecording'));
      await waitFor(() => {
        expect(runPreviewAutomationRequestMock).toHaveBeenCalledWith(expect.objectContaining({
          roomId: 'room-1',
          tabId: 'browser:new',
          operation: 'recordingStart',
          input: {},
          timeoutMs: 10000,
        }));
        expect(screen.getByLabelText('codeAgentBrowserStopRecording')).toBeTruthy();
      });

      fireEvent.click(screen.getByLabelText('codeAgentBrowserStopRecording'));
      const banner = await screen.findByTestId('code-agent-browser-recording-saved');
      expect(banner.textContent).toContain('codeAgentBrowserRecordingSaved');
      expect(banner.textContent).toContain(recordingPath);
      expect(runPreviewAutomationRequestMock).toHaveBeenCalledWith(expect.objectContaining({
        roomId: 'room-1',
        tabId: 'browser:new',
        operation: 'recordingStop',
        input: {},
        timeoutMs: 60000,
      }));
      expect(createCodeWorkspaceAssetUrlMock).toHaveBeenCalledWith('room-1', recordingPath);
      await waitFor(() => {
        expect(loadCodeWorkspaceEntriesMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      });

      fireEvent.click(within(banner).getByText('codeAgentCopyFilePath'));
      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(recordingPath);
      });

      fireEvent.click(within(banner).getByText('codeAgentDownloadFile'));
      expect(clickMock).toHaveBeenCalled();
      expect(downloadedHref).toContain('/api/coco/workspace-assets/token/preview-recording-browser-new.webm');
      expect(downloadedFilename).toBe('preview-recording-browser-new.webm');

      fireEvent.click(within(banner).getByText('codeAgentBrowserOpenRecording'));
      await waitFor(() => {
        expect(loadCodeWorkspaceFileMock).toHaveBeenCalledWith('room-1', recordingPath, expect.any(Object));
      });
    } finally {
      clickMock.mockRestore();
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it('uses a two-row browser preview chrome on mobile surfaces', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [],
      truncated: false,
    });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);

    const { container } = render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" surface="mobile" />);

    await screen.findByText('0 files');
    fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentBrowserSurface'));

    const mobileChrome = await screen.findByTestId('code-agent-mobile-browser-chrome');
    expect(mobileChrome.dataset.mobileBrowserChrome).toBe('true');
    expect(mobileChrome.querySelector('form')?.className).toContain('flex-col');
    const addressRow = screen.getByTestId('code-agent-mobile-browser-address-row');
    const actionRow = screen.getByTestId('code-agent-mobile-browser-action-row');
    expect(actionRow.className).toContain('overflow-x-auto');

    const address = within(addressRow).getByLabelText('codeAgentBrowserAddressLabel') as HTMLInputElement;
    expect(within(actionRow).getByLabelText('codeAgentBrowserBack')).toBeTruthy();
    expect(within(actionRow).getByLabelText('codeAgentBrowserForward')).toBeTruthy();
    expect(within(actionRow).getByLabelText('codeAgentBrowserRefresh')).toBeTruthy();
    expect(within(actionRow).getByLabelText('codeAgentBrowserCaptureScreenshot')).toBeTruthy();
    expect(within(actionRow).getByLabelText('codeAgentBrowserStartRecording')).toBeTruthy();
    expect(within(actionRow).getByLabelText('codeAgentOpenBrowserPreviewExternally')).toBeTruthy();
    expect(within(actionRow).getByLabelText('moreActions')).toBeTruthy();
    expect((within(actionRow).getByLabelText('codeAgentOpenBrowserPreviewExternally') as HTMLButtonElement).disabled).toBe(true);
    expect((within(actionRow).getByLabelText('codeAgentBrowserCaptureScreenshot') as HTMLButtonElement).disabled).toBe(true);
    expect((within(actionRow).getByLabelText('codeAgentBrowserStartRecording') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(address, { target: { value: 'https://example.com/mobile' } });
    fireEvent.submit(address.closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://example.com/mobile');
      expect(address.value).toBe('example.com');
    });

    fireEvent.click(within(actionRow).getByLabelText('codeAgentOpenBrowserPreviewExternally'));
    expect(open).toHaveBeenCalledWith('https://example.com/mobile', '_blank', 'noopener,noreferrer');

    fireEvent.click(within(actionRow).getByLabelText('codeAgentBrowserRefresh'));
    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://example.com/mobile');
    });

    const iframeBeforeHardReload = container.querySelector('iframe');
    fireEvent.click(within(actionRow).getByLabelText('moreActions'));
    let browserMoreMenu = screen.getByTestId('code-agent-browser-more-menu');
    fireEvent.click(within(browserMoreMenu).getByText('codeAgentBrowserHardReload'));
    await waitFor(() => {
      expect(container.querySelector('iframe')).not.toBe(iframeBeforeHardReload);
    });

    fireEvent.click(within(actionRow).getByLabelText('moreActions'));
    browserMoreMenu = screen.getByTestId('code-agent-browser-more-menu');
    expect(within(browserMoreMenu).getByText('codeAgentBrowserClearCookies')).toBeTruthy();
    expect(within(browserMoreMenu).getByText('codeAgentBrowserClearCache')).toBeTruthy();
    fireEvent.click(within(browserMoreMenu).getByText('codeAgentBrowserClearCookies'));
    await waitFor(() => {
      expect(runPreviewAutomationRequestMock).toHaveBeenCalledWith(expect.objectContaining({
        roomId: 'room-1',
        tabId: 'browser:new',
        operation: 'clearCookies',
        input: {},
        timeoutMs: 10000,
      }));
    });

    fireEvent.click(within(actionRow).getByLabelText('moreActions'));
    browserMoreMenu = screen.getByTestId('code-agent-browser-more-menu');
    fireEvent.click(within(browserMoreMenu).getByLabelText('codeAgentBrowserZoomIn'));
    await waitFor(() => {
      const zoomFrame = screen.getByTestId('code-agent-browser-preview-zoom-frame');
      expect(zoomFrame.style.transform).toBe('scale(1.1)');
    });
    fireEvent.click(within(browserMoreMenu).getByText('codeAgentBrowserShowDeviceToolbar'));
    expect(await screen.findByTestId('code-agent-browser-device-toolbar')).toBeTruthy();
    await waitFor(() => {
      expect(resizePreviewSessionMock).toHaveBeenCalledWith(expect.objectContaining({
        roomId: 'room-1',
        tabId: 'browser:new',
        viewport: expect.objectContaining({ _tag: 'freeform' }),
      }));
    });
  });

  it('renders preview unreachable state from cloud preview session failures', async () => {
    const previewEventCallbacks: Array<(event: any) => void> = [];
    subscribePreviewEventsMock.mockImplementation((_roomId, callback) => {
      previewEventCallbacks.push(callback);
      return () => undefined;
    });
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [],
      truncated: false,
    });

    const { container } = render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    await screen.findByText('0 files');
    fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentBrowserSurface'));

    const address = screen.getByLabelText('codeAgentBrowserAddressLabel') as HTMLInputElement;
    fireEvent.change(address, { target: { value: 'https://example.com/report' } });
    fireEvent.submit(address.closest('form') as HTMLFormElement);

    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://example.com/report');
    });

    act(() => {
      for (const callback of previewEventCallbacks) {
        callback({
          type: 'status',
          roomId: 'room-1',
          tabId: 'browser:new',
          createdAt: '2026-07-02T00:00:00.000Z',
          snapshot: {
            roomId: 'room-1',
            tabId: 'browser:new',
            navStatus: {
              _tag: 'LoadFailed',
              url: 'https://example.com/report',
              title: 'Example',
              code: -102,
              description: 'ERR_CONNECTION_REFUSED',
            },
            canGoBack: false,
            canGoForward: false,
            viewport: { _tag: 'fill' },
            updatedAt: '2026-07-02T00:00:00.000Z',
          },
        });
      }
    });

    expect(await screen.findByTestId('code-agent-browser-preview-unreachable')).toBeTruthy();
    expect(screen.getByText('ERR_CONNECTION_REFUSED')).toBeTruthy();
    expect((screen.getByLabelText('codeAgentBrowserCaptureScreenshot') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByText('codeAgentBrowserUnreachableDetails'));
    expect(screen.getByText('codeAgentBrowserUnreachableCheckServer')).toBeTruthy();

    fireEvent.click(screen.getByText('codeAgentBrowserUnreachableReload'));
    await waitFor(() => {
      expect(refreshPreviewSessionMock).toHaveBeenCalledWith({
        roomId: 'room-1',
        tabId: 'browser:new',
      });
      expect(screen.queryByTestId('code-agent-browser-preview-unreachable')).toBeNull();
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://example.com/report');
    });
  });

  it('shows recent cloud preview targets in empty browser surfaces', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [],
      truncated: false,
    });

    const { container } = render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    await screen.findByText('0 files');
    fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentBrowserSurface'));

    const address = screen.getByLabelText('codeAgentBrowserAddressLabel') as HTMLInputElement;
    fireEvent.change(address, { target: { value: 'https://example.com/report' } });
    fireEvent.submit(address.closest('form') as HTMLFormElement);

    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://example.com/report');
    });

    fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentBrowserSurface'));

    const emptyBrowser = await screen.findByTestId('code-agent-browser-surface-empty');
    const recentTargets = within(emptyBrowser).getByTestId('code-agent-browser-recent-targets');
    expect(within(recentTargets).getByText('recentlyUsed')).toBeTruthy();
    expect(within(recentTargets).getByText('example.com')).toBeTruthy();
    expect(within(recentTargets).getByText('https://example.com/report')).toBeTruthy();

    fireEvent.click(within(recentTargets).getByText('example.com'));
    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://example.com/report');
      expect((screen.getByLabelText('codeAgentBrowserAddressLabel') as HTMLInputElement).value).toBe(
        'https://example.com/report',
      );
    });
  });

  it('lists sandbox preview servers in empty browser surfaces', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [],
      truncated: false,
    });
    requestCodeWorkspacePreviewServersMock.mockResolvedValue([
      {
        host: 'localhost',
        port: 5173,
        url: 'http://localhost:5173/',
        processName: 'vite',
        pid: 1234,
      },
    ]);

    const { container } = render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    await screen.findByText('0 files');
    fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentBrowserSurface'));

    const servers = await screen.findByTestId('code-agent-browser-preview-servers');
    expect(within(servers).getByText('codeAgentWorkspacePreviewServers')).toBeTruthy();
    expect(within(servers).getByText('vite')).toBeTruthy();
    expect(within(servers).getByText('localhost:5173')).toBeTruthy();

    fireEvent.click(within(servers).getByText('vite'));

    await waitFor(() => {
      expect(resolvePreviewTargetMock).toHaveBeenCalledWith({
        roomId: 'room-1',
        target: {
          kind: 'environment-port',
          port: 5173,
          protocol: 'http',
          path: '/',
        },
      });
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://5173-sandbox.e2b.dev/');
    });
  });

  it('lists sandbox preview servers in mobile empty browser surfaces', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [],
      truncated: false,
    });
    requestCodeWorkspacePreviewServersMock.mockResolvedValue([
      {
        host: 'localhost',
        port: 3000,
        url: 'http://localhost:3000/',
        processName: 'next',
        pid: 5678,
      },
    ]);

    const { container } = render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" surface="mobile" />);

    await screen.findByText('0 files');
    fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentBrowserSurface'));

    const servers = await screen.findByTestId('code-agent-browser-preview-servers');
    expect(within(servers).getByText('next')).toBeTruthy();
    expect(within(servers).getByText('localhost:3000')).toBeTruthy();

    fireEvent.click(within(servers).getByText('next'));

    await waitFor(() => {
      expect(resolvePreviewTargetMock).toHaveBeenCalledWith({
        roomId: 'room-1',
        target: {
          kind: 'environment-port',
          port: 3000,
          protocol: 'http',
          path: '/',
        },
      });
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://3000-sandbox.e2b.dev/');
    });
  });

  it('navigates browser surfaces to previewable workspace files', async () => {
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

    await screen.findByText('1 files');
    fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentBrowserSurface'));

    const address = screen.getByLabelText('codeAgentBrowserAddressLabel') as HTMLInputElement;
    fireEvent.change(address, { target: { value: ' output/report.html ' } });
    fireEvent.submit(address.closest('form') as HTMLFormElement);

    await waitFor(() => {
      expect(createCodeWorkspaceAssetUrlMock).toHaveBeenCalledWith('room-1', 'output/report.html', expect.any(Object));
    });
    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('/api/coco/workspace-assets/token/report.html');
    });
    expect(screen.getByTestId('code-agent-file-surface-tabs').textContent).toContain('report.html');
  });

  it('shows an error for unsupported browser surface targets', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
      ],
      truncated: false,
    });

    const { container } = render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    await screen.findByText('1 files');
    fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentBrowserSurface'));

    const address = screen.getByLabelText('codeAgentBrowserAddressLabel') as HTMLInputElement;
    fireEvent.change(address, { target: { value: 'src/App.tsx' } });
    fireEvent.submit(address.closest('form') as HTMLFormElement);

    expect(screen.getByRole('alert').textContent).toBe('codeAgentBrowserInvalidTarget');
    expect(container.querySelector('iframe')).toBeNull();
    expect(createCodeWorkspaceAssetUrlMock).not.toHaveBeenCalled();
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
    expect(sidebar.style.width).toBe('var(--workspace-diff-changed-files-width)');
    expect(sidebar.style.maxWidth).toBe('calc(100% - 260px)');
    const diffSidebarResizeHandle = screen.getByLabelText('codeAgentResizeChangedFiles');
    expect(diffSidebarResizeHandle.className).toContain('w-8');
    expect(diffSidebarResizeHandle.className).not.toContain('hover:bg');
    const diffSidebarResizeHighlight = diffSidebarResizeHandle.querySelector('[data-code-agent-resize-highlight="diff-changed-files"]');
    expect(diffSidebarResizeHighlight?.className).toContain('w-0.5');
    expect(diffSidebarResizeHighlight?.className).toContain('-ml-px');
    expect(diffSidebarResizeHighlight?.className).toContain('z-50');
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

  it('uses a focused single-column changed-files list on mobile diff surfaces', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
        { path: 'src/utils.ts', name: 'utils.ts', type: 'file' },
      ],
      truncated: false,
    });

    render(
      <CodeAgentFileBrowserPanel
        roomId="room-1"
        projectName="Coco"
        surface="mobile"
        workspaceChanges={{
          available: true,
          changedFiles: ['src/App.tsx', 'src/utils.ts'],
          changedFileStats: [
            { path: 'src/App.tsx', additions: 7, deletions: 3 },
            { path: 'src/utils.ts', additions: 1, deletions: 0 },
          ],
          diffSummary: { files: 2, additions: 8, deletions: 3 },
        }}
      />
    );
    await screen.findByText('2 files');
    fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentChanges'));

    const diffSurface = await screen.findByTestId('code-agent-diff-surface-body');
    expect(diffSurface.dataset.mobileLayout).toBe('true');
    expect(diffSurface.dataset.mobileView).toBe('diff');
    expect(screen.queryByTestId('code-agent-diff-changed-files-sidebar')).toBeNull();
    expect(screen.queryByLabelText('codeAgentResizeChangedFiles')).toBeNull();
    expect(screen.getByTestId('code-agent-workspace-diff-viewer').dataset.enabled).toBe('true');
    expect(screen.getByTestId('code-agent-workspace-diff-viewer').dataset.mobileLayout).toBe('true');
    expect(screen.queryByTestId('code-agent-mobile-diff-files-toggle')).toBeNull();
    const mobileDiffFilesButton = screen.getByTestId('code-agent-mobile-diff-files-button');
    expect(within(screen.getByTestId('code-agent-workspace-diff-viewer')).getByTestId('code-agent-mobile-diff-files-button')).toBe(mobileDiffFilesButton);
    expect(within(mobileDiffFilesButton).getByText('codeAgentChangedFiles')).toBeTruthy();

    fireEvent.click(mobileDiffFilesButton);
    expect(diffSurface.dataset.mobileView).toBe('files');
    expect(screen.queryByTestId('code-agent-workspace-diff-viewer')).toBeNull();
    expect(screen.queryByTestId('code-agent-diff-changed-files-sidebar')).toBeNull();
    expect(screen.queryByLabelText('codeAgentResizeChangedFiles')).toBeNull();
    const mobileDiffFilesToggle = screen.getByTestId('code-agent-mobile-diff-files-toggle');
    expect(within(mobileDiffFilesToggle).getByText('codeAgentChanges')).toBeTruthy();
    expect(within(mobileDiffFilesToggle).queryByText('codeAgentChangedFilesCount')).toBeNull();
    expect(within(mobileDiffFilesToggle).queryByText('+8')).toBeNull();
    expect(within(mobileDiffFilesToggle).queryByText('-3')).toBeNull();

    const mobileFilesPanel = screen.getByTestId('code-agent-mobile-diff-changed-files-panel');
    const mobileChangedFilesTree = within(mobileFilesPanel).getByTestId('code-agent-changed-files-tree');
    expect(mobileChangedFilesTree.dataset.mobileLayout).toBe('true');
    const mobileRows = within(mobileFilesPanel).getAllByTestId('code-agent-changed-files-tree-row');
    expect(mobileRows.length).toBeGreaterThan(0);
    expect(mobileRows.every((row) => row.dataset.mobileLayout === 'true')).toBe(true);
    expect(mobileRows.every((row) => row.className.includes('min-h-[42px]'))).toBe(true);
    expect(mobileRows.some((row) => row.dataset.kind === 'directory' && row.dataset.path === 'src')).toBe(true);
    expect(mobileRows.some((row) => row.dataset.kind === 'file' && row.dataset.path === 'src/App.tsx')).toBe(true);
    const mobileChangedFilesHeader = within(mobileFilesPanel).getByTestId('code-agent-changed-files-panel-header');
    expect(mobileChangedFilesHeader.className).toContain('flex-wrap');
    expect(within(mobileChangedFilesHeader).getByText('codeAgentChangedFilesCount')).toBeTruthy();
    expect(within(mobileChangedFilesHeader).getByText('+8')).toBeTruthy();
    expect(within(mobileChangedFilesHeader).getByText('-3')).toBeTruthy();
    expect(within(mobileFilesPanel).getByText('+7')).toBeTruthy();
    expect(within(mobileFilesPanel).getAllByText('-3').length).toBeGreaterThan(0);

    fireEvent.click(within(mobileFilesPanel).getByText('App.tsx'));
    await waitFor(() => {
      expect(diffSurface.dataset.mobileView).toBe('diff');
      expect(screen.getByTestId('code-agent-workspace-diff-viewer').dataset.selectedFile).toBe('src/App.tsx');
    });
    expect(Number(screen.getByTestId('code-agent-workspace-diff-viewer').dataset.selectedFileRequestId)).toBeGreaterThan(0);
  });

  it('resizes the Diff changed-files sidebar while preserving the viewer area', async () => {
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
    fireEvent.click(screen.getByTestId('emit-diff-file-summaries'));

    const diffSurface = await screen.findByTestId('code-agent-diff-surface-body');
    vi.spyOn(diffSurface, 'getBoundingClientRect').mockReturnValue({
      width: 700,
      height: 500,
      top: 0,
      right: 700,
      bottom: 500,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const panel = document.querySelector<HTMLElement>('[data-file-browser-panel="room-1:workspace"]');
    expect(panel).toBeTruthy();
    const resizeHandle = screen.getByLabelText('codeAgentResizeChangedFiles');
    dispatchPointer(resizeHandle, 'pointerdown', { pointerId: 17, clientX: 288, buttons: 1 });
    dispatchPointer(window, 'pointermove', { pointerId: 17, clientX: 900, buttons: 1 });
    dispatchPointer(window, 'pointerup', { pointerId: 17, clientX: 900, buttons: 0 });
    dispatchPointer(window, 'pointermove', { pointerId: 17, clientX: 300, buttons: 1 });

    expect(panel!.style.getPropertyValue('--workspace-diff-changed-files-width')).toBe('440px');
    expect(localStorage.getItem('roomtalk.codeWorkspace.diffChangedFilesWidth')).toBe('440');
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('renders snapshot changed-file stats before live diff summaries load', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
      ],
      truncated: false,
    });

    render(
      <CodeAgentFileBrowserPanel
        roomId="room-1"
        projectName="Coco"
        workspaceChanges={{
          available: true,
          changedFiles: ['src/App.tsx'],
          changedFileStats: [{ path: 'src/App.tsx', additions: 2, deletions: 1 }],
          diffSummary: { files: 1, additions: 2, deletions: 1 },
        }}
      />
    );
    await screen.findByText('1 files');
    fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentChanges'));

    const sidebar = await screen.findByTestId('code-agent-diff-changed-files-sidebar');
    expect(within(sidebar).getByTestId('code-agent-changed-files-tree')).toBeTruthy();
    expect(within(sidebar).getByText('App.tsx')).toBeTruthy();
    expect(within(sidebar).getAllByText('+2').length).toBeGreaterThan(0);
    expect(within(sidebar).getAllByText('-1').length).toBeGreaterThan(0);
  });

  it('uses persisted changed-file collapse state for the active workspace scope', async () => {
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
      ],
      truncated: false,
    });
    setCodeAgentChangedFilesExpanded('room-1', 'ready:2026-07-01T00:00:00.000Z:branch:auto', false);

    render(
      <CodeAgentFileBrowserPanel
        roomId="room-1"
        projectName="Coco"
        sandboxStatus="ready"
        sandboxUpdatedAt="2026-07-01T00:00:00.000Z"
        workspaceChanges={{
          available: true,
          changedFiles: ['src/App.tsx'],
          changedFileStats: [{ path: 'src/App.tsx', additions: 2, deletions: 1 }],
          diffSummary: { files: 1, additions: 2, deletions: 1 },
        }}
      />
    );
    await screen.findByText('1 files');
    fireEvent.click(screen.getByLabelText('codeAgentAddWorkspaceSurface'));
    fireEvent.click(within(screen.getByTestId('code-agent-file-surface-add-menu')).getByText('codeAgentChanges'));

    const sidebar = await screen.findByTestId('code-agent-diff-changed-files-sidebar');
    expect(within(sidebar).getByText('codeAgentExpandChangedFileTree')).toBeTruthy();
    expect(within(sidebar).queryByText('App.tsx')).toBeNull();
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
    expect(screen.queryByLabelText('openMediaHistory')).toBeNull();
    expect(getRoomMediaHistoryMock).not.toHaveBeenCalled();

    const stage = screen.getByTestId('media-viewer-stage');
    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 320 });
    Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 520 });
    const fullScreenImage = document.body.querySelector('[data-testid="media-viewer-stage"] [data-active-media="true"] img') as HTMLElement | null;
    expect(fullScreenImage).toBeTruthy();
    fireEvent.doubleClick(stage, { clientX: 180, clientY: 220 });
    await waitFor(() => {
      expect(fullScreenImage?.style.transform).toContain('scale(2)');
    });

    fireEvent.click(within(fullScreenPreview).getByLabelText('close'));
    await waitFor(() => {
      expect(screen.queryByTestId('code-agent-image-fullscreen-preview')).toBeNull();
    });

    fireEvent.click(screen.getByLabelText('codeAgentOpenImagePreviewFullscreen:assets/logo.png'));
    fullScreenPreview = screen.getByTestId('code-agent-image-fullscreen-preview');
    expect(fullScreenPreview.getAttribute('aria-label')).toBe('codeAgentImagePreviewFullscreen:assets/logo.png');
    const swipeStage = screen.getByTestId('media-viewer-stage');
    Object.defineProperty(swipeStage, 'clientWidth', { configurable: true, value: 320 });
    Object.defineProperty(swipeStage, 'clientHeight', { configurable: true, value: 520 });
    fireEvent.pointerDown(swipeStage, { pointerId: 1, clientX: 180, clientY: 120 });
    fireEvent.pointerMove(swipeStage, { pointerId: 1, clientX: 184, clientY: 218 });
    fireEvent.pointerUp(swipeStage, { pointerId: 1, clientX: 184, clientY: 230 });
    await waitFor(() => {
      expect(screen.queryByTestId('code-agent-image-fullscreen-preview')).toBeNull();
    });

    fireEvent.click(screen.getByLabelText('codeAgentOpenImagePreviewFullscreen:assets/logo.png'));
    fullScreenPreview = screen.getByTestId('code-agent-image-fullscreen-preview');
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

  it('opens mobile browser preview files externally from the file header', async () => {
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
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);

    openCodeAgentRightPanelFile('room-1', 'output/report.html');
    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" surface="mobile" />);

    const mobileHeader = await screen.findByTestId('code-agent-mobile-file-preview-header');
    await waitFor(() => {
      expect(createCodeWorkspaceAssetUrlMock).toHaveBeenCalledWith('room-1', 'output/report.html', expect.any(Object));
    });
    const externalOpenButton = within(mobileHeader).getByLabelText('codeAgentOpenBrowserPreviewExternally') as HTMLButtonElement;
    expect(externalOpenButton.disabled).toBe(false);
    expect(externalOpenButton.className).toContain('h-8');
    expect(externalOpenButton.className).toContain('w-8');

    fireEvent.click(externalOpenButton);
    expect(open).toHaveBeenCalledWith('/api/coco/workspace-assets/token/report.html', '_blank', 'noopener,noreferrer');

    fireEvent.click(within(mobileHeader).getByLabelText('codeAgentShowSource'));
    expect(await screen.findByTestId('diff-file')).toBeTruthy();
    const sourceModeExternalOpenButton = within(mobileHeader).getByLabelText('codeAgentOpenBrowserPreviewExternally') as HTMLButtonElement;
    expect(sourceModeExternalOpenButton.disabled).toBe(false);

    fireEvent.click(sourceModeExternalOpenButton);
    expect(open).toHaveBeenCalledTimes(2);
    expect(createCodeWorkspaceAssetUrlMock).toHaveBeenCalledTimes(1);
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
    const copyPathButton = screen.getByTestId('code-agent-file-copy-path-button');
    expect(copyPathButton.className).toContain('p-1.5');
    expect(copyPathButton.className).not.toContain('h-8');
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

  it('scopes remote workspace search matches to the current sandbox', async () => {
    const nextSearch = deferred<{
      entries: { path: string; name: string; type: 'file' }[];
      truncated: boolean;
    }>();
    loadCodeWorkspaceEntriesMock
      .mockResolvedValueOnce({
        entries: [
          { path: 'README.md', name: 'README.md', type: 'file' },
        ],
        truncated: true,
      })
      .mockResolvedValueOnce({
        entries: [
          { path: 'package.json', name: 'package.json', type: 'file' },
        ],
        truncated: true,
      });
    searchCodeWorkspaceEntriesMock
      .mockResolvedValueOnce({
        entries: [
          { path: 'old/components/Composer.tsx', name: 'Composer.tsx', type: 'file' },
        ],
        truncated: false,
      })
      .mockReturnValueOnce(nextSearch.promise);
    fileTreeSearchStateRef.current = { isOpen: true, value: 'cmp' };

    const { rerender } = render(
      <CodeAgentFileBrowserPanel
        roomId="room-1"
        projectName="Coco"
        sandboxStatus="ready"
        sandboxUpdatedAt="2026-06-30T10:00:00.000Z"
      />,
    );

    await waitFor(() => {
      expect(resetPathsMock).toHaveBeenLastCalledWith([
        'old/',
        'old/components/',
        'old/components/Composer.tsx',
        'README.md',
      ]);
    });

    rerender(
      <CodeAgentFileBrowserPanel
        roomId="room-1"
        projectName="Coco"
        sandboxStatus="ready"
        sandboxUpdatedAt="2026-06-30T10:01:00.000Z"
      />,
    );

    await waitFor(() => {
      expect(resetPathsMock).toHaveBeenLastCalledWith(['package.json']);
    });
    expect(resetPathsMock).not.toHaveBeenLastCalledWith(expect.arrayContaining(['old/components/Composer.tsx']));
    await waitFor(() => {
      expect(searchCodeWorkspaceEntriesMock).toHaveBeenCalledTimes(2);
    });

    act(() => {
      nextSearch.resolve({
        entries: [
          { path: 'new/components/Composer.tsx', name: 'Composer.tsx', type: 'file' },
        ],
        truncated: false,
      });
    });

    await waitFor(() => {
      expect(resetPathsMock).toHaveBeenLastCalledWith([
        'new/',
        'new/components/',
        'new/components/Composer.tsx',
        'package.json',
      ]);
    });
  });

  it('keeps restored file surfaces while workspace entries are still loading', async () => {
    openCodeAgentRightPanelFile('room-1', 'src/App.tsx');
    loadCodeWorkspaceEntriesMock.mockReturnValue(new Promise(() => {}));
    loadCodeWorkspaceFileMock.mockReturnValue(new Promise(() => {}));

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    await waitFor(() => {
      expect(loadCodeWorkspaceEntriesMock).toHaveBeenCalledTimes(1);
    });
    expect(readCodeAgentRightPanelState('room-1').surfaces.map((surface) => surface.id)).toEqual([
      'file:src/App.tsx',
    ]);
  });

  it('reconciles restored file surfaces when the workspace is unavailable', async () => {
    openCodeAgentRightPanelFile('room-1', 'src/App.tsx');
    openCodeAgentRightPanelPreview('room-1', 'output/report.html');
    openCodeAgentRightPanel('room-1', 'diff');
    loadCodeWorkspaceEntriesMock.mockRejectedValue(new Error('Workspace sandbox is not ready'));
    loadCodeWorkspaceFileMock.mockReturnValue(new Promise(() => {}));

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    await waitFor(() => {
      expect(readCodeAgentRightPanelState('room-1')).toMatchObject({
        isOpen: true,
        activeSurfaceId: 'diff',
        surfaces: [{ id: 'diff', kind: 'diff' }],
      });
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

  it('scopes open file contents to the current sandbox refresh', async () => {
    const nextFile = deferred<{
      path: string;
      content: string;
      byteSize: number;
      truncated: boolean;
      encoding: 'utf-8';
    }>();
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock
      .mockResolvedValueOnce({
        path: 'src/App.tsx',
        content: 'old sandbox content',
        byteSize: 19,
        truncated: false,
        encoding: 'utf-8',
      })
      .mockReturnValueOnce(nextFile.promise);

    const { rerender } = render(
      <CodeAgentFileBrowserPanel
        roomId="room-1"
        projectName="Coco"
        sandboxStatus="ready"
        sandboxUpdatedAt="2026-06-30T10:00:00.000Z"
      />,
    );

    expect(await screen.findByText('1 files')).toBeTruthy();
    selectionHandlerRef.current?.(['src/App.tsx']);
    expect((await screen.findByTestId('diff-file')).textContent).toBe('src/App.tsx:old sandbox content');

    rerender(
      <CodeAgentFileBrowserPanel
        roomId="room-1"
        projectName="Coco"
        sandboxStatus="ready"
        sandboxUpdatedAt="2026-06-30T10:01:00.000Z"
      />,
    );

    await waitFor(() => {
      expect(loadCodeWorkspaceFileMock).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByTestId('diff-file')).toBeNull();

    await act(async () => {
      nextFile.resolve({
        path: 'src/App.tsx',
        content: 'new sandbox content',
        byteSize: 19,
        truncated: false,
        encoding: 'utf-8',
      });
    });

    expect((await screen.findByTestId('diff-file')).textContent).toBe('src/App.tsx:new sandbox content');
  });

  it('does not carry optimistic file edits into a refreshed sandbox', async () => {
    const nextFile = deferred<{
      path: string;
      content: string;
      byteSize: number;
      truncated: boolean;
      encoding: 'utf-8';
    }>();
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'src/App.tsx', name: 'App.tsx', type: 'file' },
      ],
      truncated: false,
    });
    loadCodeWorkspaceFileMock
      .mockResolvedValueOnce({
        path: 'src/App.tsx',
        content: 'old sandbox content',
        byteSize: 19,
        truncated: false,
        encoding: 'utf-8',
      })
      .mockReturnValueOnce(nextFile.promise);

    const { rerender } = render(
      <CodeAgentFileBrowserPanel
        roomId="room-1"
        projectName="Coco"
        sandboxStatus="ready"
        sandboxUpdatedAt="2026-06-30T10:00:00.000Z"
      />,
    );

    expect(await screen.findByText('1 files')).toBeTruthy();
    selectionHandlerRef.current?.(['src/App.tsx']);
    expect((await screen.findByTestId('diff-file')).textContent).toBe('src/App.tsx:old sandbox content');

    nextEditorContentsRef.current = 'optimistic old sandbox edit';
    fireEvent.click(screen.getByTestId('diff-file'));
    expect(screen.getByTestId('diff-file').textContent).toBe('src/App.tsx:optimistic old sandbox edit');

    rerender(
      <CodeAgentFileBrowserPanel
        roomId="room-1"
        projectName="Coco"
        sandboxStatus="ready"
        sandboxUpdatedAt="2026-06-30T10:01:00.000Z"
      />,
    );

    await waitFor(() => {
      expect(loadCodeWorkspaceFileMock).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByTestId('diff-file')).toBeNull();

    await act(async () => {
      nextFile.resolve({
        path: 'src/App.tsx',
        content: 'new sandbox content',
        byteSize: 19,
        truncated: false,
        encoding: 'utf-8',
      });
    });

    expect((await screen.findByTestId('diff-file')).textContent).toBe('src/App.tsx:new sandbox content');
  });

  it('scopes workspace asset preview URLs to the current sandbox refresh', async () => {
    const nextAsset = deferred<{
      relativeUrl: string;
      expiresAt: string;
    }>();
    loadCodeWorkspaceEntriesMock.mockResolvedValue({
      entries: [
        { path: 'output/report.html', name: 'report.html', type: 'file' },
      ],
      truncated: false,
    });
    createCodeWorkspaceAssetUrlMock
      .mockResolvedValueOnce({
        relativeUrl: '/api/coco/workspace-assets/old/report.html',
        expiresAt: '2026-06-30T12:15:00.000Z',
      })
      .mockReturnValueOnce(nextAsset.promise);
    resolveCodeWorkspaceAssetUrlMock.mockImplementation((asset: { relativeUrl: string }) => asset.relativeUrl);

    const { container, rerender } = render(
      <CodeAgentFileBrowserPanel
        roomId="room-1"
        projectName="Coco"
        sandboxStatus="ready"
        sandboxUpdatedAt="2026-06-30T10:00:00.000Z"
      />,
    );

    expect(await screen.findByText('1 files')).toBeTruthy();
    selectionHandlerRef.current?.(['output/report.html']);
    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('/api/coco/workspace-assets/old/report.html');
    });

    rerender(
      <CodeAgentFileBrowserPanel
        roomId="room-1"
        projectName="Coco"
        sandboxStatus="ready"
        sandboxUpdatedAt="2026-06-30T10:01:00.000Z"
      />,
    );

    await waitFor(() => {
      expect(createCodeWorkspaceAssetUrlMock).toHaveBeenCalledTimes(2);
    });
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByRole('status', { name: 'codeAgentPreparingBrowserPreview' })).toBeTruthy();

    await act(async () => {
      nextAsset.resolve({
        relativeUrl: '/api/coco/workspace-assets/new/report.html',
        expiresAt: '2026-06-30T12:16:00.000Z',
      });
    });

    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('/api/coco/workspace-assets/new/report.html');
    });
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

  it('uses a mobile selection action bar before opening a file comment draft', async () => {
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
    openCodeAgentRightPanelFile('room-1', 'src/App.tsx');

    const onAddReviewComment = vi.fn();
    render(
      <CodeAgentFileBrowserPanel
        roomId="room-1"
        projectName="Coco"
        surface="mobile"
        onAddReviewComment={onAddReviewComment}
      />,
    );
    expect((await screen.findByTestId('diff-file')).textContent).toBe('src/App.tsx:line 1\nline 2\nline 3\nline 4');

    fireEvent.click(screen.getByLabelText('select-lines'));

    const actionBar = await screen.findByTestId('code-agent-mobile-review-selection-action-bar');
    expect(actionBar.className).toContain('absolute');
    expect(actionBar.className).toContain('bottom-3');
    expect(screen.queryByLabelText('codeAgentCommentOnLines:L2 to L4')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'codeAgentCommentOnLines:L2 to L4' }));

    const mobileCommentSheet = await screen.findByTestId('code-agent-mobile-review-comment-sheet');
    expect(mobileCommentSheet.dataset.mobileCommentAnnotation).toBe('true');
    expect(within(mobileCommentSheet).getByText('src/App.tsx')).toBeTruthy();
    const selectionPreview = within(mobileCommentSheet).getByTestId('code-agent-mobile-review-comment-preview');
    expect(selectionPreview.className).toContain('overflow-auto');
    expect(within(selectionPreview).getByText('line 2')).toBeTruthy();
    expect(within(selectionPreview).getByText('line 3')).toBeTruthy();
    expect(within(selectionPreview).getByText('line 4')).toBeTruthy();
    expect(Array.from(selectionPreview.querySelectorAll('[data-review-comment-preview-line]')).map((row) => row.getAttribute('data-change'))).toEqual(['source', 'source', 'source']);
    const mobileCommentInput = within(mobileCommentSheet).getByTestId('code-agent-mobile-review-comment-textarea');
    expect(mobileCommentInput.className).toContain('min-h-[132px]');
    expect(within(mobileCommentSheet).getByRole('button', { name: 'codeAgentSubmitComment' }).className).toContain('min-h-11');
    const input = await screen.findByLabelText('codeAgentCommentOnLines:L2 to L4');
    fireEvent.change(input, { target: { value: 'Please adjust this range.' } });
    fireEvent.click(screen.getByRole('button', { name: 'codeAgentSubmitComment' }));

    expect(onAddReviewComment).toHaveBeenCalledWith(expect.objectContaining({
      filePath: 'src/App.tsx',
      rangeLabel: 'L2 to L4',
      text: 'Please adjust this range.',
      diff: 'line 2\nline 3\nline 4',
      fenceLanguage: 'tsx',
    }));
    expect(screen.queryByTestId('code-agent-mobile-review-selection-action-bar')).toBeNull();
  });

  it('clears a mobile file comment selection without opening a draft', async () => {
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
    openCodeAgentRightPanelFile('room-1', 'src/App.tsx');

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" surface="mobile" />);
    await screen.findByTestId('diff-file');

    fireEvent.click(screen.getByLabelText('select-lines'));
    expect(await screen.findByTestId('code-agent-mobile-review-selection-action-bar')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('codeAgentCancelComment'));

    expect(screen.queryByTestId('code-agent-mobile-review-selection-action-bar')).toBeNull();
    expect(screen.queryByLabelText('codeAgentCommentOnLines:L2 to L4')).toBeNull();
  });

  it('restores persisted file review comments into the active file preview', async () => {
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

    const reviewComment = {
      id: 'comment-1',
      sectionId: 'file:src/App.tsx',
      sectionTitle: 'File comment',
      filePath: 'src/App.tsx',
      startIndex: 1,
      endIndex: 3,
      rangeLabel: 'L2 to L4',
      text: 'Persisted file note.',
      diff: 'line 2\nline 3\nline 4',
      fenceLanguage: 'tsx',
    };
    const { rerender } = render(
      <CodeAgentFileBrowserPanel
        roomId="room-1"
        projectName="Coco"
        reviewComments={[reviewComment]}
      />,
    );
    await screen.findByText('1 files');
    fireEvent.click(screen.getByLabelText('Coco files'));
    expect((await screen.findByTestId('diff-file')).textContent).toBe('src/App.tsx:line 1\nline 2\nline 3\nline 4');

    expect(await screen.findByText('Persisted file note.')).toBeTruthy();
    expect(screen.getByText('L2 to L4')).toBeTruthy();

    rerender(
      <CodeAgentFileBrowserPanel
        roomId="room-1"
        projectName="Coco"
        reviewComments={[]}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText('Persisted file note.')).toBeNull();
    });
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
    expect(getOptimisticCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', 'none:')?.content).toBe(
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
    expect(getOptimisticCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', 'none:')).toBeNull();
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
