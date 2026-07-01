import { describe, expect, it } from 'vitest';
import {
  CODE_AGENT_CHAT_SIDEBAR_MIN_WIDTH,
  clampCodeAgentFilePanelWidthForSidebarResize,
  getCodeAgentPanelResizeBounds,
  getSidebarMaxWidthForChat,
  getSidebarMaxWidthForCodeAgentLayout,
  getSidebarMaxWidthForCodeAgentShell,
} from './codeAgentPanelLayout';

describe('getCodeAgentPanelResizeBounds', () => {
  it('preserves the absolute chat width on wide layouts', () => {
    expect(getCodeAgentPanelResizeBounds(2024)).toEqual({
      min: 360,
      max: 1664,
      chatMin: 360,
    });
  });

  it('uses the available wide layout while preserving the chat pane', () => {
    expect(getCodeAgentPanelResizeBounds(3440)).toEqual({
      min: 360,
      max: 3080,
      chatMin: 360,
    });
  });

  it('avoids viewport fraction caps before the chat-preserving cap', () => {
    expect(getCodeAgentPanelResizeBounds(1800)).toEqual({
      min: 360,
      max: 1440,
      chatMin: 360,
    });
  });

  it('preserves an absolute chat width before shrinking the file panel on narrower layouts', () => {
    expect(getCodeAgentPanelResizeBounds(744)).toEqual({
      min: 360,
      max: 384,
      chatMin: 360,
    });
  });

  it('can reserve a larger chat width for left sidebar resizing', () => {
    expect(getCodeAgentPanelResizeBounds(840, CODE_AGENT_CHAT_SIDEBAR_MIN_WIDTH)).toEqual({
      min: 360,
      max: 360,
      chatMin: 480,
    });
  });

  it('allows the sidebar to consume only chat width above the reserved minimum', () => {
    expect(getSidebarMaxWidthForChat(280, 900, 480)).toBe(700);
    expect(getSidebarMaxWidthForChat(280, 480, 480)).toBe(280);
  });

  it('keeps left sidebar resizing from consuming the code-agent chat pane', () => {
    expect(getSidebarMaxWidthForCodeAgentLayout(320, 1280, 960)).toBe(280);
    expect(getSidebarMaxWidthForCodeAgentLayout(320, 1280, 760)).toBe(480);
  });

  it('bases code-agent sidebar resizing on the full shell width and reserved right panel width', () => {
    expect(getSidebarMaxWidthForCodeAgentShell(1280, 360)).toBe(560);
    expect(getSidebarMaxWidthForCodeAgentShell(1280, 360, CODE_AGENT_CHAT_SIDEBAR_MIN_WIDTH)).toBe(440);
    expect(getSidebarMaxWidthForCodeAgentShell(1280, 48)).toBe(872);
  });

  it('shrinks the right file panel during left sidebar resizing before chat can disappear', () => {
    expect(clampCodeAgentFilePanelWidthForSidebarResize(760, 1600, 860)).toBe(380);
    expect(clampCodeAgentFilePanelWidthForSidebarResize(760, 1600, 520)).toBe(720);
    expect(clampCodeAgentFilePanelWidthForSidebarResize(
      760,
      1600,
      760,
      CODE_AGENT_CHAT_SIDEBAR_MIN_WIDTH,
    )).toBe(360);
  });
});
