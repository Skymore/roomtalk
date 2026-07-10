const DEFAULT_FLUSH_DELAY_MS = 16;
const DEFAULT_MAX_BATCH_LENGTH = 16 * 1024;

interface TerminalInputBufferOptions {
  send: (data: string) => Promise<void>;
  onError?: (error: unknown) => void;
  flushDelayMs?: number;
  maxBatchLength?: number;
}

export interface TerminalInputBuffer {
  push(data: string): void;
  flush(): void;
  dispose(): void;
}

export function createTerminalInputBuffer({
  send,
  onError,
  flushDelayMs = DEFAULT_FLUSH_DELAY_MS,
  maxBatchLength = DEFAULT_MAX_BATCH_LENGTH,
}: TerminalInputBufferOptions): TerminalInputBuffer {
  let pending = '';
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearScheduledFlush = () => {
    if (timeoutId === null) {
      return;
    }
    clearTimeout(timeoutId);
    timeoutId = null;
  };

  const sendPending = () => {
    clearScheduledFlush();
    if (!pending) {
      return;
    }
    const data = pending;
    pending = '';
    for (let offset = 0; offset < data.length; offset += maxBatchLength) {
      void send(data.slice(offset, offset + maxBatchLength)).catch((error) => onError?.(error));
    }
  };

  const scheduleFlush = () => {
    if (timeoutId !== null) {
      return;
    }
    timeoutId = setTimeout(sendPending, flushDelayMs);
  };

  return {
    push(data) {
      if (disposed || !data) {
        return;
      }
      pending += data;
      if (pending.length >= maxBatchLength || data.includes('\r') || data.includes('\n')) {
        sendPending();
        return;
      }
      scheduleFlush();
    },
    flush: sendPending,
    dispose() {
      if (disposed) {
        return;
      }
      sendPending();
      disposed = true;
    },
  };
}
