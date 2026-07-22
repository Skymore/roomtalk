import type { Socket } from 'socket.io';
import type { Logger } from '../logger';
import type { RoomStore } from '../repositories/store';

type IdentitySocket = Pick<Socket, 'id' | 'data' | 'rooms' | 'emit' | 'connected'>;

interface ResolveSocketIdentityOptions {
  socket: IdentitySocket;
  store: RoomStore;
  logger: Pick<Logger, 'warn' | 'error'>;
}

const scheduleRealtimeIdentityRepair = (
  socket: IdentitySocket,
  store: RoomStore,
  logger: Pick<Logger, 'warn' | 'error'>,
  clientId: string,
) => {
  if (!socket.connected || socket.data.roomtalkIdentityRepairPending) return;
  socket.data.roomtalkIdentityRepairPending = true;
  queueMicrotask(() => {
    if (!socket.connected) {
      socket.data.roomtalkIdentityRepairPending = false;
      return;
    }
    const browserInstanceId = typeof socket.data.roomtalkBrowserInstanceId === 'string'
      ? socket.data.roomtalkBrowserInstanceId
      : undefined;
    const candidateRoomIds = [...socket.rooms].filter(roomId => roomId !== socket.id && roomId !== clientId);
    void (async () => {
      const roomIds = store.readRoomMemberClientIds
        ? (await Promise.all(candidateRoomIds.map(async roomId => (
          (await store.readRoomMemberClientIds!(roomId, [clientId])).has(clientId) ? roomId : null
        )))).filter((roomId): roomId is string => Boolean(roomId))
        : (await Promise.all(candidateRoomIds.map(async roomId => (
          await store.isRoomMember(roomId, clientId) ? roomId : null
        )))).filter((roomId): roomId is string => Boolean(roomId));
      await store.storeClientSession(socket.id, clientId, browserInstanceId);
      await store.storeUserRooms(socket.id, roomIds);
      await Promise.all(roomIds.map(async roomId => {
        await store.updateRoomMemberCount(roomId, clientId, socket.id, true);
        if (browserInstanceId) {
          await store.updateRoomBrowserPresence(roomId, browserInstanceId, socket.id, true);
        }
      }));
    })().catch(error => {
      logger.error('Failed to rebuild realtime socket identity', { error, socketId: socket.id, clientId });
    }).finally(() => {
      socket.data.roomtalkIdentityRepairPending = false;
    });
  });
};

/**
 * The authenticated connection identity in socket.data is authoritative for the
 * lifetime of the Socket. Redis is a rebuildable cross-instance presence index.
 * A conflicting non-empty Redis identity fails closed; a missing index is repaired.
 */
export const resolveAuthenticatedSocketIdentity = async ({
  socket,
  store,
  logger,
}: ResolveSocketIdentityOptions): Promise<string | null> => {
  const localClientId = typeof socket.data.roomtalkClientId === 'string'
    ? socket.data.roomtalkClientId
    : null;
  let storedClientId: string | null = null;
  try {
    storedClientId = await store.getClientId(socket.id);
  } catch (error) {
    logger.warn('Redis socket identity lookup failed; using authenticated local identity when available', {
      error,
      socketId: socket.id,
    });
  }

  if (!localClientId) {
    if (storedClientId && !socket.data.roomtalkIdentityConflictNotified) {
      socket.data.roomtalkIdentityConflictNotified = true;
      socket.emit('registration_required', { reason: 'missing_authenticated_identity' });
    }
    return null;
  }

  if (storedClientId && storedClientId !== localClientId) {
    logger.warn('Rejected socket operation because Redis and local identities conflict', {
      socketId: socket.id,
      storedClientId,
      localClientId,
    });
    if (!socket.data.roomtalkIdentityConflictNotified) {
      socket.data.roomtalkIdentityConflictNotified = true;
      socket.emit('registration_required', { reason: 'identity_conflict' });
    }
    return null;
  }

  if (!storedClientId) scheduleRealtimeIdentityRepair(socket, store, logger, localClientId);
  return localClientId;
};
