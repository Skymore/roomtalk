const APP_HEIGHT_CSS_VAR = '--app-height';
const APP_VIEWPORT_TOP_CSS_VAR = '--app-viewport-top';

const getViewportHeight = (win: Window) => {
  const visualHeight = win.visualViewport?.height;
  const height =
    typeof visualHeight === 'number' && Number.isFinite(visualHeight) && visualHeight > 0
      ? visualHeight
      : win.innerHeight;

  return Math.max(1, Math.round(height));
};

const getViewportTop = (win: Window) => {
  const offsetTop = win.visualViewport?.offsetTop;

  return Math.max(
    0,
    Math.round(typeof offsetTop === 'number' && Number.isFinite(offsetTop) ? offsetTop : 0)
  );
};

export const installAppViewportSizing = (win: Window = window) => {
  const root = win.document.documentElement;
  const viewport = win.visualViewport;
  let frameId: number | null = null;
  let hasPendingFrame = false;
  let pendingUpdate: 'all' | 'top' = 'all';

  const updateViewport = () => {
    const updateKind = pendingUpdate;
    hasPendingFrame = false;
    frameId = null;

    if (updateKind === 'all') {
      root.style.setProperty(APP_HEIGHT_CSS_VAR, `${getViewportHeight(win)}px`);
    }

    root.style.setProperty(APP_VIEWPORT_TOP_CSS_VAR, `${getViewportTop(win)}px`);
  };

  const scheduleViewportUpdate = (updateKind: 'all' | 'top') => {
    if (!hasPendingFrame || updateKind === 'all') {
      pendingUpdate = updateKind;
    }

    if (hasPendingFrame && frameId !== null) {
      win.cancelAnimationFrame(frameId);
    }

    hasPendingFrame = true;
    frameId = win.requestAnimationFrame(updateViewport);
  };

  const scheduleFullViewportUpdate = () => scheduleViewportUpdate('all');
  const scheduleViewportTopUpdate = () => scheduleViewportUpdate('top');

  scheduleFullViewportUpdate();

  win.addEventListener('resize', scheduleFullViewportUpdate);
  win.addEventListener('orientationchange', scheduleFullViewportUpdate);
  viewport?.addEventListener('resize', scheduleFullViewportUpdate);
  viewport?.addEventListener('scroll', scheduleViewportTopUpdate);

  return () => {
    win.removeEventListener('resize', scheduleFullViewportUpdate);
    win.removeEventListener('orientationchange', scheduleFullViewportUpdate);
    viewport?.removeEventListener('resize', scheduleFullViewportUpdate);
    viewport?.removeEventListener('scroll', scheduleViewportTopUpdate);

    if (hasPendingFrame && frameId !== null) {
      win.cancelAnimationFrame(frameId);
    }
  };
};
