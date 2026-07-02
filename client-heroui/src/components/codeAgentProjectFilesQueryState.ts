import type { CodeWorkspaceFile } from '../utils/codeWorkspaceFiles';
import { normalizeWorkspaceOpenPath } from '../utils/workspaceFileOpenTarget';

interface OptimisticCodeWorkspaceFile {
  data: CodeWorkspaceFile;
  confirmedAgainst?: CodeWorkspaceFile | null;
}

const optimisticFiles = new Map<string, OptimisticCodeWorkspaceFile>();

const fileKey = (roomId: string, relativePath: string, scopeKey = ''): string => (
  `${roomId.trim()}:${scopeKey || 'default'}:${normalizeWorkspaceOpenPath(relativePath)}`
);

const utf8ByteSize = (contents: string): number => new TextEncoder().encode(contents).byteLength;

const buildOptimisticFile = (relativePath: string, contents: string): CodeWorkspaceFile => ({
  path: normalizeWorkspaceOpenPath(relativePath),
  content: contents,
  byteSize: utf8ByteSize(contents),
  truncated: false,
  encoding: 'utf-8',
});

const refreshedFileMatchesOptimistic = (
  relativePath: string,
  optimisticFile: CodeWorkspaceFile,
  refreshedFile: CodeWorkspaceFile,
): boolean => (
  normalizeWorkspaceOpenPath(refreshedFile.path) === normalizeWorkspaceOpenPath(relativePath) &&
  refreshedFile.content === optimisticFile.content &&
  refreshedFile.byteSize === optimisticFile.byteSize &&
  refreshedFile.truncated === optimisticFile.truncated &&
  refreshedFile.encoding === optimisticFile.encoding
);

export function setCodeAgentProjectFileQueryData(
  roomId: string,
  relativePath: string,
  contents: string,
  scopeKey = '',
): CodeWorkspaceFile {
  const data = buildOptimisticFile(relativePath, contents);
  optimisticFiles.set(fileKey(roomId, relativePath, scopeKey), {
    confirmedAgainst: undefined,
    data,
  });
  return data;
}

export function getOptimisticCodeAgentProjectFileQueryData(
  roomId: string,
  relativePath: string,
  scopeKey = '',
): CodeWorkspaceFile | null {
  return optimisticFiles.get(fileKey(roomId, relativePath, scopeKey))?.data ?? null;
}

export function resolveCodeAgentProjectFileQueryData(
  roomId: string,
  relativePath: string | null,
  data: CodeWorkspaceFile | null,
  scopeKey = '',
): CodeWorkspaceFile | null {
  if (relativePath === null) return data;
  return getOptimisticCodeAgentProjectFileQueryData(roomId, relativePath, scopeKey) ?? data;
}

export function confirmCodeAgentProjectFileQueryData(
  roomId: string,
  relativePath: string,
  contents: string,
  confirmedAgainst: CodeWorkspaceFile | null = null,
  scopeKey = '',
): boolean {
  const key = fileKey(roomId, relativePath, scopeKey);
  const optimisticFile = optimisticFiles.get(key);
  if (optimisticFile?.data.content !== contents) {
    return false;
  }
  const confirmed = {
    ...optimisticFile,
    confirmedAgainst,
  };
  optimisticFiles.set(key, confirmed);
  return true;
}

export function settleConfirmedCodeAgentProjectFileQueryData(
  roomId: string,
  relativePath: string,
  refreshedFile: CodeWorkspaceFile,
  scopeKey = '',
): boolean {
  const key = fileKey(roomId, relativePath, scopeKey);
  const optimisticFile = optimisticFiles.get(key);
  if (!optimisticFile || optimisticFile.confirmedAgainst === undefined) {
    return false;
  }
  if (!refreshedFileMatchesOptimistic(relativePath, optimisticFile.data, refreshedFile)) {
    return false;
  }
  optimisticFiles.delete(key);
  return true;
}

export function clearCodeAgentProjectFileQueryData(roomId: string, relativePath: string, scopeKey?: string): void {
  if (scopeKey !== undefined) {
    optimisticFiles.delete(fileKey(roomId, relativePath, scopeKey));
    return;
  }
  const roomPrefix = `${roomId.trim()}:`;
  const pathSuffix = `:${normalizeWorkspaceOpenPath(relativePath)}`;
  for (const key of optimisticFiles.keys()) {
    if (key.startsWith(roomPrefix) && key.endsWith(pathSuffix)) {
      optimisticFiles.delete(key);
    }
  }
}

export function resetCodeAgentProjectFilesQueryStateForTests(): void {
  optimisticFiles.clear();
}
