import {
  onCodeWorkspacePreviewAutomationEvent,
  onSocketConnected,
  requestConnectCodeWorkspacePreviewAutomation,
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
] as const satisfies readonly CodeWorkspacePreviewAutomationOperation[];

export type CodeWorkspacePreviewAutomationHandler = (
  request: CodeWorkspacePreviewAutomationRequest,
) => Promise<unknown> | unknown;

export type CodeWorkspacePreviewAutomationHostController = {
  host: CodeWorkspacePreviewAutomationHost;
  setFocused: (focused: boolean) => Promise<CodeWorkspacePreviewAutomationHost>;
  dispose: () => void;
};

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

function serializePreviewAutomationError(error: unknown): NonNullable<CodeWorkspacePreviewAutomationResponse['error']> {
  if (error instanceof Error) {
    return {
      _tag: error.name || 'PreviewAutomationExecutionError',
      message: error.message,
    };
  }
  return {
    _tag: 'PreviewAutomationExecutionError',
    message: typeof error === 'string' ? error : 'Workspace preview automation failed',
  };
}

export async function connectCodeWorkspacePreviewAutomationHost({
  roomId,
  focused = typeof document === 'undefined' ? true : document.hasFocus(),
  supportedOperations = CODE_WORKSPACE_PREVIEW_AUTOMATION_SESSION_OPERATIONS,
  handle,
}: {
  roomId: string;
  focused?: boolean;
  supportedOperations?: readonly CodeWorkspacePreviewAutomationOperation[];
  handle: CodeWorkspacePreviewAutomationHandler;
}): Promise<CodeWorkspacePreviewAutomationHostController> {
  let currentHost = validateCodeWorkspacePreviewAutomationHost(
    await requestConnectCodeWorkspacePreviewAutomation({
      roomId,
      focused,
      supportedOperations: [...supportedOperations],
    }),
  );
  let disposed = false;
  const reconnect = async () => {
    currentHost = validateCodeWorkspacePreviewAutomationHost(
      await requestConnectCodeWorkspacePreviewAutomation({
        roomId,
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
    void Promise.resolve()
      .then(() => handle(event.request))
      .then(
        (result) => requestRespondCodeWorkspacePreviewAutomation({
          roomId,
          connectionId: host.connectionId,
          requestId: event.request.requestId,
          ok: true,
          ...(result === undefined ? {} : { result }),
        }),
        (error) => requestRespondCodeWorkspacePreviewAutomation({
          roomId,
          connectionId: host.connectionId,
          requestId: event.request.requestId,
          ok: false,
          error: serializePreviewAutomationError(error),
        }),
      )
      .catch(() => undefined);
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
      disposed = true;
      unsubscribe();
      unsubscribeReconnect();
    },
  };
}
