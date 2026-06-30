// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Message } from '../utils/types';
import { MessageList, MessageListHandle } from './MessageList';

const requestAIResponseMock = vi.hoisted(() => vi.fn());
const requestEditMessageAndAIResponseMock = vi.hoisted(() => vi.fn());
const loadCodeAgentWorkspaceSnapshotMock = vi.hoisted(() => vi.fn());
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

vi.mock('../utils/socket', () => ({
  socket: socketMock,
  clientId: 'client-1',
  requestAIResponse: requestAIResponseMock,
  requestEditMessageAndAIResponse: requestEditMessageAndAIResponseMock,
}));

vi.mock('../utils/cocoWorkspace', async () => {
  const actual = await vi.importActual<typeof import('../utils/cocoWorkspace')>('../utils/cocoWorkspace');
  return {
    ...actual,
    loadCodeAgentWorkspaceSnapshot: loadCodeAgentWorkspaceSnapshotMock,
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@iconify/react', () => ({
  Icon: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

vi.mock('./MessageItem', () => ({
  MessageItem: ({ message, onRefreshAI, onStartEdit }: { message: Message; onRefreshAI?: (messageId: string) => void; onStartEdit?: (messageId: string) => void }) => (
    <div
      data-testid="message-item"
      data-message-id={message.id}
      data-client-message-id={message.clientMessageId || ''}
      data-delivery-status={message.deliveryStatus || ''}
      data-delivery-error={message.deliveryError || ''}
    >
      {message.content}
      <button type="button" onClick={() => onRefreshAI?.(message.id)}>retry-{message.id}</button>
      <button type="button" onClick={() => onStartEdit?.(message.id)}>edit-{message.id}</button>
    </div>
  ),
  preloadMarkdownContent: () => {},
}));

vi.mock('./DeleteConfirmationModal', () => ({
  DeleteConfirmationModal: () => null,
}));

vi.mock('./EditMessageModal', () => ({
  EditMessageModal: ({ message, onSaveAndAskAI }: { message?: Message | null; onSaveAndAskAI?: (messageId: string, content: string) => void }) => (
    message ? <button type="button" onClick={() => onSaveAndAskAI?.(message.id, 'edited content')}>edit-and-ask</button> : null
  ),
}));

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'm1',
  clientId: 'client-1',
  content: 'hello',
  roomId: 'room-1',
  timestamp: '2026-05-03T10:00:00.000Z',
  messageType: 'text',
  ...overrides,
});

const createLocalStorageMock = (): Storage => {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
};

describe('MessageList optimistic messages', () => {
  beforeEach(() => {
    const localStorageMock = createLocalStorageMock();
    Object.defineProperty(window, 'localStorage', { configurable: true, value: localStorageMock });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorageMock });
    socketMock.reset();
    vi.clearAllMocks();
    window.localStorage.clear();
    requestAIResponseMock.mockResolvedValue(undefined);
    requestEditMessageAndAIResponseMock.mockResolvedValue(undefined);
    loadCodeAgentWorkspaceSnapshotMock.mockResolvedValue({
      roomId: 'room-1',
      backend: 'coco',
      source: 'sandbox',
      generatedAt: '2026-05-29T00:00:00.000Z',
      status: { sandboxStatus: 'ready', agentStatus: 'idle', hasSession: false },
      summary: {
        toolCalls: 0,
        toolResults: 0,
        toolErrors: 0,
        lastToolName: null,
      },
      changes: { available: false, changedFiles: [], diffSummary: null },
      commands: [],
    });
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows pending messages and replaces matching server messages without duplicates', async () => {
    const ref = createRef<MessageListHandle>();
    render(<MessageList ref={ref} roomId="room-1" onReply={vi.fn()} roomPermissions={null} />);

    act(() => {
      socketMock.trigger('message_history', { roomId: 'room-1', messages: [], historyVersion: 0, hasMore: false, mode: 'replace' });
    });

    const pending = message({
      id: 'temp-client-message-1',
      content: 'pending text',
      clientMessageId: 'client-message-1',
      deliveryStatus: 'pending',
    });

    act(() => {
      ref.current?.addOptimisticMessage(pending);
      ref.current?.addOptimisticMessage(pending);
    });

    expect(await screen.findByText('pending text')).toBeTruthy();
    expect(screen.getAllByTestId('message-item')).toHaveLength(1);
    expect(screen.getByTestId('message-item').getAttribute('data-delivery-status')).toBe('pending');

    const saved = message({
      id: 'server-message-1',
      content: 'saved text',
      clientMessageId: 'client-message-1',
    });

    act(() => {
      socketMock.trigger('new_message', saved);
      socketMock.trigger('new_message', saved);
    });

    await waitFor(() => {
      expect(screen.getByText('saved text')).toBeTruthy();
    });
    expect(screen.queryByText('pending text')).toBeNull();
    expect(screen.getAllByTestId('message-item')).toHaveLength(1);
    expect(screen.getByTestId('message-item').getAttribute('data-message-id')).toBe('server-message-1');
    expect(screen.getByTestId('message-item').getAttribute('data-delivery-status')).toBe('sent');
  });

  it('can mark pending messages as failed', async () => {
    const ref = createRef<MessageListHandle>();
    render(<MessageList ref={ref} roomId="room-1" onReply={vi.fn()} roomPermissions={null} />);

    act(() => {
      socketMock.trigger('message_history', { roomId: 'room-1', messages: [], historyVersion: 0, hasMore: false, mode: 'replace' });
      ref.current?.addOptimisticMessage(message({
        id: 'temp-client-message-2',
        content: 'will fail',
        clientMessageId: 'client-message-2',
        deliveryStatus: 'pending',
      }));
    });

    act(() => {
      ref.current?.markOptimisticMessageFailed('client-message-2', 'network down');
    });

    expect(await screen.findByText('will fail')).toBeTruthy();
    expect(screen.getByTestId('message-item').getAttribute('data-delivery-status')).toBe('failed');
    expect(screen.getByTestId('message-item').getAttribute('data-delivery-error')).toBe('network down');
  });

  it('renders a recent message window and can load older messages', async () => {
    render(<MessageList roomId="room-1" onReply={vi.fn()} roomPermissions={null} />);

    const history = Array.from({ length: 85 }, (_, index) => {
      const messageNumber = index + 1;
      return message({
        id: `m-${messageNumber}`,
        content: `message ${messageNumber}`,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      });
    });

    act(() => {
      socketMock.trigger('message_history', {
        roomId: 'room-1',
        messages: history.slice(5),
        historyVersion: 1,
        hasMore: true,
        oldestMessageId: 'm-6',
        mode: 'replace',
      });
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('message-item')).toHaveLength(80);
    });
    expect(screen.queryByText('message 1')).toBeNull();
    expect(screen.getByText('message 6')).toBeTruthy();
    expect(screen.getByText('message 85')).toBeTruthy();

    fireEvent.click(screen.getByText('loadMoreMessages'));
    expect(socketMock.emit).toHaveBeenCalledWith('get_room_messages', {
      roomId: 'room-1',
      beforeMessageId: 'm-6',
      limit: 80,
    });

    act(() => {
      socketMock.trigger('message_history', {
        roomId: 'room-1',
        messages: history.slice(0, 5),
        historyVersion: 1,
        hasMore: false,
        oldestMessageId: 'm-1',
        mode: 'prepend',
      });
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('message-item')).toHaveLength(85);
    });
    expect(screen.getByText('message 1')).toBeTruthy();
  });

  it('uses the server pagination cursor instead of the timestamp-sorted first message', async () => {
    render(<MessageList roomId="room-1" onReply={vi.fn()} roomPermissions={null} />);

    act(() => {
      socketMock.trigger('message_history', {
        roomId: 'room-1',
        messages: [
          message({
            id: 'position-oldest',
            content: 'position oldest',
            timestamp: '2026-01-01T00:02:00.000Z',
          }),
          message({
            id: 'timestamp-oldest',
            content: 'timestamp oldest',
            timestamp: '2026-01-01T00:01:00.000Z',
          }),
        ],
        historyVersion: 1,
        hasMore: true,
        oldestMessageId: 'position-oldest',
        mode: 'replace',
      });
    });

    await screen.findByText('timestamp oldest');
    fireEvent.click(screen.getByText('loadMoreMessages'));

    expect(socketMock.emit).toHaveBeenCalledWith('get_room_messages', {
      roomId: 'room-1',
      beforeMessageId: 'position-oldest',
      limit: 80,
    });
  });

  it('keeps the room entry view pinned to the bottom when message content grows', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    const observedElements: Element[] = [];
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }

      observe(element: Element) {
        observedElements.push(element);
      }

      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    render(<MessageList roomId="room-1" onReply={vi.fn()} roomPermissions={null} />);
    act(() => {
      socketMock.trigger('message_history', {
        roomId: 'room-1',
        messages: [message({ id: 'image-message', content: 'image loaded later' })],
        historyVersion: 1,
        hasMore: false,
        mode: 'replace',
      });
    });
    await screen.findByText('image loaded later');

    const container = screen.getByTestId('message-list-scroll') as HTMLDivElement;
    const content = screen.getByTestId('message-list-content');
    let scrollHeight = 1000;
    let scrollTop = 900;
    Object.defineProperty(container, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    Object.defineProperty(container, 'scrollTo', {
      configurable: true,
      value: vi.fn((options: ScrollToOptions) => {
        scrollTop = Number(options.top || 0);
      }),
    });

    expect(observedElements).toContain(content);

    act(() => {
      scrollHeight = 1500;
      resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver));
    });

    expect(scrollTop).toBe(1500);
  });

  it('renders composer clearance as a single in-flow bottom inset', async () => {
    render(<MessageList roomId="room-1" onReply={vi.fn()} roomPermissions={null} bottomInsetPx={124} />);

    act(() => {
      socketMock.trigger('message_history', {
        roomId: 'room-1',
        messages: [message({ id: 'last-message', content: 'last visible message' })],
        historyVersion: 1,
        hasMore: false,
        mode: 'replace',
      });
    });
    await screen.findByText('last visible message');

    const inset = screen.getByTestId('message-list-scroll-end-inset');
    expect(inset.getAttribute('style')).toContain('height: 124px');
    expect(screen.getByTestId('message-list-scroll').className).toContain('pt-3');
    expect(screen.getByTestId('message-list-scroll').className).not.toContain('p-3');
    expect(screen.getByText('last visible message').parentElement?.className).not.toContain('pb-4');
  });

  it('keeps export controls outside the message scroll container', () => {
    render(<MessageList roomId="room-1" onReply={vi.fn()} roomPermissions={null} />);

    expect(screen.getByText('exportChat').closest('[data-testid="message-list-scroll"]')).toBeNull();
  });

  it('keeps the code workspace panel outside the message scroll container', () => {
    render(
      <MessageList
        roomId="room-1"
        onReply={vi.fn()}
        roomPermissions={null}
        presentation="code-agent"
        currentRoom={{
          id: 'room-1',
          name: 'Coco',
          createdAt: '2026-05-26T00:00:00.000Z',
          creatorId: 'client-1',
          type: 'coco',
          sandboxStatus: 'ready',
          cocoStatus: 'idle',
        }}
      />
    );

    expect(screen.getByTestId('message-list-shell').className).toContain('min-h-0');
    expect(screen.getByTestId('message-list-shell').className).toContain('overflow-hidden');
    expect(screen.getByTestId('code-agent-workspace').closest('[data-testid="message-list-scroll"]')).toBeNull();
    expect(screen.getByTestId('code-agent-workspace').className).toContain('sticky');
    expect(screen.getByTestId('code-agent-workspace').className).toContain('top-0');
  });

  it('uses current room AI settings when retrying an AI message', async () => {
    window.localStorage.setItem('aiRoles', JSON.stringify([
      { id: 'default', name: 'Assistant', systemPrompt: 'You are helpful', color: 'secondary', icon: 'lucide:bot' },
      { id: 'coder', name: 'Code Expert', systemPrompt: 'Review code', color: 'primary', icon: 'lucide:code' },
    ]));
    window.localStorage.setItem('roomtalk:ai-settings:room-1', JSON.stringify({
      selectedRoleId: 'coder',
      selectedModel: 'deepseek-v4-pro',
      maxContextMessages: 1,
    }));
    render(<MessageList roomId="room-1" onReply={vi.fn()} roomPermissions={null} />);

    act(() => {
      socketMock.trigger('message_history', {
        roomId: 'room-1',
        messages: [message({ id: 'ai-1', messageType: 'ai', content: 'old answer' })],
        historyVersion: 1,
        hasMore: false,
        mode: 'replace',
      });
    });

    fireEvent.click(await screen.findByText('retry-ai-1'));

    await waitFor(() => {
      expect(requestAIResponseMock).toHaveBeenCalledWith({
        roomId: 'room-1',
        retryForMessageId: 'ai-1',
        systemPrompt: 'Review code',
        roleName: 'Code Expert',
        model: 'deepseek-v4-pro',
        maxContextMessages: 1,
      });
    });
  });

  it('passes the current code-agent mode when retrying in a code-agent room', async () => {
    window.localStorage.setItem('aiRoles', JSON.stringify([
      { id: 'default', name: 'Assistant', systemPrompt: 'You are helpful', color: 'secondary', icon: 'lucide:bot' },
      { id: 'coder', name: 'Code Expert', systemPrompt: 'Review code', color: 'primary', icon: 'lucide:code' },
    ]));
    window.localStorage.setItem('roomtalk:ai-settings:room-1', JSON.stringify({
      selectedRoleId: 'coder',
      selectedModel: 'deepseek-v4-pro',
      maxContextMessages: 1,
    }));
    render(
      <MessageList
        roomId="room-1"
        onReply={vi.fn()}
        roomPermissions={null}
        presentation="code-agent"
        codeAgentMode="acceptEdits"
      />
    );

    act(() => {
      socketMock.trigger('message_history', {
        roomId: 'room-1',
        messages: [message({ id: 'ai-1', messageType: 'ai', content: 'old answer' })],
        historyVersion: 1,
        hasMore: false,
        mode: 'replace',
      });
    });

    fireEvent.click(await screen.findByText('retry-ai-1'));

    await waitFor(() => {
      expect(requestAIResponseMock).toHaveBeenCalledWith({
        roomId: 'room-1',
        retryForMessageId: 'ai-1',
        systemPrompt: 'Review code',
        roleName: 'Code Expert',
        model: 'deepseek-v4-pro',
        maxContextMessages: 1,
      });
    });
  });

  it('uses current room AI settings when editing and asking AI', async () => {
    window.localStorage.setItem('aiRoles', JSON.stringify([
      { id: 'default', name: 'Assistant', systemPrompt: 'You are helpful', color: 'secondary', icon: 'lucide:bot' },
      { id: 'a2ui-demo', name: 'A2UI Demo', systemPrompt: 'Use A2UI', color: 'warning', icon: 'lucide:layout-dashboard' },
    ]));
    window.localStorage.setItem('roomtalk:ai-settings:room-1', JSON.stringify({
      selectedRoleId: 'a2ui-demo',
      selectedModel: 'deepseek-v4-pro',
      maxContextMessages: 2,
    }));
    render(<MessageList roomId="room-1" onReply={vi.fn()} roomPermissions={null} />);

    act(() => {
      socketMock.trigger('message_history', {
        roomId: 'room-1',
        messages: [message({ id: 'm-edit', content: 'original' })],
        historyVersion: 1,
        hasMore: false,
        mode: 'replace',
      });
    });

    fireEvent.click(await screen.findByText('edit-m-edit'));
    fireEvent.click(screen.getByText('edit-and-ask'));

    await waitFor(() => {
      expect(requestEditMessageAndAIResponseMock).toHaveBeenCalledWith({
        roomId: 'room-1',
        messageId: 'm-edit',
        newContent: 'edited content',
        systemPrompt: 'Use A2UI',
        roleName: 'A2UI Demo',
        model: 'deepseek-v4-pro',
        maxContextMessages: 2,
      });
    });
  });

  it('passes the current code-agent mode when editing and asking in a code-agent room', async () => {
    window.localStorage.setItem('aiRoles', JSON.stringify([
      { id: 'default', name: 'Assistant', systemPrompt: 'You are helpful', color: 'secondary', icon: 'lucide:bot' },
      { id: 'a2ui-demo', name: 'A2UI Demo', systemPrompt: 'Use A2UI', color: 'warning', icon: 'lucide:layout-dashboard' },
    ]));
    window.localStorage.setItem('roomtalk:ai-settings:room-1', JSON.stringify({
      selectedRoleId: 'a2ui-demo',
      selectedModel: 'deepseek-v4-pro',
      maxContextMessages: 2,
    }));
    render(
      <MessageList
        roomId="room-1"
        onReply={vi.fn()}
        roomPermissions={null}
        presentation="code-agent"
        codeAgentMode="acceptEdits"
      />
    );

    act(() => {
      socketMock.trigger('message_history', {
        roomId: 'room-1',
        messages: [message({ id: 'm-edit', content: 'original' })],
        historyVersion: 1,
        hasMore: false,
        mode: 'replace',
      });
    });

    fireEvent.click(await screen.findByText('edit-m-edit'));
    fireEvent.click(screen.getByText('edit-and-ask'));

    await waitFor(() => {
      expect(requestEditMessageAndAIResponseMock).toHaveBeenCalledWith({
        roomId: 'room-1',
        messageId: 'm-edit',
        newContent: 'edited content',
        systemPrompt: 'Use A2UI',
        roleName: 'A2UI Demo',
        model: 'deepseek-v4-pro',
        maxContextMessages: 2,
      });
    });
  });

  it('does not force the room back to the bottom after the user scrolls away', () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    render(<MessageList roomId="room-1" onReply={vi.fn()} roomPermissions={null} />);

    const container = screen.getByTestId('message-list-scroll') as HTMLDivElement;
    let scrollHeight = 1500;
    let scrollTop = 0;
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      scrollTop = Number(options.top || 0);
    });
    Object.defineProperty(container, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    Object.defineProperty(container, 'scrollTo', { configurable: true, value: scrollTo });

    fireEvent.scroll(container);
    act(() => {
      scrollHeight = 1800;
      resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver));
    });

    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollTop).toBe(0);
  });
});
