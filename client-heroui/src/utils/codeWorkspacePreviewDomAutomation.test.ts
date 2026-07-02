// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CODE_WORKSPACE_PREVIEW_AUTOMATION_DOM_OPERATIONS,
  isCodeWorkspacePreviewDomAutomationOperation,
  runCodeWorkspacePreviewDomAutomation,
} from './codeWorkspacePreviewDomAutomation';
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

function createIframe(html: string): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  const frameDocument = iframe.contentDocument;
  if (!frameDocument) {
    throw new Error('test iframe was not created');
  }
  frameDocument.open();
  frameDocument.write(html);
  frameDocument.close();
  return iframe;
}

function frameState(iframe: HTMLIFrameElement) {
  return {
    iframe,
    tabId: 'browser:preview',
    loading: false,
    title: 'Preview',
    url: 'https://example.test/preview',
  };
}

describe('codeWorkspacePreviewDomAutomation', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('advertises DOM operations distinctly from session operations', () => {
    expect(CODE_WORKSPACE_PREVIEW_AUTOMATION_DOM_OPERATIONS).toEqual([
      'snapshot',
      'click',
      'type',
      'press',
      'scroll',
      'evaluate',
      'waitFor',
    ]);
    expect(isCodeWorkspacePreviewDomAutomationOperation('click')).toBe(true);
    expect(isCodeWorkspacePreviewDomAutomationOperation('navigate')).toBe(false);
  });

  it('clicks and types inside an accessible preview frame', async () => {
    const iframe = createIframe(`
      <button id="submit" type="button">Send</button>
      <input id="message" aria-label="Message" value="old" />
    `);
    iframe.contentDocument?.getElementById('submit')?.addEventListener('click', () => {
      iframe.contentDocument?.body.setAttribute('data-clicked', 'yes');
    });

    await runCodeWorkspacePreviewDomAutomation(
      request('click', { locator: 'role=button[name="Send"]' }),
      frameState(iframe),
    );
    expect(iframe.contentDocument?.body.getAttribute('data-clicked')).toBe('yes');

    await runCodeWorkspacePreviewDomAutomation(
      request('type', { selector: '#message', text: 'hello', clear: true }),
      frameState(iframe),
    );
    expect((iframe.contentDocument?.querySelector('#message') as HTMLInputElement).value).toBe('hello');
  });

  it('evaluates, waits for text, and returns a semantic snapshot', async () => {
    const iframe = createIframe(`
      <main>
        <h1>Dashboard</h1>
        <button type="button" aria-label="Save report">Save</button>
      </main>
    `);

    await expect(runCodeWorkspacePreviewDomAutomation(
      request('evaluate', { expression: 'document.querySelector("h1").textContent' }),
      frameState(iframe),
    )).resolves.toBe('Dashboard');

    await expect(runCodeWorkspacePreviewDomAutomation(
      request('waitFor', { text: 'Dashboard', locator: 'role=button[name="Save"]' }),
      frameState(iframe),
    )).resolves.toMatchObject({ matched: true, text: 'Dashboard' });

    await expect(runCodeWorkspacePreviewDomAutomation(
      request('snapshot'),
      frameState(iframe),
    )).resolves.toMatchObject({
      visibleText: expect.stringContaining('Dashboard'),
      interactiveElements: [
        expect.objectContaining({
          role: 'button',
          name: 'Save report',
        }),
      ],
      screenshot: expect.objectContaining({
        mimeType: 'image/png',
        unavailable: true,
      }),
    });
  });

  it('reports an inaccessible preview frame clearly', async () => {
    await expect(runCodeWorkspacePreviewDomAutomation(
      request('snapshot'),
      { ...frameState(null as unknown as HTMLIFrameElement), iframe: null },
    )).rejects.toThrow('Workspace preview automation frame is not ready.');
  });
});
