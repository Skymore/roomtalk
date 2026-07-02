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
      'clearCookies',
      'clearCache',
      'recordingStart',
      'recordingStop',
    ]);
    expect(isCodeWorkspacePreviewDomAutomationOperation('click')).toBe(true);
    expect(isCodeWorkspacePreviewDomAutomationOperation('clearCache')).toBe(true);
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

  it('reports an inaccessible preview frame clearly', async () => {
    await expect(runCodeWorkspacePreviewDomAutomation(
      request('snapshot'),
      { ...frameState(null as unknown as HTMLIFrameElement), iframe: null },
    )).rejects.toThrow('Workspace preview automation frame is not ready.');
  });
});
