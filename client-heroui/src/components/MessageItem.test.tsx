// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Message } from '../utils/types';
import { MessageItem } from './MessageItem';

vi.mock('../utils/socket', () => ({
  clientId: 'viewer',
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) => values?.name ? `${key}:${values.name}` : key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('./MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => <span>{content}</span>,
}));

const message = {
  id: 'reply',
  clientId: 'sender',
  username: 'Grace',
  content: 'follow up',
  roomId: 'room-1',
  timestamp: '2026-05-03T10:00:00.000Z',
  messageType: 'text',
  replyTo: {
    messageId: 'quoted',
    username: 'Ada',
    messageType: 'text',
    preview: 'original question',
  },
} as Message;

describe('MessageItem replies', () => {
  afterEach(cleanup);

  it('shows reply context and exposes a touch-accessible reply action', () => {
    const onReply = vi.fn();
    render(
      <MessageItem
        message={message}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={onReply}
      />
    );

    expect(screen.getByText('replyingTo:Ada')).toBeTruthy();
    expect(screen.getByText('original question')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('replyToMessage'));
    expect(onReply).toHaveBeenCalledWith(message);
  });

  it('shows optimistic pending and failed delivery states', () => {
    const { rerender } = render(
      <MessageItem
        message={{ ...message, clientId: 'viewer', deliveryStatus: 'pending' }}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    expect(screen.getByText(/messageSending/)).toBeTruthy();

    rerender(
      <MessageItem
        message={{
          ...message,
          clientId: 'viewer',
          deliveryStatus: 'failed',
          deliveryError: 'network down',
        }}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    expect(screen.getByText(/network down/)).toBeTruthy();
  });
});
