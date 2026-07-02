import type {
  CodeWorkspacePreviewAutomationOperation,
  CodeWorkspacePreviewAutomationRequest,
} from './socket';

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
const PREVIEW_ANNOTATION_HTML_LIMIT = 4000;
const PREVIEW_ANNOTATION_STYLE_LIMIT = 4000;

type DomAutomationInput = Record<string, unknown>;

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

function visibleText(element: Element): string {
  return (element.textContent || '').replace(/\s+/g, ' ').trim();
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

function accessibleName(element: Element): string {
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
  const direct =
    element.getAttribute('aria-label')
    || element.getAttribute('alt')
    || element.getAttribute('title')
    || element.getAttribute('placeholder')
    || '';
  if (direct.trim()) {
    return direct.trim();
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

function queryLocator(doc: Document, locator: string): Element | null {
  const parsed = parseLocator(locator);
  if (parsed.kind === 'css') {
    return doc.querySelector(parsed.value);
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

function targetElement(doc: Document, input: DomAutomationInput): Element {
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
    ? doc.querySelector(selector)
    : locator
      ? queryLocator(doc, locator)
      : x !== null && y !== null
        ? doc.elementFromPoint(x, y)
        : doc.activeElement;
  if (!target || target === doc.body || target === doc.documentElement) {
    throw new Error('Workspace preview automation target was not found.');
  }
  return target;
}

function activeEditable(doc: Document, input: DomAutomationInput): HTMLElement {
  const selector = stringInput(input, 'selector');
  const locator = stringInput(input, 'locator');
  const element = selector || locator
    ? targetElement(doc, input)
    : doc.activeElement;
  if (!element || element === doc.body || element === doc.documentElement) {
    throw new Error('Workspace preview automation editable target was not found.');
  }
  return element as HTMLElement;
}

function writeText(element: HTMLElement, text: string, clear: boolean): void {
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
  throw new Error('Workspace preview automation target is not editable.');
}

function dispatchKeyboard(element: Element, key: string, modifiers: readonly unknown[] = []): void {
  const ownerWindow = element.ownerDocument.defaultView ?? window;
  const modifierSet = new Set(modifiers.filter((modifier): modifier is string => typeof modifier === 'string'));
  const init: KeyboardEventInit = {
    bubbles: true,
    cancelable: true,
    key,
    altKey: modifierSet.has('Alt'),
    ctrlKey: modifierSet.has('Control'),
    metaKey: modifierSet.has('Meta'),
    shiftKey: modifierSet.has('Shift'),
  };
  element.dispatchEvent(new ownerWindow.KeyboardEvent('keydown', init));
  element.dispatchEvent(new ownerWindow.KeyboardEvent('keyup', init));
}

function scrollTarget(win: Window, doc: Document, input: DomAutomationInput): {
  scrollLeft: number;
  scrollTop: number;
} {
  const deltaX = numberInput(input, 'deltaX') ?? 0;
  const deltaY = numberInput(input, 'deltaY') ?? 0;
  const selector = stringInput(input, 'selector');
  const locator = stringInput(input, 'locator');
  if (selector || locator) {
    const element = targetElement(doc, input) as HTMLElement;
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
): Element {
  const target = inputClientPointElement(state, doc, input) ?? targetElement(doc, input);
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
): Promise<unknown> {
  const doc = frameDocument(state);
  const element = previewAnnotationTargetElement(state, doc, input);
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
  intervalId: number;
  stopping?: Promise<PreviewAutomationRecordingArtifactUpload>;
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
    accessibilityTree: {
      role: 'document',
      name: doc.title || state.title,
    },
    consoleEntries: [],
    networkEntries: [],
    actionTimeline: [],
    screenshot,
  };
}

let activeRecording: ActiveDomRecording | null = null;

async function startRecording(state: DomAutomationFrameState): Promise<{
  tabId: string;
  recording: true;
  startedAt: string;
}> {
  const doc = frameDocument(state);
  const win = frameWindow(state);
  if (activeRecording) {
    if (activeRecording.tabId === state.tabId) {
      return {
        tabId: activeRecording.tabId,
        recording: true,
        startedAt: activeRecording.startedAt,
      };
    }
    throw new Error(`Cannot record tab ${state.tabId} while tab ${activeRecording.tabId} is already being recorded.`);
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
  await drawDocumentToCanvas(doc, win, canvas, context);
  const mimeType = recordingMimeType();
  const recorder = new MediaRecorder(canvas.captureStream(RECORDING_FRAME_RATE), {
    mimeType,
    videoBitsPerSecond: 4_000_000,
  });
  const startedAt = new Date().toISOString();
  const id = recordingId(state.tabId, startedAt);
  const recording: ActiveDomRecording = {
    id,
    tabId: state.tabId,
    canvas,
    context,
    recorder,
    chunks: [],
    mimeType,
    startedAt,
    frameCount: 1,
    intervalId: window.setInterval(() => {
      void drawDocumentToCanvas(doc, win, canvas, context)
        .then(() => {
          if (activeRecording === recording) {
            recording.frameCount += 1;
          }
        })
        .catch(() => undefined);
    }, RECORDING_FRAME_INTERVAL_MS),
  };
  recorder.addEventListener('dataavailable', (event) => {
    const data = (event as BlobEvent).data;
    if (data?.size > 0) {
      recording.chunks.push(data);
    }
  });
  activeRecording = recording;
  try {
    recorder.start(1000);
  } catch (error) {
    window.clearInterval(recording.intervalId);
    activeRecording = null;
    throw error;
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
  window.clearInterval(recording.intervalId);
  if (activeRecording === recording) {
    activeRecording = null;
  }
}

async function stopRecording(state: DomAutomationFrameState, request: CodeWorkspacePreviewAutomationRequest): Promise<PreviewAutomationRecordingArtifactUpload> {
  const requestedTabId = request.tabIdExplicit ? request.tabId : undefined;
  const recording = activeRecording;
  const stopTabId = requestedTabId ?? recording?.tabId ?? state.tabId;
  if (!recording || recording.tabId !== stopTabId) {
    throw new Error(`Preview automation request ${request.requestId} found no active recording for tab ${stopTabId ?? 'unassigned'}.`);
  }
  if (recording.stopping) {
    return recording.stopping;
  }
  const stopPromise = Promise.resolve()
    .then(async () => {
      clearRecording(recording);
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
      if (activeRecording === recording) {
        activeRecording = null;
      }
    });
  recording.stopping = stopPromise;
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
): Promise<unknown> {
  const timeoutMs = timeoutInput(input, fallbackTimeoutMs);
  const deadline = Date.now() + timeoutMs;
  const selector = stringInput(input, 'selector');
  const locator = stringInput(input, 'locator');
  const text = stringInput(input, 'text');
  const urlIncludes = stringInput(input, 'urlIncludes');
  while (Date.now() <= deadline) {
    const doc = frameDocument(state);
    const selectorMatch = selector ? doc.querySelector(selector) : null;
    const locatorMatch = locator ? queryLocator(doc, locator) : null;
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
  throw new Error('Workspace preview automation wait timed out.');
}

async function evaluateFrame(state: DomAutomationFrameState, input: DomAutomationInput): Promise<unknown> {
  const expression = stringInput(input, 'expression');
  if (!expression) {
    throw new Error('Preview automation evaluate expression is required.');
  }
  const win = frameWindow(state);
  const evaluator = (win as Window & typeof globalThis).Function('return (' + expression + ');');
  const value = evaluator.call(win);
  return booleanInput(input, 'awaitPromise', true) && value && typeof (value as Promise<unknown>).then === 'function'
    ? await value
    : value;
}

export async function runCodeWorkspacePreviewDomAutomation(
  request: CodeWorkspacePreviewAutomationRequest,
  state: DomAutomationFrameState,
): Promise<unknown> {
  const input = inputRecord(request.input);
  const doc = request.operation === 'evaluate' || request.operation === 'snapshot'
    ? null
    : frameDocument(state);
  switch (request.operation) {
    case 'snapshot':
      return snapshotFrame(state);
    case 'click': {
      const element = targetElement(doc!, input) as HTMLElement;
      element.focus();
      element.click();
      return { clicked: true, selector: elementSelector(element), name: accessibleName(element) };
    }
    case 'type': {
      const text = stringInput(input, 'text');
      if (text === null) {
        throw new Error('Preview automation type text is required.');
      }
      const element = activeEditable(doc!, input);
      writeText(element, text, booleanInput(input, 'clear'));
      return { typed: true, selector: elementSelector(element) };
    }
    case 'press': {
      const key = stringInput(input, 'key');
      if (!key) {
        throw new Error('Preview automation press key is required.');
      }
      const element = (doc!.activeElement || doc!.body) as HTMLElement;
      dispatchKeyboard(element, key, Array.isArray(input.modifiers) ? input.modifiers : []);
      return { pressed: true, key };
    }
    case 'scroll':
      return scrollTarget(frameWindow(state), doc!, input);
    case 'evaluate':
      return evaluateFrame(state, input);
    case 'waitFor':
      return waitForCondition(state, input, request.timeoutMs);
    case 'previewAnnotation':
      return previewAnnotationForTarget(state, input);
    case 'clearCookies':
      return clearFrameCookies(state);
    case 'clearCache':
      return clearFrameCache(state);
    case 'recordingStart':
      return startRecording(state);
    case 'recordingStop':
      return stopRecording(state, request);
    default:
      throw new Error(`Workspace preview automation does not support ${request.operation} in this browser surface.`);
  }
}
