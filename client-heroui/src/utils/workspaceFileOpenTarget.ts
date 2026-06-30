export interface WorkspaceFileOpenTarget {
  path: string;
  line: number | null;
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

export const parseWorkspaceFileOpenTarget = (path: string): WorkspaceFileOpenTarget | null => {
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
    const hashLineMatch = hash.match(/^L(\d+)$/i);
    line = normalizeWorkspaceOpenLine(hashLineMatch?.[1]);
  }

  const queryIndex = normalizedPath.indexOf('?');
  if (queryIndex >= 0) {
    normalizedPath = normalizedPath.slice(0, queryIndex);
  }

  if (line === null) {
    const colonLineMatch = normalizedPath.match(/:(\d+)$/);
    if (colonLineMatch?.index !== undefined) {
      line = normalizeWorkspaceOpenLine(colonLineMatch[1]);
      normalizedPath = normalizedPath.slice(0, colonLineMatch.index);
    }
  }

  normalizedPath = normalizeWorkspaceOpenPath(normalizedPath);
  return normalizedPath ? { path: normalizedPath, line } : null;
};
