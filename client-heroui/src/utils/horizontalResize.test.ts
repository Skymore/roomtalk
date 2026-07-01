// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginHorizontalResize } from './horizontalResize';

function pointerEvent(type: string, values: Partial<PointerEvent>): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  const pointerType = Object.prototype.hasOwnProperty.call(values, 'pointerType')
    ? values.pointerType
    : 'mouse';
  Object.defineProperties(event, {
    pointerId: { value: values.pointerId ?? 1 },
    clientX: { value: values.clientX ?? 0 },
    buttons: { value: values.buttons ?? 0 },
    pointerType: { value: pointerType },
    pressure: { value: values.pressure },
  });
  return event;
}

function mouseEvent(type: string, values: MouseEventInit): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, ...values });
}

describe('beginHorizontalResize', () => {
  afterEach(() => {
    window.dispatchEvent(new Event('blur'));
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    vi.restoreAllMocks();
  });

  it('keeps the original drag anchor after overshooting a boundary', () => {
    const handle = document.createElement('button');
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);
    handle.releasePointerCapture = vi.fn();
    const onFinish = vi.fn();

    beginHorizontalResize({
      pointerId: 7,
      startX: 100,
      initialWidth: 300,
      direction: 1,
      captureTarget: handle,
      getBounds: () => ({ min: 200, max: 500 }),
      onResize: vi.fn(),
      onFinish,
    });

    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 7, clientX: 500, buttons: 1 }));
    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 7, clientX: 900, buttons: 1 }));
    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 7, clientX: 890, buttons: 1 }));
    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 7, clientX: 290, buttons: 1 }));
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 7, clientX: 890 }));

    expect(onFinish).toHaveBeenCalledWith(490);
    expect(handle.setPointerCapture).toHaveBeenCalledWith(7);
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('keeps the original drag anchor after overshooting the opposite boundary', () => {
    const onFinish = vi.fn();

    beginHorizontalResize({
      pointerId: 8,
      startX: 500,
      initialWidth: 300,
      direction: -1,
      captureTarget: document.createElement('button'),
      getBounds: () => ({ min: 200, max: 500 }),
      onResize: vi.fn(),
      onFinish,
    });

    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 8, clientX: 100, buttons: 1 }));
    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 8, clientX: -300, buttons: 1 }));
    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 8, clientX: -290, buttons: 1 }));
    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 8, clientX: 310, buttons: 1 }));
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 8, clientX: -290 }));

    expect(onFinish).toHaveBeenCalledWith(490);
    expect(document.querySelector('[data-horizontal-resize-guard="true"]')).toBeNull();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('keeps resizing when pointer capture is lost while the primary button is still pressed', () => {
    const handle = document.createElement('button');
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);
    handle.releasePointerCapture = vi.fn();
    const onFinish = vi.fn();

    beginHorizontalResize({
      pointerId: 31,
      startX: 100,
      initialWidth: 300,
      direction: 1,
      captureTarget: handle,
      getBounds: () => ({ min: 200, max: 500 }),
      onResize: vi.fn(),
      onFinish,
    });

    handle.dispatchEvent(pointerEvent('lostpointercapture', { pointerId: 31, buttons: 1 }));
    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 31, clientX: 400, buttons: 1 }));
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 31, clientX: 400, buttons: 0 }));

    expect(onFinish).toHaveBeenCalledWith(500);
    expect(document.querySelector('[data-horizontal-resize-guard="true"]')).toBeNull();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('finishes when pointer capture is lost after the primary button is released', () => {
    const handle = document.createElement('button');
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);
    handle.releasePointerCapture = vi.fn();
    const onFinish = vi.fn();

    beginHorizontalResize({
      pointerId: 32,
      startX: 100,
      initialWidth: 300,
      direction: 1,
      captureTarget: handle,
      getBounds: () => ({ min: 200, max: 500 }),
      onResize: vi.fn(),
      onFinish,
    });

    handle.dispatchEvent(pointerEvent('lostpointercapture', { pointerId: 32, buttons: 0 }));

    expect(onFinish).toHaveBeenCalledWith(300);
    expect(document.querySelector('[data-horizontal-resize-guard="true"]')).toBeNull();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('finishes when a move reports that the primary button is already released', () => {
    const onFinish = vi.fn();
    beginHorizontalResize({
      pointerId: 3,
      startX: 200,
      initialWidth: 400,
      direction: -1,
      captureTarget: document.createElement('button'),
      getBounds: () => ({ min: 240, max: 1200 }),
      onResize: vi.fn(),
      onFinish,
    });

    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 3, clientX: 150, buttons: 0 }));

    expect(onFinish).toHaveBeenCalledWith(400);
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('finishes when the window loses focus', () => {
    const onFinish = vi.fn();
    beginHorizontalResize({
      pointerId: 9,
      startX: 0,
      initialWidth: 320,
      direction: 1,
      captureTarget: document.createElement('button'),
      getBounds: () => ({ min: 240, max: 1200 }),
      onResize: vi.fn(),
      onFinish,
    });

    window.dispatchEvent(new Event('blur'));

    expect(onFinish).toHaveBeenCalledWith(320);
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('uses mouseup as a fallback when pointerup is not delivered', () => {
    const onFinish = vi.fn();
    beginHorizontalResize({
      pointerId: 11,
      startX: 0,
      initialWidth: 360,
      direction: 1,
      captureTarget: document.createElement('button'),
      getBounds: () => ({ min: 240, max: 1200 }),
      onResize: vi.fn(),
      onFinish,
    });

    window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));

    expect(onFinish).toHaveBeenCalledWith(360);
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('catches mouseup on the captured resize handle', () => {
    const handle = document.createElement('button');
    const onFinish = vi.fn();
    beginHorizontalResize({
      pointerId: 22,
      startX: 0,
      initialWidth: 360,
      direction: 1,
      captureTarget: handle,
      getBounds: () => ({ min: 240, max: 1200 }),
      onResize: vi.fn(),
      onFinish,
    });

    handle.dispatchEvent(mouseEvent('mouseup', { button: 0 }));

    expect(onFinish).toHaveBeenCalledWith(360);
    expect(document.querySelector('[data-horizontal-resize-guard="true"]')).toBeNull();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('finishes when a released pointer leaves or re-enters the resize surface', () => {
    const onFinish = vi.fn();
    beginHorizontalResize({
      pointerId: 23,
      startX: 100,
      initialWidth: 420,
      direction: 1,
      captureTarget: document.createElement('button'),
      getBounds: () => ({ min: 240, max: 1200 }),
      onResize: vi.fn(),
      onFinish,
    });

    window.dispatchEvent(pointerEvent('pointerout', {
      pointerId: 23,
      pointerType: 'mouse',
      clientX: 700,
      buttons: 0,
    }));

    expect(onFinish).toHaveBeenCalledWith(420);
    expect(document.querySelector('[data-horizontal-resize-guard="true"]')).toBeNull();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('finishes on a released mouse pointer even when pointer capture reports a stale id', () => {
    const onFinish = vi.fn();
    beginHorizontalResize({
      pointerId: 21,
      startX: 0,
      initialWidth: 360,
      direction: 1,
      captureTarget: document.createElement('button'),
      getBounds: () => ({ min: 240, max: 1200 }),
      onResize: vi.fn(),
      onFinish,
    });

    window.dispatchEvent(pointerEvent('pointerup', {
      pointerId: 99,
      pointerType: 'mouse',
      clientX: 900,
      buttons: 0,
    }));

    expect(onFinish).toHaveBeenCalledWith(360);
    expect(document.querySelector('[data-horizontal-resize-guard="true"]')).toBeNull();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('finishes on pointerup when browsers omit pointerType and report a stale id', () => {
    const onFinish = vi.fn();
    beginHorizontalResize({
      pointerId: 34,
      startX: 0,
      initialWidth: 360,
      direction: 1,
      captureTarget: document.createElement('button'),
      getBounds: () => ({ min: 240, max: 1200 }),
      onResize: vi.fn(),
      onFinish,
    });

    window.dispatchEvent(pointerEvent('pointerup', {
      pointerId: 99,
      pointerType: undefined,
      clientX: 900,
      buttons: 0,
    }));
    window.dispatchEvent(pointerEvent('pointermove', {
      pointerId: 34,
      pointerType: undefined,
      clientX: 1100,
      buttons: 1,
    }));

    expect(onFinish).toHaveBeenCalledWith(360);
    expect(document.querySelector('[data-horizontal-resize-guard="true"]')).toBeNull();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('finishes when a new mouse pointer event arrives after a missed release', () => {
    const onFinish = vi.fn();
    beginHorizontalResize({
      pointerId: 35,
      startX: 0,
      initialWidth: 360,
      direction: 1,
      captureTarget: document.createElement('button'),
      getBounds: () => ({ min: 240, max: 1200 }),
      onResize: vi.fn(),
      onFinish,
    });

    window.dispatchEvent(pointerEvent('pointerover', {
      pointerId: 99,
      pointerType: 'mouse',
      clientX: 900,
      buttons: 1,
    }));
    window.dispatchEvent(pointerEvent('pointermove', {
      pointerId: 35,
      pointerType: 'mouse',
      clientX: 1100,
      buttons: 1,
    }));

    expect(onFinish).toHaveBeenCalledWith(360);
    expect(document.querySelector('[data-horizontal-resize-guard="true"]')).toBeNull();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('finishes instead of resizing when a different mouse pointer moves', () => {
    const onResize = vi.fn();
    const onFinish = vi.fn();
    beginHorizontalResize({
      pointerId: 36,
      startX: 0,
      initialWidth: 360,
      direction: 1,
      captureTarget: document.createElement('button'),
      getBounds: () => ({ min: 240, max: 1200 }),
      onResize,
      onFinish,
    });
    onResize.mockClear();

    window.dispatchEvent(pointerEvent('pointermove', {
      pointerId: 88,
      pointerType: 'mouse',
      clientX: 1100,
      buttons: 1,
    }));

    expect(onFinish).toHaveBeenCalledWith(360);
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(360);
    expect(document.querySelector('[data-horizontal-resize-guard="true"]')).toBeNull();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('finishes on mouse pointerup even when the browser reports stale buttons', () => {
    const onFinish = vi.fn();
    beginHorizontalResize({
      pointerId: 33,
      startX: 0,
      initialWidth: 360,
      direction: 1,
      captureTarget: document.createElement('button'),
      getBounds: () => ({ min: 240, max: 1200 }),
      onResize: vi.fn(),
      onFinish,
    });

    window.dispatchEvent(pointerEvent('pointerup', {
      pointerId: 99,
      pointerType: 'mouse',
      clientX: 900,
      buttons: 1,
    }));
    window.dispatchEvent(pointerEvent('pointermove', {
      pointerId: 33,
      pointerType: 'mouse',
      clientX: 1100,
      buttons: 1,
    }));

    expect(onFinish).toHaveBeenCalledWith(360);
    expect(document.querySelector('[data-horizontal-resize-guard="true"]')).toBeNull();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('finishes when a released mouse pointer reports stale buttons with zero pressure', () => {
    const onFinish = vi.fn();
    beginHorizontalResize({
      pointerId: 25,
      startX: 100,
      initialWidth: 420,
      direction: 1,
      captureTarget: document.createElement('button'),
      getBounds: () => ({ min: 240, max: 1200 }),
      onResize: vi.fn(),
      onFinish,
    });

    window.dispatchEvent(pointerEvent('pointermove', {
      pointerId: 25,
      pointerType: 'mouse',
      clientX: 700,
      buttons: 1,
      pressure: 0,
    }));

    expect(onFinish).toHaveBeenCalledWith(420);
    expect(document.querySelector('[data-horizontal-resize-guard="true"]')).toBeNull();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('covers iframe-heavy content while resizing and removes the guard on finish', () => {
    const onFinish = vi.fn();
    beginHorizontalResize({
      pointerId: 14,
      startX: 0,
      initialWidth: 360,
      direction: 1,
      captureTarget: document.createElement('button'),
      getBounds: () => ({ min: 240, max: 1200 }),
      onResize: vi.fn(),
      onFinish,
    });

    const guard = document.querySelector<HTMLElement>('[data-horizontal-resize-guard="true"]');
    expect(guard).toBeTruthy();
    expect(guard?.style.cursor).toBe('col-resize');

    guard?.dispatchEvent(mouseEvent('mouseup', { button: 0 }));

    expect(onFinish).toHaveBeenCalledWith(360);
    expect(document.querySelector('[data-horizontal-resize-guard="true"]')).toBeNull();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('catches pointer release directly on the resize guard', () => {
    const onFinish = vi.fn();
    beginHorizontalResize({
      pointerId: 15,
      startX: 0,
      initialWidth: 360,
      direction: 1,
      captureTarget: document.createElement('button'),
      getBounds: () => ({ min: 240, max: 1200 }),
      onResize: vi.fn(),
      onFinish,
    });

    const guard = document.querySelector<HTMLElement>('[data-horizontal-resize-guard="true"]');
    guard?.dispatchEvent(pointerEvent('pointerup', { pointerId: 15, clientX: 900, buttons: 0 }));

    expect(onFinish).toHaveBeenCalledWith(360);
    expect(document.querySelector('[data-horizontal-resize-guard="true"]')).toBeNull();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('cancels dragging on context menu gestures', () => {
    const onFinish = vi.fn();
    beginHorizontalResize({
      pointerId: 16,
      startX: 0,
      initialWidth: 360,
      direction: 1,
      captureTarget: document.createElement('button'),
      getBounds: () => ({ min: 240, max: 1200 }),
      onResize: vi.fn(),
      onFinish,
    });

    window.dispatchEvent(mouseEvent('contextmenu', { button: 2 }));

    expect(onFinish).toHaveBeenCalledWith(360);
    expect(document.querySelector('[data-horizontal-resize-guard="true"]')).toBeNull();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('also catches document mouseup when release is missed by the window listener', () => {
    const onFinish = vi.fn();
    beginHorizontalResize({
      pointerId: 12,
      startX: 0,
      initialWidth: 360,
      direction: 1,
      captureTarget: document.createElement('button'),
      getBounds: () => ({ min: 240, max: 1200 }),
      onResize: vi.fn(),
      onFinish,
    });

    document.dispatchEvent(mouseEvent('mouseup', { button: 0 }));

    expect(onFinish).toHaveBeenCalledWith(360);
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('finishes on mousemove fallback when the pointer was released outside the viewport', () => {
    const onFinish = vi.fn();
    beginHorizontalResize({
      pointerId: 13,
      startX: 100,
      initialWidth: 420,
      direction: 1,
      captureTarget: document.createElement('button'),
      getBounds: () => ({ min: 240, max: 1200 }),
      onResize: vi.fn(),
      onFinish,
    });

    window.dispatchEvent(mouseEvent('mousemove', { clientX: 700, buttons: 0 }));

    expect(onFinish).toHaveBeenCalledWith(420);
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('does not finish only because a pressed mouse leaves a resize surface', () => {
    const onFinish = vi.fn();
    beginHorizontalResize({
      pointerId: 17,
      startX: 100,
      initialWidth: 420,
      direction: 1,
      captureTarget: document.createElement('button'),
      getBounds: () => ({ min: 240, max: 1200 }),
      onResize: vi.fn(),
      onFinish,
    });

    document.dispatchEvent(mouseEvent('mouseleave', { clientX: 700, buttons: 1 }));

    expect(onFinish).not.toHaveBeenCalled();
    expect(document.querySelector('[data-horizontal-resize-guard="true"]')).toBeTruthy();

    document.dispatchEvent(mouseEvent('mouseup', { button: 0 }));

    expect(onFinish).toHaveBeenCalledWith(1020);
    expect(document.querySelector('[data-horizontal-resize-guard="true"]')).toBeNull();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('keeps resizing active across a pressed viewport leave at a clamped boundary', () => {
    const onResize = vi.fn();
    const onFinish = vi.fn();
    beginHorizontalResize({
      pointerId: 24,
      startX: 100,
      initialWidth: 420,
      direction: 1,
      captureTarget: document.createElement('button'),
      getBounds: () => ({ min: 240, max: 1200 }),
      onResize,
      onFinish,
    });

    window.dispatchEvent(mouseEvent('mouseleave', { clientX: 1600, buttons: 1 }));
    expect(onFinish).not.toHaveBeenCalled();
    window.dispatchEvent(mouseEvent('mousemove', { clientX: 1500, buttons: 1 }));
    expect(onFinish).not.toHaveBeenCalled();
    window.dispatchEvent(mouseEvent('mousemove', { clientX: 870, buttons: 1 }));
    window.dispatchEvent(mouseEvent('mouseup', { button: 0 }));

    expect(onFinish).toHaveBeenCalledWith(1190);
    expect(document.querySelector('[data-horizontal-resize-guard="true"]')).toBeNull();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('finishes when a released pointer re-enters the window after an outside release', () => {
    const onFinish = vi.fn();
    beginHorizontalResize({
      pointerId: 18,
      startX: 100,
      initialWidth: 420,
      direction: 1,
      captureTarget: document.createElement('button'),
      getBounds: () => ({ min: 240, max: 1200 }),
      onResize: vi.fn(),
      onFinish,
    });

    window.dispatchEvent(pointerEvent('pointerover', {
      pointerId: 99,
      pointerType: 'mouse',
      clientX: 700,
      buttons: 0,
    }));

    expect(onFinish).toHaveBeenCalledWith(420);
    expect(document.querySelector('[data-horizontal-resize-guard="true"]')).toBeNull();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('finishes when a released pointer enters the window after an outside release', () => {
    const onFinish = vi.fn();
    beginHorizontalResize({
      pointerId: 20,
      startX: 100,
      initialWidth: 420,
      direction: 1,
      captureTarget: document.createElement('button'),
      getBounds: () => ({ min: 240, max: 1200 }),
      onResize: vi.fn(),
      onFinish,
    });

    window.dispatchEvent(pointerEvent('pointerenter', {
      pointerId: 99,
      pointerType: 'mouse',
      clientX: 700,
      buttons: 0,
    }));

    expect(onFinish).toHaveBeenCalledWith(420);
    expect(document.querySelector('[data-horizontal-resize-guard="true"]')).toBeNull();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('finishes when the resize guard sees a released mouse re-enter', () => {
    const onFinish = vi.fn();
    beginHorizontalResize({
      pointerId: 19,
      startX: 100,
      initialWidth: 420,
      direction: 1,
      captureTarget: document.createElement('button'),
      getBounds: () => ({ min: 240, max: 1200 }),
      onResize: vi.fn(),
      onFinish,
    });

    const guard = document.querySelector<HTMLElement>('[data-horizontal-resize-guard="true"]');
    guard?.dispatchEvent(mouseEvent('mouseover', { clientX: 700, buttons: 0 }));

    expect(onFinish).toHaveBeenCalledWith(420);
    expect(document.querySelector('[data-horizontal-resize-guard="true"]')).toBeNull();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('finishes on the next pointerdown if an outside release left the guard active', () => {
    const onFinish = vi.fn();
    beginHorizontalResize({
      pointerId: 41,
      startX: 100,
      initialWidth: 420,
      direction: 1,
      captureTarget: document.createElement('button'),
      getBounds: () => ({ min: 240, max: 1200 }),
      onResize: vi.fn(),
      onFinish,
    });

    document.documentElement.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 42,
      pointerType: 'mouse',
      clientX: 700,
      buttons: 1,
    }));

    expect(onFinish).toHaveBeenCalledWith(420);
    expect(document.querySelector('[data-horizontal-resize-guard="true"]')).toBeNull();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('finishes on click if a browser emits click after a missed release', () => {
    const onFinish = vi.fn();
    beginHorizontalResize({
      pointerId: 43,
      startX: 100,
      initialWidth: 420,
      direction: 1,
      captureTarget: document.createElement('button'),
      getBounds: () => ({ min: 240, max: 1200 }),
      onResize: vi.fn(),
      onFinish,
    });

    document.dispatchEvent(mouseEvent('click', { button: 0 }));

    expect(onFinish).toHaveBeenCalledWith(420);
    expect(document.querySelector('[data-horizontal-resize-guard="true"]')).toBeNull();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });
});
