const APP_HEIGHT_CSS_VAR = '--app-height';
const APP_VIEWPORT_TOP_CSS_VAR = '--app-viewport-top';
const APP_KEYBOARD_INSET_CSS_VAR = '--app-keyboard-inset';

const getFinitePositiveNumber = (value: number | undefined, fallback: number) => {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
};

const getViewportHeight = (win: Window) => {
  return Math.max(1, Math.round(getFinitePositiveNumber(win.innerHeight, 1)));
};

const getViewportTop = (win: Window) => {
  const offsetTop = win.visualViewport?.offsetTop;

  return Math.max(
    0,
    Math.round(typeof offsetTop === 'number' && Number.isFinite(offsetTop) ? offsetTop : 0)
  );
};

const isEditableElement = (element: Element | null) => {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  return (
    element.isContentEditable ||
    element.getAttribute('contenteditable') === 'true' ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'INPUT'
  );
};

const getKeyboardInset = (win: Window, layoutHeight: number) => {
  if (!isEditableElement(win.document.activeElement)) {
    return 0;
  }

  const visualHeight = getFinitePositiveNumber(win.visualViewport?.height, layoutHeight);

  return Math.max(0, Math.round(layoutHeight - visualHeight));
};

export const installAppViewportSizing = (win: Window = window) => {
  const root = win.document.documentElement;
  const viewport = win.visualViewport;
  let frameId: number | null = null;
  let hasPendingFrame = false;
  let pendingUpdate: 'all' | 'keyboard' = 'all';
  let layoutHeight = getViewportHeight(win);
  let layoutWidth = Math.max(1, Math.round(getFinitePositiveNumber(win.innerWidth, 1)));

  const updateViewport = () => {
    const updateKind = pendingUpdate;
    hasPendingFrame = false;
    frameId = null;

    if (updateKind === 'all') {
      const nextWidth = Math.max(1, Math.round(getFinitePositiveNumber(win.innerWidth, layoutWidth)));
      const nextHeight = getViewportHeight(win);

      if (nextWidth !== layoutWidth || !isEditableElement(win.document.activeElement)) {
        layoutHeight = nextHeight;
        layoutWidth = nextWidth;
      } else {
        layoutHeight = Math.max(layoutHeight, nextHeight);
      }

      root.style.setProperty(APP_HEIGHT_CSS_VAR, `${layoutHeight}px`);
    }

    root.style.setProperty(APP_VIEWPORT_TOP_CSS_VAR, `${getViewportTop(win)}px`);
    root.style.setProperty(APP_KEYBOARD_INSET_CSS_VAR, `${getKeyboardInset(win, layoutHeight)}px`);
  };

  const scheduleViewportUpdate = (updateKind: 'all' | 'keyboard') => {
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
  const scheduleKeyboardViewportUpdate = () => scheduleViewportUpdate('keyboard');

  scheduleFullViewportUpdate();

  win.addEventListener('resize', scheduleFullViewportUpdate);
  win.addEventListener('orientationchange', scheduleFullViewportUpdate);
  viewport?.addEventListener('resize', scheduleKeyboardViewportUpdate);
  viewport?.addEventListener('scroll', scheduleKeyboardViewportUpdate);
  win.document.addEventListener('focusin', scheduleKeyboardViewportUpdate);
  win.document.addEventListener('focusout', scheduleKeyboardViewportUpdate);

  return () => {
    win.removeEventListener('resize', scheduleFullViewportUpdate);
    win.removeEventListener('orientationchange', scheduleFullViewportUpdate);
    viewport?.removeEventListener('resize', scheduleKeyboardViewportUpdate);
    viewport?.removeEventListener('scroll', scheduleKeyboardViewportUpdate);
    win.document.removeEventListener('focusin', scheduleKeyboardViewportUpdate);
    win.document.removeEventListener('focusout', scheduleKeyboardViewportUpdate);

    if (hasPendingFrame && frameId !== null) {
      win.cancelAnimationFrame(frameId);
    }
  };
};
