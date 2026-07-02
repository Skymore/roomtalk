// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
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
    expect(screen.getByText('apps/web/src').closest('button')?.hasAttribute('data-scroll-anchor-ignore')).toBe(true);
    expect(screen.queryByText('index.ts')).toBeNull();
    expect(screen.queryByText('main.ts')).toBeNull();
  });

  it.each([
    {
      name: 'a compacted single-chain directory',
      files: [
        { path: 'apps/web/src/index.ts', additions: 2, deletions: 1 },
        { path: 'apps/web/src/main.ts', additions: 3, deletions: 0 },
      ],
      visibleLabels: ['apps/web/src'],
      hiddenLabels: ['index.ts', 'main.ts'],
    },
    {
      name: 'a branch point after a compacted prefix',
      files: [
        {
          path: 'apps/server/src/git/Layers/GitCore.ts',
          additions: 4,
          deletions: 3,
        },
        {
          path: 'apps/server/src/provider/Layers/CodexAdapter.ts',
          additions: 7,
          deletions: 2,
        },
      ],
      visibleLabels: ['apps/server/src'],
      hiddenLabels: ['git', 'provider', 'GitCore.ts', 'CodexAdapter.ts'],
    },
    {
      name: 'mixed root files and nested compacted directories',
      files: [
        { path: 'README.md', additions: 1, deletions: 0 },
        { path: 'packages/shared/src/git.ts', additions: 8, deletions: 2 },
        {
          path: 'packages/contracts/src/orchestration.ts',
          additions: 13,
          deletions: 3,
        },
      ],
      visibleLabels: ['README.md', 'packages'],
      hiddenLabels: ['shared/src', 'contracts/src', 'git.ts', 'orchestration.ts'],
    },
  ])('renders $name collapsed on the first render when collapse-all is active', ({
    files,
    visibleLabels,
    hiddenLabels,
  }) => {
    const markup = renderToStaticMarkup(
      <CodeAgentChangedFilesTree
        files={files}
        allDirectoriesExpanded={false}
        resolvedTheme="light"
        onOpenDiffFile={vi.fn()}
      />,
    );

    for (const label of visibleLabels) {
      expect(markup).toContain(label);
    }
    for (const label of hiddenLabels) {
      expect(markup).not.toContain(label);
    }
  });

  it.each([
    {
      name: 'a compacted single-chain directory',
      files: [
        { path: 'apps/web/src/index.ts', additions: 2, deletions: 1 },
        { path: 'apps/web/src/main.ts', additions: 3, deletions: 0 },
      ],
      visibleLabels: ['apps/web/src', 'index.ts', 'main.ts'],
    },
    {
      name: 'a branch point after a compacted prefix',
      files: [
        {
          path: 'apps/server/src/git/Layers/GitCore.ts',
          additions: 4,
          deletions: 3,
        },
        {
          path: 'apps/server/src/provider/Layers/CodexAdapter.ts',
          additions: 7,
          deletions: 2,
        },
      ],
      visibleLabels: [
        'apps/server/src',
        'git/Layers',
        'provider/Layers',
        'GitCore.ts',
        'CodexAdapter.ts',
      ],
    },
    {
      name: 'mixed root files and nested compacted directories',
      files: [
        { path: 'README.md', additions: 1, deletions: 0 },
        { path: 'packages/shared/src/git.ts', additions: 8, deletions: 2 },
        {
          path: 'packages/contracts/src/orchestration.ts',
          additions: 13,
          deletions: 3,
        },
      ],
      visibleLabels: [
        'README.md',
        'packages',
        'shared/src',
        'contracts/src',
        'git.ts',
        'orchestration.ts',
      ],
    },
  ])('renders $name expanded on the first render when expand-all is active', ({
    files,
    visibleLabels,
  }) => {
    const markup = renderToStaticMarkup(
      <CodeAgentChangedFilesTree
        files={files}
        allDirectoriesExpanded
        resolvedTheme="light"
        onOpenDiffFile={vi.fn()}
      />,
    );

    for (const label of visibleLabels) {
      expect(markup).toContain(label);
    }
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

  it('expands ancestor directories and scrolls the selected diff file into view', async () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    render(
      <CodeAgentChangedFilesTree
        files={[
          { path: 'apps/web/src/index.ts', additions: 2, deletions: 1 },
          { path: 'apps/web/src/main.ts', additions: 3, deletions: 0 },
        ]}
        allDirectoriesExpanded={false}
        resolvedTheme="light"
        selectedPath="apps/web/src/main.ts"
        onOpenDiffFile={vi.fn()}
      />,
    );

    const selected = await screen.findByText('main.ts');
    expect(selected.closest('button')?.getAttribute('aria-current')).toBe('true');
    expect(screen.getByText('index.ts')).toBeTruthy();

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    });

    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: originalScrollIntoView,
    });
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
