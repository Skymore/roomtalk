export type CodeAgentMobileFileTreeEntry = {
  path: string;
  kind: 'file' | 'directory';
};

export interface CodeAgentMobileFileTreeNode {
  readonly path: string;
  readonly name: string;
  readonly kind: CodeAgentMobileFileTreeEntry['kind'];
  readonly children: ReadonlyArray<CodeAgentMobileFileTreeNode>;
  readonly searchSegments: ReadonlyArray<string>;
  readonly searchWords: ReadonlyArray<string>;
}

export interface CodeAgentVisibleMobileFileTreeNode {
  readonly node: CodeAgentMobileFileTreeNode;
  readonly depth: number;
}

interface MutableMobileFileTreeNode {
  path: string;
  name: string;
  kind: CodeAgentMobileFileTreeEntry['kind'];
  children: Map<string, MutableMobileFileTreeNode>;
}

function createMutableNode(
  path: string,
  name: string,
  kind: CodeAgentMobileFileTreeEntry['kind'],
): MutableMobileFileTreeNode {
  return {
    path,
    name,
    kind,
    children: new Map(),
  };
}

export function codeAgentMobileFileTreePath(entry: CodeAgentMobileFileTreeEntry): string {
  return entry.kind === 'directory' ? `${entry.path}/` : entry.path;
}

export function normalizeCodeAgentMobileSearchQuery(input: string): string {
  const trimmed = input.trim();
  return trimmed ? trimmed.toLowerCase() : '';
}

export function scoreCodeAgentMobileSubsequenceMatch(value: string, query: string): number | null {
  if (!query) return 0;

  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;

  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) {
      continue;
    }

    if (firstMatchIndex === -1) {
      firstMatchIndex = valueIndex;
    }
    if (previousMatchIndex !== -1) {
      gapPenalty += valueIndex - previousMatchIndex - 1;
    }

    previousMatchIndex = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) {
      const spanPenalty = valueIndex - firstMatchIndex + 1 - query.length;
      const lengthPenalty = Math.min(64, value.length - query.length);
      return firstMatchIndex * 2 + gapPenalty * 3 + spanPenalty + lengthPenalty;
    }
  }

  return null;
}

function lengthPenalty(value: string, query: string): number {
  return Math.min(64, Math.max(0, value.length - query.length));
}

function findBoundaryMatchIndex(
  value: string,
  query: string,
  boundaryMarkers: readonly string[],
): number | null {
  let bestIndex: number | null = null;

  for (const marker of boundaryMarkers) {
    const index = value.indexOf(`${marker}${query}`);
    if (index === -1) {
      continue;
    }

    const matchIndex = index + marker.length;
    if (bestIndex === null || matchIndex < bestIndex) {
      bestIndex = matchIndex;
    }
  }

  return bestIndex;
}

export function scoreCodeAgentMobileQueryMatch(input: {
  value: string;
  query: string;
  exactBase: number;
  prefixBase?: number;
  boundaryBase?: number;
  includesBase?: number;
  fuzzyBase?: number;
  boundaryMarkers?: readonly string[];
}): number | null {
  const { value, query } = input;

  if (!value || !query) {
    return null;
  }

  if (value === query) {
    return input.exactBase;
  }

  if (input.prefixBase !== undefined && value.startsWith(query)) {
    return input.prefixBase + lengthPenalty(value, query);
  }

  if (input.boundaryBase !== undefined) {
    const boundaryIndex = findBoundaryMatchIndex(
      value,
      query,
      input.boundaryMarkers ?? [' ', '-', '_', '/'],
    );
    if (boundaryIndex !== null) {
      return input.boundaryBase + boundaryIndex * 2 + lengthPenalty(value, query);
    }
  }

  if (input.includesBase !== undefined) {
    const includesIndex = value.indexOf(query);
    if (includesIndex !== -1) {
      return input.includesBase + includesIndex * 2 + lengthPenalty(value, query);
    }
  }

  if (input.fuzzyBase !== undefined) {
    const fuzzyScore = scoreCodeAgentMobileSubsequenceMatch(value, query);
    if (fuzzyScore !== null) {
      return input.fuzzyBase + fuzzyScore;
    }
  }

  return null;
}

function splitSearchWords(value: string): ReadonlyArray<string> {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function buildNodeSearchTerms(path: string): {
  readonly segments: ReadonlyArray<string>;
  readonly words: ReadonlyArray<string>;
} {
  const segments: string[] = [];
  const words: string[] = [];

  for (const segment of path.split('/')) {
    if (!segment) {
      continue;
    }
    segments.push(segment.toLowerCase());
    words.push(...splitSearchWords(segment));
  }

  return { segments, words };
}

function compareNodes(
  left: Pick<CodeAgentMobileFileTreeNode, 'kind' | 'name'>,
  right: Pick<CodeAgentMobileFileTreeNode, 'kind' | 'name'>,
): number {
  if (left.kind !== right.kind) {
    return left.kind === 'directory' ? -1 : 1;
  }
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
}

function freezeNode(node: MutableMobileFileTreeNode): CodeAgentMobileFileTreeNode {
  const searchTerms = buildNodeSearchTerms(node.path);
  return {
    path: node.path,
    name: node.name,
    kind: node.kind,
    children: [...node.children.values()].sort(compareNodes).map(freezeNode),
    searchSegments: searchTerms.segments,
    searchWords: searchTerms.words,
  };
}

export function buildCodeAgentMobileFileTree(
  entries: ReadonlyArray<CodeAgentMobileFileTreeEntry>,
): ReadonlyArray<CodeAgentMobileFileTreeNode> {
  const root = createMutableNode('', '', 'directory');

  for (const entry of entries) {
    const parts = entry.path.split('/').filter(Boolean);
    if (parts.length === 0) {
      continue;
    }

    let current = root;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (!part) {
        continue;
      }

      const path = parts.slice(0, index + 1).join('/');
      const isLeaf = index === parts.length - 1;
      const kind = isLeaf ? entry.kind : 'directory';
      let child = current.children.get(part);
      if (!child) {
        child = createMutableNode(path, part, kind);
        current.children.set(part, child);
      } else if (isLeaf) {
        child.kind = entry.kind;
      }
      current = child;
    }
  }

  return [...root.children.values()].sort(compareNodes).map(freezeNode);
}

export function countCodeAgentMobileFileNodes(
  nodes: ReadonlyArray<CodeAgentMobileFileTreeNode>,
): number {
  let count = 0;
  for (const node of nodes) {
    if (node.kind === 'file') {
      count += 1;
    } else {
      count += countCodeAgentMobileFileNodes(node.children);
    }
  }
  return count;
}

export function defaultExpandedCodeAgentMobileTreePaths(
  nodes: ReadonlyArray<CodeAgentMobileFileTreeNode>,
): ReadonlySet<string> {
  const expanded = new Set<string>();
  for (const node of nodes) {
    if (node.kind === 'directory') {
      expanded.add(node.path);
    }
  }
  return expanded;
}

function valueMatchesSearchToken(value: string, token: string, fuzzy: boolean): boolean {
  return (
    scoreCodeAgentMobileQueryMatch({
      value,
      query: token,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      ...(fuzzy ? { fuzzyBase: 100 } : {}),
      boundaryMarkers: ['/', '-', '_', '.'],
    }) !== null
  );
}

function nodeMatchesSearch(node: CodeAgentMobileFileTreeNode, tokens: ReadonlyArray<string>): boolean {
  return tokens.every((token) => (
    node.searchSegments.some((segment) => valueMatchesSearchToken(segment, token, false)) ||
    node.searchWords.some((word) => valueMatchesSearchToken(word, token, true))
  ));
}

function flattenNode(
  output: CodeAgentVisibleMobileFileTreeNode[],
  node: CodeAgentMobileFileTreeNode,
  depth: number,
  expanded: ReadonlySet<string>,
  searchTokens: ReadonlyArray<string>,
): boolean {
  const isSearching = searchTokens.length > 0;
  const matches = isSearching && nodeMatchesSearch(node, searchTokens);
  let descendantMatches = false;
  const childOutput: CodeAgentVisibleMobileFileTreeNode[] = [];

  if (node.kind === 'directory' && (expanded.has(node.path) || isSearching)) {
    for (const child of node.children) {
      if (flattenNode(childOutput, child, depth + 1, expanded, searchTokens)) {
        descendantMatches = true;
      }
    }
  }

  const visible = !isSearching || matches || descendantMatches;
  if (!visible) {
    return false;
  }

  output.push({ node, depth });
  output.push(...childOutput);
  return matches || descendantMatches;
}

export function flattenCodeAgentMobileFileTree(input: {
  readonly nodes: ReadonlyArray<CodeAgentMobileFileTreeNode>;
  readonly expanded: ReadonlySet<string>;
  readonly searchQuery?: string;
}): ReadonlyArray<CodeAgentVisibleMobileFileTreeNode> {
  const output: CodeAgentVisibleMobileFileTreeNode[] = [];
  const normalizedSearch = normalizeCodeAgentMobileSearchQuery(input.searchQuery ?? '');
  const searchTokens = normalizedSearch.split(/[\s/\\._-]+/).filter(Boolean);
  for (const node of input.nodes) {
    flattenNode(output, node, 0, input.expanded, searchTokens);
  }
  return output;
}

export function firstCodeAgentMobileFilePath(
  nodes: ReadonlyArray<CodeAgentMobileFileTreeNode>,
): string | null {
  for (const node of nodes) {
    if (node.kind === 'file') {
      return node.path;
    }
    const child = firstCodeAgentMobileFilePath(node.children);
    if (child !== null) {
      return child;
    }
  }
  return null;
}

export function codeAgentMobileAncestorPaths(path: string): ReadonlyArray<string> {
  const parts = path.split('/').filter(Boolean);
  const ancestors: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    ancestors.push(parts.slice(0, index).join('/'));
  }
  return ancestors;
}
