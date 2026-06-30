// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeAgentFileBrowserPanel } from './CodeAgentFileBrowserPanel';

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
const selectionHandlerRef = vi.hoisted(() => ({ current: null as null | ((paths: readonly string[]) => void) }));
const fileTreeSelectionPathRef = vi.hoisted(() => ({ current: 'src/App.tsx' }));
const fileTreeSearchStateRef = vi.hoisted(() => ({
  current: { isOpen: false, value: '' },
}));
const editorOptionsRef = vi.hoisted(() => ({ current: null as null | { onChange?: (file: { name: string; contents: string }) => void } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (
      params?.path ? `${key}:${params.path}` : key
    ),
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
  }: {
    content: string;
    onTaskListChange?: (change: { markerOffset: number; checked: boolean }) => void;
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
    constructor(options: { onChange?: (file: { name: string; contents: string }) => void }) {
      editorOptionsRef.current = options;
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
  }: {
    file: { name: string; contents: string };
    options: { overflow?: 'scroll' | 'wrap' };
  }) => (
    <button
      type="button"
      data-testid="diff-file"
      data-overflow={options.overflow}
      onClick={() => editorOptionsRef.current?.onChange?.({ ...file, contents: 'export const changed = true;' })}
    >
      {file.name}:{file.contents}
    </button>
  ),
}));

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
    selectionHandlerRef.current = null;
    fileTreeSelectionPathRef.current = 'src/App.tsx';
    fileTreeSearchStateRef.current = { isOpen: false, value: '' };
    editorOptionsRef.current = null;
    localStorage.clear();
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
    expect((await screen.findByTestId('diff-file')).textContent).toBe('src/App.tsx:export default function App() {}');
    expect(loadCodeWorkspaceFileMock).toHaveBeenCalledWith('room-1', 'src/App.tsx', expect.any(Object));
    const explorerResizeHandle = screen.getByLabelText('codeAgentResizeFileExplorer');
    const explorer = explorerResizeHandle.closest('aside') as HTMLElement;
    expect(explorer.style.width).toBe('var(--workspace-file-explorer-width)');
    expect(explorer.style.maxWidth).toBe('calc(100% - 180px)');
    expect(explorer.className).not.toContain('50%');
    expect(open).not.toHaveBeenCalled();
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

  it('uses a signed workspace-file asset URL for HTML previews', async () => {
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
      expect(createCodeWorkspaceAssetUrlMock).toHaveBeenCalledWith('room-1', 'output/report.html', expect.any(Object));
    });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement | null;
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute('src')).toBe('/api/coco/workspace-assets/token/report.html');
    expect(loadCodeWorkspaceFileMock).not.toHaveBeenCalled();
  });

  it('opens T3-style browser preview files in a new tab through the signed asset URL', async () => {
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
    const previewWindow = {
      closed: false,
      close: vi.fn(),
      location: { href: 'about:blank' },
      opener: window,
    } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(previewWindow);

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    expect(await screen.findByText('1 files')).toBeTruthy();
    selectionHandlerRef.current?.(['output/report.html']);
    await waitFor(() => {
      expect(createCodeWorkspaceAssetUrlMock).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByLabelText('codeAgentOpenFileInPreview'));

    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(previewWindow.location.href).toBe('/api/coco/workspace-assets/token/report.html');
    expect(createCodeWorkspaceAssetUrlMock).toHaveBeenCalledTimes(1);
  });

  it('opens a requested workspace file from an external diff action', async () => {
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

    expect(await screen.findByText(/^2 files/)).toBeTruthy();
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
    expect(screen.getByText(/Preview limited to 11 of 2,000,000 bytes/)).toBeTruthy();

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
