// @vitest-environment jsdom

import { Dispatch, SetStateAction, useRef } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Message } from '../utils/types';
import { useRoomMessageEvents } from './useRoomMessageEvents';

const socketMock = vi.hoisted(() => {
  const handlers = new Map<string, Set<(...args: any[]) => void>>();

  return {
    id: 'socket-1',
    handlers,
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      const eventHandlers = handlers.get(event) || new Set();
      eventHandlers.add(handler);
      handlers.set(event, eventHandlers);
    }),
    off: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.get(event)?.delete(handler);
    }),
    emit: vi.fn(),
    trigger: (event: string, ...args: any[]) => {
      handlers.get(event)?.forEach(handler => handler(...args));
    },
    reset: () => {
      handlers.clear();
    },
  };
});

const cacheMock = vi.hoisted(() => ({
  readMemoryRoomMessageWindow: vi.fn(),
  readCachedRoomMessageWindow: vi.fn(),
  writeCachedRoomMessageWindow: vi.fn(),
  deleteCachedRoomMessageWindow: vi.fn(),
}));

vi.mock('../utils/socket', () => ({
  socket: socketMock,
  clientId: 'client-1',
}));

vi.mock('../utils/messageHistoryCache', () => cacheMock);

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'm1',
  clientId: 'client-1',
  content: 'hello',
  roomId: 'room-1',
  timestamp: '2026-05-03T10:00:00.000Z',
  messageType: 'text',
  ...overrides,
});

type UpdateMessages = (updater: SetStateAction<Message[]>) => void;
type SetBoolean = Dispatch<SetStateAction<boolean>>;
type SetNumber = Dispatch<SetStateAction<number>>;
type ScrollToBottom = (behavior?: ScrollBehavior) => void;
type CloseModal = () => void;
type MockedFunction<T extends (...args: any[]) => any> = T & Mock<T>;

type HarnessProps = {
  roomId?: string;
  messageToDeleteId?: string;
  messageToEditId?: string;
  updateMessages: UpdateMessages;
  setIsLoading: SetBoolean;
  setIsLoadingMore: SetBoolean;
  setHasMoreMessages: SetBoolean;
  setHistoryVersion: SetNumber;
  setOldestMessageId: Dispatch<SetStateAction<string | undefined>>;
  setSessionCostUsd: SetNumber;
  setShowScrollButton: SetBoolean;
  scrollToBottom: ScrollToBottom;
  closeDeleteModal: CloseModal;
  closeEditModal: CloseModal;
};

type HarnessTestProps = Omit<HarnessProps, 'roomId' | 'messageToDeleteId' | 'messageToEditId'> & {
  updateMessages: MockedFunction<UpdateMessages>;
  setIsLoading: MockedFunction<SetBoolean>;
  setIsLoadingMore: MockedFunction<SetBoolean>;
  setHasMoreMessages: MockedFunction<SetBoolean>;
  setHistoryVersion: MockedFunction<SetNumber>;
  setOldestMessageId: MockedFunction<Dispatch<SetStateAction<string | undefined>>>;
  setSessionCostUsd: MockedFunction<SetNumber>;
  setShowScrollButton: MockedFunction<SetBoolean>;
  scrollToBottom: MockedFunction<ScrollToBottom>;
  closeDeleteModal: MockedFunction<CloseModal>;
  closeEditModal: MockedFunction<CloseModal>;
};

const Harness = ({
  roomId = 'room-1',
  messageToDeleteId,
  messageToEditId,
  updateMessages,
  setIsLoading,
  setIsLoadingMore,
  setHasMoreMessages,
  setHistoryVersion,
  setOldestMessageId,
  setSessionCostUsd,
  setShowScrollButton,
  scrollToBottom,
  closeDeleteModal,
  closeEditModal,
}: HarnessProps) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useRoomMessageEvents({
    roomId,
    containerRef,
    updateMessages,
    setIsLoading,
    setIsLoadingMore,
    setHasMoreMessages,
    setHistoryVersion,
    setOldestMessageId,
    setSessionCostUsd,
    setShowScrollButton,
    scrollToBottom,
    closeDeleteModal,
    closeEditModal,
    messageToDeleteId,
    messageToEditId,
    warningPrefix: 'Warning',
  });

  return <div ref={containerRef} data-testid="container" />;
};

const mockFunction = <T extends (...args: any[]) => any>() => vi.fn<T>() as unknown as MockedFunction<T>;

const createHarnessProps = (): HarnessTestProps => ({
  updateMessages: mockFunction<UpdateMessages>(),
  setIsLoading: mockFunction<SetBoolean>(),
  setIsLoadingMore: mockFunction<SetBoolean>(),
  setHasMoreMessages: mockFunction<SetBoolean>(),
  setHistoryVersion: mockFunction<SetNumber>(),
  setOldestMessageId: mockFunction<Dispatch<SetStateAction<string | undefined>>>(),
  setSessionCostUsd: mockFunction<SetNumber>(),
  setShowScrollButton: mockFunction<SetBoolean>(),
  scrollToBottom: mockFunction<ScrollToBottom>(),
  closeDeleteModal: mockFunction<CloseModal>(),
  closeEditModal: mockFunction<CloseModal>(),
});

describe('useRoomMessageEvents', () => {
  beforeEach(() => {
    socketMock.reset();
    vi.clearAllMocks();
    cacheMock.readMemoryRoomMessageWindow.mockReturnValue(null);
    cacheMock.readCachedRoomMessageWindow.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('does not reset subscriptions or close modals when the active edit/delete target changes', () => {
    const props = createHarnessProps();
    const { rerender } = render(<Harness {...props} />);

    expect(props.closeEditModal).toHaveBeenCalledTimes(1);
    expect(props.closeDeleteModal).toHaveBeenCalledTimes(1);
    expect(socketMock.emit).toHaveBeenCalledWith('get_room_messages', { roomId: 'room-1', limit: 80 });

    props.closeEditModal.mockClear();
    props.closeDeleteModal.mockClear();
    socketMock.emit.mockClear();
    socketMock.on.mockClear();
    socketMock.off.mockClear();

    rerender(
      <Harness
        {...props}
        messageToEditId="m1"
        messageToDeleteId="m2"
      />
    );

    expect(props.closeEditModal).not.toHaveBeenCalled();
    expect(props.closeDeleteModal).not.toHaveBeenCalled();
    expect(socketMock.emit).not.toHaveBeenCalledWith('get_room_messages', { roomId: 'room-1', limit: 80 });
    expect(socketMock.on).not.toHaveBeenCalled();
    expect(socketMock.off).not.toHaveBeenCalled();
  });

  it('renders instantly from the in-memory cache without a loading flash', () => {
    cacheMock.readMemoryRoomMessageWindow.mockReturnValue({
      roomId: 'room-1',
      messages: [message({ id: 'cached-1', content: 'cached' })],
      historyVersion: 7,
      hasMore: true,
      oldestMessageId: 'cached-1',
      cachedAt: 1,
    });
    const props = createHarnessProps();
    render(<Harness {...props} />);

    expect(props.updateMessages).toHaveBeenCalledWith([message({ id: 'cached-1', content: 'cached' })]);
    expect(props.setIsLoading).toHaveBeenCalledWith(false);
    expect(props.setIsLoading).not.toHaveBeenCalledWith(true);
    expect(props.setHasMoreMessages).toHaveBeenCalledWith(true);
    expect(props.setHistoryVersion).toHaveBeenCalledWith(7);
    expect(cacheMock.readCachedRoomMessageWindow).not.toHaveBeenCalled();
    expect(socketMock.emit).toHaveBeenCalledWith('get_room_messages', { roomId: 'room-1', limit: 80 });
  });

  it('sorts loaded room history before setting messages', () => {
    const props = createHarnessProps();
    render(<Harness {...props} />);
    props.updateMessages.mockClear();

    socketMock.trigger('message_history', {
      roomId: 'room-1',
      messages: [
        message({ id: 'later', timestamp: '2026-05-03T10:00:02.000Z' }),
        message({ id: 'first', timestamp: '2026-05-03T10:00:00.000Z' }),
        message({ id: 'other-room', roomId: 'room-2' }),
      ],
      historyVersion: 1,
      hasMore: false,
      mode: 'replace',
    });

    expect(props.updateMessages).toHaveBeenCalledWith([
      message({ id: 'first', timestamp: '2026-05-03T10:00:00.000Z' }),
      message({ id: 'later', timestamp: '2026-05-03T10:00:02.000Z' }),
    ]);
  });

  it('does not let a slower cached window overwrite server history', async () => {
    let resolveCache: (value: unknown) => void = () => {};
    cacheMock.readCachedRoomMessageWindow.mockReturnValue(new Promise(resolve => {
      resolveCache = resolve;
    }));
    const props = createHarnessProps();
    render(<Harness {...props} />);
    props.updateMessages.mockClear();

    socketMock.trigger('message_history', {
      roomId: 'room-1',
      messages: [message({ id: 'server-message', content: 'server' })],
      historyVersion: 4,
      hasMore: false,
      mode: 'replace',
    });

    expect(props.updateMessages).toHaveBeenCalledTimes(1);
    expect(props.updateMessages).toHaveBeenLastCalledWith([message({ id: 'server-message', content: 'server' })]);

    await act(async () => {
      resolveCache({
        roomId: 'room-1',
        messages: [message({ id: 'cached-message', content: 'cached' })],
        historyVersion: 1,
        hasMore: false,
        cachedAt: 1,
      });
      await Promise.resolve();
    });

    expect(props.updateMessages).toHaveBeenCalledTimes(1);
  });

  it('updates the cached latest window when a visible new message arrives', () => {
    const initialMessage = message({ id: 'm1', content: 'first' });
    let currentMessages = [initialMessage];
    const props = createHarnessProps();
    props.updateMessages.mockImplementation(updater => {
      currentMessages = typeof updater === 'function'
        ? updater(currentMessages)
        : updater;
    });
    render(<Harness {...props} />);

      socketMock.trigger('message_history', {
        roomId: 'room-1',
        messages: [initialMessage],
        historyVersion: 4,
        hasMore: false,
        oldestMessageId: initialMessage.id,
        mode: 'replace',
      });
    cacheMock.writeCachedRoomMessageWindow.mockClear();

    socketMock.trigger('new_message', message({ id: 'm2', content: 'second' }));

    expect(currentMessages.map(item => item.id)).toEqual(['m1', 'm2']);
    expect(cacheMock.writeCachedRoomMessageWindow).toHaveBeenCalledWith(expect.objectContaining({
      roomId: 'room-1',
      historyVersion: 5,
      hasMore: false,
      messages: currentMessages,
    }));
  });

  it('uses the persistent client id when deciding whether a new message should auto-scroll', () => {
    vi.useFakeTimers();
    const props = createHarnessProps();
    const { getByTestId } = render(<Harness {...props} />);
    const container = getByTestId('container');
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(container, 'scrollTop', { configurable: true, value: 0 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 100 });

    act(() => {
      socketMock.trigger('new_message', message({ id: 'own-message', clientId: 'client-1' }));
      vi.advanceTimersByTime(100);
    });

    expect(props.scrollToBottom).toHaveBeenCalledWith('smooth');
    expect(props.setShowScrollButton).not.toHaveBeenCalledWith(true);
  });

  it('debounces scheduled scrolls during AI streaming', () => {
    vi.useFakeTimers();
    const props = createHarnessProps();
    render(<Harness {...props} />);

    act(() => {
      socketMock.trigger('ai_chunk', { roomId: 'room-1', messageId: 'ai1', chunk: 'a' });
      socketMock.trigger('ai_chunk', { roomId: 'room-1', messageId: 'ai1', chunk: 'b' });
      socketMock.trigger('ai_chunk', { roomId: 'room-1', messageId: 'ai1', chunk: 'c' });
      vi.advanceTimersByTime(49);
    });
    expect(props.scrollToBottom).not.toHaveBeenCalledWith('smooth');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(props.scrollToBottom).toHaveBeenCalledTimes(1);
    expect(props.scrollToBottom).toHaveBeenCalledWith('smooth');
  });

  it('uses the latest edit target when deciding whether an edit broadcast should close the modal', () => {
    const props = createHarnessProps();
    const { rerender } = render(<Harness {...props} />);

    props.closeEditModal.mockClear();
    rerender(<Harness {...props} messageToEditId="m1" />);
    props.closeEditModal.mockClear();

    socketMock.trigger('message_edited', message({ id: 'other' }));
    expect(props.closeEditModal).not.toHaveBeenCalled();

    socketMock.trigger('message_edited', message({ id: 'm1' }));
    expect(props.closeEditModal).toHaveBeenCalledTimes(1);
  });

  it('uses the latest delete target when deciding whether delete broadcasts should close modals', () => {
    const props = createHarnessProps();
    const { rerender } = render(<Harness {...props} />);

    rerender(
      <Harness
        {...props}
        messageToDeleteId="m2"
        messageToEditId="m1"
      />
    );
    props.closeDeleteModal.mockClear();
    props.closeEditModal.mockClear();

    socketMock.trigger('message_deleted', 'other', 'room-1');
    expect(props.closeDeleteModal).not.toHaveBeenCalled();
    expect(props.closeEditModal).not.toHaveBeenCalled();

    socketMock.trigger('message_deleted', 'm2', 'room-1');
    expect(props.closeDeleteModal).toHaveBeenCalledTimes(1);
    expect(props.closeEditModal).not.toHaveBeenCalled();

    socketMock.trigger('message_deleted', 'm1', 'room-1');
    expect(props.closeEditModal).toHaveBeenCalledTimes(1);
  });
});
