export interface HorizontalResizeBounds {
  min: number;
  max: number;
}

interface HorizontalResizeOptions {
  pointerId: number;
  startX: number;
  initialWidth: number;
  direction: 1 | -1;
  captureTarget: HTMLElement;
  getBounds: () => HorizontalResizeBounds;
  onResize: (width: number) => void;
  onFinish: (width: number) => void;
}

let activeResize: (() => void) | null = null;

const clampWidth = (width: number, bounds: HorizontalResizeBounds): number => {
  const min = Math.max(0, Math.round(bounds.min));
  const max = Math.max(min, Math.round(bounds.max));
  return Math.min(max, Math.max(min, Math.round(width)));
};

const isPrimaryButtonReleased = (event: MouseEvent | PointerEvent): boolean => {
  if ((event.buttons & 1) === 0) {
    return true;
  }
  return 'pointerType' in event && event.pointerType === 'mouse' && event.pressure === 0;
};

const isMouseLikePointer = (event: PointerEvent): boolean => (
  event.pointerType === 'mouse' ||
  event.pointerType === '' ||
  typeof event.pointerType !== 'string'
);

export function beginHorizontalResize({
  pointerId,
  startX,
  initialWidth,
  direction,
  captureTarget,
  getBounds,
  onResize,
  onFinish,
}: HorizontalResizeOptions): () => void {
  activeResize?.();

  const startWidth = clampWidth(initialWidth, getBounds());
  let width = startWidth;
  let animationFrame: number | null = null;
  let finished = false;
  let pointerCaptureElement: HTMLElement | null = null;
  const previousUserSelect = document.body.style.userSelect;
  const previousCursor = document.body.style.cursor;
  const resizeGuard = document.createElement('div');
  const rootElement = document.documentElement;

  resizeGuard.dataset.horizontalResizeGuard = 'true';
  resizeGuard.style.position = 'fixed';
  resizeGuard.style.inset = '0';
  resizeGuard.style.zIndex = '2147483647';
  resizeGuard.style.cursor = 'col-resize';
  resizeGuard.style.touchAction = 'none';
  resizeGuard.style.userSelect = 'none';
  resizeGuard.style.pointerEvents = 'auto';

  const applyWidth = () => {
    animationFrame = null;
    onResize(width);
  };

  const applyClientX = (clientX: number) => {
    const rawWidth = startWidth + ((clientX - startX) * direction);
    const nextWidth = clampWidth(rawWidth, getBounds());
    width = nextWidth;
    if (animationFrame === null) {
      animationFrame = window.requestAnimationFrame(applyWidth);
    }
  };

  const removeListeners = () => {
    window.removeEventListener('pointermove', handlePointerMove, true);
    window.removeEventListener('pointerenter', handlePointerReleaseProbe, true);
    window.removeEventListener('pointerover', handlePointerReleaseProbe, true);
    window.removeEventListener('pointerout', handlePointerReleaseProbe, true);
    window.removeEventListener('pointerleave', handlePointerViewportLeave, true);
    window.removeEventListener('pointerup', handlePointerEnd, true);
    window.removeEventListener('pointercancel', handlePointerEnd, true);
    window.removeEventListener('mouseup', handleMouseUp, true);
    window.removeEventListener('mousemove', handleMouseMove, true);
    window.removeEventListener('mouseenter', handleMouseReleaseProbe, true);
    window.removeEventListener('mouseover', handleMouseReleaseProbe, true);
    window.removeEventListener('mouseout', handleMouseReleaseProbe, true);
    window.removeEventListener('mouseleave', handleMouseViewportLeave, true);
    window.removeEventListener('contextmenu', finishResize, true);
    window.removeEventListener('dragend', finishResize, true);
    document.removeEventListener('pointerup', handlePointerEnd, true);
    document.removeEventListener('pointercancel', handlePointerEnd, true);
    document.removeEventListener('pointerenter', handlePointerReleaseProbe, true);
    document.removeEventListener('pointerover', handlePointerReleaseProbe, true);
    document.removeEventListener('pointerout', handlePointerReleaseProbe, true);
    document.removeEventListener('pointerleave', handlePointerViewportLeave, true);
    document.removeEventListener('mouseup', handleMouseUp, true);
    document.removeEventListener('mousemove', handleMouseMove, true);
    document.removeEventListener('mouseenter', handleMouseReleaseProbe, true);
    document.removeEventListener('mouseover', handleMouseReleaseProbe, true);
    document.removeEventListener('mouseout', handleMouseReleaseProbe, true);
    document.removeEventListener('mouseleave', handleMouseViewportLeave, true);
    document.removeEventListener('contextmenu', finishResize, true);
    document.removeEventListener('dragend', finishResize, true);
    document.removeEventListener('click', handleMouseEnd, true);
    document.removeEventListener('auxclick', handleMouseEnd, true);
    rootElement.removeEventListener('pointerup', handlePointerEnd, true);
    rootElement.removeEventListener('pointercancel', handlePointerEnd, true);
    rootElement.removeEventListener('pointerdown', handlePointerRestart, true);
    rootElement.removeEventListener('mouseup', handleMouseUp, true);
    rootElement.removeEventListener('click', handleMouseEnd, true);
    rootElement.removeEventListener('auxclick', handleMouseEnd, true);
    window.removeEventListener('blur', finishResize);
    window.removeEventListener('pagehide', finishResize);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    captureTarget.removeEventListener('pointermove', handlePointerMove, true);
    captureTarget.removeEventListener('pointerenter', handlePointerReleaseProbe, true);
    captureTarget.removeEventListener('pointerover', handlePointerReleaseProbe, true);
    captureTarget.removeEventListener('pointerout', handlePointerReleaseProbe, true);
    captureTarget.removeEventListener('pointerleave', handlePointerReleaseProbe, true);
    captureTarget.removeEventListener('pointerup', handlePointerEnd, true);
    captureTarget.removeEventListener('pointercancel', handlePointerEnd, true);
    captureTarget.removeEventListener('mouseup', handleMouseUp, true);
    captureTarget.removeEventListener('mousemove', handleMouseMove, true);
    captureTarget.removeEventListener('mouseenter', handleMouseReleaseProbe, true);
    captureTarget.removeEventListener('mouseover', handleMouseReleaseProbe, true);
    captureTarget.removeEventListener('mouseout', handleMouseReleaseProbe, true);
    captureTarget.removeEventListener('mouseleave', handleMouseLeave, true);
    captureTarget.removeEventListener('contextmenu', finishResize, true);
    captureTarget.removeEventListener('dragend', finishResize, true);
    captureTarget.removeEventListener('click', handleMouseEnd, true);
    captureTarget.removeEventListener('auxclick', handleMouseEnd, true);
    captureTarget.removeEventListener('pointerdown', handlePointerRestart, true);
    pointerCaptureElement?.removeEventListener('lostpointercapture', handleLostPointerCapture);
    resizeGuard.removeEventListener('pointermove', handlePointerMove, true);
    resizeGuard.removeEventListener('pointerenter', handlePointerReleaseProbe, true);
    resizeGuard.removeEventListener('pointerover', handlePointerReleaseProbe, true);
    resizeGuard.removeEventListener('pointerout', handlePointerReleaseProbe, true);
    resizeGuard.removeEventListener('pointerleave', handlePointerReleaseProbe, true);
    resizeGuard.removeEventListener('pointerup', handlePointerEnd, true);
    resizeGuard.removeEventListener('pointercancel', handlePointerEnd, true);
    resizeGuard.removeEventListener('mouseup', handleMouseUp, true);
    resizeGuard.removeEventListener('mousemove', handleMouseMove, true);
    resizeGuard.removeEventListener('mouseenter', handleMouseReleaseProbe, true);
    resizeGuard.removeEventListener('mouseover', handleMouseReleaseProbe, true);
    resizeGuard.removeEventListener('mouseout', handleMouseReleaseProbe, true);
    resizeGuard.removeEventListener('mouseleave', handleMouseLeave, true);
    resizeGuard.removeEventListener('contextmenu', finishResize, true);
    resizeGuard.removeEventListener('dragend', finishResize, true);
    resizeGuard.removeEventListener('click', handleMouseEnd, true);
    resizeGuard.removeEventListener('auxclick', handleMouseEnd, true);
    resizeGuard.removeEventListener('pointerdown', handlePointerRestart, true);
    resizeGuard.remove();
  };

  const finishResize = () => {
    if (finished) return;
    finished = true;
    if (animationFrame !== null) {
      window.cancelAnimationFrame(animationFrame);
    }
    applyWidth();
    removeListeners();
    try {
      if (pointerCaptureElement?.hasPointerCapture?.(pointerId)) {
        pointerCaptureElement.releasePointerCapture(pointerId);
      }
    } catch {
      // Pointer capture can already be gone after window or document transitions.
    }
    document.body.style.userSelect = previousUserSelect;
    document.body.style.cursor = previousCursor;
    if (activeResize === finishResize) {
      activeResize = null;
    }
    onFinish(width);
  };

  function handlePointerMove(event: PointerEvent) {
    if (event.pointerId !== pointerId) {
      if (isMouseLikePointer(event) && isPrimaryButtonReleased(event)) {
        finishResize();
      }
      return;
    }
    if (isPrimaryButtonReleased(event)) {
      finishResize();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    applyClientX(event.clientX);
  }

  function handlePointerEnd(event: PointerEvent) {
    if (event.pointerId === pointerId || isMouseLikePointer(event)) {
      event.preventDefault();
      event.stopPropagation();
      finishResize();
    }
  }

  function handlePointerRestart(event: PointerEvent) {
    if (event.pointerId !== pointerId || isMouseLikePointer(event)) {
      finishResize();
    }
  }

  function handlePointerReleaseProbe(event: PointerEvent) {
    if (isMouseLikePointer(event) && isPrimaryButtonReleased(event)) {
      finishResize();
    }
  }

  function handlePointerViewportLeave(event: PointerEvent) {
    if (event.pointerId !== pointerId && event.pointerType !== 'mouse') {
      return;
    }
    if (isPrimaryButtonReleased(event)) {
      finishResize();
      return;
    }
    applyClientX(event.clientX);
  }

  function handleLostPointerCapture(event: PointerEvent) {
    if (event.pointerId !== pointerId) {
      return;
    }
    if (isPrimaryButtonReleased(event)) {
      finishResize();
    }
  }

  function handleMouseUp(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    finishResize();
  }

  function handleMouseEnd() {
    finishResize();
  }

  function handleMouseMove(event: MouseEvent) {
    if (isPrimaryButtonReleased(event)) {
      finishResize();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    applyClientX(event.clientX);
  }

  function handleMouseReleaseProbe(event: MouseEvent) {
    if (isPrimaryButtonReleased(event)) {
      finishResize();
    }
  }

  function handleMouseViewportLeave(event: MouseEvent) {
    if (isPrimaryButtonReleased(event)) {
      finishResize();
      return;
    }
    applyClientX(event.clientX);
  }

  function handleMouseLeave(event: MouseEvent) {
    if (isPrimaryButtonReleased(event)) {
      finishResize();
    }
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      finishResize();
    }
  }

  activeResize = finishResize;
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'col-resize';
  document.body.appendChild(resizeGuard);
  onResize(width);

  if (typeof captureTarget.setPointerCapture === 'function') {
    try {
      captureTarget.setPointerCapture(pointerId);
      pointerCaptureElement = captureTarget;
    } catch {
      pointerCaptureElement = null;
    }
  }
  if (!pointerCaptureElement && typeof resizeGuard.setPointerCapture === 'function') {
    try {
      resizeGuard.setPointerCapture(pointerId);
      pointerCaptureElement = resizeGuard;
    } catch {
      // Global listeners still provide a complete fallback when capture is unavailable.
    }
  }
  window.addEventListener('pointermove', handlePointerMove, { capture: true, passive: false });
  window.addEventListener('pointerenter', handlePointerReleaseProbe, true);
  window.addEventListener('pointerover', handlePointerReleaseProbe, true);
  window.addEventListener('pointerout', handlePointerReleaseProbe, true);
  window.addEventListener('pointerleave', handlePointerViewportLeave, true);
  window.addEventListener('pointerup', handlePointerEnd, true);
  window.addEventListener('pointercancel', handlePointerEnd, true);
  window.addEventListener('mouseup', handleMouseUp, true);
  window.addEventListener('mousemove', handleMouseMove, { capture: true, passive: false });
  window.addEventListener('mouseenter', handleMouseReleaseProbe, true);
  window.addEventListener('mouseover', handleMouseReleaseProbe, true);
  window.addEventListener('mouseout', handleMouseReleaseProbe, true);
  window.addEventListener('mouseleave', handleMouseViewportLeave, true);
  window.addEventListener('contextmenu', finishResize, true);
  window.addEventListener('dragend', finishResize, true);
  document.addEventListener('pointerup', handlePointerEnd, true);
  document.addEventListener('pointercancel', handlePointerEnd, true);
  document.addEventListener('pointerenter', handlePointerReleaseProbe, true);
  document.addEventListener('pointerover', handlePointerReleaseProbe, true);
  document.addEventListener('pointerout', handlePointerReleaseProbe, true);
  document.addEventListener('pointerleave', handlePointerViewportLeave, true);
  document.addEventListener('mouseup', handleMouseUp, true);
  document.addEventListener('mousemove', handleMouseMove, { capture: true, passive: false });
  document.addEventListener('mouseenter', handleMouseReleaseProbe, true);
  document.addEventListener('mouseover', handleMouseReleaseProbe, true);
  document.addEventListener('mouseout', handleMouseReleaseProbe, true);
  document.addEventListener('mouseleave', handleMouseViewportLeave, true);
  document.addEventListener('contextmenu', finishResize, true);
  document.addEventListener('dragend', finishResize, true);
  document.addEventListener('click', handleMouseEnd, true);
  document.addEventListener('auxclick', handleMouseEnd, true);
  rootElement.addEventListener('pointerup', handlePointerEnd, true);
  rootElement.addEventListener('pointercancel', handlePointerEnd, true);
  rootElement.addEventListener('pointerdown', handlePointerRestart, true);
  rootElement.addEventListener('mouseup', handleMouseUp, true);
  rootElement.addEventListener('click', handleMouseEnd, true);
  rootElement.addEventListener('auxclick', handleMouseEnd, true);
  window.addEventListener('blur', finishResize);
  window.addEventListener('pagehide', finishResize);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  captureTarget.addEventListener('pointermove', handlePointerMove, { capture: true, passive: false });
  captureTarget.addEventListener('pointerup', handlePointerEnd, true);
  captureTarget.addEventListener('pointercancel', handlePointerEnd, true);
  captureTarget.addEventListener('pointerenter', handlePointerReleaseProbe, true);
  captureTarget.addEventListener('pointerover', handlePointerReleaseProbe, true);
  captureTarget.addEventListener('pointerout', handlePointerReleaseProbe, true);
  captureTarget.addEventListener('pointerleave', handlePointerReleaseProbe, true);
  captureTarget.addEventListener('mouseup', handleMouseUp, true);
  captureTarget.addEventListener('mousemove', handleMouseMove, { capture: true, passive: false });
  captureTarget.addEventListener('mouseenter', handleMouseReleaseProbe, true);
  captureTarget.addEventListener('mouseover', handleMouseReleaseProbe, true);
  captureTarget.addEventListener('mouseout', handleMouseReleaseProbe, true);
  captureTarget.addEventListener('mouseleave', handleMouseLeave, true);
  captureTarget.addEventListener('contextmenu', finishResize, true);
  captureTarget.addEventListener('dragend', finishResize, true);
  captureTarget.addEventListener('click', handleMouseEnd, true);
  captureTarget.addEventListener('auxclick', handleMouseEnd, true);
  captureTarget.addEventListener('pointerdown', handlePointerRestart, true);
  pointerCaptureElement?.addEventListener('lostpointercapture', handleLostPointerCapture);
  resizeGuard.addEventListener('pointermove', handlePointerMove, { capture: true, passive: false });
  resizeGuard.addEventListener('pointerup', handlePointerEnd, true);
  resizeGuard.addEventListener('pointercancel', handlePointerEnd, true);
  resizeGuard.addEventListener('pointerenter', handlePointerReleaseProbe, true);
  resizeGuard.addEventListener('pointerover', handlePointerReleaseProbe, true);
  resizeGuard.addEventListener('pointerout', handlePointerReleaseProbe, true);
  resizeGuard.addEventListener('pointerleave', handlePointerReleaseProbe, true);
  resizeGuard.addEventListener('mouseup', handleMouseUp, true);
  resizeGuard.addEventListener('mousemove', handleMouseMove, { capture: true, passive: false });
  resizeGuard.addEventListener('mouseenter', handleMouseReleaseProbe, true);
  resizeGuard.addEventListener('mouseover', handleMouseReleaseProbe, true);
  resizeGuard.addEventListener('mouseout', handleMouseReleaseProbe, true);
  resizeGuard.addEventListener('mouseleave', handleMouseLeave, true);
  resizeGuard.addEventListener('contextmenu', finishResize, true);
  resizeGuard.addEventListener('dragend', finishResize, true);
  resizeGuard.addEventListener('click', handleMouseEnd, true);
  resizeGuard.addEventListener('auxclick', handleMouseEnd, true);
  resizeGuard.addEventListener('pointerdown', handlePointerRestart, true);

  return finishResize;
}
