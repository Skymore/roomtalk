import { A2UIUpdateEvent, AIChunkEvent, AIStreamEndEvent } from './types';

export type PendingAITransientEvent =
  | { type: 'ai_chunk'; data: AIChunkEvent }
  | { type: 'a2ui_update'; data: A2UIUpdateEvent }
  | { type: 'ai_stream_end'; data: AIStreamEndEvent };

export interface PendingAIEventBufferLimits {
  maxMessageIds: number;
  maxEvents: number;
  maxBytes: number;
  ttlMs: number;
}

export const DEFAULT_PENDING_AI_EVENT_LIMITS: PendingAIEventBufferLimits = {
  maxMessageIds: 64,
  maxEvents: 512,
  maxBytes: 512 * 1024,
  ttlMs: 60_000,
};

type BufferedEvent = {
  event: PendingAITransientEvent;
  bytes: number;
};

type BufferedMessage = {
  events: BufferedEvent[];
  bytes: number;
  expiresAt: number;
};

const serializedBytes = (event: PendingAITransientEvent) => (
  new TextEncoder().encode(JSON.stringify(event)).byteLength
);

export class PendingAIEventBuffer {
  private readonly entries = new Map<string, BufferedMessage>();
  private eventCount = 0;
  private byteCount = 0;

  constructor(private readonly limits: PendingAIEventBufferLimits = DEFAULT_PENDING_AI_EVENT_LIMITS) {}

  enqueue(event: PendingAITransientEvent, now = Date.now()): boolean {
    this.prune(now);
    const messageId = event.data.messageId;
    const bytes = serializedBytes(event);
    if (bytes > this.limits.maxBytes) return false;

    const existing = this.remove(messageId) || { events: [], bytes: 0, expiresAt: 0 };
    existing.events.push({ event, bytes });
    existing.bytes += bytes;
    existing.expiresAt = now + this.limits.ttlMs;

    while (
      existing.events.length > this.limits.maxEvents
      || existing.bytes > this.limits.maxBytes
    ) {
      const removed = existing.events.shift();
      if (!removed) break;
      existing.bytes -= removed.bytes;
    }

    while (this.entries.size >= this.limits.maxMessageIds) this.evictOldest();
    while (
      this.entries.size > 0
      && (
        this.eventCount + existing.events.length > this.limits.maxEvents
        || this.byteCount + existing.bytes > this.limits.maxBytes
      )
    ) {
      this.evictOldest();
    }

    if (existing.events.length === 0) return false;
    this.entries.set(messageId, existing);
    this.eventCount += existing.events.length;
    this.byteCount += existing.bytes;
    return true;
  }

  take(messageId: string, now = Date.now()): PendingAITransientEvent[] {
    this.prune(now);
    return (this.remove(messageId)?.events || []).map(item => item.event);
  }

  clear(): void {
    this.entries.clear();
    this.eventCount = 0;
    this.byteCount = 0;
  }

  private prune(now: number): void {
    Array.from(this.entries.entries()).forEach(([messageId, entry]) => {
      if (entry.expiresAt <= now) this.remove(messageId);
    });
  }

  private evictOldest(): void {
    const oldestMessageId = this.entries.keys().next().value as string | undefined;
    if (oldestMessageId) this.remove(oldestMessageId);
  }

  private remove(messageId: string): BufferedMessage | undefined {
    const entry = this.entries.get(messageId);
    if (!entry) return undefined;
    this.entries.delete(messageId);
    this.eventCount -= entry.events.length;
    this.byteCount -= entry.bytes;
    return entry;
  }
}
