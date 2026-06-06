// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Message } from '../utils/types';
import { MessageItem } from './MessageItem';

const getMediaDownloadUrlMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/socket', () => ({
  clientId: 'viewer',
  getMediaDownloadUrl: getMediaDownloadUrlMock,
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
    getMediaDownloadUrlMock.mockReset();
  });

  it('shows reply context and exposes a touch-accessible reply action', () => {
    const onReply = vi.fn();
    render(
      <MessageItem
        message={message}
        roomPermissions={null}
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

  it('hides edit and delete actions unless the viewer owns the message or can manage all messages', () => {
    const { rerender } = render(
      <MessageItem
        message={message}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    expect(screen.queryByLabelText('editMessage')).toBeNull();
    expect(screen.queryByLabelText('deleteMessage')).toBeNull();

    rerender(
      <MessageItem
        message={message}
        roomPermissions={{
          roomId: 'room-1',
          clientId: 'viewer',
          role: 'owner',
          canPost: true,
          canEditAnyMessage: true,
          canDeleteAnyMessage: true,
          canClearHistory: true,
          canManageRoom: true,
          canManageAdmins: true,
          canTransferOwnership: true,
        }}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    expect(screen.getByLabelText('editMessage')).toBeTruthy();
    expect(screen.getByLabelText('deleteMessage')).toBeTruthy();
  });

  it('shows optimistic pending and failed delivery states', () => {
    const { rerender } = render(
      <MessageItem
        message={{ ...message, clientId: 'viewer', deliveryStatus: 'pending' }}
        roomPermissions={null}
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
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    expect(screen.getByText(/network down/)).toBeTruthy();
  });

  it('loads signed URLs for asset-backed images without using legacy base64 content', async () => {
    getMediaDownloadUrlMock.mockResolvedValue({
      url: 'https://signed.example/rooms/room-1/asset-1.webp',
      expiresAt: '2026-05-03T10:15:00.000Z',
    });

    render(
      <MessageItem
        message={{
          ...message,
          id: 'image-message',
          content: '',
          messageType: 'media',
          mimeType: 'image/webp',
          mediaAsset: {
            id: 'asset-1',
            kind: 'image',
            mimeType: 'image/webp',
            byteSize: 123,
            width: 10,
            height: 20,
          },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(getMediaDownloadUrlMock).toHaveBeenCalledWith({ roomId: 'room-1', assetId: 'asset-1' });
    });
    await waitFor(() => {
      const primaryImage = screen.getAllByAltText('sharedImage')
        .find(element => element.getAttribute('aria-hidden') !== 'true');
      expect(primaryImage?.getAttribute('src')).toBe('https://signed.example/rooms/room-1/asset-1.webp');
    });
  });

  it('renders audio media messages through signed URLs', async () => {
    getMediaDownloadUrlMock.mockResolvedValue({
      url: 'https://signed.example/rooms/room-1/audio-1.webm',
      expiresAt: '2026-05-03T10:15:00.000Z',
    });

    const { container } = render(
      <MessageItem
        message={{
          ...message,
          id: 'audio-message',
          content: '',
          messageType: 'media',
          mediaAsset: {
            id: 'audio-1',
            kind: 'audio',
            mimeType: 'audio/webm',
            byteSize: 456,
            durationMs: 1200,
          },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(getMediaDownloadUrlMock).toHaveBeenCalledWith({ roomId: 'room-1', assetId: 'audio-1' });
    });
    const audio = container.querySelector('audio.roomtalk-audio-player');
    expect(audio).toBeTruthy();
    await waitFor(() => {
      expect(audio?.getAttribute('src')).toBe('https://signed.example/rooms/room-1/audio-1.webm');
    });
    expect(audio?.parentElement?.className).toBe('w-fit max-w-full');
  });
});
