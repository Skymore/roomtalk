import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  CodeWorkspacePreviewAutomationError,
  connectCodeWorkspacePreviewAutomationHost,
  runCodeWorkspacePreviewAutomationRequest,
  validateCodeWorkspacePreviewAutomationHost,
  validateCodeWorkspacePreviewAutomationResponse,
} from './codeWorkspacePreviewAutomation';
import type { CodeWorkspacePreviewAutomationEvent } from './socket';

const connectMock = vi.hoisted(() => vi.fn());
const disconnectMock = vi.hoisted(() => vi.fn());
const focusMock = vi.hoisted(() => vi.fn());
const requestMock = vi.hoisted(() => vi.fn());
const respondMock = vi.hoisted(() => vi.fn());
const eventCallbacks = vi.hoisted(() => new Set<(event: CodeWorkspacePreviewAutomationEvent) => void>());
const connectCallbacks = vi.hoisted(() => new Set<() => void>());

vi.mock('./socket', () => ({
  requestCodeWorkspacePreviewAutomation: requestMock,
  requestConnectCodeWorkspacePreviewAutomation: connectMock,
  requestDisconnectCodeWorkspacePreviewAutomation: disconnectMock,
  requestFocusCodeWorkspacePreviewAutomation: focusMock,
  requestRespondCodeWorkspacePreviewAutomation: respondMock,
  onSocketConnected: (callback: () => void) => {
    connectCallbacks.add(callback);
    return () => {
      connectCallbacks.delete(callback);
    };
  },
  onCodeWorkspacePreviewAutomationEvent: (callback: (event: CodeWorkspacePreviewAutomationEvent) => void) => {
    eventCallbacks.add(callback);
    return () => {
      eventCallbacks.delete(callback);
    };
  },
}));

const host = {
  roomId: 'room-1',
  clientId: 'client-1',
  connectionId: 'automation-1',
  socketId: 'socket-1',
  focused: true,
  supportedOperations: ['status', 'navigate'],
  connectedAt: '2026-05-03T10:00:00.000Z',
  updatedAt: '2026-05-03T10:00:00.000Z',
};
const tabHost = {
  ...host,
  tabId: 'browser:preview',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('codeWorkspacePreviewAutomation', () => {
  beforeEach(() => {
    eventCallbacks.clear();
    connectCallbacks.clear();
    connectMock.mockReset();
    disconnectMock.mockReset();
    focusMock.mockReset();
    requestMock.mockReset();
    respondMock.mockReset();
    connectMock.mockResolvedValue(host);
    disconnectMock.mockResolvedValue(undefined);
    focusMock.mockResolvedValue({ ...host, focused: false });
    respondMock.mockResolvedValue({
      clientId: 'client-1',
      connectionId: 'automation-1',
      requestId: 'request-1',
      ok: true,
    });
    requestMock.mockResolvedValue({
      clientId: 'client-1',
      connectionId: 'automation-1',
      requestId: 'request-1',
      ok: true,
      result: { screenshot: { mimeType: 'image/png', data: 'cG5n', width: 10, height: 10 } },
    });
  });

  it('validates automation host and response payloads', () => {
    expect(validateCodeWorkspacePreviewAutomationHost(host)).toEqual(host);
    expect(validateCodeWorkspacePreviewAutomationHost(tabHost)).toEqual(tabHost);
    expect(validateCodeWorkspacePreviewAutomationResponse({
      clientId: 'client-1',
      connectionId: 'automation-1',
      requestId: 'request-1',
      ok: false,
      error: { _tag: 'PreviewAutomationExecutionError', message: 'failed' },
    })).toEqual({
      clientId: 'client-1',
      connectionId: 'automation-1',
      requestId: 'request-1',
      ok: false,
      error: { _tag: 'PreviewAutomationExecutionError', message: 'failed' },
    });
  });

  it('runs preview automation requests through the socket response contract', async () => {
    await expect(runCodeWorkspacePreviewAutomationRequest({
      roomId: 'room-1',
      tabId: 'tab-1',
      operation: 'snapshot',
      input: {},
      timeoutMs: 5000,
    })).resolves.toEqual({
      screenshot: { mimeType: 'image/png', data: 'cG5n', width: 10, height: 10 },
    });
    expect(requestMock).toHaveBeenCalledWith({
      roomId: 'room-1',
      tabId: 'tab-1',
      operation: 'snapshot',
      input: {},
      timeoutMs: 5000,
    });

    requestMock.mockResolvedValueOnce({
      clientId: 'client-1',
      connectionId: 'automation-1',
      requestId: 'request-2',
      ok: false,
      error: {
        _tag: 'PreviewAutomationTabNotFoundError',
        message: 'no frame',
        detail: { tabId: 'browser:missing' },
      },
    });
    await expect(runCodeWorkspacePreviewAutomationRequest({
      roomId: 'room-1',
      operation: 'snapshot',
    })).rejects.toMatchObject({
      name: 'PreviewAutomationTabNotFoundError',
      _tag: 'PreviewAutomationTabNotFoundError',
      message: 'no frame',
      detail: { tabId: 'browser:missing' },
    } satisfies Partial<CodeWorkspacePreviewAutomationError>);
  });

  it('responds to matching preview automation requests', async () => {
    const handle = vi.fn().mockResolvedValue({ available: true });
    const controller = await connectCodeWorkspacePreviewAutomationHost({
      roomId: 'room-1',
      handle,
    });

    expect(controller.host.connectionId).toBe('automation-1');
    eventCallbacks.forEach((callback) => callback({
      type: 'request',
      roomId: 'room-1',
      connectionId: 'automation-1',
      createdAt: '2026-05-03T10:00:00.000Z',
      request: {
        requestId: 'request-1',
        roomId: 'room-1',
        operation: 'status',
        input: {},
        timeoutMs: 1000,
      },
    }));

    await vi.waitFor(() => {
      expect(respondMock).toHaveBeenCalledWith({
        roomId: 'room-1',
        connectionId: 'automation-1',
        requestId: 'request-1',
        ok: true,
        result: { available: true },
      });
    });
    expect(handle).toHaveBeenCalledTimes(1);
    controller.dispose();
    expect(disconnectMock).toHaveBeenCalledWith({
      roomId: 'room-1',
      connectionId: 'automation-1',
    });
  });

  it('registers tab-scoped automation hosts across reconnects', async () => {
    connectMock.mockResolvedValue(tabHost);
    const controller = await connectCodeWorkspacePreviewAutomationHost({
      roomId: 'room-1',
      tabId: 'browser:preview',
      focused: true,
      supportedOperations: ['status', 'navigate'],
      handle: () => ({ available: true }),
    });

    expect(controller.host.tabId).toBe('browser:preview');
    expect(connectMock).toHaveBeenCalledWith({
      roomId: 'room-1',
      tabId: 'browser:preview',
      focused: true,
      supportedOperations: ['status', 'navigate'],
    });

    connectCallbacks.forEach((callback) => callback());

    await vi.waitFor(() => {
      expect(connectMock).toHaveBeenCalledTimes(2);
    });
    expect(connectMock).toHaveBeenLastCalledWith(expect.objectContaining({
      roomId: 'room-1',
      tabId: 'browser:preview',
      supportedOperations: ['status', 'navigate'],
    }));
  });

  it('serializes handler failures into automation responses', async () => {
    await connectCodeWorkspacePreviewAutomationHost({
      roomId: 'room-1',
      handle: () => {
        throw new Error('unsupported');
      },
    });

    eventCallbacks.forEach((callback) => callback({
      type: 'request',
      roomId: 'room-1',
      connectionId: 'automation-1',
      createdAt: '2026-05-03T10:00:00.000Z',
      request: {
        requestId: 'request-1',
        roomId: 'room-1',
        operation: 'click',
        input: {},
        timeoutMs: 1000,
      },
    }));

    await vi.waitFor(() => {
      expect(respondMock).toHaveBeenCalledWith({
        roomId: 'room-1',
        connectionId: 'automation-1',
        requestId: 'request-1',
        ok: false,
        error: {
          _tag: 'PreviewAutomationExecutionError',
          message: 'unsupported',
          detail: {
            requestId: 'request-1',
            operation: 'click',
            roomId: 'room-1',
            tabId: null,
          },
        },
      });
    });
  });

  it('preserves typed preview automation errors in host responses', async () => {
    const typedError = Object.assign(
      new Error('Preview automation type request request-1 requires an editable target in tab browser:preview.'),
      {
        _tag: 'PreviewAutomationTargetNotEditableError',
        detail: {
          requestId: 'request-1',
          operation: 'type',
          roomId: 'room-1',
          tabId: 'browser:preview',
          selectorKind: 'selector',
          selectorLength: 7,
        },
      },
    );

    await connectCodeWorkspacePreviewAutomationHost({
      roomId: 'room-1',
      handle: () => {
        throw typedError;
      },
    });

    eventCallbacks.forEach((callback) => callback({
      type: 'request',
      roomId: 'room-1',
      connectionId: 'automation-1',
      createdAt: '2026-05-03T10:00:00.000Z',
      request: {
        requestId: 'request-1',
        roomId: 'room-1',
        tabId: 'browser:preview',
        operation: 'type',
        input: { selector: '#submit', text: 'hello' },
        timeoutMs: 1000,
      },
    }));

    await vi.waitFor(() => {
      expect(respondMock).toHaveBeenCalledWith({
        roomId: 'room-1',
        connectionId: 'automation-1',
        requestId: 'request-1',
        ok: false,
        error: {
          _tag: 'PreviewAutomationTargetNotEditableError',
          message: 'Preview automation type request request-1 requires an editable target in tab browser:preview.',
          detail: {
            requestId: 'request-1',
            operation: 'type',
            roomId: 'room-1',
            tabId: 'browser:preview',
            selectorKind: 'selector',
            selectorLength: 7,
          },
        },
      });
    });
  });

  it('reconnects the automation host after a socket reconnect', async () => {
    await connectCodeWorkspacePreviewAutomationHost({
      roomId: 'room-1',
      handle: () => ({ available: true }),
    });

    expect(connectMock).toHaveBeenCalledTimes(1);
    connectCallbacks.forEach((callback) => callback());

    await vi.waitFor(() => {
      expect(connectMock).toHaveBeenCalledTimes(2);
    });
  });

  it('suppresses stale automation responses after the host reconnects', async () => {
    const pendingRequest = deferred<unknown>();
    const handle = vi.fn(() => pendingRequest.promise);
    connectMock
      .mockResolvedValueOnce(host)
      .mockResolvedValueOnce({
        ...host,
        connectionId: 'automation-2',
        updatedAt: '2026-05-03T10:00:01.000Z',
      });

    await connectCodeWorkspacePreviewAutomationHost({
      roomId: 'room-1',
      handle,
    });

    eventCallbacks.forEach((callback) => callback({
      type: 'request',
      roomId: 'room-1',
      connectionId: 'automation-1',
      createdAt: '2026-05-03T10:00:00.000Z',
      request: {
        requestId: 'request-stale',
        roomId: 'room-1',
        operation: 'status',
        input: {},
        timeoutMs: 1000,
      },
    }));
    expect(handle).toHaveBeenCalledTimes(1);

    connectCallbacks.forEach((callback) => callback());
    await vi.waitFor(() => {
      expect(connectMock).toHaveBeenCalledTimes(2);
    });
    pendingRequest.resolve({ available: true });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(respondMock).not.toHaveBeenCalledWith(expect.objectContaining({
      connectionId: 'automation-1',
      requestId: 'request-stale',
    }));
  });

  it('suppresses stale automation responses after dispose', async () => {
    const pendingRequest = deferred<unknown>();
    const handle = vi.fn(() => pendingRequest.promise);

    const controller = await connectCodeWorkspacePreviewAutomationHost({
      roomId: 'room-1',
      handle,
    });

    eventCallbacks.forEach((callback) => callback({
      type: 'request',
      roomId: 'room-1',
      connectionId: 'automation-1',
      createdAt: '2026-05-03T10:00:00.000Z',
      request: {
        requestId: 'request-disposed',
        roomId: 'room-1',
        operation: 'status',
        input: {},
        timeoutMs: 1000,
      },
    }));
    controller.dispose();
    pendingRequest.resolve({ available: true });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(disconnectMock).toHaveBeenCalledWith({
      roomId: 'room-1',
      connectionId: 'automation-1',
    });
    expect(respondMock).not.toHaveBeenCalledWith(expect.objectContaining({
      connectionId: 'automation-1',
      requestId: 'request-disposed',
    }));
  });
});
