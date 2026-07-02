export interface CodeAgentPickedElementStackFrame {
  functionName: string | null;
  fileName: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
}

export interface CodeAgentPickedElementPayload {
  pageUrl: string;
  pageTitle: string | null;
  tagName: string;
  selector: string | null;
  htmlPreview: string;
  componentName: string | null;
  source: CodeAgentPickedElementStackFrame | null;
  stack: readonly CodeAgentPickedElementStackFrame[];
  styles: string;
  pickedAt: string;
}

export interface CodeAgentPreviewAnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CodeAgentPreviewAnnotationElementTarget {
  id: string;
  element: CodeAgentPickedElementPayload;
  rect: CodeAgentPreviewAnnotationRect;
}

export interface CodeAgentPreviewAnnotationPoint {
  x: number;
  y: number;
}

export interface CodeAgentPreviewAnnotationRegionTarget {
  id: string;
  rect: CodeAgentPreviewAnnotationRect;
}

export interface CodeAgentPreviewAnnotationStrokeTarget {
  id: string;
  color: string;
  width: number;
  points: readonly CodeAgentPreviewAnnotationPoint[];
  bounds: CodeAgentPreviewAnnotationRect;
}

export interface CodeAgentPreviewAnnotationStyleChange {
  targetId: string;
  selector: string | null;
  property: string;
  previousValue: string;
  value: string;
}

export interface CodeAgentPreviewAnnotationScreenshot {
  dataUrl: string;
  width: number;
  height: number;
  cropRect: CodeAgentPreviewAnnotationRect;
}

export interface CodeAgentPreviewAnnotationContext {
  id: string;
  pageUrl: string;
  pageTitle: string | null;
  comment: string;
  elements: readonly CodeAgentPreviewAnnotationElementTarget[];
  regions: readonly CodeAgentPreviewAnnotationRegionTarget[];
  strokes: readonly CodeAgentPreviewAnnotationStrokeTarget[];
  styleChanges: readonly CodeAgentPreviewAnnotationStyleChange[];
  screenshot: CodeAgentPreviewAnnotationScreenshot | null;
  createdAt: string;
}

const ELEMENT_CONTEXT_HTML_PREVIEW_LIMIT = 4000;
const ELEMENT_CONTEXT_STYLES_LIMIT = 4000;
const ELEMENT_CONTEXT_LABEL_TAG_MAX = 24;
const STYLE_CHANGE_VALUE_LIMIT = 1000;

function truncateString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isStackFrame(value: unknown): value is CodeAgentPickedElementStackFrame {
  if (!value || typeof value !== 'object') return false;
  const frame = value as Partial<Record<keyof CodeAgentPickedElementStackFrame, unknown>>;
  return isStringOrNull(frame.functionName)
    && isStringOrNull(frame.fileName)
    && isFiniteNumberOrNull(frame.lineNumber)
    && isFiniteNumberOrNull(frame.columnNumber);
}

function isRect(value: unknown): value is CodeAgentPreviewAnnotationRect {
  if (!value || typeof value !== 'object') return false;
  const rect = value as Partial<Record<keyof CodeAgentPreviewAnnotationRect, unknown>>;
  return typeof rect.x === 'number'
    && Number.isFinite(rect.x)
    && typeof rect.y === 'number'
    && Number.isFinite(rect.y)
    && typeof rect.width === 'number'
    && Number.isFinite(rect.width)
    && typeof rect.height === 'number'
    && Number.isFinite(rect.height);
}

function isPoint(value: unknown): value is CodeAgentPreviewAnnotationPoint {
  if (!value || typeof value !== 'object') return false;
  const point = value as Partial<Record<keyof CodeAgentPreviewAnnotationPoint, unknown>>;
  return typeof point.x === 'number'
    && Number.isFinite(point.x)
    && typeof point.y === 'number'
    && Number.isFinite(point.y);
}

export function isCodeAgentPickedElementPayload(value: unknown): value is CodeAgentPickedElementPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<Record<keyof CodeAgentPickedElementPayload, unknown>>;
  return typeof payload.pageUrl === 'string'
    && isStringOrNull(payload.pageTitle)
    && typeof payload.tagName === 'string'
    && isStringOrNull(payload.selector)
    && typeof payload.htmlPreview === 'string'
    && isStringOrNull(payload.componentName)
    && (payload.source === null || isStackFrame(payload.source))
    && Array.isArray(payload.stack)
    && payload.stack.every(isStackFrame)
    && typeof payload.styles === 'string'
    && typeof payload.pickedAt === 'string';
}

function isPreviewAnnotationElement(value: unknown): value is CodeAgentPreviewAnnotationElementTarget {
  if (!value || typeof value !== 'object') return false;
  const target = value as Partial<Record<keyof CodeAgentPreviewAnnotationElementTarget, unknown>>;
  return typeof target.id === 'string'
    && isCodeAgentPickedElementPayload(target.element)
    && isRect(target.rect);
}

function isPreviewAnnotationRegion(value: unknown): value is CodeAgentPreviewAnnotationRegionTarget {
  if (!value || typeof value !== 'object') return false;
  const region = value as Partial<Record<keyof CodeAgentPreviewAnnotationRegionTarget, unknown>>;
  return typeof region.id === 'string' && isRect(region.rect);
}

function isPreviewAnnotationStroke(value: unknown): value is CodeAgentPreviewAnnotationStrokeTarget {
  if (!value || typeof value !== 'object') return false;
  const stroke = value as Partial<Record<keyof CodeAgentPreviewAnnotationStrokeTarget, unknown>>;
  return typeof stroke.id === 'string'
    && typeof stroke.color === 'string'
    && typeof stroke.width === 'number'
    && Number.isFinite(stroke.width)
    && Array.isArray(stroke.points)
    && stroke.points.every(isPoint)
    && isRect(stroke.bounds);
}

function isPreviewAnnotationStyleChange(value: unknown): value is CodeAgentPreviewAnnotationStyleChange {
  if (!value || typeof value !== 'object') return false;
  const change = value as Partial<Record<keyof CodeAgentPreviewAnnotationStyleChange, unknown>>;
  return typeof change.targetId === 'string'
    && isStringOrNull(change.selector)
    && typeof change.property === 'string'
    && typeof change.previousValue === 'string'
    && typeof change.value === 'string';
}

function isScreenshot(value: unknown): value is CodeAgentPreviewAnnotationScreenshot {
  if (!value || typeof value !== 'object') return false;
  const screenshot = value as Partial<Record<keyof CodeAgentPreviewAnnotationScreenshot, unknown>>;
  return typeof screenshot.dataUrl === 'string'
    && screenshot.dataUrl.startsWith('data:image/')
    && typeof screenshot.width === 'number'
    && Number.isFinite(screenshot.width)
    && typeof screenshot.height === 'number'
    && Number.isFinite(screenshot.height)
    && isRect(screenshot.cropRect);
}

export function isCodeAgentPreviewAnnotationContext(value: unknown): value is CodeAgentPreviewAnnotationContext {
  if (!value || typeof value !== 'object') return false;
  const annotation = value as Partial<Record<keyof CodeAgentPreviewAnnotationContext, unknown>>;
  return typeof annotation.id === 'string'
    && typeof annotation.pageUrl === 'string'
    && isStringOrNull(annotation.pageTitle)
    && typeof annotation.comment === 'string'
    && Array.isArray(annotation.elements)
    && annotation.elements.every(isPreviewAnnotationElement)
    && Array.isArray(annotation.regions)
    && annotation.regions.every(isPreviewAnnotationRegion)
    && Array.isArray(annotation.strokes)
    && annotation.strokes.every(isPreviewAnnotationStroke)
    && Array.isArray(annotation.styleChanges)
    && annotation.styleChanges.every(isPreviewAnnotationStyleChange)
    && (annotation.screenshot === null || isScreenshot(annotation.screenshot))
    && typeof annotation.createdAt === 'string';
}

export function compactCodeAgentPreviewAnnotation(
  annotation: CodeAgentPreviewAnnotationContext,
): CodeAgentPreviewAnnotationContext {
  return {
    ...annotation,
    comment: annotation.comment.trim(),
    elements: annotation.elements.map((target) => ({
      ...target,
      element: {
        ...target.element,
        pageUrl: target.element.pageUrl.trim(),
        pageTitle: target.element.pageTitle?.trim() || null,
        tagName: target.element.tagName.trim().toLowerCase(),
        selector: target.element.selector?.trim() || null,
        htmlPreview: truncateString(normalizeText(target.element.htmlPreview), ELEMENT_CONTEXT_HTML_PREVIEW_LIMIT),
        componentName: target.element.componentName?.trim() || null,
        styles: truncateString(normalizeText(target.element.styles), ELEMENT_CONTEXT_STYLES_LIMIT),
      },
    })),
    regions: annotation.regions.map((region) => ({
      ...region,
      rect: { ...region.rect },
    })),
    strokes: annotation.strokes.map((stroke) => ({
      ...stroke,
      color: stroke.color.trim(),
      width: stroke.width,
      points: stroke.points.map((point) => ({ ...point })),
      bounds: { ...stroke.bounds },
    })),
    styleChanges: annotation.styleChanges.map((change) => ({
      targetId: change.targetId.trim(),
      selector: change.selector?.trim() || null,
      property: truncateString(change.property.trim(), STYLE_CHANGE_VALUE_LIMIT),
      previousValue: truncateString(normalizeText(change.previousValue), STYLE_CHANGE_VALUE_LIMIT),
      value: truncateString(normalizeText(change.value), STYLE_CHANGE_VALUE_LIMIT),
    })).filter((change) => change.targetId.length > 0 && change.property.length > 0),
    screenshot: null,
  };
}

function shortenTagLabel(tagName: string): string {
  return tagName.length <= ELEMENT_CONTEXT_LABEL_TAG_MAX
    ? tagName
    : `${tagName.slice(0, ELEMENT_CONTEXT_LABEL_TAG_MAX - 3)}...`;
}

export function formatCodeAgentPickedElementLabel(element: CodeAgentPickedElementPayload): string {
  const componentName = element.componentName?.trim();
  if (componentName) return `<${componentName}>`;
  return `<${shortenTagLabel(element.tagName.trim().toLowerCase() || 'element')}>`;
}

function basenameFromPath(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}

export function formatCodeAgentPickedElementSourceLabel(element: CodeAgentPickedElementPayload): string | null {
  const source = element.source;
  if (!source?.fileName) return null;
  const base = basenameFromPath(source.fileName);
  return source.lineNumber === null ? base : `${base}:${source.lineNumber}`;
}

export function formatCodeAgentPreviewAnnotationLabel(annotation: CodeAgentPreviewAnnotationContext): string {
  const title = annotation.pageTitle?.trim() || annotation.pageUrl.trim() || 'Preview';
  const firstElement = annotation.elements[0]?.element;
  const elementLabel = firstElement ? formatCodeAgentPickedElementLabel(firstElement) : null;
  return elementLabel ? `${title} ${elementLabel}` : title;
}

function buildSingleElementContextLines(element: CodeAgentPickedElementPayload): string[] {
  const label = formatCodeAgentPickedElementLabel(element);
  const source = formatCodeAgentPickedElementSourceLabel(element);
  const lines = [`- ${source ? `${label} (${source})` : label}:`];
  if (element.pageUrl.trim()) {
    lines.push(`  url: ${element.pageUrl.trim()}`);
  }
  if (element.selector?.trim()) {
    lines.push(`  selector: ${element.selector.trim()}`);
  }
  if (element.source?.fileName) {
    const { fileName, lineNumber, columnNumber } = element.source;
    const location = lineNumber !== null
      ? `${fileName}:${lineNumber}${columnNumber !== null ? `:${columnNumber}` : ''}`
      : fileName;
    lines.push(`  source: ${location}`);
  }
  const html = element.htmlPreview.trim();
  if (html) {
    lines.push('  html:');
    lines.push(...html.split('\n').map((line) => `    ${line}`));
  }
  const styles = element.styles.trim();
  if (styles) {
    lines.push('  styles:');
    lines.push(...styles.split('\n').map((line) => `    ${line}`));
  }
  return lines;
}

function buildElementContextBlock(elements: readonly CodeAgentPreviewAnnotationElementTarget[]): string {
  if (elements.length === 0) return '';
  const lines: string[] = [];
  elements.forEach((target, index) => {
    lines.push(...buildSingleElementContextLines(target.element));
    if (index < elements.length - 1) {
      lines.push('');
    }
  });
  return ['<element_context>', ...lines, '</element_context>'].join('\n');
}

export function buildCodeAgentPreviewAnnotationPrompt(annotation: CodeAgentPreviewAnnotationContext): string {
  const lines = ['Preview annotation:'];
  lines.push(`Id: ${annotation.id}`);
  const title = annotation.pageTitle?.trim() || annotation.pageUrl.trim() || 'Preview';
  lines.push(`Page: ${title}`);
  if (annotation.comment.trim()) {
    lines.push(`Comment: ${annotation.comment.trim()}`);
  }
  const targets: string[] = [];
  if (annotation.elements.length > 0) {
    targets.push(`${annotation.elements.length} selected element${annotation.elements.length === 1 ? '' : 's'}`);
  }
  if (annotation.regions.length > 0) {
    targets.push(`${annotation.regions.length} marked region${annotation.regions.length === 1 ? '' : 's'}`);
  }
  if (annotation.strokes.length > 0) {
    targets.push(`${annotation.strokes.length} drawing${annotation.strokes.length === 1 ? '' : 's'}`);
  }
  if (targets.length > 0) {
    lines.push(`Targets: ${targets.join(', ')}.`);
  }
  if (annotation.styleChanges.length > 0) {
    lines.push('Requested visual changes:');
    for (const change of annotation.styleChanges) {
      lines.push(`- ${change.property}: ${change.previousValue || '(unset)'} -> ${change.value}`);
    }
  }
  if (annotation.screenshot) {
    lines.push('The attached screenshot is the annotated preview crop.');
  }
  const elementBlock = buildElementContextBlock(annotation.elements);
  if (elementBlock) {
    lines.push(elementBlock);
  }
  return ['<preview_annotation>', ...lines, '</preview_annotation>'].join('\n');
}

export function appendPreviewAnnotationsToPrompt(
  prompt: string,
  annotations: readonly CodeAgentPreviewAnnotationContext[],
): string {
  const blocks = annotations.map(buildCodeAgentPreviewAnnotationPrompt);
  if (blocks.length === 0) return prompt;
  const trimmedPrompt = prompt.trim();
  return trimmedPrompt.length > 0
    ? `${trimmedPrompt}\n\n${blocks.join('\n\n')}`
    : blocks.join('\n\n');
}
