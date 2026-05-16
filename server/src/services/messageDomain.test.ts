import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyMessageEdit,
  buildAIProviderMessages,
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

  it('initializes Coco room lifecycle fields when requested', () => {
    const room = createRoomRecord({
      roomId: 'coco-1',
      name: 'Coco',
      creatorId: 'client-1',
      type: 'coco',
      now: at,
    });

    assert.equal(room.type, 'coco');
    assert.equal(room.sandboxStatus, 'none');
    assert.equal(room.sandboxUpdatedAt, at.toISOString());
    assert.equal(room.cocoStatus, 'idle');
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

  it('edits one message while preserving the rest of history', () => {
    const editedAt = new Date('2026-05-03T10:01:00.000Z');
    const first = createMessage({ id: 'm1', content: 'before' });
    const second = createMessage({ id: 'm2', content: 'untouched' });

    const result = applyMessageEdit([first, second], 'm1', 'after', editedAt);

    assert.equal(result.found, true);
    assert.equal(result.updatedMessage?.content, 'after');
    assert.equal(result.updatedMessage?.timestamp, editedAt.toISOString());
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
  it('maps text, AI, and image messages into provider format', () => {
    const result = buildAIProviderMessages('system prompt', [
      createMessage({ id: 'm1', clientId: 'client-1', content: 'user text' }),
      createMessage({ id: 'ai1', clientId: 'ai_assistant', content: 'assistant text', messageType: 'ai' }),
      createMessage({ id: 'img1', clientId: 'client-1', content: 'abc123', messageType: 'image', mimeType: 'image/webp' }),
      createMessage({ id: 'empty', content: '' }),
    ]);

    assert.equal(result.length, 4);
    assert.deepEqual(result[0], { role: 'system', content: 'system prompt' });
    assert.deepEqual(result[1], { role: 'user', content: 'user text' });
    assert.deepEqual(result[2], { role: 'assistant', content: 'assistant text' });
    assert.deepEqual(result[3], {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: {
            url: 'data:image/webp;base64,abc123',
            detail: 'auto',
          },
        },
      ],
    });
  });
});
