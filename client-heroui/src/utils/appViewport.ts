const APP_HEIGHT_CSS_VAR = '--app-height';
const APP_VIEWPORT_TOP_CSS_VAR = '--app-viewport-top';
const KEYBOARD_OPEN_CLASS = 'roomtalk-keyboard-open';
const LEGACY_EDITING_CLASS = 'roomtalk-editing';
const KEYBOARD_HEIGHT_THRESHOLD_PX = 120;

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

const isEditableElement = (element: Element | null) => {
  if (!element) return false;

  const tagName = element.tagName.toLowerCase();

  if (tagName === 'input' || tagName === 'textarea') {
    const input = element as HTMLInputElement | HTMLTextAreaElement;
    return !input.readOnly && !input.disabled;
  }

  return element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false';
};

export const installAppViewportSizing = (win: Window = window) => {
  const root = win.document.documentElement;
  const viewport = win.visualViewport;
  let expandedViewportHeight = Math.max(win.innerHeight, getViewportHeight(win));
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

    const viewportHeight = getViewportHeight(win);
    const isEditableFocused = isEditableElement(win.document.activeElement);

    if (!isEditableFocused || viewportHeight > expandedViewportHeight) {
      expandedViewportHeight = Math.max(win.innerHeight, viewportHeight);
    }

    const isKeyboardOpen = isEditableFocused && expandedViewportHeight - viewportHeight > KEYBOARD_HEIGHT_THRESHOLD_PX;
    root.classList.toggle(KEYBOARD_OPEN_CLASS, isKeyboardOpen);
    root.classList.remove(LEGACY_EDITING_CLASS);
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
  const handleOrientationChange = () => {
    expandedViewportHeight = Math.max(win.innerHeight, getViewportHeight(win));
    scheduleFullViewportUpdate();
  };

  scheduleFullViewportUpdate();

  win.addEventListener('resize', scheduleFullViewportUpdate);
  win.addEventListener('orientationchange', handleOrientationChange);
  win.document.addEventListener('focusin', scheduleFullViewportUpdate);
  win.document.addEventListener('focusout', scheduleFullViewportUpdate);
  viewport?.addEventListener('resize', scheduleFullViewportUpdate);
  viewport?.addEventListener('scroll', scheduleViewportTopUpdate);

  return () => {
    win.removeEventListener('resize', scheduleFullViewportUpdate);
    win.removeEventListener('orientationchange', handleOrientationChange);
    win.document.removeEventListener('focusin', scheduleFullViewportUpdate);
    win.document.removeEventListener('focusout', scheduleFullViewportUpdate);
    viewport?.removeEventListener('resize', scheduleFullViewportUpdate);
    viewport?.removeEventListener('scroll', scheduleViewportTopUpdate);

    if (hasPendingFrame && frameId !== null) {
      win.cancelAnimationFrame(frameId);
    }

    root.classList.remove(KEYBOARD_OPEN_CLASS);
    root.classList.remove(LEGACY_EDITING_CLASS);
  };
};
