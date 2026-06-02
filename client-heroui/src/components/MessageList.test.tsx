// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Message } from '../utils/types';
import { MessageList, MessageListHandle } from './MessageList';

const socketMock = vi.hoisted(() => {
  const handlers = new Map<string, Set<(...args: any[]) => void>>();

  return {
    id: 'socket-1',
    handlers,
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      const eventHandlers = handlers.get(event) || new Set();
      eventHandlers.add(handler);
      handlers.set(event, eventHandlers);
    }),
    off: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.get(event)?.delete(handler);
    }),
    emit: vi.fn(),
    trigger: (event: string, ...args: any[]) => {
      handlers.get(event)?.forEach(handler => handler(...args));
    },
    reset: () => {
      handlers.clear();
    },
  };
});

vi.mock('../utils/socket', () => ({
  socket: socketMock,
  clientId: 'client-1',
  requestAIResponse: vi.fn(),
  requestEditMessageAndAIResponse: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@iconify/react', () => ({
  Icon: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

vi.mock('./MessageItem', () => ({
  MessageItem: ({ message }: { message: Message }) => (
    <div
      data-testid="message-item"
      data-message-id={message.id}
      data-client-message-id={message.clientMessageId || ''}
      data-delivery-status={message.deliveryStatus || ''}
      data-delivery-error={message.deliveryError || ''}
    >
      {message.content}
    </div>
  ),
}));

vi.mock('./DeleteConfirmationModal', () => ({
  DeleteConfirmationModal: () => null,
}));

vi.mock('./EditMessageModal', () => ({
  EditMessageModal: () => null,
}));

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'm1',
  clientId: 'client-1',
  content: 'hello',
  roomId: 'room-1',
  timestamp: '2026-05-03T10:00:00.000Z',
  messageType: 'text',
  ...overrides,
});

describe('MessageList optimistic messages', () => {
  beforeEach(() => {
    socketMock.reset();
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows pending messages and replaces matching server messages without duplicates', async () => {
    const ref = createRef<MessageListHandle>();
    render(<MessageList ref={ref} roomId="room-1" onReply={vi.fn()} />);

    act(() => {
      socketMock.trigger('message_history', []);
    });

    const pending = message({
      id: 'temp-client-message-1',
      content: 'pending text',
      clientMessageId: 'client-message-1',
      deliveryStatus: 'pending',
    });

    act(() => {
      ref.current?.addOptimisticMessage(pending);
      ref.current?.addOptimisticMessage(pending);
    });

    expect(await screen.findByText('pending text')).toBeTruthy();
    expect(screen.getAllByTestId('message-item')).toHaveLength(1);
    expect(screen.getByTestId('message-item').getAttribute('data-delivery-status')).toBe('pending');

    const saved = message({
      id: 'server-message-1',
      content: 'saved text',
      clientMessageId: 'client-message-1',
    });

    act(() => {
      socketMock.trigger('new_message', saved);
      socketMock.trigger('new_message', saved);
    });

    await waitFor(() => {
      expect(screen.getByText('saved text')).toBeTruthy();
    });
    expect(screen.queryByText('pending text')).toBeNull();
    expect(screen.getAllByTestId('message-item')).toHaveLength(1);
    expect(screen.getByTestId('message-item').getAttribute('data-message-id')).toBe('server-message-1');
    expect(screen.getByTestId('message-item').getAttribute('data-delivery-status')).toBe('sent');
  });

  it('can mark pending messages as failed', async () => {
    const ref = createRef<MessageListHandle>();
    render(<MessageList ref={ref} roomId="room-1" onReply={vi.fn()} />);

    act(() => {
      socketMock.trigger('message_history', []);
      ref.current?.addOptimisticMessage(message({
        id: 'temp-client-message-2',
        content: 'will fail',
        clientMessageId: 'client-message-2',
        deliveryStatus: 'pending',
      }));
    });

    act(() => {
      ref.current?.markOptimisticMessageFailed('client-message-2', 'network down');
    });

    expect(await screen.findByText('will fail')).toBeTruthy();
    expect(screen.getByTestId('message-item').getAttribute('data-delivery-status')).toBe('failed');
    expect(screen.getByTestId('message-item').getAttribute('data-delivery-error')).toBe('network down');
  });

  it('renders a recent message window and can load older messages', async () => {
    render(<MessageList roomId="room-1" onReply={vi.fn()} />);

    const history = Array.from({ length: 85 }, (_, index) => {
      const messageNumber = index + 1;
      return message({
        id: `m-${messageNumber}`,
        content: `message ${messageNumber}`,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      });
    });

    act(() => {
      socketMock.trigger('message_history', history);
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('message-item')).toHaveLength(80);
    });
    expect(screen.queryByText('message 1')).toBeNull();
    expect(screen.getByText('message 6')).toBeTruthy();
    expect(screen.getByText('message 85')).toBeTruthy();

    fireEvent.click(screen.getByText('loadMoreMessages'));

    await waitFor(() => {
      expect(screen.getAllByTestId('message-item')).toHaveLength(85);
    });
    expect(screen.getByText('message 1')).toBeTruthy();
  });
});
