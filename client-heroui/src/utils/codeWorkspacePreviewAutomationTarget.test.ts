import { describe, expect, it } from 'vitest';
import type { CodeWorkspacePreviewSession } from './codeWorkspacePreviewSessions';
import {
  needsCodeWorkspacePreviewAutomationSessionSync,
  resolveCodeWorkspacePreviewAutomationOpenTab,
  resolveCodeWorkspacePreviewAutomationTarget,
} from './codeWorkspacePreviewAutomationTarget';

const snapshot = (tabId: string): CodeWorkspacePreviewSession => ({
  roomId: 'room-1',
  tabId,
  navStatus: { _tag: 'Idle' },
  canGoBack: false,
  canGoForward: false,
  viewport: { _tag: 'fill' },
  updatedAt: '2026-07-02T00:00:00.000Z',
});

describe('code workspace preview automation target selection', () => {
  it('refreshes authoritative sessions whenever the caller relies on the active tab', () => {
    const active = snapshot('tab-active');
    expect(
      needsCodeWorkspacePreviewAutomationSessionSync(
        { snapshot: active, sessions: { [active.tabId]: active } },
        undefined,
      ),
    ).toBe(true);
  });

  it('refreshes an explicit tab only when it is absent locally', () => {
    const active = snapshot('tab-active');
    const state = { snapshot: active, sessions: { [active.tabId]: active } };

    expect(needsCodeWorkspacePreviewAutomationSessionSync(state, active.tabId)).toBe(false);
    expect(needsCodeWorkspacePreviewAutomationSessionSync(state, 'tab-missing')).toBe(true);
  });

  it('does not report the active tab under an unknown requested tab id', () => {
    const active = snapshot('tab-active');

    expect(
      resolveCodeWorkspacePreviewAutomationTarget(
        { snapshot: active, sessions: { [active.tabId]: active } },
        'tab-missing',
      ),
    ).toEqual({ tabId: null, snapshot: null });
  });

  it('reuses the provider session tab instead of the mutable UI tab', () => {
    const uiActive = snapshot('tab-ui-active');
    const agentTab = snapshot('tab-opened-by-agent');
    const state = {
      snapshot: uiActive,
      sessions: { [uiActive.tabId]: uiActive, [agentTab.tabId]: agentTab },
    };

    expect(resolveCodeWorkspacePreviewAutomationOpenTab(state, agentTab.tabId, true)).toBe(agentTab.tabId);
    expect(resolveCodeWorkspacePreviewAutomationOpenTab(state, undefined, true)).toBe(uiActive.tabId);
    expect(resolveCodeWorkspacePreviewAutomationOpenTab(state, agentTab.tabId, false)).toBeNull();
  });
});
