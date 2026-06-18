import React from 'react';

export const HORIZONTAL_TRACK_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
export const HORIZONTAL_TRACK_MIN_TRANSITION_MS = 500;
export const HORIZONTAL_TRACK_MAX_TRANSITION_MS = 800;
export const HORIZONTAL_SWIPE_DISTANCE_PX = 48;
export const HORIZONTAL_SWIPE_VELOCITY_THRESHOLD = 0.45;
export const HORIZONTAL_TAP_THRESHOLD_PX = 8;

type GestureMode = 'tap' | 'horizontal' | 'ignored';

type DragState = {
  pointerId: number | null;
  startX: number;
  startY: number;
  startTime: number;
  width: number;
  mode: GestureMode;
  dx: number;
  dy: number;
};

export type HorizontalPageTarget = {
  direction: 'previous' | 'next';
  indexDelta: -1 | 1;
  settleOffset: number;
  durationMs: number;
};

export type HorizontalPageTargetOptions = {
  deltaX: number;
  deltaY: number;
  elapsedMs: number;
  width: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
};

export interface SwipePagerOptions {
  pageCount: number;
  index: number;
  onIndexChange: (index: number) => void;
  enabled?: boolean;
  animationDurationMs?: number;
}

export interface SwipePager {
  viewportProps: {
    ref: React.Ref<HTMLDivElement>;
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void;
    onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
    onMouseMove: (event: React.MouseEvent<HTMLDivElement>) => void;
    onMouseUp: (event: React.MouseEvent<HTMLDivElement>) => void;
    onMouseLeave: (event: React.MouseEvent<HTMLDivElement>) => void;
    onClickCapture: (event: React.MouseEvent<HTMLDivElement>) => void;
  };
  trackProps: {
    ref: React.Ref<HTMLDivElement>;
  };
}

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const now = () => (
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
);

export const getHorizontalTrackTransitionMs = (remainingDistance: number, velocity: number, width: number) => {
  const safeWidth = Math.max(1, width);
  const distanceRatio = clampNumber(remainingDistance / safeWidth, 0.12, 1);
  const velocityRatio = clampNumber(Math.abs(velocity) / 1.2, 0, 1);
  const duration = 520 + distanceRatio * 420 - velocityRatio * 120;
  return Math.round(clampNumber(duration, HORIZONTAL_TRACK_MIN_TRANSITION_MS, HORIZONTAL_TRACK_MAX_TRANSITION_MS));
};

export const getHorizontalSwipeThreshold = (width: number) => (
  Math.min(96, Math.max(HORIZONTAL_SWIPE_DISTANCE_PX, width * 0.18))
);

export const getHorizontalBoundaryResistedOffset = (
  offset: number,
  width: number,
  canGoPrevious: boolean,
  canGoNext: boolean,
) => {
  const isPastPreviousEdge = offset > 0 && !canGoPrevious;
  const isPastNextEdge = offset < 0 && !canGoNext;
  if (!isPastPreviousEdge && !isPastNextEdge) {
    return offset;
  }

  const safeWidth = Math.max(1, width);
  const distance = Math.abs(offset);
  const resisted = safeWidth * (1 - (1 / ((distance / safeWidth) * 0.55 + 1)));
  return Math.sign(offset) * Math.min(resisted, safeWidth * 0.45);
};

export const getHorizontalPageTarget = ({
  deltaX,
  deltaY,
  elapsedMs,
  width,
  canGoPrevious,
  canGoNext,
}: HorizontalPageTargetOptions): HorizontalPageTarget | null => {
  const safeWidth = Math.max(1, width);
  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);
  const velocityX = deltaX / Math.max(1, elapsedMs);
  const swipeThreshold = getHorizontalSwipeThreshold(safeWidth);
  const shouldNavigate = absX > swipeThreshold
    || (
      Math.abs(velocityX) > HORIZONTAL_SWIPE_VELOCITY_THRESHOLD
      && absX > HORIZONTAL_TAP_THRESHOLD_PX * 2
      && absX > absY * 1.1
    );

  if (!shouldNavigate) {
    return null;
  }

  const remainingDistance = Math.max(0, safeWidth - Math.min(absX, safeWidth));
  const durationMs = getHorizontalTrackTransitionMs(remainingDistance, velocityX, safeWidth);

  if (deltaX < 0 && canGoNext) {
    return {
      direction: 'next',
      indexDelta: 1,
      settleOffset: -safeWidth,
      durationMs,
    };
  }

  if (deltaX > 0 && canGoPrevious) {
    return {
      direction: 'previous',
      indexDelta: -1,
      settleOffset: safeWidth,
      durationMs,
    };
  }

  return null;
};

export const getHorizontalSettleTransitionMs = (
  deltaX: number,
  elapsedMs: number,
  width: number,
) => {
  const safeWidth = Math.max(1, width);
  return getHorizontalTrackTransitionMs(
    Math.min(Math.abs(deltaX), safeWidth),
    deltaX / Math.max(1, elapsedMs),
    safeWidth,
  );
};

export function useSwipePager({
  pageCount,
  index,
  onIndexChange,
  enabled = true,
  animationDurationMs,
}: SwipePagerOptions): SwipePager {
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const dragRef = React.useRef<DragState | null>(null);
  const didSwipeRef = React.useRef(false);
  const clickSuppressTimerRef = React.useRef<number | null>(null);
  const pointerSequenceRef = React.useRef(false);
  const pointerSequenceTimerRef = React.useRef<number | null>(null);
  const mouseGestureActiveRef = React.useRef(false);
  const indexRef = React.useRef(index);
  const pageCountRef = React.useRef(pageCount);

  const clampIndex = React.useCallback((value: number) => (
    Math.max(0, Math.min(value, Math.max(0, pageCountRef.current - 1)))
  ), []);

  const defaultAnimationDurationMs = animationDurationMs ?? HORIZONTAL_TRACK_MIN_TRANSITION_MS;

  const applyTransform = React.useCallback((translateX: number, animate: boolean, durationMs = defaultAnimationDurationMs) => {
    const track = trackRef.current;
    if (!track) return;
    track.style.transition = animate ? `transform ${durationMs}ms ${HORIZONTAL_TRACK_EASING}` : 'none';
    track.style.transform = `translate3d(${translateX}px, 0, 0)`;
  }, [defaultAnimationDurationMs]);

  const snapTo = React.useCallback((targetIndex: number, animate: boolean, durationMs = defaultAnimationDurationMs) => {
    const width = viewportRef.current?.clientWidth ?? 0;
    applyTransform(-targetIndex * width, animate, durationMs);
  }, [applyTransform, defaultAnimationDurationMs]);

  React.useEffect(() => {
    pageCountRef.current = pageCount;
    const clampedIndex = clampIndex(index);
    indexRef.current = clampedIndex;
    if (clampedIndex !== index) {
      onIndexChange(clampedIndex);
      return;
    }
    snapTo(clampedIndex, true);
  }, [clampIndex, index, onIndexChange, pageCount, snapTo]);

  React.useEffect(() => {
    const handleResize = () => snapTo(indexRef.current, false);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [snapTo]);

  React.useEffect(() => () => {
    if (clickSuppressTimerRef.current !== null) {
      window.clearTimeout(clickSuppressTimerRef.current);
    }
    if (pointerSequenceTimerRef.current !== null) {
      window.clearTimeout(pointerSequenceTimerRef.current);
    }
  }, []);

  React.useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const preventVerticalScrollAfterHorizontalLock = (event: TouchEvent) => {
      if (dragRef.current?.mode === 'horizontal' && event.cancelable) {
        event.preventDefault();
      }
    };

    viewport.addEventListener('touchmove', preventVerticalScrollAfterHorizontalLock, { passive: false });
    return () => {
      viewport.removeEventListener('touchmove', preventVerticalScrollAfterHorizontalLock);
    };
  }, []);

  const clearClickSuppression = React.useCallback(() => {
    if (clickSuppressTimerRef.current !== null) {
      window.clearTimeout(clickSuppressTimerRef.current);
      clickSuppressTimerRef.current = null;
    }
    didSwipeRef.current = false;
  }, []);

  const scheduleClickSuppressionReset = React.useCallback(() => {
    if (clickSuppressTimerRef.current !== null) {
      window.clearTimeout(clickSuppressTimerRef.current);
    }
    clickSuppressTimerRef.current = window.setTimeout(() => {
      clickSuppressTimerRef.current = null;
      didSwipeRef.current = false;
    }, 350);
  }, []);

  const beginDrag = React.useCallback((pointerId: number | null, clientX: number, clientY: number) => {
    if (!enabled || pageCount <= 1) {
      return;
    }

    const width = viewportRef.current?.clientWidth ?? 0;
    dragRef.current = {
      pointerId,
      startX: clientX,
      startY: clientY,
      startTime: now(),
      width,
      mode: 'tap',
      dx: 0,
      dy: 0,
    };
  }, [enabled, pageCount]);

  const updateDrag = React.useCallback((pointerId: number | null, clientX: number, clientY: number, preventDefault?: () => void) => {
    const drag = dragRef.current;
    if (!enabled || !drag || drag.pointerId !== pointerId) {
      return;
    }

    const dx = clientX - drag.startX;
    const dy = clientY - drag.startY;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);

    if (drag.mode === 'tap' && (absX > HORIZONTAL_TAP_THRESHOLD_PX || absY > HORIZONTAL_TAP_THRESHOLD_PX)) {
      drag.mode = absX > absY * 1.1 ? 'horizontal' : 'ignored';
    }

    if (drag.mode !== 'horizontal') {
      return;
    }

    preventDefault?.();
    drag.dx = dx;
    drag.dy = dy;
    didSwipeRef.current = true;

    const activeIndex = indexRef.current;
    const resistedOffset = getHorizontalBoundaryResistedOffset(
      dx,
      drag.width,
      activeIndex > 0,
      activeIndex < pageCount - 1,
    );
    applyTransform((-activeIndex * drag.width) + resistedOffset, false);
  }, [applyTransform, enabled, pageCount]);

  const finishDragAt = React.useCallback((pointerId: number | null) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) {
      return;
    }

    dragRef.current = null;

    if (drag.mode !== 'horizontal') {
      return;
    }
    scheduleClickSuppressionReset();

    const activeIndex = indexRef.current;
    const elapsedMs = now() - drag.startTime;
    const target = getHorizontalPageTarget({
      deltaX: drag.dx,
      deltaY: drag.dy,
      elapsedMs,
      width: drag.width,
      canGoPrevious: activeIndex > 0,
      canGoNext: activeIndex < pageCount - 1,
    });

    if (target) {
      applyTransform((-activeIndex * drag.width) + target.settleOffset, true, animationDurationMs ?? target.durationMs);
      onIndexChange(clampIndex(activeIndex + target.indexDelta));
      return;
    }

    snapTo(activeIndex, true, animationDurationMs ?? getHorizontalSettleTransitionMs(drag.dx, elapsedMs, drag.width));
  }, [animationDurationMs, applyTransform, clampIndex, onIndexChange, pageCount, scheduleClickSuppressionReset, snapTo]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    pointerSequenceRef.current = true;
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    beginDrag(event.pointerId, event.clientX, event.clientY);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    updateDrag(event.pointerId, event.clientX, event.clientY, () => {
      try { viewportRef.current?.setPointerCapture(event.pointerId); } catch { /* ignored */ }
      event.preventDefault();
    });
  };

  const finishPointerDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    finishDragAt(event.pointerId);
    try { viewportRef.current?.releasePointerCapture(event.pointerId); } catch { /* ignored */ }
    if (pointerSequenceTimerRef.current !== null) {
      window.clearTimeout(pointerSequenceTimerRef.current);
    }
    pointerSequenceTimerRef.current = window.setTimeout(() => {
      pointerSequenceTimerRef.current = null;
      pointerSequenceRef.current = false;
    }, 350);
  };

  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (pointerSequenceRef.current || event.button !== 0) return;
    mouseGestureActiveRef.current = true;
    beginDrag(null, event.clientX, event.clientY);
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (pointerSequenceRef.current || !mouseGestureActiveRef.current) return;
    updateDrag(null, event.clientX, event.clientY, () => event.preventDefault());
  };

  const finishMouseDrag = () => {
    if (pointerSequenceRef.current || !mouseGestureActiveRef.current) return;
    mouseGestureActiveRef.current = false;
    finishDragAt(null);
  };

  const handleClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!didSwipeRef.current) {
      return;
    }

    event.stopPropagation();
    event.preventDefault();
    clearClickSuppression();
  };

  return {
    viewportProps: {
      ref: viewportRef,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: finishPointerDrag,
      onPointerCancel: finishPointerDrag,
      onMouseDown: handleMouseDown,
      onMouseMove: handleMouseMove,
      onMouseUp: finishMouseDrag,
      onMouseLeave: finishMouseDrag,
      onClickCapture: handleClickCapture,
    },
    trackProps: {
      ref: trackRef,
    },
  };
}
