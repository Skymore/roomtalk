import { describe, expect, it } from 'vitest';
import { codeAgentBrowserViewportSettingKey } from './codeAgentBrowserViewportLayout';
import { isCodeWorkspacePreviewViewportReady } from './codeWorkspacePreviewViewportReadiness';

describe('codeWorkspacePreviewViewportReadiness', () => {
  const landscape = {
    _tag: 'preset',
    width: 844,
    height: 390,
    presetId: 'iphone-12-pro',
  } as const;

  it('rejects stale rendered viewport state while a preset orientation is applying', () => {
    expect(isCodeWorkspacePreviewViewportReady({
      setting: landscape,
      appliedSettingKey: 'preset:390:844:iphone-12-pro',
      declaredViewport: { width: 390, height: 844 },
      renderedViewport: { width: 390, height: 844 },
    })).toBe(false);
  });

  it('requires declared and rendered viewports to match the requested fixed viewport', () => {
    const appliedSettingKey = codeAgentBrowserViewportSettingKey(landscape);
    expect(isCodeWorkspacePreviewViewportReady({
      setting: landscape,
      appliedSettingKey,
      declaredViewport: { width: 390, height: 844 },
      renderedViewport: { width: 844, height: 390 },
    })).toBe(false);
    expect(isCodeWorkspacePreviewViewportReady({
      setting: landscape,
      appliedSettingKey,
      declaredViewport: { width: 844, height: 390 },
      renderedViewport: { width: 844, height: 390 },
    })).toBe(true);
  });

  it('allows one pixel of rendering tolerance in every mode', () => {
    expect(isCodeWorkspacePreviewViewportReady({
      setting: { _tag: 'fill' },
      appliedSettingKey: 'fill',
      declaredViewport: { width: 500, height: 700 },
      renderedViewport: { width: 501, height: 699 },
    })).toBe(true);
    expect(isCodeWorkspacePreviewViewportReady({
      setting: landscape,
      appliedSettingKey: codeAgentBrowserViewportSettingKey(landscape),
      declaredViewport: { width: 844, height: 390 },
      renderedViewport: { width: 845, height: 389 },
    })).toBe(true);
    expect(isCodeWorkspacePreviewViewportReady({
      setting: landscape,
      appliedSettingKey: codeAgentBrowserViewportSettingKey(landscape),
      declaredViewport: { width: 844, height: 390 },
      renderedViewport: { width: 846, height: 390 },
    })).toBe(false);
  });
});
