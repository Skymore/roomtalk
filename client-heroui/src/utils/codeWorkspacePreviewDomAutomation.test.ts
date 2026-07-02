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

type AccessibilityNode = {
  role: string;
  name: string;
  value?: string;
  checked?: boolean;
  level?: number;
  children?: AccessibilityNode[];
  nodeCount?: number;
  maxNodeCount?: number;
  truncated?: boolean;
};

function flattenAccessibilityTree(node: AccessibilityNode): AccessibilityNode[] {
  return [
    node,
    ...(node.children ?? []).flatMap((child) => flattenAccessibilityTree(child)),
  ];
}

function installRecordingFrameMocks(
  iframe: HTMLIFrameElement,
  options: { manualImageLoad?: boolean } = {},
) {
  const imageLoads: Array<() => void> = [];
  let stopCalls = 0;

  class TestImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    set src(_value: string) {
      const load = () => this.onload?.();
      if (options.manualImageLoad) {
        imageLoads.push(load);
      } else {
        queueMicrotask(load);
      }
    }
  }

  class TestMediaRecorder extends EventTarget {
    static isTypeSupported = vi.fn((mimeType: string) => mimeType.startsWith('video/webm'));

    state: RecordingState = 'inactive';
    readonly mimeType: string;

    constructor(_stream: MediaStream, mediaOptions?: MediaRecorderOptions) {
      super();
      this.mimeType = mediaOptions?.mimeType || 'video/webm';
    }

    start() {
      this.state = 'recording';
    }

    stop() {
      stopCalls += 1;
      const dataEvent = new Event('dataavailable') as Event & { data: Blob };
      Object.defineProperty(dataEvent, 'data', {
        configurable: true,
        value: new Blob(['recorded-video'], { type: this.mimeType }),
      });
      this.dispatchEvent(dataEvent);
      this.state = 'inactive';
      this.dispatchEvent(new Event('stop'));
    }
  }

  const originalMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder');
  const originalWindowMediaRecorder = Object.getOwnPropertyDescriptor(window, 'MediaRecorder');
  const originalWindowImage = Object.getOwnPropertyDescriptor(window, 'Image');
  Object.defineProperty(globalThis, 'MediaRecorder', {
    configurable: true,
    value: TestMediaRecorder,
  });
  Object.defineProperty(window, 'MediaRecorder', {
    configurable: true,
    value: TestMediaRecorder,
  });
  Object.defineProperty(window, 'Image', {
    configurable: true,
    value: TestImage,
  });

  const frameWindow = iframe.contentWindow as Window & typeof globalThis;
  const originalFrameImage = Object.getOwnPropertyDescriptor(frameWindow, 'Image');
  const originalCaptureStream = Object.getOwnPropertyDescriptor(
    frameWindow.HTMLCanvasElement.prototype,
    'captureStream',
  );
  Object.defineProperties(frameWindow, {
    innerWidth: { configurable: true, value: 640 },
    innerHeight: { configurable: true, value: 360 },
    Image: { configurable: true, value: TestImage },
  });
  vi.spyOn(frameWindow.HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  Object.defineProperty(frameWindow.HTMLCanvasElement.prototype, 'captureStream', {
    configurable: true,
    value: vi.fn(() => ({} as MediaStream)),
  });

  return {
    imageLoads,
    stopCalls: () => stopCalls,
    restore: () => {
      if (originalMediaRecorder) {
        Object.defineProperty(globalThis, 'MediaRecorder', originalMediaRecorder);
      } else {
        Reflect.deleteProperty(globalThis, 'MediaRecorder');
      }
      if (originalWindowMediaRecorder) {
        Object.defineProperty(window, 'MediaRecorder', originalWindowMediaRecorder);
      } else {
        Reflect.deleteProperty(window, 'MediaRecorder');
      }
      if (originalWindowImage) {
        Object.defineProperty(window, 'Image', originalWindowImage);
      } else {
        Reflect.deleteProperty(window, 'Image');
      }
      if (originalFrameImage) {
        Object.defineProperty(frameWindow, 'Image', originalFrameImage);
      } else {
        Reflect.deleteProperty(frameWindow, 'Image');
      }
      if (originalCaptureStream) {
        Object.defineProperty(frameWindow.HTMLCanvasElement.prototype, 'captureStream', originalCaptureStream);
      } else {
        Reflect.deleteProperty(frameWindow.HTMLCanvasElement.prototype, 'captureStream');
      }
    },
  };
}

describe('codeWorkspacePreviewDomAutomation', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
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
      'previewAnnotation',
      'clearCookies',
      'clearCache',
      'recordingStart',
      'recordingStop',
    ]);
    expect(isCodeWorkspacePreviewDomAutomationOperation('click')).toBe(true);
    expect(isCodeWorkspacePreviewDomAutomationOperation('clearCache')).toBe(true);
    expect(isCodeWorkspacePreviewDomAutomationOperation('previewAnnotation')).toBe(true);
    expect(isCodeWorkspacePreviewDomAutomationOperation('recordingStart')).toBe(true);
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

  it('presses keys with browser-like editing behavior inside a focused preview frame control', async () => {
    const iframe = createIframe(`
      <input id="message" aria-label="Message" value="old" />
    `);
    const input = iframe.contentDocument?.querySelector('#message') as HTMLInputElement;
    const events: string[] = [];
    input.addEventListener('keydown', (event) => {
      events.push(`keydown:${event.key}:${event.code}:${event.keyCode}:${event.shiftKey}`);
    });
    input.addEventListener('keyup', (event) => {
      events.push(`keyup:${event.key}:${event.code}:${event.keyCode}:${event.shiftKey}`);
    });
    input.addEventListener('input', (event) => {
      events.push(`input:${(event as InputEvent).inputType}:${(event as InputEvent).data ?? ''}`);
    });

    input.focus();
    input.setSelectionRange(1, 1);
    await expect(runCodeWorkspacePreviewDomAutomation(
      request('press', { key: 'a' }),
      frameState(iframe),
    )).resolves.toMatchObject({
      pressed: true,
      key: 'a',
      code: 'KeyA',
      modifiers: 0,
      text: 'a',
      defaultApplied: true,
      inputType: 'insertText',
      selectionStart: 2,
      selectionEnd: 2,
      value: 'oald',
    });
    expect(input.value).toBe('oald');
    expect(events).toEqual([
      'keydown:a:KeyA:65:false',
      'input:insertText:a',
      'keyup:a:KeyA:65:false',
    ]);

    input.setSelectionRange(input.value.length, input.value.length);
    await expect(runCodeWorkspacePreviewDomAutomation(
      request('press', { key: '1', modifiers: ['Shift'] }),
      frameState(iframe),
    )).resolves.toMatchObject({
      key: '!',
      code: 'Digit1',
      modifiers: 8,
      text: '!',
      defaultApplied: true,
      value: 'oald!',
    });
    expect(input.value).toBe('oald!');

    await expect(runCodeWorkspacePreviewDomAutomation(
      request('press', { key: 'a', modifiers: ['Control'] }),
      frameState(iframe),
    )).resolves.toMatchObject({
      key: 'a',
      code: 'KeyA',
      modifiers: 2,
      defaultApplied: true,
      inputType: 'selectAll',
      selectionStart: 0,
      selectionEnd: 5,
    });
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(5);

    await expect(runCodeWorkspacePreviewDomAutomation(
      request('press', { key: 'Backspace' }),
      frameState(iframe),
    )).resolves.toMatchObject({
      key: 'Backspace',
      code: 'Backspace',
      defaultApplied: true,
      inputType: 'deleteContentBackward',
      value: '',
    });
    expect(input.value).toBe('');
  });

  it('does not apply keyboard editing defaults when preview code prevents keydown', async () => {
    const iframe = createIframe('<input id="message" value="old" />');
    const input = iframe.contentDocument?.querySelector('#message') as HTMLInputElement;
    input.focus();
    input.setSelectionRange(1, 1);
    input.addEventListener('keydown', (event) => event.preventDefault());

    await expect(runCodeWorkspacePreviewDomAutomation(
      request('press', { key: 'z' }),
      frameState(iframe),
    )).resolves.toMatchObject({
      pressed: true,
      key: 'z',
      code: 'KeyZ',
      defaultApplied: false,
    });
    expect(input.value).toBe('old');
  });

  it('reports typed input errors for non-editable targets and invalid selectors', async () => {
    const iframe = createIframe(`
      <button id="submit" type="button">Send</button>
    `);

    await expect(runCodeWorkspacePreviewDomAutomation(
      request('type', { selector: '#submit', text: 'hello' }),
      frameState(iframe),
    )).rejects.toMatchObject({
      _tag: 'PreviewAutomationTargetNotEditableError',
      message: 'Preview automation type request request:type requires an editable target in tab browser:preview.',
      detail: {
        requestId: 'request:type',
        operation: 'type',
        roomId: 'room-1',
        tabId: 'browser:preview',
        selectorKind: 'selector',
        selectorLength: 7,
      },
    });

    await expect(runCodeWorkspacePreviewDomAutomation(
      request('click', { selector: '[' }),
      frameState(iframe),
    )).rejects.toMatchObject({
      _tag: 'PreviewAutomationInvalidSelectorError',
      message: 'Preview automation click request request:click received an invalid selector.',
      detail: {
        requestId: 'request:click',
        operation: 'click',
        roomId: 'room-1',
        tabId: 'browser:preview',
        selectorKind: 'selector',
        selectorLength: 1,
      },
    });
  });

  it('reports typed automation errors for missing targets, coordinates, waits, and evaluation', async () => {
    const iframe = createIframe(`
      <main>
        <button id="submit" type="button">Send</button>
      </main>
    `);

    await expect(runCodeWorkspacePreviewDomAutomation(
      request('click', { selector: '#missing' }),
      frameState(iframe),
    )).rejects.toMatchObject({
      _tag: 'PreviewAutomationTargetNotFoundError',
      detail: {
        requestId: 'request:click',
        operation: 'click',
        roomId: 'room-1',
        tabId: 'browser:preview',
        selectorKind: 'selector',
        selectorLength: 8,
      },
    });

    await expect(runCodeWorkspacePreviewDomAutomation(
      request('click', { x: 2048, y: 12 }),
      frameState(iframe),
    )).rejects.toMatchObject({
      _tag: 'PreviewAutomationCoordinatesOutsideViewportError',
      detail: {
        requestId: 'request:click',
        operation: 'click',
        roomId: 'room-1',
        tabId: 'browser:preview',
        x: 2048,
        y: 12,
        viewportWidth: expect.any(Number),
        viewportHeight: expect.any(Number),
      },
    });

    await expect(runCodeWorkspacePreviewDomAutomation(
      request('waitFor', { text: 'Never appears', timeoutMs: 1 }),
      frameState(iframe),
    )).rejects.toMatchObject({
      _tag: 'PreviewAutomationTimeoutError',
      detail: {
        requestId: 'request:waitFor',
        operation: 'waitFor',
        roomId: 'room-1',
        tabId: 'browser:preview',
        timeoutMs: 1,
      },
    });

    await expect(runCodeWorkspacePreviewDomAutomation(
      request('evaluate', { expression: '(() => { throw new Error("boom") })()' }),
      frameState(iframe),
    )).rejects.toMatchObject({
      _tag: 'PreviewAutomationEvaluationError',
      detail: {
        requestId: 'request:evaluate',
        operation: 'evaluate',
        roomId: 'room-1',
        tabId: 'browser:preview',
        detailKind: 'message',
        detailLength: expect.any(Number),
      },
    });

    await expect(runCodeWorkspacePreviewDomAutomation(
      request('evaluate', { expression: '"x".repeat(65000)' }),
      frameState(iframe),
    )).rejects.toMatchObject({
      _tag: 'PreviewAutomationResultTooLargeError',
      detail: {
        requestId: 'request:evaluate',
        operation: 'evaluate',
        roomId: 'room-1',
        tabId: 'browser:preview',
        actualBytes: expect.any(Number),
        maximumBytes: 64000,
      },
    });
  });

  it('captures a preview annotation from client coordinates inside the frame', async () => {
    const iframe = createIframe(`
      <main>
        <button id="save" type="button" class="primary">Save changes</button>
      </main>
    `);
    const button = iframe.contentDocument?.querySelector('#save') as HTMLButtonElement;
    Object.defineProperties(iframe, {
      clientWidth: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 300 },
    });
    vi.spyOn(iframe, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 410,
      bottom: 320,
      width: 400,
      height: 300,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(iframe.contentDocument!, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => button),
    });
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      x: 24,
      y: 32,
      left: 24,
      top: 32,
      right: 144,
      bottom: 64,
      width: 120,
      height: 32,
      toJSON: () => ({}),
    } as DOMRect);

    await expect(runCodeWorkspacePreviewDomAutomation(
      request('previewAnnotation', { clientX: 64, clientY: 48 }),
      frameState(iframe),
    )).resolves.toMatchObject({
      pageUrl: expect.stringContaining('about:blank'),
      elements: [
        expect.objectContaining({
          element: expect.objectContaining({
            tagName: 'button',
            selector: '#save',
            htmlPreview: expect.stringContaining('Save changes'),
          }),
          rect: {
            x: 24,
            y: 32,
            width: 120,
            height: 32,
          },
        }),
      ],
    });
  });

  it('evaluates, waits for text, and returns a semantic snapshot', async () => {
    const iframe = createIframe(`
      <title>Dashboard Page</title>
      <main>
        <h1>Dashboard</h1>
        <nav aria-label="Primary navigation">
          <a href="/reports">Reports</a>
        </nav>
        <form aria-label="Filters">
          <label for="search">Search query</label>
          <input id="search" value="launch" />
          <label><input id="archived" type="checkbox" checked /> Include archived</label>
        </form>
        <button type="button" aria-label="Save report">Save</button>
        <button type="button" style="display: none">Hidden action</button>
        <button type="button" aria-hidden="true">Ignored action</button>
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

    const snapshot = await runCodeWorkspacePreviewDomAutomation(
      request('snapshot'),
      frameState(iframe),
    ) as {
      visibleText: string;
      interactiveElements: Array<{ role: string; name: string }>;
      accessibilityTree: AccessibilityNode;
      screenshot: { mimeType: string; unavailable?: boolean };
    };
    expect(snapshot).toMatchObject({
      visibleText: expect.stringContaining('Dashboard'),
      interactiveElements: expect.arrayContaining([
        expect.objectContaining({
          role: 'button',
          name: 'Save report',
        }),
      ]),
      screenshot: expect.objectContaining({
        mimeType: 'image/png',
        unavailable: true,
      }),
    });
    expect(snapshot.visibleText).not.toContain('Hidden action');
    expect(snapshot.visibleText).not.toContain('Ignored action');
    const nodes = flattenAccessibilityTree(snapshot.accessibilityTree);
    expect(snapshot.accessibilityTree).toMatchObject({
      role: 'document',
      nodeCount: nodes.length,
      maxNodeCount: 200,
      truncated: false,
    });
    expect(nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'heading', name: 'Dashboard', level: 1 }),
      expect.objectContaining({ role: 'navigation', name: 'Primary navigation' }),
      expect.objectContaining({ role: 'link', name: 'Reports' }),
      expect.objectContaining({ role: 'form', name: 'Filters' }),
      expect.objectContaining({ role: 'textbox', name: 'Search query', value: 'launch' }),
      expect.objectContaining({ role: 'checkbox', name: 'Include archived', checked: true }),
      expect.objectContaining({ role: 'button', name: 'Save report' }),
    ]));
    expect(nodes.some((node) => node.name.includes('Hidden action'))).toBe(false);
    expect(nodes.some((node) => node.name.includes('Ignored action'))).toBe(false);
  });

  it('bounds the accessibility tree returned in preview snapshots', async () => {
    const iframe = createIframe(`
      <main>
        ${Array.from({ length: 260 }, (_, index) => `<button type="button">Action ${index + 1}</button>`).join('')}
      </main>
    `);

    const snapshot = await runCodeWorkspacePreviewDomAutomation(
      request('snapshot'),
      frameState(iframe),
    ) as { accessibilityTree: AccessibilityNode };
    const nodes = flattenAccessibilityTree(snapshot.accessibilityTree);

    expect(snapshot.accessibilityTree).toMatchObject({
      nodeCount: nodes.length,
      maxNodeCount: 200,
      truncated: true,
    });
    expect(nodes.length).toBeLessThanOrEqual(200);
  });

  it('captures a PNG screenshot for accessible preview snapshots', async () => {
    class TestImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    Object.defineProperty(window, 'Image', {
      configurable: true,
      value: TestImage,
    });
    const iframe = createIframe(`
      <main style="width: 320px; height: 240px">
        <h1>Dashboard</h1>
      </main>
    `);
    const frameWindow = iframe.contentWindow as Window & typeof globalThis;
    vi.spyOn(frameWindow.HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(frameWindow.HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,c2NyZWVuc2hvdA==');
    Object.defineProperties(iframe.contentWindow, {
      innerWidth: { configurable: true, value: 1440 },
      innerHeight: { configurable: true, value: 900 },
      Image: { configurable: true, value: TestImage },
    });

    const snapshot = await runCodeWorkspacePreviewDomAutomation(
      request('snapshot'),
      frameState(iframe),
    ) as { screenshot: { data: string; width: number; height: number; unavailable?: boolean } };

    expect(snapshot.screenshot).toMatchObject({
      data: 'c2NyZWVuc2hvdA==',
      width: 1280,
      height: 800,
    });
    expect(snapshot.screenshot.unavailable).toBeUndefined();
  });

  it('includes action timeline, console diagnostics, and failed network diagnostics in snapshots', async () => {
    const iframe = createIframe(`
      <main>
        <button id="save" type="button" aria-label="Save changes">Save</button>
        <input id="title" aria-label="Title" value="Draft" />
      </main>
    `);
    const win = iframe.contentWindow as Window & typeof globalThis;
    const fetchMock = vi.fn().mockResolvedValue({
      status: 503,
      url: 'https://example.test/api/save',
    });
    Object.defineProperty(win, 'fetch', {
      configurable: true,
      value: fetchMock,
    });
    vi.spyOn(win.console, 'warn').mockImplementation(() => undefined);

    await expect(runCodeWorkspacePreviewDomAutomation(
      request('click', { locator: 'role=button[name="Save"]' }),
      frameState(iframe),
    )).resolves.toMatchObject({ clicked: true });

    await expect(runCodeWorkspacePreviewDomAutomation(
      request('type', { selector: '#title', text: 'Launch', clear: true }),
      frameState(iframe),
    )).resolves.toMatchObject({ typed: true });

    win.console.warn('Hydration mismatch');
    await win.fetch('/api/save', { method: 'POST' });

    const snapshot = await runCodeWorkspacePreviewDomAutomation(
      request('snapshot'),
      frameState(iframe),
    ) as {
      actionTimeline: Array<{ action: string; status: string; error?: string }>;
      consoleEntries: Array<{ level: string; text: string; source?: string }>;
      networkEntries: Array<{ url: string; method: string; status: number | null; failed: boolean }>;
    };

    expect(snapshot.actionTimeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'click', status: 'succeeded' }),
      expect.objectContaining({ action: 'type', status: 'succeeded' }),
      expect.objectContaining({ action: 'snapshot', status: 'running' }),
    ]));
    expect(snapshot.consoleEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: 'warn',
        text: 'Hydration mismatch',
        source: 'console',
      }),
    ]));
    expect(snapshot.networkEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: 'https://example.test/api/save',
        method: 'POST',
        status: 503,
        failed: true,
      }),
    ]));
    expect(fetchMock).toHaveBeenCalledWith('/api/save', { method: 'POST' });
  });

  it('clears browser data inside an accessible preview frame', async () => {
    const iframe = createIframe('<main>Preview</main>');
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow as Window & typeof globalThis;
    if (!doc) {
      throw new Error('test iframe document was not created');
    }

    let cookieValue = 'session=abc; theme=dark';
    Object.defineProperty(doc, 'cookie', {
      configurable: true,
      get: () => cookieValue,
      set: (value: string) => {
        const cookieName = value.split('=')[0]?.trim();
        if (!cookieName) {
          return;
        }
        cookieValue = cookieValue
          .split(';')
          .map((cookie) => cookie.trim())
          .filter((cookie) => cookie && !cookie.startsWith(`${cookieName}=`))
          .join('; ');
      },
    });

    const localStorageClear = vi.fn();
    const sessionStorageClear = vi.fn();
    const cacheKeys = vi.fn().mockResolvedValue(['assets-v1', 'runtime-v1']);
    const cacheDelete = vi.fn().mockResolvedValue(true);
    const databases = vi.fn().mockResolvedValue([{ name: 'app-db' }, { name: '' }]);
    const deleteDatabase = vi.fn((_name: string) => {
      const deleteRequest: Partial<IDBOpenDBRequest> = {};
      queueMicrotask(() => {
        deleteRequest.onsuccess?.call(deleteRequest as IDBOpenDBRequest, new Event('success'));
      });
      return deleteRequest as IDBOpenDBRequest;
    });
    Object.defineProperties(win, {
      localStorage: {
        configurable: true,
        value: { clear: localStorageClear },
      },
      sessionStorage: {
        configurable: true,
        value: { clear: sessionStorageClear },
      },
      caches: {
        configurable: true,
        value: { keys: cacheKeys, delete: cacheDelete },
      },
      indexedDB: {
        configurable: true,
        value: { databases, deleteDatabase },
      },
    });

    await expect(runCodeWorkspacePreviewDomAutomation(
      request('clearCookies'),
      frameState(iframe),
    )).resolves.toMatchObject({
      cleared: true,
      cookieNames: ['session', 'theme'],
      beforeCount: 2,
      afterCount: 0,
      httpOnlyUnavailable: true,
    });

    await expect(runCodeWorkspacePreviewDomAutomation(
      request('clearCache'),
      frameState(iframe),
    )).resolves.toMatchObject({
      cleared: true,
      localStorage: true,
      sessionStorage: true,
      cacheStorageKeys: ['assets-v1', 'runtime-v1'],
      indexedDbNames: ['app-db'],
    });
    expect(localStorageClear).toHaveBeenCalledTimes(1);
    expect(sessionStorageClear).toHaveBeenCalledTimes(1);
    expect(cacheDelete).toHaveBeenCalledWith('assets-v1');
    expect(cacheDelete).toHaveBeenCalledWith('runtime-v1');
    expect(deleteDatabase).toHaveBeenCalledWith('app-db');
  });

  it('records an accessible preview frame as a base64 browser artifact upload', async () => {
    class TestImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    class TestMediaRecorder extends EventTarget {
      static isTypeSupported = vi.fn((mimeType: string) => mimeType.startsWith('video/webm'));

      state: RecordingState = 'inactive';
      readonly mimeType: string;

      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        super();
        this.mimeType = options?.mimeType || 'video/webm';
      }

      start() {
        this.state = 'recording';
      }

      stop() {
        const dataEvent = new Event('dataavailable') as Event & { data: Blob };
        Object.defineProperty(dataEvent, 'data', {
          configurable: true,
          value: new Blob(['recorded-video'], { type: this.mimeType }),
        });
        this.dispatchEvent(dataEvent);
        this.state = 'inactive';
        this.dispatchEvent(new Event('stop'));
      }
    }
    const originalMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder');
    const originalWindowMediaRecorder = Object.getOwnPropertyDescriptor(window, 'MediaRecorder');
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: TestMediaRecorder,
    });
    Object.defineProperty(window, 'MediaRecorder', {
      configurable: true,
      value: TestMediaRecorder,
    });
    Object.defineProperty(window, 'Image', {
      configurable: true,
      value: TestImage,
    });
    const iframe = createIframe('<main><h1>Recorder</h1></main>');
    const frameWindow = iframe.contentWindow as Window & typeof globalThis;
    Object.defineProperties(frameWindow, {
      innerWidth: { configurable: true, value: 640 },
      innerHeight: { configurable: true, value: 360 },
      Image: { configurable: true, value: TestImage },
    });
    vi.spyOn(frameWindow.HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    Object.defineProperty(frameWindow.HTMLCanvasElement.prototype, 'captureStream', {
      configurable: true,
      value: vi.fn(() => ({} as MediaStream)),
    });

    try {
      await expect(runCodeWorkspacePreviewDomAutomation(
        request('recordingStart'),
        frameState(iframe),
      )).resolves.toMatchObject({
        tabId: 'browser:preview',
        recording: true,
        startedAt: expect.any(String),
      });

      const artifact = await runCodeWorkspacePreviewDomAutomation(
        request('recordingStop'),
        frameState(iframe),
      ) as {
        data: string;
        encoding: string;
        mimeType: string;
        path: string;
        sizeBytes: number;
      };

      expect(artifact).toMatchObject({
        encoding: 'base64',
        mimeType: 'video/webm;codecs=vp9',
        path: expect.stringMatching(/^\.roomtalk\/preview-recordings\/preview-recording-browser-preview-/),
        sizeBytes: 'recorded-video'.length,
      });
      expect(artifact.data).toBe(btoa('recorded-video'));
    } finally {
      if (originalMediaRecorder) {
        Object.defineProperty(globalThis, 'MediaRecorder', originalMediaRecorder);
      } else {
        Reflect.deleteProperty(globalThis, 'MediaRecorder');
      }
      if (originalWindowMediaRecorder) {
        Object.defineProperty(window, 'MediaRecorder', originalWindowMediaRecorder);
      } else {
        Reflect.deleteProperty(window, 'MediaRecorder');
      }
    }
  });

  it('rejects duplicate recording starts while the cloud preview recording is still starting', async () => {
    const iframe = createIframe('<main><h1>Recorder</h1></main>');
    const recordingMocks = installRecordingFrameMocks(iframe, { manualImageLoad: true });

    try {
      const firstStart = runCodeWorkspacePreviewDomAutomation(
        request('recordingStart'),
        frameState(iframe),
      );
      await vi.waitFor(() => expect(recordingMocks.imageLoads.length).toBeGreaterThan(0));

      await expect(runCodeWorkspacePreviewDomAutomation(
        request('recordingStart'),
        frameState(iframe),
      )).rejects.toMatchObject({
        _tag: 'PreviewAutomationRecordingConflictError',
        message: 'Cannot record tab browser:preview while tab browser:preview is already being recorded.',
        detail: {
          requestId: 'request:recordingStart',
          operation: 'recordingStart',
          roomId: 'room-1',
          tabId: 'browser:preview',
          activeTabId: 'browser:preview',
        },
      });

      recordingMocks.imageLoads.shift()?.();
      await firstStart;

      const stop = runCodeWorkspacePreviewDomAutomation(
        request('recordingStop'),
        frameState(iframe),
      );
      await vi.waitFor(() => expect(recordingMocks.imageLoads.length).toBeGreaterThan(0));
      recordingMocks.imageLoads.shift()?.();
      await stop;
    } finally {
      recordingMocks.restore();
    }
  });

  it('shares an in-progress cloud preview recording stop between duplicate callers', async () => {
    const iframe = createIframe('<main><h1>Recorder</h1></main>');
    const recordingMocks = installRecordingFrameMocks(iframe, { manualImageLoad: true });

    try {
      const start = runCodeWorkspacePreviewDomAutomation(
        request('recordingStart'),
        frameState(iframe),
      );
      await vi.waitFor(() => expect(recordingMocks.imageLoads.length).toBeGreaterThan(0));
      recordingMocks.imageLoads.shift()?.();
      await start;

      const firstStop = runCodeWorkspacePreviewDomAutomation(
        request('recordingStop'),
        frameState(iframe),
      );
      await vi.waitFor(() => expect(recordingMocks.imageLoads.length).toBeGreaterThan(0));
      const duplicateStop = runCodeWorkspacePreviewDomAutomation(
        request('recordingStop'),
        frameState(iframe),
      );
      recordingMocks.imageLoads.shift()?.();
      const [firstArtifact, duplicateArtifact] = await Promise.all([firstStop, duplicateStop]);

      expect(duplicateArtifact).toEqual(firstArtifact);
      expect(recordingMocks.stopCalls()).toBe(1);
    } finally {
      recordingMocks.restore();
    }
  });

  it('reports a typed error when stopping a missing recording', async () => {
    const iframe = createIframe('<main><h1>Recorder</h1></main>');

    await expect(runCodeWorkspacePreviewDomAutomation(
      {
        ...request('recordingStop'),
        tabId: 'browser:missing',
        tabIdExplicit: true,
      },
      frameState(iframe),
    )).rejects.toMatchObject({
      _tag: 'PreviewAutomationRecordingNotActiveError',
      message: 'Preview automation request request:recordingStop found no active recording for tab browser:missing.',
      detail: {
        requestId: 'request:recordingStop',
        operation: 'recordingStop',
        roomId: 'room-1',
        tabId: 'browser:missing',
      },
    });
  });

  it('reports an inaccessible preview frame clearly', async () => {
    await expect(runCodeWorkspacePreviewDomAutomation(
      request('snapshot'),
      { ...frameState(null as unknown as HTMLIFrameElement), iframe: null },
    )).rejects.toThrow('Workspace preview automation frame is not ready.');
  });
});
