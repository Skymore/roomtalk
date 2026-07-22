import assert from 'assert/strict';
import { describe, it } from 'node:test';
import {
  ASSISTANT_RUN_TRANSIENT_CHANNEL,
  RedisAssistantRunEventPublisher,
  decodeAssistantRunEventEnvelope,
} from './assistantRunEvents';

describe('assistant run transient event bridge', () => {
  it('publishes a versioned, target-scoped envelope without copying queue state', async () => {
    const published: unknown[][] = [];
    const publisher = new RedisAssistantRunEventPublisher({
      publish: async (...args: unknown[]) => {
        published.push(args);
        return 1;
      },
    } as any);

    await publisher.emit({ kind: 'room', id: 'room-1' }, 'ai_chunk', {
      roomId: 'room-1',
      messageId: 'message-1',
      runId: 'run-1',
      generation: 2,
      chunkSeq: 3,
      chunk: 'hello',
    });

    assert.equal(published[0][0], ASSISTANT_RUN_TRANSIENT_CHANNEL);
    assert.deepEqual(decodeAssistantRunEventEnvelope(published[0][1] as string), {
      schemaVersion: 1,
      target: { kind: 'room', id: 'room-1' },
      event: 'ai_chunk',
      payload: {
        roomId: 'room-1',
        messageId: 'message-1',
        runId: 'run-1',
        generation: 2,
        chunkSeq: 3,
        chunk: 'hello',
      },
    });
  });

  it('rejects unknown events, extra envelope fields, and oversized payloads', () => {
    assert.equal(decodeAssistantRunEventEnvelope(JSON.stringify({
      schemaVersion: 1,
      target: { kind: 'room', id: 'room-1' },
      event: 'internal_secret',
      payload: {},
    })), null);
    assert.equal(decodeAssistantRunEventEnvelope(JSON.stringify({
      schemaVersion: 1,
      target: { kind: 'room', id: 'room-1' },
      event: 'ai_chunk',
      payload: {},
      secret: 'not allowed',
    })), null);
    assert.equal(decodeAssistantRunEventEnvelope('x'.repeat(513 * 1024)), null);
  });
});
