import { v4 as uuidv4 } from 'uuid';
import {
  createReplyReference,
  createUserMessage,
} from '../services/messageDomain';
import { Message } from '../types';
import { SocketConnectionContext } from './types';

export function registerMessageHandlers({ io, socket, store, socketLogger }: SocketConnectionContext) {
  socket.on('get_room_messages', async (roomId: string) => {
    const userId = await store.getClientId(socket.id);
    socketLogger.debug('Client requested message history', { socketId: socket.id, userId, roomId });

    const roomMessages = await store.readMessagesByRoom(roomId);
    socket.emit('message_history', roomMessages);
    socket.emit('ai_cost_total', await store.readRoomAICost(roomId));
  });

  socket.on('send_message', async (
    messageData: {
      roomId: string;
      content: string;
      messageType?: 'text' | 'image';
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

    const message = createUserMessage({
      id: uuidv4(),
      clientId,
      content: messageData.content,
      roomId: messageData.roomId,
      messageType: messageData.messageType || 'text',
      username: messageData.username,
      avatar: messageData.avatar,
      replyTo,
      clientMessageId: messageData.clientMessageId,
    });

    const loggableMessage = socketLogger.formatMessageForLog(message);
    socketLogger.info('Received WebSocket message', loggableMessage);

    const updatedRoom = await store.appendMessage(message);
    if (!updatedRoom) {
      socketLogger.error('Failed to append WebSocket message', { messageId: message.id, roomId: message.roomId, clientId });
      socket.emit('error', { message: 'Failed to save message' });
      callback?.({ success: false, error: 'Failed to save message' });
      return;
    }

    io.to(updatedRoom.creatorId).emit('room_updated', updatedRoom);
    io.to(messageData.roomId).emit('new_message', message);
    callback?.({ success: true, message });
  });

  socket.on('edit_message', async (data: { roomId: string; messageId: string; newContent: string }, callback?: (response: { success: boolean; updatedMessage?: Message; error?: string }) => void) => {
    const clientId = await store.getClientId(socket.id);
    if (!clientId) {
      return callback?.({ success: false, error: 'Not registered' });
    }

    if (!data.roomId || !data.messageId || typeof data.newContent !== 'string') {
      return callback?.({ success: false, error: 'Missing required fields' });
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

  socket.on('clear_room_messages', async (roomId: string) => {
    const clientId = await store.getClientId(socket.id);
    if (!clientId) {
      socketLogger.warn('Unregistered client tried to clear messages', { socketId: socket.id, roomId });
      socket.emit('error', { message: 'You are not registered' });
      return;
    }

    if (!roomId) {
      socketLogger.warn('Client tried to clear messages without room ID', { socketId: socket.id, clientId });
      socket.emit('error', { message: 'Room ID is required' });
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
    } catch (error) {
      socketLogger.error('Error clearing room messages from store', { error, socketId: socket.id, clientId, roomId });
      socket.emit('error', { message: 'Failed to clear room messages' });
    }
  });
}
