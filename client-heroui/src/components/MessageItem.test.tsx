// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Message } from '../utils/types';
import { MessageItem } from './MessageItem';

const getImageDownloadUrlMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/socket', () => ({
  clientId: 'viewer',
  getImageDownloadUrl: getImageDownloadUrlMock,
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
  afterEach(() => {
    cleanup();
    getImageDownloadUrlMock.mockReset();
  });

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

  it('loads signed URLs for asset-backed images without using legacy base64 content', async () => {
    getImageDownloadUrlMock.mockResolvedValue({
      url: 'https://signed.example/rooms/room-1/asset-1.webp',
      expiresAt: '2026-05-03T10:15:00.000Z',
    });

    render(
      <MessageItem
        message={{
          ...message,
          id: 'image-message',
          content: 'asset-1',
          messageType: 'image',
          mimeType: 'image/webp',
          imageAsset: {
            id: 'asset-1',
            mimeType: 'image/webp',
            byteSize: 123,
            width: 10,
            height: 20,
          },
        }}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(getImageDownloadUrlMock).toHaveBeenCalledWith({ roomId: 'room-1', assetId: 'asset-1' });
    });
    await waitFor(() => {
      const primaryImage = screen.getAllByAltText('sharedImage')
        .find(element => element.getAttribute('aria-hidden') !== 'true');
      expect(primaryImage?.getAttribute('src')).toBe('https://signed.example/rooms/room-1/asset-1.webp');
    });
  });

  it('keeps rendering legacy base64 image messages without requesting signed URLs', () => {
    render(
      <MessageItem
        message={{
          ...message,
          id: 'legacy-image',
          content: 'AAAA',
          messageType: 'image',
          mimeType: 'image/png',
        }}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    expect(getImageDownloadUrlMock).not.toHaveBeenCalled();
    const primaryImage = screen.getAllByAltText('sharedImage')
      .find(element => element.getAttribute('aria-hidden') !== 'true');
    expect(primaryImage?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
  });
});
