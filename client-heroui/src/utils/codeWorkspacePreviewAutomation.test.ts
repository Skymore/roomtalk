import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  connectCodeWorkspacePreviewAutomationHost,
  runCodeWorkspacePreviewAutomationRequest,
  validateCodeWorkspacePreviewAutomationHost,
  validateCodeWorkspacePreviewAutomationResponse,
} from './codeWorkspacePreviewAutomation';
import type { CodeWorkspacePreviewAutomationEvent } from './socket';

const connectMock = vi.hoisted(() => vi.fn());
const focusMock = vi.hoisted(() => vi.fn());
const requestMock = vi.hoisted(() => vi.fn());
const respondMock = vi.hoisted(() => vi.fn());
const eventCallbacks = vi.hoisted(() => new Set<(event: CodeWorkspacePreviewAutomationEvent) => void>());
const connectCallbacks = vi.hoisted(() => new Set<() => void>());

vi.mock('./socket', () => ({
  requestCodeWorkspacePreviewAutomation: requestMock,
  requestConnectCodeWorkspacePreviewAutomation: connectMock,
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

describe('codeWorkspacePreviewAutomation', () => {
  beforeEach(() => {
    eventCallbacks.clear();
    connectCallbacks.clear();
    connectMock.mockReset();
    focusMock.mockReset();
    requestMock.mockReset();
    respondMock.mockReset();
    connectMock.mockResolvedValue(host);
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
      error: { _tag: 'PreviewAutomationExecutionError', message: 'no frame' },
    });
    await expect(runCodeWorkspacePreviewAutomationRequest({
      roomId: 'room-1',
      operation: 'snapshot',
    })).rejects.toThrow('no frame');
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
          _tag: 'Error',
          message: 'unsupported',
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
});
