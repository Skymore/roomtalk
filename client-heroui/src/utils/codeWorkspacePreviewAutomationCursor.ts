import type {
  CodeWorkspacePreviewAutomationOperation,
  CodeWorkspacePreviewAutomationRequest,
} from './socket';

export type CodeWorkspacePreviewAutomationCursorController = 'human' | 'agent' | 'none';
export type CodeWorkspacePreviewAutomationCursorPhase = 'move' | 'click';

export type CodeWorkspacePreviewAutomationCursorPoint = {
  x: number;
  y: number;
};

export type CodeWorkspacePreviewAutomationCursorEvent = CodeWorkspacePreviewAutomationCursorPoint & {
  phase: CodeWorkspacePreviewAutomationCursorPhase;
  sequence: number;
};

type CursorInput = Record<string, unknown>;

export function codeWorkspacePreviewAutomationCursorOpacity(
  active: boolean,
  controller: CodeWorkspacePreviewAutomationCursorController,
): number {
  if (active) return 1;
  return controller === 'human' ? 0.18 : 0.35;
}

export function codeWorkspacePreviewAutomationCursorPhase(
  operation: CodeWorkspacePreviewAutomationOperation,
): CodeWorkspacePreviewAutomationCursorPhase | null {
  if (operation === 'click') return 'click';
  if (operation === 'type' || operation === 'press' || operation === 'scroll') return 'move';
  return null;
}

export function buildCodeWorkspacePreviewAutomationCursorEvent(
  request: CodeWorkspacePreviewAutomationRequest,
  iframe: HTMLIFrameElement | null,
  sequence: number,
): CodeWorkspacePreviewAutomationCursorEvent | null {
  const phase = codeWorkspacePreviewAutomationCursorPhase(request.operation);
  if (!phase) {
    return null;
  }
  const point = resolveCodeWorkspacePreviewAutomationCursorPoint(request, iframe);
  if (!point) {
    return null;
  }
  return {
    ...point,
    phase,
    sequence,
  };
}

export function resolveCodeWorkspacePreviewAutomationCursorPoint(
  request: CodeWorkspacePreviewAutomationRequest,
  iframe: HTMLIFrameElement | null,
): CodeWorkspacePreviewAutomationCursorPoint | null {
  if (!iframe) {
    return null;
  }
  const input = inputRecord(request.input);
  const doc = frameDocument(iframe);
  if (!doc) {
    return null;
  }
  const clientPoint = pointFromClientCoordinates(iframe, input);
  if (clientPoint) {
    return clientPoint;
  }
  const selectorPoint = pointFromSelector(doc, input);
  if (selectorPoint) {
    return clampPoint(iframe, selectorPoint);
  }
  const locatorPoint = pointFromLocator(doc, input);
  if (locatorPoint) {
    return clampPoint(iframe, locatorPoint);
  }
  const localPoint = pointFromLocalCoordinates(iframe, input);
  if (localPoint) {
    return localPoint;
  }
  if (request.operation === 'type' || request.operation === 'press') {
    const activeElement = doc.activeElement;
    if (activeElement && activeElement !== doc.body && activeElement !== doc.documentElement) {
      return clampPoint(iframe, elementCenter(activeElement));
    }
  }
  if (request.operation === 'scroll') {
    return frameCenter(iframe);
  }
  return null;
}

function isRecord(value: unknown): value is CursorInput {
  return typeof value === 'object' && value !== null;
}

function inputRecord(input: unknown): CursorInput {
  return isRecord(input) ? input : {};
}

function stringInput(input: CursorInput, key: string): string | null {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberInput(input: CursorInput, key: string): number | null {
  const value = input[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function frameDocument(iframe: HTMLIFrameElement): Document | null {
  try {
    const doc = iframe.contentDocument ?? iframe.contentWindow?.document ?? null;
    if (!doc) {
      return null;
    }
    void doc.body;
    return doc;
  } catch {
    return null;
  }
}

function frameSize(iframe: HTMLIFrameElement): { width: number; height: number } {
  const rect = iframe.getBoundingClientRect();
  return {
    width: Math.max(1, iframe.clientWidth || Math.round(rect.width) || 1),
    height: Math.max(1, iframe.clientHeight || Math.round(rect.height) || 1),
  };
}

function clampPoint(
  iframe: HTMLIFrameElement,
  point: CodeWorkspacePreviewAutomationCursorPoint,
): CodeWorkspacePreviewAutomationCursorPoint {
  const size = frameSize(iframe);
  return {
    x: Math.min(Math.max(0, point.x), size.width),
    y: Math.min(Math.max(0, point.y), size.height),
  };
}

function pointFromClientCoordinates(
  iframe: HTMLIFrameElement,
  input: CursorInput,
): CodeWorkspacePreviewAutomationCursorPoint | null {
  const clientX = numberInput(input, 'clientX');
  const clientY = numberInput(input, 'clientY');
  if (clientX === null || clientY === null) {
    return null;
  }
  const rect = iframe.getBoundingClientRect();
  const size = frameSize(iframe);
  const scaleX = rect.width > 0 ? size.width / rect.width : 1;
  const scaleY = rect.height > 0 ? size.height / rect.height : 1;
  return clampPoint(iframe, {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  });
}

function pointFromLocalCoordinates(
  iframe: HTMLIFrameElement,
  input: CursorInput,
): CodeWorkspacePreviewAutomationCursorPoint | null {
  const x = numberInput(input, 'x');
  const y = numberInput(input, 'y');
  if (x === null || y === null) {
    return null;
  }
  return clampPoint(iframe, { x, y });
}

function pointFromSelector(doc: Document, input: CursorInput): CodeWorkspacePreviewAutomationCursorPoint | null {
  const selector = stringInput(input, 'selector');
  if (!selector) {
    return null;
  }
  try {
    const element = doc.querySelector(selector);
    return element ? elementCenter(element) : null;
  } catch {
    return null;
  }
}

function pointFromLocator(doc: Document, input: CursorInput): CodeWorkspacePreviewAutomationCursorPoint | null {
  const locator = stringInput(input, 'locator');
  if (!locator) {
    return null;
  }
  const element = queryLocator(doc, locator);
  return element ? elementCenter(element) : null;
}

function frameCenter(iframe: HTMLIFrameElement): CodeWorkspacePreviewAutomationCursorPoint {
  const size = frameSize(iframe);
  return {
    x: Math.round(size.width / 2),
    y: Math.round(size.height / 2),
  };
}

function elementCenter(element: Element): CodeWorkspacePreviewAutomationCursorPoint {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
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
    try {
      return doc.querySelector(parsed.value);
    } catch {
      return null;
    }
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
