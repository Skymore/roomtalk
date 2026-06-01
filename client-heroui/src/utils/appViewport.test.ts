// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installAppViewportSizing } from './appViewport';

const createVisualViewport = (initialHeight: number, initialOffsetTop = 0) => {
  const target = new EventTarget();

  return {
    get height() {
      return initialHeight;
    },
    set height(nextHeight: number) {
      initialHeight = nextHeight;
    },
    get offsetTop() {
      return initialOffsetTop;
    },
    set offsetTop(nextOffsetTop: number) {
      initialOffsetTop = nextOffsetTop;
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatch(type: string) {
      target.dispatchEvent(new Event(type));
    },
  };
};

const setVisualViewport = (viewport: ReturnType<typeof createVisualViewport> | undefined) => {
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: viewport,
  });
};

describe('installAppViewportSizing', () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty('--app-height');
    document.documentElement.style.removeProperty('--app-viewport-top');
    document.documentElement.style.removeProperty('--app-keyboard-inset');
    document.body.innerHTML = '';

    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 800,
    });

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setVisualViewport(undefined);
  });

  const focusEditable = () => {
    const editor = document.createElement('input');
    document.body.appendChild(editor);
    editor.focus();
    return editor;
  };

  it('uses a stable layout height and initializes keyboard vars', () => {
    const viewport = createVisualViewport(640);
    setVisualViewport(viewport);

    const cleanup = installAppViewportSizing();

    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('800px');
    expect(document.documentElement.style.getPropertyValue('--app-viewport-top')).toBe('0px');
    expect(document.documentElement.style.getPropertyValue('--app-keyboard-inset')).toBe('0px');

    cleanup();
  });

  it('keeps app height stable when the visual viewport shrinks around a focused editor', () => {
    const viewport = createVisualViewport(640);
    setVisualViewport(viewport);

    const cleanup = installAppViewportSizing();
    focusEditable();

    viewport.height = 420;
    viewport.offsetTop = 24;
    viewport.dispatch('resize');

    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('800px');
    expect(document.documentElement.style.getPropertyValue('--app-viewport-top')).toBe('24px');
    expect(document.documentElement.style.getPropertyValue('--app-keyboard-inset')).toBe('380px');

    cleanup();

    viewport.height = 360;
    viewport.offsetTop = 48;
    viewport.dispatch('resize');

    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('800px');
    expect(document.documentElement.style.getPropertyValue('--app-viewport-top')).toBe('24px');
    expect(document.documentElement.style.getPropertyValue('--app-keyboard-inset')).toBe('380px');
  });

  it('updates keyboard overlay vars on mobile keyboard panning without changing height', () => {
    const viewport = createVisualViewport(640);
    setVisualViewport(viewport);

    const cleanup = installAppViewportSizing();
    focusEditable();

    viewport.height = 420;
    viewport.offsetTop = 180;
    viewport.dispatch('scroll');

    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('800px');
    expect(document.documentElement.style.getPropertyValue('--app-viewport-top')).toBe('180px');
    expect(document.documentElement.style.getPropertyValue('--app-keyboard-inset')).toBe('380px');

    cleanup();
  });

  it('falls back to window.innerHeight when visualViewport is unavailable', () => {
    setVisualViewport(undefined);

    const cleanup = installAppViewportSizing();

    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('800px');
    expect(document.documentElement.style.getPropertyValue('--app-viewport-top')).toBe('0px');
    expect(document.documentElement.style.getPropertyValue('--app-keyboard-inset')).toBe('0px');

    cleanup();
  });
});
