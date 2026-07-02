import { describe, expect, it } from 'vitest';
import {
  CODE_AGENT_PREVIEW_VIEWPORT_MAX_AREA,
  CODE_AGENT_PREVIEW_VIEWPORT_PRESETS,
  FILL_CODE_AGENT_PREVIEW_VIEWPORT,
  codeAgentPreviewViewportLabel,
  codeAgentPreviewViewportPresetOrientation,
  coerceCodeAgentPreviewViewportSetting,
  resolveCodeAgentPreviewViewport,
} from './codeAgentPreviewViewport';

describe('codeAgentPreviewViewport', () => {
  it('resolves fill, freeform, and preset viewport settings', () => {
    expect(resolveCodeAgentPreviewViewport({ mode: 'fill' })).toBe(FILL_CODE_AGENT_PREVIEW_VIEWPORT);
    expect(resolveCodeAgentPreviewViewport({ mode: 'freeform', width: 393.4, height: 851.6 })).toEqual({
      _tag: 'freeform',
      width: 393,
      height: 852,
    });
    expect(resolveCodeAgentPreviewViewport({ mode: 'preset', preset: 'iphone-12-pro' })).toEqual({
      _tag: 'preset',
      presetId: 'iphone-12-pro',
      width: 390,
      height: 844,
    });
    expect(resolveCodeAgentPreviewViewport({
      mode: 'preset',
      preset: 'iphone-12-pro',
      orientation: 'landscape',
    })).toEqual({
      _tag: 'preset',
      presetId: 'iphone-12-pro',
      width: 844,
      height: 390,
    });
  });

  it('keeps viewport presets ordered and labeled for the device toolbar', () => {
    expect(CODE_AGENT_PREVIEW_VIEWPORT_PRESETS.map((preset) => preset.id).slice(0, 4)).toEqual([
      'iphone-se',
      'iphone-xr',
      'iphone-12-pro',
      'iphone-14-pro-max',
    ]);
    expect(codeAgentPreviewViewportPresetOrientation(resolveCodeAgentPreviewViewport({
      mode: 'preset',
      preset: 'iphone-12-pro',
    }))).toBe('portrait');
    expect(codeAgentPreviewViewportLabel({ _tag: 'freeform', width: 390, height: 844 })).toBe('390 × 844');
    expect(codeAgentPreviewViewportLabel(FILL_CODE_AGENT_PREVIEW_VIEWPORT)).toBe('Fill panel');
  });

  it('coerces persisted viewport payloads through the same size limits', () => {
    expect(coerceCodeAgentPreviewViewportSetting({ _tag: 'fill' })).toBe(FILL_CODE_AGENT_PREVIEW_VIEWPORT);
    expect(coerceCodeAgentPreviewViewportSetting({
      _tag: 'freeform',
      width: 99999,
      height: 3840,
    })).toEqual({
      _tag: 'freeform',
      width: Math.floor(CODE_AGENT_PREVIEW_VIEWPORT_MAX_AREA / 3840),
      height: 3840,
    });
    expect(coerceCodeAgentPreviewViewportSetting({
      _tag: 'preset',
      presetId: 'pixel-7',
      width: 412,
      height: 915,
    })).toEqual({
      _tag: 'preset',
      presetId: 'pixel-7',
      width: 412,
      height: 915,
    });
    expect(coerceCodeAgentPreviewViewportSetting({
      _tag: 'preset',
      presetId: 'unknown-device',
      width: 412,
      height: 915,
    })).toBeNull();
  });
});
