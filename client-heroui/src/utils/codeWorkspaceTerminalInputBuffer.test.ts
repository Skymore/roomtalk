import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTerminalInputBuffer } from './codeWorkspaceTerminalInputBuffer';

describe('codeWorkspaceTerminalInputBuffer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('combines input produced within one flush window', () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const buffer = createTerminalInputBuffer({
      send: async (data) => {
        sent.push(data);
      },
    });

    buffer.push('a');
    buffer.push('b');
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(16);
    expect(sent).toEqual(['ab']);
  });

  it('flushes immediately when enter is pressed', () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const buffer = createTerminalInputBuffer({
      send: async (data) => {
        sent.push(data);
      },
    });

    buffer.push('echo ok');
    buffer.push('\r');

    expect(sent).toEqual(['echo ok\r']);
    vi.runAllTimers();
    expect(sent).toEqual(['echo ok\r']);
  });

  it('flushes pending input when disposed', () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const buffer = createTerminalInputBuffer({
      send: async (data) => {
        sent.push(data);
      },
    });

    buffer.push('pending');
    buffer.dispose();
    buffer.push('ignored');

    expect(sent).toEqual(['pending']);
  });

  it('splits a large paste into bounded batches', () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const buffer = createTerminalInputBuffer({
      maxBatchLength: 4,
      send: async (data) => {
        sent.push(data);
      },
    });

    buffer.push('abcdefghij');

    expect(sent).toEqual(['abcd', 'efgh', 'ij']);
  });
});
