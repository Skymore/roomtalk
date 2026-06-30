import { describe, expect, it } from 'vitest';
import {
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
      max: 1400,
      chatMin: 480,
    });
  });

  it('matches T3-style max width caps on very wide layouts', () => {
    expect(getCodeAgentPanelResizeBounds(3440)).toEqual({
      min: 360,
      max: 1400,
      chatMin: 480,
    });
  });

  it('uses T3-style viewport fraction caps before the absolute max', () => {
    expect(getCodeAgentPanelResizeBounds(1800)).toEqual({
      min: 360,
      max: 1260,
      chatMin: 480,
    });
  });

  it('preserves an absolute chat width before shrinking the file panel on narrower layouts', () => {
    expect(getCodeAgentPanelResizeBounds(744)).toEqual({
      min: 264,
      max: 264,
      chatMin: 480,
    });
  });

  it('allows the sidebar to consume only chat width above the reserved minimum', () => {
    expect(getSidebarMaxWidthForChat(280, 900, 480)).toBe(700);
    expect(getSidebarMaxWidthForChat(280, 480, 480)).toBe(280);
  });

  it('keeps left sidebar resizing from consuming the code-agent chat pane', () => {
    expect(getSidebarMaxWidthForCodeAgentLayout(320, 1280, 960)).toBe(160);
    expect(getSidebarMaxWidthForCodeAgentLayout(320, 1280, 760)).toBe(360);
  });

  it('bases code-agent sidebar resizing on the full shell width and reserved right panel width', () => {
    expect(getSidebarMaxWidthForCodeAgentShell(1280, 360)).toBe(440);
    expect(getSidebarMaxWidthForCodeAgentShell(1280, 48)).toBe(752);
  });

  it('shrinks the right file panel during left sidebar resizing before chat can disappear', () => {
    expect(clampCodeAgentFilePanelWidthForSidebarResize(760, 1600, 860)).toBe(260);
    expect(clampCodeAgentFilePanelWidthForSidebarResize(760, 1600, 520)).toBe(600);
  });
});
