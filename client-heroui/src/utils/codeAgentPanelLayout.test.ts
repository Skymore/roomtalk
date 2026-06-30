import { describe, expect, it } from 'vitest';
import {
  getCodeAgentPanelResizeBounds,
  getSidebarMaxWidthForChat,
  getSidebarMaxWidthForCodeAgentLayout,
  getSidebarMaxWidthForCodeAgentShell,
} from './codeAgentPanelLayout';

describe('getCodeAgentPanelResizeBounds', () => {
  it('preserves the absolute chat width on wide layouts', () => {
    expect(getCodeAgentPanelResizeBounds(2024)).toEqual({
      min: 420,
      max: 1704,
      chatMin: 320,
    });
  });

  it('preserves an absolute chat width before shrinking the file panel on narrower layouts', () => {
    expect(getCodeAgentPanelResizeBounds(744)).toEqual({
      min: 420,
      max: 424,
      chatMin: 320,
    });
  });

  it('allows the sidebar to consume only chat width above the reserved minimum', () => {
    expect(getSidebarMaxWidthForChat(280, 900, 480)).toBe(700);
    expect(getSidebarMaxWidthForChat(280, 480, 480)).toBe(280);
  });

  it('keeps left sidebar resizing from consuming the code-agent chat pane', () => {
    expect(getSidebarMaxWidthForCodeAgentLayout(320, 1280, 960)).toBe(320);
    expect(getSidebarMaxWidthForCodeAgentLayout(320, 1280, 760)).toBe(520);
  });

  it('bases code-agent sidebar resizing on the full shell width and reserved right panel width', () => {
    expect(getSidebarMaxWidthForCodeAgentShell(1280, 420)).toBe(540);
    expect(getSidebarMaxWidthForCodeAgentShell(1280, 48)).toBe(912);
  });
});
