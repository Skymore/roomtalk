import {
  onCodeWorkspacePreviewEvent,
  requestCloseCodeWorkspacePreviewSession,
  requestCodeWorkspacePreviewSessions,
  requestNavigateCodeWorkspacePreviewSession,
  requestOpenCodeWorkspacePreviewSession,
  requestRefreshCodeWorkspacePreviewSession,
  requestReportCodeWorkspacePreviewSession,
  requestResolveCodeWorkspacePreviewTarget,
  requestResizeCodeWorkspacePreviewSession,
  type CodeWorkspacePreviewEvent,
  type CodeWorkspacePreviewNavigationTarget,
  type CodeWorkspacePreviewResolvedTarget,
} from './socket';
import {
  FILL_CODE_AGENT_PREVIEW_VIEWPORT,
  coerceCodeAgentPreviewViewportSetting,
  type CodeAgentPreviewViewportSetting,
} from './codeAgentPreviewViewport';

export type CodeWorkspacePreviewNavStatus =
  | { _tag: 'Idle' }
  | { _tag: 'Loading'; url: string; title: string }
  | { _tag: 'Success'; url: string; title: string }
  | { _tag: 'LoadFailed'; url: string; title: string; code: number; description: string };

export interface CodeWorkspacePreviewSession {
  roomId: string;
  tabId: string;
  navStatus: CodeWorkspacePreviewNavStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  viewport: CodeAgentPreviewViewportSetting;
  renderedViewport?: { width: number; height: number };
  updatedAt: string;
}

export type CodeWorkspacePreviewSessionEvent = Omit<CodeWorkspacePreviewEvent, 'snapshot'> & {
  snapshot?: CodeWorkspacePreviewSession;
};

const validatePreviewUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith('/api/coco/workspace-assets/')) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};

const validateNavStatus = (value: unknown): CodeWorkspacePreviewNavStatus => {
  if (!value || typeof value !== 'object') {
    return { _tag: 'Idle' };
  }
  const status = value as Partial<CodeWorkspacePreviewNavStatus>;
  if (status._tag === 'Idle') {
    return { _tag: 'Idle' };
  }
  if (status._tag === 'Loading' || status._tag === 'Success' || status._tag === 'LoadFailed') {
    const url = validatePreviewUrl((value as { url?: unknown }).url);
    if (!url) {
      return { _tag: 'Idle' };
    }
    const title = typeof (value as { title?: unknown }).title === 'string'
      ? (value as { title: string }).title
      : '';
    if (status._tag === 'LoadFailed') {
      const code = Number((value as { code?: unknown }).code);
      const description = typeof (value as { description?: unknown }).description === 'string'
        ? (value as { description: string }).description
        : 'Preview failed';
      return {
        _tag: 'LoadFailed',
        url,
        title,
        code: Number.isFinite(code) ? Math.trunc(code) : 0,
        description,
      };
    }
    return { _tag: status._tag, url, title };
  }
  return { _tag: 'Idle' };
};

export const codeWorkspacePreviewUrlFromStatus = (
  status: CodeWorkspacePreviewNavStatus,
): string | null => (
  status._tag === 'Idle' ? null : status.url
);

export const validateCodeWorkspacePreviewSession = (
  value: unknown,
): CodeWorkspacePreviewSession => {
  if (!value || typeof value !== 'object') {
    throw new Error('Workspace preview session response is invalid');
  }
  const session = value as Partial<CodeWorkspacePreviewSession>;
  if (typeof session.roomId !== 'string' || typeof session.tabId !== 'string') {
    throw new Error('Workspace preview session response is invalid');
  }
  const renderedViewport = (value as { renderedViewport?: unknown }).renderedViewport;
  const renderedSize = renderedViewport && typeof renderedViewport === 'object'
    && typeof (renderedViewport as { width?: unknown }).width === 'number'
    && typeof (renderedViewport as { height?: unknown }).height === 'number'
    ? {
      width: (renderedViewport as { width: number }).width,
      height: (renderedViewport as { height: number }).height,
    }
    : undefined;
  return {
    roomId: session.roomId,
    tabId: session.tabId,
    navStatus: validateNavStatus((value as { navStatus?: unknown }).navStatus),
    canGoBack: session.canGoBack === true,
    canGoForward: session.canGoForward === true,
    viewport: coerceCodeAgentPreviewViewportSetting((value as { viewport?: unknown }).viewport)
      ?? FILL_CODE_AGENT_PREVIEW_VIEWPORT,
    ...(renderedSize ? { renderedViewport: renderedSize } : {}),
    updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : new Date(0).toISOString(),
  };
};

export const validateCodeWorkspacePreviewResolvedTarget = (
  value: unknown,
): CodeWorkspacePreviewResolvedTarget => {
  if (!value || typeof value !== 'object') {
    throw new Error('Workspace preview target response is invalid');
  }
  const target = value as Partial<CodeWorkspacePreviewResolvedTarget>;
  if (
    typeof target.requestedUrl !== 'string'
    || typeof target.resolvedUrl !== 'string'
    || (target.resolutionKind !== 'direct' && target.resolutionKind !== 'e2b-port-host')
  ) {
    throw new Error('Workspace preview target response is invalid');
  }
  return {
    requestedUrl: target.requestedUrl,
    resolvedUrl: target.resolvedUrl,
    resolutionKind: target.resolutionKind,
  };
};

export const resolveCodeWorkspacePreviewTarget = async (payload: {
  roomId: string;
  target: CodeWorkspacePreviewNavigationTarget;
}): Promise<CodeWorkspacePreviewResolvedTarget> => (
  validateCodeWorkspacePreviewResolvedTarget(await requestResolveCodeWorkspacePreviewTarget(payload))
);

export const openCodeWorkspacePreviewSession = async (payload: {
  roomId: string;
  tabId?: string;
  url?: string | null;
  title?: string;
  viewport?: CodeAgentPreviewViewportSetting;
}): Promise<CodeWorkspacePreviewSession> => (
  validateCodeWorkspacePreviewSession(await requestOpenCodeWorkspacePreviewSession(payload))
);

export const navigateCodeWorkspacePreviewSession = async (payload: {
  roomId: string;
  tabId: string;
  url: string;
  title?: string;
}): Promise<CodeWorkspacePreviewSession> => (
  validateCodeWorkspacePreviewSession(await requestNavigateCodeWorkspacePreviewSession(payload))
);

export const resizeCodeWorkspacePreviewSession = async (payload: {
  roomId: string;
  tabId: string;
  viewport: CodeAgentPreviewViewportSetting;
}): Promise<CodeWorkspacePreviewSession> => (
  validateCodeWorkspacePreviewSession(await requestResizeCodeWorkspacePreviewSession(payload))
);

export const reportCodeWorkspacePreviewSession = async (payload: {
  roomId: string;
  tabId: string;
  navStatus: CodeWorkspacePreviewNavStatus;
  renderedViewport?: { width: number; height: number };
}): Promise<CodeWorkspacePreviewSession> => (
  validateCodeWorkspacePreviewSession(await requestReportCodeWorkspacePreviewSession(payload))
);

export const refreshCodeWorkspacePreviewSession = async (payload: {
  roomId: string;
  tabId: string;
}): Promise<CodeWorkspacePreviewSession> => (
  validateCodeWorkspacePreviewSession(await requestRefreshCodeWorkspacePreviewSession(payload))
);

export const listCodeWorkspacePreviewSessions = async (
  roomId: string,
): Promise<CodeWorkspacePreviewSession[]> => (
  (await requestCodeWorkspacePreviewSessions(roomId)).map(validateCodeWorkspacePreviewSession)
);

export const closeCodeWorkspacePreviewSession = async (payload: {
  roomId: string;
  tabId?: string;
}): Promise<CodeWorkspacePreviewSession[]> => (
  (await requestCloseCodeWorkspacePreviewSession(payload)).map(validateCodeWorkspacePreviewSession)
);

export const subscribeCodeWorkspacePreviewEvents = (
  roomId: string,
  callback: (event: CodeWorkspacePreviewSessionEvent) => void,
) => onCodeWorkspacePreviewEvent((event) => {
  if (event.roomId !== roomId) {
    return;
  }
  callback({
    ...event,
    snapshot: event.snapshot ? validateCodeWorkspacePreviewSession(event.snapshot) : undefined,
  });
});
