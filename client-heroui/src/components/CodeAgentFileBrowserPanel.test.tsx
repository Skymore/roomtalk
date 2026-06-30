// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeAgentFileBrowserPanel } from './CodeAgentFileBrowserPanel';

const loadCodeWorkspaceEntriesMock = vi.hoisted(() => vi.fn());
const loadCodeWorkspaceFileMock = vi.hoisted(() => vi.fn());
const openSearchMock = vi.hoisted(() => vi.fn());
const resetPathsMock = vi.hoisted(() => vi.fn());
const selectionHandlerRef = vi.hoisted(() => ({ current: null as null | ((paths: readonly string[]) => void) }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../utils/codeWorkspaceFiles', () => ({
  loadCodeWorkspaceEntries: loadCodeWorkspaceEntriesMock,
  loadCodeWorkspaceFile: loadCodeWorkspaceFileMock,
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
  FileTree: ({ 'aria-label': ariaLabel }: { 'aria-label': string }) => (
    <button type="button" aria-label={ariaLabel} onClick={() => selectionHandlerRef.current?.(['src/App.tsx'])}>
      file-tree
    </button>
  ),
}));

describe('CodeAgentFileBrowserPanel', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    loadCodeWorkspaceEntriesMock.mockReset();
    loadCodeWorkspaceFileMock.mockReset();
    openSearchMock.mockReset();
    resetPathsMock.mockReset();
    selectionHandlerRef.current = null;
  });

  it('renders T3-style file tree controls and opens selected files through the workspace API', async () => {
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
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:workspace-file');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);

    render(<CodeAgentFileBrowserPanel roomId="room-1" projectName="Coco" />);

    expect(await screen.findByText('1 files')).toBeTruthy();
    await waitFor(() => {
      expect(resetPathsMock).toHaveBeenCalledWith(['src/', 'src/App.tsx']);
    });

    fireEvent.click(screen.getByLabelText('codeAgentSearchWorkspaceFiles'));
    expect(openSearchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('codeAgentRefreshWorkspaceFiles'));
    await waitFor(() => {
      expect(loadCodeWorkspaceEntriesMock).toHaveBeenCalledTimes(2);
    });

    fireEvent.click(screen.getByLabelText('Coco files'));
    await waitFor(() => {
      expect(loadCodeWorkspaceFileMock).toHaveBeenCalledWith('room-1', 'src/App.tsx');
      expect(createObjectURL).toHaveBeenCalled();
      expect(open).toHaveBeenCalledWith('blob:workspace-file', '_blank', 'noopener,noreferrer');
    });
  });
});
