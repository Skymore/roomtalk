import {
  requestCodeWorkspaceAssetUrl,
  requestCodeWorkspaceEntries,
  requestCodeWorkspaceEntrySearch,
  requestCodeWorkspaceFile,
  requestResolveCodeWorkspaceFilePreview,
  requestCreateCodeWorkspaceDirectory,
  requestDeleteCodeWorkspaceEntry,
  requestRenameCodeWorkspaceEntry,
  requestWriteCodeWorkspaceFile,
} from './socket';
import { apiPath } from './apiBase';

export interface CodeWorkspaceEntry {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size?: number;
  updatedAt?: string;
}

export interface CodeWorkspaceFile {
  path: string;
  content: string;
  byteSize: number;
  truncated: boolean;
  encoding: 'utf-8' | 'base64';
}

export interface CodeWorkspaceAssetUrl {
  relativeUrl: string;
  expiresAt: string;
}

export type CodeWorkspaceFilePreview =
  | {
      kind: 'static-file';
      asset: CodeWorkspaceAssetUrl;
    }
  | {
      kind: 'dev-server';
      frameworkId: string;
      frameworkName: string;
      projectRoot: string;
      command: string;
      port: number;
      status: 'running' | 'starting';
      requestedUrl: string;
      resolvedUrl?: string;
      server?: {
        host: string;
        port: number;
        url: string;
        processName?: string | null;
        pid?: number | null;
      };
    };

export const loadCodeWorkspaceEntries = async (
  roomId: string,
  options: { signal?: AbortSignal } = {}
): Promise<{ entries: CodeWorkspaceEntry[]; truncated: boolean }> => {
  if (options.signal?.aborted) {
    throw new Error('Workspace file request aborted');
  }

  const response = await requestCodeWorkspaceEntries(roomId);
  if (options.signal?.aborted) {
    throw new Error('Workspace file request aborted');
  }

  return {
    entries: response.entries.map(validateWorkspaceEntry),
    truncated: response.truncated,
  };
};

export const searchCodeWorkspaceEntries = async (
  roomId: string,
  query: string,
  options: { limit?: number; signal?: AbortSignal } = {}
): Promise<{ entries: CodeWorkspaceEntry[]; truncated: boolean }> => {
  if (options.signal?.aborted) {
    throw new Error('Workspace file search aborted');
  }

  const response = await requestCodeWorkspaceEntrySearch(roomId, query, options.limit);
  if (options.signal?.aborted) {
    throw new Error('Workspace file search aborted');
  }

  return {
    entries: response.entries.map(validateWorkspaceEntry),
    truncated: response.truncated,
  };
};

export const loadCodeWorkspaceFile = async (
  roomId: string,
  path: string,
  options: { signal?: AbortSignal } = {}
): Promise<CodeWorkspaceFile> => {
  if (options.signal?.aborted) {
    throw new Error('Workspace file read aborted');
  }

  const file = await requestCodeWorkspaceFile(roomId, path);
  if (options.signal?.aborted) {
    throw new Error('Workspace file read aborted');
  }

  return validateWorkspaceFile(file);
};

export const createCodeWorkspaceAssetUrl = async (
  roomId: string,
  path: string,
  options: { signal?: AbortSignal } = {}
): Promise<CodeWorkspaceAssetUrl> => {
  if (options.signal?.aborted) {
    throw new Error('Workspace preview request aborted');
  }

  const asset = await requestCodeWorkspaceAssetUrl(roomId, path);
  if (options.signal?.aborted) {
    throw new Error('Workspace preview request aborted');
  }

  return validateWorkspaceAssetUrl(asset);
};

export const resolveCodeWorkspaceFilePreview = async (
  roomId: string,
  path: string,
  options: { signal?: AbortSignal } = {}
): Promise<CodeWorkspaceFilePreview> => {
  if (options.signal?.aborted) {
    throw new Error('Workspace preview request aborted');
  }

  const preview = await requestResolveCodeWorkspaceFilePreview(roomId, path);
  if (options.signal?.aborted) {
    throw new Error('Workspace preview request aborted');
  }

  return validateWorkspaceFilePreview(preview);
};

export const resolveCodeWorkspaceAssetUrl = (asset: CodeWorkspaceAssetUrl): string => (
  apiPath(asset.relativeUrl)
);

export const writeCodeWorkspaceFile = async (
  roomId: string,
  path: string,
  content: string,
  encoding: CodeWorkspaceFile['encoding'] = 'utf-8'
): Promise<CodeWorkspaceEntry> => {
  const entry = await requestWriteCodeWorkspaceFile({ roomId, path, content, encoding });
  return validateWorkspaceEntry(entry);
};

export const createCodeWorkspaceDirectory = async (
  roomId: string,
  path: string
): Promise<CodeWorkspaceEntry> => {
  const entry = await requestCreateCodeWorkspaceDirectory(roomId, path);
  return validateWorkspaceEntry(entry);
};

export const renameCodeWorkspaceEntry = async (
  roomId: string,
  fromPath: string,
  toPath: string
): Promise<CodeWorkspaceEntry> => {
  const entry = await requestRenameCodeWorkspaceEntry(roomId, fromPath, toPath);
  return validateWorkspaceEntry(entry);
};

export const deleteCodeWorkspaceEntry = async (
  roomId: string,
  path: string
): Promise<void> => {
  await requestDeleteCodeWorkspaceEntry(roomId, path);
};

const validateWorkspaceAssetUrl = (value: unknown): CodeWorkspaceAssetUrl => {
  if (!value || typeof value !== 'object') {
    throw new Error('Workspace asset URL response is invalid');
  }
  const asset = value as Partial<CodeWorkspaceAssetUrl>;
  if (typeof asset.relativeUrl !== 'string' || typeof asset.expiresAt !== 'string') {
    throw new Error('Workspace asset URL response is invalid');
  }

  return {
    relativeUrl: asset.relativeUrl,
    expiresAt: asset.expiresAt,
  };
};

const validateWorkspaceFilePreview = (value: unknown): CodeWorkspaceFilePreview => {
  if (!value || typeof value !== 'object') {
    throw new Error('Workspace preview response is invalid');
  }
  const preview = value as Partial<CodeWorkspaceFilePreview>;
  if (preview.kind === 'static-file') {
    if (!('asset' in preview)) {
      throw new Error('Workspace preview response is invalid');
    }
    return {
      kind: 'static-file',
      asset: validateWorkspaceAssetUrl(preview.asset),
    };
  }
  if (preview.kind === 'dev-server') {
    if (
      typeof preview.frameworkId !== 'string' ||
      typeof preview.frameworkName !== 'string' ||
      typeof preview.projectRoot !== 'string' ||
      typeof preview.command !== 'string' ||
      typeof preview.port !== 'number' ||
      (preview.status !== 'running' && preview.status !== 'starting') ||
      typeof preview.requestedUrl !== 'string'
    ) {
      throw new Error('Workspace preview response is invalid');
    }
    return {
      kind: 'dev-server',
      frameworkId: preview.frameworkId,
      frameworkName: preview.frameworkName,
      projectRoot: preview.projectRoot,
      command: preview.command,
      port: preview.port,
      status: preview.status,
      requestedUrl: preview.requestedUrl,
      ...(typeof preview.resolvedUrl === 'string' ? { resolvedUrl: preview.resolvedUrl } : {}),
      ...(validateWorkspacePreviewServer(preview.server) ? { server: validateWorkspacePreviewServer(preview.server)! } : {}),
    };
  }
  throw new Error('Workspace preview response is invalid');
};

const validateWorkspacePreviewServer = (value: unknown): Extract<CodeWorkspaceFilePreview, { kind: 'dev-server' }>['server'] | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const server = value as Partial<NonNullable<Extract<CodeWorkspaceFilePreview, { kind: 'dev-server' }>['server']>>;
  if (
    typeof server.host !== 'string' ||
    typeof server.port !== 'number' ||
    typeof server.url !== 'string'
  ) {
    return null;
  }
  return {
    host: server.host,
    port: server.port,
    url: server.url,
    ...(typeof server.processName === 'string' || server.processName === null ? { processName: server.processName } : {}),
    ...(typeof server.pid === 'number' || server.pid === null ? { pid: server.pid } : {}),
  };
};

const validateWorkspaceEntry = (value: unknown): CodeWorkspaceEntry => {
  if (!value || typeof value !== 'object') {
    throw new Error('Workspace entry response is invalid');
  }
  const entry = value as Partial<CodeWorkspaceEntry>;
  if (
    typeof entry.path !== 'string' ||
    typeof entry.name !== 'string' ||
    (entry.type !== 'file' && entry.type !== 'directory')
  ) {
    throw new Error('Workspace entry response is invalid');
  }

  return {
    path: entry.path,
    name: entry.name,
    type: entry.type,
    ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
    ...(typeof entry.updatedAt === 'string' ? { updatedAt: entry.updatedAt } : {}),
  };
};

const validateWorkspaceFile = (value: unknown): CodeWorkspaceFile => {
  if (!value || typeof value !== 'object') {
    throw new Error('Workspace file response is invalid');
  }
  const file = value as Partial<CodeWorkspaceFile>;
  if (
    typeof file.path !== 'string' ||
    typeof file.content !== 'string' ||
    typeof file.byteSize !== 'number' ||
    typeof file.truncated !== 'boolean' ||
    (file.encoding !== 'utf-8' && file.encoding !== 'base64')
  ) {
    throw new Error('Workspace file response is invalid');
  }

  return {
    path: file.path,
    content: file.content,
    byteSize: file.byteSize,
    truncated: file.truncated,
    encoding: file.encoding,
  };
};
