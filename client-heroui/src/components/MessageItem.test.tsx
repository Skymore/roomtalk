// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Message } from '../utils/types';
import { MessageItem } from './MessageItem';

const getMediaDownloadUrlMock = vi.hoisted(() => vi.fn());
const getRoomMediaHistoryMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/socket', () => ({
  clientId: 'viewer',
  getMediaDownloadUrl: getMediaDownloadUrlMock,
  getRoomMediaHistory: getRoomMediaHistoryMock,
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
  beforeEach(() => {
    getRoomMediaHistoryMock.mockResolvedValue({
      roomId: 'room-1',
      items: [],
      hasMore: false,
      nextCursor: null,
      windowMonths: 6,
    });
  });

  afterEach(() => {
    cleanup();
    getMediaDownloadUrlMock.mockReset();
    getRoomMediaHistoryMock.mockReset();
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

  it('opens asset-backed images in the full-screen media viewer', async () => {
    getMediaDownloadUrlMock.mockResolvedValue({
      url: 'https://signed.example/rooms/room-1/asset-1.webp',
      expiresAt: '2026-05-03T10:15:00.000Z',
    });

    render(
      <MessageItem
        message={{
          ...message,
          id: 'image-viewer-message',
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
      expect(screen.getAllByLabelText('openMediaViewer').length).toBeGreaterThan(0);
    });
    expect(screen.queryByLabelText('downloadMedia')).toBeNull();
    expect(screen.queryByLabelText('shareMedia')).toBeNull();

    fireEvent.click(screen.getAllByLabelText('openMediaViewer')[0]);

    expect(screen.getByRole('dialog', { name: 'mediaViewer' })).toBeTruthy();
    expect(screen.getAllByLabelText('downloadMedia').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('openMediaHistory').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('shareMedia').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByLabelText('close'));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'mediaViewer' })).toBeNull();
    });
  });

  it('opens recent room media history and returns from preview to the grid', async () => {
    getMediaDownloadUrlMock.mockResolvedValue({
      url: 'https://signed.example/rooms/room-1/asset-1.webp',
      expiresAt: '2026-05-03T10:15:00.000Z',
    });
    getRoomMediaHistoryMock.mockResolvedValue({
      roomId: 'room-1',
      items: [{
        assetId: 'asset-2',
        messageId: 'media-message-2',
        kind: 'image',
        mimeType: 'image/webp',
        byteSize: 456,
        createdAt: '2026-06-01T10:00:00.000Z',
        url: 'https://signed.example/rooms/room-1/asset-2.webp',
      }],
      hasMore: false,
      nextCursor: null,
      windowMonths: 6,
    });

    render(
      <MessageItem
        message={{
          ...message,
          id: 'image-history-message',
          content: '',
          messageType: 'media',
          mimeType: 'image/webp',
          mediaAsset: {
            id: 'asset-1',
            kind: 'image',
            mimeType: 'image/webp',
            byteSize: 123,
          },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByLabelText('openMediaViewer').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByLabelText('openMediaViewer')[0]);
    fireEvent.click(screen.getByLabelText('openMediaHistory'));

    await waitFor(() => {
      expect(getRoomMediaHistoryMock).toHaveBeenCalledWith({ roomId: 'room-1', before: null, limit: 36 });
    });
    expect(screen.getByText('mediaHistoryRecentMonths')).toBeTruthy();
    expect(screen.getByLabelText('openMediaItem')).toBeTruthy();
    expect(screen.getByLabelText('closeMediaHistory')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('openMediaItem'));
    await waitFor(() => {
      expect(screen.getByLabelText('backToMediaHistory')).toBeTruthy();
    });
    const viewerImages = screen.getAllByAltText('sharedImage');
    expect(viewerImages.some(element => element.getAttribute('src') === 'https://signed.example/rooms/room-1/asset-2.webp')).toBe(true);

    const historyPreviewImage = document.body.querySelector('[data-testid="history-media-stage"] [data-active-media="true"] img');
    expect(historyPreviewImage).toBeTruthy();
    fireEvent.click(historyPreviewImage as Element);
    await waitFor(() => {
      expect(screen.queryByLabelText('backToMediaHistory')).toBeNull();
    });
    expect(screen.getByText('mediaHistoryRecentMonths')).toBeTruthy();

    expect(screen.queryByLabelText('closeMediaHistory')).toBeNull();
    const historySection = screen.getByRole('region', { name: 'mediaHistory' });
    fireEvent.click(within(historySection).getByLabelText('close'));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'mediaViewer' })).toBeNull();
    });
  });

  it('orders media history from oldest to newest so latest appears last', async () => {
    getMediaDownloadUrlMock.mockResolvedValue({
      url: 'https://signed.example/rooms/room-1/asset-current.webp',
      expiresAt: '2026-05-03T10:15:00.000Z',
    });
    getRoomMediaHistoryMock.mockResolvedValue({
      roomId: 'room-1',
      items: [
        {
          assetId: 'asset-new',
          messageId: 'media-message-new',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: 456,
          createdAt: '2026-06-01T10:00:00.000Z',
          url: 'https://signed.example/rooms/room-1/asset-new.webp',
        },
        {
          assetId: 'asset-middle',
          messageId: 'media-message-middle',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: 456,
          createdAt: '2026-05-03T10:00:00.000Z',
          url: 'https://signed.example/rooms/room-1/asset-middle.webp',
        },
        {
          assetId: 'asset-old',
          messageId: 'media-message-old',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: 456,
          createdAt: '2026-05-01T10:00:00.000Z',
          url: 'https://signed.example/rooms/room-1/asset-old.webp',
        },
      ],
      hasMore: false,
      nextCursor: null,
      windowMonths: 6,
    });

    render(
      <MessageItem
        message={{
          ...message,
          id: 'image-history-order-message',
          content: '',
          messageType: 'media',
          mimeType: 'image/webp',
          mediaAsset: {
            id: 'asset-current',
            kind: 'image',
            mimeType: 'image/webp',
            byteSize: 123,
          },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByLabelText('openMediaViewer').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByLabelText('openMediaViewer')[0]);
    fireEvent.click(screen.getByLabelText('openMediaHistory'));

    await waitFor(() => {
      const images = Array.from(document.body.querySelectorAll('[aria-label="openMediaItem"] img'));
      expect(images.map(image => image.getAttribute('src'))).toEqual([
        'https://signed.example/rooms/room-1/asset-old.webp',
        'https://signed.example/rooms/room-1/asset-middle.webp',
        'https://signed.example/rooms/room-1/asset-new.webp',
      ]);
    });
  });

  it('filters media history by video in the viewer', async () => {
    getMediaDownloadUrlMock.mockResolvedValue({
      url: 'https://signed.example/rooms/room-1/asset-current.webp',
      expiresAt: '2026-05-03T10:15:00.000Z',
    });
    getRoomMediaHistoryMock
      .mockResolvedValueOnce({
        roomId: 'room-1',
        items: [{
          assetId: 'asset-image',
          messageId: 'media-message-image',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: 456,
          createdAt: '2026-06-01T10:00:00.000Z',
          url: 'https://signed.example/rooms/room-1/asset-image.webp',
        }],
        hasMore: false,
        nextCursor: null,
        windowMonths: 6,
      })
      .mockResolvedValueOnce({
        roomId: 'room-1',
        items: [{
          assetId: 'asset-video',
          messageId: 'media-message-video',
          kind: 'video',
          mimeType: 'video/mp4',
          byteSize: 789,
          createdAt: '2026-06-02T10:00:00.000Z',
          url: 'https://signed.example/rooms/room-1/asset-video.mp4?token=abc',
        }],
        hasMore: false,
        nextCursor: null,
        windowMonths: 6,
      });

    render(
      <MessageItem
        message={{
          ...message,
          id: 'image-history-filter-message',
          content: '',
          messageType: 'media',
          mimeType: 'image/webp',
          mediaAsset: {
            id: 'asset-current',
            kind: 'image',
            mimeType: 'image/webp',
            byteSize: 123,
          },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByLabelText('openMediaViewer').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByLabelText('openMediaViewer')[0]);
    fireEvent.click(screen.getByLabelText('openMediaHistory'));

    await waitFor(() => {
      expect(getRoomMediaHistoryMock).toHaveBeenCalledWith({ roomId: 'room-1', before: null, limit: 36 });
    });

    fireEvent.click(screen.getByText('mediaHistoryFilterVideos'));

    await waitFor(() => {
      expect(getRoomMediaHistoryMock).toHaveBeenCalledWith({ roomId: 'room-1', before: null, limit: 36, kind: 'video' });
    });
    const historyVideo = document.body.querySelector('[aria-label="openMediaItem"] video');
    expect(historyVideo?.getAttribute('src')).toBe('https://signed.example/rooms/room-1/asset-video.mp4?token=abc#t=0.001');
  });

  it('swipes between room media from a single expanded image', async () => {
    getMediaDownloadUrlMock.mockResolvedValue({
      url: 'https://signed.example/rooms/room-1/asset-1.webp',
      expiresAt: '2026-05-03T10:15:00.000Z',
    });
    getRoomMediaHistoryMock.mockResolvedValue({
      roomId: 'room-1',
      items: [
        {
          assetId: 'asset-3',
          messageId: 'media-message-3',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: 456,
          createdAt: '2026-06-01T10:00:00.000Z',
          url: 'https://signed.example/rooms/room-1/asset-3.webp',
        },
        {
          assetId: 'asset-1',
          messageId: 'media-message-1',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: 123,
          createdAt: '2026-05-03T10:00:00.000Z',
          url: 'https://signed.example/rooms/room-1/asset-1.webp',
        },
        {
          assetId: 'asset-2',
          messageId: 'media-message-2',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: 456,
          createdAt: '2026-05-01T10:00:00.000Z',
          url: 'https://signed.example/rooms/room-1/asset-2.webp',
        },
      ],
      hasMore: false,
      nextCursor: null,
      windowMonths: 6,
    });

    render(
      <MessageItem
        message={{
          ...message,
          id: 'image-swipe-message',
          content: '',
          messageType: 'media',
          mimeType: 'image/webp',
          mediaAsset: {
            id: 'asset-1',
            kind: 'image',
            mimeType: 'image/webp',
            byteSize: 123,
          },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByLabelText('openMediaViewer').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByLabelText('openMediaViewer')[0]);
    await waitFor(() => {
      expect(getRoomMediaHistoryMock).toHaveBeenCalledWith({ roomId: 'room-1', before: null, limit: 36 });
    });
    await waitFor(() => {
      expect(screen.getByLabelText('nextMedia')).toBeTruthy();
    });

    const stage = screen.getByTestId('media-viewer-stage');
    const track = screen.getByTestId('media-carousel-track');
    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(track, 'clientWidth', { configurable: true, value: 300 });

    fireEvent.mouseDown(stage, { clientX: 320, clientY: 220 });
    fireEvent.mouseMove(stage, { clientX: 20, clientY: 224 });
    await waitFor(() => {
      expect(track.getAttribute('style')).toContain('translate3d(-600px, 0, 0)');
    });
    fireEvent.mouseUp(stage, { clientX: 20, clientY: 224 });
    await waitFor(() => {
      const activeImage = document.body.querySelector('[data-testid="media-viewer-stage"] [data-active-media="true"] img');
      expect(activeImage?.getAttribute('src')).toBe('https://signed.example/rooms/room-1/asset-3.webp');
    });

    fireEvent.mouseDown(stage, { clientX: 120, clientY: 220 });
    fireEvent.mouseUp(stage, { clientX: 320, clientY: 224 });
    await waitFor(() => {
      const activeImage = document.body.querySelector('[data-testid="media-viewer-stage"] [data-active-media="true"] img');
      expect(activeImage?.getAttribute('src')).toBe('https://signed.example/rooms/room-1/asset-1.webp');
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

  it('renders videos as tap-to-open previews and plays them inside the media viewer', async () => {
    getMediaDownloadUrlMock.mockResolvedValue({
      url: 'https://signed.example/rooms/room-1/video-1.mp4?X-Amz-Signature=abc123',
      expiresAt: '2026-05-03T10:15:00.000Z',
    });

    const { container } = render(
      <MessageItem
        message={{
          ...message,
          id: 'video-message',
          content: '',
          messageType: 'media',
          mediaAsset: {
            id: 'video-1',
            kind: 'video',
            mimeType: 'video/mp4',
            byteSize: 789,
            durationMs: 2400,
          },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(getMediaDownloadUrlMock).toHaveBeenCalledWith({ roomId: 'room-1', assetId: 'video-1' });
    });

    const inlineVideo = container.querySelector('video');
    expect(inlineVideo?.getAttribute('src')).toBe('https://signed.example/rooms/room-1/video-1.mp4?X-Amz-Signature=abc123#t=0.001');
    expect(inlineVideo?.hasAttribute('controls')).toBe(false);

    fireEvent.click(screen.getAllByLabelText('openMediaViewer')[0]);

    const viewerVideo = await waitFor(() => {
      const video = document.body.querySelector('[role="dialog"] video');
      expect(video).toBeTruthy();
      return video;
    });
    expect(viewerVideo?.getAttribute('src')).toBe('https://signed.example/rooms/room-1/video-1.mp4?X-Amz-Signature=abc123#t=0.001');
    expect(viewerVideo?.hasAttribute('controls')).toBe(true);
  });
});
