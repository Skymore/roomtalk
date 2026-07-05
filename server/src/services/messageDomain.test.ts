import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyMessageEdit,
  buildAIProviderMessages,
  buildAnthropicMessages,
  createReplyReference,
  createRoomMemberEvent,
  createRoomRecord,
  createUserMessage,
  deleteMessageFromHistory,
  validateRoomNameInput,
} from './messageDomain';
import { Message } from '../types';

const at = new Date('2026-05-03T10:00:00.000Z');

const createMessage = (overrides: Partial<Message> = {}): Message => ({
  id: 'm1',
  clientId: 'client-1',
  content: 'hello',
  roomId: 'room-1',
  timestamp: at.toISOString(),
  messageType: 'text',
  ...overrides,
});

describe('message domain', () => {
  it('creates room records with default description', () => {
    const room = createRoomRecord({ roomId: 'room-1', name: 'General', creatorId: 'client-1', now: at });

    assert.deepEqual(room, {
      id: 'room-1',
      name: 'General',
      description: '',
      createdAt: at.toISOString(),
      lastActivityAt: at.toISOString(),
      creatorId: 'client-1',
    });
  });

  it('initializes code-agent room lifecycle fields when requested', () => {
    const room = createRoomRecord({
      roomId: 'code-agent-1',
      name: 'Code Agent',
      creatorId: 'client-1',
      type: 'codeAgent',
      now: at,
    });

    assert.equal(room.type, 'codeAgent');
    assert.equal(room.sandboxStatus, 'none');
    assert.equal(room.sandboxUpdatedAt, at.toISOString());
    assert.equal(room.codeAgentStatus, 'idle');
  });

  it('validates room names consistently for create and rename flows', () => {
    assert.deepEqual(validateRoomNameInput('  General  '), { ok: true, name: 'General' });
    assert.deepEqual(validateRoomNameInput(''), { ok: false, error: 'Room name is required' });
    assert.deepEqual(validateRoomNameInput('x'.repeat(21)), { ok: false, error: 'Room name cannot exceed 20 characters' });
  });

  it('creates consistent room member events', () => {
    const event = createRoomMemberEvent({ roomId: 'room-1', userId: 'client-1', count: 2, action: 'join', now: at });

    assert.deepEqual(event, {
      roomId: 'room-1',
      user: { id: 'client-1' },
      count: 2,
      action: 'join',
      timestamp: at.toISOString(),
    });
  });

  it('creates user messages with text as the default type', () => {
    const message = createUserMessage({
      id: 'm1',
      clientId: 'client-1',
      roomId: 'room-1',
      content: 'hello',
      username: 'Sky',
      avatar: { text: 'S', color: 'primary' },
      now: at,
    });

    assert.equal(message.messageType, 'text');
    assert.equal(message.timestamp, at.toISOString());
    assert.equal(message.username, 'Sky');
  });

  it('normalizes display names and stores bounded server-created reply references', () => {
    const replyTo = createReplyReference(createMessage({
      id: 'source',
      username: ' Bob\nBuilder ',
      content: ` first line\n${'long '.repeat(40)}`,
    }));
    const message = createUserMessage({
      id: 'm2',
      clientId: 'client-2',
      roomId: 'room-1',
      content: 'reply',
      username: ' Alice\nModerator ',
      replyTo,
      now: at,
    });

    assert.equal(message.username, 'Alice Moderator');
    assert.equal(message.replyTo?.messageId, 'source');
    assert.equal(message.replyTo?.username, 'Bob Builder');
    assert.equal(message.replyTo?.preview.includes('\n'), false);
    assert.ok((message.replyTo?.preview.length || 0) <= 120);
  });

  it('labels file attachments distinctly in reply references and AI context', () => {
    const fileMessage = createMessage({
      id: 'file-message',
      content: '',
      messageType: 'media',
      mediaAsset: {
        id: 'file-asset',
        kind: 'file',
        mimeType: 'text/markdown',
        byteSize: 42,
        filename: 'notes.md',
      },
    });

    const replyReference = createReplyReference(fileMessage);
    assert.equal(replyReference.messageId, 'file-message');
    assert.equal(replyReference.messageType, 'media');
    assert.equal(replyReference.mediaKind, 'file');
    assert.deepEqual(replyReference.mediaAsset, fileMessage.mediaAsset);
    assert.equal(replyReference.preview, '[File attachment]');
    assert.deepEqual(buildAIProviderMessages('system prompt', [fileMessage])[1], {
      role: 'user',
      content: '[Sender: Participant]\n[File attachment]',
    });
  });

  it('edits one message while preserving the rest of history', () => {
    const editedAt = new Date('2026-05-03T10:01:00.000Z');
    const first = createMessage({
      id: 'm1',
      content: 'before',
      timestamp: '2026-05-03T10:00:00.000Z',
      uiPayload: {
        format: 'a2ui',
        version: 'v0.9',
        messages: [{
          version: 'v0.9',
          createSurface: {
            surfaceId: 'surface-1',
            catalogId: 'https://a2ui.org/specification/v0_9/basic_catalog.json',
          },
        }],
      },
    });
    const second = createMessage({ id: 'm2', content: 'untouched' });

    const result = applyMessageEdit([first, second], 'm1', 'after', editedAt);

    assert.equal(result.found, true);
    assert.equal(result.updatedMessage?.content, 'after');
    assert.equal(result.updatedMessage?.timestamp, first.timestamp);
    assert.equal(result.updatedMessage?.updatedAt, editedAt.toISOString());
    assert.equal(result.updatedMessage?.uiPayload, undefined);
    assert.equal(result.messages[1], second);
  });

  it('deletes one message and treats missing deletes as idempotent', () => {
    const first = createMessage({ id: 'm1' });
    const second = createMessage({ id: 'm2' });

    assert.deepEqual(deleteMessageFromHistory([first, second], 'm1').messages.map(message => message.id), ['m2']);

    const missing = deleteMessageFromHistory([first, second], 'missing');
    assert.equal(missing.found, false);
    assert.deepEqual(missing.messages, [first, second]);
  });
});

describe('AI provider messages', () => {
  it('includes display-name and reply context without exposing client IDs', () => {
    const replyTo = createReplyReference(createMessage({
      id: 'source',
      clientId: 'private-client-id',
      username: 'Bob',
      content: 'original question',
    }));
    const result = buildAIProviderMessages('system prompt', [
      createMessage({ id: 'm1', clientId: 'private-client-id', username: 'Alice', content: 'user text', replyTo }),
      createMessage({ id: 'ai1', clientId: 'ai_assistant', content: 'assistant text', messageType: 'ai' }),
      createMessage({ id: 'img1', clientId: 'client-1', username: 'Alice', content: '', messageType: 'media', mimeType: 'image/webp', mediaAsset: { id: 'a1', kind: 'image', mimeType: 'image/webp', byteSize: 1 } }),
      createMessage({ id: 'empty', content: '' }),
    ]);

    assert.equal(result.length, 4);
    assert.deepEqual(result[0], { role: 'system', content: 'system prompt' });
    assert.deepEqual(result[1], {
      role: 'user',
      content: '[Sender: Alice]\n[Replying to Bob: original question]\nuser text',
    });
    assert.deepEqual(result[2], { role: 'assistant', content: 'assistant text' });
    assert.deepEqual(result[3], {
      role: 'user',
      content: '[Sender: Alice]\n[Image attachment]',
    });
    assert.equal(JSON.stringify(result).includes('private-client-id'), false);
  });

  it('includes the same human speaker context for Anthropic messages', () => {
    const result = buildAnthropicMessages([
      createMessage({ username: 'Alice', content: 'hello' }),
      createMessage({ username: 'Alice', content: '', messageType: 'media', mimeType: 'image/webp', mediaAsset: { id: 'a2', kind: 'image', mimeType: 'image/webp', byteSize: 1 } }),
      createMessage({ clientId: 'ai_assistant', content: 'answer', messageType: 'ai' }),
    ]);

    assert.deepEqual(result[0], { role: 'user', content: '[Sender: Alice]\nhello' });
    assert.deepEqual(result[1], {
      role: 'user',
      content: '[Sender: Alice]\n[Image attachment]',
    });
    assert.deepEqual(result[2], { role: 'assistant', content: 'answer' });
  });
});
