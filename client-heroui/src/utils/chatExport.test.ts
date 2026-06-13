import { describe, expect, it } from 'vitest';
import { buildTranscriptHtml } from './chatExport';
import { Message } from './types';

const baseMessage: Message = {
  id: 'message-1',
  clientId: 'client-1',
  content: 'reply',
  roomId: 'room-1',
  timestamp: '2026-05-03T10:00:00.000Z',
  messageType: 'text',
  username: 'Grace',
};

describe('chat export', () => {
  it('renders quoted image, video, and audio references in transcript HTML', () => {
    const messages: Message[] = [
      {
        ...baseMessage,
        id: 'reply-image',
        replyTo: {
          messageId: 'quoted-image',
          username: 'Ada',
          messageType: 'media',
          mediaKind: 'image',
          preview: '[Image attachment]',
          mediaAsset: {
            id: 'asset-image',
            kind: 'image',
            mimeType: 'image/webp',
            byteSize: 123,
          },
        },
      },
      {
        ...baseMessage,
        id: 'reply-video',
        replyTo: {
          messageId: 'quoted-video',
          username: 'Ada',
          messageType: 'media',
          mediaKind: 'video',
          preview: '[Video attachment]',
          mediaAsset: {
            id: 'asset-video',
            kind: 'video',
            mimeType: 'video/mp4',
            byteSize: 456,
            filename: 'clip.mp4',
          },
        },
      },
      {
        ...baseMessage,
        id: 'reply-audio',
        replyTo: {
          messageId: 'quoted-audio',
          username: 'Ada',
          messageType: 'media',
          mediaKind: 'audio',
          preview: '[Audio attachment]',
          mediaAsset: {
            id: 'asset-audio',
            kind: 'audio',
            mimeType: 'audio/webm',
            byteSize: 789,
          },
        },
      },
    ];
    const mediaByAssetId = new Map([
      ['asset-image', { kind: 'image', src: 'data:image/webp;base64,a', filename: 'quote.webp', mimeType: 'image/webp', byteSize: 123 }],
      ['asset-video', { kind: 'video', src: 'media/clip.mp4', filename: 'clip.mp4', mimeType: 'video/mp4', byteSize: 456 }],
      ['asset-audio', { kind: 'audio', src: 'media/voice.webm', filename: 'voice.webm', mimeType: 'audio/webm', byteSize: 789 }],
    ]);

    const html = buildTranscriptHtml({ id: 'room-1', name: 'Room' }, messages, mediaByAssetId);

    expect(html).toContain('Replying to Ada');
    expect(html).toContain('<img class="media-image" src="data:image/webp;base64,a"');
    expect(html).toContain('<video class="media-video" controls src="media/clip.mp4"');
    expect(html).toContain('<audio controls src="media/voice.webm"');
  });
});
