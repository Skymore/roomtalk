import type { AITransientStreamIdentity } from './types';

interface ActiveStream {
  runId: string;
  generation: number;
  lastChunkSeq: number;
}

export type AITransientStreamDecision =
  | { accepted: true; resetMessage: boolean }
  | { accepted: false; conflict: boolean };

type StreamIdentity =
  | { kind: 'legacy' }
  | { kind: 'invalid' }
  | { kind: 'modern'; stream: ActiveStream };

const readIdentity = (event: AITransientStreamIdentity): StreamIdentity => {
  const hasRunId = event.runId !== undefined;
  const hasGeneration = event.generation !== undefined;
  const hasChunkSeq = event.chunkSeq !== undefined;
  if (!hasRunId && !hasGeneration && !hasChunkSeq) return { kind: 'legacy' };
  if (
    typeof event.runId !== 'string'
    || event.runId.length === 0
    || !Number.isSafeInteger(event.generation)
    || Number(event.generation) <= 0
    || !Number.isSafeInteger(event.chunkSeq)
    || Number(event.chunkSeq) <= 0
  ) {
    return { kind: 'invalid' };
  }
  return {
    kind: 'modern',
    stream: {
      runId: event.runId,
      generation: Number(event.generation),
      lastChunkSeq: Number(event.chunkSeq),
    },
  };
};

/**
 * Filters transient AI events by the durable run's claim generation. Events
 * without an identity belong to legacy/Code Agent streams and keep their
 * existing ordered Socket.IO semantics.
 */
export class AITransientStreamGate {
  private readonly activeByMessageId = new Map<string, ActiveStream>();

  accept(messageId: string, event: AITransientStreamIdentity): AITransientStreamDecision {
    const identity = readIdentity(event);
    if (identity.kind === 'legacy') return { accepted: true, resetMessage: false };
    if (identity.kind === 'invalid') return { accepted: false, conflict: true };
    const incoming = identity.stream;

    const active = this.activeByMessageId.get(messageId);
    if (!active) {
      this.activeByMessageId.set(messageId, incoming);
      return { accepted: true, resetMessage: true };
    }
    if (active.runId !== incoming.runId) {
      return { accepted: false, conflict: true };
    }
    if (incoming.generation < active.generation) {
      return { accepted: false, conflict: false };
    }
    if (incoming.generation > active.generation) {
      this.activeByMessageId.set(messageId, incoming);
      return { accepted: true, resetMessage: true };
    }
    if (incoming.lastChunkSeq <= active.lastChunkSeq) {
      return { accepted: false, conflict: false };
    }

    active.lastChunkSeq = incoming.lastChunkSeq;
    return { accepted: true, resetMessage: false };
  }

  settle(messageId: string): void {
    this.activeByMessageId.delete(messageId);
  }

  clear(): void {
    this.activeByMessageId.clear();
  }
}
