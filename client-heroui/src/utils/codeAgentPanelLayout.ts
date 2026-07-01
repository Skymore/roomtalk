export const CODE_AGENT_FILE_PANEL_MIN_WIDTH = 360;
export const CODE_AGENT_FILE_PANEL_PREFERRED_MIN_WIDTH = 420;
export const CODE_AGENT_FILE_PANEL_COLLAPSED_WIDTH = 48;
export const CODE_AGENT_CHAT_ABSOLUTE_MIN_WIDTH = 360;
export const CODE_AGENT_CHAT_SIDEBAR_MIN_WIDTH = 480;
export const CODE_AGENT_FILE_PANEL_WIDTH_CHANGE_EVENT = 'roomtalk:code-agent-file-panel-width-change';

export interface CodeAgentPanelResizeBounds {
  min: number;
  max: number;
  chatMin: number;
}

export interface CodeAgentFilePanelWidthChangeDetail {
  width: number;
}

export function getCodeAgentPanelResizeBounds(
  availableWidth: number,
  chatMinWidth: number = CODE_AGENT_CHAT_ABSOLUTE_MIN_WIDTH,
): CodeAgentPanelResizeBounds {
  const width = Math.max(0, Math.floor(availableWidth));
  const targetChatMin = Math.max(0, Math.floor(chatMinWidth));
  const min = Math.min(
    CODE_AGENT_FILE_PANEL_MIN_WIDTH,
    Math.max(0, width - targetChatMin),
  );
  const chatMin = Math.min(
    targetChatMin,
    Math.max(0, width - min),
  );
  const maxByChat = Math.max(min, width - chatMin);
  return {
    min,
    max: Math.max(min, maxByChat),
    chatMin,
  };
}

export function clampCodeAgentFilePanelWidth(width: number, availableWidth: number): number {
  const bounds = getCodeAgentPanelResizeBounds(availableWidth);
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));
}

export function clampCodeAgentFilePanelWidthForSidebarResize(
  filePanelWidth: number,
  shellWidth: number,
  sidebarWidth: number,
  chatMinWidth: number = CODE_AGENT_CHAT_ABSOLUTE_MIN_WIDTH,
): number {
  const bounds = getCodeAgentPanelResizeBounds(
    Math.max(0, Math.floor(shellWidth) - Math.floor(sidebarWidth)),
    chatMinWidth,
  );
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(filePanelWidth)));
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
