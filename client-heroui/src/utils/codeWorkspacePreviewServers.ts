import {
  requestCodeWorkspacePreviewServers,
  type CodeWorkspacePreviewNavigationTarget,
  type CodeWorkspacePreviewServerSnapshot,
} from './socket';

export type CodeWorkspacePreviewServerSource = 'configured' | 'scanner' | 'recent';

export type CodeWorkspacePreviewServer = CodeWorkspacePreviewServerSnapshot;

export interface PreviewableCodeWorkspacePreviewServer extends CodeWorkspacePreviewServer {
  source: CodeWorkspacePreviewServerSource;
  listening: boolean;
}

export const isLoopbackPreviewHost = (host: string): boolean => {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === '::1'
    || normalized === '::'
    || normalized === '0.0.0.0'
    || normalized.startsWith('127.')
  );
};

export const previewPortTargetFromLocalUrl = (
  raw: string,
): Extract<CodeWorkspacePreviewNavigationTarget, { kind: 'environment-port' }> | null => {
  const parsed = parseLocalPreviewUrl(raw);
  if (!parsed) {
    return null;
  }
  const url = new URL(parsed.url);
  const path = `${url.pathname || '/'}${url.search}${url.hash}`;
  return {
    kind: 'environment-port',
    port: parsed.port,
    protocol: url.protocol === 'https:' ? 'https' : 'http',
    path,
  };
};

export const validateCodeWorkspacePreviewServer = (value: unknown): CodeWorkspacePreviewServer => {
  if (!value || typeof value !== 'object') {
    throw new Error('Workspace preview server response is invalid');
  }
  const record = value as Partial<CodeWorkspacePreviewServerSnapshot>;
  const host = typeof record.host === 'string' && record.host.trim()
    ? record.host.trim()
    : 'localhost';
  const port = Number(record.port);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    throw new Error('Workspace preview server response is invalid');
  }
  const url = validatePreviewServerUrl(record.url, port);
  const processName = typeof record.processName === 'string' && record.processName.trim()
    ? record.processName.trim()
    : null;
  const pid = Number(record.pid);
  return {
    host,
    port,
    url,
    processName,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
  };
};

export const listCodeWorkspacePreviewServers = async (
  roomId: string,
): Promise<CodeWorkspacePreviewServer[]> => (
  (await requestCodeWorkspacePreviewServers(roomId)).map(validateCodeWorkspacePreviewServer)
);

export const mergeCodeWorkspacePreviewServers = (input: {
  scanner: readonly CodeWorkspacePreviewServer[];
  configuredUrls?: readonly string[];
  recentlySeenUrls?: readonly string[];
}): PreviewableCodeWorkspacePreviewServer[] => {
  const seen = new Map<string, PreviewableCodeWorkspacePreviewServer>();

  for (const url of input.configuredUrls ?? []) {
    const parsed = parseLocalPreviewUrl(url);
    if (!parsed) {
      continue;
    }
    const key = canonicalPreviewServerKey(parsed.host, parsed.port);
    if (seen.has(key)) {
      continue;
    }
    seen.set(key, {
      host: parsed.host,
      port: parsed.port,
      url: parsed.url,
      processName: null,
      pid: null,
      source: 'configured',
      listening: false,
    });
  }

  for (const server of input.scanner) {
    const key = canonicalPreviewServerKey(server.host, server.port);
    const existing = seen.get(key);
    if (existing) {
      seen.set(key, {
        ...existing,
        processName: server.processName ?? existing.processName,
        pid: server.pid ?? existing.pid,
        listening: true,
      });
      continue;
    }
    seen.set(key, {
      ...server,
      source: 'scanner',
      listening: true,
    });
  }

  for (const url of input.recentlySeenUrls ?? []) {
    const parsed = parseLocalPreviewUrl(url);
    if (!parsed) {
      continue;
    }
    const key = canonicalPreviewServerKey(parsed.host, parsed.port);
    if (seen.has(key)) {
      continue;
    }
    seen.set(key, {
      host: parsed.host,
      port: parsed.port,
      url: parsed.url,
      processName: null,
      pid: null,
      source: 'recent',
      listening: false,
    });
  }

  return [...seen.values()].sort((a, b) => {
    const sourceOrder: Record<CodeWorkspacePreviewServerSource, number> = {
      configured: 0,
      scanner: 1,
      recent: 2,
    };
    if (sourceOrder[a.source] !== sourceOrder[b.source]) {
      return sourceOrder[a.source] - sourceOrder[b.source];
    }
    return a.port - b.port;
  });
};

const canonicalPreviewServerKey = (host: string, port: number): string => (
  `${host.trim().toLowerCase()}:${port}`
);

const parseLocalPreviewUrl = (raw: string): { host: string; port: number; url: string } | null => {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (!isLoopbackPreviewHost(parsed.hostname)) {
      return null;
    }
    const port = parsed.port
      ? Number.parseInt(parsed.port, 10)
      : parsed.protocol === 'http:'
        ? 80
        : 443;
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
      return null;
    }
    return {
      host: parsed.hostname,
      port,
      url: parsed.toString(),
    };
  } catch {
    return null;
  }
};

const validatePreviewServerUrl = (value: unknown, port: number): string => {
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = new URL(value.trim());
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.toString();
      }
    } catch {
      // Fall through to the localhost URL below.
    }
  }
  return `http://localhost:${port}/`;
};
