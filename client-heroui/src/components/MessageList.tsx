import React, { useEffect, useState, useRef, useCallback, useImperativeHandle } from 'react';
import { Icon } from '@iconify/react';
import { cancelQueuedCodeAgentInput, editQueuedCodeAgentInput, getMediaDownloadUrl, getRoomMessagesForExport, getRoomRoleMembers, removeRoomAdmin, removeRoomMember, requestAIResponse, requestEditMessageAndAIResponse, sendMessage, sendSticker, setRoomAdmin, socket, steerQueuedCodeAgentInput, transferRoomOwnership } from '../utils/socket';
import { MessageItem, MessageUserAction, preloadMarkdownContent } from './MessageItem';
import { Message, Room, RoomAgentTurn, RoomPermissions, RoomRoleMember } from '../utils/types';
import { AgentTurnItem } from './AgentTurnItem';
import { readMemoryRoomMessageWindow } from '../utils/messageHistoryCache';
import { useTranslation } from 'react-i18next';
import { getRoomAIRequestSettingsForKind, type AIRequestRoomKind } from '../utils/aiRequestSettings';
import { formatUsdCost } from '../utils/formatters';
import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger } from '@heroui/react';
import { downloadTranscriptHtml, downloadTranscriptZip, type ExportMediaResolver } from '../utils/chatExport';
import {
  addOptimisticMessage,
  deleteMessageById,
  editMessageAndTruncateAfter,
  editMessageContent,
  getMessageById,
  markOptimisticMessageFailed,
  replaceMessage,
  replaceOptimisticMessage,
  sortMessages,
  truncateBeforeMessage,
} from '../utils/messageState';
import { useRoomMessageEvents } from '../hooks/useRoomMessageEvents';
import { CodeAgentBackend, CodeAgentMode, getCodeAgentAssistantDisplayName } from '../utils/codeAgent';
import { CodeAgentWorkspaceSnapshot, loadCodeAgentWorkspaceSnapshot } from '../utils/codeAgentWorkspace';
import type { ReviewCommentContext } from '../utils/codeAgentReviewComments';

// Import your new modals
import { DeleteConfirmationModal } from './DeleteConfirmationModal';
import { EditMessageModal } from './EditMessageModal';
import { CodeAgentWorkspacePanel } from './CodeAgentWorkspacePanel';

const LOAD_MORE_MESSAGE_COUNT = 80;
const LOAD_MORE_SCROLL_THRESHOLD_PX = 240;
const AI_COMPLETION_ANNOUNCEMENT_MAX_CHARACTERS = 160;

type MessageTimelineItem =
  | { kind: 'message'; message: Message }
  | { kind: 'agent-turn'; turn: RoomAgentTurn; messages: Message[] };

export const buildMessageTimeline = (
  messages: Message[],
  turns: RoomAgentTurn[],
  activeTurnId?: string,
): MessageTimelineItem[] => {
  const historyMessages = messages.filter(message => message.codeAgentQueuedInput?.state === 'started' || !message.codeAgentQueuedInput);
  const turnById = new Map(turns.map(turn => [turn.id, turn]));
  const lastIndexByTurn = new Map<string, number>();
  historyMessages.forEach((message, index) => {
    if (message.turnId) lastIndexByTurn.set(message.turnId, index);
  });

  const timeline: MessageTimelineItem[] = [];
  for (let index = 0; index < historyMessages.length;) {
    const message = historyMessages[index];
    if (!message.turnId) {
      timeline.push({ kind: 'message', message });
      index++;
      continue;
    }

    const lastIndex = lastIndexByTurn.get(message.turnId) ?? index;
    const groupedMessages = historyMessages.slice(index, lastIndex + 1);
    const ownMessages = groupedMessages.filter(item => item.turnId === message.turnId);
    const firstTimestamp = ownMessages[0]?.timestamp || message.timestamp;
    const lastTimestamp = ownMessages.at(-1)?.timestamp || firstTimestamp;
    const lastAIMessage = [...ownMessages].reverse().find(item => item.messageType === 'ai');
    const persisted = turnById.get(message.turnId);
    const isRunning = persisted?.status === 'running' || (!persisted && activeTurnId === message.turnId);
    const assistantName = getCodeAgentAssistantDisplayName(message.username) || 'Coco';
    timeline.push({
      kind: 'agent-turn',
      messages: groupedMessages,
      turn: persisted || {
        id: message.turnId,
        roomId: message.roomId,
        status: isRunning ? 'running' : 'complete',
        startedAt: firstTimestamp,
        ...(!isRunning ? { completedAt: lastTimestamp } : {}),
        ...(lastAIMessage ? { finalMessageId: lastAIMessage.id } : {}),
        backend: assistantName === 'Codex' ? 'codex-app-server' : 'code-agent',
        assistantName,
        updatedAt: lastTimestamp,
      },
    });
    index = lastIndex + 1;
  }
  return timeline;
};

const buildAccessibleMessageSummary = (content: string) => {
  const plainText = content
    .replace(/```(?:[a-z0-9_-]+)?/gi, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[#>*+\-]+\s*/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(plainText);
  if (characters.length <= AI_COMPLETION_ANNOUNCEMENT_MAX_CHARACTERS) {
    return plainText;
  }
  return `${characters.slice(0, AI_COMPLETION_ANNOUNCEMENT_MAX_CHARACTERS).join('')}…`;
};

// Reminder: Set the app element for react-modal for accessibility
// Ideally in your root component file (e.g., App.tsx or main.tsx)
// Modal.setAppElement('#root');

interface MessageListProps {
  roomId: string;
  room?: Room;
  onReply?: (message: Message) => void;
  roomPermissions?: RoomPermissions | null;
  bottomInsetPx?: number;
  onScrollButtonVisibilityChange?: (isVisible: boolean) => void;
  presentation?: 'chat' | 'code-agent';
  currentRoom?: Room;
  codeAgentMode?: CodeAgentMode;
  codeAgentBackend?: CodeAgentBackend;
  codeAgentAvailableModes?: CodeAgentMode[];
  onCodeAgentModeChange?: (mode: CodeAgentMode) => void;
  onCodeAgentBackendChange?: (backend: CodeAgentBackend) => void;
  onOpenWorkspaceFile?: (path: string) => void;
  onOpenWorkspaceArtifact?: (url: string) => boolean;
  onWorkspaceRootChange?: (workspaceRoot: string | null) => void;
  onWorkspaceChangesChange?: (changes: CodeAgentWorkspaceSnapshot['changes'] | null) => void;
  reviewComments?: readonly ReviewCommentContext[];
  onAddReviewComment?: (comment: ReviewCommentContext) => void;
  onRemoveReviewComment?: (commentId: string) => void;
  isRoomSessionReady?: boolean;
}

export interface MessageListHandle {
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  addOptimisticMessage: (message: Message) => void;
  replaceOptimisticMessage: (clientMessageId: string, savedMessage: Message) => void;
  markOptimisticMessageFailed: (clientMessageId: string, error?: string) => void;
}

export const MessageList = React.forwardRef<MessageListHandle, MessageListProps>(({
  roomId,
  room,
  onReply = () => {},
  roomPermissions = null,
  bottomInsetPx = 16,
  onScrollButtonVisibilityChange,
  presentation = 'chat',
  currentRoom,
  codeAgentMode = 'plan',
  codeAgentBackend,
  codeAgentAvailableModes = ['plan'],
  onCodeAgentModeChange,
  onCodeAgentBackendChange,
  onOpenWorkspaceFile,
  onOpenWorkspaceArtifact,
  onWorkspaceRootChange,
  onWorkspaceChangesChange,
  reviewComments = [],
  onAddReviewComment,
  onRemoveReviewComment,
  isRoomSessionReady = true,
}, ref) => {
  const { t } = useTranslation();
  // generate a stable ID for the scroll container
  const scrollContainerId = `message-list-scroll-${roomId}`;
  const canManageCodeAgentMode = Boolean(roomPermissions?.canManageRoom);
  // Lazy initializers read the synchronous in-memory cache so the first paint
  // already shows the cached window (requires the `key={roomId}` remount in the
  // parent so these run per room).
  const [messages, setMessages] = useState<Message[]>(() => {
    const cached = readMemoryRoomMessageWindow(roomId);
    return cached ? cached.messages.filter(msg => msg.roomId === roomId) : [];
  });
  const [agentTurns, setAgentTurns] = useState<RoomAgentTurn[]>([]);
  const [isLoading, setIsLoading] = useState(() => !readMemoryRoomMessageWindow(roomId));
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(() => readMemoryRoomMessageWindow(roomId)?.hasMore ?? false);
  const [historyVersion, setHistoryVersion] = useState(() => readMemoryRoomMessageWindow(roomId)?.historyVersion ?? 0);
  const [oldestMessageId, setOldestMessageId] = useState<string | undefined>(() => readMemoryRoomMessageWindow(roomId)?.oldestMessageId);
  // Always points at the latest messages so item handlers can stay reference-stable.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const roomSessionReadyRef = useRef(isRoomSessionReady);
  roomSessionReadyRef.current = isRoomSessionReady;
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const historyLoadSentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreInFlightRef = useRef(false);
  const retryScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryingClientMessageIdsRef = useRef(new Set<string>());
  const isNearBottomRef = useRef(true);
  const preserveScrollRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const pendingScrollFrameRef = useRef<number | null>(null);
  const workspaceFetchAbortRef = useRef<AbortController | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  // State for modals
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [messageToDelete, setMessageToDelete] = useState<Message | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [messageToEdit, setMessageToEdit] = useState<Message | null>(null);
  const [sessionCostUsd, setSessionCostUsd] = useState<number | null>(null);
  const [isSessionCostUnavailable, setIsSessionCostUnavailable] = useState(false);
  const [exportNotice, setExportNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const exportNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accessibilityMessageStateRef = useRef(new Map<string, { status?: Message['status']; deliveryStatus?: Message['deliveryStatus'] }>());
  const accessibilityRoomRef = useRef(roomId);
  const announcementSequenceRef = useRef(0);
  const [statusAnnouncement, setStatusAnnouncement] = useState<{ id: number; text: string } | null>(null);
  const [errorAnnouncement, setErrorAnnouncement] = useState<{ id: number; text: string } | null>(null);
  const [isMessageLogLive, setIsMessageLogLive] = useState(false);
  const [workspaceSnapshot, setWorkspaceSnapshot] = useState<CodeAgentWorkspaceSnapshot | null>(null);
  const [isWorkspaceRefreshing, setIsWorkspaceRefreshing] = useState(false);
  const [workspaceRefreshError, setWorkspaceRefreshError] = useState<string | null>(null);
  const [roleMembers, setRoleMembers] = useState<RoomRoleMember[]>([]);
  const codeAgentRoom = currentRoom || (presentation === 'code-agent' ? room : undefined);
  const currentRoomId = codeAgentRoom?.id;
  const workspaceRefreshKey = `${currentRoomId || ''}:${codeAgentRoom?.sandboxStatus || 'none'}:${codeAgentRoom?.sandboxUpdatedAt || ''}`;
  const workspaceRoot = workspaceSnapshot?.workspaceRoot ?? null;
  const canManageSenderActions = Boolean(roomPermissions?.canManageMembers || roomPermissions?.canManageAdmins || roomPermissions?.canTransferOwnership);
  const aiRequestRoomKind: AIRequestRoomKind = presentation === 'code-agent' ? 'codeAgent' : 'chat';
  const getAIRequestSettingsForRoom = useCallback(() => (
    getRoomAIRequestSettingsForKind(roomId, aiRequestRoomKind)
  ), [aiRequestRoomKind, roomId]);

  const roleMemberByClientId = React.useMemo(() => {
    const map = new Map<string, RoomRoleMember>();
    roleMembers.forEach(member => map.set(member.clientId, member));
    return map;
  }, [roleMembers]);

  const toolResultPairing = React.useMemo(() => {
    const resultByCallId = new Map<string, Message>();
    const consumed = new Set<string>();
    const callIds = new Set<string>();
    for (const msg of messages) {
      if (msg.messageType === 'tool_call' && msg.toolCallId) {
        callIds.add(msg.toolCallId);
      }
    }
    for (const msg of messages) {
      if (msg.messageType === 'tool_result' && msg.toolCallId && callIds.has(msg.toolCallId)) {
        resultByCallId.set(msg.toolCallId, msg);
        consumed.add(msg.id);
      }
    }
    return { resultByCallId, consumed };
  }, [messages]);
  const displayMessages = React.useMemo(
    () => messages.filter(message => !(message.messageType === 'tool_result' && toolResultPairing.consumed.has(message.id))),
    [messages, toolResultPairing.consumed],
  );
  const pendingQueueMessages = React.useMemo(
    () => displayMessages.filter(message => Boolean(message.codeAgentQueuedInput && message.codeAgentQueuedInput.state !== 'started')),
    [displayMessages],
  );
  const activeTurnId = React.useMemo(() => {
    if (codeAgentRoom?.codeAgentStatus !== 'running') return undefined;
    return [...messages].reverse().find(message => message.turnId)?.turnId;
  }, [codeAgentRoom?.codeAgentStatus, messages]);
  const timelineItems = React.useMemo(
    () => buildMessageTimeline(displayMessages, agentTurns, activeTurnId),
    [activeTurnId, agentTurns, displayMessages],
  );

  const updateMessages = useCallback((updater: React.SetStateAction<Message[]>) => {
    setMessages(prev => {
      const next =
        typeof updater === 'function'
          ? (updater as (prevState: Message[]) => Message[])(prev)
          : updater;

      if (next === prev) {
        return prev;
      }

      return next;
    });
  }, []);

  const getCurrentMessages = useCallback(() => messagesRef.current, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const container = containerRef.current;
    if (container) {
      const effectiveBehavior = behavior === 'smooth'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : behavior;
      isNearBottomRef.current = true;
      setShowScrollButton(false);
      if (typeof container.scrollTo === 'function') {
        container.scrollTo({
          top: container.scrollHeight,
          behavior: effectiveBehavior,
        });
      } else {
        container.scrollTop = container.scrollHeight;
      }
      return;
    }

    // Intentionally avoid scrollIntoView here: it can scroll outer layout
    // ancestors and push the code workspace summary out of view.
  }, []);

  const scheduleScrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    if (typeof requestAnimationFrame !== 'function') {
      scrollToBottom(behavior);
      return;
    }

    if (pendingScrollFrameRef.current !== null) {
      cancelAnimationFrame(pendingScrollFrameRef.current);
    }

    pendingScrollFrameRef.current = requestAnimationFrame(() => {
      pendingScrollFrameRef.current = null;
      scrollToBottom(behavior);
    });
  }, [scrollToBottom]);

  useImperativeHandle(ref, () => ({
    scrollToBottom,
    addOptimisticMessage: (message: Message) => {
      updateMessages(prev => addOptimisticMessage(prev, message));
      scheduleScrollToBottom('auto');
    },
    replaceOptimisticMessage: (clientMessageId: string, savedMessage: Message) => {
      updateMessages(prev => replaceOptimisticMessage(prev, clientMessageId, savedMessage));
    },
    markOptimisticMessageFailed: (clientMessageId: string, error?: string) => {
      updateMessages(prev => markOptimisticMessageFailed(prev, clientMessageId, error));
    },
  }), [scheduleScrollToBottom, scrollToBottom, updateMessages]);

  const handleLoadMore = useCallback(() => {
    if (!roomSessionReadyRef.current || loadMoreInFlightRef.current || isLoadingMore || !hasMoreMessages || messages.length === 0) {
      return;
    }

    loadMoreInFlightRef.current = true;

    const container = containerRef.current;
    if (container) {
      preserveScrollRef.current = {
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
      };
    }

    setIsLoadingMore(true);
    socket.emit('get_room_messages', {
      roomId,
      beforeMessageId: oldestMessageId || messages[0].id,
      limit: LOAD_MORE_MESSAGE_COUNT,
      baseHistoryVersion: historyVersion,
    });
  }, [hasMoreMessages, historyVersion, isLoadingMore, messages, oldestMessageId, roomId]);

  useEffect(() => {
    if (!isLoadingMore) {
      loadMoreInFlightRef.current = false;
    }
  }, [isLoadingMore]);

  useEffect(() => {
    const container = containerRef.current;
    const sentinel = historyLoadSentinelRef.current;
    if (!container || !sentinel || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        handleLoadMore();
      }
    }, {
      root: container,
      rootMargin: `${LOAD_MORE_SCROLL_THRESHOLD_PX}px 0px 0px`,
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [handleLoadMore]);

  useEffect(() => {
    onScrollButtonVisibilityChange?.(showScrollButton);
  }, [showScrollButton, onScrollButtonVisibilityChange]);

  useEffect(() => {
    return () => {
      if (retryScrollTimerRef.current) {
        clearTimeout(retryScrollTimerRef.current);
      }
      if (pendingScrollFrameRef.current !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(pendingScrollFrameRef.current);
      }
      const workspaceController = workspaceFetchAbortRef.current;
      workspaceFetchAbortRef.current = null;
      workspaceController?.abort();
      if (exportNoticeTimerRef.current) {
        clearTimeout(exportNoticeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setIsSessionCostUnavailable(false);
    if (sessionCostUsd !== null) return;
    const timer = setTimeout(() => setIsSessionCostUnavailable(true), 8000);
    return () => clearTimeout(timer);
  }, [roomId, sessionCostUsd]);

  useEffect(() => {
    setIsMessageLogLive(false);
    if (isLoading) return undefined;

    let cancelled = false;
    const enableLiveMessages = () => {
      if (!cancelled) setIsMessageLogLive(true);
    };
    if (typeof requestAnimationFrame === 'function') {
      const frame = requestAnimationFrame(enableLiveMessages);
      return () => {
        cancelled = true;
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      };
    }

    const timer = setTimeout(enableLiveMessages, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isLoading, roomId]);

  useEffect(() => {
    if (accessibilityRoomRef.current !== roomId) {
      accessibilityRoomRef.current = roomId;
      accessibilityMessageStateRef.current.clear();
      setStatusAnnouncement(null);
      setErrorAnnouncement(null);
    }

    const previous = accessibilityMessageStateRef.current;
    let nextStatusAnnouncement = '';
    let nextErrorAnnouncement = '';

    messages.forEach(message => {
      const previousState = previous.get(message.id);
      if (previousState && previousState.deliveryStatus !== 'failed' && message.deliveryStatus === 'failed') {
        nextErrorAnnouncement = t('messageDeliveryFailedAnnouncement', {
          message: message.content.trim().slice(0, 80),
        });
      }
      if (previousState?.status === 'streaming' && message.status === 'complete') {
        const summary = buildAccessibleMessageSummary(message.content);
        nextStatusAnnouncement = summary
          ? t('aiResponseCompleteSummaryAnnouncement', { message: summary })
          : t('aiResponseCompleteAnnouncement');
      } else if (previousState?.status === 'streaming' && message.status === 'error') {
        nextErrorAnnouncement = t('aiResponseFailedAnnouncement');
      }
    });

    accessibilityMessageStateRef.current = new Map(messages.map(message => [message.id, {
      status: message.status,
      deliveryStatus: message.deliveryStatus,
    }]));

    if (nextStatusAnnouncement) {
      announcementSequenceRef.current += 1;
      setStatusAnnouncement({ id: announcementSequenceRef.current, text: nextStatusAnnouncement });
    }
    if (nextErrorAnnouncement) {
      announcementSequenceRef.current += 1;
      setErrorAnnouncement({ id: announcementSequenceRef.current, text: nextErrorAnnouncement });
    }
  }, [messages, roomId, t]);

  const refreshWorkspaceSnapshot = useCallback(async () => {
    if (!roomSessionReadyRef.current || presentation !== 'code-agent' || !currentRoomId) {
      return;
    }

    workspaceFetchAbortRef.current?.abort();
    const controller = new AbortController();
    workspaceFetchAbortRef.current = controller;
    setIsWorkspaceRefreshing(true);
    setWorkspaceRefreshError(null);

    try {
      const snapshot = await loadCodeAgentWorkspaceSnapshot(currentRoomId, { signal: controller.signal });
      if (!controller.signal.aborted) {
        setWorkspaceSnapshot(snapshot);
        onWorkspaceRootChange?.(snapshot.workspaceRoot ?? null);
        onWorkspaceChangesChange?.(snapshot.changes);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error('Failed to refresh code-agent workspace snapshot:', error);
        setWorkspaceRefreshError(error instanceof Error ? error.message : 'Failed to load workspace snapshot');
      }
    } finally {
      if (workspaceFetchAbortRef.current === controller) {
        workspaceFetchAbortRef.current = null;
        setIsWorkspaceRefreshing(false);
      }
    }
  }, [currentRoomId, onWorkspaceChangesChange, onWorkspaceRootChange, presentation]);

  const handleCodeAgentTurnSettled = useCallback(() => {
    if (presentation !== 'code-agent') {
      return;
    }
    void refreshWorkspaceSnapshot();
  }, [presentation, refreshWorkspaceSnapshot]);

  useEffect(() => {
    if (!isRoomSessionReady || presentation !== 'code-agent' || !currentRoomId) {
      setWorkspaceSnapshot(null);
      setWorkspaceRefreshError(null);
      onWorkspaceRootChange?.(null);
      onWorkspaceChangesChange?.(null);
      return;
    }

    void refreshWorkspaceSnapshot();

    return () => {
      const workspaceController = workspaceFetchAbortRef.current;
      workspaceFetchAbortRef.current = null;
      workspaceController?.abort();
    };
  }, [currentRoomId, isRoomSessionReady, onWorkspaceChangesChange, onWorkspaceRootChange, presentation, refreshWorkspaceSnapshot, workspaceRefreshKey]);

  // Warm the lazily-loaded markdown chunk on mount so the first message renders
  // as markdown immediately instead of flashing plain text. The component
  // remounts per room (key={roomId}), so per-room state already resets via the
  // lazy useState initializers above — no manual roomId reset needed here.
  useEffect(() => {
    preloadMarkdownContent();
  }, []);

  const loadRoleMembers = useCallback(async () => {
    if (!canManageSenderActions) {
      setRoleMembers([]);
      return;
    }

    try {
      setRoleMembers(await getRoomRoleMembers(roomId));
    } catch (error) {
      console.error('Failed to load room role members:', error);
    }
  }, [canManageSenderActions, roomId]);

  useEffect(() => {
    void loadRoleMembers();
  }, [loadRoleMembers]);

  useEffect(() => {
    if (!canManageSenderActions) {
      return;
    }

    const handleRoleMembersUpdated = (updatedRoomId: string) => {
      if (updatedRoomId === roomId) {
        void loadRoleMembers();
      }
    };

    socket.on('room_role_members_updated', handleRoleMembersUpdated);
    return () => {
      socket.off('room_role_members_updated', handleRoleMembersUpdated);
    };
  }, [canManageSenderActions, loadRoleMembers, roomId]);

  React.useLayoutEffect(() => {
    const preserveScroll = preserveScrollRef.current;
    const container = containerRef.current;
    if (!preserveScroll || !container) return;

    preserveScrollRef.current = null;
    container.scrollTop = preserveScroll.scrollTop + (container.scrollHeight - preserveScroll.scrollHeight);
  }, [messages.length]);

  React.useLayoutEffect(() => {
    if (isNearBottomRef.current) {
      scheduleScrollToBottom('auto');
    }
  }, [bottomInsetPx, scheduleScrollToBottom]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const stickToBottomIfNeeded = () => {
      if (preserveScrollRef.current) {
        return;
      }
      if (isNearBottomRef.current) {
        scheduleScrollToBottom('auto');
      }
    };

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(stickToBottomIfNeeded);
      observer.observe(contentRef.current || container);
    }

    container.addEventListener('load', stickToBottomIfNeeded, true);

    return () => {
      observer?.disconnect();
      container.removeEventListener('load', stickToBottomIfNeeded, true);
    };
  }, [scheduleScrollToBottom]);

  // --- Modal Handlers (Keep dependencies as they are or simplify if possible) ---
  const handleOpenDeleteModal = useCallback((messageId: string) => {
    if (!roomSessionReadyRef.current) return;
    const msg = getMessageById(messagesRef.current, messageId);
    if (msg) {
      setMessageToDelete(msg);
      setIsDeleteModalOpen(true);
    }
   }, []);
  const handleCloseDeleteModal = useCallback(() => {
      setIsDeleteModalOpen(false);
    setMessageToDelete(null);
   }, []);
  const handleOpenEditModal = useCallback((messageId: string) => {
    if (!roomSessionReadyRef.current) return;
      const msg = getMessageById(messagesRef.current, messageId);
    if (msg) {
      setMessageToEdit(msg);
      setIsEditModalOpen(true);
    }
  }, []);
  const handleCloseEditModal = useCallback(() => {
      setIsEditModalOpen(false);
    setMessageToEdit(null);
   }, []);

  useEffect(() => {
    if (isRoomSessionReady) return;
    handleCloseDeleteModal();
    handleCloseEditModal();
  }, [handleCloseDeleteModal, handleCloseEditModal, isRoomSessionReady]);

  // --- Edit/Delete Logic ---
  const handleSaveEdit = useCallback((messageId: string, newContent: string) => {
    if (!roomSessionReadyRef.current) return;
    console.log('Saving edit (from modal):', messageId, newContent);
    const originalMessages = messages;
    updateMessages(prev => editMessageContent(prev, messageId, newContent));
    // No need to close modal here, EditMessageModal handles it

    const targetMessage = getMessageById(messagesRef.current, messageId);
    if (targetMessage?.codeAgentQueuedInput) {
      editQueuedCodeAgentInput(roomId, messageId, newContent).catch((error) => {
        console.error('Failed to edit queued agent input:', error);
        updateMessages(originalMessages);
        socket.emit('get_room_messages', { roomId });
        alert(t('errorEditingMessage', { error: error instanceof Error ? error.message : t('unknownError') }));
      });
      return;
    }

    socket.emit('edit_message', { roomId, messageId, newContent }, (response: { success: boolean; updatedMessage?: Message; error?: string }) => {
      if (response.success && response.updatedMessage) {
        console.log('Edit successful on server.');
        updateMessages(prev => replaceMessage(prev, response.updatedMessage!));
      } else {
        console.error('Failed to save edit on server:', response.error);
        updateMessages(originalMessages);
        // Use translation key for alert
        alert(t('errorEditingMessage', { error: response.error || t('unknownError') }));
      }
    });
  }, [roomId, messages, updateMessages, t]);

  const handleSteerQueuedMessage = useCallback(async (messageId: string) => {
    if (!roomSessionReadyRef.current) return;
    try {
      await steerQueuedCodeAgentInput(roomId, messageId);
    } catch (error) {
      console.error('Failed to steer with queued agent input:', error);
      socket.emit('get_room_messages', { roomId });
      alert(t('codeAgentQueuedActionFailed'));
    }
  }, [roomId, t]);

  const handleCancelQueuedMessage = useCallback(async (messageId: string) => {
    if (!roomSessionReadyRef.current) return;
    try {
      await cancelQueuedCodeAgentInput(roomId, messageId);
    } catch (error) {
      console.error('Failed to cancel queued agent input:', error);
      socket.emit('get_room_messages', { roomId });
      alert(t('codeAgentQueuedActionFailed'));
    }
  }, [roomId, t]);

  const handleSaveEditAndAskAI = useCallback((messageId: string, newContent: string) => {
    if (!roomSessionReadyRef.current) return;
    console.log('Saving edit and triggering AI (from modal):', messageId, newContent);
    const originalMessages = messages;
    const optimisticResult = editMessageAndTruncateAfter(messages, messageId, newContent);

    // 1. Optimistic Update & Truncation
    updateMessages(optimisticResult.messages);
    // No need to close modal here, EditMessageModal handles it

    // Check if index was found before proceeding
    if (!optimisticResult.found) {
        console.error("Edited message ID not found in state during optimistic update.");
        updateMessages(originalMessages); // Revert
        return;
    }

    requestEditMessageAndAIResponse({
      roomId,
      messageId,
      newContent,
      ...getAIRequestSettingsForRoom(),
    }).then(() => {
      socket.emit('get_room_messages', { roomId, baseHistoryVersion: historyVersion });
    }).catch((error) => {
      console.error('Failed to save edit before asking AI:', error);
      updateMessages(originalMessages);
      alert(t('errorEditingMessage', { error: error instanceof Error ? error.message : t('unknownError') }));
    });
  }, [roomId, messages, updateMessages, getAIRequestSettingsForRoom, historyVersion, t]);

  // Define handleConfirmDelete within useCallback, accessing messageToDelete state
  const handleConfirmDelete = useCallback(() => {
    if (!roomSessionReadyRef.current || !messageToDelete) return;

    const messageIdToDelete = messageToDelete.id;
    console.log('Confirmed deleting message:', messageIdToDelete);

    // 1. Close modal & Optimistically remove from UI
    handleCloseDeleteModal(); // Close modal first
    updateMessages(prev => deleteMessageById(prev, messageIdToDelete));

    // 2. Emit event to server
    socket.emit('delete_message', { roomId, messageId: messageIdToDelete }, (response: { success: boolean; error?: string }) => {
      if (!response.success) {
        console.error('Failed to delete message on server:', response.error);
        // Refetch history on error to ensure consistency
        socket.emit('get_room_messages', { roomId, baseHistoryVersion: historyVersion });
         // Use translation key for alert
        alert(t('errorDeletingMessage', { error: response.error || t('unknownError') }));
      }
    });
  }, [roomId, messageToDelete, handleCloseDeleteModal, updateMessages, historyVersion, t]);

  const handleUserAction = useCallback(async (action: MessageUserAction, message: Message) => {
    if (!roomSessionReadyRef.current) return;
    try {
      if (action === 'setAdmin') {
        await setRoomAdmin(roomId, message.clientId);
      } else if (action === 'removeAdmin') {
        await removeRoomAdmin(roomId, message.clientId);
      } else if (action === 'removeMember') {
        await removeRoomMember(roomId, message.clientId);
      } else if (action === 'transferOwnership') {
        const senderName = message.username?.trim() || message.clientId.slice(-4);
        const confirmed = typeof window.confirm !== 'function'
          || window.confirm(t('confirmTransferToUser', { name: senderName }));
        if (!confirmed) {
          return;
        }
        await transferRoomOwnership(roomId, message.clientId);
      }
      await loadRoleMembers();
    } catch (error) {
      console.error('Failed to perform member action:', error);
      alert(error instanceof Error ? error.message : t('unknownError'));
    }
  }, [loadRoleMembers, roomId, t]);

  const handleRetryDelivery = useCallback(async (failedMessage: Message) => {
    const clientMessageId = failedMessage.clientMessageId;
    if (
      !roomSessionReadyRef.current
      || roomPermissions?.canPost !== true
      || failedMessage.roomId !== roomId
      || failedMessage.deliveryStatus !== 'failed'
      || !clientMessageId
      || (failedMessage.messageType !== 'text' && failedMessage.messageType !== 'sticker')
      || failedMessage.deliveryAction === 'ask-ai'
      || retryingClientMessageIdsRef.current.has(clientMessageId)
    ) {
      return;
    }

    retryingClientMessageIdsRef.current.add(clientMessageId);
    updateMessages(previous => previous.map(message => (
      message.clientMessageId === clientMessageId && message.deliveryStatus === 'failed'
        ? { ...message, deliveryStatus: 'pending' as const, deliveryError: undefined }
        : message
    )));

    try {
      const savedMessage = failedMessage.messageType === 'sticker'
        ? await sendSticker(
            failedMessage.content,
            roomId,
            failedMessage.username,
            failedMessage.avatar,
            failedMessage.replyTo?.messageId,
            clientMessageId,
          )
        : await sendMessage(
            failedMessage.content,
            roomId,
            'text',
            failedMessage.username,
            failedMessage.avatar,
            failedMessage.replyTo?.messageId,
            clientMessageId,
          );
      updateMessages(previous => replaceOptimisticMessage(previous, clientMessageId, savedMessage));
    } catch (error) {
      const deliveryError = error instanceof Error
        ? error.message
        : t(failedMessage.messageType === 'sticker' ? 'failedToSendSticker' : 'errorSendingMessage');
      // A new_message broadcast can replace the optimistic row before its ack
      // times out. Never turn that already-saved canonical row back into failed.
      updateMessages(previous => previous.map(message => (
        message.clientMessageId === clientMessageId && message.deliveryStatus === 'pending'
          ? { ...message, deliveryStatus: 'failed' as const, deliveryError }
          : message
      )));
    } finally {
      retryingClientMessageIdsRef.current.delete(clientMessageId);
    }
  }, [roomId, roomPermissions?.canPost, t, updateMessages]);

  // 添加刷新AI的处理函数
  const handleRefreshAI = useCallback((messageId: string) => {
    if (!roomSessionReadyRef.current) return;
    console.log('Retrying AI response for message ID:', messageId);

    // 找到消息的索引位置
    const retryResult = truncateBeforeMessage(messagesRef.current, messageId);
    if (!retryResult.found) {
      console.error("Cannot retry AI response: Message ID not found in current list.");
      return;
    }

    // 截断本地消息列表到当前AI消息之前
    // This effectively removes the target AI message and all subsequent messages from the UI optimistically
    updateMessages(retryResult.messages);
    console.log('Truncated message list locally, count:', retryResult.messages.length);

    // 向服务器发送 ask_ai 事件，并带上 retryForMessageId 标识
    // 服务器将根据这个ID来截断 redis 中的历史记录
    requestAIResponse({
      roomId,
      // prompt: '', // Prompt is now determined by the server based on truncated history
      retryForMessageId: messageId, // 新增：告知服务器这是针对哪条消息的重试
      ...getAIRequestSettingsForRoom(),
    }).catch((error) => {
      console.error('Failed to retry AI response:', error);
      socket.emit('get_room_messages', { roomId, baseHistoryVersion: historyVersion });
    });
    console.log('Emitted ask_ai for retry with retryForMessageId:', messageId);

    // 自动滚动到底部
    if (retryScrollTimerRef.current) {
      clearTimeout(retryScrollTimerRef.current);
    }
    retryScrollTimerRef.current = setTimeout(() => {
      scrollToBottom('smooth');
      retryScrollTimerRef.current = null;
    }, 100);
  }, [roomId, updateMessages, scrollToBottom, getAIRequestSettingsForRoom, historyVersion]);

  useRoomMessageEvents({
    roomId,
    isRoomSessionReady,
    containerRef,
    getCurrentMessages,
    updateMessages,
    setAgentTurns,
    setIsLoading,
    setIsLoadingMore,
    setHasMoreMessages,
    setHistoryVersion,
    setOldestMessageId,
    setSessionCostUsd,
    setShowScrollButton,
    scrollToBottom,
    closeDeleteModal: handleCloseDeleteModal,
    closeEditModal: handleCloseEditModal,
    messageToDeleteId: messageToDelete?.id,
    messageToEditId: messageToEdit?.id,
    onAIStreamSettled: presentation === 'code-agent' ? handleCodeAgentTurnSettled : undefined,
    warningPrefix: t('warningPrefix'),
  });

  // ... handleScroll ...
  const handleScroll = () => {
    const container = containerRef.current;
    if (container) {
      const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
      isNearBottomRef.current = isAtBottom;
      setShowScrollButton(!isAtBottom && messages.length > 0);
      if (container.scrollTop <= LOAD_MORE_SCROLL_THRESHOLD_PX) {
        handleLoadMore();
      }
    }
  };

  const [isExporting, setIsExporting] = useState(false);

  // Fall back to roomId when tests or older call sites do not provide room metadata.
  const loadMessagesForExport = useCallback(async () => (
    sortMessages(await getRoomMessagesForExport(roomId))
  ), [roomId]);

  const resolveExportMediaUrl = useCallback<ExportMediaResolver>(async (message) => {
    if (!message.mediaAsset?.id) {
      return null;
    }
    const { url } = await getMediaDownloadUrl({ roomId: message.roomId, assetId: message.mediaAsset.id });
    return url;
  }, []);

  const showExportNotice = useCallback((notice: { tone: 'success' | 'error'; message: string }) => {
    setExportNotice(notice);
    if (exportNoticeTimerRef.current) clearTimeout(exportNoticeTimerRef.current);
    exportNoticeTimerRef.current = setTimeout(() => {
      setExportNotice(null);
      exportNoticeTimerRef.current = null;
    }, notice.tone === 'error' ? 8000 : 4000);
  }, []);

  const handleExportHtml = useCallback(async () => {
    if (!roomSessionReadyRef.current || isExporting) return;
    setIsExporting(true);
    setExportNotice(null);
    try {
      await downloadTranscriptHtml(room || { id: roomId, name: roomId }, await loadMessagesForExport(), resolveExportMediaUrl);
      showExportNotice({ tone: 'success', message: t('exportSucceeded', { format: 'HTML' }) });
    } catch (error) {
      console.error('Failed to export HTML transcript:', error);
      showExportNotice({ tone: 'error', message: t('exportFormatFailed', { format: 'HTML' }) });
    } finally {
      setIsExporting(false);
    }
  }, [isExporting, loadMessagesForExport, resolveExportMediaUrl, room, roomId, showExportNotice, t]);

  const handleExportZip = useCallback(async () => {
    if (!roomSessionReadyRef.current || isExporting) return;
    setIsExporting(true);
    setExportNotice(null);
    try {
      await downloadTranscriptZip(room || { id: roomId, name: roomId }, await loadMessagesForExport(), resolveExportMediaUrl);
      showExportNotice({ tone: 'success', message: t('exportSucceeded', { format: 'ZIP' }) });
    } catch (error) {
      console.error('Failed to export ZIP transcript:', error);
      showExportNotice({ tone: 'error', message: t('exportFormatFailed', { format: 'ZIP' }) });
    } finally {
      setIsExporting(false);
    }
  }, [isExporting, loadMessagesForExport, resolveExportMediaUrl, room, roomId, showExportNotice, t]);

  // ... loading/empty states ...
  // ... return statement with JSX ...

  return (
    <>
      {presentation !== 'code-agent' && (
      <div className="absolute right-3 top-3 z-20 flex max-w-[min(28rem,calc(100%-1.5rem))] flex-col items-end gap-1.5">
        <div className="flex items-center gap-1.5">
          <Dropdown placement="bottom-end">
            <DropdownTrigger>
              <Button
                size="sm"
                variant="flat"
                radius="full"
                isDisabled={isExporting || !isRoomSessionReady}
                aria-busy={isExporting}
                aria-label={isExporting ? t('exportingChat') : t('exportChat')}
                className="h-7 min-w-0 border border-[#dedbd0] bg-[#faf9f5]/95 px-2 text-tiny font-medium text-[#4d4c48] shadow-sm backdrop-blur dark:border-[#30302e] dark:bg-[#1d1d1b]/95 dark:text-[#e8e6dc]"
                startContent={<Icon icon={isExporting ? 'lucide:loader-circle' : 'lucide:download'} className={`h-3.5 w-3.5 ${isExporting ? 'animate-spin' : ''}`} />}
              >
                {t('exportChat')}
              </Button>
            </DropdownTrigger>
            <DropdownMenu aria-label={t('exportChat')}>
              <DropdownItem key="html" startContent={<Icon icon="lucide:file-code-2" />} onPress={handleExportHtml}>
                {t('exportHtml')}
              </DropdownItem>
              <DropdownItem key="zip" startContent={<Icon icon="lucide:archive" />} onPress={handleExportZip}>
                {t('exportZip')}
              </DropdownItem>
            </DropdownMenu>
          </Dropdown>
          <div className="flex items-center gap-1 rounded-full border border-[#dedbd0] bg-[#faf9f5]/95 px-2.5 py-1 text-tiny font-medium text-[#4d4c48] shadow-sm backdrop-blur dark:border-[#30302e] dark:bg-[#1d1d1b]/95 dark:text-[#e8e6dc]">
            <Icon icon="lucide:coins" className="h-3.5 w-3.5" />
            <span className="flex items-center gap-1">
              {t('sessionCost')}:
              {sessionCostUsd !== null ? formatUsdCost(sessionCostUsd) : isSessionCostUnavailable ? t('costUnavailable') : (
                <>
                  <span className="sr-only">{t('loadingSessionCost')}</span>
                  <span aria-hidden="true" className="inline-block h-2 w-8 animate-pulse rounded-full bg-[#c2c0b6] dark:bg-[#4d4c48]" />
                </>
              )}
            </span>
          </div>
        </div>
        {exportNotice && (
          <div
            role={exportNotice.tone === 'error' ? 'alert' : 'status'}
            aria-atomic="true"
            className={`max-w-full rounded-lg border px-2.5 py-1.5 text-xs shadow-sm backdrop-blur ${exportNotice.tone === 'error'
              ? 'border-danger-300 bg-danger-50 text-danger-700 dark:border-danger-700 dark:bg-danger-950/90 dark:text-danger-200'
              : 'border-success-300 bg-success-50 text-success-700 dark:border-success-700 dark:bg-success-950/90 dark:text-success-200'}`}
          >
            {exportNotice.message}
          </div>
        )}
      </div>
      )}
      <div
        data-testid="message-list-shell"
        className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[#f5f4ed] dark:bg-[#141413]"
      >
        {presentation === 'code-agent' && codeAgentRoom && (
          <CodeAgentWorkspacePanel
            room={codeAgentRoom}
            messages={messages}
            mode={codeAgentMode}
            availableModes={codeAgentAvailableModes}
            backend={codeAgentBackend}
            canSwitchMode={codeAgentAvailableModes.length > 1 && canManageCodeAgentMode}
            canSwitchBackend={canManageCodeAgentMode}
            onModeChange={onCodeAgentModeChange}
            onBackendChange={onCodeAgentBackendChange}
            sessionCostUsd={sessionCostUsd}
            isSessionCostUnavailable={isSessionCostUnavailable}
            isRoomSessionReady={isRoomSessionReady}
            workspaceSnapshot={workspaceSnapshot}
            isRefreshingWorkspace={isWorkspaceRefreshing}
            workspaceRefreshError={workspaceRefreshError}
            onRefreshWorkspace={isRoomSessionReady ? refreshWorkspaceSnapshot : undefined}
            onOpenWorkspaceFile={onOpenWorkspaceFile}
            onOpenWorkspaceArtifact={onOpenWorkspaceArtifact}
            reviewComments={reviewComments}
            onAddReviewComment={onAddReviewComment}
            onRemoveReviewComment={onRemoveReviewComment}
          />
        )}
        <div
          id={scrollContainerId}
          data-testid="message-list-scroll"
          ref={containerRef}
          role="log"
          aria-label={t('messageLog')}
          aria-live={isMessageLogLive ? 'polite' : 'off'}
          aria-relevant="additions"
          aria-busy={isLoading}
          className="relative flex min-h-0 w-full flex-1 flex-col overflow-y-auto px-3 pt-3"
          onScroll={handleScroll}
        >
          <div ref={contentRef} data-testid="message-list-content" className="flex min-h-full flex-col">
            {hasMoreMessages && (
              <div
                ref={historyLoadSentinelRef}
                data-testid="history-load-sentinel"
                className="mb-3 flex min-h-6 items-center justify-center"
                role={isLoadingMore ? 'status' : undefined}
                aria-live="polite"
              >
                {isLoadingMore && (
                  <>
                    <Icon icon="lucide:loader-circle" className="mr-1.5 h-4 w-4 animate-spin text-[#c96442] dark:text-[#d97757]" />
                    <span className="text-xs font-medium text-[#5e5d59] dark:text-[#b0aea5]">{t('loadingMore')}</span>
                  </>
                )}
              </div>
            )}
            {isLoading && messages.length === 0 && (
              <div className="flex min-h-[220px] flex-1 items-center justify-center">
                <Icon icon="lucide:loader-circle" className="h-6 w-6 animate-spin text-[#c96442] dark:text-[#d97757]" />
              </div>
            )}
            {!isLoading && messages.length === 0 && (
              <div className="flex min-h-[220px] flex-1 flex-col items-center justify-center text-center">
                <Icon icon="lucide:message-circle" className="mb-3 h-8 w-8 text-[#5e5d59] dark:text-[#8f8d86]" />
                <p className="font-serif text-lg font-medium text-[#141413] dark:text-[#faf9f5]">{t('noMessages')}</p>
                <p className="mt-1 text-sm text-[#5e5d59] dark:text-[#b0aea5]">{t('beFirstToMessage')}</p>
              </div>
            )}
            {!isLoading && messages.length > 0 && (
              <div className="flex flex-col space-y-2">
                {timelineItems.map((item) => {
                  const renderMessage = (message: Message, turnGrouped = false) => (
                    <MessageItem
                      key={turnGrouped ? undefined : message.id}
                      message={message}
                      pairedToolResult={message.messageType === 'tool_call' && message.toolCallId
                        ? toolResultPairing.resultByCallId.get(message.toolCallId)
                        : undefined}
                      roomPermissions={roomPermissions}
                      senderRole={message.clientId === (codeAgentRoom || room)?.creatorId
                        ? 'owner'
                        : roleMemberByClientId.get(message.clientId)?.role ?? null}
                      senderDisplayId={roleMemberByClientId.get(message.clientId)?.displayId}
                      aiRequestRoomKind={aiRequestRoomKind}
                      onStartEdit={handleOpenEditModal}
                      onDeleteMessage={handleOpenDeleteModal}
                      onEditQueuedMessage={handleOpenEditModal}
                      onSteerQueuedMessage={handleSteerQueuedMessage}
                      onCancelQueuedMessage={handleCancelQueuedMessage}
                      onRefreshAI={handleRefreshAI}
                      onRetryDelivery={handleRetryDelivery}
                      onReply={onReply}
                      onUserAction={handleUserAction}
                      onOpenWorkspaceFile={onOpenWorkspaceFile}
                      workspaceRoot={workspaceRoot}
                      turnGrouped={turnGrouped}
                      isInteractionDisabled={!isRoomSessionReady}
                    />
                  );
                  if (item.kind === 'agent-turn') {
                    return (
                      <AgentTurnItem
                        key={`turn:${item.turn.id}`}
                        turn={item.turn}
                        messages={item.messages}
                        renderAgentMessage={message => renderMessage(message, true)}
                        renderStandaloneMessage={message => renderMessage(message)}
                      />
                    );
                  }
                  return renderMessage(item.message);
                })}
              </div>
            )}
            <div
              aria-hidden="true"
              data-testid="message-list-scroll-end-inset"
              className="flex-shrink-0"
              style={{ height: bottomInsetPx }}
            />
            <div ref={messagesEndRef} />
          </div>
        </div>
        {presentation === 'code-agent' && pendingQueueMessages.length > 0 && (
          <div
            data-testid="code-agent-pending-queue"
            className="z-20 flex max-h-[40%] flex-shrink-0 flex-col gap-2 overflow-y-auto bg-[#f5f4ed]/95 px-4 pb-2 pt-2 backdrop-blur dark:bg-[#141413]/95"
          >
            {pendingQueueMessages.map(message => (
              <MessageItem
                key={`pending:${message.id}`}
                message={message}
                roomPermissions={roomPermissions}
                senderRole={message.clientId === (codeAgentRoom || room)?.creatorId
                  ? 'owner'
                  : roleMemberByClientId.get(message.clientId)?.role ?? null}
                senderDisplayId={roleMemberByClientId.get(message.clientId)?.displayId}
                aiRequestRoomKind={aiRequestRoomKind}
                onStartEdit={handleOpenEditModal}
                onDeleteMessage={handleOpenDeleteModal}
                onEditQueuedMessage={handleOpenEditModal}
                onSteerQueuedMessage={handleSteerQueuedMessage}
                onCancelQueuedMessage={handleCancelQueuedMessage}
                onRefreshAI={handleRefreshAI}
                onRetryDelivery={handleRetryDelivery}
                onReply={onReply}
                onUserAction={handleUserAction}
                onOpenWorkspaceFile={onOpenWorkspaceFile}
                workspaceRoot={workspaceRoot}
                isInteractionDisabled={!isRoomSessionReady}
              />
            ))}
          </div>
        )}
      </div>

      {statusAnnouncement && <span key={statusAnnouncement.id} className="sr-only" role="status" aria-atomic="true">{statusAnnouncement.text}</span>}
      {errorAnnouncement && <span key={errorAnnouncement.id} className="sr-only" role="alert" aria-atomic="true">{errorAnnouncement.text}</span>}

      {/* Render Modals */}
      <DeleteConfirmationModal
        isOpen={isDeleteModalOpen}
        onClose={handleCloseDeleteModal}
        onConfirm={handleConfirmDelete}
        messageContent={messageToDelete?.content ? messageToDelete.content.substring(0, 100) : ''}
      />
      <EditMessageModal
        isOpen={isEditModalOpen}
        onClose={handleCloseEditModal}
        message={messageToEdit}
        onSave={handleSaveEdit}
        onSaveAndAskAI={handleSaveEditAndAskAI}
        showSaveAndAskAI={!messageToEdit?.codeAgentQueuedInput}
      />
    </>
  );
});

MessageList.displayName = 'MessageList';
