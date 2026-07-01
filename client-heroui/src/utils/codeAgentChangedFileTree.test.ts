import { describe, expect, it } from 'vitest';
import {
  buildCodeAgentChangedFileTree,
  formatCompactDiffCount,
  summarizeCodeAgentChangedFileStats,
} from './codeAgentChangedFileTree';

describe('buildCodeAgentChangedFileTree', () => {
  it('builds nested directory nodes with aggregated stats', () => {
    expect(buildCodeAgentChangedFileTree([
      { path: 'src/index.ts', additions: 2, deletions: 1 },
      { path: 'src/components/Button.tsx', additions: 4, deletions: 2 },
      { path: 'README.md', additions: 1, deletions: 0 },
    ])).toEqual([
      {
        kind: 'directory',
        name: 'src',
        path: 'src',
        stat: { additions: 6, deletions: 3 },
        children: [
          {
            kind: 'directory',
            name: 'components',
            path: 'src/components',
            stat: { additions: 4, deletions: 2 },
            children: [
              {
                kind: 'file',
                name: 'Button.tsx',
                path: 'src/components/Button.tsx',
                stat: { additions: 4, deletions: 2 },
              },
            ],
          },
          {
            kind: 'file',
            name: 'index.ts',
            path: 'src/index.ts',
            stat: { additions: 2, deletions: 1 },
          },
        ],
      },
      {
        kind: 'file',
        name: 'README.md',
        path: 'README.md',
        stat: { additions: 1, deletions: 0 },
      },
    ]);
  });

  it('compacts single-directory chains and normalizes path separators', () => {
    expect(buildCodeAgentChangedFileTree([
      { path: 'apps\\web\\src\\index.ts' },
      { path: 'apps/web/src/main.ts' },
    ])).toEqual([
      {
        kind: 'directory',
        name: 'apps/web/src',
        path: 'apps/web/src',
        stat: { additions: 0, deletions: 0 },
        children: [
          { kind: 'file', name: 'index.ts', path: 'apps/web/src/index.ts', stat: null },
          { kind: 'file', name: 'main.ts', path: 'apps/web/src/main.ts', stat: null },
        ],
      },
    ]);
  });

  it('keeps zero-valued file stats and includes only their numeric contribution', () => {
    expect(buildCodeAgentChangedFileTree([
      { path: 'docs/notes.md', additions: 0, deletions: 0 },
      { path: 'docs/todo.md', additions: 1, deletions: 1 },
    ])).toEqual([
      {
        kind: 'directory',
        name: 'docs',
        path: 'docs',
        stat: { additions: 1, deletions: 1 },
        children: [
          {
            kind: 'file',
            name: 'notes.md',
            path: 'docs/notes.md',
            stat: { additions: 0, deletions: 0 },
          },
          {
            kind: 'file',
            name: 'todo.md',
            path: 'docs/todo.md',
            stat: { additions: 1, deletions: 1 },
          },
        ],
      },
    ]);
  });

  it('compacts only single-directory chains and stops at branch points', () => {
    expect(buildCodeAgentChangedFileTree([
      { path: 'apps/server/src/index.ts', additions: 2, deletions: 1 },
      { path: 'apps/server/main.ts', additions: 4, deletions: 0 },
    ])).toEqual([
      {
        kind: 'directory',
        name: 'apps/server',
        path: 'apps/server',
        stat: { additions: 6, deletions: 1 },
        children: [
          {
            kind: 'directory',
            name: 'src',
            path: 'apps/server/src',
            stat: { additions: 2, deletions: 1 },
            children: [
              {
                kind: 'file',
                name: 'index.ts',
                path: 'apps/server/src/index.ts',
                stat: { additions: 2, deletions: 1 },
              },
            ],
          },
          {
            kind: 'file',
            name: 'main.ts',
            path: 'apps/server/main.ts',
            stat: { additions: 4, deletions: 0 },
          },
        ],
      },
    ]);
  });

  it('preserves leading/trailing whitespace in path segments', () => {
    const tree = buildCodeAgentChangedFileTree([
      { path: 'a/file.ts', additions: 1, deletions: 0 },
      { path: ' a/file.ts', additions: 2, deletions: 0 },
    ]);

    expect(tree).toHaveLength(2);
    const directoryNodes = tree.filter(
      (node): node is Extract<(typeof tree)[number], { kind: 'directory' }> => node.kind === 'directory',
    );
    expect(directoryNodes.map((node) => node.name).sort()).toEqual([' a', 'a']);
    expect(directoryNodes.map((node) => node.path).sort()).toEqual([' a', 'a']);
  });
});

describe('formatCompactDiffCount', () => {
  it('formats large diff counts like T3', () => {
    expect(formatCompactDiffCount(999)).toBe('999');
    expect(formatCompactDiffCount(1_200)).toBe('1.2k');
    expect(formatCompactDiffCount(12_400)).toBe('12k');
    expect(formatCompactDiffCount(1_250_000)).toBe('1.3m');
  });
});

describe('summarizeCodeAgentChangedFileStats', () => {
  it('summarizes changed-file stats like T3', () => {
    expect(summarizeCodeAgentChangedFileStats([
      { path: 'src/App.tsx', additions: 7, deletions: 3 },
      { path: 'src/empty.ts' },
      { path: 'docs/Guide.md', additions: 2, deletions: 0 },
    ])).toEqual({ additions: 9, deletions: 3 });
  });
});
