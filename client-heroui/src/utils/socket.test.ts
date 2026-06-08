// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Message, Room } from './types';

type AckResponse = Record<string, unknown>;

const socketMock = vi.hoisted(() => {
  const handlers = new Map<string, Set<(...args: any[]) => void>>();
  const ackResponses = new Map<string, AckResponse>();
  let nextSocketId = 1;

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
    emit: vi.fn((event: string, _payload?: unknown, callback?: (response: AckResponse) => void) => {
      if (typeof callback === 'function') {
        callback(ackResponses.get(event) || { success: true });
      }
      return socket;
    }),
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
  getMediaDownloadUrl,
  getRoomMemberCount,
  getRoomMembers,
  getSavedRoomsFromServer,
  saveRoomToServer,
  sendMessage,
  sendMessageAndAskAI,
  setUsername,
  unsaveRoomFromServer,
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

describe('socket message acknowledgement helpers', () => {
  beforeEach(() => {
    socketMock.reset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.clearAllMocks();
    localStorage.setItem('clientId', 'client-uuid');
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
        'client-message-1'
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
      { clientId: 'client-uuid', username: undefined },
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
      { clientId: 'client-uuid', username: undefined },
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
      { clientId: 'client-uuid', username: undefined },
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
      })
    ).resolves.toEqual({
      userMessage: savedMessage,
      aiMessageId: 'ai-message-1',
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
      },
      expect.any(Function)
    );
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

    expect(fetchMock).toHaveBeenCalledWith('/api/media/asset-1/download-url?roomId=room-1&clientId=client-uuid');
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
});
