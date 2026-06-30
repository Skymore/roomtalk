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

  const originWidth = clampWidth(initialWidth, getBounds());
  let width = originWidth;
  let animationFrame: number | null = null;
  let finished = false;
  const previousUserSelect = document.body.style.userSelect;
  const previousCursor = document.body.style.cursor;

  const applyWidth = () => {
    animationFrame = null;
    onResize(width);
  };

  const removeListeners = () => {
    window.removeEventListener('pointermove', handlePointerMove, true);
    window.removeEventListener('pointerup', handlePointerEnd, true);
    window.removeEventListener('pointercancel', handlePointerEnd, true);
    window.removeEventListener('mouseup', handleMouseUp, true);
    window.removeEventListener('blur', finishResize);
    window.removeEventListener('pagehide', finishResize);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    captureTarget.removeEventListener('lostpointercapture', handleLostPointerCapture);
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
      if (captureTarget.hasPointerCapture?.(pointerId)) {
        captureTarget.releasePointerCapture(pointerId);
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
    if (event.pointerId !== pointerId) return;
    if ((event.buttons & 1) === 0) {
      finishResize();
      return;
    }
    event.preventDefault();
    const deltaFromOrigin = (event.clientX - startX) * direction;
    width = clampWidth(originWidth + deltaFromOrigin, getBounds());
    if (animationFrame === null) {
      animationFrame = window.requestAnimationFrame(applyWidth);
    }
  }

  function handlePointerEnd(event: PointerEvent) {
    if (event.pointerId === pointerId) {
      finishResize();
    }
  }

  function handleLostPointerCapture(event: PointerEvent) {
    if (event.pointerId === pointerId) {
      finishResize();
    }
  }

  function handleMouseUp(event: MouseEvent) {
    if (event.button === 0) {
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
  onResize(width);

  try {
    captureTarget.setPointerCapture?.(pointerId);
  } catch {
    // Global listeners still provide a complete fallback when capture is unavailable.
  }
  window.addEventListener('pointermove', handlePointerMove, { capture: true, passive: false });
  window.addEventListener('pointerup', handlePointerEnd, true);
  window.addEventListener('pointercancel', handlePointerEnd, true);
  window.addEventListener('mouseup', handleMouseUp, true);
  window.addEventListener('blur', finishResize);
  window.addEventListener('pagehide', finishResize);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  captureTarget.addEventListener('lostpointercapture', handleLostPointerCapture);

  return finishResize;
}
