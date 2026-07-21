import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useCallback, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CachedRoomMessageWindow } from '../utils/messageHistoryCache';
import type { Message, Room, RoomAgentTurn, RoomEvent, RoomEventPagePayload, RoomSnapshotPayload } from '../utils/types';
import { useRoomMessageEvents, type RoomMessageHistoryRequest } from './useRoomMessageEvents';

const socketMock = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  class MockSocketRequestError extends Error {
    constructor(readonly code: string | null, message: string) {
      super(message);
    }
  }
  return {
    listeners,
    requestSnapshot: vi.fn(),
    requestEvents: vi.fn(),
    SocketRequestError: MockSocketRequestError,
    socket: {
      connected: true,
      id: 'socket-1',
      on: vi.fn((event: string, listener: (...args: any[]) => void) => {
        const eventListeners = listeners.get(event) || new Set();
        eventListeners.add(listener);
        listeners.set(event, eventListeners);
      }),
      off: vi.fn((event: string, listener: (...args: any[]) => void) => {
        listeners.get(event)?.delete(listener);
      }),
    },
    trigger(event: string, ...args: any[]) {
      listeners.get(event)?.forEach(listener => listener(...args));
    },
  };
});

vi.mock('../utils/socket', () => ({
  requestRoomSnapshot: socketMock.requestSnapshot,
  requestRoomEvents: socketMock.requestEvents,
  SocketRequestError: socketMock.SocketRequestError,
  socket: socketMock.socket,
}));

const cacheMock = vi.hoisted(() => ({
  memory: null as CachedRoomMessageWindow | null,
  persistent: null as CachedRoomMessageWindow | null,
  readMemoryRoomMessageWindow: vi.fn(() => cacheMock.memory),
  readCachedRoomMessageWindow: vi.fn(async () => cacheMock.persistent),
  writeCachedRoomMessageWindow: vi.fn(async () => undefined),
  clearCachedRoomMessageWindow: vi.fn(async () => undefined),
}));

vi.mock('../utils/messageHistoryCache', () => ({
  readMemoryRoomMessageWindow: cacheMock.readMemoryRoomMessageWindow,
  readCachedRoomMessageWindow: cacheMock.readCachedRoomMessageWindow,
  writeCachedRoomMessageWindow: cacheMock.writeCachedRoomMessageWindow,
  clearCachedRoomMessageWindow: cacheMock.clearCachedRoomMessageWindow,
}));

const mediaCacheMock = vi.hoisted(() => ({
  clearCachedMediaAsset: vi.fn(async () => undefined),
  clearCachedMediaForRoom: vi.fn(async () => undefined),
}));

vi.mock('../utils/mediaCache', () => mediaCacheMock);
vi.mock('../utils/roomDiagnostics', () => ({ logRoomMessageDiagnostic: vi.fn() }));

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'message-1',
  roomId: 'room-1',
  clientId: 'client-1',
  content: 'hello',
  timestamp: '2026-07-20T00:00:00.000Z',
  messageType: 'text',
  ...overrides,
});

const turn = (overrides: Partial<RoomAgentTurn> = {}): RoomAgentTurn => ({
  id: 'turn-1',
  roomId: 'room-1',
  status: 'running',
  startedAt: '2026-07-20T00:00:00.000Z',
  backend: 'code-agent',
  assistantName: 'Coco',
  updatedAt: '2026-07-20T00:00:00.000Z',
  ...overrides,
});

const event = (seq: number, overrides: Partial<RoomEvent> = {}): RoomEvent => ({
  id: `room-1:${seq}`,
  roomId: 'room-1',
  seq,
  type: 'messages.upserted',
  payload: { messages: [message({ id: `message-${seq}` })], messageIds: [`message-${seq}`] },
  createdAt: '2026-07-20T00:00:00.000Z',
  ...overrides,
});

const room = (overrides: Partial<Room> = {}): Room => ({
  id: 'room-1',
  name: 'Room 1',
  description: '',
  createdAt: '2026-07-20T00:00:00.000Z',
  creatorId: 'client-1',
  ...overrides,
});

const snapshot = (overrides: Partial<RoomSnapshotPayload> = {}): RoomSnapshotPayload => ({
  requestId: 'filled-by-mock',
  roomId: 'room-1',
  room: room(),
  messages: [],
  turns: [],
  snapshotSeq: 0,
  hasMore: false,
  mode: 'replace',
  ...overrides,
});

const eventPage = (requestId: string, afterSeq: number, overrides: Partial<RoomEventPagePayload> = {}): RoomEventPagePayload => ({
  requestId,
  roomId: 'room-1',
  events: [],
  headSeq: afterSeq,
  minAvailableSeq: 1,
  hasMore: false,
  ...overrides,
});

type HarnessProps = {
  roomId?: string;
  isRoomSessionReady?: boolean;
  messageSyncRequestId?: number;
  initialMessages?: Message[];
  messageToDeleteId?: string;
  messageToEditId?: string;
  closeDeleteModal?: () => void;
  closeEditModal?: () => void;
  onRoomUpdated?: (room: Room) => void;
  requestHistoryRef?: { current: RoomMessageHistoryRequest | null };
};

const noop = () => undefined;

const Harness = ({
  roomId = 'room-1',
  isRoomSessionReady = true,
  messageSyncRequestId = 0,
  initialMessages = [],
  messageToDeleteId,
  messageToEditId,
  closeDeleteModal = noop,
  closeEditModal = noop,
  onRoomUpdated,
  requestHistoryRef: externalRequestHistoryRef,
}: HarnessProps) => {
  const [messages, setMessages] = useState(initialMessages);
  const [turns, setTurns] = useState<RoomAgentTurn[]>([]);
  const [lastAppliedSeq, setLastAppliedSeq] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [oldestMessageId, setOldestMessageId] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(false);
  const [, setIsLoadingMore] = useState(false);
  const [, setSessionCostUsd] = useState<number | null>(null);
  const [, setShowScrollButton] = useState(false);
  const messagesRef = useRef(messages);
  const turnsRef = useRef(turns);
  messagesRef.current = messages;
  turnsRef.current = turns;
  const getCurrentMessages = useCallback(() => messagesRef.current, []);
  const getCurrentAgentTurns = useCallback(() => turnsRef.current, []);
  const containerRef = useRef<HTMLDivElement>(null);
  const localRequestHistoryRef = useRef<RoomMessageHistoryRequest | null>(null);
  const requestHistoryRef = externalRequestHistoryRef || localRequestHistoryRef;
  const scrollToBottom = useCallback(noop, []);

  useRoomMessageEvents({
    roomId,
    isRoomSessionReady,
    messageSyncRequestId,
    containerRef,
    getCurrentMessages,
    getCurrentAgentTurns,
    updateMessages: setMessages,
    setAgentTurns: setTurns,
    setIsLoading,
    setIsLoadingMore,
    setHasMoreMessages: setHasMore,
    setLastAppliedSeq,
    setOldestMessageId,
    setSessionCostUsd,
    setShowScrollButton,
    scrollToBottom,
    closeDeleteModal,
    closeEditModal,
    messageToDeleteId,
    messageToEditId,
    onRoomUpdated,
    warningPrefix: 'Warning',
    requestHistoryRef,
  });

  return <div
    ref={containerRef}
    data-testid="state"
    data-messages={messages.map(item => item.id).join(',')}
    data-contents={messages.map(item => item.content).join('|')}
    data-turns={turns.map(item => item.id).join(',')}
    data-seq={lastAppliedSeq}
    data-more={String(hasMore)}
    data-oldest={oldestMessageId || ''}
    data-loading={String(isLoading)}
  />;
};

const installDefaultProtocolMocks = () => {
  socketMock.requestSnapshot.mockImplementation(async (request: { requestId: string }) => (
    snapshot({ requestId: request.requestId })
  ));
  socketMock.requestEvents.mockImplementation(async (request: { requestId: string; afterSeq: number }) => (
    eventPage(request.requestId, request.afterSeq)
  ));
};

describe('useRoomMessageEvents event-log synchronization', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    socketMock.listeners.clear();
    cacheMock.memory = null;
    cacheMock.persistent = null;
    installDefaultProtocolMocks();
  });

  it('loads a consistent snapshot and then drains from snapshotSeq', async () => {
    socketMock.requestSnapshot.mockImplementationOnce(async request => snapshot({
      requestId: request.requestId,
      messages: [message({ id: 'snapshot-message' })],
      snapshotSeq: 4,
      hasMore: true,
      oldestMessageId: 'snapshot-message',
    }));

    render(<Harness />);

    await waitFor(() => expect(screen.getByTestId('state').dataset.messages).toBe('snapshot-message'));
    expect(screen.getByTestId('state').dataset.seq).toBe('4');
    expect(socketMock.requestEvents).toHaveBeenCalledWith(expect.objectContaining({ roomId: 'room-1', afterSeq: 4 }));
  });

  it('renders a cached baseline immediately and only requests missing events', async () => {
    cacheMock.memory = {
      roomId: 'room-1',
      messages: [message({ id: 'cached-message' })],
      turns: [],
      lastAppliedSeq: 5,
      hasMore: false,
      cachedAt: Date.now(),
    };
    socketMock.requestEvents.mockImplementationOnce(async request => eventPage(request.requestId, request.afterSeq, {
      events: [event(6)],
      headSeq: 6,
    }));

    render(<Harness />);

    expect(screen.getByTestId('state').dataset.messages).toContain('cached-message');
    await waitFor(() => expect(screen.getByTestId('state').dataset.seq).toBe('6'));
    expect(socketMock.requestSnapshot).not.toHaveBeenCalled();
    expect(screen.getByTestId('state').dataset.messages).toBe('cached-message,message-6');
  });

  it('drains multiple bounded event pages without losing the first page', async () => {
    cacheMock.memory = {
      roomId: 'room-1', messages: [], lastAppliedSeq: 1, hasMore: false, cachedAt: Date.now(),
    };
    socketMock.requestEvents
      .mockImplementationOnce(async request => eventPage(request.requestId, request.afterSeq, {
        events: [event(2)], headSeq: 3, hasMore: true,
      }))
      .mockImplementationOnce(async request => eventPage(request.requestId, request.afterSeq, {
        events: [event(3)], headSeq: 3, hasMore: false,
      }));

    render(<Harness />);

    await waitFor(() => expect(screen.getByTestId('state').dataset.seq).toBe('3'));
    expect(screen.getByTestId('state').dataset.messages).toBe('message-2,message-3');
    expect(socketMock.requestEvents.mock.calls.map(call => call[0].afterSeq)).toEqual([1, 2]);
  });

  it('ignores repeated wake-up notifications after the cursor is already caught up', async () => {
    cacheMock.memory = {
      roomId: 'room-1', messages: [], lastAppliedSeq: 1, hasMore: false, cachedAt: Date.now(),
    };
    socketMock.requestEvents.mockImplementation(async request => eventPage(request.requestId, request.afterSeq, request.afterSeq === 1
      ? { events: [event(2)], headSeq: 2 }
      : { headSeq: 2 }));
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state').dataset.seq).toBe('2'));

    act(() => {
      socketMock.trigger('room_event_available', { roomId: 'room-1', headSeq: 2 });
      socketMock.trigger('room_event_available', { roomId: 'room-1', headSeq: 2 });
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(socketMock.requestEvents).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('state').dataset.messages).toBe('message-2');
  });

  it('applies a contiguous Socket event payload without another replay request', async () => {
    cacheMock.memory = {
      roomId: 'room-1', messages: [], lastAppliedSeq: 1, hasMore: false, cachedAt: Date.now(),
    };
    render(<Harness />);
    await waitFor(() => expect(socketMock.requestEvents).toHaveBeenCalledTimes(1));

    act(() => socketMock.trigger('room_event_available', {
      roomId: 'room-1',
      headSeq: 2,
      events: [event(2)],
    }));

    await waitFor(() => expect(screen.getByTestId('state').dataset.seq).toBe('2'));
    expect(screen.getByTestId('state').dataset.messages).toBe('message-2');
    expect(socketMock.requestEvents).toHaveBeenCalledTimes(1);
  });

  it('replays from the durable cursor when a Socket payload has a sequence gap', async () => {
    cacheMock.memory = {
      roomId: 'room-1', messages: [], lastAppliedSeq: 1, hasMore: false, cachedAt: Date.now(),
    };
    socketMock.requestEvents
      .mockImplementationOnce(async request => eventPage(request.requestId, request.afterSeq, { headSeq: 1 }))
      .mockImplementationOnce(async request => eventPage(request.requestId, request.afterSeq, {
        events: [event(2), event(3)], headSeq: 3,
      }));
    render(<Harness />);
    await waitFor(() => expect(socketMock.requestEvents).toHaveBeenCalledTimes(1));

    act(() => socketMock.trigger('room_event_available', {
      roomId: 'room-1',
      headSeq: 3,
      events: [event(3)],
    }));

    await waitFor(() => expect(screen.getByTestId('state').dataset.seq).toBe('3'));
    expect(screen.getByTestId('state').dataset.messages).toBe('message-2,message-3');
    expect(socketMock.requestEvents.mock.calls.map(call => call[0].afterSeq)).toEqual([1, 1]);
  });

  it('switches a large retained gap to a consistent snapshot instead of replaying every page', async () => {
    cacheMock.memory = {
      roomId: 'room-1', messages: [message({ id: 'cached' })], lastAppliedSeq: 1, hasMore: false, cachedAt: Date.now(),
    };
    socketMock.requestEvents.mockImplementation(async request => eventPage(request.requestId, request.afterSeq, request.afterSeq === 1
      ? { events: [event(2)], headSeq: 1000, hasMore: true }
      : { headSeq: 1000 }));
    socketMock.requestSnapshot.mockImplementationOnce(async request => snapshot({
      requestId: request.requestId,
      messages: [message({ id: 'snapshot-current' })],
      snapshotSeq: 1000,
    }));

    render(<Harness />);

    await waitFor(() => expect(screen.getByTestId('state').dataset.seq).toBe('1000'));
    expect(screen.getByTestId('state').dataset.messages).toBe('snapshot-current');
    expect(screen.getByTestId('state').dataset.messages).not.toContain('message-2');
    expect(socketMock.requestSnapshot).toHaveBeenCalledTimes(1);
  });

  it('retries a failed large-gap snapshot when the same high-water notification arrives again', async () => {
    cacheMock.memory = {
      roomId: 'room-1', messages: [message({ id: 'cached' })], lastAppliedSeq: 1, hasMore: false, cachedAt: Date.now(),
    };
    socketMock.requestEvents.mockImplementation(async request => eventPage(request.requestId, request.afterSeq, {
      headSeq: request.afterSeq,
    }));
    socketMock.requestSnapshot
      .mockRejectedValueOnce(new Error('temporary snapshot failure'))
      .mockImplementationOnce(async request => snapshot({
        requestId: request.requestId,
        messages: [message({ id: 'snapshot-current' })],
        snapshotSeq: 1000,
      }));
    render(<Harness />);
    await waitFor(() => expect(socketMock.requestEvents).toHaveBeenCalledTimes(1));

    act(() => socketMock.trigger('room_event_available', { roomId: 'room-1', headSeq: 1000 }));
    await waitFor(() => expect(socketMock.requestSnapshot).toHaveBeenCalledTimes(1));
    act(() => socketMock.trigger('room_event_available', { roomId: 'room-1', headSeq: 1000 }));

    await waitFor(() => expect(screen.getByTestId('state').dataset.seq).toBe('1000'));
    expect(socketMock.requestSnapshot).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('state').dataset.messages).toBe('snapshot-current');
  });

  it('resets from a snapshot when the retained cursor has expired', async () => {
    cacheMock.memory = {
      roomId: 'room-1', messages: [message({ id: 'stale' })], lastAppliedSeq: 2, hasMore: false, cachedAt: Date.now(),
    };
    socketMock.requestEvents
      .mockRejectedValueOnce(new socketMock.SocketRequestError('CURSOR_EXPIRED', 'expired'))
      .mockImplementation(async request => eventPage(request.requestId, request.afterSeq));
    socketMock.requestSnapshot.mockImplementationOnce(async request => snapshot({
      requestId: request.requestId,
      messages: [message({ id: 'fresh' })],
      snapshotSeq: 10,
    }));

    render(<Harness />);

    await waitFor(() => expect(screen.getByTestId('state').dataset.seq).toBe('10'));
    expect(screen.getByTestId('state').dataset.messages).toBe('fresh');
    expect(socketMock.requestSnapshot).toHaveBeenCalledTimes(1);
  });

  it('resets from a snapshot when a database restore moves the stream head behind the cached cursor', async () => {
    cacheMock.memory = {
      roomId: 'room-1', messages: [message({ id: 'future' })], lastAppliedSeq: 20, hasMore: false, cachedAt: Date.now(),
    };
    socketMock.requestEvents
      .mockRejectedValueOnce(new socketMock.SocketRequestError('CURSOR_AHEAD', 'ahead'))
      .mockImplementation(async request => eventPage(request.requestId, request.afterSeq));
    socketMock.requestSnapshot.mockImplementationOnce(async request => snapshot({
      requestId: request.requestId,
      messages: [message({ id: 'restored' })],
      snapshotSeq: 8,
    }));

    render(<Harness />);

    await waitFor(() => expect(screen.getByTestId('state').dataset.seq).toBe('8'));
    expect(screen.getByTestId('state').dataset.messages).toBe('restored');
    expect(socketMock.requestSnapshot).toHaveBeenCalledTimes(1);
  });

  it('detects a non-contiguous page and resets rather than applying it', async () => {
    cacheMock.memory = {
      roomId: 'room-1', messages: [message({ id: 'baseline' })], lastAppliedSeq: 1, hasMore: false, cachedAt: Date.now(),
    };
    socketMock.requestEvents
      .mockImplementationOnce(async request => eventPage(request.requestId, request.afterSeq, {
        events: [event(3)], headSeq: 3,
      }))
      .mockImplementation(async request => eventPage(request.requestId, request.afterSeq));
    socketMock.requestSnapshot.mockImplementationOnce(async request => snapshot({
      requestId: request.requestId,
      messages: [message({ id: 'canonical' })],
      snapshotSeq: 3,
    }));

    render(<Harness />);

    await waitFor(() => expect(screen.getByTestId('state').dataset.messages).toBe('canonical'));
    expect(screen.getByTestId('state').dataset.messages).not.toContain('message-3');
  });

  it('applies edits and deletes and closes modals for the current target', async () => {
    const closeDeleteModal = vi.fn();
    const closeEditModal = vi.fn();
    cacheMock.memory = {
      roomId: 'room-1',
      messages: [
        message({ id: 'edit-me', content: 'old' }),
        message({ id: 'delete-me', mediaAsset: { id: 'asset-1', kind: 'image', mimeType: 'image/png', byteSize: 1 } }),
      ],
      lastAppliedSeq: 1,
      hasMore: false,
      cachedAt: Date.now(),
    };
    socketMock.requestEvents.mockImplementationOnce(async request => eventPage(request.requestId, request.afterSeq, {
      headSeq: 3,
      events: [
        event(2, {
          payload: { messageIds: ['edit-me'], messages: [message({ id: 'edit-me', content: 'new' })] },
        }),
        event(3, {
          type: 'messages.deleted',
          payload: { messageIds: ['delete-me'] },
        }),
      ],
    }));

    render(<Harness
      messageToDeleteId="delete-me"
      messageToEditId="delete-me"
      closeDeleteModal={closeDeleteModal}
      closeEditModal={closeEditModal}
    />);

    await waitFor(() => expect(screen.getByTestId('state').dataset.seq).toBe('3'));
    expect(screen.getByTestId('state').dataset.contents).toBe('new');
    expect(mediaCacheMock.clearCachedMediaAsset).toHaveBeenCalledWith('asset-1');
    expect(closeDeleteModal).toHaveBeenCalled();
    expect(closeEditModal).toHaveBeenCalled();
  });

  it('replays agent-turn updates through the same cursor', async () => {
    cacheMock.memory = {
      roomId: 'room-1', messages: [], turns: [], lastAppliedSeq: 1, hasMore: false, cachedAt: Date.now(),
    };
    socketMock.requestEvents.mockImplementationOnce(async request => eventPage(request.requestId, request.afterSeq, {
      headSeq: 2,
      events: [event(2, {
        type: 'agent_turns.upserted',
        payload: { turnIds: ['turn-1'], turns: [turn()] },
      })],
    }));

    render(<Harness />);

    await waitFor(() => expect(screen.getByTestId('state').dataset.turns).toBe('turn-1'));
    expect(screen.getByTestId('state').dataset.seq).toBe('2');
  });

  it('applies canonical room metadata from the same event cursor', async () => {
    const onRoomUpdated = vi.fn();
    const updatedRoom = room({ name: 'Renamed room', updatedAt: '2026-07-20T00:01:00.000Z' });
    cacheMock.memory = {
      roomId: 'room-1', messages: [], turns: [], lastAppliedSeq: 1, hasMore: false, cachedAt: Date.now(),
    };
    socketMock.requestEvents.mockImplementationOnce(async request => eventPage(request.requestId, request.afterSeq, {
      headSeq: 2,
      events: [event(2, {
        type: 'room.updated',
        payload: { roomId: 'room-1', room: updatedRoom },
      })],
    }));

    render(<Harness onRoomUpdated={onRoomUpdated} />);

    await waitFor(() => expect(screen.getByTestId('state').dataset.seq).toBe('2'));
    expect(onRoomUpdated).toHaveBeenCalledWith(updatedRoom);
  });

  it('paginates older history without moving the live event cursor', async () => {
    const requestHistoryRef: { current: RoomMessageHistoryRequest | null } = { current: null };
    cacheMock.memory = {
      roomId: 'room-1', messages: [message({ id: 'newest' })], lastAppliedSeq: 8, hasMore: true, oldestMessageId: 'newest', cachedAt: Date.now(),
    };
    socketMock.requestSnapshot.mockImplementationOnce(async request => snapshot({
      requestId: request.requestId,
      messages: [message({ id: 'older', timestamp: '2026-07-19T00:00:00.000Z' })],
      snapshotSeq: 12,
      hasMore: false,
      oldestMessageId: 'older',
      mode: 'prepend',
    }));
    render(<Harness requestHistoryRef={requestHistoryRef} />);
    await waitFor(() => expect(screen.getByTestId('state').dataset.seq).toBe('8'));

    await act(async () => {
      await requestHistoryRef.current?.({ beforeMessageId: 'newest', limit: 80 });
    });

    expect(screen.getByTestId('state').dataset.messages).toBe('older,newest');
    expect(screen.getByTestId('state').dataset.seq).toBe('8');
  });

  it('checks for missed events after reconnect and page resume', async () => {
    cacheMock.memory = {
      roomId: 'room-1', messages: [], lastAppliedSeq: 4, hasMore: false, cachedAt: Date.now(),
    };
    render(<Harness />);
    await waitFor(() => expect(socketMock.requestEvents).toHaveBeenCalledTimes(1));

    act(() => socketMock.trigger('connect'));
    await waitFor(() => expect(socketMock.requestEvents).toHaveBeenCalledTimes(2));

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(socketMock.requestEvents).toHaveBeenCalledTimes(3));
  });

  it('keeps browser-local optimistic messages while replacing a snapshot', async () => {
    socketMock.requestSnapshot.mockImplementationOnce(async request => snapshot({
      requestId: request.requestId,
      messages: [message({ id: 'server-message' })],
      snapshotSeq: 2,
    }));
    render(<Harness initialMessages={[message({
      id: 'temp-1',
      clientMessageId: 'client-message-1',
      deliveryStatus: 'pending',
    })]} />);

    await waitFor(() => expect(screen.getByTestId('state').dataset.seq).toBe('2'));
    expect(screen.getByTestId('state').dataset.messages).toContain('temp-1');
    expect(screen.getByTestId('state').dataset.messages).toContain('server-message');
  });

  it('clears durable and media caches on a room deletion event', async () => {
    cacheMock.memory = {
      roomId: 'room-1', messages: [message()], lastAppliedSeq: 1, hasMore: false, cachedAt: Date.now(),
    };
    socketMock.requestEvents.mockImplementationOnce(async request => eventPage(request.requestId, request.afterSeq, {
      headSeq: 2,
      events: [event(2, { type: 'room.deleted', payload: { roomId: 'room-1' } })],
    }));

    render(<Harness />);

    await waitFor(() => expect(screen.getByTestId('state').dataset.seq).toBe('2'));
    expect(screen.getByTestId('state').dataset.messages).toBe('');
    expect(cacheMock.clearCachedRoomMessageWindow).toHaveBeenCalledWith('room-1');
    expect(mediaCacheMock.clearCachedMediaForRoom).toHaveBeenCalledWith('room-1');
  });

  it('keeps transient AI chunks outside the durable cursor and settles them on stream end', async () => {
    cacheMock.memory = {
      roomId: 'room-1',
      messages: [message({ id: 'ai-1', clientId: 'ai_assistant', content: '', status: 'streaming' })],
      lastAppliedSeq: 5,
      hasMore: false,
      cachedAt: Date.now(),
    };
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state').dataset.seq).toBe('5'));

    act(() => socketMock.trigger('ai_chunk', { roomId: 'room-1', messageId: 'ai-1', chunk: 'partial' }));
    expect(screen.getByTestId('state').dataset.contents).toBe('partial');
    expect(screen.getByTestId('state').dataset.seq).toBe('5');

    act(() => socketMock.trigger('ai_stream_end', { roomId: 'room-1', messageId: 'ai-1', content: 'final' }));
    expect(screen.getByTestId('state').dataset.contents).toBe('final');
    expect(screen.getByTestId('state').dataset.seq).toBe('5');
  });
});
