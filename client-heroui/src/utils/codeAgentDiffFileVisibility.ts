export interface CodeAgentDiffVisibilityFile {
  readonly id: string;
}

export function getDefaultCodeAgentDiffExpandedFileKeys(
  files: ReadonlyArray<CodeAgentDiffVisibilityFile>,
): ReadonlyArray<string> {
  return files.map((file) => file.id);
}

export function getValidCodeAgentDiffFileKeys(
  files: ReadonlyArray<CodeAgentDiffVisibilityFile>,
  fileKeys: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (fileKeys === undefined) {
    return getDefaultCodeAgentDiffExpandedFileKeys(files);
  }

  const fileKeySet = new Set(files.map((file) => file.id));
  return fileKeys.filter((id) => fileKeySet.has(id));
}

export function getValidExplicitCodeAgentDiffFileKeys(
  files: ReadonlyArray<CodeAgentDiffVisibilityFile>,
  fileKeys: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (fileKeys === undefined) {
    return [];
  }

  return getValidCodeAgentDiffFileKeys(files, fileKeys);
}

export function toggleCodeAgentDiffFileKey(
  fileKeys: ReadonlyArray<string>,
  fileKey: string,
): ReadonlyArray<string> {
  return fileKeys.includes(fileKey)
    ? fileKeys.filter((id) => id !== fileKey)
    : [...fileKeys, fileKey];
}

export function removeCodeAgentDiffFileKey(
  fileKeys: ReadonlyArray<string>,
  fileKey: string,
): ReadonlyArray<string> {
  return fileKeys.includes(fileKey) ? fileKeys.filter((id) => id !== fileKey) : fileKeys;
}

export function getCodeAgentDiffCollapsedFileKeys(
  files: ReadonlyArray<CodeAgentDiffVisibilityFile>,
  expandedFileKeys: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  const expandedFileKeySet = new Set(getValidCodeAgentDiffFileKeys(files, expandedFileKeys));
  return files.reduce<string[]>((fileKeys, file) => {
    if (!expandedFileKeySet.has(file.id)) {
      fileKeys.push(file.id);
    }
    return fileKeys;
  }, []);
}
