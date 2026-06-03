// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Message } from './types';

type AckResponse = Record<string, unknown>;

const socketMock = vi.hoisted(() => {
  const handlers = new Map<string, Set<(...args: any[]) => void>>();
  const ackResponses = new Map<string, AckResponse>();

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
      socket.connected = true;
    },
  };

  return socket;
});

vi.mock('socket.io-client', () => ({
  default: vi.fn(() => socketMock),
  Socket: class SocketMock {},
}));

vi.mock('uuid', () => ({
  v4: () => 'client-uuid',
}));

const { getImageDownloadUrl, sendMessage, sendMessageAndAskAI } = await import('./socket');

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'm1',
  clientId: 'client-uuid',
  content: 'hello',
  roomId: 'room-1',
  timestamp: '2026-05-03T10:00:00.000Z',
  messageType: 'text',
  ...overrides,
});

describe('socket message acknowledgement helpers', () => {
  beforeEach(() => {
    socketMock.reset();
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

  it('returns signed image download URLs from get_image_download_url acknowledgements', async () => {
    socketMock.ackResponses.set('get_image_download_url', {
      success: true,
      url: 'https://signed.example/image.webp',
      expiresAt: '2026-05-03T00:15:00.000Z',
    });

    await expect(getImageDownloadUrl({ roomId: 'room-1', assetId: 'asset-1' })).resolves.toEqual({
      url: 'https://signed.example/image.webp',
      expiresAt: '2026-05-03T00:15:00.000Z',
    });

    expect(socketMock.emit).toHaveBeenCalledWith(
      'get_image_download_url',
      {
        roomId: 'room-1',
        assetId: 'asset-1',
      },
      expect.any(Function)
    );
  });
});
