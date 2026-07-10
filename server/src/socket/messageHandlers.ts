import { v4 as uuidv4 } from 'uuid';
import {
  createReplyReference,
  createStickerMessage,
  createUserMessage,
} from '../services/messageDomain';
import { notifyRoomMessageBestEffort } from '../services/pushNotifications';
import { isValidStickerId } from '../stickers/catalog';
import { A2UIActionEvent, Message } from '../types';
import { hasRoomAccess } from './roomAccess';
import { authorizeRoomAction, getRoomMessage } from './roomAuthorization';
import { SocketConnectionContext } from './types';

const MAX_CLIENT_MESSAGE_ID_LENGTH = 128;

const parseClientMessageId = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_CLIENT_MESSAGE_ID_LENGTH) {
    return undefined;
  }
  return value;
};

const parseClearRoomPayload = (payload: unknown): { roomId: string | null; confirmation?: string } => {
  if (typeof payload === 'string') {
    return { roomId: payload };
  }

  if (payload && typeof payload === 'object') {
    const data = payload as { roomId?: unknown; confirmation?: unknown };
    return {
      roomId: typeof data.roomId === 'string' ? data.roomId : null,
      confirmation: typeof data.confirmation === 'string' ? data.confirmation : undefined,
    };
  }

  return { roomId: null };
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isA2UIActionEvent = (value: unknown): value is A2UIActionEvent => (
  isRecord(value) &&
  typeof value.name === 'string' &&
  value.name.trim().length > 0 &&
  typeof value.surfaceId === 'string' &&
  value.surfaceId.trim().length > 0 &&
  typeof value.sourceComponentId === 'string' &&
  value.sourceComponentId.trim().length > 0 &&
  typeof value.timestamp === 'string' &&
  (!('context' in value) || value.context === undefined || isRecord(value.context))
);

export function registerMessageHandlers({ io, socket, store, socketLogger }: SocketConnectionContext) {
  socket.on('get_room_messages', async (request: { roomId: string; beforeMessageId?: string; limit?: number; baseHistoryVersion?: number }) => {
    const roomId = request?.roomId;
    const beforeMessageId = request?.beforeMessageId;
    const limit = request?.limit;
    const userId = await store.getClientId(socket.id);
    socketLogger.debug('Client requested message history', { socketId: socket.id, userId, roomId, beforeMessageId, limit });

    if (!userId) {
      socket.emit('error', { message: 'You are not registered' });
      return;
    }

    if (!roomId || !(await hasRoomAccess(store, roomId, userId))) {
      socket.emit('error', { message: 'You are not authorized to access this room' });
      return;
    }

    const page = await store.readMessagePageByRoom(roomId, { beforeMessageId, limit });
    socket.emit('message_history', {
      ...page,
      mode: beforeMessageId ? 'prepend' : 'replace',
      ...(typeof request.baseHistoryVersion === 'number'
        ? { requestedHistoryVersion: request.baseHistoryVersion }
        : {}),
    });
    socket.emit('ai_cost_total', await store.readRoomAICost(roomId));
  });

  socket.on('send_message', async (
    messageData: {
      roomId: string;
      content: string;
      messageType?: 'text' | 'media' | 'image' | 'voice' | 'sticker';
      username?: string;
      avatar?: {
        text: string;
        color: string;
      };
      replyToMessageId?: string;
      clientMessageId?: string;
    },
    callback?: (response: { success: boolean; message?: Message; error?: string }) => void,
  ) => {
    const clientId = await store.getClientId(socket.id);
    if (!clientId) {
      socketLogger.warn('Unregistered client tried to send message', { socketId: socket.id });
      socket.emit('error', { message: 'You are not registered' });
      callback?.({ success: false, error: 'You are not registered' });
      return;
    }

    if (!messageData.roomId) {
      socketLogger.warn('Client tried to send message without room ID', { socketId: socket.id, clientId });
      socket.emit('error', { message: 'Room ID is required' });
      callback?.({ success: false, error: 'Room ID is required' });
      return;
    }

    const clientMessageId = parseClientMessageId(messageData.clientMessageId);
    if (messageData.clientMessageId !== undefined && !clientMessageId) {
      callback?.({ success: false, error: 'Invalid client message ID' });
      return;
    }

    if (!(await hasRoomAccess(store, messageData.roomId, clientId))) {
      socketLogger.warn('Client tried to send message without room access', { socketId: socket.id, clientId, roomId: messageData.roomId });
      socket.emit('error', { message: 'You are not authorized to access this room' });
      callback?.({ success: false, error: 'You are not authorized to access this room' });
      return;
    }

    const postAuth = await authorizeRoomAction({
      store,
      roomId: messageData.roomId,
      clientId,
      action: { type: 'message.post' },
    });
    if (!postAuth.ok) {
      callback?.({ success: false, error: postAuth.message });
      return;
    }

    const messageType = messageData.messageType ?? 'text';
    if (messageType !== 'text' && messageType !== 'sticker') {
      socketLogger.warn('Client tried to send media through text message socket path', { socketId: socket.id, clientId, roomId: messageData.roomId, messageType: messageData.messageType });
      callback?.({ success: false, error: 'Media messages must use the media upload API' });
      return;
    }

    if (messageType === 'sticker') {
      // Stickers carry only a stable catalog reference; reject anything not in the catalog.
      if (!isValidStickerId(messageData.content)) {
        socketLogger.warn('Client tried to send an unknown sticker', { socketId: socket.id, clientId, roomId: messageData.roomId, stickerId: messageData.content });
        callback?.({ success: false, error: 'Unknown sticker' });
        return;
      }
    } else if (typeof messageData.content !== 'string' || !messageData.content.trim()) {
      callback?.({ success: false, error: 'Message content is required' });
      return;
    }

    let replyTo;
    if (messageData.replyToMessageId) {
      const roomMessages = await store.readMessagesByRoom(messageData.roomId);
      const quotedMessage = roomMessages.find(message => message.id === messageData.replyToMessageId);
      if (!quotedMessage) {
        callback?.({ success: false, error: 'Quoted message not found' });
        return;
      }
      replyTo = createReplyReference(quotedMessage);
    }

    const message = messageType === 'sticker'
      ? createStickerMessage({
          id: uuidv4(),
          clientId,
          stickerId: messageData.content,
          roomId: messageData.roomId,
          username: messageData.username,
          avatar: messageData.avatar,
          replyTo,
          clientMessageId,
        })
      : createUserMessage({
          id: uuidv4(),
          clientId,
          content: messageData.content,
          roomId: messageData.roomId,
          username: messageData.username,
          avatar: messageData.avatar,
          replyTo,
          clientMessageId,
        });

    const loggableMessage = socketLogger.formatMessageForLog(message);
    socketLogger.info('Received WebSocket message', loggableMessage);

    const appendResult = await store.appendMessageIdempotent(message);
    if (!appendResult) {
      socketLogger.error('Failed to append WebSocket message', { messageId: message.id, roomId: message.roomId, clientId });
      socket.emit('error', { message: 'Failed to save message' });
      callback?.({ success: false, error: 'Failed to save message' });
      return;
    }

    const persistedMessage = appendResult.message;
    if (appendResult.inserted) {
      io.to(appendResult.room.creatorId).emit('room_updated', appendResult.room);
      io.to(messageData.roomId).emit('new_message', persistedMessage);
      notifyRoomMessageBestEffort({ store, room: appendResult.room, message: persistedMessage, logger: socketLogger });
    }
    callback?.({ success: true, message: persistedMessage });
  });

  socket.on('edit_message', async (data: { roomId: string; messageId: string; newContent: string }, callback?: (response: { success: boolean; updatedMessage?: Message; error?: string }) => void) => {
    const clientId = await store.getClientId(socket.id);
    if (!clientId) {
      return callback?.({ success: false, error: 'Not registered' });
    }

    if (!data.roomId || !data.messageId || typeof data.newContent !== 'string') {
      return callback?.({ success: false, error: 'Missing required fields' });
    }

    if (!(await hasRoomAccess(store, data.roomId, clientId))) {
      return callback?.({ success: false, error: 'You are not authorized to access this room' });
    }

    const targetMessage = await getRoomMessage(store, data.roomId, data.messageId);
    if (!targetMessage) {
      return callback?.({ success: false, error: 'Message not found' });
    }
    if (targetMessage.codeAgentQueuedInput) {
      return callback?.({ success: false, error: 'Use queued agent input controls to edit this message' });
    }

    const auth = await authorizeRoomAction({
      store,
      roomId: data.roomId,
      clientId,
      action: { type: 'message.edit', message: targetMessage },
    });
    if (!auth.ok) {
      return callback?.({ success: false, error: auth.message });
    }

    socketLogger.info('Received edit message request', { ...data, editorClientId: clientId });

    try {
      const editResult = await store.updateMessageContent(data.roomId, data.messageId, data.newContent);
      if (!editResult) {
        socketLogger.error('Failed to persist edited message', { ...data, editorClientId: clientId });
        return callback?.({ success: false, error: 'Failed to save edited message' });
      }

      if (!editResult.found || !editResult.updatedMessage) {
        return callback?.({ success: false, error: 'Message not found' });
      }

      io.to(editResult.room.creatorId).emit('room_updated', editResult.room);
      io.to(data.roomId).emit('message_edited', editResult.updatedMessage);
      socketLogger.info('Message edited successfully', { messageId: data.messageId, roomId: data.roomId, editorClientId: clientId });

      callback?.({ success: true, updatedMessage: editResult.updatedMessage });
    } catch (error) {
      socketLogger.error('Error editing message', { error, ...data, editorClientId: clientId });
      callback?.({ success: false, error: 'Server error while editing message' });
    }
  });

  socket.on('delete_message', async (data: { roomId: string; messageId: string }, callback?: (response: { success: boolean; error?: string }) => void) => {
    const clientId = await store.getClientId(socket.id);
    if (!clientId) {
      return callback?.({ success: false, error: 'Not registered' });
    }

    if (!data.roomId || !data.messageId) {
      return callback?.({ success: false, error: 'Missing required fields' });
    }

    if (!(await hasRoomAccess(store, data.roomId, clientId))) {
      return callback?.({ success: false, error: 'You are not authorized to access this room' });
    }

    const targetMessage = await getRoomMessage(store, data.roomId, data.messageId);
    if (!targetMessage) {
      socketLogger.warn('Attempted to delete message not found', { ...data, deleterClientId: clientId });
      return callback?.({ success: true });
    }
    if (targetMessage.codeAgentQueuedInput) {
      return callback?.({ success: false, error: 'Use queued agent input controls to cancel this message' });
    }

    const auth = await authorizeRoomAction({
      store,
      roomId: data.roomId,
      clientId,
      action: { type: 'message.delete', message: targetMessage },
    });
    if (!auth.ok) {
      return callback?.({ success: false, error: auth.message });
    }

    socketLogger.info('Received delete message request', { ...data, deleterClientId: clientId });

    try {
      const deleteResult = await store.deleteMessageById(data.roomId, data.messageId);
      if (!deleteResult) {
        socketLogger.error('Failed to persist deleted message', { ...data, deleterClientId: clientId });
        return callback?.({ success: false, error: 'Failed to delete message' });
      }

      if (!deleteResult.deleted) {
        socketLogger.warn('Attempted to delete message not found', { ...data, deleterClientId: clientId });
        return callback?.({ success: true });
      }

      io.to(deleteResult.room.creatorId).emit('room_updated', deleteResult.room);
      io.to(data.roomId).emit('message_deleted', data.messageId, data.roomId);
      socketLogger.info('Message deleted successfully', { messageId: data.messageId, roomId: data.roomId, deleterClientId: clientId });

      callback?.({ success: true });
    } catch (error) {
      socketLogger.error('Error deleting message', { error, ...data, deleterClientId: clientId });
      callback?.({ success: false, error: 'Server error while deleting message' });
    }
  });

  socket.on('clear_room_messages', async (payload: unknown, callback?: (response: { success: boolean; error?: string }) => void) => {
    const { roomId, confirmation } = parseClearRoomPayload(payload);
    const clientId = await store.getClientId(socket.id);
    if (!clientId) {
      socketLogger.warn('Unregistered client tried to clear messages', { socketId: socket.id, roomId });
      socket.emit('error', { message: 'You are not registered' });
      callback?.({ success: false, error: 'You are not registered' });
      return;
    }

    if (!roomId) {
      socketLogger.warn('Client tried to clear messages without room ID', { socketId: socket.id, clientId });
      socket.emit('error', { message: 'Room ID is required' });
      callback?.({ success: false, error: 'Room ID is required' });
      return;
    }

    const auth = await authorizeRoomAction({
      store,
      roomId,
      clientId,
      action: { type: 'room.clearHistory', confirmation },
    });
    if (!auth.ok) {
      socketLogger.warn('Client tried to clear messages without owner permission or confirmation', { socketId: socket.id, clientId, roomId, code: auth.code });
      socket.emit('error', { message: auth.message });
      callback?.({ success: false, error: auth.message });
      return;
    }

    try {
      const result = await store.clearRoomMessages(roomId);
      if (result > 0) {
        socketLogger.info('Cleared room messages from store', { socketId: socket.id, clientId, roomId });
      } else {
        socketLogger.debug('No messages to clear or key did not exist', { socketId: socket.id, clientId, roomId });
      }

      io.to(roomId).emit('messages_cleared', roomId);
      io.to(roomId).emit('ai_cost_total', await store.readRoomAICost(roomId));
      callback?.({ success: true });
    } catch (error) {
      socketLogger.error('Error clearing room messages from store', { error, socketId: socket.id, clientId, roomId });
      socket.emit('error', { message: 'Failed to clear room messages' });
      callback?.({ success: false, error: 'Failed to clear room messages' });
    }
  });

  socket.on('a2ui_action', async (
    payload: unknown,
    callback?: (response: { success: boolean; error?: string }) => void,
  ) => {
    const clientId = await store.getClientId(socket.id);
    if (!clientId) {
      callback?.({ success: false, error: 'You are not registered' });
      return;
    }

    if (!isRecord(payload) || typeof payload.roomId !== 'string' || typeof payload.messageId !== 'string' || !isA2UIActionEvent(payload.action)) {
      callback?.({ success: false, error: 'Invalid A2UI action payload' });
      return;
    }

    const { roomId, messageId, action } = payload;
    if (!(await hasRoomAccess(store, roomId, clientId))) {
      callback?.({ success: false, error: 'You are not authorized to access this room' });
      return;
    }

    const message = await getRoomMessage(store, roomId, messageId);
    if (!message || message.uiPayload?.format !== 'a2ui') {
      callback?.({ success: false, error: 'A2UI message not found' });
      return;
    }

    socketLogger.info('Received A2UI action', {
      roomId,
      messageId,
      clientId,
      actionName: action.name,
      surfaceId: action.surfaceId,
      sourceComponentId: action.sourceComponentId,
    });

    io.to(roomId).emit('a2ui_action', {
      roomId,
      messageId,
      clientId,
      action,
    });
    callback?.({ success: true });
  });
}
