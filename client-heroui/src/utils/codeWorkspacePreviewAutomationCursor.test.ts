// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCodeWorkspacePreviewAutomationCursorEvent,
  codeWorkspacePreviewAutomationCursorOpacity,
  codeWorkspacePreviewAutomationCursorPhase,
  resolveCodeWorkspacePreviewAutomationCursorPoint,
} from './codeWorkspacePreviewAutomationCursor';
import type { CodeWorkspacePreviewAutomationRequest } from './socket';

function request(
  operation: CodeWorkspacePreviewAutomationRequest['operation'],
  input: unknown = {},
): CodeWorkspacePreviewAutomationRequest {
  return {
    requestId: `request:${operation}`,
    roomId: 'room-1',
    tabId: 'browser:preview',
    operation,
    input,
    timeoutMs: 500,
  };
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function createIframe(html = ''): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  Object.defineProperties(iframe, {
    clientWidth: { configurable: true, value: 200 },
    clientHeight: { configurable: true, value: 100 },
  });
  vi.spyOn(iframe, 'getBoundingClientRect').mockReturnValue(rect(10, 20, 400, 200));
  const frameDocument = iframe.contentDocument;
  if (!frameDocument) {
    throw new Error('test iframe was not created');
  }
  frameDocument.open();
  frameDocument.write(html);
  frameDocument.close();
  return iframe;
}

describe('codeWorkspacePreviewAutomationCursor', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('matches the active and idle cursor opacity contract', () => {
    expect(codeWorkspacePreviewAutomationCursorOpacity(true, 'agent')).toBe(1);
    expect(codeWorkspacePreviewAutomationCursorOpacity(false, 'agent')).toBe(0.35);
    expect(codeWorkspacePreviewAutomationCursorOpacity(false, 'none')).toBe(0.35);
    expect(codeWorkspacePreviewAutomationCursorOpacity(false, 'human')).toBe(0.18);
  });

  it('maps automation operations to cursor phases', () => {
    expect(codeWorkspacePreviewAutomationCursorPhase('click')).toBe('click');
    expect(codeWorkspacePreviewAutomationCursorPhase('type')).toBe('move');
    expect(codeWorkspacePreviewAutomationCursorPhase('press')).toBe('move');
    expect(codeWorkspacePreviewAutomationCursorPhase('scroll')).toBe('move');
    expect(codeWorkspacePreviewAutomationCursorPhase('snapshot')).toBeNull();
    expect(codeWorkspacePreviewAutomationCursorPhase('evaluate')).toBeNull();
  });

  it('converts preview client coordinates into iframe coordinates', () => {
    const iframe = createIframe();
    expect(resolveCodeWorkspacePreviewAutomationCursorPoint(
      request('click', { clientX: 210, clientY: 120 }),
      iframe,
    )).toEqual({ x: 100, y: 50 });
  });

  it('resolves accessible locators to element centers inside the iframe', () => {
    const iframe = createIframe('<button id="save" type="button" aria-label="Save changes">Save</button>');
    const button = iframe.contentDocument?.querySelector('#save') as HTMLButtonElement;
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(rect(30, 40, 20, 10));

    expect(resolveCodeWorkspacePreviewAutomationCursorPoint(
      request('click', { locator: 'role=button[name="Save"]' }),
      iframe,
    )).toEqual({ x: 40, y: 45 });
  });

  it('builds sequenced events only for operations with a visible target', () => {
    const iframe = createIframe('<input id="title" aria-label="Title" />');
    const input = iframe.contentDocument?.querySelector('#title') as HTMLInputElement;
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(rect(12, 14, 80, 20));

    expect(buildCodeWorkspacePreviewAutomationCursorEvent(
      request('type', { selector: '#title', text: 'Launch' }),
      iframe,
      7,
    )).toEqual({
      x: 52,
      y: 24,
      phase: 'move',
      sequence: 7,
    });
    expect(buildCodeWorkspacePreviewAutomationCursorEvent(
      request('snapshot'),
      iframe,
      8,
    )).toBeNull();
  });

  it('uses the frame center for untargeted scroll requests', () => {
    const iframe = createIframe();
    expect(resolveCodeWorkspacePreviewAutomationCursorPoint(
      request('scroll', { deltaY: 240 }),
      iframe,
    )).toEqual({ x: 100, y: 50 });
  });
});
