import { describe, expect, it } from 'vitest';
import {
  buildCodeAgentMobileFileTree,
  codeAgentMobileAncestorPaths,
  codeAgentMobileFileTreePath,
  countCodeAgentMobileFileNodes,
  defaultExpandedCodeAgentMobileTreePaths,
  firstCodeAgentMobileFilePath,
  flattenCodeAgentMobileFileTree,
  normalizeCodeAgentMobileSearchQuery,
  scoreCodeAgentMobileQueryMatch,
  scoreCodeAgentMobileSubsequenceMatch,
  type CodeAgentMobileFileTreeEntry,
} from './codeAgentMobileFileTree';

const entries = [
  { kind: 'file', path: 'README.md' },
  { kind: 'directory', path: 'src' },
  { kind: 'file', path: 'src/index.ts' },
  { kind: 'file', path: 'src/components/App.tsx' },
  { kind: 'file', path: 'package.json' },
] satisfies ReadonlyArray<CodeAgentMobileFileTreeEntry>;

describe('codeAgentMobileFileTree', () => {
  it('builds a deterministic hierarchy with directories before files', () => {
    const tree = buildCodeAgentMobileFileTree(entries);

    expect(tree.map((node) => `${node.kind}:${node.path}`)).toEqual([
      'directory:src',
      'file:package.json',
      'file:README.md',
    ]);
    expect(tree[0]?.children.map((node) => `${node.kind}:${node.path}`)).toEqual([
      'directory:src/components',
      'file:src/index.ts',
    ]);
    expect(countCodeAgentMobileFileNodes(tree)).toBe(4);
    expect(firstCodeAgentMobileFilePath(tree)).toBe('src/components/App.tsx');
  });

  it('flattens expanded directories and hides collapsed descendants', () => {
    const tree = buildCodeAgentMobileFileTree(entries);

    expect(
      flattenCodeAgentMobileFileTree({
        nodes: tree,
        expanded: new Set(['src']),
      }).map((item) => `${item.depth}:${item.node.path}`),
    ).toEqual(['0:src', '1:src/components', '1:src/index.ts', '0:package.json', '0:README.md']);

    expect(
      flattenCodeAgentMobileFileTree({
        nodes: tree,
        expanded: new Set(),
      }).map((item) => item.node.path),
    ).toEqual(['src', 'package.json', 'README.md']);
  });

  it('includes matching descendants and their ancestors during search', () => {
    const tree = buildCodeAgentMobileFileTree(entries);

    expect(
      flattenCodeAgentMobileFileTree({
        nodes: tree,
        expanded: new Set(),
        searchQuery: 'app',
      }).map((item) => item.node.path),
    ).toEqual(['src', 'src/components', 'src/components/App.tsx']);
  });

  it('supports fuzzy, whitespace-separated path queries', () => {
    const tree = buildCodeAgentMobileFileTree([
      {
        kind: 'file',
        path: '.plans/19-version-control-phase-1-vcs-driver-foundation.md',
      },
      {
        kind: 'file',
        path: '.repos/alchemy-effect/examples/aws-lambda/src/JobNotifications.ts',
      },
      { kind: 'directory', path: 'apps/web/src/components/chat' },
      { kind: 'file', path: 'apps/web/src/components/chat/ChatHeader.test.ts' },
      { kind: 'file', path: 'apps/web/src/components/chat/ChatHeader.tsx' },
      { kind: 'file', path: 'apps/web/src/components/chat/Composer.tsx' },
    ]);

    const expectedPaths = [
      'apps',
      'apps/web',
      'apps/web/src',
      'apps/web/src/components',
      'apps/web/src/components/chat',
      'apps/web/src/components/chat/ChatHeader.test.ts',
      'apps/web/src/components/chat/ChatHeader.tsx',
    ];

    for (const searchQuery of ['chat hea', 'cht hdr']) {
      expect(
        flattenCodeAgentMobileFileTree({
          nodes: tree,
          expanded: new Set(),
          searchQuery,
        }).map((item) => item.node.path),
      ).toEqual(expectedPaths);
    }
  });

  it('expands top-level directories by default', () => {
    const tree = buildCodeAgentMobileFileTree(entries);

    expect([...defaultExpandedCodeAgentMobileTreePaths(tree)]).toEqual(['src']);
  });

  it('normalizes and scores mobile file tree searches', () => {
    expect(normalizeCodeAgentMobileSearchQuery('  UI  ')).toBe('ui');
    expect(scoreCodeAgentMobileSubsequenceMatch('ghfixci', 'gfc')).toBeLessThan(
      scoreCodeAgentMobileSubsequenceMatch('github-fix-ci', 'gfc') ?? Number.POSITIVE_INFINITY,
    );
    expect(scoreCodeAgentMobileQueryMatch({
      value: 'gh-fix-ci',
      query: 'fix',
      exactBase: 0,
      prefixBase: 10,
      boundaryBase: 20,
      includesBase: 30,
      boundaryMarkers: ['-'],
    })).toBeLessThan(scoreCodeAgentMobileQueryMatch({
      value: 'highfixci',
      query: 'fix',
      exactBase: 0,
      prefixBase: 10,
      boundaryBase: 20,
      includesBase: 30,
      boundaryMarkers: ['-'],
    }) ?? Number.POSITIVE_INFINITY);
  });

  it('formats tree paths and ancestor paths for selected mobile entries', () => {
    expect(codeAgentMobileFileTreePath({ kind: 'directory', path: 'src' })).toBe('src/');
    expect(codeAgentMobileFileTreePath({ kind: 'file', path: 'src/App.tsx' })).toBe('src/App.tsx');
    expect(codeAgentMobileAncestorPaths('src/components/App.tsx')).toEqual(['src', 'src/components']);
  });
});
