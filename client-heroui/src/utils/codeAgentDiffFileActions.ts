import { openCodeAgentRightPanelFile } from './codeAgentRightPanelStore';
import { parseWorkspaceFileOpenTarget } from './workspaceFileOpenTarget';

interface OpenCodeAgentDiffFilePrimaryActionInput {
  roomId?: string | null;
  filePath: string;
  openInWorkspaceFileViewer?: (filePath: string) => void;
  openFallback?: (filePath: string) => void;
}

export function openCodeAgentDiffFilePrimaryAction({
  roomId,
  filePath,
  openInWorkspaceFileViewer,
  openFallback,
}: OpenCodeAgentDiffFilePrimaryActionInput): void {
  const normalizedFilePath = filePath.trim();
  if (!normalizedFilePath) {
    return;
  }

  const target = parseWorkspaceFileOpenTarget(normalizedFilePath);
  const roomKey = roomId?.trim();
  if (roomKey && target) {
    openCodeAgentRightPanelFile(roomKey, target.path, target.line);
    return;
  }

  if (openInWorkspaceFileViewer && target) {
    openInWorkspaceFileViewer(target.line ? `${target.path}#L${target.line}` : target.path);
    return;
  }

  openFallback?.(normalizedFilePath);
}
