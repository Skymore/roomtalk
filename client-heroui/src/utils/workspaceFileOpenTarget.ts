export interface WorkspaceFileOpenTarget {
  path: string;
  line: number | null;
}

const DEFAULT_WORKSPACE_ROOT = '/workspace';

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('//');
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || isWindowsAbsolutePath(value);
}

function splitWorkspacePathAndPosition(value: string): {
  path: string;
  line: string | undefined;
} {
  let path = value;
  const columnMatch = path.match(/:(\d+)$/);
  if (!columnMatch?.[1]) {
    return { path, line: undefined };
  }

  path = path.slice(0, -columnMatch[0].length);
  const lineMatch = path.match(/:(\d+)$/);
  if (!lineMatch?.[1]) {
    return { path, line: columnMatch[1] };
  }

  path = path.slice(0, -lineMatch[0].length);
  return { path, line: lineMatch[1] };
}

export const normalizeWorkspaceOpenLine = (line: string | undefined): number | null => {
  if (!line) {
    return null;
  }
  const parsed = Number.parseInt(line, 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : null;
};

export const normalizeWorkspaceOpenPath = (path: string): string => (
  path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/?workspace\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
);

function normalizeWorkspaceRelativePath(value: string): string | null {
  const segments: string[] = [];
  for (const segment of value.replaceAll('\\', '/').split('/')) {
    if (segment.length === 0 || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join('/') : null;
}

export function resolveWorkspaceOpenRelativePath(
  targetPath: string,
  workspaceRoot: string | null | undefined = DEFAULT_WORKSPACE_ROOT,
): string | null {
  if (!isAbsolutePath(targetPath)) {
    if (targetPath.startsWith('~/') || targetPath.startsWith('~\\')) {
      return null;
    }
    return normalizeWorkspaceRelativePath(targetPath);
  }
  if (!workspaceRoot) {
    return null;
  }

  const normalizedTarget = targetPath.replaceAll('\\', '/');
  const normalizedRoot = workspaceRoot.replaceAll('\\', '/').replace(/\/+$/, '');
  const caseInsensitive = isWindowsAbsolutePath(targetPath) || isWindowsAbsolutePath(workspaceRoot);
  const comparableTarget = caseInsensitive ? normalizedTarget.toLowerCase() : normalizedTarget;
  const comparableRoot = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  if (!comparableTarget.startsWith(`${comparableRoot}/`)) {
    return null;
  }

  return normalizeWorkspaceRelativePath(normalizedTarget.slice(normalizedRoot.length + 1));
}

export const parseWorkspaceFileOpenTarget = (
  path: string,
  options: { workspaceRoot?: string | null } = {},
): WorkspaceFileOpenTarget | null => {
  let normalizedPath = path.trim().replace(/\\/g, '/');
  if (!normalizedPath) {
    return null;
  }

  if (/^file:\/\//i.test(normalizedPath)) {
    try {
      const fileUrl = new URL(normalizedPath);
      normalizedPath = `${decodeURIComponent(fileUrl.pathname)}${fileUrl.search}${fileUrl.hash}`;
    } catch {
      normalizedPath = normalizedPath.replace(/^file:\/\//i, '');
    }
  }

  let line: number | null = null;
  const hashIndex = normalizedPath.indexOf('#');
  if (hashIndex >= 0) {
    const hash = normalizedPath.slice(hashIndex + 1);
    normalizedPath = normalizedPath.slice(0, hashIndex);
    const hashLineMatch = hash.match(/^L(\d+)(?:C\d+)?$/i);
    line = normalizeWorkspaceOpenLine(hashLineMatch?.[1]);
  }

  const queryIndex = normalizedPath.indexOf('?');
  if (queryIndex >= 0) {
    normalizedPath = normalizedPath.slice(0, queryIndex);
  }

  if (line === null) {
    const pathAndPosition = splitWorkspacePathAndPosition(normalizedPath);
    line = normalizeWorkspaceOpenLine(pathAndPosition.line);
    normalizedPath = pathAndPosition.path;
  }

  const relativePath = resolveWorkspaceOpenRelativePath(
    normalizedPath,
    options.workspaceRoot === undefined ? DEFAULT_WORKSPACE_ROOT : options.workspaceRoot,
  );
  return relativePath ? { path: relativePath, line } : null;
};
