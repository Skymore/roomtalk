import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSaveCoordinator, type FileSaveResult } from './codeAgentFileSaveCoordinator';

function deferred() {
  let resolve!: (result: FileSaveResult) => void;
  const promise = new Promise<FileSaveResult>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('FileSaveCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces edits and persists only the latest contents like T3', async () => {
    vi.useFakeTimers();
    const persist = vi.fn<(contents: string) => Promise<FileSaveResult>>()
      .mockResolvedValue({ _tag: 'Success' });
    const onPendingChange = vi.fn();
    const onConfirmed = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed,
    });

    coordinator.change('first');
    await vi.advanceTimersByTimeAsync(300);
    coordinator.change('latest');
    await vi.advanceTimersByTimeAsync(499);
    expect(persist).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith('latest');
    expect(onConfirmed).toHaveBeenCalledWith('latest');
    expect(onPendingChange.mock.calls).toEqual([[true], [true], [false]]);
  });

  it('keeps pending state until an edit made during a write is also saved', async () => {
    vi.useFakeTimers();
    const firstWrite = deferred();
    const persist = vi.fn<(contents: string) => Promise<FileSaveResult>>()
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce({ _tag: 'Success' });
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change('first');
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change('latest');
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledTimes(1);

    firstWrite.resolve({ _tag: 'Success' });
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith('latest');
    expect(onPendingChange.mock.calls.at(-1)).toEqual([false]);
  });

  it('leaves the file pending when the latest write fails', async () => {
    vi.useFakeTimers();
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist: vi.fn().mockResolvedValue({ _tag: 'Failure' }),
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change('latest');
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();

    expect(onPendingChange).toHaveBeenCalledWith(true);
    expect(onPendingChange).not.toHaveBeenCalledWith(false);
  });
});
