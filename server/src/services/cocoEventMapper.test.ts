import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapCocoRunnerEvent } from './cocoEventMapper';

const now = new Date('2026-05-16T10:00:00.000Z');
const context = {
  roomId: 'room-1',
  turnId: 'turn-1',
  now,
  createMessageId: (prefix: string) => `${prefix}_id`,
};

describe('Coco runner event mapper', () => {
  it('maps text deltas without creating persisted messages', () => {
    const mapped = mapCocoRunnerEvent({
      schemaVersion: 1,
      type: 'text_delta',
      messageId: 'ai-1',
      delta: 'hello',
    }, context);

    assert.deepEqual(mapped, { kind: 'ai_delta', messageId: 'ai-1', delta: 'hello' });
  });

  it('maps tool calls into message drafts', () => {
    const mapped = mapCocoRunnerEvent({
      schemaVersion: 1,
      type: 'tool_call',
      id: 'tool-1',
      name: 'Read',
      args: { file_path: 'README.md' },
    }, context);

    assert.equal(mapped.kind, 'message');
    if (mapped.kind !== 'message') return;
    assert.equal(mapped.message.id, 'tool-1');
    assert.equal(mapped.message.messageType, 'tool_call');
    assert.equal(mapped.message.toolCallId, 'tool-1');
    assert.equal(mapped.message.toolName, 'Read');
    assert.deepEqual(mapped.message.toolArgs, { file_path: 'README.md' });
  });

  it('maps failed tool results into error message drafts with truncated output', () => {
    const mapped = mapCocoRunnerEvent({
      schemaVersion: 1,
      type: 'tool_result',
      id: 'tool-1',
      name: 'Shell',
      success: false,
      output: 'x'.repeat(5000),
      exitCode: 1,
      truncated: true,
    }, context);

    assert.equal(mapped.kind, 'message');
    if (mapped.kind !== 'message') return;
    assert.equal(mapped.message.id, 'tool_result_tool-1_id');
    assert.equal(mapped.message.messageType, 'tool_result');
    assert.equal(mapped.message.status, 'error');
    assert.equal(mapped.message.isError, true);
    assert.equal(mapped.message.exitCode, 1);
    assert.equal(mapped.message.content.includes('[display truncated]'), true);
    assert.equal(mapped.message.content.includes('[output truncated by runner]'), true);
    assert.equal(mapped.message.content.length < 5000, true);
  });

  it('maps status events', () => {
    const starting = mapCocoRunnerEvent({
      schemaVersion: 1,
      type: 'status',
      turnId: 'turn-1',
      status: 'starting',
      message: 'starting sandbox',
    }, context);
    assert.equal(starting.kind, 'message');
    if (starting.kind !== 'message') return;
    assert.equal(starting.message.messageType, 'sandbox_status');
    assert.equal(starting.message.status, 'complete');
    assert.equal(starting.message.content, 'starting sandbox');

    const running = mapCocoRunnerEvent({
      schemaVersion: 1,
      type: 'status',
      turnId: 'turn-1',
      status: 'running',
    }, context);
    assert.deepEqual(running, { kind: 'ignored' });

    const ready = mapCocoRunnerEvent({
      schemaVersion: 1,
      type: 'status',
      turnId: 'turn-1',
      status: 'ready',
    }, context);
    assert.deepEqual(ready, { kind: 'ignored' });

    const complete = mapCocoRunnerEvent({
      schemaVersion: 1,
      type: 'status',
      turnId: 'turn-1',
      status: 'complete',
    }, context);
    assert.deepEqual(complete, { kind: 'ignored' });

    const startingWithoutMessage = mapCocoRunnerEvent({
      schemaVersion: 1,
      type: 'status',
      turnId: 'turn-1',
      status: 'starting',
    }, context);
    assert.equal(startingWithoutMessage.kind, 'message');
    if (startingWithoutMessage.kind !== 'message') return;
    assert.equal(startingWithoutMessage.message.content, 'starting');

    const error = mapCocoRunnerEvent({
      schemaVersion: 1,
      type: 'status',
      turnId: 'turn-1',
      status: 'error',
      message: 'sandbox failed',
    }, context);
    assert.equal(error.kind, 'message');
    if (error.kind !== 'message') return;
    assert.equal(error.message.status, 'error');
    assert.equal(error.message.isError, true);
  });

  it('maps successful tool results into complete message drafts', () => {
    const mapped = mapCocoRunnerEvent({
      schemaVersion: 1,
      type: 'tool_result',
      id: 'tool-2',
      name: 'Read',
      success: true,
      output: 'ok',
      exitCode: 0,
    }, context);

    assert.equal(mapped.kind, 'message');
    if (mapped.kind !== 'message') return;
    assert.equal(mapped.message.messageType, 'tool_result');
    assert.equal(mapped.message.status, 'complete');
    assert.equal(mapped.message.isError, false);
    assert.equal(mapped.message.content, 'ok');
    assert.equal(mapped.message.toolOutputPreview, 'ok');
  });

  it('maps final events and runner errors', () => {
    const final = mapCocoRunnerEvent({
      schemaVersion: 1,
      type: 'final',
      messageId: 'ai-1',
      answer: 'done',
      sessionId: 'session-1',
    }, context);
    assert.deepEqual(final, {
      kind: 'final',
      messageId: 'ai-1',
      answer: 'done',
      sessionId: 'session-1',
      usage: undefined,
    });

    const error = mapCocoRunnerEvent({
      schemaVersion: 1,
      type: 'error',
      message: 'runner exited',
    }, context);
    assert.equal(error.kind, 'message');
    if (error.kind !== 'message') return;
    assert.equal(error.message.messageType, 'sandbox_status');
    assert.equal(error.message.status, 'error');
    assert.equal(error.message.content, 'runner exited');
  });
});
