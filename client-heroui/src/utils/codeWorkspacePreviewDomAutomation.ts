import type {
  CodeWorkspacePreviewAutomationOperation,
  CodeWorkspacePreviewAutomationRequest,
} from './socket';
import {
  makeCodeWorkspacePreviewAutomationKeySequence,
  type CodeWorkspacePreviewAutomationKeyEvent,
  type CodeWorkspacePreviewAutomationModifier,
} from './codeWorkspacePreviewKeyboard';

export const CODE_WORKSPACE_PREVIEW_AUTOMATION_DOM_OPERATIONS = [
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
] as const satisfies readonly CodeWorkspacePreviewAutomationOperation[];

const domOperationSet = new Set<string>(CODE_WORKSPACE_PREVIEW_AUTOMATION_DOM_OPERATIONS);

const TRANSPARENT_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const MAX_SCREENSHOT_WIDTH = 1280;
const SCREENSHOT_IMAGE_LOAD_TIMEOUT_MS = 250;
const RECORDING_FRAME_INTERVAL_MS = 500;
const RECORDING_FRAME_RATE = 4;
const RECORDING_STARTUP_SETTLE_TIMEOUT_MS = 5000;
const PREVIEW_ANNOTATION_HTML_LIMIT = 4000;
const PREVIEW_ANNOTATION_STYLE_LIMIT = 4000;
const PREVIEW_AUTOMATION_DIAGNOSTIC_BUFFER_LIMIT = 200;
const PREVIEW_AUTOMATION_ACCESSIBILITY_NODE_LIMIT = 200;
const PREVIEW_AUTOMATION_ACCESSIBILITY_DEPTH_LIMIT = 12;
const PREVIEW_AUTOMATION_ACCESSIBILITY_NAME_LIMIT = 240;
const PREVIEW_AUTOMATION_MAX_EVALUATION_BYTES = 64_000;

type DomAutomationInput = Record<string, unknown>;
type PreviewAutomationSelectorKind = 'focused-element' | 'locator' | 'selector';
type PreviewAutomationActionStatus = 'running' | 'succeeded' | 'failed' | 'interrupted';

type PreviewAutomationConsoleEntry = {
  level: string;
  text: string;
  timestamp: string;
  source?: string;
};

type PreviewAutomationNetworkEntry = {
  url: string;
  method: string;
  status: number | null;
  failed: boolean;
  errorText?: string;
  timestamp: string;
};

type PreviewAutomationActionEvent = {
  id: string;
  action: string;
  status: PreviewAutomationActionStatus;
  startedAt: string;
  completedAt?: string;
  error?: string;
};

type PreviewAutomationDiagnostics = {
  consoleEntries: PreviewAutomationConsoleEntry[];
  networkEntries: PreviewAutomationNetworkEntry[];
  actionTimeline: PreviewAutomationActionEvent[];
};

type PreviewAutomationAccessibilityNode = {
  role: string;
  name: string;
  selector?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  level?: number;
  children?: PreviewAutomationAccessibilityNode[];
};

type PreviewAutomationAccessibilityTree = PreviewAutomationAccessibilityNode & {
  nodeCount: number;
  maxNodeCount: number;
  truncated: boolean;
};

type InstrumentedPreviewWindow = Window & typeof globalThis & {
  __roomtalkPreviewAutomationDiagnostics?: {
    tabId: string;
  };
};

type InstrumentedXMLHttpRequest = XMLHttpRequest & {
  __roomtalkPreviewAutomationRequest?: {
    method: string;
    url: string;
    observed: boolean;
  };
};

type DomAutomationFrameState = {
  iframe: HTMLIFrameElement | null;
  tabId: string;
  loading: boolean;
  title: string;
  url: string;
};

export type CodeWorkspacePreviewDomAutomationHandler = (
  request: CodeWorkspacePreviewAutomationRequest,
) => Promise<unknown>;

export function isCodeWorkspacePreviewDomAutomationOperation(
  operation: CodeWorkspacePreviewAutomationOperation,
): boolean {
  return domOperationSet.has(operation);
}

const diagnosticsByTabId = new Map<string, PreviewAutomationDiagnostics>();
let previewAutomationActionSequence = 0;

function isRecord(value: unknown): value is DomAutomationInput {
  return typeof value === 'object' && value !== null;
}

function inputRecord(input: unknown): DomAutomationInput {
  return isRecord(input) ? input : {};
}

function stringInput(input: DomAutomationInput, key: string): string | null {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function booleanInput(input: DomAutomationInput, key: string, fallback = false): boolean {
  const value = input[key];
  return typeof value === 'boolean' ? value : fallback;
}

function numberInput(input: DomAutomationInput, key: string): number | null {
  const value = input[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function timeoutInput(input: DomAutomationInput, fallback: number): number {
  const value = numberInput(input, 'timeoutMs') ?? fallback;
  return Math.min(Math.max(1, Math.round(value)), 60000);
}

function boundedAppend<T>(items: T[], item: T): T[] {
  return [...items, item].slice(-PREVIEW_AUTOMATION_DIAGNOSTIC_BUFFER_LIMIT);
}

function diagnosticsForTab(tabId: string): PreviewAutomationDiagnostics {
  const existing = diagnosticsByTabId.get(tabId);
  if (existing) {
    return existing;
  }
  const diagnostics: PreviewAutomationDiagnostics = {
    consoleEntries: [],
    networkEntries: [],
    actionTimeline: [],
  };
  diagnosticsByTabId.set(tabId, diagnostics);
  return diagnostics;
}

function currentIsoTimestamp(): string {
  return new Date().toISOString();
}

function pushConsoleEntry(
  tabId: string,
  entry: Omit<PreviewAutomationConsoleEntry, 'timestamp'> & { timestamp?: string },
): void {
  const diagnostics = diagnosticsForTab(tabId);
  diagnostics.consoleEntries = boundedAppend(diagnostics.consoleEntries, {
    ...entry,
    timestamp: entry.timestamp ?? currentIsoTimestamp(),
  });
}

function pushNetworkEntry(
  tabId: string,
  entry: Omit<PreviewAutomationNetworkEntry, 'timestamp'> & { timestamp?: string },
): void {
  const diagnostics = diagnosticsForTab(tabId);
  diagnostics.networkEntries = boundedAppend(diagnostics.networkEntries, {
    ...entry,
    timestamp: entry.timestamp ?? currentIsoTimestamp(),
  });
}

function replaceActionEntry(tabId: string, event: PreviewAutomationActionEvent): void {
  const diagnostics = diagnosticsForTab(tabId);
  diagnostics.actionTimeline = diagnostics.actionTimeline.map((candidate) => (
    candidate.id === event.id ? event : candidate
  ));
}

function actionNameForOperation(operation: CodeWorkspacePreviewAutomationOperation): string {
  if (operation === 'recordingStart') return 'recording.start';
  if (operation === 'recordingStop') return 'recording.stop';
  if (operation === 'previewAnnotation') return 'preview.annotation';
  if (operation === 'clearCookies') return 'cookies.clear';
  if (operation === 'clearCache') return 'cache.clear';
  return operation;
}

function startActionEntry(
  tabId: string,
  operation: CodeWorkspacePreviewAutomationOperation,
): PreviewAutomationActionEvent {
  previewAutomationActionSequence += 1;
  const startedAt = currentIsoTimestamp();
  const event: PreviewAutomationActionEvent = {
    id: `browser-action-${Date.now().toString(36)}-${previewAutomationActionSequence.toString(36)}`,
    action: actionNameForOperation(operation),
    status: 'running',
    startedAt,
  };
  const diagnostics = diagnosticsForTab(tabId);
  diagnostics.actionTimeline = boundedAppend(diagnostics.actionTimeline, event);
  return event;
}

function completeActionEntry(
  tabId: string,
  event: PreviewAutomationActionEvent,
  status: Exclude<PreviewAutomationActionStatus, 'running' | 'interrupted'>,
  error?: unknown,
): void {
  replaceActionEntry(tabId, {
    ...event,
    status,
    completedAt: currentIsoTimestamp(),
    ...(status === 'failed' ? { error: error instanceof Error ? error.message : String(error) } : {}),
  });
}

function serializeConsoleArgument(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function requestUrl(input: unknown, baseUrl: string): string {
  const rawUrl = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : typeof (input as { url?: unknown } | null)?.url === 'string'
        ? (input as { url: string }).url
        : String(input);
  try {
    return new URL(rawUrl, baseUrl).href;
  } catch {
    return rawUrl;
  }
}

function requestMethod(input: unknown, init?: RequestInit): string {
  const method = typeof init?.method === 'string'
    ? init.method
    : typeof (input as { method?: unknown } | null)?.method === 'string'
      ? (input as { method: string }).method
      : 'GET';
  return method.toUpperCase();
}

function installConsoleDiagnostics(win: InstrumentedPreviewWindow, tabId: string): void {
  const consoleObject = win.console;
  if (!consoleObject) {
    return;
  }
  const activeTabId = () => win.__roomtalkPreviewAutomationDiagnostics?.tabId ?? tabId;
  const methods: Array<keyof Pick<Console, 'debug' | 'error' | 'info' | 'log' | 'warn'>> = [
    'debug',
    'error',
    'info',
    'log',
    'warn',
  ];
  for (const method of methods) {
    const original = consoleObject[method];
    if (typeof original !== 'function') {
      continue;
    }
    const level = method === 'debug' ? 'log' : method;
    consoleObject[method] = ((...args: unknown[]) => {
      pushConsoleEntry(activeTabId(), {
        level,
        text: args.map(serializeConsoleArgument).join(' '),
        source: 'console',
      });
      return original.apply(consoleObject, args);
    }) as Console[typeof method];
  }
  win.addEventListener('error', (event) => {
    pushConsoleEntry(activeTabId(), {
      level: 'error',
      text: event.message || 'Uncaught exception',
      source: 'exception',
    });
  });
  win.addEventListener('unhandledrejection', (event) => {
    pushConsoleEntry(activeTabId(), {
      level: 'error',
      text: serializeConsoleArgument(event.reason ?? 'Unhandled promise rejection'),
      source: 'unhandledrejection',
    });
  });
}

function installFetchDiagnostics(win: InstrumentedPreviewWindow, doc: Document, tabId: string): void {
  if (typeof win.fetch !== 'function') {
    return;
  }
  const originalFetch = win.fetch.bind(win);
  const activeTabId = () => win.__roomtalkPreviewAutomationDiagnostics?.tabId ?? tabId;
  const wrappedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input, doc.location?.href || 'about:blank');
    const method = requestMethod(input, init);
    try {
      const response = await originalFetch(input, init);
      if (response.status >= 400) {
        pushNetworkEntry(activeTabId(), {
          url: response.url || url,
          method,
          status: response.status,
          failed: true,
        });
      }
      return response;
    } catch (error) {
      pushNetworkEntry(activeTabId(), {
        url,
        method,
        status: null,
        failed: true,
        errorText: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }) as typeof win.fetch;
  try {
    Object.defineProperty(win, 'fetch', {
      configurable: true,
      writable: true,
      value: wrappedFetch,
    });
  } catch {
    try {
      win.fetch = wrappedFetch;
    } catch {
      // Some embedded browser environments expose fetch as a locked property.
    }
  }
}

function installXhrDiagnostics(win: InstrumentedPreviewWindow, doc: Document, tabId: string): void {
  const proto = win.XMLHttpRequest?.prototype;
  if (!proto) {
    return;
  }
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const activeTabId = () => win.__roomtalkPreviewAutomationDiagnostics?.tabId ?? tabId;
  proto.open = function open(
    this: InstrumentedXMLHttpRequest,
    method: string,
    url: string | URL,
    async = true,
    username?: string | null,
    password?: string | null,
  ) {
    this.__roomtalkPreviewAutomationRequest = {
      method: method.toUpperCase(),
      url: requestUrl(url, doc.location?.href || 'about:blank'),
      observed: false,
    };
    const openArgs = password !== undefined
      ? [method, url, async, username ?? undefined, password] as const
      : username !== undefined
        ? [method, url, async, username] as const
        : [method, url, async] as const;
    return Reflect.apply(originalOpen, this, openArgs) as void;
  } as XMLHttpRequest['open'];
  proto.send = function send(
    this: InstrumentedXMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const request = this.__roomtalkPreviewAutomationRequest;
    if (request && !request.observed) {
      request.observed = true;
      const reportFailure = (errorText?: string) => {
        const status = Number.isFinite(this.status) && this.status > 0 ? this.status : null;
        if (status === null || status >= 400 || errorText) {
          pushNetworkEntry(activeTabId(), {
            url: this.responseURL || request.url,
            method: request.method,
            status,
            failed: true,
            ...(errorText ? { errorText } : {}),
          });
        }
      };
      this.addEventListener('loadend', () => reportFailure());
      this.addEventListener('error', () => reportFailure('Network request failed'));
      this.addEventListener('abort', () => reportFailure('Network request aborted'));
      this.addEventListener('timeout', () => reportFailure('Network request timed out'));
    }
    return originalSend.call(this, body);
  } as XMLHttpRequest['send'];
}

function installPreviewAutomationDiagnostics(state: DomAutomationFrameState): void {
  const win = frameWindow(state) as InstrumentedPreviewWindow;
  const doc = frameDocument(state);
  const installed = win.__roomtalkPreviewAutomationDiagnostics;
  if (installed?.tabId === state.tabId) {
    return;
  }
  if (installed && installed.tabId !== state.tabId) {
    installed.tabId = state.tabId;
    return;
  }
  win.__roomtalkPreviewAutomationDiagnostics = { tabId: state.tabId };
  diagnosticsForTab(state.tabId);
  installConsoleDiagnostics(win, state.tabId);
  installFetchDiagnostics(win, doc, state.tabId);
  installXhrDiagnostics(win, doc, state.tabId);
}

class PreviewAutomationInputError extends Error {
  readonly _tag: string;
  readonly detail: Record<string, unknown>;

  constructor(tag: string, message: string, detail: Record<string, unknown>) {
    super(message);
    this.name = tag;
    this._tag = tag;
    this.detail = detail;
  }
}

function selectorDiagnostics(input: DomAutomationInput): {
  selectorKind: PreviewAutomationSelectorKind;
  selectorLength?: number;
} {
  const selector = stringInput(input, 'selector');
  if (selector) {
    return { selectorKind: 'selector', selectorLength: selector.length };
  }
  const locator = stringInput(input, 'locator');
  if (locator) {
    return { selectorKind: 'locator', selectorLength: locator.length };
  }
  return { selectorKind: 'focused-element' };
}

function previewAutomationErrorDetail(
  request: CodeWorkspacePreviewAutomationRequest,
  input: DomAutomationInput,
): Record<string, unknown> {
  return {
    requestId: request.requestId,
    operation: request.operation,
    roomId: request.roomId,
    tabId: request.tabId ?? null,
    ...selectorDiagnostics(input),
  };
}

function previewAutomationTargetNotEditableError(
  request: CodeWorkspacePreviewAutomationRequest,
  input: DomAutomationInput,
): PreviewAutomationInputError {
  return new PreviewAutomationInputError(
    'PreviewAutomationTargetNotEditableError',
    `Preview automation ${request.operation} request ${request.requestId} requires an editable target in tab ${request.tabId ?? 'unassigned'}.`,
    previewAutomationErrorDetail(request, input),
  );
}

function previewAutomationInvalidSelectorError(
  request: CodeWorkspacePreviewAutomationRequest,
  input: DomAutomationInput,
): PreviewAutomationInputError {
  return new PreviewAutomationInputError(
    'PreviewAutomationInvalidSelectorError',
    `Preview automation ${request.operation} request ${request.requestId} received an invalid selector.`,
    previewAutomationErrorDetail(request, input),
  );
}

function previewAutomationTargetNotFoundError(
  request: CodeWorkspacePreviewAutomationRequest,
  input: DomAutomationInput,
): PreviewAutomationInputError {
  const detail = previewAutomationErrorDetail(request, input);
  return new PreviewAutomationInputError(
    'PreviewAutomationTargetNotFoundError',
    `Preview automation ${request.operation} request ${request.requestId} could not find target in tab ${request.tabId ?? 'unassigned'}.`,
    detail,
  );
}

function previewAutomationCoordinatesOutsideViewportError(
  request: CodeWorkspacePreviewAutomationRequest,
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
): PreviewAutomationInputError {
  return new PreviewAutomationInputError(
    'PreviewAutomationCoordinatesOutsideViewportError',
    `Preview automation ${request.operation} request ${request.requestId} received coordinates outside the ${viewportWidth}x${viewportHeight} preview viewport for tab ${request.tabId ?? 'unassigned'}.`,
    {
      requestId: request.requestId,
      operation: request.operation,
      roomId: request.roomId,
      tabId: request.tabId ?? null,
      x,
      y,
      viewportWidth,
      viewportHeight,
    },
  );
}

function previewAutomationTimeoutError(
  request: CodeWorkspacePreviewAutomationRequest,
  timeoutMs: number,
): PreviewAutomationInputError {
  return new PreviewAutomationInputError(
    'PreviewAutomationTimeoutError',
    `Preview automation ${request.operation} request ${request.requestId} did not match within ${timeoutMs}ms in tab ${request.tabId ?? 'unassigned'}.`,
    {
      requestId: request.requestId,
      operation: request.operation,
      roomId: request.roomId,
      tabId: request.tabId ?? null,
      timeoutMs,
    },
  );
}

function previewAutomationEvaluationError(
  request: CodeWorkspacePreviewAutomationRequest,
  error: unknown,
): PreviewAutomationInputError {
  const message = error instanceof Error ? error.message : String(error);
  return new PreviewAutomationInputError(
    'PreviewAutomationEvaluationError',
    `Preview automation ${request.operation} request ${request.requestId} failed to evaluate JavaScript in tab ${request.tabId ?? 'unassigned'}.`,
    {
      requestId: request.requestId,
      operation: request.operation,
      roomId: request.roomId,
      tabId: request.tabId ?? null,
      detailKind: 'message',
      detailLength: message.length,
    },
  );
}

function previewAutomationResultTooLargeError(
  request: CodeWorkspacePreviewAutomationRequest,
  actualBytes: number,
): PreviewAutomationInputError {
  return new PreviewAutomationInputError(
    'PreviewAutomationResultTooLargeError',
    `Preview automation ${request.operation} request ${request.requestId} returned ${actualBytes} bytes from tab ${request.tabId ?? 'unassigned'}; maximum is ${PREVIEW_AUTOMATION_MAX_EVALUATION_BYTES} bytes.`,
    {
      requestId: request.requestId,
      operation: request.operation,
      roomId: request.roomId,
      tabId: request.tabId ?? null,
      actualBytes,
      maximumBytes: PREVIEW_AUTOMATION_MAX_EVALUATION_BYTES,
    },
  );
}

function previewAutomationRecordingNotActiveError(
  request: CodeWorkspacePreviewAutomationRequest,
  tabId: string | null,
): PreviewAutomationInputError {
  return new PreviewAutomationInputError(
    'PreviewAutomationRecordingNotActiveError',
    `Preview automation request ${request.requestId} found no active recording for tab ${tabId ?? 'unassigned'}.`,
    {
      requestId: request.requestId,
      operation: request.operation,
      roomId: request.roomId,
      tabId,
    },
  );
}

function previewAutomationRecordingConflictError(
  request: CodeWorkspacePreviewAutomationRequest,
  requestedTabId: string,
  activeTabId: string,
): PreviewAutomationInputError {
  return new PreviewAutomationInputError(
    'PreviewAutomationRecordingConflictError',
    `Cannot record tab ${requestedTabId} while tab ${activeTabId} is already being recorded.`,
    {
      requestId: request.requestId,
      operation: request.operation,
      roomId: request.roomId,
      tabId: requestedTabId,
      activeTabId,
    },
  );
}

function frameWindow(state: DomAutomationFrameState): Window {
  const win = state.iframe?.contentWindow;
  if (!win) {
    throw new Error('Workspace preview automation frame is not ready.');
  }
  return win;
}

function frameDocument(state: DomAutomationFrameState): Document {
  try {
    const doc = state.iframe?.contentDocument ?? state.iframe?.contentWindow?.document ?? null;
    if (!doc) {
      throw new Error('Workspace preview automation frame is not ready.');
    }
    void doc.body;
    return doc;
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message !== 'Workspace preview automation frame is not ready.'
        ? 'Workspace preview automation cannot access this preview frame.'
        : 'Workspace preview automation frame is not ready.',
    );
  }
}

function parseCookieNames(cookieHeader: string): string[] {
  return Array.from(new Set(
    cookieHeader
      .split(';')
      .map((cookie) => cookie.split('=')[0]?.trim() ?? '')
      .filter(Boolean),
  ));
}

function frameUrl(state: DomAutomationFrameState, doc: Document): URL | null {
  const candidates = [
    state.url,
    doc.location.href === 'about:blank' ? '' : doc.location.href,
  ];
  for (const candidate of candidates) {
    try {
      return new URL(candidate);
    } catch {
      // Continue with the next candidate.
    }
  }
  return null;
}

function cookiePathCandidates(url: URL | null): string[] {
  const paths = new Set<string>(['/']);
  const segments = (url?.pathname || '/').split('/').filter(Boolean);
  let current = '';
  for (const segment of segments) {
    current += `/${segment}`;
    paths.add(current);
  }
  return [...paths];
}

function cookieDomainCandidates(url: URL | null): string[] {
  const hostname = url?.hostname;
  if (!hostname || hostname === 'localhost' || hostname.includes(':') || /^[\d.]+$/.test(hostname)) {
    return [];
  }
  const parts = hostname.split('.').filter(Boolean);
  if (parts.length < 2) {
    return [];
  }
  const domains = new Set<string>([hostname, `.${hostname}`]);
  for (let index = 1; index < parts.length - 1; index += 1) {
    domains.add(`.${parts.slice(index).join('.')}`);
  }
  return [...domains];
}

function clearFrameCookies(state: DomAutomationFrameState): {
  cleared: true;
  cookieNames: string[];
  beforeCount: number;
  afterCount: number;
  httpOnlyUnavailable: true;
} {
  const doc = frameDocument(state);
  const cookieNames = parseCookieNames(doc.cookie);
  const url = frameUrl(state, doc);
  const paths = cookiePathCandidates(url);
  const domains = cookieDomainCandidates(url);
  const expires = 'expires=Thu, 01 Jan 1970 00:00:00 GMT; max-age=0';

  for (const cookieName of cookieNames) {
    const safeName = cookieName.replace(/[\r\n;]/g, '');
    if (!safeName) {
      continue;
    }
    for (const path of paths) {
      doc.cookie = `${safeName}=; ${expires}; path=${path}`;
      for (const domain of domains) {
        doc.cookie = `${safeName}=; ${expires}; path=${path}; domain=${domain}`;
      }
    }
  }

  return {
    cleared: true,
    cookieNames,
    beforeCount: cookieNames.length,
    afterCount: parseCookieNames(doc.cookie).length,
    httpOnlyUnavailable: true,
  };
}

type IndexedDbWithDatabases = IDBFactory & {
  databases?: () => Promise<Array<{ name?: string | null }>>;
};

function deleteIndexedDbDatabase(indexedDB: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

async function clearFrameCache(state: DomAutomationFrameState): Promise<{
  cleared: true;
  localStorage: boolean;
  sessionStorage: boolean;
  cacheStorageKeys: string[];
  indexedDbNames: string[];
  serviceWorkerScopes: string[];
}> {
  const doc = frameDocument(state);
  const win = frameWindow(state) as Window & typeof globalThis & {
    caches?: CacheStorage;
    indexedDB?: IndexedDbWithDatabases;
  };
  void doc.body;

  let localStorage = false;
  let sessionStorage = false;
  const cacheStorageKeys: string[] = [];
  const indexedDbNames: string[] = [];
  const serviceWorkerScopes: string[] = [];

  try {
    win.localStorage.clear();
    localStorage = true;
  } catch {
    localStorage = false;
  }
  try {
    win.sessionStorage.clear();
    sessionStorage = true;
  } catch {
    sessionStorage = false;
  }

  if (win.caches && typeof win.caches.keys === 'function' && typeof win.caches.delete === 'function') {
    try {
      const keys = await win.caches.keys();
      cacheStorageKeys.push(...keys);
      await Promise.all(keys.map((key) => win.caches!.delete(key).catch(() => false)));
    } catch {
      // Cache Storage can be unavailable for opaque or restricted frames.
    }
  }

  if (
    win.indexedDB
    && typeof win.indexedDB.databases === 'function'
    && typeof win.indexedDB.deleteDatabase === 'function'
  ) {
    try {
      const databases = await win.indexedDB.databases();
      const names = databases
        .map((database) => database.name)
        .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
      indexedDbNames.push(...names);
      await Promise.all(names.map((name) => deleteIndexedDbDatabase(win.indexedDB!, name)));
    } catch {
      // Some browsers do not expose indexedDB.databases() in iframe contexts.
    }
  }

  const serviceWorker = win.navigator?.serviceWorker;
  if (serviceWorker && typeof serviceWorker.getRegistrations === 'function') {
    try {
      const registrations = await serviceWorker.getRegistrations();
      serviceWorkerScopes.push(...registrations.map((registration) => registration.scope));
      await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
    } catch {
      // Service worker access can be blocked for sandboxed or insecure previews.
    }
  }

  return {
    cleared: true,
    localStorage,
    sessionStorage,
    cacheStorageKeys,
    indexedDbNames,
    serviceWorkerScopes,
  };
}

function boundedAccessibilityText(value: string, limit = PREVIEW_AUTOMATION_ACCESSIBILITY_NAME_LIMIT): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 3)}...` : trimmed;
}

function isElementVisible(element: Element): boolean {
  const htmlElement = element as HTMLElement;
  if (htmlElement.hidden || htmlElement.getAttribute('aria-hidden') === 'true') {
    return false;
  }
  const ownerWindow = element.ownerDocument.defaultView;
  const style = ownerWindow?.getComputedStyle(element);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) {
    return false;
  }
  return true;
}

function visibleText(element: Element): string {
  const collect = (node: Node): string[] => {
    if (node.nodeType === Node.TEXT_NODE) {
      return [node.textContent || ''];
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return [];
    }
    const childElement = node as Element;
    const tagName = childElement.tagName.toLowerCase();
    if (
      tagName === 'script'
      || tagName === 'style'
      || tagName === 'template'
      || !isElementVisible(childElement)
    ) {
      return [];
    }
    return Array.from(childElement.childNodes).flatMap(collect);
  };
  return collect(element).join(' ').replace(/\s+/g, ' ').trim();
}

function explicitAccessibleName(element: Element): string {
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const label = labelledBy
      .split(/\s+/)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent || '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (label) {
      return label;
    }
  }
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel?.trim()) {
    return ariaLabel.trim();
  }
  const labelledControl = element as HTMLInputElement & { labels?: NodeListOf<HTMLLabelElement> | null };
  const labels = labelledControl.labels ? Array.from(labelledControl.labels) : [];
  const labelText = labels
    .map((label) => visibleText(label))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (labelText) {
    return labelText;
  }
  const direct = element.getAttribute('alt')
    || element.getAttribute('title')
    || element.getAttribute('placeholder')
    || '';
  return direct.trim();
}

function accessibleName(element: Element): string {
  const direct = explicitAccessibleName(element);
  if (direct) {
    return direct;
  }
  if (element.tagName.toLowerCase() === 'input') {
    const input = element as HTMLInputElement;
    return input.value || input.name || input.id || '';
  }
  return visibleText(element);
}

function elementRole(element: Element): string | null {
  const explicitRole = element.getAttribute('role');
  if (explicitRole) {
    return explicitRole.split(/\s+/)[0] || null;
  }
  const tagName = element.tagName.toLowerCase();
  if (tagName === 'button') return 'button';
  if (tagName === 'a' && element.hasAttribute('href')) return 'link';
  if (tagName === 'textarea') return 'textbox';
  if (tagName === 'select') return 'combobox';
  if (tagName === 'input') {
    const type = (element.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
    if (type === 'range') return 'slider';
    return 'textbox';
  }
  return null;
}

function accessibilityNodeRole(element: Element): string | null {
  const explicitRole = element.getAttribute('role');
  if (explicitRole) {
    return explicitRole.split(/\s+/)[0] || null;
  }
  const tagName = element.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tagName)) return 'heading';
  if (tagName === 'main') return 'main';
  if (tagName === 'nav') return 'navigation';
  if (tagName === 'header') return 'banner';
  if (tagName === 'footer') return 'contentinfo';
  if (tagName === 'aside') return 'complementary';
  if (tagName === 'article') return 'article';
  if (tagName === 'section' && explicitAccessibleName(element)) return 'region';
  if (tagName === 'form') return 'form';
  if (tagName === 'img') return 'image';
  if (tagName === 'ul' || tagName === 'ol') return 'list';
  if (tagName === 'li') return 'listitem';
  if (tagName === 'table') return 'table';
  if (tagName === 'thead' || tagName === 'tbody' || tagName === 'tfoot') return 'rowgroup';
  if (tagName === 'tr') return 'row';
  if (tagName === 'th') return element.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader';
  if (tagName === 'td') return 'cell';
  if (tagName === 'p') return 'paragraph';
  if (tagName === 'blockquote') return 'blockquote';
  if (tagName === 'summary') return 'button';
  return elementRole(element);
}

function accessibilityNodeName(element: Element, role: string): string {
  const direct = explicitAccessibleName(element);
  if (direct) {
    return boundedAccessibilityText(direct);
  }
  const tagName = element.tagName.toLowerCase();
  if (
    role === 'button'
    || role === 'link'
    || role === 'heading'
    || role === 'image'
    || role === 'listitem'
    || role === 'paragraph'
    || role === 'blockquote'
    || role === 'columnheader'
    || role === 'rowheader'
    || role === 'cell'
    || tagName === 'option'
  ) {
    return boundedAccessibilityText(visibleText(element));
  }
  if (tagName === 'input') {
    const input = element as HTMLInputElement;
    return boundedAccessibilityText(input.name || input.id || input.value || '');
  }
  return '';
}

function elementValue(element: Element): string | undefined {
  const tagName = element.tagName.toLowerCase();
  if (tagName === 'textarea') {
    return boundedAccessibilityText((element as HTMLTextAreaElement).value);
  }
  if (tagName === 'select') {
    const select = element as HTMLSelectElement;
    return boundedAccessibilityText(Array.from(select.selectedOptions).map((option) => option.text).join(', '));
  }
  if (tagName === 'input') {
    const input = element as HTMLInputElement;
    const type = (input.type || 'text').toLowerCase();
    if (type === 'password' || type === 'file') {
      return undefined;
    }
    if (type === 'checkbox' || type === 'radio') {
      return undefined;
    }
    return boundedAccessibilityText(input.value);
  }
  return undefined;
}

function headingLevel(element: Element): number | undefined {
  const ariaLevel = Number(element.getAttribute('aria-level'));
  if (Number.isInteger(ariaLevel) && ariaLevel > 0) {
    return ariaLevel;
  }
  const tagName = element.tagName.toLowerCase();
  return /^h[1-6]$/.test(tagName) ? Number(tagName.slice(1)) : undefined;
}

function accessibilityNodeState(element: Element): Omit<PreviewAutomationAccessibilityNode, 'role' | 'name' | 'children'> {
  const disabled = element.getAttribute('aria-disabled') === 'true'
    || ('disabled' in element && Boolean((element as { disabled?: unknown }).disabled));
  const expandedAttribute = element.getAttribute('aria-expanded');
  const checkedAttribute = element.getAttribute('aria-checked');
  const tagName = element.tagName.toLowerCase();
  const checked = checkedAttribute === 'true'
    ? true
    : checkedAttribute === 'false'
      ? false
      : tagName === 'input'
        ? Boolean((element as HTMLInputElement).checked)
        : undefined;
  return {
    selector: elementSelector(element),
    ...(checked === undefined ? {} : { checked }),
    ...(disabled ? { disabled: true } : {}),
    ...(expandedAttribute === 'true' || expandedAttribute === 'false'
      ? { expanded: expandedAttribute === 'true' }
      : {}),
  };
}

function isAccessibilityElementHidden(element: Element): boolean {
  const tagName = element.tagName.toLowerCase();
  if (tagName === 'script' || tagName === 'style' || tagName === 'template' || tagName === 'meta' || tagName === 'link') {
    return true;
  }
  if (element.getAttribute('aria-hidden') === 'true') {
    return true;
  }
  return !isElementVisible(element);
}

function buildAccessibilityTree(doc: Document): PreviewAutomationAccessibilityTree {
  const root: PreviewAutomationAccessibilityTree = {
    role: 'document',
    name: boundedAccessibilityText(doc.title || ''),
    nodeCount: 1,
    maxNodeCount: PREVIEW_AUTOMATION_ACCESSIBILITY_NODE_LIMIT,
    truncated: false,
  };

  const build = (element: Element, depth: number): PreviewAutomationAccessibilityNode[] => {
    if (root.nodeCount >= PREVIEW_AUTOMATION_ACCESSIBILITY_NODE_LIMIT) {
      root.truncated = true;
      return [];
    }
    if (depth > PREVIEW_AUTOMATION_ACCESSIBILITY_DEPTH_LIMIT || isAccessibilityElementHidden(element)) {
      if (depth > PREVIEW_AUTOMATION_ACCESSIBILITY_DEPTH_LIMIT) {
        root.truncated = true;
      }
      return [];
    }
    const role = accessibilityNodeRole(element);
    const includeNode = role !== null;
    const collectChildren = () => {
      const childNodes: PreviewAutomationAccessibilityNode[] = [];
      for (const child of Array.from(element.children)) {
        childNodes.push(...build(child, depth + 1));
        if (root.nodeCount >= PREVIEW_AUTOMATION_ACCESSIBILITY_NODE_LIMIT) {
          root.truncated = true;
          break;
        }
      }
      return childNodes;
    };

    if (!includeNode) {
      return collectChildren();
    }

    root.nodeCount += 1;
    const value = elementValue(element);
    const level = headingLevel(element);
    const node: PreviewAutomationAccessibilityNode = {
      role,
      name: accessibilityNodeName(element, role),
      ...accessibilityNodeState(element),
      ...(value ? { value } : {}),
      ...(level ? { level } : {}),
    };
    const childNodes = collectChildren();
    if (childNodes.length > 0) {
      node.children = childNodes;
    }
    return [node];
  };

  const children = Array.from((doc.body || doc.documentElement).children)
    .flatMap((child) => build(child, 1));
  if (children.length > 0) {
    root.children = children;
  }
  return root;
}

function parseLocator(locator: string): {
  kind: 'css' | 'text' | 'role';
  value: string;
  name?: string;
} {
  if (locator.startsWith('css=')) {
    return { kind: 'css', value: locator.slice(4).trim() };
  }
  if (locator.startsWith('text=')) {
    return { kind: 'text', value: locator.slice(5).trim() };
  }
  const roleMatch = locator.match(/^role=([a-zA-Z0-9_-]+)(?:\[(.+)\])?$/);
  if (roleMatch) {
    const options = roleMatch[2] || '';
    const nameMatch = options.match(/name=(['"])(.*?)\1/);
    return { kind: 'role', value: roleMatch[1], ...(nameMatch ? { name: nameMatch[2] } : {}) };
  }
  return { kind: 'css', value: locator };
}

function queryCssSelector(
  doc: Document,
  selector: string,
  request: CodeWorkspacePreviewAutomationRequest,
  input: DomAutomationInput,
): Element | null {
  try {
    return doc.querySelector(selector);
  } catch {
    throw previewAutomationInvalidSelectorError(request, input);
  }
}

function queryLocator(
  doc: Document,
  locator: string,
  request: CodeWorkspacePreviewAutomationRequest,
  input: DomAutomationInput,
): Element | null {
  const parsed = parseLocator(locator);
  if (parsed.kind === 'css') {
    return queryCssSelector(doc, parsed.value, request, input);
  }
  const candidates = Array.from(doc.querySelectorAll<HTMLElement>('body *')).filter(isElementVisible);
  if (parsed.kind === 'text') {
    return candidates.find((element) => visibleText(element).includes(parsed.value)) ?? null;
  }
  return candidates.find((element) => {
    if (elementRole(element) !== parsed.value) {
      return false;
    }
    return parsed.name ? accessibleName(element).includes(parsed.name) : true;
  }) ?? null;
}

function targetElement(
  doc: Document,
  input: DomAutomationInput,
  request: CodeWorkspacePreviewAutomationRequest,
): Element {
  const selector = stringInput(input, 'selector');
  const locator = stringInput(input, 'locator');
  const x = numberInput(input, 'x');
  const y = numberInput(input, 'y');
  if (selector && locator) {
    throw new Error('Provide either selector or locator, not both.');
  }
  if ((x === null) !== (y === null)) {
    throw new Error('Coordinates require both x and y.');
  }
  const target = selector
    ? queryCssSelector(doc, selector, request, input)
    : locator
      ? queryLocator(doc, locator, request, input)
      : x !== null && y !== null
        ? (() => {
          const win = doc.defaultView ?? window;
          const viewportWidth = Math.max(0, Math.round(doc.documentElement.clientWidth || win.innerWidth || 0));
          const viewportHeight = Math.max(0, Math.round(doc.documentElement.clientHeight || win.innerHeight || 0));
          if (x < 0 || y < 0 || (viewportWidth > 0 && x > viewportWidth) || (viewportHeight > 0 && y > viewportHeight)) {
            throw previewAutomationCoordinatesOutsideViewportError(request, x, y, viewportWidth, viewportHeight);
          }
          return doc.elementFromPoint(x, y);
        })()
        : doc.activeElement;
  if (!target || target === doc.body || target === doc.documentElement) {
    throw previewAutomationTargetNotFoundError(request, input);
  }
  return target;
}

function activeEditable(
  doc: Document,
  input: DomAutomationInput,
  request: CodeWorkspacePreviewAutomationRequest,
): HTMLElement {
  const selector = stringInput(input, 'selector');
  const locator = stringInput(input, 'locator');
  const element = selector || locator
    ? targetElement(doc, input, request)
    : doc.activeElement;
  if (!element || element === doc.body || element === doc.documentElement) {
    throw previewAutomationTargetNotEditableError(request, input);
  }
  return element as HTMLElement;
}

function writeText(
  element: HTMLElement,
  text: string,
  clear: boolean,
  request: CodeWorkspacePreviewAutomationRequest,
  input: DomAutomationInput,
): void {
  element.focus();
  const tagName = element.tagName.toLowerCase();
  const ownerWindow = element.ownerDocument.defaultView ?? window;
  if (tagName === 'input' || tagName === 'textarea') {
    const input = element as HTMLInputElement | HTMLTextAreaElement;
    const current = clear ? '' : input.value;
    input.value = `${current}${text}`;
    element.dispatchEvent(new ownerWindow.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    element.dispatchEvent(new ownerWindow.Event('change', { bubbles: true }));
    return;
  }
  if (element.isContentEditable) {
    if (clear) {
      element.textContent = '';
    }
    element.textContent = `${element.textContent || ''}${text}`;
    element.dispatchEvent(new ownerWindow.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return;
  }
  throw previewAutomationTargetNotEditableError(request, input);
}

function modifierInput(input: DomAutomationInput): CodeWorkspacePreviewAutomationModifier[] {
  const modifiers = Array.isArray(input.modifiers) ? input.modifiers : [];
  const allowed = new Set<CodeWorkspacePreviewAutomationModifier>(['Alt', 'Control', 'Meta', 'Shift']);
  return modifiers.filter((modifier): modifier is CodeWorkspacePreviewAutomationModifier => (
    typeof modifier === 'string' && allowed.has(modifier as CodeWorkspacePreviewAutomationModifier)
  ));
}

function isApplePlatform(win: Window): boolean {
  const platform = win.navigator?.platform || '';
  const userAgent = win.navigator?.userAgent || '';
  return /Mac|iPhone|iPad|iPod/.test(platform) || /\b(Macintosh|iPhone|iPad|iPod)\b/.test(userAgent);
}

function keyboardEventInit(
  event: CodeWorkspacePreviewAutomationKeyEvent,
): KeyboardEventInit & { keyCode: number; which: number } {
  const modifiers = event.modifiers;
  return {
    bubbles: true,
    cancelable: true,
    key: event.key,
    code: event.code,
    location: event.location,
    altKey: (modifiers & 1) !== 0,
    ctrlKey: (modifiers & 2) !== 0,
    metaKey: (modifiers & 4) !== 0,
    shiftKey: (modifiers & 8) !== 0,
    keyCode: event.windowsVirtualKeyCode,
    which: event.windowsVirtualKeyCode,
  };
}

function dispatchPreviewKeyboardEvent(
  element: Element,
  event: CodeWorkspacePreviewAutomationKeyEvent,
): boolean {
  const ownerWindow = element.ownerDocument.defaultView ?? window;
  const type = event.type === 'keyUp' ? 'keyup' : 'keydown';
  const init = keyboardEventInit(event);
  const keyboardEvent = new ownerWindow.KeyboardEvent(type, init);
  for (const property of ['keyCode', 'which'] as const) {
    try {
      Object.defineProperty(keyboardEvent, property, {
        configurable: true,
        get: () => init[property],
      });
    } catch {
      // Some browser implementations expose these as non-configurable fields.
    }
  }
  return element.dispatchEvent(keyboardEvent);
}

function editableTextControl(element: Element): HTMLInputElement | HTMLTextAreaElement | null {
  const tagName = element.tagName.toLowerCase();
  if (tagName === 'textarea') {
    return element as HTMLTextAreaElement;
  }
  if (tagName !== 'input') {
    return null;
  }
  const input = element as HTMLInputElement;
  const type = (input.type || 'text').toLowerCase();
  const textTypes = new Set([
    'email',
    'number',
    'password',
    'search',
    'tel',
    'text',
    'url',
  ]);
  return textTypes.has(type) ? input : null;
}

function textControlSelection(element: HTMLInputElement | HTMLTextAreaElement): {
  start: number;
  end: number;
} {
  try {
    const valueLength = element.value.length;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    return {
      start: typeof start === 'number' ? Math.max(0, Math.min(start, valueLength)) : valueLength,
      end: typeof end === 'number' ? Math.max(0, Math.min(end, valueLength)) : valueLength,
    };
  } catch {
    return { start: element.value.length, end: element.value.length };
  }
}

function dispatchEditableInputEvent(
  element: HTMLElement,
  type: 'beforeinput' | 'input',
  inputType: string,
  data: string | null,
): boolean {
  const ownerWindow = element.ownerDocument.defaultView ?? window;
  const event = typeof ownerWindow.InputEvent === 'function'
    ? new ownerWindow.InputEvent(type, {
      bubbles: true,
      cancelable: type === 'beforeinput',
      inputType,
      data,
    })
    : new ownerWindow.Event(type, {
      bubbles: true,
      cancelable: type === 'beforeinput',
    });
  if (!('inputType' in event)) {
    try {
      Object.defineProperty(event, 'inputType', { configurable: true, value: inputType });
      Object.defineProperty(event, 'data', { configurable: true, value: data });
    } catch {
      // The semantic event is still dispatched even if diagnostic fields cannot be attached.
    }
  }
  return element.dispatchEvent(event);
}

function dispatchEditableChangeEvent(element: HTMLElement): void {
  const ownerWindow = element.ownerDocument.defaultView ?? window;
  element.dispatchEvent(new ownerWindow.Event('change', { bubbles: true }));
}

function replaceTextControlRange(
  element: HTMLInputElement | HTMLTextAreaElement,
  start: number,
  end: number,
  text: string,
  inputType: string,
): boolean {
  const htmlElement = element as HTMLElement;
  if (!dispatchEditableInputEvent(htmlElement, 'beforeinput', inputType, text)) {
    return false;
  }
  const before = element.value.slice(0, start);
  const after = element.value.slice(end);
  element.value = `${before}${text}${after}`;
  const nextCaret = start + text.length;
  try {
    element.setSelectionRange(nextCaret, nextCaret);
  } catch {
    // Selection APIs can be unavailable for some input types.
  }
  dispatchEditableInputEvent(htmlElement, 'input', inputType, text);
  dispatchEditableChangeEvent(htmlElement);
  return true;
}

function replaceTextControlSelection(
  element: HTMLInputElement | HTMLTextAreaElement,
  text: string,
  inputType: string,
): boolean {
  const { start, end } = textControlSelection(element);
  return replaceTextControlRange(element, start, end, text, inputType);
}

function deleteTextControlSelection(
  element: HTMLInputElement | HTMLTextAreaElement,
  direction: 'backward' | 'forward',
): boolean {
  const { start, end } = textControlSelection(element);
  const deleteStart = start === end && direction === 'backward' ? Math.max(0, start - 1) : start;
  const deleteEnd = start === end && direction === 'forward' ? Math.min(element.value.length, end + 1) : end;
  if (deleteStart === deleteEnd) {
    return false;
  }
  return replaceTextControlRange(
    element,
    deleteStart,
    deleteEnd,
    '',
    direction === 'backward' ? 'deleteContentBackward' : 'deleteContentForward',
  );
}

function selectEditableContents(element: HTMLElement): boolean {
  const textControl = editableTextControl(element);
  if (textControl) {
    try {
      textControl.setSelectionRange(0, textControl.value.length);
      return true;
    } catch {
      return false;
    }
  }
  if (element.isContentEditable) {
    const doc = element.ownerDocument;
    const selection = doc.getSelection();
    if (!selection) {
      return false;
    }
    const range = doc.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }
  return false;
}

function replaceContentEditableSelection(
  element: HTMLElement,
  text: string,
  inputType: string,
): boolean {
  if (!dispatchEditableInputEvent(element, 'beforeinput', inputType, text)) {
    return false;
  }
  const doc = element.ownerDocument;
  const selection = doc.getSelection();
  if (!selection) {
    element.textContent = `${element.textContent || ''}${text}`;
  } else {
    if (selection.rangeCount === 0) {
      const range = doc.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection.addRange(range);
    }
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = doc.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.setEndAfter(node);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  dispatchEditableInputEvent(element, 'input', inputType, text);
  dispatchEditableChangeEvent(element);
  return true;
}

function applyKeyboardDefault(
  element: HTMLElement,
  keyDown: CodeWorkspacePreviewAutomationKeyEvent,
  modifiers: readonly CodeWorkspacePreviewAutomationModifier[],
): {
  defaultApplied: boolean;
  inputType?: string;
  selectionStart?: number;
  selectionEnd?: number;
  value?: string;
} {
  const modifierSet = new Set(modifiers);
  if ((modifierSet.has('Meta') || modifierSet.has('Control')) && keyDown.code === 'KeyA') {
    const selected = selectEditableContents(element);
    const textControl = editableTextControl(element);
    const selection = textControl ? textControlSelection(textControl) : null;
    return {
      defaultApplied: selected,
      inputType: selected ? 'selectAll' : undefined,
      ...(selection ? { selectionStart: selection.start, selectionEnd: selection.end } : {}),
    };
  }
  if (modifiers.some((modifier) => modifier !== 'Shift')) {
    return { defaultApplied: false };
  }

  const textControl = editableTextControl(element);
  const insertText = keyDown.text === '\r' ? '\n' : keyDown.text;
  const isTextArea = textControl?.tagName.toLowerCase() === 'textarea';
  if (insertText && textControl && (insertText !== '\n' || isTextArea)) {
    const applied = replaceTextControlSelection(textControl, insertText, insertText === '\n' ? 'insertLineBreak' : 'insertText');
    const selection = textControlSelection(textControl);
    return {
      defaultApplied: applied,
      inputType: insertText === '\n' ? 'insertLineBreak' : 'insertText',
      selectionStart: selection.start,
      selectionEnd: selection.end,
      value: textControl.value,
    };
  }
  if (insertText && element.isContentEditable) {
    return {
      defaultApplied: replaceContentEditableSelection(
        element,
        insertText,
        insertText === '\n' ? 'insertParagraph' : 'insertText',
      ),
      inputType: insertText === '\n' ? 'insertParagraph' : 'insertText',
      value: element.textContent || '',
    };
  }
  if (textControl && (keyDown.key === 'Backspace' || keyDown.key === 'Delete')) {
    const direction = keyDown.key === 'Backspace' ? 'backward' : 'forward';
    const applied = deleteTextControlSelection(textControl, direction);
    const selection = textControlSelection(textControl);
    return {
      defaultApplied: applied,
      inputType: direction === 'backward' ? 'deleteContentBackward' : 'deleteContentForward',
      selectionStart: selection.start,
      selectionEnd: selection.end,
      value: textControl.value,
    };
  }
  return { defaultApplied: false };
}

function dispatchKeyboard(
  element: HTMLElement,
  input: DomAutomationInput,
  state: DomAutomationFrameState,
): {
  key: string;
  code: string;
  modifiers: number;
  text?: string;
  commands?: readonly string[];
  defaultApplied: boolean;
  inputType?: string;
  selectionStart?: number;
  selectionEnd?: number;
  value?: string;
} {
  const key = stringInput(input, 'key');
  if (!key) {
    throw new Error('Preview automation press key is required.');
  }
  const modifiers = modifierInput(input);
  const sequence = makeCodeWorkspacePreviewAutomationKeySequence(
    { key, modifiers },
    { isMac: isApplePlatform(frameWindow(state)) },
  );
  element.focus();
  const shouldRunDefault = dispatchPreviewKeyboardEvent(element, sequence.keyDown);
  const defaultResult = shouldRunDefault
    ? applyKeyboardDefault(element, sequence.keyDown, modifiers)
    : { defaultApplied: false };
  dispatchPreviewKeyboardEvent(element, sequence.keyUp);
  return {
    key: sequence.signal.key,
    code: sequence.signal.code,
    modifiers: sequence.keyDown.modifiers,
    ...(sequence.keyDown.text ? { text: sequence.keyDown.text } : {}),
    ...(sequence.keyDown.commands ? { commands: sequence.keyDown.commands } : {}),
    ...defaultResult,
  };
}

function scrollTarget(
  win: Window,
  doc: Document,
  input: DomAutomationInput,
  request: CodeWorkspacePreviewAutomationRequest,
): {
  scrollLeft: number;
  scrollTop: number;
} {
  const deltaX = numberInput(input, 'deltaX') ?? 0;
  const deltaY = numberInput(input, 'deltaY') ?? 0;
  const selector = stringInput(input, 'selector');
  const locator = stringInput(input, 'locator');
  if (selector || locator) {
    const element = targetElement(doc, input, request) as HTMLElement;
    element.scrollLeft += deltaX;
    element.scrollTop += deltaY;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
    return { scrollLeft: element.scrollLeft, scrollTop: element.scrollTop };
  }
  win.scrollBy(deltaX, deltaY);
  return {
    scrollLeft: win.scrollX,
    scrollTop: win.scrollY,
  };
}

function elementSelector(element: Element): string {
  if (element.id) {
    return `#${element.id.replace(/"/g, '\\"')}`;
  }
  const tagName = element.tagName.toLowerCase();
  const parent = element.parentElement;
  if (!parent) {
    return tagName;
  }
  const index = Array.from(parent.children)
    .filter((child) => child.tagName === element.tagName)
    .indexOf(element) + 1;
  return `${elementSelector(parent)} > ${tagName}:nth-of-type(${index})`;
}

function inputClientPointElement(
  state: DomAutomationFrameState,
  doc: Document,
  input: DomAutomationInput,
): Element | null {
  const clientX = numberInput(input, 'clientX');
  const clientY = numberInput(input, 'clientY');
  if (clientX === null && clientY === null) {
    return null;
  }
  if (clientX === null || clientY === null) {
    throw new Error('Preview annotation client coordinates require both clientX and clientY.');
  }
  const iframe = state.iframe;
  if (!iframe) {
    throw new Error('Workspace preview automation frame is not ready.');
  }
  const rect = iframe.getBoundingClientRect();
  if (
    clientX < rect.left
    || clientX > rect.right
    || clientY < rect.top
    || clientY > rect.bottom
  ) {
    throw new Error('Preview annotation target is outside the preview frame.');
  }
  const scaleX = rect.width > 0 && iframe.clientWidth > 0 ? iframe.clientWidth / rect.width : 1;
  const scaleY = rect.height > 0 && iframe.clientHeight > 0 ? iframe.clientHeight / rect.height : 1;
  const frameX = (clientX - rect.left) * scaleX;
  const frameY = (clientY - rect.top) * scaleY;
  return doc.elementFromPoint(frameX, frameY);
}

function previewAnnotationTargetElement(
  state: DomAutomationFrameState,
  doc: Document,
  input: DomAutomationInput,
  request: CodeWorkspacePreviewAutomationRequest,
): Element {
  const target = inputClientPointElement(state, doc, input) ?? targetElement(doc, input, request);
  if (!target || target === doc.body || target === doc.documentElement) {
    throw new Error('Preview annotation target was not found.');
  }
  return target;
}

function truncatePreviewAnnotationString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function previewAnnotationElementId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `element-${crypto.randomUUID()}`;
  }
  return `element-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function previewAnnotationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `annotation-${crypto.randomUUID()}`;
  }
  return `annotation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function rectFromDomRect(rect: DOMRect): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: Number(rect.x.toFixed(2)),
    y: Number(rect.y.toFixed(2)),
    width: Number(rect.width.toFixed(2)),
    height: Number(rect.height.toFixed(2)),
  };
}

function computedStylePreview(element: Element): string {
  const ownerWindow = element.ownerDocument.defaultView;
  if (!ownerWindow || typeof ownerWindow.getComputedStyle !== 'function') {
    return '';
  }
  const style = ownerWindow.getComputedStyle(element);
  const properties = [
    'display',
    'position',
    'width',
    'height',
    'margin',
    'padding',
    'color',
    'background-color',
    'font-family',
    'font-size',
    'font-weight',
    'line-height',
    'border',
    'border-radius',
    'box-shadow',
    'opacity',
    'transform',
  ];
  const lines = properties
    .map((property) => {
      const value = style.getPropertyValue(property).trim();
      return value ? `${property}: ${value};` : '';
    })
    .filter(Boolean);
  return truncatePreviewAnnotationString(lines.join('\n'), PREVIEW_ANNOTATION_STYLE_LIMIT);
}

async function previewAnnotationForTarget(
  state: DomAutomationFrameState,
  input: DomAutomationInput,
  request: CodeWorkspacePreviewAutomationRequest,
): Promise<unknown> {
  const doc = frameDocument(state);
  const element = previewAnnotationTargetElement(state, doc, input, request);
  const win = frameWindow(state);
  const rect = rectFromDomRect(element.getBoundingClientRect());
  const elementId = previewAnnotationElementId();
  const createdAt = new Date().toISOString();
  const comment = stringInput(input, 'comment') ?? '';
  let screenshot: {
    dataUrl: string;
    width: number;
    height: number;
    cropRect: typeof rect;
  } | null = null;
  try {
    const captured = await captureFrameScreenshot(doc, win);
    if (!captured.unavailable) {
      screenshot = {
        dataUrl: `data:${captured.mimeType};base64,${captured.data}`,
        width: captured.width,
        height: captured.height,
        cropRect: rect,
      };
    }
  } catch {
    screenshot = null;
  }
  return {
    id: previewAnnotationId(),
    pageUrl: doc.location?.href || state.url,
    pageTitle: doc.title || state.title || null,
    comment,
    elements: [{
      id: elementId,
      element: {
        pageUrl: doc.location?.href || state.url,
        pageTitle: doc.title || state.title || null,
        tagName: element.tagName.toLowerCase(),
        selector: elementSelector(element),
        htmlPreview: truncatePreviewAnnotationString(
          (element as HTMLElement).outerHTML || element.textContent || '',
          PREVIEW_ANNOTATION_HTML_LIMIT,
        ),
        componentName: null,
        source: null,
        stack: [],
        styles: computedStylePreview(element),
        pickedAt: createdAt,
      },
      rect,
    }],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot,
    createdAt,
  };
}

function interactiveElements(doc: Document) {
  const selector = [
    'a[href]',
    'button',
    'input',
    'textarea',
    'select',
    '[role]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  return Array.from(doc.querySelectorAll<HTMLElement>(selector))
    .filter(isElementVisible)
    .slice(0, 200)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        role: elementRole(element),
        name: accessibleName(element),
        selector: elementSelector(element),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    });
}

type PreviewAutomationScreenshot = {
  mimeType: 'image/png';
  data: string;
  width: number;
  height: number;
  unavailable?: boolean;
};

type PreviewAutomationRecordingArtifactUpload = {
  id: string;
  tabId: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  encoding: 'base64';
  data: string;
  startedAt: string;
  stoppedAt: string;
  durationMs: number;
  frameCount: number;
};

type PreviewAutomationRecordingLifecycle =
  | { phase: 'starting' }
  | { phase: 'recording' }
  | {
      phase: 'stopping';
      stopPromise: Promise<PreviewAutomationRecordingArtifactUpload>;
    };

type ActiveDomRecording = {
  id: string;
  tabId: string;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  recorder: MediaRecorder;
  chunks: Blob[];
  mimeType: string;
  startedAt: string;
  frameCount: number;
  intervalId: number | null;
  startupSettled: Promise<void>;
  settleStartup: () => void;
  lifecycle: PreviewAutomationRecordingLifecycle;
};

function fallbackScreenshot(win: Window): PreviewAutomationScreenshot {
  return {
    mimeType: 'image/png',
    data: TRANSPARENT_PIXEL_PNG,
    width: Math.max(1, Math.round(win.innerWidth || 1)),
    height: Math.max(1, Math.round(win.innerHeight || 1)),
    unavailable: true,
  };
}

function recordingMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];
  return candidates.find((candidate) => (
    typeof MediaRecorder !== 'undefined'
    && typeof MediaRecorder.isTypeSupported === 'function'
    && MediaRecorder.isTypeSupported(candidate)
  )) ?? 'video/webm';
}

function recordingId(tabId: string, startedAt: string): string {
  const safeTabId = tabId
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'preview';
  return `preview-recording-${safeTabId}-${startedAt.replace(/[:.]/g, '-')}`;
}

function recordingPath(id: string, mimeType: string): string {
  const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
  return `.roomtalk/preview-recordings/${id}.${extension}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
        return;
      }
      reject(new Error('Workspace preview automation recording could not read the recorded blob.'));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('Workspace preview automation recording could not read the recorded blob.'));
    };
    reader.readAsArrayBuffer(blob);
  });
}

function cloneDocumentForScreenshot(doc: Document, width: number, height: number): HTMLElement {
  const wrapper = doc.createElement('div');
  const styles = Array.from(doc.querySelectorAll<HTMLStyleElement | HTMLLinkElement>('style, link[rel="stylesheet"]'))
    .map((element) => element.outerHTML)
    .join('');
  const bodyStyle = doc.body && doc.defaultView ? doc.defaultView.getComputedStyle(doc.body) : null;
  wrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  wrapper.style.width = `${width}px`;
  wrapper.style.minHeight = `${height}px`;
  wrapper.style.boxSizing = 'border-box';
  wrapper.style.margin = '0';
  wrapper.style.background = bodyStyle?.backgroundColor || 'white';
  wrapper.style.color = bodyStyle?.color || 'black';
  wrapper.style.font = bodyStyle?.font || '16px sans-serif';
  wrapper.innerHTML = `${styles}${doc.body?.innerHTML ?? ''}`;
  return wrapper;
}

async function drawDocumentToCanvas(
  doc: Document,
  win: Window,
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
): Promise<void> {
  const width = Math.max(
    1,
    Math.round(win.innerWidth || doc.documentElement.clientWidth || doc.body?.clientWidth || 1),
  );
  const height = Math.max(
    1,
    Math.round(win.innerHeight || doc.documentElement.clientHeight || doc.body?.clientHeight || 1),
  );
  if (canvas.width !== width) {
    canvas.width = width;
  }
  if (canvas.height !== height) {
    canvas.height = height;
  }
  const screenshotDocument = cloneDocumentForScreenshot(doc, width, height);
  const serialized = new XMLSerializer().serializeToString(screenshotDocument);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<foreignObject width="100%" height="100%">${serialized}</foreignObject>`,
    '</svg>',
  ].join('');
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, doc);
  context.drawImage(image, 0, 0, width, height);
}

function loadImage(src: string, ownerDocument: Document): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const ownerWindow = ownerDocument.defaultView ?? window;
    const image = new ownerWindow.Image();
    const timeout = window.setTimeout(() => {
      image.onload = null;
      image.onerror = null;
      reject(new Error('Workspace preview automation screenshot image timed out.'));
    }, SCREENSHOT_IMAGE_LOAD_TIMEOUT_MS);
    image.onload = () => {
      window.clearTimeout(timeout);
      resolve(image);
    };
    image.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error('Workspace preview automation screenshot image failed to load.'));
    };
    image.src = src;
  });
}

async function captureFrameScreenshot(
  doc: Document,
  win: Window,
): Promise<PreviewAutomationScreenshot> {
  const sourceWidth = Math.max(
    1,
    Math.round(win.innerWidth || doc.documentElement.clientWidth || doc.body?.clientWidth || 1),
  );
  const sourceHeight = Math.max(
    1,
    Math.round(win.innerHeight || doc.documentElement.clientHeight || doc.body?.clientHeight || 1),
  );
  const scale = sourceWidth > MAX_SCREENSHOT_WIDTH ? MAX_SCREENSHOT_WIDTH / sourceWidth : 1;
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const screenshotDocument = cloneDocumentForScreenshot(doc, sourceWidth, sourceHeight);
  const serialized = new XMLSerializer().serializeToString(screenshotDocument);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sourceWidth}" height="${sourceHeight}" viewBox="0 0 ${sourceWidth} ${sourceHeight}">`,
    `<foreignObject width="100%" height="100%">${serialized}</foreignObject>`,
    '</svg>',
  ].join('');
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, doc);
  const canvas = doc.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Workspace preview automation screenshot canvas is unavailable.');
  }
  context.drawImage(image, 0, 0, width, height);
  const dataUrl = canvas.toDataURL('image/png');
  const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
  if (!data || data === dataUrl) {
    throw new Error('Workspace preview automation screenshot encoding failed.');
  }
  return {
    mimeType: 'image/png',
    data,
    width,
    height,
  };
}

async function snapshotFrame(state: DomAutomationFrameState): Promise<unknown> {
  const doc = frameDocument(state);
  const win = frameWindow(state);
  const diagnostics = diagnosticsForTab(state.tabId);
  let screenshot = fallbackScreenshot(win);
  try {
    screenshot = await captureFrameScreenshot(doc, win);
  } catch {
    screenshot = fallbackScreenshot(win);
  }
  return {
    url: doc.location?.href || state.url,
    title: doc.title || state.title,
    loading: state.loading,
    visibleText: visibleText(doc.body || doc.documentElement).slice(0, 20000),
    interactiveElements: interactiveElements(doc),
    accessibilityTree: buildAccessibilityTree(doc),
    consoleEntries: [...diagnostics.consoleEntries],
    networkEntries: [...diagnostics.networkEntries],
    actionTimeline: [...diagnostics.actionTimeline],
    screenshot,
  };
}

let activeRecording: ActiveDomRecording | null = null;

function isRecordingStarting(recording: ActiveDomRecording): boolean {
  return activeRecording === recording && recording.lifecycle.phase === 'starting';
}

function recordingStartupCancelledError(recording: ActiveDomRecording): Error {
  return new Error(`Workspace preview automation recording startup was cancelled for tab ${recording.tabId}.`);
}

function waitForRecordingStartupToSettle(recording: ActiveDomRecording): Promise<void> {
  let timeoutId: number | null = null;
  return Promise.race([
    recording.startupSettled,
    new Promise<void>((_, reject) => {
      timeoutId = window.setTimeout(() => {
        reject(new Error(`Workspace preview automation recording startup did not settle for tab ${recording.tabId}.`));
      }, RECORDING_STARTUP_SETTLE_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  });
}

async function startRecording(state: DomAutomationFrameState, request: CodeWorkspacePreviewAutomationRequest): Promise<{
  tabId: string;
  recording: true;
  startedAt: string;
}> {
  const doc = frameDocument(state);
  const win = frameWindow(state);
  if (activeRecording) {
    if (activeRecording.tabId === state.tabId && activeRecording.lifecycle.phase === 'recording') {
      return {
        tabId: activeRecording.tabId,
        recording: true,
        startedAt: activeRecording.startedAt,
      };
    }
    throw previewAutomationRecordingConflictError(request, state.tabId, activeRecording.tabId);
  }
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('Workspace preview automation recording requires MediaRecorder support.');
  }
  const canvas = doc.createElement('canvas');
  if (typeof canvas.captureStream !== 'function') {
    throw new Error('Workspace preview automation recording requires canvas captureStream support.');
  }
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    throw new Error('Workspace preview automation recording canvas is unavailable.');
  }
  const mimeType = recordingMimeType();
  const recorder = new MediaRecorder(canvas.captureStream(RECORDING_FRAME_RATE), {
    mimeType,
    videoBitsPerSecond: 4_000_000,
  });
  const startedAt = new Date().toISOString();
  const id = recordingId(state.tabId, startedAt);
  let settleStartup = () => {};
  const startupSettled = new Promise<void>((resolve) => {
    settleStartup = resolve;
  });
  const recording: ActiveDomRecording = {
    id,
    tabId: state.tabId,
    canvas,
    context,
    recorder,
    chunks: [],
    mimeType,
    startedAt,
    frameCount: 0,
    intervalId: null,
    startupSettled,
    settleStartup,
    lifecycle: { phase: 'starting' },
  };
  recorder.addEventListener('dataavailable', (event) => {
    const data = (event as BlobEvent).data;
    if (data?.size > 0) {
      recording.chunks.push(data);
    }
  });
  activeRecording = recording;
  try {
    await drawDocumentToCanvas(doc, win, canvas, context);
    recording.frameCount += 1;
    if (!isRecordingStarting(recording)) {
      throw recordingStartupCancelledError(recording);
    }
    recorder.start(1000);
    if (!isRecordingStarting(recording)) {
      await stopMediaRecorder(recorder).catch(() => undefined);
      throw recordingStartupCancelledError(recording);
    }
    recording.intervalId = window.setInterval(() => {
      void drawDocumentToCanvas(doc, win, canvas, context)
        .then(() => {
          if (activeRecording === recording && recording.lifecycle.phase === 'recording') {
            recording.frameCount += 1;
          }
        })
        .catch(() => undefined);
    }, RECORDING_FRAME_INTERVAL_MS);
    recording.lifecycle = { phase: 'recording' };
  } catch (error) {
    if (activeRecording === recording && recording.lifecycle.phase === 'starting') {
      clearRecording(recording);
    }
    throw error;
  } finally {
    recording.settleStartup();
  }
  return {
    tabId: recording.tabId,
    recording: true,
    startedAt,
  };
}

function stopMediaRecorder(recorder: MediaRecorder): Promise<void> {
  return new Promise((resolve, reject) => {
    if (recorder.state === 'inactive') {
      resolve();
      return;
    }
    const cleanup = () => {
      recorder.removeEventListener('stop', onStop);
      recorder.removeEventListener('error', onError);
    };
    const onStop = () => {
      cleanup();
      resolve();
    };
    const onError = (event: Event) => {
      cleanup();
      reject(event instanceof ErrorEvent ? event.error : new Error('Workspace preview automation recording failed.'));
    };
    recorder.addEventListener('stop', onStop, { once: true });
    recorder.addEventListener('error', onError, { once: true });
    recorder.stop();
  });
}

function clearRecording(recording: ActiveDomRecording): void {
  if (recording.intervalId !== null) {
    window.clearInterval(recording.intervalId);
    recording.intervalId = null;
  }
  if (activeRecording === recording) {
    activeRecording = null;
  }
}

async function stopRecording(state: DomAutomationFrameState, request: CodeWorkspacePreviewAutomationRequest): Promise<PreviewAutomationRecordingArtifactUpload> {
  const requestedTabId = request.tabIdExplicit ? request.tabId : undefined;
  const recording = activeRecording;
  const stopTabId = requestedTabId ?? recording?.tabId ?? state.tabId;
  if (!recording || recording.tabId !== stopTabId) {
    throw previewAutomationRecordingNotActiveError(request, stopTabId ?? null);
  }
  if (recording.lifecycle.phase === 'stopping') {
    return recording.lifecycle.stopPromise;
  }
  const wasStarting = recording.lifecycle.phase === 'starting';
  const stopPromise = Promise.resolve()
    .then(async () => {
      if (wasStarting) {
        await waitForRecordingStartupToSettle(recording);
      }
      if (recording.intervalId !== null) {
        window.clearInterval(recording.intervalId);
        recording.intervalId = null;
      }
      try {
        await drawDocumentToCanvas(
          frameDocument(state),
          frameWindow(state),
          recording.canvas,
          recording.context,
        );
        recording.frameCount += 1;
      } catch {
        // Keep the recording stoppable even if the iframe navigated cross-origin.
      }
      await stopMediaRecorder(recording.recorder);
      const stoppedAt = new Date().toISOString();
      const blob = new Blob(recording.chunks, { type: recording.mimeType });
      const data = arrayBufferToBase64(await blobToArrayBuffer(blob));
      return {
        id: recording.id,
        tabId: recording.tabId,
        path: recordingPath(recording.id, recording.mimeType),
        mimeType: recording.mimeType,
        sizeBytes: blob.size,
        createdAt: stoppedAt,
        encoding: 'base64' as const,
        data,
        startedAt: recording.startedAt,
        stoppedAt,
        durationMs: Math.max(0, Date.parse(stoppedAt) - Date.parse(recording.startedAt)),
        frameCount: recording.frameCount,
      };
    })
    .finally(() => {
      clearRecording(recording);
    });
  recording.lifecycle = { phase: 'stopping', stopPromise };
  return stopPromise;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

async function waitForCondition(
  state: DomAutomationFrameState,
  input: DomAutomationInput,
  fallbackTimeoutMs: number,
  request: CodeWorkspacePreviewAutomationRequest,
): Promise<unknown> {
  const timeoutMs = timeoutInput(input, fallbackTimeoutMs);
  const deadline = Date.now() + timeoutMs;
  const selector = stringInput(input, 'selector');
  const locator = stringInput(input, 'locator');
  const text = stringInput(input, 'text');
  const urlIncludes = stringInput(input, 'urlIncludes');
  while (Date.now() <= deadline) {
    const doc = frameDocument(state);
    const selectorMatch = selector ? queryCssSelector(doc, selector, request, input) : null;
    const locatorMatch = locator ? queryLocator(doc, locator, request, input) : null;
    const textMatched = text ? visibleText(doc.body || doc.documentElement).includes(text) : true;
    const urlMatched = urlIncludes ? (doc.location?.href || state.url).includes(urlIncludes) : true;
    if (
      (!selector || selectorMatch)
      && (!locator || locatorMatch)
      && textMatched
      && urlMatched
    ) {
      return {
        matched: true,
        ...(selector ? { selector } : {}),
        ...(locator ? { locator } : {}),
        ...(text ? { text } : {}),
        ...(urlIncludes ? { url: doc.location?.href || state.url } : {}),
      };
    }
    await wait(50);
  }
  throw previewAutomationTimeoutError(request, timeoutMs);
}

function serializedJsonByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') {
    return 0;
  }
  const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
  return encoder ? encoder.encode(serialized).byteLength : serialized.length;
}

async function evaluateFrame(
  state: DomAutomationFrameState,
  input: DomAutomationInput,
  request: CodeWorkspacePreviewAutomationRequest,
): Promise<unknown> {
  const expression = stringInput(input, 'expression');
  if (!expression) {
    throw new Error('Preview automation evaluate expression is required.');
  }
  try {
    const win = frameWindow(state);
    const evaluator = (win as Window & typeof globalThis).Function('return (' + expression + ');');
    const value = evaluator.call(win);
    const resolved = booleanInput(input, 'awaitPromise', true) && value && typeof (value as Promise<unknown>).then === 'function'
      ? await value
      : value;
    const actualBytes = serializedJsonByteLength(resolved);
    if (actualBytes > PREVIEW_AUTOMATION_MAX_EVALUATION_BYTES) {
      throw previewAutomationResultTooLargeError(request, actualBytes);
    }
    return resolved;
  } catch (error) {
    if (error instanceof PreviewAutomationInputError) {
      throw error;
    }
    throw previewAutomationEvaluationError(request, error);
  }
}

export async function runCodeWorkspacePreviewDomAutomation(
  request: CodeWorkspacePreviewAutomationRequest,
  state: DomAutomationFrameState,
): Promise<unknown> {
  const input = inputRecord(request.input);
  const action = startActionEntry(state.tabId, request.operation);
  try {
    installPreviewAutomationDiagnostics(state);
    const doc = request.operation === 'evaluate' || request.operation === 'snapshot'
      ? null
      : frameDocument(state);
    const result = await (async () => {
      switch (request.operation) {
        case 'snapshot':
          return snapshotFrame(state);
        case 'click': {
          const element = targetElement(doc!, input, request) as HTMLElement;
          element.focus();
          element.click();
          return { clicked: true, selector: elementSelector(element), name: accessibleName(element) };
        }
        case 'type': {
          const text = stringInput(input, 'text');
          if (text === null) {
            throw new Error('Preview automation type text is required.');
          }
          const element = activeEditable(doc!, input, request);
          writeText(element, text, booleanInput(input, 'clear'), request, input);
          return { typed: true, selector: elementSelector(element) };
        }
        case 'press': {
          const element = (doc!.activeElement || doc!.body) as HTMLElement;
          return {
            pressed: true,
            ...dispatchKeyboard(element, input, state),
          };
        }
        case 'scroll':
          return scrollTarget(frameWindow(state), doc!, input, request);
        case 'evaluate':
          return evaluateFrame(state, input, request);
        case 'waitFor':
          return waitForCondition(state, input, request.timeoutMs, request);
        case 'previewAnnotation':
          return previewAnnotationForTarget(state, input, request);
        case 'clearCookies':
          return clearFrameCookies(state);
        case 'clearCache':
          return clearFrameCache(state);
        case 'recordingStart':
          return startRecording(state, request);
        case 'recordingStop':
          return stopRecording(state, request);
        default:
          throw new Error(`Workspace preview automation does not support ${request.operation} in this browser surface.`);
      }
    })();
    completeActionEntry(state.tabId, action, 'succeeded');
    return result;
  } catch (error) {
    completeActionEntry(state.tabId, action, 'failed', error);
    throw error;
  }
}
