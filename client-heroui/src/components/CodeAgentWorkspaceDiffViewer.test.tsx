// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
  CodeView: ({ items }: { items: Array<{ id: string; fileDiff: { name: string } }> }) => (
    <div data-testid="code-view">
      {items.map((item) => (
        <span key={item.id}>{item.fileDiff.name}</span>
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
  });

  it('does not request the patch until the changes tab enables it', async () => {
    render(<CodeAgentWorkspaceDiffViewer roomId="room-1" enabled={false} />);

    await waitFor(() => {
      expect(loadCodeAgentWorkspaceDiffMock).not.toHaveBeenCalled();
    });
    expect(screen.queryByTestId('code-view')).toBeNull();
  });
});
