import { clearCachedMediaForClient, clearCachedMediaForRoom } from './mediaCache';
import {
  clearCachedMessageWindowsForClient,
  invalidateCachedRoomMessageWindow,
} from './messageHistoryCache';
import { clearStoredRoomPermissionsForClient } from './appPersistence';

export const invalidatePersistentRoomCache = async (roomId: string): Promise<void> => {
  await Promise.all([
    invalidateCachedRoomMessageWindow(roomId),
    clearCachedMediaForRoom(roomId),
  ]);
};

export const clearPersistentCachesForClient = async (clientId: string): Promise<void> => {
  if (!clientId) return;
  clearStoredRoomPermissionsForClient(clientId);
  await Promise.all([
    clearCachedMessageWindowsForClient(clientId),
    clearCachedMediaForClient(clientId),
  ]);
};
