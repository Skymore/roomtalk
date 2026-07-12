// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Message, Room } from './types';

type AckResponse = Record<string, unknown>;

const socketMock = vi.hoisted(() => {
  const handlers = new Map<string, Set<(...args: any[]) => void>>();
  const ackResponses = new Map<string, AckResponse>();
  let nextSocketId = 1;
  function defaultEmit(event: string, _payload?: unknown, callback?: (response: AckResponse) => void) {
    if (typeof callback === 'function') {
      callback(ackResponses.get(event) || { success: true });
    }
    return socket;
  }

  const socket = {
    id: 'socket-1',
    connected: true,
    handlers,
    ackResponses,
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      const eventHandlers = handlers.get(event) || new Set();
      eventHandlers.add(handler);
      handlers.set(event, eventHandlers);
      return socket;
    }),
    once: vi.fn((event: string, handler: (...args: any[]) => void) => {
      const onceHandler = (...args: any[]) => {
        handlers.get(event)?.delete(onceHandler);
        handler(...args);
      };
      const eventHandlers = handlers.get(event) || new Set();
      eventHandlers.add(onceHandler);
      handlers.set(event, eventHandlers);
      return socket;
    }),
    off: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.get(event)?.delete(handler);
      return socket;
    }),
    emit: vi.fn(defaultEmit),
    connect: vi.fn(() => {
      socket.connected = true;
      handlers.get('connect')?.forEach(handler => handler());
      return socket;
    }),
    reset: () => {
      handlers.clear();
      ackResponses.clear();
      nextSocketId += 1;
      socket.id = `socket-${nextSocketId}`;
      socket.connected = true;
      socket.emit.mockImplementation(defaultEmit);
    },
  };

  return socket;
});
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('socket.io-client', () => ({
  default: vi.fn(() => socketMock),
  Socket: class SocketMock {},
}));

vi.mock('uuid', () => ({
  v4: () => 'client-uuid',
}));

const {
  ensureRoomJoined,
  getAudioTranscription,
  getClientAccountStatus,
  getClientAuthStatus,
  getMediaDownloadUrl,
  getRoomMediaHistory,
  getRoomMemberCount,
  getRoomMembers,
  getRoomRoleMembers,
  getSavedRoomsFromServer,
  joinRoom,
  leaveRoom,
  loginWithClientPassword,
  loginWithGoogleCredential,
  onRoomMembershipRepairFailure,
  onUsernameAdopted,
  removeRoomMember,
  saveRoomToServer,
  sendMessage,
  sendMessageAndAskAI,
  requestAudioTranscription,
  requestCodeWorkspaceEntries,
  requestCodeWorkspaceEntrySearch,
  requestResolveCodeWorkspaceFilePreview,
  requestResolveCodeWorkspacePreviewTarget,
  requestCodeWorkspaceRefs,
  resetRoomJoinStateForTests,
  setClientPassword,
  setClientAuthToken,
  setUsername,
  unsaveRoomFromServer,
  uploadMediaMessage,
} = await import('./socket');

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'm1',
  clientId: 'client-uuid',
  content: 'hello',
  roomId: 'room-1',
  timestamp: '2026-05-03T10:00:00.000Z',
  messageType: 'text',
  ...overrides,
});

const room = (overrides: Partial<Room> = {}): Room => ({
  id: 'room-1',
  name: 'Room 1',
  description: '',
  createdAt: '2026-05-03T10:00:00.000Z',
  creatorId: 'client-uuid',
  ...overrides,
});

const deferRoomJoinAcknowledgements = () => {
  const joins: Array<{
    payload: { roomId: string; password?: string };
    acknowledge: (response: AckResponse) => void;
  }> = [];
  const leaves: string[] = [];
  socketMock.emit.mockImplementation((event: string, payload?: unknown, callback?: (response: AckResponse) => void) => {
    if (event === 'register') {
      callback?.({ success: true });
    } else if (event === 'join_room' && callback) {
      joins.push({
        payload: payload as { roomId: string; password?: string },
        acknowledge: callback,
      });
    } else if (event === 'leave_room') {
      leaves.push(payload as string);
    }
    return socketMock;
  });
  return { joins, leaves };
};

describe('socket message acknowledgement helpers', () => {
  beforeEach(() => {
    socketMock.reset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.clearAllMocks();
    localStorage.setItem('clientId', 'client-uuid');
    localStorage.removeItem('clientAuthToken');
    localStorage.removeItem('roomtalk_username');
    resetRoomJoinStateForTests();
  });

  it('returns the saved message from send_message acknowledgements', async () => {
    const savedMessage = message({ id: 'server-message-1', clientMessageId: 'client-message-1' });
    socketMock.ackResponses.set('send_message', {
      success: true,
      message: savedMessage,
    });

    await expect(
      sendMessage(
        'hello',
        'room-1',
        'text',
        'Ada',
        { text: 'A', color: '#123456' },
        'reply-1',
        'client-message-1',
        { id: 'mixed-batch', index: 1 },
      )
    ).resolves.toEqual(savedMessage);

    expect(socketMock.emit).toHaveBeenCalledWith(
      'send_message',
      {
        content: 'hello',
        roomId: 'room-1',
        messageType: 'text',
        username: 'Ada',
        avatar: { text: 'A', color: '#123456' },
        replyToMessageId: 'reply-1',
        clientMessageId: 'client-message-1',
        clientBatchId: 'mixed-batch',
        clientBatchIndex: 1,
      },
      expect.any(Function)
    );
  });

  it('registers the socket before emitting acknowledged room operations', async () => {
    const savedMessage = message({ id: 'registered-message' });
    socketMock.ackResponses.set('send_message', {
      success: true,
      message: savedMessage,
    });

    await expect(sendMessage('hello', 'room-1')).resolves.toEqual(savedMessage);

    expect(socketMock.emit.mock.calls[0]).toEqual([
      'register',
      { clientId: 'client-uuid', browserInstanceId: 'client-uuid', username: undefined, clientAuthToken: undefined },
      expect.any(Function),
    ]);
    expect(socketMock.emit.mock.calls[1]).toEqual([
      'send_message',
      {
        content: 'hello',
        roomId: 'room-1',
        messageType: 'text',
        username: undefined,
        avatar: undefined,
        replyToMessageId: undefined,
        clientMessageId: undefined,
      },
      expect.any(Function),
    ]);
  });

  it('does not emit the room operation when registration fails', async () => {
    socketMock.ackResponses.set('register', {
      success: false,
      error: 'register failed',
    });

    await expect(sendMessage('hello', 'room-1')).rejects.toThrow('register failed');

    expect(socketMock.emit).toHaveBeenCalledTimes(1);
    expect(socketMock.emit).toHaveBeenCalledWith(
      'register',
      { clientId: 'client-uuid', browserInstanceId: 'client-uuid', username: undefined, clientAuthToken: undefined },
      expect.any(Function),
    );
    expect(socketMock.emit).not.toHaveBeenCalledWith(
      'send_message',
      expect.anything(),
      expect.any(Function),
    );
  });

  it('connects before registering when the socket is disconnected', async () => {
    socketMock.connected = false;
    const savedMessage = message({ id: 'after-reconnect' });
    socketMock.ackResponses.set('send_message', {
      success: true,
      message: savedMessage,
    });

    await expect(sendMessage('hello', 'room-1')).resolves.toEqual(savedMessage);

    expect(socketMock.connect).toHaveBeenCalledTimes(1);
    expect(socketMock.emit.mock.calls[0]).toEqual([
      'register',
      { clientId: 'client-uuid', browserInstanceId: 'client-uuid', username: undefined, clientAuthToken: undefined },
      expect.any(Function),
    ]);
  });

  it('retries registration when the socket disconnects before the register acknowledgement', async () => {
    const savedMessage = message({ id: 'after-register-retry' });
    let registerAttempts = 0;

    socketMock.emit
      .mockImplementationOnce((event: string) => {
        expect(event).toBe('register');
        registerAttempts += 1;
        socketMock.connected = false;
        socketMock.id = 'socket-reconnected';
        Array.from(socketMock.handlers.get('disconnect') || []).forEach(handler => handler('transport close'));
        return socketMock;
      })
      .mockImplementationOnce((event: string, _payload?: unknown, callback?: (response: AckResponse) => void) => {
        expect(event).toBe('register');
        registerAttempts += 1;
        callback?.({ success: true });
        return socketMock;
      })
      .mockImplementationOnce((event: string, _payload?: unknown, callback?: (response: AckResponse) => void) => {
        expect(event).toBe('send_message');
        callback?.({ success: true, message: savedMessage });
        return socketMock;
      });

    await expect(sendMessage('hello', 'room-1')).resolves.toEqual(savedMessage);

    expect(registerAttempts).toBe(2);
    expect(socketMock.connect).toHaveBeenCalledTimes(1);
  });

  it('retries read-only workspace requests after a socket disconnect while waiting for acknowledgement', async () => {
    socketMock.emit
      .mockImplementationOnce((event: string, _payload?: unknown, callback?: (response: AckResponse) => void) => {
        expect(event).toBe('register');
        callback?.({ success: true });
        return socketMock;
      })
      .mockImplementationOnce((event: string) => {
        expect(event).toBe('list_code_workspace_entries');
        socketMock.connected = false;
        socketMock.id = 'socket-reconnected';
        Array.from(socketMock.handlers.get('disconnect') || []).forEach(handler => handler('transport close'));
        return socketMock;
      })
      .mockImplementationOnce((event: string, _payload?: unknown, callback?: (response: AckResponse) => void) => {
        expect(event).toBe('register');
        callback?.({ success: true });
        return socketMock;
      })
      .mockImplementationOnce((event: string, _payload?: unknown, callback?: (response: AckResponse) => void) => {
        expect(event).toBe('list_code_workspace_entries');
        callback?.({
          success: true,
          entries: [{ path: 'src/App.tsx', name: 'App.tsx', type: 'file' }],
          truncated: false,
        });
        return socketMock;
      });

    await expect(requestCodeWorkspaceEntries('room-1')).resolves.toEqual({
      entries: [{ path: 'src/App.tsx', name: 'App.tsx', type: 'file' }],
      truncated: false,
    });

    const listCalls = socketMock.emit.mock.calls.filter(([event]) => event === 'list_code_workspace_entries');
    expect(listCalls).toHaveLength(2);
  });

  it('searches workspace entries through the socket request', async () => {
    socketMock.ackResponses.set('search_code_workspace_entries', {
      success: true,
      entries: [{ path: 'src/components/Composer.tsx', name: 'Composer.tsx', type: 'file' }],
      truncated: true,
    });

    await expect(requestCodeWorkspaceEntrySearch('room-1', '@cmp', 25)).resolves.toEqual({
      entries: [{ path: 'src/components/Composer.tsx', name: 'Composer.tsx', type: 'file' }],
      truncated: true,
    });

    expect(socketMock.emit).toHaveBeenCalledWith(
      'search_code_workspace_entries',
      { roomId: 'room-1', query: '@cmp', limit: 25 },
      expect.any(Function),
    );
  });

  it('loads workspace refs through the socket request', async () => {
    socketMock.ackResponses.set('list_code_workspace_refs', {
      success: true,
      refs: {
        available: true,
        headRef: 'feature/search',
        refs: [
          { name: 'main', kind: 'local' },
          { name: 'origin/main', kind: 'remote', remoteName: 'origin' },
        ],
      },
    });

    await expect(requestCodeWorkspaceRefs('room-1', { query: 'main', limit: 25 })).resolves.toEqual({
      available: true,
      headRef: 'feature/search',
      refs: [
        { name: 'main', kind: 'local' },
        { name: 'origin/main', kind: 'remote', remoteName: 'origin' },
      ],
    });

    expect(socketMock.emit).toHaveBeenCalledWith(
      'list_code_workspace_refs',
      { roomId: 'room-1', query: 'main', limit: 25 },
      expect.any(Function),
    );
  });

  it('allows workspace file preview resolution to wait up to ten minutes', async () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    socketMock.ackResponses.set('resolve_code_workspace_file_preview', {
      success: true,
      preview: {
        kind: 'static-file',
        asset: { relativeUrl: '/api/code-agent/workspace-assets/token/index.html' },
      },
    });

    await expect(
      requestResolveCodeWorkspaceFilePreview('room-1', 'index.html', { startDevServer: true })
    ).resolves.toEqual({
      kind: 'static-file',
      asset: { relativeUrl: '/api/code-agent/workspace-assets/token/index.html' },
    });

    expect(socketMock.emit).toHaveBeenCalledWith(
      'resolve_code_workspace_file_preview',
      { roomId: 'room-1', path: 'index.html', startDevServer: true },
      expect.any(Function),
    );
    expect(setTimeoutSpy.mock.calls.map((call) => call[1])).toContain(600_000);
    setTimeoutSpy.mockRestore();
  });

  it('resolves workspace preview targets through the socket request', async () => {
    socketMock.ackResponses.set('resolve_code_workspace_preview_target', {
      success: true,
      target: {
        requestedUrl: 'http://localhost:5173/app',
        resolvedUrl: 'https://5173-sandbox.e2b.dev/app',
        resolutionKind: 'e2b-port-host',
      },
    });

    await expect(requestResolveCodeWorkspacePreviewTarget({
      roomId: 'room-1',
      target: { kind: 'environment-port', port: 5173, path: '/app' },
    })).resolves.toEqual({
      requestedUrl: 'http://localhost:5173/app',
      resolvedUrl: 'https://5173-sandbox.e2b.dev/app',
      resolutionKind: 'e2b-port-host',
    });

    expect(socketMock.emit).toHaveBeenCalledWith(
      'resolve_code_workspace_preview_target',
      {
        roomId: 'room-1',
        target: { kind: 'environment-port', port: 5173, path: '/app' },
      },
      expect.any(Function),
    );
  });

  it('includes the stored client auth token when registering the socket', async () => {
    localStorage.setItem('clientAuthToken', 'auth-token-1');
    const savedMessage = message({ id: 'registered-message' });
    socketMock.ackResponses.set('send_message', {
      success: true,
      message: savedMessage,
    });

    await expect(sendMessage('hello', 'room-1')).resolves.toEqual(savedMessage);

    expect(socketMock.emit.mock.calls[0]).toEqual([
      'register',
      { clientId: 'client-uuid', browserInstanceId: 'client-uuid', username: undefined, clientAuthToken: 'auth-token-1' },
      expect.any(Function),
    ]);
  });

  it('reuses registration for later operations on the same socket', async () => {
    const savedMessage = message({ id: 'first-operation' });
    socketMock.ackResponses.set('send_message', {
      success: true,
      message: savedMessage,
    });
    socketMock.ackResponses.set('get_saved_rooms', {
      success: true,
      rooms: [],
    });

    await sendMessage('hello', 'room-1');
    await getSavedRoomsFromServer();

    const registerCalls = socketMock.emit.mock.calls.filter(([event]) => event === 'register');
    expect(registerCalls).toHaveLength(1);
  });

  it('adopts the server nickname returned by register acknowledgements', async () => {
    const adopted = vi.fn();
    const unsubscribe = onUsernameAdopted(adopted);
    socketMock.ackResponses.set('register', {
      success: true,
      nickname: 'Server Ada',
    });
    socketMock.ackResponses.set('get_saved_rooms', {
      success: true,
      rooms: [],
    });

    try {
      await getSavedRoomsFromServer();
    } finally {
      unsubscribe();
    }

    expect(localStorage.getItem('roomtalk_username')).toBe('Server Ada');
    expect(adopted).toHaveBeenCalledWith('Server Ada');
  });

  it('returns the saved user message and AI message id from send_message_and_ask_ai', async () => {
    const savedMessage = message({ id: 'server-message-2', clientMessageId: 'client-message-2' });
    socketMock.ackResponses.set('send_message_and_ask_ai', {
      success: true,
      userMessage: savedMessage,
      aiMessageId: 'ai-message-1',
    });

    await expect(
      sendMessageAndAskAI({
        roomId: 'room-1',
        content: 'ask this',
        username: 'Ada',
        avatar: { text: 'A', color: '#123456' },
        replyToMessageId: 'reply-1',
        clientMessageId: 'client-message-2',
        systemPrompt: 'be concise',
        roleName: 'Assistant',
        model: 'model-a',
        maxContextMessages: 25,
      })
    ).resolves.toEqual({
      userMessage: savedMessage,
      aiMessageId: 'ai-message-1',
      aiStarted: true,
      aiError: undefined,
    });

    expect(socketMock.emit).toHaveBeenCalledWith(
      'send_message_and_ask_ai',
      {
        roomId: 'room-1',
        content: 'ask this',
        username: 'Ada',
        avatar: { text: 'A', color: '#123456' },
        replyToMessageId: 'reply-1',
        clientMessageId: 'client-message-2',
        systemPrompt: 'be concise',
        roleName: 'Assistant',
        model: 'model-a',
        maxContextMessages: 25,
      },
      expect.any(Function)
    );
  });

  it('resolves with the saved user message when AI startup fails after saving', async () => {
    const savedMessage = message({ id: 'server-message-2', clientMessageId: 'client-message-2' });
    socketMock.ackResponses.set('send_message_and_ask_ai', {
      success: true,
      userMessage: savedMessage,
      aiStarted: false,
      aiError: 'Unable to start a durable AI response',
    });

    await expect(
      sendMessageAndAskAI({
        roomId: 'room-1',
        content: 'ask this',
        clientMessageId: 'client-message-2',
      })
    ).resolves.toEqual({
      userMessage: savedMessage,
      aiMessageId: undefined,
      aiStarted: false,
      aiError: 'Unable to start a durable AI response',
    });
  });

  it('returns signed media download URLs from the media API', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      url: 'https://signed.example/media.webp',
      expiresAt: '2026-05-03T00:15:00.000Z',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(getMediaDownloadUrl({ roomId: 'room-1', assetId: 'asset-1' })).resolves.toEqual({
      url: 'https://signed.example/media.webp',
      expiresAt: '2026-05-03T00:15:00.000Z',
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/media/asset-1/download-url?roomId=room-1', { headers: { 'X-Client-Id': 'client-uuid' } });
  });

  it('appends the client auth token to signed media URL requests', async () => {
    setClientAuthToken('auth-token-1');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      url: 'https://signed.example/media.webp',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(getMediaDownloadUrl({ roomId: 'room-1', assetId: 'asset-1' })).resolves.toEqual({
      url: 'https://signed.example/media.webp',
      expiresAt: undefined,
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/media/asset-1/download-url?roomId=room-1', { headers: { 'X-Client-Id': 'client-uuid', 'X-Client-Auth-Token': 'auth-token-1' } });
  });

  it('loads, sets, and logs in with User ID password auth', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ clientId: 'client-uuid', hasPassword: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ clientId: 'client-uuid', hasPassword: true, clientAuthToken: 'new-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ clientId: 'client-other', hasPassword: true, clientAuthToken: 'login-token', nickname: 'Alice' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    await expect(getClientAuthStatus()).resolves.toEqual({ clientId: 'client-uuid', hasPassword: false });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/client-auth/client-uuid/status', { cache: 'no-store' });

    setClientAuthToken('old-token');
    await expect(setClientPassword('password-1', 'current-password')).resolves.toEqual({ clientId: 'client-uuid', hasPassword: true });
    expect(localStorage.getItem('clientAuthToken')).toBe('new-token');
    const setPasswordRequest = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(setPasswordRequest.body as string)).toEqual({
      clientId: 'client-uuid',
      password: 'password-1',
      currentPassword: 'current-password',
      clientAuthToken: 'old-token',
    });

    const adopted = vi.fn();
    const unsubscribe = onUsernameAdopted(adopted);
    try {
      await expect(loginWithClientPassword('client-other', 'password-2')).resolves.toEqual({ clientId: 'client-other', hasPassword: true });
    } finally {
      unsubscribe();
    }
    expect(localStorage.getItem('clientId')).toBe('client-other');
    expect(localStorage.getItem('clientAuthToken')).toBe('login-token');
    expect(localStorage.getItem('roomtalk_username')).toBe('Alice');
    expect(adopted).toHaveBeenCalledWith('Alice');
    const loginRequest = fetchMock.mock.calls[2][1] as RequestInit;
    expect(JSON.parse(loginRequest.body as string)).toEqual({
      clientId: 'client-other',
      password: 'password-2',
    });
  });

  it('clears the cached username when User ID password login has no server nickname', async () => {
    localStorage.setItem('roomtalk_username', 'Stale Bob');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      clientId: 'client-other',
      hasPassword: true,
      clientAuthToken: 'login-token',
      nickname: null,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(loginWithClientPassword('client-other', 'password-2')).resolves.toEqual({ clientId: 'client-other', hasPassword: true });

    expect(localStorage.getItem('clientId')).toBe('client-other');
    expect(localStorage.getItem('clientAuthToken')).toBe('login-token');
    expect(localStorage.getItem('roomtalk_username')).toBeNull();
  });

  it('loads account status and adopts Google login responses', async () => {
    setClientAuthToken('old-token');
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        clientId: 'client-uuid',
        hasPassword: false,
        googleConfigured: true,
        account: null,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        clientId: 'client-google',
        hasPassword: false,
        clientAuthToken: 'google-token',
        nickname: 'Ada',
        account: {
          accountId: 'account-1',
          primaryClientId: 'client-google',
          provider: 'google',
          email: 'ada@example.com',
          emailVerified: true,
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    await expect(getClientAccountStatus()).resolves.toEqual({
      clientId: 'client-uuid',
      hasPassword: false,
      googleConfigured: true,
      account: null,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/auth/account', { cache: 'no-store', headers: { 'X-Client-Id': 'client-uuid', 'X-Client-Auth-Token': 'old-token' } });

    await expect(loginWithGoogleCredential('google-credential')).resolves.toEqual({
      clientId: 'client-google',
      hasPassword: false,
      clientAuthToken: 'google-token',
      nickname: 'Ada',
      account: {
        accountId: 'account-1',
        primaryClientId: 'client-google',
        provider: 'google',
        email: 'ada@example.com',
        emailVerified: true,
      },
    });
    const googleRequest = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(googleRequest.body as string)).toEqual({
      clientId: 'client-uuid',
      credential: 'google-credential',
      clientAuthToken: 'old-token',
    });
    expect(localStorage.getItem('clientId')).toBe('client-google');
    expect(localStorage.getItem('clientAuthToken')).toBe('google-token');
    expect(localStorage.getItem('roomtalk_username')).toBe('Ada');
  });

  it('uploads media objects through relative local media URLs', async () => {
    const onUploadAllocated = vi.fn();
    const savedMessage = message({
      id: 'media-message-1',
      content: '',
      messageType: 'media',
      mediaAsset: {
        id: 'asset-1',
        kind: 'image',
        mimeType: 'image/webp',
        byteSize: 11,
      },
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        assetId: 'asset-1',
        uploadUrl: '/api/media/local-objects/local-key',
        objectKey: 'rooms/room-1/media/image/asset-1',
        expiresAt: '2026-05-03T00:15:00.000Z',
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(savedMessage), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }));

    await expect(uploadMediaMessage({
      file: new Blob(['image-bytes'], { type: 'image/webp' }),
      roomId: 'room-1',
      kind: 'image',
      mimeType: 'image/webp',
      onUploadAllocated,
    })).resolves.toEqual(savedMessage);

    expect(onUploadAllocated).toHaveBeenCalledWith({
      assetId: 'asset-1',
      objectKey: 'rooms/room-1/media/image/asset-1',
      roomId: 'room-1',
      kind: 'image',
      mimeType: 'image/webp',
      byteSize: 11,
      filename: undefined,
    });
    expect(onUploadAllocated.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[1]);
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/media/local-objects/local-key', {
      method: 'PUT',
      headers: { 'Content-Type': 'image/webp' },
      body: expect.any(Blob),
    });
  });

  it('reports object upload progress and completes after the XHR upload', async () => {
    const progress = vi.fn();
    const savedMessage = message({ id: 'media-progress-1', messageType: 'media', content: '' });
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        assetId: 'asset-progress-1',
        uploadUrl: '/api/media/local-objects/progress-key',
        objectKey: 'rooms/room-1/media/file/asset-progress-1',
      }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(savedMessage), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }));

    class ProgressXMLHttpRequest {
      upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
      status = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open = vi.fn();
      setRequestHeader = vi.fn();
      abort = vi.fn(() => this.onabort?.());
      send = vi.fn(() => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent);
        this.status = 204;
        this.onload?.();
      });
    }
    vi.stubGlobal('XMLHttpRequest', ProgressXMLHttpRequest);

    await expect(uploadMediaMessage({
      file: new Blob(['0123456789'], { type: 'text/plain' }),
      roomId: 'room-1',
      kind: 'file',
      filename: 'progress.txt',
      onUploadProgress: progress,
    })).resolves.toEqual(savedMessage);

    expect(progress).toHaveBeenNthCalledWith(1, 50);
    expect(progress).toHaveBeenLastCalledWith(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts during upload creation without starting the object PUT or completion request', async () => {
    const send = vi.fn();
    class AbortXMLHttpRequest {
      upload = { onprogress: null };
      open = vi.fn();
      setRequestHeader = vi.fn();
      send = send;
      abort = vi.fn();
    }
    vi.stubGlobal('XMLHttpRequest', AbortXMLHttpRequest);
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const controller = new AbortController();

    const uploadPromise = uploadMediaMessage({
      file: new Blob(['cancel me'], { type: 'text/plain' }),
      roomId: 'room-1',
      kind: 'file',
      filename: 'cancel.txt',
      signal: controller.signal,
      onUploadProgress: vi.fn(),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    controller.abort();

    await expect(uploadPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(send).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a signal that becomes aborted before the object PUT is opened', async () => {
    const xhrConstructed = vi.fn();
    class UnexpectedXMLHttpRequest {
      constructor() {
        xhrConstructed();
      }
    }
    vi.stubGlobal('XMLHttpRequest', UnexpectedXMLHttpRequest);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      assetId: 'asset-cancelled-before-put',
      uploadUrl: '/api/media/local-objects/cancelled-before-put',
      objectKey: 'rooms/room-1/media/file/asset-cancelled-before-put',
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }));

    let abortedReads = 0;
    const stagedSignal = {
      get aborted() {
        abortedReads += 1;
        return abortedReads >= 2;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    await expect(uploadMediaMessage({
      file: new Blob(['cancel before PUT'], { type: 'text/plain' }),
      roomId: 'room-1',
      kind: 'file',
      filename: 'cancel-before-put.txt',
      signal: stagedSignal,
      onUploadProgress: vi.fn(),
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(xhrConstructed).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('includes the client auth token when creating and completing media uploads', async () => {
    setClientAuthToken('auth-token-1');
    const savedMessage = message({
      id: 'media-message-1',
      content: '',
      messageType: 'media',
      mediaAsset: {
        id: 'asset-1',
        kind: 'image',
        mimeType: 'image/webp',
        byteSize: 11,
      },
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        assetId: 'asset-1',
        uploadUrl: '/api/media/local-objects/local-key',
        objectKey: 'rooms/room-1/media/image/asset-1',
        expiresAt: '2026-05-03T00:15:00.000Z',
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(savedMessage), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }));

    await expect(uploadMediaMessage({
      file: new Blob(['image-bytes'], { type: 'image/webp' }),
      roomId: 'room-1',
      kind: 'image',
      mimeType: 'image/webp',
    })).resolves.toEqual(savedMessage);

    const createRequest = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(createRequest.body as string)).toEqual({
      clientId: 'client-uuid',
      roomId: 'room-1',
      kind: 'image',
      mimeType: 'image/webp',
      byteSize: 11,
      clientAuthToken: 'auth-token-1',
    });
    const completeRequest = fetchMock.mock.calls[2][1] as RequestInit;
    expect(JSON.parse(completeRequest.body as string)).toMatchObject({
      clientId: 'client-uuid',
      roomId: 'room-1',
      clientAuthToken: 'auth-token-1',
    });
  });

  it('sends filenames when uploading generic file messages', async () => {
    const savedMessage = message({
      id: 'file-message-1',
      content: '',
      messageType: 'media',
      mediaAsset: {
        id: 'asset-file-1',
        kind: 'file',
        mimeType: 'text/markdown',
        byteSize: 7,
        filename: 'notes.md',
      },
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        assetId: 'asset-file-1',
        uploadUrl: '/api/media/local-objects/file-key',
        objectKey: 'rooms/room-1/media/file/asset-file-1',
        expiresAt: '2026-05-03T00:15:00.000Z',
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(savedMessage), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }));

    const file = new Blob(['# notes'], { type: 'text/markdown' });
    await expect(uploadMediaMessage({
      file,
      roomId: 'room-1',
      kind: 'file',
      mimeType: 'text/markdown',
      filename: 'notes.md',
    })).resolves.toEqual(savedMessage);

    const createRequest = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(createRequest.body as string)).toMatchObject({
      clientId: 'client-uuid',
      roomId: 'room-1',
      kind: 'file',
      mimeType: 'text/markdown',
      byteSize: 7,
      filename: 'notes.md',
    });
    const completeRequest = fetchMock.mock.calls[2][1] as RequestInit;
    expect(JSON.parse(completeRequest.body as string)).toMatchObject({
      clientId: 'client-uuid',
      roomId: 'room-1',
      kind: 'file',
      mimeType: 'text/markdown',
      byteSize: 7,
      objectKey: 'rooms/room-1/media/file/asset-file-1',
      filename: 'notes.md',
    });
  });

  it('returns room media history and normalizes local media URLs', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      roomId: 'room-1',
      items: [{
        assetId: 'asset-1',
        messageId: 'message-1',
        kind: 'image',
        mimeType: 'image/webp',
        byteSize: 123,
        createdAt: '2026-06-01T00:00:00.000Z',
        url: '/api/media/local-objects/local-key',
      }],
      hasMore: true,
      nextCursor: 'cursor-1',
      windowMonths: 6,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(getRoomMediaHistory({ roomId: 'room-1', before: 'cursor-0', limit: 24, kind: 'video' })).resolves.toEqual({
      roomId: 'room-1',
      items: [{
        assetId: 'asset-1',
        messageId: 'message-1',
        kind: 'image',
        mimeType: 'image/webp',
        byteSize: 123,
        createdAt: '2026-06-01T00:00:00.000Z',
        url: '/api/media/local-objects/local-key',
      }],
      hasMore: true,
      nextCursor: 'cursor-1',
      windowMonths: 6,
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/rooms/room-1/media-history?before=cursor-0&limit=24&kind=video', { headers: { 'X-Client-Id': 'client-uuid' } });
  });

  it('appends the client auth token to media history requests', async () => {
    setClientAuthToken('auth-token-1');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      roomId: 'room-1',
      items: [],
      hasMore: false,
      nextCursor: null,
      windowMonths: 6,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(getRoomMediaHistory({ roomId: 'room-1' })).resolves.toEqual({
      roomId: 'room-1',
      items: [],
      hasMore: false,
      nextCursor: null,
      windowMonths: 6,
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/rooms/room-1/media-history', { headers: { 'X-Client-Id': 'client-uuid', 'X-Client-Auth-Token': 'auth-token-1' } });
  });

  it('loads and requests audio transcriptions with client auth', async () => {
    setClientAuthToken('auth-token-1');
    const transcription = {
      assetId: 'audio-asset-1',
      roomId: 'room-1',
      messageId: 'message-1',
      status: 'completed',
      transcript: 'hello',
      languageCode: 'en',
      updatedAt: '2026-05-03T10:16:00.000Z',
      completedAt: '2026-05-03T10:16:00.000Z',
    };
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(transcription), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...transcription, status: 'processing', transcript: undefined }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }));

    await expect(getAudioTranscription({ roomId: 'room-1', messageId: 'message-1' })).resolves.toEqual(transcription);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/rooms/room-1/messages/message-1/audio-transcription',
      { cache: 'no-store', headers: { 'X-Client-Id': 'client-uuid', 'X-Client-Auth-Token': 'auth-token-1' } },
    );

    await expect(requestAudioTranscription({ roomId: 'room-1', messageId: 'message-1' })).resolves.toMatchObject({
      assetId: 'audio-asset-1',
      status: 'processing',
    });
    const request = fetchMock.mock.calls[1][1] as RequestInit;
    expect(fetchMock.mock.calls[1][0]).toBe('/api/rooms/room-1/messages/message-1/audio-transcription');
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body as string)).toEqual({
      clientId: 'client-uuid',
      clientAuthToken: 'auth-token-1',
    });
  });

  it('returns saved rooms from get_saved_rooms acknowledgements', async () => {
    const savedRooms = [room()];
    socketMock.ackResponses.set('get_saved_rooms', {
      success: true,
      rooms: savedRooms,
    });

    await expect(getSavedRoomsFromServer()).resolves.toEqual(savedRooms);

    expect(socketMock.emit).toHaveBeenCalledWith(
      'get_saved_rooms',
      {},
      expect.any(Function)
    );
  });

  it('saves rooms through save_room acknowledgements', async () => {
    const savedRoom = room({ id: 'room-2', name: 'Saved Room' });
    socketMock.ackResponses.set('save_room', {
      success: true,
      room: savedRoom,
    });

    await expect(saveRoomToServer('room-2')).resolves.toEqual(savedRoom);

    expect(socketMock.emit).toHaveBeenCalledWith(
      'save_room',
      { roomId: 'room-2' },
      expect.any(Function)
    );
  });

  it('removes saved rooms through unsave_room acknowledgements', async () => {
    const remainingRooms = [room({ id: 'room-3' })];
    socketMock.ackResponses.set('unsave_room', {
      success: true,
      rooms: remainingRooms,
    });

    await expect(unsaveRoomFromServer('room-2')).resolves.toEqual(remainingRooms);

    expect(socketMock.emit).toHaveBeenCalledWith(
      'unsave_room',
      { roomId: 'room-2' },
      expect.any(Function)
    );
  });

  it('returns online members from get_room_members acknowledgements', async () => {
    const members = [
      { clientId: 'client-uuid', nickname: 'Ada' },
      { clientId: 'client-2', nickname: 'Grace' },
    ];
    socketMock.ackResponses.set('get_room_members', {
      success: true,
      members,
    });

    await expect(getRoomMembers('room-1')).resolves.toEqual(members);

    expect(socketMock.emit).toHaveBeenCalledWith(
      'get_room_members',
      { roomId: 'room-1' },
      expect.any(Function)
    );
  });

  it('returns persistent role members from get_room_role_members acknowledgements', async () => {
    const members = [
      { roomId: 'room-1', clientId: 'client-uuid', role: 'owner', joinedAt: '2026-05-03T10:00:00.000Z', nickname: 'Ada' },
      { roomId: 'room-1', clientId: 'client-2', role: 'member', joinedAt: '2026-05-03T10:01:00.000Z', nickname: 'Grace' },
    ];
    socketMock.ackResponses.set('get_room_role_members', {
      success: true,
      members,
    });

    await expect(getRoomRoleMembers('room-1')).resolves.toEqual(members);

    expect(socketMock.emit).toHaveBeenCalledWith(
      'get_room_role_members',
      { roomId: 'room-1' },
      expect.any(Function)
    );
  });

  it('removes persistent room members through remove_room_member acknowledgements', async () => {
    socketMock.ackResponses.set('remove_room_member', {
      success: true,
    });

    await expect(removeRoomMember('room-1', 'client-2')).resolves.toBeUndefined();

    expect(socketMock.emit).toHaveBeenCalledWith(
      'remove_room_member',
      { roomId: 'room-1', targetClientId: 'client-2' },
      expect.any(Function)
    );
  });

  it('emits set_username when a username is set while connected', async () => {
    setUsername('Ada');

    await vi.waitFor(() => {
      expect(socketMock.emit).toHaveBeenCalledWith('set_username', 'Ada');
    });
  });

  it('rejoins the active room through ensureRoomJoined', async () => {
    const joinedRoom = room();
    socketMock.ackResponses.set('join_room', {
      success: true,
      room: joinedRoom,
      memberCount: 3,
    });

    await expect(ensureRoomJoined(joinedRoom.id)).resolves.toEqual({
      room: joinedRoom,
      permissions: undefined,
      memberCount: 3,
    });
    expect(getRoomMemberCount(joinedRoom.id)).toBe(3);

    expect(socketMock.emit).toHaveBeenCalledWith(
      'join_room',
      { roomId: joinedRoom.id, password: undefined },
      expect.any(Function)
    );
  });

  it('reuses the active room password through ensureRoomJoined', async () => {
    const joinedRoom = room();
    socketMock.ackResponses.set('join_room', {
      success: true,
      room: joinedRoom,
      memberCount: 3,
    });

    await joinRoom(joinedRoom.id, 'secret');
    socketMock.emit.mockClear();

    await expect(ensureRoomJoined(joinedRoom.id)).resolves.toEqual({
      room: joinedRoom,
      permissions: undefined,
      memberCount: 3,
    });

    expect(socketMock.emit).toHaveBeenCalledWith(
      'join_room',
      { roomId: joinedRoom.id, password: 'secret' },
      expect.any(Function)
    );
  });

  it('repairs the latest room when an older join acknowledgement arrives last', async () => {
    const { joins, leaves } = deferRoomJoinAcknowledgements();
    const roomA = room({ id: 'room-a', name: 'Room A' });
    const roomB = room({ id: 'room-b', name: 'Room B' });

    const joinA = joinRoom(roomA.id, 'a-secret');
    const joinB = joinRoom(roomB.id, 'b-secret');
    await vi.waitFor(() => expect(joins).toHaveLength(2));

    joins[1].acknowledge({ success: true, room: roomB, memberCount: 2 });
    await expect(joinB).resolves.toMatchObject({ room: roomB });
    joins[0].acknowledge({ success: true, room: roomA, memberCount: 1 });
    await expect(joinA).resolves.toMatchObject({ room: roomA });

    await vi.waitFor(() => expect(joins).toHaveLength(3));
    expect(leaves).toEqual([roomA.id]);
    expect(joins[2].payload).toEqual({ roomId: roomB.id, password: 'b-secret' });
    joins[2].acknowledge({ success: true, room: roomB, memberCount: 4 });
    await vi.waitFor(() => expect(getRoomMemberCount(roomB.id)).toBe(4));
  });

  it('repairs after the latest join settles because ack order does not prove mutation order', async () => {
    const { joins, leaves } = deferRoomJoinAcknowledgements();
    const roomA = room({ id: 'room-a', name: 'Room A' });
    const roomB = room({ id: 'room-b', name: 'Room B' });

    const joinA = joinRoom(roomA.id);
    const joinB = joinRoom(roomB.id);
    await vi.waitFor(() => expect(joins).toHaveLength(2));

    joins[0].acknowledge({ success: true, room: roomA });
    await expect(joinA).resolves.toMatchObject({ room: roomA });
    await Promise.resolve();
    expect(joins).toHaveLength(2);

    joins[1].acknowledge({ success: true, room: roomB });
    await expect(joinB).resolves.toMatchObject({ room: roomB });
    await vi.waitFor(() => expect(joins).toHaveLength(3));
    expect(leaves).toEqual([roomA.id]);
    expect(joins[2].payload).toEqual({ roomId: roomB.id, password: undefined });
    joins[2].acknowledge({ success: true, room: roomB, memberCount: 3 });
    await vi.waitFor(() => expect(getRoomMemberCount(roomB.id)).toBe(3));
  });

  it('repairs the latest room after a stale join fails because the server outcome may be partial', async () => {
    const { joins, leaves } = deferRoomJoinAcknowledgements();
    const roomA = room({ id: 'room-a', name: 'Room A' });
    const roomB = room({ id: 'room-b', name: 'Room B' });

    const joinA = joinRoom(roomA.id);
    const joinB = joinRoom(roomB.id);
    await vi.waitFor(() => expect(joins).toHaveLength(2));

    joins[1].acknowledge({ success: true, room: roomB, memberCount: 2 });
    await expect(joinB).resolves.toMatchObject({ room: roomB });
    joins[0].acknowledge({ success: false, error: 'stale join failed' });
    await expect(joinA).rejects.toThrow('stale join failed');

    await vi.waitFor(() => expect(joins).toHaveLength(3));
    expect(leaves).toEqual([roomA.id]);
    expect(joins[2].payload).toEqual({ roomId: roomB.id, password: undefined });
    joins[2].acknowledge({ success: true, room: roomB, memberCount: 4 });
    await vi.waitFor(() => expect(getRoomMemberCount(roomB.id)).toBe(4));
  });

  it('leaves a room again when its join acknowledgement arrives after leave', async () => {
    const { joins, leaves } = deferRoomJoinAcknowledgements();
    const roomA = room({ id: 'room-a', name: 'Room A' });

    const pendingJoin = joinRoom(roomA.id);
    await vi.waitFor(() => expect(joins).toHaveLength(1));
    leaveRoom(roomA.id);
    expect(leaves).toEqual([roomA.id]);

    joins[0].acknowledge({ success: true, room: roomA });
    await expect(pendingJoin).resolves.toMatchObject({ room: roomA });
    await vi.waitFor(() => expect(leaves).toEqual([roomA.id, roomA.id]));
  });

  it('keeps the latest failed intent and password for an explicit retry', async () => {
    const { joins } = deferRoomJoinAcknowledgements();
    const roomB = room({ id: 'room-b', name: 'Room B' });

    const failedJoin = joinRoom(roomB.id, 'b-secret');
    await vi.waitFor(() => expect(joins).toHaveLength(1));
    joins[0].acknowledge({ success: false, error: 'temporary failure' });
    await expect(failedJoin).rejects.toThrow('temporary failure');

    const retry = ensureRoomJoined(roomB.id);
    await vi.waitFor(() => expect(joins).toHaveLength(2));
    expect(joins[1].payload).toEqual({ roomId: roomB.id, password: 'b-secret' });
    joins[1].acknowledge({ success: true, room: roomB });
    await expect(retry).resolves.toMatchObject({ room: roomB });
  });

  it('leaves a latest join whose timeout has an uncertain server outcome even without a late ack', async () => {
    vi.useFakeTimers();
    try {
      const { joins, leaves } = deferRoomJoinAcknowledgements();
      const onRepairFailure = vi.fn();
      onRoomMembershipRepairFailure(onRepairFailure);
      const roomB = room({ id: 'room-b', name: 'Room B' });
      const timedOutJoin = joinRoom(roomB.id);
      const timeoutExpectation = expect(timedOutJoin).rejects.toThrow('Timed out while joining room');
      await vi.advanceTimersByTimeAsync(0);
      expect(joins).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(15000);
      await timeoutExpectation;
      await vi.advanceTimersByTimeAsync(0);

      expect(leaves).toEqual([roomB.id]);
      expect(joins).toHaveLength(1);
      expect(onRepairFailure).toHaveBeenCalledOnce();
      expect(onRepairFailure).toHaveBeenCalledWith(
        roomB.id,
        expect.objectContaining({ message: 'Timed out while joining room' }),
      );

      const explicitRetry = ensureRoomJoined(roomB.id);
      await vi.advanceTimersByTimeAsync(0);
      expect(joins).toHaveLength(2);
      joins[1].acknowledge({ success: true, room: roomB, memberCount: 2 });
      await expect(explicitRetry).resolves.toMatchObject({ room: roomB });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconciles a join acknowledgement that arrives after the client timeout', async () => {
    vi.useFakeTimers();
    try {
      const { joins, leaves } = deferRoomJoinAcknowledgements();
      const onRepairFailure = vi.fn();
      onRoomMembershipRepairFailure(onRepairFailure);
      const roomA = room({ id: 'room-a', name: 'Room A' });
      const timedOutJoin = joinRoom(roomA.id);
      const timeoutExpectation = expect(timedOutJoin).rejects.toThrow('Timed out while joining room');
      await vi.advanceTimersByTimeAsync(0);
      expect(joins).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(15000);
      await timeoutExpectation;
      await vi.advanceTimersByTimeAsync(0);
      expect(leaves).toEqual([roomA.id]);

      joins[0].acknowledge({ success: true, room: roomA });
      await vi.advanceTimersByTimeAsync(0);
      expect(leaves).toEqual([roomA.id, roomA.id]);
      expect(onRepairFailure).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a definitive late room-not-found acknowledgement after an earlier timeout', async () => {
    vi.useFakeTimers();
    try {
      const { joins } = deferRoomJoinAcknowledgements();
      const onRepairFailure = vi.fn();
      onRoomMembershipRepairFailure(onRepairFailure);
      const missingRoom = room({ id: 'missing-late-room', name: 'Missing Room' });
      const timedOutJoin = joinRoom(missingRoom.id);
      const timeoutExpectation = expect(timedOutJoin).rejects.toThrow('Timed out while joining room');
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(15000);
      await timeoutExpectation;
      await vi.advanceTimersByTimeAsync(0);
      expect(onRepairFailure).toHaveBeenCalledWith(
        missingRoom.id,
        expect.objectContaining({ message: 'Timed out while joining room' }),
      );

      joins[0].acknowledge({ success: false, error: 'Room not found' });
      await vi.advanceTimersByTimeAsync(0);

      expect(onRepairFailure).toHaveBeenLastCalledWith(
        missingRoom.id,
        expect.objectContaining({ message: 'Room not found' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let late repair acknowledgements reopen the bounded repair budget', async () => {
    vi.useFakeTimers();
    try {
      const { joins, leaves } = deferRoomJoinAcknowledgements();
      const onRepairFailure = vi.fn();
      onRoomMembershipRepairFailure(onRepairFailure);
      const roomA = room({ id: 'room-a', name: 'Room A' });
      const roomB = room({ id: 'room-b', name: 'Room B' });

      const joinA = joinRoom(roomA.id);
      const joinB = joinRoom(roomB.id);
      await vi.advanceTimersByTimeAsync(0);
      expect(joins).toHaveLength(2);

      joins[1].acknowledge({ success: true, room: roomB, memberCount: 2 });
      await joinB;
      joins[0].acknowledge({ success: true, room: roomA, memberCount: 1 });
      await joinA;
      await vi.advanceTimersByTimeAsync(0);

      expect(leaves).toEqual([roomA.id]);
      expect(joins).toHaveLength(3);

      await vi.advanceTimersByTimeAsync(15000);
      expect(joins).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(15000);
      await vi.advanceTimersByTimeAsync(0);

      expect(onRepairFailure).toHaveBeenCalledTimes(1);
      expect(onRepairFailure).toHaveBeenCalledWith(
        roomB.id,
        expect.objectContaining({ message: 'Timed out while joining room' }),
      );
      expect(joins).toHaveLength(4);

      joins[2].acknowledge({ success: true, room: roomB, memberCount: 3 });
      joins[3].acknowledge({ success: true, room: roomB, memberCount: 4 });
      await vi.advanceTimersByTimeAsync(0);

      expect(joins).toHaveLength(4);
      expect(onRepairFailure).toHaveBeenCalledTimes(1);

      const explicitRetry = ensureRoomJoined(roomB.id);
      await vi.advanceTimersByTimeAsync(0);
      expect(joins).toHaveLength(5);
      joins[4].acknowledge({ success: true, room: roomB, memberCount: 5 });
      await expect(explicitRetry).resolves.toMatchObject({ room: roomB });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a bounded repair failure instead of silently keeping the room ready', async () => {
    const { joins } = deferRoomJoinAcknowledgements();
    const onRepairFailure = vi.fn();
    onRoomMembershipRepairFailure(onRepairFailure);
    const roomA = room({ id: 'room-a', name: 'Room A' });
    const roomB = room({ id: 'room-b', name: 'Room B' });

    const joinA = joinRoom(roomA.id);
    const joinB = joinRoom(roomB.id);
    await vi.waitFor(() => expect(joins).toHaveLength(2));
    joins[1].acknowledge({ success: true, room: roomB });
    await joinB;
    joins[0].acknowledge({ success: true, room: roomA });
    await joinA;

    await vi.waitFor(() => expect(joins).toHaveLength(3));
    joins[2].acknowledge({ success: false, error: 'repair one failed' });
    await vi.waitFor(() => expect(joins).toHaveLength(4));
    joins[3].acknowledge({ success: false, error: 'repair two failed' });

    await vi.waitFor(() => {
      expect(onRepairFailure).toHaveBeenCalledWith(roomB.id, expect.objectContaining({ message: 'repair two failed' }));
    });
    expect(joins).toHaveLength(4);
  });
});
