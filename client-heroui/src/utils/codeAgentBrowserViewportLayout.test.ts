import { describe, expect, it } from 'vitest';
import {
  CODE_AGENT_BROWSER_DEVICE_TOOLBAR_HEIGHT,
  CODE_AGENT_BROWSER_VIEWPORT_RESIZE_RAIL_SIZE,
  resizeCodeAgentBrowserViewportFromRail,
  resolveCodeAgentBrowserDeviceViewportArea,
  resolveCodeAgentBrowserDeviceViewportLayout,
  resolveCodeAgentBrowserViewportLayout,
  resolveResponsiveCodeAgentBrowserViewportSize,
} from './codeAgentBrowserViewportLayout';

describe('codeAgentBrowserViewportLayout', () => {
  it('fills the panel for responsive preview mode', () => {
    expect(resolveCodeAgentBrowserViewportLayout(
      { width: 900, height: 600 },
      { _tag: 'fill' },
      1.25,
    )).toEqual({
      canvasWidth: 900,
      canvasHeight: 600,
      viewportX: 0,
      viewportY: 0,
      viewportWidth: 900,
      viewportHeight: 600,
      viewportScale: 1,
      fillsPanel: true,
    });
  });

  it('centers fixed viewports and scales them down when needed', () => {
    const layout = resolveCodeAgentBrowserViewportLayout(
      { width: 1000, height: 800 },
      { _tag: 'freeform', width: 390, height: 844 },
    );

    expect(layout.fillsPanel).toBe(false);
    expect(layout.viewportScale).toBeCloseTo(800 / 844);
    expect(layout.viewportWidth).toBeCloseTo(390 * (800 / 844));
    expect(layout.viewportHeight).toBeCloseTo(800);
    expect(layout.viewportX).toBe(Math.round((1000 - layout.viewportWidth) / 2));
    expect(layout.viewportY).toBe(0);
  });

  it('reserves toolbar and rail space for device viewport mode', () => {
    const area = resolveCodeAgentBrowserDeviceViewportArea({ width: 430, height: 932 });
    expect(area).toEqual({
      width: 430 - CODE_AGENT_BROWSER_VIEWPORT_RESIZE_RAIL_SIZE * 2,
      height: 932 - CODE_AGENT_BROWSER_DEVICE_TOOLBAR_HEIGHT - CODE_AGENT_BROWSER_VIEWPORT_RESIZE_RAIL_SIZE,
    });

    const layout = resolveCodeAgentBrowserDeviceViewportLayout(
      { width: 430, height: 932 },
      { _tag: 'freeform', width: 390, height: 844 },
    );
    expect(layout.canvasWidth).toBe(430);
    expect(layout.canvasHeight).toBe(932);
    expect(layout.viewportWidth).toBe(390);
    expect(layout.viewportHeight).toBe(844);
    expect(layout.viewportX).toBe(20);
    expect(layout.viewportY).toBe(55);
  });

  it('keeps rail resizing continuous after the viewport reaches the available edge', () => {
    expect(resizeCodeAgentBrowserViewportFromRail(
      { width: 500, height: 500 },
      { x: 100, y: 0 },
      { width: 700, height: 700 },
      1,
      'east',
    )).toEqual({ width: 700, height: 500 });

    expect(resizeCodeAgentBrowserViewportFromRail(
      { width: 500, height: 500 },
      { x: 200, y: 0 },
      { width: 700, height: 700 },
      1,
      'east',
    )).toEqual({ width: 800, height: 500 });
  });

  it('derives an editable responsive viewport from the visible preview area', () => {
    expect(resolveResponsiveCodeAgentBrowserViewportSize({ width: 390, height: 844 })).toEqual({
      width: 370,
      height: 802,
    });
    expect(resolveResponsiveCodeAgentBrowserViewportSize({ width: 390, height: 844 }, 2)).toEqual({
      width: 240,
      height: 401,
    });
  });
});
