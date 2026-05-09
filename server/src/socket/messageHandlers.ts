import { v4 as uuidv4 } from 'uuid';
import {
  applyMessageEdit,
  createUserMessage,
  deleteMessageFromHistory,
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

  socket.on('send_message', async (messageData: {
    roomId: string;
    content: string;
    messageType?: 'text' | 'image';
    username?: string;
    avatar?: {
      text: string;
      color: string;
    };
  }) => {
    const clientId = await store.getClientId(socket.id);
    if (!clientId) {
      socketLogger.warn('Unregistered client tried to send message', { socketId: socket.id });
      socket.emit('error', { message: 'You are not registered' });
      return;
    }

    if (!messageData.roomId) {
      socketLogger.warn('Client tried to send message without room ID', { socketId: socket.id, clientId });
      socket.emit('error', { message: 'Room ID is required' });
      return;
    }

    const message = createUserMessage({
      id: uuidv4(),
      clientId,
      content: messageData.content,
      roomId: messageData.roomId,
      messageType: messageData.messageType || 'text',
      username: messageData.username,
      avatar: messageData.avatar,
    });

    const loggableMessage = socketLogger.formatMessageForLog(message);
    socketLogger.info('Received WebSocket message', loggableMessage);

    const updatedRoom = await store.appendMessage(message);
    if (!updatedRoom) {
      socketLogger.error('Failed to append WebSocket message', { messageId: message.id, roomId: message.roomId, clientId });
      socket.emit('error', { message: 'Failed to save message' });
      return;
    }

    io.to(updatedRoom.creatorId).emit('room_updated', updatedRoom);
    io.to(messageData.roomId).emit('new_message', message);
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
      const messages = await store.readMessagesByRoom(data.roomId);
      const editResult = applyMessageEdit(messages, data.messageId, data.newContent);

      if (!editResult.found) {
        return callback?.({ success: false, error: 'Message not found' });
      }

      const updatedMessage = editResult.updatedMessage;
      const updatedRoom = await store.saveMessageHistory(data.roomId, editResult.messages);
      if (updatedRoom) {
        io.to(updatedRoom.creatorId).emit('room_updated', updatedRoom);
      }

      io.to(data.roomId).emit('message_edited', updatedMessage);
      socketLogger.info('Message edited successfully', { messageId: data.messageId, roomId: data.roomId, editorClientId: clientId });

      callback?.({ success: true, updatedMessage });
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
      const messages = await store.readMessagesByRoom(data.roomId);
      const deleteResult = deleteMessageFromHistory(messages, data.messageId);

      if (!deleteResult.found) {
        socketLogger.warn('Attempted to delete message not found', { ...data, deleterClientId: clientId });
        return callback?.({ success: true });
      }

      const updatedRoom = await store.saveMessageHistory(data.roomId, deleteResult.messages);
      if (updatedRoom) {
        io.to(updatedRoom.creatorId).emit('room_updated', updatedRoom);
      }

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
        socketLogger.info('Cleared room messages from Redis', { socketId: socket.id, clientId, roomId });
      } else {
        socketLogger.debug('No messages to clear or key did not exist', { socketId: socket.id, clientId, roomId });
      }

      io.to(roomId).emit('messages_cleared', roomId);
      io.to(roomId).emit('ai_cost_total', await store.readRoomAICost(roomId));
    } catch (error) {
      socketLogger.error('Error clearing room messages from Redis', { error, socketId: socket.id, clientId, roomId });
      socket.emit('error', { message: 'Failed to clear room messages' });
    }
  });
}
