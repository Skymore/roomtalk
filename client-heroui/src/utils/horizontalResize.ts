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
    width = clampWidth(startWidth + ((clientX - startX) * direction), getBounds());
    if (animationFrame === null) {
      animationFrame = window.requestAnimationFrame(applyWidth);
    }
  };

  const removeListeners = () => {
    window.removeEventListener('pointermove', handlePointerMove, true);
    window.removeEventListener('pointerover', handlePointerReleaseProbe, true);
    window.removeEventListener('pointerout', handlePointerReleaseProbe, true);
    window.removeEventListener('pointerleave', handleViewportLeave, true);
    window.removeEventListener('pointerup', handlePointerEnd, true);
    window.removeEventListener('pointercancel', handlePointerEnd, true);
    window.removeEventListener('mouseup', handleMouseUp, true);
    window.removeEventListener('mousemove', handleMouseMove, true);
    window.removeEventListener('mouseover', handleMouseReleaseProbe, true);
    window.removeEventListener('mouseout', handleMouseReleaseProbe, true);
    window.removeEventListener('mouseleave', handleViewportLeave, true);
    window.removeEventListener('contextmenu', finishResize, true);
    window.removeEventListener('dragend', finishResize, true);
    document.removeEventListener('pointerup', handlePointerEnd, true);
    document.removeEventListener('pointercancel', handlePointerEnd, true);
    document.removeEventListener('pointerover', handlePointerReleaseProbe, true);
    document.removeEventListener('pointerout', handlePointerReleaseProbe, true);
    document.removeEventListener('pointerleave', handleViewportLeave, true);
    document.removeEventListener('mouseup', handleMouseUp, true);
    document.removeEventListener('mousemove', handleMouseMove, true);
    document.removeEventListener('mouseover', handleMouseReleaseProbe, true);
    document.removeEventListener('mouseout', handleMouseReleaseProbe, true);
    document.removeEventListener('mouseleave', handleViewportLeave, true);
    document.removeEventListener('contextmenu', finishResize, true);
    document.removeEventListener('dragend', finishResize, true);
    window.removeEventListener('blur', finishResize);
    window.removeEventListener('pagehide', finishResize);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    captureTarget.removeEventListener('pointermove', handlePointerMove, true);
    captureTarget.removeEventListener('pointerover', handlePointerReleaseProbe, true);
    captureTarget.removeEventListener('pointerout', handlePointerReleaseProbe, true);
    captureTarget.removeEventListener('pointerup', handlePointerEnd, true);
    captureTarget.removeEventListener('pointercancel', handlePointerEnd, true);
    captureTarget.removeEventListener('mouseup', handleMouseUp, true);
    captureTarget.removeEventListener('mousemove', handleMouseMove, true);
    captureTarget.removeEventListener('mouseover', handleMouseReleaseProbe, true);
    captureTarget.removeEventListener('mouseout', handleMouseReleaseProbe, true);
    captureTarget.removeEventListener('mouseleave', handleMouseLeave, true);
    captureTarget.removeEventListener('contextmenu', finishResize, true);
    captureTarget.removeEventListener('dragend', finishResize, true);
    pointerCaptureElement?.removeEventListener('lostpointercapture', handleLostPointerCapture);
    resizeGuard.removeEventListener('pointermove', handlePointerMove, true);
    resizeGuard.removeEventListener('pointerover', handlePointerReleaseProbe, true);
    resizeGuard.removeEventListener('pointerout', handlePointerReleaseProbe, true);
    resizeGuard.removeEventListener('pointerup', handlePointerEnd, true);
    resizeGuard.removeEventListener('pointercancel', handlePointerEnd, true);
    resizeGuard.removeEventListener('mouseup', handleMouseUp, true);
    resizeGuard.removeEventListener('mousemove', handleMouseMove, true);
    resizeGuard.removeEventListener('mouseover', handleMouseReleaseProbe, true);
    resizeGuard.removeEventListener('mouseout', handleMouseReleaseProbe, true);
    resizeGuard.removeEventListener('mouseleave', handleMouseLeave, true);
    resizeGuard.removeEventListener('contextmenu', finishResize, true);
    resizeGuard.removeEventListener('dragend', finishResize, true);
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
      if (event.pointerType === 'mouse' && isPrimaryButtonReleased(event)) {
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
    if (event.pointerId === pointerId || (event.pointerType === 'mouse' && isPrimaryButtonReleased(event))) {
      event.preventDefault();
      event.stopPropagation();
      finishResize();
    }
  }

  function handlePointerReleaseProbe(event: PointerEvent) {
    if (event.pointerType === 'mouse' && isPrimaryButtonReleased(event)) {
      finishResize();
    }
  }

  function handleLostPointerCapture(event: PointerEvent) {
    if (event.pointerId !== pointerId) {
      return;
    }
    finishResize();
  }

  function handleMouseUp(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
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

  function handleMouseLeave(event: MouseEvent) {
    if (isPrimaryButtonReleased(event)) {
      finishResize();
    }
  }

  function handleViewportLeave(event: PointerEvent | MouseEvent) {
    if (
      !isPrimaryButtonReleased(event) &&
      Number.isFinite(event.clientX)
    ) {
      applyClientX(event.clientX);
    }
    finishResize();
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
  window.addEventListener('pointerover', handlePointerReleaseProbe, true);
  window.addEventListener('pointerout', handlePointerReleaseProbe, true);
  window.addEventListener('pointerleave', handleViewportLeave, true);
  window.addEventListener('pointerup', handlePointerEnd, true);
  window.addEventListener('pointercancel', handlePointerEnd, true);
  window.addEventListener('mouseup', handleMouseUp, true);
  window.addEventListener('mousemove', handleMouseMove, { capture: true, passive: false });
  window.addEventListener('mouseover', handleMouseReleaseProbe, true);
  window.addEventListener('mouseout', handleMouseReleaseProbe, true);
  window.addEventListener('mouseleave', handleViewportLeave, true);
  window.addEventListener('contextmenu', finishResize, true);
  window.addEventListener('dragend', finishResize, true);
  document.addEventListener('pointerup', handlePointerEnd, true);
  document.addEventListener('pointercancel', handlePointerEnd, true);
  document.addEventListener('pointerover', handlePointerReleaseProbe, true);
  document.addEventListener('pointerout', handlePointerReleaseProbe, true);
  document.addEventListener('pointerleave', handleViewportLeave, true);
  document.addEventListener('mouseup', handleMouseUp, true);
  document.addEventListener('mousemove', handleMouseMove, { capture: true, passive: false });
  document.addEventListener('mouseover', handleMouseReleaseProbe, true);
  document.addEventListener('mouseout', handleMouseReleaseProbe, true);
  document.addEventListener('mouseleave', handleViewportLeave, true);
  document.addEventListener('contextmenu', finishResize, true);
  document.addEventListener('dragend', finishResize, true);
  window.addEventListener('blur', finishResize);
  window.addEventListener('pagehide', finishResize);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  captureTarget.addEventListener('pointermove', handlePointerMove, { capture: true, passive: false });
  captureTarget.addEventListener('pointerup', handlePointerEnd, true);
  captureTarget.addEventListener('pointercancel', handlePointerEnd, true);
  captureTarget.addEventListener('pointerover', handlePointerReleaseProbe, true);
  captureTarget.addEventListener('pointerout', handlePointerReleaseProbe, true);
  captureTarget.addEventListener('mouseup', handleMouseUp, true);
  captureTarget.addEventListener('mousemove', handleMouseMove, { capture: true, passive: false });
  captureTarget.addEventListener('mouseover', handleMouseReleaseProbe, true);
  captureTarget.addEventListener('mouseout', handleMouseReleaseProbe, true);
  captureTarget.addEventListener('mouseleave', handleMouseLeave, true);
  captureTarget.addEventListener('contextmenu', finishResize, true);
  captureTarget.addEventListener('dragend', finishResize, true);
  pointerCaptureElement?.addEventListener('lostpointercapture', handleLostPointerCapture);
  resizeGuard.addEventListener('pointermove', handlePointerMove, { capture: true, passive: false });
  resizeGuard.addEventListener('pointerup', handlePointerEnd, true);
  resizeGuard.addEventListener('pointercancel', handlePointerEnd, true);
  resizeGuard.addEventListener('pointerover', handlePointerReleaseProbe, true);
  resizeGuard.addEventListener('pointerout', handlePointerReleaseProbe, true);
  resizeGuard.addEventListener('mouseup', handleMouseUp, true);
  resizeGuard.addEventListener('mousemove', handleMouseMove, { capture: true, passive: false });
  resizeGuard.addEventListener('mouseover', handleMouseReleaseProbe, true);
  resizeGuard.addEventListener('mouseout', handleMouseReleaseProbe, true);
  resizeGuard.addEventListener('mouseleave', handleMouseLeave, true);
  resizeGuard.addEventListener('contextmenu', finishResize, true);
  resizeGuard.addEventListener('dragend', finishResize, true);

  return finishResize;
}
