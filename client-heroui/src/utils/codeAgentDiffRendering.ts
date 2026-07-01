import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs';

export const CODE_AGENT_DIFF_THEME_NAMES = {
  light: 'pierre-light',
  dark: 'pierre-dark',
} as const;

export type CodeAgentDiffThemeName = (typeof CODE_AGENT_DIFF_THEME_NAMES)[keyof typeof CODE_AGENT_DIFF_THEME_NAMES];

export function resolveCodeAgentDiffThemeName(theme: 'light' | 'dark'): CodeAgentDiffThemeName {
  return theme === 'dark' ? CODE_AGENT_DIFF_THEME_NAMES.dark : CODE_AGENT_DIFF_THEME_NAMES.light;
}

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const SECONDARY_HASH_SEED = 0x9e3779b9;
const SECONDARY_HASH_MULTIPLIER = 0x85ebca6b;

export function fnv1a32(
  input: string,
  seed = FNV_OFFSET_BASIS_32,
  multiplier = FNV_PRIME_32,
): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, multiplier) >>> 0;
  }
  return hash >>> 0;
}

export function buildPatchCacheKey(patch: string, scope = 'diff-panel'): string {
  const normalizedPatch = patch.trim();
  const primary = fnv1a32(normalizedPatch, FNV_OFFSET_BASIS_32, FNV_PRIME_32).toString(36);
  const secondary = fnv1a32(
    normalizedPatch,
    SECONDARY_HASH_SEED,
    SECONDARY_HASH_MULTIPLIER,
  ).toString(36);
  return `${scope}:${normalizedPatch.length}:${primary}:${secondary}`;
}

export type RenderablePatch =
  | {
    kind: 'files';
    files: FileDiffMetadata[];
  }
  | {
    kind: 'raw';
    text: string;
    reason: string;
  };

interface RenderablePatchOptions {
  /**
   * Mirrored from T3: Pierre's partial-patch parser keeps hunk render starts in
   * source-file coordinates, while the virtualizer renders partial patches as
   * compact rows.
   */
  compactPartialHunkOffsets?: boolean;
}

export function compactPartialHunkOffsets(file: FileDiffMetadata): FileDiffMetadata {
  if (!file.isPartial) {
    return file;
  }

  let splitLineStart = 0;
  let unifiedLineStart = 0;
  const hunks = file.hunks.map((hunk) => {
    const compactHunk = {
      ...hunk,
      splitLineStart,
      unifiedLineStart,
    };
    splitLineStart += hunk.splitLineCount;
    unifiedLineStart += hunk.unifiedLineCount;
    return compactHunk;
  });

  return {
    ...file,
    hunks,
    splitLineCount: splitLineStart,
    unifiedLineCount: unifiedLineStart,
    ...(file.cacheKey ? { cacheKey: `${file.cacheKey}:compact-partial` } : {}),
  };
}

export function getRenderablePatch(
  patch: string | undefined,
  cacheScope = 'diff-panel',
  options: RenderablePatchOptions = {},
): RenderablePatch | null {
  if (!patch) {
    return null;
  }
  const normalizedPatch = patch.trim();
  if (normalizedPatch.length === 0) {
    return null;
  }

  try {
    const parsedPatches = parsePatchFiles(
      normalizedPatch,
      buildPatchCacheKey(normalizedPatch, cacheScope),
    );
    const files = parsedPatches.flatMap((parsedPatch) =>
      options.compactPartialHunkOffsets
        ? parsedPatch.files.map(compactPartialHunkOffsets)
        : parsedPatch.files,
    );
    if (files.length > 0) {
      return { kind: 'files', files };
    }
    return {
      kind: 'raw',
      text: normalizedPatch,
      reason: 'Unsupported diff format. Showing raw patch.',
    };
  } catch {
    return {
      kind: 'raw',
      text: normalizedPatch,
      reason: 'Failed to parse patch. Showing raw patch.',
    };
  }
}

export function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const rawPath = fileDiff.name ?? fileDiff.prevName ?? '';
  return rawPath.startsWith('a/') || rawPath.startsWith('b/') ? rawPath.slice(2) : rawPath;
}

export function stripDiffPathPrefix(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith('a/') || trimmed.startsWith('b/') ? trimmed.slice(2) : trimmed;
}

export function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? 'none'}:${fileDiff.name}`;
}

function addDiffTitlePathCandidate(
  candidates: Map<string, string>,
  title: string | null | undefined,
  path: string,
) {
  if (!title) {
    return;
  }
  const trimmed = title.trim();
  if (!trimmed) {
    return;
  }
  candidates.set(trimmed, path);
  candidates.set(stripDiffPathPrefix(trimmed), path);
}

export function buildDiffTitlePathMap(fileDiffs: ReadonlyArray<FileDiffMetadata>): ReadonlyMap<string, string> {
  const candidates = new Map<string, string>();
  for (const fileDiff of fileDiffs) {
    const filePath = resolveFileDiffPath(fileDiff);
    addDiffTitlePathCandidate(candidates, fileDiff.name, filePath);
    addDiffTitlePathCandidate(candidates, fileDiff.prevName, filePath);
    if (fileDiff.prevName && fileDiff.name) {
      const previousPath = stripDiffPathPrefix(fileDiff.prevName);
      const nextPath = stripDiffPathPrefix(fileDiff.name);
      addDiffTitlePathCandidate(candidates, `${previousPath} → ${nextPath}`, filePath);
      addDiffTitlePathCandidate(candidates, `${previousPath} -> ${nextPath}`, filePath);
    }
  }
  return candidates;
}

function normalizeDiffTitleText(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

export function resolveDiffTitleOpenPath(rawTitle: string, pathMap: ReadonlyMap<string, string>): string | null {
  const normalizedTitle = normalizeDiffTitleText(rawTitle);
  if (!normalizedTitle) {
    return null;
  }

  const directPath = pathMap.get(normalizedTitle) ?? pathMap.get(stripDiffPathPrefix(normalizedTitle));
  if (directPath) {
    return directPath;
  }

  const sortedTitles = [...pathMap.entries()].sort((left, right) => right[0].length - left[0].length);
  for (const [title, path] of sortedTitles) {
    const normalizedCandidate = normalizeDiffTitleText(title);
    if (
      normalizedCandidate &&
      (normalizedTitle === normalizedCandidate || normalizedTitle.startsWith(`${normalizedCandidate} `))
    ) {
      return path;
    }
  }

  const renameTarget = normalizedTitle.match(/(?:→|->)\s*(.+)$/)?.[1];
  if (renameTarget) {
    const normalizedTarget = stripDiffPathPrefix(renameTarget);
    const targetPath = pathMap.get(renameTarget) ?? pathMap.get(normalizedTarget);
    if (targetPath) {
      return targetPath;
    }
    for (const [title, path] of sortedTitles) {
      const normalizedCandidate = normalizeDiffTitleText(stripDiffPathPrefix(title));
      if (
        normalizedCandidate &&
        (normalizedTarget === normalizedCandidate || normalizedTarget.startsWith(`${normalizedCandidate} `))
      ) {
        return path;
      }
    }
  }

  return stripDiffPathPrefix(normalizedTitle);
}

export function withDiffLineTarget(path: string, lineNumber: number | null): string {
  return lineNumber === null ? path : `${path}#L${lineNumber}`;
}

export function getDiffCollapseIconClassName(fileDiff: FileDiffMetadata): string {
  switch (fileDiff.type) {
    case 'new':
      return 'text-[var(--diffs-addition-base)]';
    case 'deleted':
      return 'text-[var(--diffs-deletion-base)]';
    case 'change':
    case 'rename-pure':
    case 'rename-changed':
      return 'text-[var(--diffs-modified-base)]';
    default:
      return 'text-[#87867f] dark:text-[#8f8d86]';
  }
}

export function summarizeFileDiffStat(fileDiff: FileDiffMetadata): { additions: number; deletions: number } {
  return fileDiff.hunks.reduce(
    (stat, hunk) => ({
      additions: stat.additions + hunk.additionLines,
      deletions: stat.deletions + hunk.deletionLines,
    }),
    { additions: 0, deletions: 0 },
  );
}
