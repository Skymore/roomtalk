// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Message, RoomPermissions } from '../utils/types';
import { buildMessageTimeline, MessageList, MessageListHandle } from './MessageList';
import { clearCachedRoomMessageWindow, writeCachedRoomMessageWindow } from '../utils/messageHistoryCache';

const requestAIResponseMock = vi.hoisted(() => vi.fn());
const requestEditMessageAndAIResponseMock = vi.hoisted(() => vi.fn());
const editQueuedCodeAgentInputMock = vi.hoisted(() => vi.fn());
const steerQueuedCodeAgentInputMock = vi.hoisted(() => vi.fn());
const cancelQueuedCodeAgentInputMock = vi.hoisted(() => vi.fn());
const loadCodeAgentWorkspaceSnapshotMock = vi.hoisted(() => vi.fn());
const getRoomMessagesForExportMock = vi.hoisted(() => vi.fn());
const getMediaDownloadUrlMock = vi.hoisted(() => vi.fn());
const downloadTranscriptHtmlMock = vi.hoisted(() => vi.fn());
const downloadTranscriptZipMock = vi.hoisted(() => vi.fn());
const sendMessageMock = vi.hoisted(() => vi.fn());
const sendStickerMock = vi.hoisted(() => vi.fn());
const editMessageMock = vi.hoisted(() => vi.fn());
const deleteMessageMock = vi.hoisted(() => vi.fn());
const socketMock = vi.hoisted(() => {
  const handlers = new Map<string, Set<(...args: any[]) => void>>();
  const pendingHistory: Array<{
    request: Record<string, any>;
    resolve: (history: Record<string, any>) => void;
  }> = [];
  const queuedHistory: Array<Record<string, any>> = [];
  const eventLog: Array<Record<string, any>> = [];
  let headSeq = 0;

  class MockSocketRequestError extends Error {
    constructor(readonly code: string | null, message: string) {
      super(message);
    }
  }

  const resolveHistory = (pending: typeof pendingHistory[number], history: Record<string, any>) => {
    const snapshotSeq = Number(history.snapshotSeq ?? headSeq);
    headSeq = Math.max(headSeq, snapshotSeq);
    pending.resolve({
      ...history,
      requestId: history.requestId || pending.request.requestId,
      snapshotSeq,
    });
  };

  const publishEvent = (roomId: string, type: string, payload: Record<string, any>) => {
    headSeq += 1;
    eventLog.push({
      id: `${roomId}:${headSeq}`,
      roomId,
      seq: headSeq,
      schemaVersion: 1,
      type,
      payload,
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    handlers.get('room_event_available')?.forEach(handler => handler({ roomId, headSeq }));
  };

  const api = {
    id: 'socket-1',
    handlers,
    publishEvent,
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
      if (event === 'message_history') {
        const history = args[0] as Record<string, any>;
        const pending = pendingHistory.shift();
        if (pending) resolveHistory(pending, history);
        else queuedHistory.push(history);
        return;
      }
      handlers.get(event)?.forEach(handler => handler(...args));
    },
    requestHistory: vi.fn((request: Record<string, any>) => {
      const { requestId: _requestId, ...loggedRequest } = request;
      api.emit('get_room_snapshot', Object.fromEntries(
        Object.entries(loggedRequest).filter(([, value]) => value !== undefined),
      ));
      return new Promise<Record<string, any>>(resolve => {
        const pending = { request, resolve };
        const queued = queuedHistory.shift();
        if (queued) resolveHistory(pending, queued);
        else pendingHistory.push(pending);
      });
    }),
    requestEvents: vi.fn(async (request: Record<string, any>) => ({
      requestId: request.requestId,
      roomId: request.roomId,
      events: eventLog.filter(event => event.roomId === request.roomId && event.seq > request.afterSeq),
      headSeq: Math.max(headSeq, request.afterSeq),
      minAvailableSeq: 1,
      hasMore: false,
    })),
    SocketRequestError: MockSocketRequestError,
    reset: () => {
      handlers.clear();
      pendingHistory.splice(0);
      queuedHistory.splice(0);
      eventLog.splice(0);
      headSeq = 0;
    },
  };
  return api;
});

describe('buildMessageTimeline', () => {
  it('groups one full agent turn while keeping standalone AI and user messages separate', () => {
    const messages = [
      message({ id: 'user-1', content: 'prompt' }),
      message({ id: 'turn-ai-1', clientId: 'ai_assistant', messageType: 'ai', turnId: 'turn-1', content: 'working' }),
      message({ id: 'turn-tool', clientId: 'code_agent_runner', messageType: 'tool_call', turnId: 'turn-1', content: 'Reading' }),
      message({ id: 'turn-ai-2', clientId: 'ai_assistant', messageType: 'ai', turnId: 'turn-1', content: 'done' }),
      message({ id: 'ordinary-ai', clientId: 'ai_assistant', messageType: 'ai', content: 'ordinary answer' }),
    ];

    const timeline = buildMessageTimeline(messages, []);

    expect(timeline.map(item => item.kind)).toEqual(['message', 'agent-turn', 'message']);
    expect(timeline[1].kind === 'agent-turn' ? timeline[1].messages.map(item => item.id) : []).toEqual([
      'turn-ai-1',
      'turn-tool',
      'turn-ai-2',
    ]);
  });

  it('infers the Codex backend for legacy turns without persisted metadata', () => {
    const timeline = buildMessageTimeline([
      message({
        id: 'codex-ai',
        clientId: 'ai_assistant',
        messageType: 'ai',
        turnId: 'turn-codex',
        username: 'CodexApp',
      }),
    ], []);

    expect(timeline[0].kind === 'agent-turn' ? timeline[0].turn.backend : null).toBe('codex-app-server');
    expect(timeline[0].kind === 'agent-turn' ? timeline[0].turn.assistantName : null).toBe('Codex');
  });

  it('keeps pending queued prompts out of the canonical history timeline', () => {
    const messages = [
      message({ id: 'turn-1-ai', clientId: 'ai_assistant', messageType: 'ai', turnId: 'turn-1', content: 'working' }),
      message({
        id: 'queued-next',
        content: 'do this next',
        codeAgentQueuedInput: {
          state: 'queued',
          queuedAt: '2026-07-10T00:00:01.000Z',
          updatedAt: '2026-07-10T00:00:03.000Z',
        },
      }),
      message({ id: 'turn-1-final', clientId: 'ai_assistant', messageType: 'ai', turnId: 'turn-1', content: 'done' }),
      message({ id: 'turn-2-ai', clientId: 'ai_assistant', messageType: 'ai', turnId: 'turn-2', content: 'next work' }),
    ];

    const timeline = buildMessageTimeline(messages, []);

    expect(timeline.map(item => item.kind)).toEqual(['agent-turn', 'agent-turn']);
    expect(timeline[0].kind === 'agent-turn' ? timeline[0].messages.map(item => item.id) : []).toEqual([
      'turn-1-ai',
      'turn-1-final',
    ]);
    expect(timeline[1].kind === 'agent-turn' ? timeline[1].turn.id : null).toBe('turn-2');
  });
});

vi.mock('../utils/socket', () => ({
  socket: socketMock,
  clientId: 'client-1',
  requestAIResponse: requestAIResponseMock,
  requestEditMessageAndAIResponse: requestEditMessageAndAIResponseMock,
  editQueuedCodeAgentInput: editQueuedCodeAgentInputMock,
  steerQueuedCodeAgentInput: steerQueuedCodeAgentInputMock,
  cancelQueuedCodeAgentInput: cancelQueuedCodeAgentInputMock,
  getRoomMessagesForExport: getRoomMessagesForExportMock,
  getMediaDownloadUrl: getMediaDownloadUrlMock,
  sendMessage: sendMessageMock,
  sendSticker: sendStickerMock,
  editMessage: editMessageMock,
  deleteMessage: deleteMessageMock,
  requestRoomSnapshot: socketMock.requestHistory,
  requestRoomEvents: socketMock.requestEvents,
  SocketRequestError: socketMock.SocketRequestError,
}));

vi.mock('../utils/chatExport', () => ({
  downloadTranscriptHtml: downloadTranscriptHtmlMock,
  downloadTranscriptZip: downloadTranscriptZipMock,
}));

vi.mock('../utils/codeAgentWorkspace', async () => {
  const actual = await vi.importActual<typeof import('../utils/codeAgentWorkspace')>('../utils/codeAgentWorkspace');
  return {
    ...actual,
    loadCodeAgentWorkspaceSnapshot: loadCodeAgentWorkspaceSnapshotMock,
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { message?: string }) => values?.message ? `${key}:${values.message}` : key,
  }),
}));

vi.mock('@iconify/react', () => ({
  Icon: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

const modalMocks = vi.hoisted(() => ({
  onConfirmDelete: undefined as (() => void) | undefined,
  onSaveAndAskAI: undefined as ((messageId: string, content: string) => void) | undefined,
}));

vi.mock('./MessageItem', () => ({
  MessageItem: ({
    message,
    aiRequestRoomKind,
    onRefreshAI,
    onRetryDelivery,
    onStartEdit,
    onEditQueuedMessage,
    onSteerQueuedMessage,
    onCancelQueuedMessage,
    onDeleteMessage,
    onOpenWorkspaceFile,
    isInteractionDisabled,
  }: {
    message: Message;
    aiRequestRoomKind?: string;
    onRefreshAI?: (messageId: string) => void;
    onRetryDelivery?: (message: Message) => void;
    onStartEdit?: (messageId: string) => void;
    onEditQueuedMessage?: (messageId: string) => void;
    onSteerQueuedMessage?: (messageId: string) => void;
    onCancelQueuedMessage?: (messageId: string) => void;
    onDeleteMessage?: (messageId: string) => void;
    onOpenWorkspaceFile?: (path: string) => void;
    isInteractionDisabled?: boolean;
  }) => (
    <div
      data-testid="message-item"
      data-message-id={message.id}
      data-client-message-id={message.clientMessageId || ''}
      data-delivery-status={message.deliveryStatus || ''}
      data-delivery-error={message.deliveryError || ''}
      data-delivery-action={message.deliveryAction || ''}
      data-ai-request-room-kind={aiRequestRoomKind || ''}
      data-interaction-disabled={String(Boolean(isInteractionDisabled))}
    >
      {message.content}
      <button type="button" onClick={() => onRefreshAI?.(message.id)}>retry-{message.id}</button>
      <button type="button" onClick={() => onRetryDelivery?.(message)}>retry-delivery-{message.id}</button>
      <button type="button" onClick={() => onStartEdit?.(message.id)}>edit-{message.id}</button>
      <button type="button" onClick={() => onEditQueuedMessage?.(message.id)}>edit-queued-{message.id}</button>
      <button type="button" onClick={() => onSteerQueuedMessage?.(message.id)}>steer-queued-{message.id}</button>
      <button type="button" onClick={() => onCancelQueuedMessage?.(message.id)}>cancel-queued-{message.id}</button>
      <button type="button" onClick={() => onDeleteMessage?.(message.id)}>delete-{message.id}</button>
      <button type="button" onClick={() => onOpenWorkspaceFile?.('src/App.tsx#L42')}>open-workspace-{message.id}</button>
    </div>
  ),
  preloadMarkdownContent: () => {},
}));

vi.mock('./DeleteConfirmationModal', () => ({
  DeleteConfirmationModal: ({ isOpen, onConfirm }: { isOpen: boolean; onConfirm?: () => void }) => {
    modalMocks.onConfirmDelete = onConfirm;
    return isOpen ? <button type="button" onClick={onConfirm}>confirm-delete</button> : null;
  },
}));

vi.mock('./EditMessageModal', () => ({
  EditMessageModal: ({ message, onSave, onSaveAndAskAI, showSaveAndAskAI = true }: { message?: Message | null; onSave?: (messageId: string, content: string) => void; onSaveAndAskAI?: (messageId: string, content: string) => void; showSaveAndAskAI?: boolean }) => {
    modalMocks.onSaveAndAskAI = onSaveAndAskAI;
    return message ? <>
      <button type="button" onClick={() => onSave?.(message.id, 'edited content')}>save-edit</button>
      {showSaveAndAskAI && <button type="button" onClick={() => onSaveAndAskAI?.(message.id, 'edited content')}>edit-and-ask</button>}
    </> : null;
  },
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

const postingPermissions: RoomPermissions = {
  roomId: 'room-1',
  clientId: 'client-1',
  role: 'member',
  canPost: true,
  canEditAnyMessage: false,
  canDeleteAnyMessage: false,
  canClearHistory: false,
  canManageRoom: false,
  canManageAdmins: false,
  canManageMembers: false,
  canTransferOwnership: false,
  canUseCodeAgent: true,
};

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

const resolveNextHistory = async (history: Record<string, unknown>) => {
  await act(async () => {
    socketMock.trigger('message_history', history);
    await Promise.resolve();
  });
};

describe('MessageList optimistic messages', () => {
  beforeEach(async () => {
    cleanup();
    const localStorageMock = createLocalStorageMock();
    Object.defineProperty(window, 'localStorage', { configurable: true, value: localStorageMock });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorageMock });
    socketMock.reset();
    vi.clearAllMocks();
    modalMocks.onConfirmDelete = undefined;
    modalMocks.onSaveAndAskAI = undefined;
    window.localStorage.clear();
    await clearCachedRoomMessageWindow('room-1');
    requestAIResponseMock.mockResolvedValue(undefined);
    requestEditMessageAndAIResponseMock.mockResolvedValue(undefined);
    editQueuedCodeAgentInputMock.mockResolvedValue(undefined);
    steerQueuedCodeAgentInputMock.mockResolvedValue(undefined);
    cancelQueuedCodeAgentInputMock.mockResolvedValue(undefined);
    getRoomMessagesForExportMock.mockResolvedValue([]);
    getMediaDownloadUrlMock.mockResolvedValue({ url: 'https://signed.example/media' });
    downloadTranscriptHtmlMock.mockResolvedValue(undefined);
    downloadTranscriptZipMock.mockResolvedValue(undefined);
    sendMessageMock.mockReset();
    sendStickerMock.mockReset();
    editMessageMock.mockResolvedValue(message({ content: 'edited content' }));
    deleteMessageMock.mockResolvedValue(undefined);
    loadCodeAgentWorkspaceSnapshotMock.mockResolvedValue({
      roomId: 'room-1',
      backend: 'code-agent',
      source: 'sandbox',
      generatedAt: '2026-05-29T00:00:00.000Z',
      status: { sandboxStatus: 'ready', agentStatus: 'idle', hasSession: false },
      summary: {
        toolCalls: 0,
        toolResults: 0,
        toolErrors: 0,
        lastToolName: null,
      },
      artifacts: [],
      changes: { available: false, changedFiles: [], changedFileStats: [], diffSummary: null },
      commands: [],
    });
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows pending messages and replaces matching server messages without duplicates', async () => {
    const ref = createRef<MessageListHandle>();
    render(<MessageList ref={ref} roomId="room-1" onReply={vi.fn()} roomPermissions={null} />);

    await resolveNextHistory({ roomId: 'room-1', messages: [], snapshotSeq: 0, hasMore: false, mode: 'replace' });

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
      socketMock.publishEvent(saved.roomId, 'messages.upserted', { messageIds: [saved.id], messages: [saved] });
      socketMock.publishEvent(saved.roomId, 'messages.upserted', { messageIds: [saved.id], messages: [saved] });
    });

    await waitFor(() => {
      expect(screen.getByText('saved text')).toBeTruthy();
    });
    expect(screen.queryByText('pending text')).toBeNull();
    expect(screen.getAllByTestId('message-item')).toHaveLength(1);
    expect(screen.getByTestId('message-item').getAttribute('data-message-id')).toBe('server-message-1');
    expect(screen.getByTestId('message-item').getAttribute('data-delivery-status')).toBe('sent');
  });

  it('wires queued edit, steer, and cancel actions to their dedicated APIs', async () => {
    render(<MessageList roomId="room-1" onReply={vi.fn()} roomPermissions={null} presentation="code-agent" />);
    const queuedMessage = message({
      id: 'queued-1',
      codeAgentQueuedInput: {
        state: 'queued',
        queuedAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
      },
    });

    act(() => {
      socketMock.trigger('message_history', {
        roomId: 'room-1',
        messages: [queuedMessage],
        snapshotSeq: 1,
        hasMore: false,
        mode: 'replace',
      });
    });

    expect((await screen.findByTestId('code-agent-pending-queue')).closest('[role="log"]')).toBeNull();

    fireEvent.click(await screen.findByText('steer-queued-queued-1'));
    await waitFor(() => expect(steerQueuedCodeAgentInputMock).toHaveBeenCalledWith('room-1', 'queued-1'));

    fireEvent.click(screen.getByText('cancel-queued-queued-1'));
    await waitFor(() => expect(cancelQueuedCodeAgentInputMock).toHaveBeenCalledWith('room-1', 'queued-1'));

    fireEvent.click(screen.getByText('edit-queued-queued-1'));
    expect(screen.queryByText('edit-and-ask')).toBeNull();
    fireEvent.click(await screen.findByText('save-edit'));
    await waitFor(() => expect(editQueuedCodeAgentInputMock).toHaveBeenCalledWith('room-1', 'queued-1', 'edited content'));
  });

  it('can mark pending messages as failed', async () => {
    const ref = createRef<MessageListHandle>();
    render(<MessageList ref={ref} roomId="room-1" onReply={vi.fn()} roomPermissions={null} />);

    await resolveNextHistory({ roomId: 'room-1', messages: [], snapshotSeq: 0, hasMore: false, mode: 'replace' });
    act(() => {
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

  it('retries a failed text message with its original id, content, reply, and avatar', async () => {
    let resolveRetry: (message: Message) => void = () => {};
    sendMessageMock.mockImplementation(() => new Promise<Message>((resolve) => {
      resolveRetry = resolve;
    }));
    const ref = createRef<MessageListHandle>();
    render(
      <MessageList
        ref={ref}
        roomId="room-1"
        onReply={vi.fn()}
        roomPermissions={postingPermissions}
        isRoomSessionReady
      />,
    );

    const failed = message({
      id: 'temp-client-message-3',
      content: 'retry this text',
      clientMessageId: 'client-message-3',
      deliveryStatus: 'failed',
      deliveryError: 'network down',
      username: 'Ada',
      avatar: { text: 'A', color: 'primary' },
      replyTo: { messageId: 'quoted-1', messageType: 'text', preview: 'quoted' },
    });
    await resolveNextHistory({ roomId: 'room-1', messages: [], snapshotSeq: 0, hasMore: false, mode: 'replace' });
    act(() => {
      ref.current?.addOptimisticMessage(failed);
    });

    fireEvent.click(await screen.findByText('retry-delivery-temp-client-message-3'));

    await waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith(
        'retry this text',
        'room-1',
        'text',
        'Ada',
        { text: 'A', color: 'primary' },
        'quoted-1',
        'client-message-3',
      );
    });
    expect(screen.getByTestId('message-item').getAttribute('data-delivery-status')).toBe('pending');

    const saved = message({
      id: 'server-message-3',
      content: failed.content,
      clientMessageId: failed.clientMessageId,
      username: failed.username,
      avatar: failed.avatar,
      replyTo: failed.replyTo,
    });
    await act(async () => resolveRetry(saved));

    await waitFor(() => {
      expect(screen.getByTestId('message-item').getAttribute('data-message-id')).toBe('server-message-3');
      expect(screen.getByTestId('message-item').getAttribute('data-delivery-status')).toBe('sent');
    });
  });

  it('retries a failed sticker and keeps a retry failure visible', async () => {
    sendStickerMock.mockRejectedValueOnce(new Error('still offline'));
    const ref = createRef<MessageListHandle>();
    render(
      <MessageList
        ref={ref}
        roomId="room-1"
        onReply={vi.fn()}
        roomPermissions={postingPermissions}
        isRoomSessionReady
      />,
    );
    await resolveNextHistory({ roomId: 'room-1', messages: [], snapshotSeq: 0, hasMore: false, mode: 'replace' });
    act(() => {
      ref.current?.addOptimisticMessage(message({
        id: 'temp-sticker-1',
        content: 'xiaokumao/001/01',
        messageType: 'sticker',
        clientMessageId: 'client-sticker-1',
        deliveryStatus: 'failed',
        deliveryError: 'offline',
        username: 'Ada',
        avatar: { text: 'A', color: 'primary' },
      }));
    });

    fireEvent.click(await screen.findByText('retry-delivery-temp-sticker-1'));

    await waitFor(() => {
      expect(sendStickerMock).toHaveBeenCalledWith(
        'xiaokumao/001/01',
        'room-1',
        'Ada',
        { text: 'A', color: 'primary' },
        undefined,
        'client-sticker-1',
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('message-item').getAttribute('data-delivery-status')).toBe('failed');
      expect(screen.getByTestId('message-item').getAttribute('data-delivery-error')).toBe('still offline');
    });
  });

  it('does not retry delivery while posting is unavailable', async () => {
    const ref = createRef<MessageListHandle>();
    render(
      <MessageList
        ref={ref}
        roomId="room-1"
        onReply={vi.fn()}
        roomPermissions={{ ...postingPermissions, canPost: false }}
        isRoomSessionReady
      />,
    );
    await resolveNextHistory({ roomId: 'room-1', messages: [], snapshotSeq: 0, hasMore: false, mode: 'replace' });
    act(() => {
      ref.current?.addOptimisticMessage(message({
        id: 'temp-locked',
        clientMessageId: 'client-locked',
        deliveryStatus: 'failed',
      }));
    });

    fireEvent.click(await screen.findByText('retry-delivery-temp-locked'));
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('does not downgrade Ask AI to ordinary delivery retry when a committed room event arrives before a failed ack', async () => {
    const ref = createRef<MessageListHandle>();
    render(
      <MessageList
        ref={ref}
        roomId="room-1"
        onReply={vi.fn()}
        roomPermissions={postingPermissions}
        isRoomSessionReady
      />,
    );
    const clientMessageId = 'ask-ai-client-message';

    await resolveNextHistory({ roomId: 'room-1', messages: [], snapshotSeq: 0, hasMore: false, mode: 'replace' });
    act(() => {
      ref.current?.addOptimisticMessage(message({
        id: 'temp-ask-ai',
        clientMessageId,
        deliveryStatus: 'pending',
        deliveryAction: 'ask-ai',
      }));
    });
    act(() => {
      const saved = message({
        id: 'canonical-ask-ai',
        clientMessageId,
      });
      socketMock.publishEvent(saved.roomId, 'messages.upserted', { messageIds: [saved.id], messages: [saved] });
    });
    act(() => {
      ref.current?.markOptimisticMessageFailed(clientMessageId, 'ack timeout');
    });

    await waitFor(() => {
      expect(screen.getByTestId('message-item').getAttribute('data-message-id')).toBe('canonical-ask-ai');
    });
    const item = screen.getByTestId('message-item');
    expect(item.getAttribute('data-message-id')).toBe('canonical-ask-ai');
    expect(item.getAttribute('data-delivery-status')).toBe('sent');
    expect(item.getAttribute('data-delivery-action')).toBe('ask-ai');
    fireEvent.click(screen.getByText('retry-delivery-canonical-ask-ai'));
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('passes workspace file link openings down to rendered messages', async () => {
    const onOpenWorkspaceFile = vi.fn();
    render(
      <MessageList
        roomId="room-1"
        onReply={vi.fn()}
        roomPermissions={null}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />,
    );

    act(() => {
      socketMock.trigger('message_history', {
        roomId: 'room-1',
        messages: [message({ id: 'm-workspace-link', content: 'See [App](src/App.tsx#L42)' })],
        snapshotSeq: 1,
        hasMore: false,
        mode: 'replace',
      });
    });

    fireEvent.click(await screen.findByText('open-workspace-m-workspace-link'));

    expect(onOpenWorkspaceFile).toHaveBeenCalledWith('src/App.tsx#L42');
  });

  it('automatically loads older messages when the user reaches the top', async () => {
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
        snapshotSeq: 1,
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

    fireEvent.scroll(screen.getByTestId('message-list-scroll'));
    await waitFor(() => {
      expect(socketMock.emit).toHaveBeenCalledWith('get_room_snapshot', {
        roomId: 'room-1',
        beforeMessageId: 'm-6',
        limit: 80,
      });
    });

    act(() => {
      socketMock.trigger('message_history', {
        roomId: 'room-1',
        messages: history.slice(0, 5),
        snapshotSeq: 1,
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
        snapshotSeq: 1,
        hasMore: true,
        oldestMessageId: 'position-oldest',
        mode: 'replace',
      });
    });

    await screen.findByText('timestamp oldest');
    fireEvent.scroll(screen.getByTestId('message-list-scroll'));

    await waitFor(() => {
      expect(socketMock.emit).toHaveBeenCalledWith('get_room_snapshot', {
        roomId: 'room-1',
        beforeMessageId: 'position-oldest',
        limit: 80,
      });
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
        snapshotSeq: 1,
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
        snapshotSeq: 1,
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

  it('keeps export busy through generation and reports success or format-specific failure without alert()', async () => {
    let resolveHtml!: () => void;
    downloadTranscriptHtmlMock.mockImplementationOnce(() => new Promise<void>(resolve => { resolveHtml = resolve; }));
    const nativeAlert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    render(<MessageList roomId="room-1" onReply={vi.fn()} roomPermissions={null} />);

    fireEvent.click(screen.getByRole('button', { name: 'exportChat' }));
    fireEvent.click(await screen.findByText('exportHtml'));
    await waitFor(() => expect(downloadTranscriptHtmlMock).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'exportingChat' }).getAttribute('aria-busy')).toBe('true');

    await act(async () => resolveHtml());
    expect((await screen.findByRole('status')).textContent).toContain('exportSucceeded');

    downloadTranscriptZipMock.mockRejectedValueOnce(new Error('zip failed'));
    fireEvent.click(screen.getByRole('button', { name: 'exportChat' }));
    fireEvent.click(await screen.findByText('exportZip'));
    expect((await screen.findByRole('alert')).textContent).toContain('exportFormatFailed');
    expect(nativeAlert).not.toHaveBeenCalled();
    nativeAlert.mockRestore();
  });

  it('keeps initial history hydration silent, then enables the realtime chat log', async () => {
    const animationFrames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    render(<MessageList roomId="room-1" onReply={vi.fn()} roomPermissions={null} />);

    const log = screen.getByRole('log', { name: 'messageLog' });
    expect(log.getAttribute('aria-live')).toBe('off');
    expect(log.getAttribute('aria-relevant')).toBe('additions');

    await resolveNextHistory({
      roomId: 'room-1',
      messages: [message({ id: 'historical-message', content: 'existing history' })],
      snapshotSeq: 1,
      hasMore: false,
      mode: 'replace',
    });
    expect(log.getAttribute('aria-live')).toBe('off');

    act(() => {
      while (animationFrames.length > 0) animationFrames.shift()?.(0);
    });
    expect(log.getAttribute('aria-live')).toBe('polite');
  });

  it('distinguishes loading session cost from an unavailable total', async () => {
    vi.useFakeTimers();
    render(<MessageList roomId="room-1" onReply={vi.fn()} roomPermissions={null} />);

    expect(screen.getByText('loadingSessionCost')).toBeTruthy();
    expect(screen.queryByText('costUnavailable')).toBeNull();

    await act(async () => { vi.advanceTimersByTime(8000); });

    expect(document.body.textContent).toContain('costUnavailable');
    vi.useRealTimers();
  });

  it('does not announce a historical failed message as a fresh delivery failure', async () => {
    render(<MessageList roomId="room-1" onReply={vi.fn()} roomPermissions={null} />);
    act(() => {
      socketMock.trigger('message_history', {
        roomId: 'room-1',
        messages: [message({ id: 'old-failure', deliveryStatus: 'failed', deliveryError: 'old network error' })],
        snapshotSeq: 1,
        hasMore: false,
        mode: 'replace',
      });
    });

    await screen.findByText('hello');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('announces delivery failures and AI completion transitions', async () => {
    const ref = createRef<MessageListHandle>();
    render(<MessageList ref={ref} roomId="room-1" onReply={vi.fn()} roomPermissions={null} />);
    await resolveNextHistory({
      roomId: 'room-1',
      messages: [
        message({ id: 'streaming-ai', clientId: 'ai_assistant', messageType: 'ai', status: 'streaming', content: '' }),
      ],
      snapshotSeq: 1,
      hasMore: false,
      mode: 'replace',
    });

    act(() => ref.current?.addOptimisticMessage(message({
      id: 'pending-message',
      clientMessageId: 'pending-client',
      deliveryStatus: 'pending',
    })));

    act(() => ref.current?.markOptimisticMessageFailed('pending-client', 'network down'));
    const deliveryAlert = await screen.findByRole('alert');
    expect(deliveryAlert.textContent).toContain('messageDeliveryFailedAnnouncement');
    expect(deliveryAlert.getAttribute('aria-live')).toBeNull();
    expect(deliveryAlert.getAttribute('aria-atomic')).toBe('true');
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    act(() => {
      socketMock.trigger('ai_stream_end', {
        roomId: 'room-1',
        messageId: 'streaming-ai',
        content: '## Finished\n[answer](https://example.com) with `code`',
      });
    });
    const completionStatus = await screen.findByRole('status');
    expect(completionStatus.textContent).toContain('aiResponseCompleteSummaryAnnouncement');
    expect(completionStatus.textContent).toContain('Finished answer with code');
    expect(completionStatus.textContent).not.toContain('https://example.com');
    expect(completionStatus.getAttribute('aria-live')).toBeNull();
    expect(completionStatus.getAttribute('aria-atomic')).toBe('true');
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('uses instant scrolling when reduced motion is requested', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    });
    const ref = createRef<MessageListHandle>();
    render(<MessageList ref={ref} roomId="room-1" onReply={vi.fn()} roomPermissions={null} />);
    const container = screen.getByTestId('message-list-scroll');
    const scrollTo = vi.fn();
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 500 });
    Object.defineProperty(container, 'scrollTo', { configurable: true, value: scrollTo });

    act(() => ref.current?.scrollToBottom('smooth'));

    expect(scrollTo).toHaveBeenCalledWith({ top: 500, behavior: 'auto' });
  });

  it('locks queued message actions while a restored room shell is unverified', async () => {
    await writeCachedRoomMessageWindow({
      roomId: 'room-1',
      messages: [message({
        codeAgentQueuedInput: {
          state: 'queued',
          queuedAt: '2026-07-10T00:00:00.000Z',
          updatedAt: '2026-07-10T00:00:00.000Z',
        },
      })],
      lastAppliedSeq: 1,
      hasMore: false,
      cachedAt: Date.now(),
    });
    render(<MessageList
      roomId="room-1"
      onReply={vi.fn()}
      roomPermissions={null}
      presentation="code-agent"
      currentRoom={{
        id: 'room-1',
        name: 'Code Agent',
        createdAt: '2026-05-26T00:00:00.000Z',
        creatorId: 'client-1',
        type: 'codeAgent',
        sandboxStatus: 'ready',
        codeAgentStatus: 'idle',
      }}
      isRoomSessionReady={false}
    />);
    const item = await screen.findByTestId('message-item');
    expect(item.getAttribute('data-interaction-disabled')).toBe('true');
    fireEvent.click(screen.getByText('edit-queued-m1'));
    fireEvent.click(screen.getByText('steer-queued-m1'));
    fireEvent.click(screen.getByText('cancel-queued-m1'));
    expect(editQueuedCodeAgentInputMock).not.toHaveBeenCalled();
    expect(steerQueuedCodeAgentInputMock).not.toHaveBeenCalled();
    expect(cancelQueuedCodeAgentInputMock).not.toHaveBeenCalled();
  });

  it('keeps acknowledged queued actions visible and recovers before mutating', async () => {
    let resolveRecovery!: () => void;
    const ensureRoomSessionReady = vi.fn(() => new Promise<void>(resolve => {
      resolveRecovery = resolve;
    }));
    await writeCachedRoomMessageWindow({
      roomId: 'room-1',
      messages: [message({
        codeAgentQueuedInput: {
          state: 'queued',
          queuedAt: '2026-07-10T00:00:00.000Z',
          updatedAt: '2026-07-10T00:00:00.000Z',
        },
      })],
      lastAppliedSeq: 1,
      hasMore: false,
      cachedAt: Date.now(),
    });
    render(<MessageList
      roomId="room-1"
      onReply={vi.fn()}
      roomPermissions={postingPermissions}
      presentation="code-agent"
      isRoomSessionReady={false}
      canUseRetainedRoomAccess
      ensureRoomSessionReady={ensureRoomSessionReady}
    />);

    const item = await screen.findByTestId('message-item');
    expect(item.getAttribute('data-interaction-disabled')).toBe('false');
    fireEvent.click(screen.getByText('steer-queued-m1'));

    await waitFor(() => expect(ensureRoomSessionReady).toHaveBeenCalledWith('room-1'));
    expect(steerQueuedCodeAgentInputMock).not.toHaveBeenCalled();

    await act(async () => resolveRecovery());
    await waitFor(() => expect(steerQueuedCodeAgentInputMock).toHaveBeenCalledWith('room-1', 'm1'));
  });

  it('does not request message history until the restored room session is verified', async () => {
    const rendered = render(
      <MessageList roomId="room-1" onReply={vi.fn()} roomPermissions={null} isRoomSessionReady={false} />
    );
    await act(async () => {});
    expect(socketMock.emit).not.toHaveBeenCalledWith(
      'get_room_snapshot',
      expect.objectContaining({ roomId: 'room-1' }),
    );

    rendered.rerender(
      <MessageList roomId="room-1" onReply={vi.fn()} roomPermissions={null} isRoomSessionReady />
    );
    await waitFor(() => {
      expect(socketMock.emit).toHaveBeenCalledWith('get_room_snapshot', {
        roomId: 'room-1',
        limit: 80,
      });
    });
  });

  it('does not auto-load cached history until the restored room session is verified', async () => {
    await writeCachedRoomMessageWindow({
      roomId: 'room-1',
      messages: [message({ id: 'cached-oldest' })],
      lastAppliedSeq: 1,
      hasMore: true,
      oldestMessageId: 'cached-oldest',
      cachedAt: Date.now(),
    });
    const rendered = render(
      <MessageList roomId="room-1" onReply={vi.fn()} roomPermissions={null} isRoomSessionReady={false} />
    );
    await screen.findByTestId('history-load-sentinel');
    socketMock.emit.mockClear();
    fireEvent.scroll(screen.getByTestId('message-list-scroll'));
    expect(socketMock.emit).not.toHaveBeenCalled();

    rendered.rerender(
      <MessageList roomId="room-1" onReply={vi.fn()} roomPermissions={null} isRoomSessionReady />
    );
    await waitFor(() => expect(socketMock.requestEvents).toHaveBeenCalled());
    socketMock.emit.mockClear();
    fireEvent.scroll(screen.getByTestId('message-list-scroll'));
    await waitFor(() => {
      expect(socketMock.emit).toHaveBeenCalledWith('get_room_snapshot', {
        roomId: 'room-1',
        beforeMessageId: 'cached-oldest',
        limit: 80,
      });
    });
  });

  it('closes open edit and delete modals and rejects their stale callbacks when the session becomes unverified', async () => {
    const rendered = render(
      <MessageList roomId="room-1" onReply={vi.fn()} roomPermissions={null} isRoomSessionReady />
    );
    act(() => {
      socketMock.trigger('message_history', {
        roomId: 'room-1',
        messages: [message({ id: 'modal-message', content: 'editable' })],
        snapshotSeq: 1,
        hasMore: false,
        mode: 'replace',
      });
    });

    fireEvent.click(await screen.findByText('edit-modal-message'));
    expect(screen.getByText('edit-and-ask')).toBeTruthy();
    const staleEdit = modalMocks.onSaveAndAskAI;

    fireEvent.click(screen.getByText('delete-modal-message'));
    expect(screen.getByText('confirm-delete')).toBeTruthy();
    const staleDelete = modalMocks.onConfirmDelete;

    rendered.rerender(
      <MessageList roomId="room-1" onReply={vi.fn()} roomPermissions={null} isRoomSessionReady={false} />
    );

    await waitFor(() => {
      expect(screen.queryByText('edit-and-ask')).toBeNull();
      expect(screen.queryByText('confirm-delete')).toBeNull();
    });
    act(() => {
      staleEdit?.('modal-message', 'late edit');
      staleDelete?.();
    });

    expect(requestEditMessageAndAIResponseMock).not.toHaveBeenCalled();
    expect(socketMock.emit).not.toHaveBeenCalledWith(
      'delete_message',
      expect.anything(),
      expect.anything(),
    );
  });

  it('keeps open message actions during a transient reconnect and validates before delete', async () => {
    let resolveRecovery!: () => void;
    const ensureRoomSessionReady = vi.fn(() => new Promise<void>(resolve => {
      resolveRecovery = resolve;
    }));
    const rendered = render(
      <MessageList
        roomId="room-1"
        onReply={vi.fn()}
        roomPermissions={postingPermissions}
        isRoomSessionReady
        canUseRetainedRoomAccess
        ensureRoomSessionReady={ensureRoomSessionReady}
      />
    );
    act(() => {
      socketMock.trigger('message_history', {
        roomId: 'room-1',
        messages: [message({ id: 'modal-message', content: 'editable' })],
        snapshotSeq: 1,
        hasMore: false,
        mode: 'replace',
      });
    });

    fireEvent.click(await screen.findByText('edit-modal-message'));
    fireEvent.click(screen.getByText('delete-modal-message'));
    expect(screen.getByText('edit-and-ask')).toBeTruthy();
    expect(screen.getByText('confirm-delete')).toBeTruthy();

    rendered.rerender(
      <MessageList
        roomId="room-1"
        onReply={vi.fn()}
        roomPermissions={postingPermissions}
        isRoomSessionReady={false}
        canUseRetainedRoomAccess
        ensureRoomSessionReady={ensureRoomSessionReady}
      />
    );
    expect(screen.getByText('edit-and-ask')).toBeTruthy();
    expect(screen.getByText('confirm-delete')).toBeTruthy();

    fireEvent.click(screen.getByText('confirm-delete'));
    await waitFor(() => expect(ensureRoomSessionReady).toHaveBeenCalledWith('room-1'));
    expect(deleteMessageMock).not.toHaveBeenCalled();

    await act(async () => resolveRecovery());
    await waitFor(() => expect(deleteMessageMock).toHaveBeenCalledWith('room-1', 'modal-message'));
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
          name: 'Code Agent',
          createdAt: '2026-05-26T00:00:00.000Z',
          creatorId: 'client-1',
          type: 'codeAgent',
          sandboxStatus: 'ready',
          codeAgentStatus: 'idle',
        }}
      />
    );

    expect(screen.getByTestId('message-list-shell').className).toContain('min-h-0');
    expect(screen.getByTestId('message-list-shell').className).toContain('overflow-hidden');
    expect(screen.getByTestId('code-agent-workspace').closest('[data-testid="message-list-scroll"]')).toBeNull();
    expect(screen.getByTestId('code-agent-workspace').className).toContain('sticky');
    expect(screen.getByTestId('code-agent-workspace').className).toContain('top-0');
  });

  it('defers code workspace requests and refresh UI until the room session is verified', async () => {
    const currentRoom = {
      id: 'room-1',
      name: 'Code Agent',
      createdAt: '2026-05-26T00:00:00.000Z',
      creatorId: 'client-1',
      type: 'codeAgent' as const,
      sandboxStatus: 'ready' as const,
      codeAgentStatus: 'idle' as const,
    };
    const rendered = render(
      <MessageList
        roomId="room-1"
        onReply={vi.fn()}
        roomPermissions={null}
        presentation="code-agent"
        currentRoom={currentRoom}
        isRoomSessionReady={false}
      />
    );
    await act(async () => {});
    expect(loadCodeAgentWorkspaceSnapshotMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('code-agent-refresh-workspace')).toBeNull();

    rendered.rerender(
      <MessageList
        roomId="room-1"
        onReply={vi.fn()}
        roomPermissions={null}
        presentation="code-agent"
        currentRoom={currentRoom}
        isRoomSessionReady
      />
    );
    await waitFor(() => expect(loadCodeAgentWorkspaceSnapshotMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('code-agent-refresh-workspace')).toBeTruthy();
  });

  it('retains the acknowledged workspace snapshot while the room reconnects', async () => {
    const onWorkspaceRootChange = vi.fn();
    loadCodeAgentWorkspaceSnapshotMock.mockResolvedValueOnce({
      roomId: 'room-1',
      backend: 'code-agent',
      source: 'sandbox',
      generatedAt: '2026-05-29T00:00:00.000Z',
      workspaceRoot: '/workspace',
      status: { sandboxStatus: 'ready', agentStatus: 'idle', hasSession: false },
      summary: { toolCalls: 0, toolResults: 0, toolErrors: 0, lastToolName: null },
      artifacts: [],
      changes: { available: false, changedFiles: [], changedFileStats: [], diffSummary: null },
      commands: [],
    });
    const currentRoom = {
      id: 'room-1',
      name: 'Code Agent',
      createdAt: '2026-05-26T00:00:00.000Z',
      creatorId: 'client-1',
      type: 'codeAgent' as const,
      sandboxStatus: 'ready' as const,
      codeAgentStatus: 'idle' as const,
    };
    const rendered = render(
      <MessageList
        roomId="room-1"
        onReply={vi.fn()}
        roomPermissions={postingPermissions}
        presentation="code-agent"
        currentRoom={currentRoom}
        isRoomSessionReady
        canUseRetainedRoomAccess
        onWorkspaceRootChange={onWorkspaceRootChange}
      />
    );
    await waitFor(() => expect(onWorkspaceRootChange).toHaveBeenCalledWith('/workspace'));
    onWorkspaceRootChange.mockClear();

    rendered.rerender(
      <MessageList
        roomId="room-1"
        onReply={vi.fn()}
        roomPermissions={postingPermissions}
        presentation="code-agent"
        currentRoom={currentRoom}
        isRoomSessionReady={false}
        canUseRetainedRoomAccess
        onWorkspaceRootChange={onWorkspaceRootChange}
      />
    );

    await act(async () => {});
    expect(onWorkspaceRootChange).not.toHaveBeenCalledWith(null);
    expect(screen.getByTestId('code-agent-workspace')).toBeTruthy();
    expect(screen.queryByTestId('code-agent-refresh-workspace')).toBeNull();
  });

  it('does not expose code-agent mode switching to non-managers', () => {
    const onCodeAgentModeChange = vi.fn();
    const memberPermissions: RoomPermissions = {
      roomId: 'room-1',
      clientId: 'member-1',
      role: 'member',
      canPost: true,
      canEditAnyMessage: false,
      canDeleteAnyMessage: false,
      canClearHistory: false,
      canManageRoom: false,
      canManageAdmins: false,
      canManageMembers: false,
      canTransferOwnership: false,
      canUseCodeAgent: true,
    };

    render(
      <MessageList
        roomId="room-1"
        onReply={vi.fn()}
        roomPermissions={memberPermissions}
        presentation="code-agent"
        currentRoom={{
          id: 'room-1',
          name: 'Code Agent',
          createdAt: '2026-05-26T00:00:00.000Z',
          creatorId: 'client-1',
          type: 'codeAgent',
          sandboxStatus: 'ready',
          codeAgentStatus: 'idle',
        }}
        codeAgentMode="plan"
        codeAgentAvailableModes={['plan', 'edit']}
        onCodeAgentModeChange={onCodeAgentModeChange}
      />
    );

    fireEvent.click(screen.getByTestId('code-agent-mode-toggle'));

    expect(onCodeAgentModeChange).not.toHaveBeenCalled();
  });

  it('refreshes the code workspace snapshot when the sandbox becomes ready', async () => {
    const baseRoom = {
      id: 'room-1',
      name: 'Code Agent',
      createdAt: '2026-05-26T00:00:00.000Z',
      creatorId: 'client-1',
      type: 'codeAgent' as const,
      codeAgentStatus: 'idle' as const,
    };

    const { rerender } = render(
      <MessageList
        roomId="room-1"
        onReply={vi.fn()}
        roomPermissions={null}
        presentation="code-agent"
        currentRoom={{
          ...baseRoom,
          sandboxStatus: 'none',
        }}
      />
    );

    await waitFor(() => {
      expect(loadCodeAgentWorkspaceSnapshotMock).toHaveBeenCalledTimes(1);
    });

    rerender(
      <MessageList
        roomId="room-1"
        onReply={vi.fn()}
        roomPermissions={null}
        presentation="code-agent"
        currentRoom={{
          ...baseRoom,
          sandboxStatus: 'ready',
          sandboxUpdatedAt: '2026-06-30T10:00:00.000Z',
        }}
      />
    );

    await waitFor(() => {
      expect(loadCodeAgentWorkspaceSnapshotMock).toHaveBeenCalledTimes(2);
    });
  });

  it('refreshes the code workspace snapshot when a code-agent turn settles', async () => {
    render(
      <MessageList
        roomId="room-1"
        onReply={vi.fn()}
        roomPermissions={null}
        presentation="code-agent"
        currentRoom={{
          id: 'room-1',
          name: 'Code Agent',
          createdAt: '2026-05-26T00:00:00.000Z',
          creatorId: 'client-1',
          type: 'codeAgent',
          sandboxStatus: 'ready',
          sandboxUpdatedAt: '2026-06-30T10:00:00.000Z',
          codeAgentStatus: 'running',
        }}
      />
    );

    await waitFor(() => {
      expect(loadCodeAgentWorkspaceSnapshotMock).toHaveBeenCalledTimes(1);
    });

    act(() => {
      socketMock.trigger('ai_stream_end', {
        roomId: 'room-1',
        messageId: 'ai-message-1',
        content: 'done',
      });
    });

    await waitFor(() => {
      expect(loadCodeAgentWorkspaceSnapshotMock).toHaveBeenCalledTimes(2);
    });

    act(() => {
      socketMock.trigger('ai_stream_error', {
        roomId: 'room-1',
        messageId: 'ai-message-2',
        error: 'failed',
      });
    });

    await waitFor(() => {
      expect(loadCodeAgentWorkspaceSnapshotMock).toHaveBeenCalledTimes(3);
    });
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
        snapshotSeq: 1,
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

  it('uses code-agent AI request settings when retrying in a code-agent room', async () => {
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
        snapshotSeq: 1,
        hasMore: false,
        mode: 'replace',
      });
    });

    expect((await screen.findByTestId('message-item')).dataset.aiRequestRoomKind).toBe('codeAgent');
    fireEvent.click(screen.getByText('retry-ai-1'));

    await waitFor(() => {
      expect(requestAIResponseMock).toHaveBeenCalledWith({
        roomId: 'room-1',
        retryForMessageId: 'ai-1',
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
        snapshotSeq: 1,
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

  it('uses code-agent AI request settings when editing and asking in a code-agent room', async () => {
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
        snapshotSeq: 1,
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
        model: 'deepseek-v4-pro',
        maxContextMessages: 2,
      });
    });
    expect(screen.getByTestId('message-item').dataset.aiRequestRoomKind).toBe('codeAgent');
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
