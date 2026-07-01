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
