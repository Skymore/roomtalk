import {
  CODE_AGENT_PREVIEW_VIEWPORT_MAX_AREA,
  CODE_AGENT_PREVIEW_VIEWPORT_MAX_DIMENSION,
  CODE_AGENT_PREVIEW_VIEWPORT_MIN_DIMENSION,
  type CodeAgentPreviewViewportSetting,
  type CodeAgentPreviewViewportSize,
  normalizeCodeAgentPreviewViewportDimension,
} from './codeAgentPreviewViewport';

export interface CodeAgentBrowserViewportLayout {
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly viewportX: number;
  readonly viewportY: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly viewportScale: number;
  readonly fillsPanel: boolean;
}

export const CODE_AGENT_BROWSER_DEVICE_TOOLBAR_HEIGHT = 32;
export const CODE_AGENT_BROWSER_VIEWPORT_RESIZE_RAIL_SIZE = 10;

export type CodeAgentBrowserViewportResizeDirection =
  | 'north'
  | 'northeast'
  | 'east'
  | 'southeast'
  | 'south'
  | 'southwest'
  | 'west'
  | 'northwest';

export const codeAgentBrowserViewportSettingKey = (
  setting: CodeAgentPreviewViewportSetting,
): string => (
  setting._tag === 'fill'
    ? 'fill'
    : `${setting._tag}:${setting.width}:${setting.height}:${
      setting._tag === 'preset' ? setting.presetId : ''
    }`
);

const normalizeZoomFactor = (zoomFactor: number): number => (
  Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
);

export function resolveCodeAgentBrowserDeviceViewportArea(container: {
  readonly width: number;
  readonly height: number;
}): CodeAgentPreviewViewportSize {
  return {
    width: Math.max(1, container.width - CODE_AGENT_BROWSER_VIEWPORT_RESIZE_RAIL_SIZE * 2),
    height: Math.max(
      1,
      container.height
        - CODE_AGENT_BROWSER_DEVICE_TOOLBAR_HEIGHT
        - CODE_AGENT_BROWSER_VIEWPORT_RESIZE_RAIL_SIZE,
    ),
  };
}

export function resolveCodeAgentBrowserViewportLayout(
  container: { readonly width: number; readonly height: number },
  setting: CodeAgentPreviewViewportSetting,
  zoomFactor = 1,
): CodeAgentBrowserViewportLayout {
  const containerWidth = Math.max(1, Math.round(container.width));
  const containerHeight = Math.max(1, Math.round(container.height));
  if (setting._tag === 'fill') {
    return {
      canvasWidth: containerWidth,
      canvasHeight: containerHeight,
      viewportX: 0,
      viewportY: 0,
      viewportWidth: containerWidth,
      viewportHeight: containerHeight,
      viewportScale: 1,
      fillsPanel: true,
    };
  }
  const normalizedZoomFactor = normalizeZoomFactor(zoomFactor);
  const renderedWidth = setting.width * normalizedZoomFactor;
  const renderedHeight = setting.height * normalizedZoomFactor;
  const viewportScale = Math.min(
    1,
    containerWidth / renderedWidth,
    containerHeight / renderedHeight,
  );
  const viewportWidth = renderedWidth * viewportScale;
  const viewportHeight = renderedHeight * viewportScale;
  return {
    canvasWidth: containerWidth,
    canvasHeight: containerHeight,
    viewportX: Math.max(0, Math.round((containerWidth - viewportWidth) / 2)),
    viewportY: Math.max(0, Math.round((containerHeight - viewportHeight) / 2)),
    viewportWidth,
    viewportHeight,
    viewportScale,
    fillsPanel: false,
  };
}

export function resolveCodeAgentBrowserDeviceViewportLayout(
  container: { readonly width: number; readonly height: number },
  setting: Exclude<CodeAgentPreviewViewportSetting, { readonly _tag: 'fill' }>,
  zoomFactor = 1,
): CodeAgentBrowserViewportLayout {
  const layout = resolveCodeAgentBrowserViewportLayout(
    resolveCodeAgentBrowserDeviceViewportArea(container),
    setting,
    zoomFactor,
  );
  return {
    ...layout,
    canvasWidth: Math.max(1, Math.round(container.width)),
    canvasHeight: Math.max(1, Math.round(container.height)),
    viewportX: layout.viewportX + CODE_AGENT_BROWSER_VIEWPORT_RESIZE_RAIL_SIZE,
    viewportY: layout.viewportY + CODE_AGENT_BROWSER_DEVICE_TOOLBAR_HEIGHT,
  };
}

const validAspectRatio = (aspectRatio: number | undefined): aspectRatio is number => (
  aspectRatio !== undefined && Number.isFinite(aspectRatio) && aspectRatio > 0
);

function resizeAtAspectRatio(
  desired: number,
  aspectRatio: number,
  primaryAxis: 'width' | 'height',
): CodeAgentPreviewViewportSize {
  if (primaryAxis === 'width') {
    const minimum = Math.ceil(Math.max(
      CODE_AGENT_PREVIEW_VIEWPORT_MIN_DIMENSION,
      CODE_AGENT_PREVIEW_VIEWPORT_MIN_DIMENSION * aspectRatio,
    ));
    const maximum = Math.floor(Math.min(
      CODE_AGENT_PREVIEW_VIEWPORT_MAX_DIMENSION,
      CODE_AGENT_PREVIEW_VIEWPORT_MAX_DIMENSION * aspectRatio,
      Math.sqrt(CODE_AGENT_PREVIEW_VIEWPORT_MAX_AREA * aspectRatio),
    ));
    let width = Math.min(maximum, Math.max(minimum, Math.round(desired)));
    let height = Math.round(width / aspectRatio);
    while (width * height > CODE_AGENT_PREVIEW_VIEWPORT_MAX_AREA && width > minimum) {
      width -= 1;
      height = Math.round(width / aspectRatio);
    }
    return { width, height };
  }

  const minimum = Math.ceil(Math.max(
    CODE_AGENT_PREVIEW_VIEWPORT_MIN_DIMENSION,
    CODE_AGENT_PREVIEW_VIEWPORT_MIN_DIMENSION / aspectRatio,
  ));
  const maximum = Math.floor(Math.min(
    CODE_AGENT_PREVIEW_VIEWPORT_MAX_DIMENSION,
    CODE_AGENT_PREVIEW_VIEWPORT_MAX_DIMENSION / aspectRatio,
    Math.sqrt(CODE_AGENT_PREVIEW_VIEWPORT_MAX_AREA / aspectRatio),
  ));
  let height = Math.min(maximum, Math.max(minimum, Math.round(desired)));
  let width = Math.round(height * aspectRatio);
  while (width * height > CODE_AGENT_PREVIEW_VIEWPORT_MAX_AREA && height > minimum) {
    height -= 1;
    width = Math.round(height * aspectRatio);
  }
  return { width, height };
}

export function resizeCodeAgentFreeformViewport(
  start: CodeAgentPreviewViewportSize,
  delta: { readonly x: number; readonly y: number },
  zoomFactor = 1,
  direction: CodeAgentBrowserViewportResizeDirection = 'southeast',
  aspectRatio?: number,
): CodeAgentPreviewViewportSize {
  const normalizedZoomFactor = normalizeZoomFactor(zoomFactor);
  const horizontalDelta = direction.includes('east')
    ? delta.x
    : direction.includes('west')
      ? -delta.x
      : 0;
  const verticalDelta = direction.includes('south')
    ? delta.y
    : direction.includes('north')
      ? -delta.y
      : 0;
  const desiredWidth = start.width + horizontalDelta / normalizedZoomFactor;
  const desiredHeight = start.height + verticalDelta / normalizedZoomFactor;
  if (validAspectRatio(aspectRatio)) {
    const controlsWidth = horizontalDelta !== 0 || direction === 'east' || direction === 'west';
    const controlsHeight = verticalDelta !== 0 || direction === 'north' || direction === 'south';
    const primaryAxis = controlsWidth && !controlsHeight
      ? 'width'
      : controlsHeight && !controlsWidth
        ? 'height'
        : Math.abs(desiredWidth - start.width) / start.width
          >= Math.abs(desiredHeight - start.height) / start.height
          ? 'width'
          : 'height';
    return resizeAtAspectRatio(
      primaryAxis === 'width' ? desiredWidth : desiredHeight,
      aspectRatio,
      primaryAxis,
    );
  }
  let width = normalizeCodeAgentPreviewViewportDimension(desiredWidth);
  let height = normalizeCodeAgentPreviewViewportDimension(desiredHeight);
  if (width * height <= CODE_AGENT_PREVIEW_VIEWPORT_MAX_AREA) {
    return { width, height };
  }
  if (Math.abs(horizontalDelta) >= Math.abs(verticalDelta)) {
    width = Math.max(
      CODE_AGENT_PREVIEW_VIEWPORT_MIN_DIMENSION,
      Math.floor(CODE_AGENT_PREVIEW_VIEWPORT_MAX_AREA / height),
    );
  } else {
    height = Math.max(
      CODE_AGENT_PREVIEW_VIEWPORT_MIN_DIMENSION,
      Math.floor(CODE_AGENT_PREVIEW_VIEWPORT_MAX_AREA / width),
    );
  }
  return { width, height };
}

const resizeFromEndRail = (start: number, pointerDelta: number, available: number): number => {
  const startEdge = start < available ? (available + start) / 2 : start;
  const targetEdge = startEdge + pointerDelta;
  return targetEdge <= available ? targetEdge * 2 - available : targetEdge;
};

const resizeFromStartRail = (start: number, pointerDelta: number, available: number): number => {
  if (start > available) {
    const distanceToFit = start - available;
    return pointerDelta <= distanceToFit
      ? start - pointerDelta
      : available - (pointerDelta - distanceToFit) * 2;
  }
  const targetEdge = (available - start) / 2 + pointerDelta;
  return targetEdge >= 0 ? available - targetEdge * 2 : available - targetEdge;
};

export function resizeCodeAgentBrowserViewportFromRail(
  start: CodeAgentPreviewViewportSize,
  pointerDelta: { readonly x: number; readonly y: number },
  available: CodeAgentPreviewViewportSize,
  zoomFactor = 1,
  direction: CodeAgentBrowserViewportResizeDirection = 'southeast',
  aspectRatio?: number,
): CodeAgentPreviewViewportSize {
  const normalizedZoomFactor = normalizeZoomFactor(zoomFactor);
  const startWidth = start.width * normalizedZoomFactor;
  const startHeight = start.height * normalizedZoomFactor;
  const desiredWidth = direction.includes('east')
    ? resizeFromEndRail(startWidth, pointerDelta.x, available.width)
    : direction.includes('west')
      ? resizeFromStartRail(startWidth, pointerDelta.x, available.width)
      : startWidth;
  const desiredHeight = direction.includes('south')
    ? resizeFromEndRail(startHeight, pointerDelta.y, available.height)
    : direction.includes('north')
      ? resizeFromStartRail(startHeight, pointerDelta.y, available.height)
      : startHeight;
  const widthDelta = desiredWidth - startWidth;
  const heightDelta = desiredHeight - startHeight;
  return resizeCodeAgentFreeformViewport(
    start,
    {
      x: direction.includes('west') ? -widthDelta : widthDelta,
      y: direction.includes('north') ? -heightDelta : heightDelta,
    },
    normalizedZoomFactor,
    direction,
    aspectRatio,
  );
}

export function resolveResponsiveCodeAgentBrowserViewportSize(
  container: { readonly width: number; readonly height: number },
  zoomFactor = 1,
): CodeAgentPreviewViewportSize {
  const area = resolveCodeAgentBrowserDeviceViewportArea(container);
  const normalizedZoomFactor = normalizeZoomFactor(zoomFactor);
  return resizeCodeAgentFreeformViewport(
    {
      width: area.width / normalizedZoomFactor,
      height: area.height / normalizedZoomFactor,
    },
    { x: 0, y: 0 },
  );
}
