const APP_HEIGHT_CSS_VAR = '--app-height';

const getViewportHeight = (win: Window) => {
  const visualHeight = win.visualViewport?.height;
  const height =
    typeof visualHeight === 'number' && Number.isFinite(visualHeight) && visualHeight > 0
      ? visualHeight
      : win.innerHeight;

  return Math.max(1, Math.round(height));
};

export const installAppViewportSizing = (win: Window = window) => {
  const root = win.document.documentElement;
  const viewport = win.visualViewport;
  let frameId: number | null = null;

  const updateViewportHeight = () => {
    frameId = null;
    root.style.setProperty(APP_HEIGHT_CSS_VAR, `${getViewportHeight(win)}px`);
  };

  const scheduleViewportHeightUpdate = () => {
    if (frameId !== null) {
      win.cancelAnimationFrame(frameId);
    }

    frameId = win.requestAnimationFrame(updateViewportHeight);
  };

  scheduleViewportHeightUpdate();

  win.addEventListener('resize', scheduleViewportHeightUpdate);
  win.addEventListener('orientationchange', scheduleViewportHeightUpdate);
  viewport?.addEventListener('resize', scheduleViewportHeightUpdate);

  return () => {
    win.removeEventListener('resize', scheduleViewportHeightUpdate);
    win.removeEventListener('orientationchange', scheduleViewportHeightUpdate);
    viewport?.removeEventListener('resize', scheduleViewportHeightUpdate);

    if (frameId !== null) {
      win.cancelAnimationFrame(frameId);
    }
  };
};
