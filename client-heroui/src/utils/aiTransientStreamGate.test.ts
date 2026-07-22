import { describe, expect, it } from 'vitest';
import { AITransientStreamGate } from './aiTransientStreamGate';

describe('AITransientStreamGate', () => {
  it('accepts legacy streams without inventing generation semantics', () => {
    const gate = new AITransientStreamGate();
    expect(gate.accept('message-1', {})).toEqual({ accepted: true, resetMessage: false });
    expect(gate.accept('message-1', {})).toEqual({ accepted: true, resetMessage: false });
  });

  it('rejects partially versioned stream identities instead of bypassing fencing', () => {
    const gate = new AITransientStreamGate();
    expect(gate.accept('message-1', { runId: 'run-1' }))
      .toEqual({ accepted: false, conflict: true });
    expect(gate.accept('message-1', { generation: 1, chunkSeq: 1 }))
      .toEqual({ accepted: false, conflict: true });
    expect(gate.accept('message-1', { runId: 'run-1', generation: 0, chunkSeq: 1 }))
      .toEqual({ accepted: false, conflict: true });
  });

  it('deduplicates one generation and fences a replaced worker', () => {
    const gate = new AITransientStreamGate();
    expect(gate.accept('message-1', { runId: 'run-1', generation: 1, chunkSeq: 1 }))
      .toEqual({ accepted: true, resetMessage: true });
    expect(gate.accept('message-1', { runId: 'run-1', generation: 1, chunkSeq: 1 }))
      .toEqual({ accepted: false, conflict: false });
    expect(gate.accept('message-1', { runId: 'run-1', generation: 1, chunkSeq: 2 }))
      .toEqual({ accepted: true, resetMessage: false });
    expect(gate.accept('message-1', { runId: 'run-1', generation: 2, chunkSeq: 1 }))
      .toEqual({ accepted: true, resetMessage: true });
    expect(gate.accept('message-1', { runId: 'run-1', generation: 1, chunkSeq: 3 }))
      .toEqual({ accepted: false, conflict: false });
  });

  it('treats a different run for the same message as a protocol conflict', () => {
    const gate = new AITransientStreamGate();
    gate.accept('message-1', { runId: 'run-1', generation: 1, chunkSeq: 1 });
    expect(gate.accept('message-1', { runId: 'run-2', generation: 1, chunkSeq: 1 }))
      .toEqual({ accepted: false, conflict: true });
  });
});
