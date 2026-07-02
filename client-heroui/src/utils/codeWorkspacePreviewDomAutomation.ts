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
] as const satisfies readonly CodeWorkspacePreviewAutomationOperation[];

const domOperationSet = new Set<string>(CODE_WORKSPACE_PREVIEW_AUTOMATION_DOM_OPERATIONS);

const TRANSPARENT_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

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

function snapshotFrame(state: DomAutomationFrameState): unknown {
  const doc = frameDocument(state);
  const win = frameWindow(state);
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
    screenshot: {
      mimeType: 'image/png',
      data: TRANSPARENT_PIXEL_PNG,
      width: Math.max(1, Math.round(win.innerWidth || 1)),
      height: Math.max(1, Math.round(win.innerHeight || 1)),
      unavailable: true,
    },
  };
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
    default:
      throw new Error(`Workspace preview automation does not support ${request.operation} in this browser surface.`);
  }
}
