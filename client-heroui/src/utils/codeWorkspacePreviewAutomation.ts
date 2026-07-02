import {
  onCodeWorkspacePreviewAutomationEvent,
  onSocketConnected,
  requestCodeWorkspacePreviewAutomation,
  requestConnectCodeWorkspacePreviewAutomation,
  requestDisconnectCodeWorkspacePreviewAutomation,
  requestFocusCodeWorkspacePreviewAutomation,
  requestRespondCodeWorkspacePreviewAutomation,
  type CodeWorkspacePreviewAutomationEvent,
  type CodeWorkspacePreviewAutomationHost,
  type CodeWorkspacePreviewAutomationOperation,
  type CodeWorkspacePreviewAutomationRequest,
  type CodeWorkspacePreviewAutomationResponse,
} from './socket';

export type { CodeWorkspacePreviewAutomationRequest } from './socket';

export const CODE_WORKSPACE_PREVIEW_AUTOMATION_SESSION_OPERATIONS = [
  'status',
  'open',
  'navigate',
  'resize',
] as const satisfies readonly CodeWorkspacePreviewAutomationOperation[];

export const CODE_WORKSPACE_PREVIEW_AUTOMATION_CLOUD_BROWSER_OPERATIONS = [
  ...CODE_WORKSPACE_PREVIEW_AUTOMATION_SESSION_OPERATIONS,
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

export type CodeWorkspacePreviewAutomationHandler = (
  request: CodeWorkspacePreviewAutomationRequest,
) => Promise<unknown> | unknown;

export type CodeWorkspacePreviewAutomationHostController = {
  host: CodeWorkspacePreviewAutomationHost;
  setFocused: (focused: boolean) => Promise<CodeWorkspacePreviewAutomationHost>;
  dispose: () => void;
};

export class CodeWorkspacePreviewAutomationError extends Error {
  readonly _tag: string;
  readonly detail?: unknown;

  constructor(error: NonNullable<CodeWorkspacePreviewAutomationResponse['error']>) {
    super(error.message || 'Workspace preview automation failed');
    this.name = error._tag || 'PreviewAutomationExecutionError';
    this._tag = this.name;
    if (Object.prototype.hasOwnProperty.call(error, 'detail')) {
      this.detail = error.detail;
    }
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null
);

export function validateCodeWorkspacePreviewAutomationHost(
  value: unknown,
): CodeWorkspacePreviewAutomationHost {
  if (!isObject(value)) {
    throw new Error('Workspace preview automation host response is invalid');
  }
  const operations = Array.isArray(value.supportedOperations)
    ? value.supportedOperations.filter((operation): operation is CodeWorkspacePreviewAutomationOperation => (
      typeof operation === 'string'
    ))
    : [];
  if (
    typeof value.roomId !== 'string'
    || typeof value.clientId !== 'string'
    || typeof value.connectionId !== 'string'
    || typeof value.socketId !== 'string'
  ) {
    throw new Error('Workspace preview automation host response is invalid');
  }
  return {
    roomId: value.roomId,
    clientId: value.clientId,
    connectionId: value.connectionId,
    socketId: value.socketId,
    ...(typeof value.tabId === 'string' && value.tabId.trim() ? { tabId: value.tabId } : {}),
    focused: value.focused === true,
    supportedOperations: operations,
    connectedAt: typeof value.connectedAt === 'string' ? value.connectedAt : new Date(0).toISOString(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
  };
}

export function validateCodeWorkspacePreviewAutomationResponse(
  value: unknown,
): CodeWorkspacePreviewAutomationResponse {
  if (!isObject(value)) {
    throw new Error('Workspace preview automation response is invalid');
  }
  if (
    typeof value.clientId !== 'string'
    || typeof value.connectionId !== 'string'
    || typeof value.requestId !== 'string'
  ) {
    throw new Error('Workspace preview automation response is invalid');
  }
  const rawError = isObject(value.error) ? value.error : null;
  return {
    clientId: value.clientId,
    connectionId: value.connectionId,
    requestId: value.requestId,
    ok: value.ok === true,
    ...(Object.prototype.hasOwnProperty.call(value, 'result') ? { result: value.result } : {}),
    ...(rawError && typeof rawError.message === 'string'
      ? {
        error: {
          _tag: typeof rawError._tag === 'string' ? rawError._tag : 'PreviewAutomationExecutionError',
          message: rawError.message,
          ...(Object.prototype.hasOwnProperty.call(rawError, 'detail') ? { detail: rawError.detail } : {}),
        },
      }
      : {}),
  };
}

function previewAutomationRequestDetail(
  request?: CodeWorkspacePreviewAutomationRequest,
): Record<string, unknown> | undefined {
  if (!request) {
    return undefined;
  }
  return {
    requestId: request.requestId,
    operation: request.operation,
    roomId: request.roomId,
    tabId: request.tabId ?? null,
  };
}

function serializePreviewAutomationError(
  error: unknown,
  request?: CodeWorkspacePreviewAutomationRequest,
): NonNullable<CodeWorkspacePreviewAutomationResponse['error']> {
  if (isObject(error) && typeof error._tag === 'string' && typeof error.message === 'string') {
    return {
      _tag: error._tag,
      message: error.message,
      ...(Object.prototype.hasOwnProperty.call(error, 'detail') ? { detail: error.detail } : {}),
    };
  }
  if (error instanceof Error) {
    const structuredError = error as Error & { _tag?: unknown; detail?: unknown };
    const detail = Object.prototype.hasOwnProperty.call(error, 'detail')
      ? structuredError.detail
      : previewAutomationRequestDetail(request);
    return {
      _tag: typeof structuredError._tag === 'string'
        ? structuredError._tag
        : 'PreviewAutomationExecutionError',
      message: error.message,
      ...(detail === undefined ? {} : { detail }),
    };
  }
  const detail = previewAutomationRequestDetail(request);
  return {
    _tag: 'PreviewAutomationExecutionError',
    message: typeof error === 'string' ? error : 'Workspace preview automation failed',
    ...(detail === undefined ? {} : { detail }),
  };
}

export async function runCodeWorkspacePreviewAutomationRequest(payload: {
  roomId: string;
  requestId?: string;
  tabId?: string;
  operation: CodeWorkspacePreviewAutomationOperation;
  input?: unknown;
  timeoutMs?: number;
}): Promise<unknown> {
  const response = validateCodeWorkspacePreviewAutomationResponse(
    await requestCodeWorkspacePreviewAutomation(payload),
  );
  if (!response.ok) {
    throw new CodeWorkspacePreviewAutomationError(response.error ?? {
      _tag: 'PreviewAutomationExecutionError',
      message: 'Workspace preview automation failed',
    });
  }
  return response.result;
}

export async function connectCodeWorkspacePreviewAutomationHost({
  roomId,
  tabId,
  focused = typeof document === 'undefined' ? true : document.hasFocus(),
  supportedOperations = CODE_WORKSPACE_PREVIEW_AUTOMATION_SESSION_OPERATIONS,
  handle,
}: {
  roomId: string;
  tabId?: string;
  focused?: boolean;
  supportedOperations?: readonly CodeWorkspacePreviewAutomationOperation[];
  handle: CodeWorkspacePreviewAutomationHandler;
}): Promise<CodeWorkspacePreviewAutomationHostController> {
  let currentHost = validateCodeWorkspacePreviewAutomationHost(
    await requestConnectCodeWorkspacePreviewAutomation({
      roomId,
      ...(tabId ? { tabId } : {}),
      focused,
      supportedOperations: [...supportedOperations],
    }),
  );
  let disposed = false;
  const reconnect = async () => {
    currentHost = validateCodeWorkspacePreviewAutomationHost(
      await requestConnectCodeWorkspacePreviewAutomation({
        roomId,
        ...(tabId ? { tabId } : {}),
        focused: typeof document === 'undefined' ? true : document.hasFocus(),
        supportedOperations: [...supportedOperations],
      }),
    );
    return currentHost;
  };
  const unsubscribe = onCodeWorkspacePreviewAutomationEvent((event: CodeWorkspacePreviewAutomationEvent) => {
    const host = currentHost;
    if (
      disposed
      || event.roomId !== roomId
      || event.connectionId !== host.connectionId
      || event.type !== 'request'
    ) {
      return;
    }
    void (async () => {
      try {
        const result = await handle(event.request);
        if (disposed || currentHost.connectionId !== host.connectionId) {
          return;
        }
        await requestRespondCodeWorkspacePreviewAutomation({
          roomId,
          connectionId: host.connectionId,
          requestId: event.request.requestId,
          ok: true,
          ...(result === undefined ? {} : { result }),
        });
      } catch (error) {
        if (disposed || currentHost.connectionId !== host.connectionId) {
          return;
        }
        await requestRespondCodeWorkspacePreviewAutomation({
          roomId,
          connectionId: host.connectionId,
          requestId: event.request.requestId,
          ok: false,
          error: serializePreviewAutomationError(error, event.request),
        });
      }
    })().catch(() => undefined);
  });
  const unsubscribeReconnect = onSocketConnected(() => {
    if (disposed) {
      return;
    }
    void reconnect().catch(() => undefined);
  });

  return {
    host: currentHost,
    setFocused: async (nextFocused: boolean) => {
      currentHost = validateCodeWorkspacePreviewAutomationHost(await requestFocusCodeWorkspacePreviewAutomation({
        roomId,
        connectionId: currentHost.connectionId,
        focused: nextFocused,
      }));
      return currentHost;
    },
    dispose: () => {
      const host = currentHost;
      disposed = true;
      unsubscribe();
      unsubscribeReconnect();
      void requestDisconnectCodeWorkspacePreviewAutomation({
        roomId,
        connectionId: host.connectionId,
      }).catch(() => undefined);
    },
  };
}
