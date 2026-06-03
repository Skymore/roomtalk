import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { ImageUploadSessions } from '../services/imageUploadSessions';
import { createUserMessage } from '../services/messageDomain';
import { ImageAsset, MessageImageAsset } from '../types';
import { hasRoomAccess } from './roomAccess';
import { SocketConnectionContext } from './types';

const uploadErrorMessage = (error: 'missing-session' | 'invalid-index' | 'invalid-chunk' | 'incomplete' | 'invalid-upload' | 'too-large') => {
  switch (error) {
    case 'missing-session':
      return 'No upload session for this fileId';
    case 'invalid-index':
      return 'Invalid chunk index';
    case 'invalid-chunk':
      return 'Invalid image chunk';
    case 'incomplete':
      return 'Not all chunks received';
    case 'invalid-upload':
      return 'Invalid image upload';
    case 'too-large':
      return 'Image upload is too large';
  }
};

const toMessageImageAsset = (asset: ImageAsset): MessageImageAsset => {
  const messageAsset: MessageImageAsset = {
    id: asset.id,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
  };
  if (asset.width !== undefined) messageAsset.width = asset.width;
  if (asset.height !== undefined) messageAsset.height = asset.height;
  return messageAsset;
};

export function registerMediaHandlers({ io, socket, store, socketLogger, imageObjectStorage }: SocketConnectionContext) {
  const imageUploadSessions = new ImageUploadSessions();

  const deleteImageObjectBestEffort = async (objectKey: string, context: Record<string, unknown>) => {
    try {
      await imageObjectStorage.deleteImageObject?.(objectKey);
    } catch (error) {
      socketLogger.error('Failed to delete image object during rollback', { error, objectKey, ...context });
    }
  };

  socket.on('start_image_upload', async (payload: { fileId: string; totalChunks: number; roomId: string; username?: string; avatar?: { text: string; color: string } }) => {
    const clientId = await store.getClientId(socket.id);
    if (!clientId) {
      socket.emit('error', { message: 'You are not registered' });
      return;
    }

    if (!payload.roomId || !(await hasRoomAccess(store, payload.roomId, clientId))) {
      socket.emit('error', { message: 'You are not authorized to access this room' });
      return;
    }

    if (!imageObjectStorage.isConfigured()) {
      socket.emit('error', { message: 'Image storage is not configured' });
      return;
    }

    const started = imageUploadSessions.start({
      fileId: payload.fileId,
      totalChunks: payload.totalChunks,
      roomId: payload.roomId,
      clientId,
    });
    if (!started.ok) {
      socket.emit('error', { message: uploadErrorMessage(started.error) });
      return;
    }
    socketLogger.info('Started image upload', { fileId: payload.fileId, totalChunks: payload.totalChunks, roomId: payload.roomId, clientId });
  });

  socket.on('upload_image_chunk', async (payload: { fileId: string; chunkIndex: number; chunkData: string }) => {
    const clientId = await store.getClientId(socket.id);
    if (!clientId) {
      socket.emit('error', { message: 'You are not registered' });
      return;
    }

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
      const currentClientId = await store.getClientId(socket.id);
      if (!currentClientId || currentClientId !== session.clientId) {
        socket.emit('error', { message: 'You are not registered' });
        return;
      }

      if (!(await hasRoomAccess(store, session.roomId, session.clientId))) {
        socket.emit('error', { message: 'You are not authorized to access this room' });
        return;
      }

      const webpBuffer = await sharp(buffer)
        .webp({ lossless: true })
        .toBuffer();
      const imageMetadata = await sharp(webpBuffer).metadata();
      const assetId = uuidv4();
      const messageId = uuidv4();
      const objectKey = `rooms/${session.roomId}/${assetId}.webp`;

      const message = createUserMessage({
        id: messageId,
        clientId: session.clientId,
        content: assetId,
        roomId: session.roomId,
        messageType: 'image',
        mimeType: 'image/webp',
        username: payload.username,
        avatar: payload.avatar,
      });
      const asset: ImageAsset = {
        id: assetId,
        roomId: session.roomId,
        messageId,
        objectKey,
        mimeType: 'image/webp',
        byteSize: webpBuffer.length,
        width: imageMetadata.width,
        height: imageMetadata.height,
        createdAt: message.timestamp,
      };

      await imageObjectStorage.putImageObject({
        objectKey,
        body: webpBuffer,
        mimeType: asset.mimeType,
        byteSize: asset.byteSize,
      });
      const savedAsset = await store.saveImageAsset(asset);
      if (!savedAsset) {
        await deleteImageObjectBestEffort(objectKey, { fileId: payload.fileId, roomId: session.roomId, assetId });
        socketLogger.error('Failed to save image asset metadata', { fileId: payload.fileId, roomId: session.roomId, clientId: session.clientId, assetId });
        socket.emit('error', { message: 'Failed to save image metadata' });
        return;
      }

      message.imageAsset = toMessageImageAsset(savedAsset);

      const updatedRoom = await store.appendMessage(message);
      if (!updatedRoom) {
        await deleteImageObjectBestEffort(objectKey, { fileId: payload.fileId, roomId: session.roomId, assetId, messageId: message.id });
        await store.deleteImageAsset(assetId);
        socketLogger.error('Failed to append image message', { fileId: payload.fileId, roomId: session.roomId, clientId: session.clientId, messageId: message.id });
        socket.emit('error', { message: 'Failed to save image message' });
        return;
      }

      io.to(updatedRoom.creatorId).emit('room_updated', updatedRoom);
      io.to(session.roomId).emit('new_message', message);
      socketLogger.info('Completed image upload and processed message', { fileId: payload.fileId, roomId: session.roomId, clientId: session.clientId });
    } catch (err) {
      socketLogger.error('Error processing image upload', { fileId: payload.fileId, error: err });
      socket.emit('error', { message: 'Error processing image upload' });
    } finally {
      imageUploadSessions.clear(payload.fileId);
    }
  });

  socket.on('get_image_download_url', async (
    payload: { roomId: string; assetId: string },
    callback?: (response: { success: boolean; url?: string; expiresAt?: string; error?: string }) => void,
  ) => {
    const clientId = await store.getClientId(socket.id);
    if (!clientId) {
      callback?.({ success: false, error: 'You are not registered' });
      return;
    }

    if (!payload.roomId || !payload.assetId) {
      callback?.({ success: false, error: 'Room ID and asset ID are required' });
      return;
    }

    if (!(await hasRoomAccess(store, payload.roomId, clientId))) {
      callback?.({ success: false, error: 'You are not authorized to access this room' });
      return;
    }

    const asset = await store.getImageAsset(payload.assetId);
    if (!asset || asset.roomId !== payload.roomId) {
      callback?.({ success: false, error: 'Image not found' });
      return;
    }

    try {
      callback?.({
        success: true,
        ...(await imageObjectStorage.createReadUrl({ objectKey: asset.objectKey })),
      });
    } catch (error) {
      socketLogger.error('Failed to create image download URL', { error, assetId: payload.assetId, roomId: payload.roomId });
      callback?.({ success: false, error: 'Failed to create image URL' });
    }
  });
}
