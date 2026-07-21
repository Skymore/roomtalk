import { describe, expect, it } from 'vitest';
import { PendingAIEventBuffer } from './pendingAIEventBuffer';

const chunk = (messageId: string, value: string) => ({
  type: 'ai_chunk' as const,
  data: { roomId: 'room-1', messageId, chunk: value },
});

describe('PendingAIEventBuffer', () => {
  it('preserves transient event order until the durable placeholder arrives', () => {
    const buffer = new PendingAIEventBuffer();
    buffer.enqueue(chunk('ai-1', 'one'), 1_000);
    buffer.enqueue(chunk('ai-1', 'two'), 1_001);

    expect(buffer.take('ai-1', 1_002)).toEqual([
      chunk('ai-1', 'one'),
      chunk('ai-1', 'two'),
    ]);
    expect(buffer.take('ai-1', 1_003)).toEqual([]);
  });

  it('expires unmatched events instead of retaining them indefinitely', () => {
    const buffer = new PendingAIEventBuffer({
      maxMessageIds: 2,
      maxEvents: 2,
      maxBytes: 1_024,
      ttlMs: 100,
    });
    buffer.enqueue(chunk('ai-1', 'expired'), 1_000);

    expect(buffer.take('ai-1', 1_100)).toEqual([]);
  });

  it('enforces message, event, and byte bounds by evicting the oldest data', () => {
    const buffer = new PendingAIEventBuffer({
      maxMessageIds: 2,
      maxEvents: 2,
      maxBytes: 240,
      ttlMs: 1_000,
    });
    buffer.enqueue(chunk('ai-1', 'first'), 1_000);
    buffer.enqueue(chunk('ai-2', 'second'), 1_001);
    buffer.enqueue(chunk('ai-3', 'third'), 1_002);

    expect(buffer.take('ai-1', 1_003)).toEqual([]);
    expect(buffer.take('ai-2', 1_003)).toEqual([chunk('ai-2', 'second')]);
    expect(buffer.take('ai-3', 1_003)).toEqual([chunk('ai-3', 'third')]);
  });
});
