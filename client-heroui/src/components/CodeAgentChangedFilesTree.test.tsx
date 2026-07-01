// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeAgentChangedFilesTree } from './CodeAgentChangedFilesTree';

describe('CodeAgentChangedFilesTree', () => {
  afterEach(() => {
    cleanup();
    document.getElementById('roomtalk-pierre-file-icon-sprite')?.remove();
  });

  it('renders compacted directories collapsed by default', () => {
    render(
      <CodeAgentChangedFilesTree
        files={[
          { path: 'apps/web/src/index.ts' },
          { path: 'apps/web/src/main.ts' },
        ]}
        allDirectoriesExpanded={false}
        resolvedTheme="light"
        onOpenDiffFile={vi.fn()}
      />,
    );

    expect(screen.getByText('apps/web/src')).toBeTruthy();
    expect(screen.queryByText('index.ts')).toBeNull();
    expect(screen.queryByText('main.ts')).toBeNull();
  });

  it('expands directories and opens selected files', () => {
    const onOpenDiffFile = vi.fn();

    render(
      <CodeAgentChangedFilesTree
        files={[
          { path: 'apps/web/src/index.ts', additions: 2, deletions: 1 },
          { path: 'apps/web/src/main.ts', additions: 3, deletions: 0 },
        ]}
        allDirectoriesExpanded
        resolvedTheme="dark"
        selectedPath="apps/web/src/main.ts"
        onOpenDiffFile={onOpenDiffFile}
      />,
    );

    expect(screen.getByText('apps/web/src')).toBeTruthy();
    expect(screen.getByText('index.ts')).toBeTruthy();
    expect(screen.getByText('main.ts')).toBeTruthy();
    expect(screen.getAllByText(/\+\d/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText('main.ts'));

    expect(onOpenDiffFile).toHaveBeenCalledWith('apps/web/src/main.ts');
  });

  it('uses T3 Pierre file icons for changed files', () => {
    render(
      <CodeAgentChangedFilesTree
        files={[
          { path: 'package.json', additions: 1, deletions: 0 },
        ]}
        allDirectoriesExpanded
        resolvedTheme="light"
        onOpenDiffFile={vi.fn()}
      />,
    );

    expect(screen.getByText('package.json')).toBeTruthy();
    expect(document.querySelector('[data-pierre-icon="t3-file-icon-package-json"]')).toBeTruthy();
    expect(document.getElementById('roomtalk-pierre-file-icon-sprite')).toBeTruthy();
  });
});
