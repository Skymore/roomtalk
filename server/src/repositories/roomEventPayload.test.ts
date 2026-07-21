import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RoomEventType } from '../types';
import { validateStoredRoomEventPayload } from './roomEventPayload';

const ROOM_ID = 'room-1';
const CREATED_AT = '2026-07-21T00:00:00.000Z';

const messageRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'message-1',
  room_id: ROOM_ID,
  client_id: 'client-1',
  client_message_id: null,
  client_batch_id: null,
  client_batch_index: null,
  content: 'hello',
  timestamp: CREATED_AT,
  updated_at: null,
  message_type: 'text',
  username: null,
  avatar: null,
  mime_type: null,
  status: null,
  turn_id: null,
  model_step_id: null,
  model_step_sequence: null,
  tool_call_id: null,
  tool_name: null,
  tool_args: null,
  tool_output_preview: null,
  exit_code: null,
  is_error: null,
  ai_model: null,
  usage: null,
  cost: null,
  reply_to: null,
  ui_payload: null,
  code_agent_mode: null,
  code_agent_queued_input: null,
  code_agent_image_message_ids: null,
  ...overrides,
});

const turnRow = (): Record<string, unknown> => ({
  id: 'turn-1',
  room_id: ROOM_ID,
  status: 'running',
  started_at: CREATED_AT,
  completed_at: null,
  final_message_id: null,
  backend: 'code-agent',
  assistant_name: 'Coco',
  phase: 'running',
  phase_message: null,
  last_heartbeat_at: CREATED_AT,
  updated_at: CREATED_AT,
});

const roomRow = (): Record<string, unknown> => ({
  id: ROOM_ID,
  name: 'Room 1',
  description: '',
  created_at: CREATED_AT,
  last_activity_at: CREATED_AT,
  creator_id: 'client-1',
  has_password: false,
  posting_schedule: null,
  type: 'chat',
  sandbox_id: null,
  sandbox_status: null,
  sandbox_updated_at: null,
  sandbox_artifact_version: null,
  sandbox_code_agent_source_ref: null,
  code_agent_session_id: null,
  code_agent_status: null,
  code_agent_access: null,
  code_agent_mode: null,
  code_agent_backend: null,
  updated_at: CREATED_AT,
});

const expectValid = (eventType: RoomEventType, payload: unknown) => {
  assert.equal(validateStoredRoomEventPayload(eventType, payload, ROOM_ID), null);
};

const expectInvalid = (eventType: RoomEventType, payload: unknown, pattern: RegExp) => {
  const reason = validateStoredRoomEventPayload(eventType, payload, ROOM_ID);
  assert.ok(reason);
  assert.match(reason, pattern);
};

describe('validateStoredRoomEventPayload', () => {
  it('accepts empty-content AI placeholders and media messages', () => {
    expectValid('messages.upserted', {
      messageRows: [
        messageRow({
          id: 'ai-placeholder',
          client_id: 'ai_assistant',
          content: '',
          message_type: 'ai',
          status: 'streaming',
        }),
        messageRow({
          id: 'media-message',
          content: '',
          message_type: 'media',
          mime_type: 'image/png',
        }),
      ],
      mediaAssets: [{
        id: 'asset-1',
        message_id: 'media-message',
        kind: 'image',
        mime_type: 'image/png',
        byte_size: 42,
        filename: 'image.png',
        width: 10,
        height: 20,
        created_at: CREATED_AT,
      }],
    });
  });

  it('accepts every non-message V1 payload', () => {
    const cases: Array<[RoomEventType, unknown]> = [
      ['messages.deleted', { messageIds: ['message-1'], deletedAt: CREATED_AT }],
      ['agent_turns.upserted', { turnRows: [turnRow()] }],
      ['agent_turns.deleted', { turnIds: ['turn-1'], deletedAt: CREATED_AT }],
      ['members.changed', {}],
      ['room.updated', { roomRow: roomRow() }],
      ['room.deleted', { roomId: ROOM_ID, deletedAt: CREATED_AT }],
    ];
    cases.forEach(([eventType, payload]) => expectValid(eventType, payload));
  });

  it('rejects missing and unexpected fields', () => {
    const valid = messageRow();
    const { content: _content, ...missingContent } = valid;
    expectInvalid('messages.upserted', {
      messageRows: [missingContent],
      mediaAssets: [],
    }, /payload\.messageRows\[0\]\.content must be present/);
    expectInvalid('messages.upserted', {
      messageRows: [{ ...valid, internal_secret: 'must-not-escape' }],
      mediaAssets: [],
    }, /payload\.messageRows\[0\]\.internal_secret must be absent/);
  });

  it('rejects a payload row bound to another room', () => {
    expectInvalid('messages.upserted', {
      messageRows: [messageRow({ room_id: 'room-2' })],
      mediaAssets: [],
    }, /payload\.messageRows\[0\]\.room_id must be equal to room-1/);
  });

  it('rejects duplicate message IDs', () => {
    expectInvalid('messages.upserted', {
      messageRows: [messageRow(), messageRow()],
      mediaAssets: [],
    }, /payload\.messageRows must be free of duplicate message IDs/);
  });

  it('rejects the retired messageIds-only upsert payload', () => {
    expectInvalid('messages.upserted', {
      messageIds: ['message-1'],
    }, /payload\.messageIds must be absent|payload\.messageRows must be present/);
  });
});
