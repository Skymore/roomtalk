export interface CodeAgentChangedFileStat {
  additions: number;
  deletions: number;
}

export interface CodeAgentChangedFile {
  path: string;
  additions?: number;
  deletions?: number;
}

export interface CodeAgentChangedFileDirectoryNode {
  kind: 'directory';
  name: string;
  path: string;
  stat: CodeAgentChangedFileStat;
  children: CodeAgentChangedFileTreeNode[];
}

export interface CodeAgentChangedFileNode {
  kind: 'file';
  name: string;
  path: string;
  stat: CodeAgentChangedFileStat | null;
}

export type CodeAgentChangedFileTreeNode = CodeAgentChangedFileDirectoryNode | CodeAgentChangedFileNode;

interface MutableDirectoryNode {
  name: string;
  path: string;
  stat: CodeAgentChangedFileStat;
  directories: Map<string, MutableDirectoryNode>;
  files: CodeAgentChangedFileNode[];
}

const SORT_LOCALE_OPTIONS: Intl.CollatorOptions = { numeric: true, sensitivity: 'base' };

function normalizePathSegments(pathValue: string): string[] {
  return pathValue
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0);
}

function compareByName(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name, undefined, SORT_LOCALE_OPTIONS);
}

function readStat(file: CodeAgentChangedFile): CodeAgentChangedFileStat | null {
  if (typeof file.additions !== 'number' || typeof file.deletions !== 'number') {
    return null;
  }
  return {
    additions: file.additions,
    deletions: file.deletions,
  };
}

function compactDirectoryNode(node: CodeAgentChangedFileDirectoryNode): CodeAgentChangedFileDirectoryNode {
  const compactedChildren = node.children.map((child) => (
    child.kind === 'directory' ? compactDirectoryNode(child) : child
  ));

  let compactedNode: CodeAgentChangedFileDirectoryNode = {
    ...node,
    children: compactedChildren,
  };

  while (compactedNode.children.length === 1 && compactedNode.children[0]?.kind === 'directory') {
    const onlyChild = compactedNode.children[0];
    compactedNode = {
      kind: 'directory',
      name: `${compactedNode.name}/${onlyChild.name}`,
      path: onlyChild.path,
      stat: onlyChild.stat,
      children: onlyChild.children,
    };
  }

  return compactedNode;
}

function toTreeNodes(directory: MutableDirectoryNode): CodeAgentChangedFileTreeNode[] {
  const subdirectories = Array.from(directory.directories.values())
    .sort(compareByName)
    .map<CodeAgentChangedFileDirectoryNode>((subdirectory) => ({
      kind: 'directory',
      name: subdirectory.name,
      path: subdirectory.path,
      stat: {
        additions: subdirectory.stat.additions,
        deletions: subdirectory.stat.deletions,
      },
      children: toTreeNodes(subdirectory),
    }))
    .map((subdirectory) => compactDirectoryNode(subdirectory));

  const files = [...directory.files].sort(compareByName);
  return [...subdirectories, ...files];
}

export function hasNonZeroChangedFileStat(stat: CodeAgentChangedFileStat): boolean {
  return stat.additions > 0 || stat.deletions > 0;
}

export function summarizeCodeAgentChangedFileStats(
  files: ReadonlyArray<CodeAgentChangedFile>,
): CodeAgentChangedFileStat {
  return files.reduce(
    (summary, file) => {
      const stat = readStat(file);
      if (!stat) {
        return summary;
      }
      return {
        additions: summary.additions + stat.additions,
        deletions: summary.deletions + stat.deletions,
      };
    },
    { additions: 0, deletions: 0 },
  );
}

export function formatCompactDiffCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, '') : Math.round(thousands)}k`;
  }
  if (value < 1_000_000_000) {
    const millions = value / 1_000_000;
    return `${millions < 10 ? millions.toFixed(1).replace(/\.0$/, '') : Math.round(millions)}m`;
  }
  const billions = value / 1_000_000_000;
  return `${billions < 10 ? billions.toFixed(1).replace(/\.0$/, '') : Math.round(billions)}b`;
}

export function buildCodeAgentChangedFileTree(
  files: ReadonlyArray<CodeAgentChangedFile>,
): CodeAgentChangedFileTreeNode[] {
  const root: MutableDirectoryNode = {
    name: '',
    path: '',
    stat: { additions: 0, deletions: 0 },
    directories: new Map(),
    files: [],
  };

  for (const file of files) {
    const segments = normalizePathSegments(file.path);
    if (segments.length === 0) {
      continue;
    }

    const filePath = segments.join('/');
    const fileName = segments.at(-1);
    if (!fileName) {
      continue;
    }
    const stat = readStat(file);
    const ancestors: MutableDirectoryNode[] = [root];
    let currentDirectory = root;

    for (const segment of segments.slice(0, -1)) {
      const nextPath = currentDirectory.path ? `${currentDirectory.path}/${segment}` : segment;
      const existing = currentDirectory.directories.get(segment);
      if (existing) {
        currentDirectory = existing;
      } else {
        const created: MutableDirectoryNode = {
          name: segment,
          path: nextPath,
          stat: { additions: 0, deletions: 0 },
          directories: new Map(),
          files: [],
        };
        currentDirectory.directories.set(segment, created);
        currentDirectory = created;
      }
      ancestors.push(currentDirectory);
    }

    currentDirectory.files.push({
      kind: 'file',
      name: fileName,
      path: filePath,
      stat,
    });

    if (stat) {
      for (const ancestor of ancestors) {
        ancestor.stat.additions += stat.additions;
        ancestor.stat.deletions += stat.deletions;
      }
    }
  }

  return toTreeNodes(root);
}

export function collectChangedFileDirectoryPaths(nodes: ReadonlyArray<CodeAgentChangedFileTreeNode>): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== 'directory') continue;
    paths.push(node.path);
    paths.push(...collectChangedFileDirectoryPaths(node.children));
  }
  return paths;
}
