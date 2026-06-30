// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFileEditorDismissal } from './codeAgentFileEditorDismissal';

function pointerDown(target: EventTarget) {
  target.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
}

describe('installFileEditorDismissal', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('clears editor selections when the user clicks outside the file surface', () => {
    const root = document.createElement('div');
    const outside = document.createElement('button');
    document.body.append(root, outside);
    const editor = { setSelections: vi.fn() };
    const onDismiss = vi.fn();
    const cleanup = installFileEditorDismissal({
      root,
      editor,
      isBlocked: () => false,
      onDismiss,
    });

    pointerDown(outside);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(editor.setSelections).toHaveBeenCalledWith([]);
    cleanup();
  });

  it('keeps selections when the pointer starts inside the file surface', () => {
    const root = document.createElement('div');
    const child = document.createElement('button');
    root.append(child);
    document.body.append(root);
    const editor = { setSelections: vi.fn() };
    const onDismiss = vi.fn();
    const cleanup = installFileEditorDismissal({
      root,
      editor,
      isBlocked: () => false,
      onDismiss,
    });

    pointerDown(child);

    expect(onDismiss).not.toHaveBeenCalled();
    expect(editor.setSelections).not.toHaveBeenCalled();
    cleanup();
  });

  it('does not dismiss while interactions are blocked', () => {
    const root = document.createElement('div');
    const outside = document.createElement('button');
    document.body.append(root, outside);
    const editor = { setSelections: vi.fn() };
    const cleanup = installFileEditorDismissal({
      root,
      editor,
      isBlocked: () => true,
      onDismiss: vi.fn(),
    });

    pointerDown(outside);

    expect(editor.setSelections).not.toHaveBeenCalled();
    cleanup();
  });

  it('dismisses the file editor when Escape is pressed inside the editor shadow root', () => {
    const root = document.createElement('div');
    const file = document.createElement('diffs-container');
    const shadow = file.attachShadow({ mode: 'open' });
    const editable = document.createElement('button');
    editable.setAttribute('data-content', '');
    shadow.append(editable);
    root.append(file);
    document.body.append(root);
    editable.focus();
    const editor = { setSelections: vi.fn() };
    const onDismiss = vi.fn();
    const cleanup = installFileEditorDismissal({
      root,
      editor,
      isBlocked: () => false,
      onDismiss,
    });

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(editor.setSelections).toHaveBeenCalledWith([]);
    cleanup();
  });
});
