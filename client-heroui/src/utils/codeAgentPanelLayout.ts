export const CODE_AGENT_FILE_PANEL_PREFERRED_MIN_WIDTH = 420;
export const CODE_AGENT_FILE_PANEL_COLLAPSED_WIDTH = 48;
export const CODE_AGENT_CHAT_ABSOLUTE_MIN_WIDTH = 320;

export interface CodeAgentPanelResizeBounds {
  min: number;
  max: number;
  chatMin: number;
}

export function getCodeAgentPanelResizeBounds(availableWidth: number): CodeAgentPanelResizeBounds {
  const width = Math.max(0, Math.floor(availableWidth));
  const min = Math.min(
    CODE_AGENT_FILE_PANEL_PREFERRED_MIN_WIDTH,
    Math.max(0, width - CODE_AGENT_CHAT_ABSOLUTE_MIN_WIDTH),
  );
  const chatMin = Math.min(
    CODE_AGENT_CHAT_ABSOLUTE_MIN_WIDTH,
    Math.max(0, width - min),
  );
  return {
    min,
    max: Math.max(min, width - chatMin),
    chatMin,
  };
}

export function clampCodeAgentFilePanelWidth(width: number, availableWidth: number): number {
  const bounds = getCodeAgentPanelResizeBounds(availableWidth);
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));
}

export function getSidebarMaxWidthForChat(
  sidebarWidth: number,
  chatWidth: number,
  chatMin: number,
): number {
  return Math.floor(sidebarWidth + chatWidth - chatMin);
}

export function getSidebarMaxWidthForCodeAgentShell(
  shellWidth: number,
  filePanelReservedWidth: number,
  chatMin: number = CODE_AGENT_CHAT_ABSOLUTE_MIN_WIDTH,
): number {
  return Math.floor(
    Math.max(0, shellWidth)
    - Math.max(0, filePanelReservedWidth)
    - Math.max(0, chatMin),
  );
}

export function getSidebarMaxWidthForCodeAgentLayout(
  sidebarWidth: number,
  workspaceWidth: number,
  filePanelWidth: number,
  chatMin: number = CODE_AGENT_CHAT_ABSOLUTE_MIN_WIDTH,
): number {
  return getSidebarMaxWidthForCodeAgentShell(
    Math.max(0, sidebarWidth)
    + Math.max(0, workspaceWidth),
    filePanelWidth,
    chatMin,
  );
}
