import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { ImageUploadSessions } from '../services/imageUploadSessions';
import { createUserMessage } from '../services/messageDomain';
import { SocketConnectionContext } from './types';

const uploadErrorMessage = (error: 'missing-session' | 'invalid-index' | 'invalid-chunk' | 'incomplete') => {
  switch (error) {
    case 'missing-session':
      return 'No upload session for this fileId';
    case 'invalid-index':
      return 'Invalid chunk index';
    case 'invalid-chunk':
      return 'Invalid image chunk';
    case 'incomplete':
      return 'Not all chunks received';
  }
};

export function registerMediaHandlers({ io, socket, store, socketLogger }: SocketConnectionContext) {
  const imageUploadSessions = new ImageUploadSessions();

  socket.on('start_image_upload', async (payload: { fileId: string; totalChunks: number; roomId: string; username?: string; avatar?: { text: string; color: string } }) => {
    const clientId = await store.getClientId(socket.id);
    if (!clientId) {
      socket.emit('error', { message: 'You are not registered' });
      return;
    }

    imageUploadSessions.start({
      fileId: payload.fileId,
      totalChunks: payload.totalChunks,
      roomId: payload.roomId,
      clientId,
    });
    socketLogger.info('Started image upload', { fileId: payload.fileId, totalChunks: payload.totalChunks, roomId: payload.roomId, clientId });
  });

  socket.on('upload_image_chunk', (payload: { fileId: string; chunkIndex: number; chunkData: string }) => {
    const result = imageUploadSessions.addChunk(payload.fileId, payload.chunkIndex, payload.chunkData);
    if (!result.ok) {
      socket.emit('error', { message: uploadErrorMessage(result.error) });
      return;
    }

    socketLogger.debug('Received image chunk', { fileId: payload.fileId, chunkIndex: payload.chunkIndex });
  });

  socket.on('finish_image_upload', async (payload: { fileId: string; username?: string; avatar?: { text: string; color: string } }) => {
    const completedUpload = imageUploadSessions.complete(payload.fileId);
    if (!completedUpload.ok) {
      socket.emit('error', { message: uploadErrorMessage(completedUpload.error) });
      return;
    }

    const { session, buffer } = completedUpload;
    try {
      const webpBuffer = await sharp(buffer)
        .webp({ lossless: true })
        .toBuffer();

      const message = createUserMessage({
        id: uuidv4(),
        clientId: session.clientId,
        content: webpBuffer.toString('base64'),
        roomId: session.roomId,
        messageType: 'image',
        mimeType: 'image/webp',
        username: payload.username,
        avatar: payload.avatar,
      });
      const updatedRoom = await store.appendMessage(message);
      if (updatedRoom) {
        io.to(updatedRoom.creatorId).emit('room_updated', updatedRoom);
      }
      io.to(session.roomId).emit('new_message', message);
      socketLogger.info('Completed image upload and processed message', { fileId: payload.fileId, roomId: session.roomId, clientId: session.clientId });
    } catch (err) {
      socketLogger.error('Error processing image upload', { fileId: payload.fileId, error: err });
      socket.emit('error', { message: 'Error processing image upload' });
    } finally {
      imageUploadSessions.clear(payload.fileId);
    }
  });
}
