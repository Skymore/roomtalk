interface OpenCodeAgentDiffFilePrimaryActionInput {
  filePath: string;
  openInWorkspaceFileViewer?: (filePath: string) => void;
  openFallback?: (filePath: string) => void;
}

export function openCodeAgentDiffFilePrimaryAction({
  filePath,
  openInWorkspaceFileViewer,
  openFallback,
}: OpenCodeAgentDiffFilePrimaryActionInput): void {
  const normalizedFilePath = filePath.trim();
  if (!normalizedFilePath) {
    return;
  }

  if (openInWorkspaceFileViewer) {
    openInWorkspaceFileViewer(normalizedFilePath);
    return;
  }

  openFallback?.(normalizedFilePath);
}
