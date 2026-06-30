import { describe, expect, it } from 'vitest';
import { getCodeAgentPanelResizeBounds, getSidebarMaxWidthForChat } from './codeAgentPanelLayout';

describe('getCodeAgentPanelResizeBounds', () => {
  it('preserves the preferred chat width on wide layouts', () => {
    expect(getCodeAgentPanelResizeBounds(2024)).toEqual({
      min: 420,
      max: 1544,
      chatMin: 480,
    });
  });

  it('preserves an absolute chat width before shrinking the file panel on narrower layouts', () => {
    expect(getCodeAgentPanelResizeBounds(744)).toEqual({
      min: 420,
      max: 420,
      chatMin: 324,
    });
  });

  it('allows the sidebar to consume only chat width above the reserved minimum', () => {
    expect(getSidebarMaxWidthForChat(280, 900, 480)).toBe(700);
    expect(getSidebarMaxWidthForChat(280, 480, 480)).toBe(280);
  });
});
