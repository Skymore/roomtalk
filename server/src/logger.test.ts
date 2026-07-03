import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { Logger } from './logger';

describe('Logger.formatMessageForLog', () => {
  it('redacts message content and reply previews', () => {
    const logger = new Logger('LoggerTest');
    const message = {
      id: 'message-1',
      clientId: 'client-1',
      roomId: 'room-1',
      messageType: 'text',
      content: 'private chat text',
      replyTo: {
        messageId: 'quoted-1',
        username: 'Ada',
        messageType: 'text',
        preview: 'quoted private text',
      },
    };

    const result = logger.formatMessageForLog(message);

    assert.equal(result.content, undefined);
    assert.equal(result.hasContent, true);
    assert.equal(result.contentLength, 'private chat text'.length);
    assert.equal(result.replyTo.preview, undefined);
    assert.equal(result.replyTo.hasPreview, true);
    assert.equal(result.replyTo.previewLength, 'quoted private text'.length);
    assert.equal(message.content, 'private chat text');
    assert.equal(message.replyTo.preview, 'quoted private text');
  });

  it('keeps media metadata without logging captions', () => {
    const logger = new Logger('LoggerTest');
    const result = logger.formatMessageForLog({
      id: 'message-1',
      clientId: 'client-1',
      roomId: 'room-1',
      messageType: 'media',
      content: 'private image caption',
      mediaAsset: {
        id: 'asset-1',
        kind: 'image',
        mimeType: 'image/png',
        byteSize: 1234,
        objectKey: 'rooms/room-1/private-object-key',
      },
    });

    assert.equal(result.content, undefined);
    assert.equal(result.hasContent, true);
    assert.equal(result.contentLength, 'private image caption'.length);
    assert.deepEqual(result.mediaAsset, {
      id: 'asset-1',
      kind: 'image',
      mimeType: 'image/png',
      byteSize: 1234,
    });
  });
});
