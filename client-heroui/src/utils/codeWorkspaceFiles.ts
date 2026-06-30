import { requestCodeWorkspaceEntries, requestCodeWorkspaceFile } from './socket';

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
