import type { Socket } from 'socket.io';

type LocalSocket = Pick<Socket, 'data' | 'emit' | 'leave'>;

interface RoomEventAuthorizationBarrierOptions {
  roomId: string;
  socketIds: string[];
  getLocalSocket(socketId: string): LocalSocket | undefined;
  readStoredClientIds(socketIds: string[]): Promise<Map<string, string>>;
  readAuthorizedClientIds(clientIds: string[]): Promise<Set<string>>;
  onUnavailable(context: { stage: 'identity' | 'membership'; error?: unknown; unresolvedSocketIds?: string[] }): void;
}

/**
 * Complete payloads are allowed only after every remaining local socket has a
 * verified server-side identity and PostgreSQL membership was read
 * successfully. Missing Redis identity is repairable because socket.data
 * survives a Redis flush. A missing or conflicting local identity is not
 * repairable from Redis: remove only that socket from the room and require it
 * to register again, rather than degrading every verified subscriber.
 */
export const enforceRoomEventAuthorizationBarrier = async (
  options: RoomEventAuthorizationBarrierOptions,
): Promise<boolean> => {
  if (options.socketIds.length === 0) return true;

  let storedClientIds = new Map<string, string>();
  try {
    storedClientIds = await options.readStoredClientIds(options.socketIds);
  } catch (error) {
    options.onUnavailable({ stage: 'identity', error });
  }

  const clientIdsBySocket = new Map<string, string>();
  const unresolvedSockets: Array<{
    socketId: string;
    reason: 'identity_conflict' | 'missing_authenticated_identity';
  }> = [];
  for (const socketId of options.socketIds) {
    const localSocket = options.getLocalSocket(socketId);
    if (!localSocket) continue;
    const storedClientId = storedClientIds.get(socketId);
    const localClientId = typeof localSocket.data?.roomtalkClientId === 'string'
      ? localSocket.data.roomtalkClientId
      : undefined;
    if (!localClientId) {
      unresolvedSockets.push({ socketId, reason: 'missing_authenticated_identity' });
      continue;
    }
    if (storedClientId && storedClientId !== localClientId) {
      unresolvedSockets.push({ socketId, reason: 'identity_conflict' });
      continue;
    }
    clientIdsBySocket.set(socketId, localClientId);
  }

  if (unresolvedSockets.length > 0) {
    options.onUnavailable({
      stage: 'identity',
      unresolvedSocketIds: unresolvedSockets.map(item => item.socketId),
    });
    await Promise.all(unresolvedSockets.map(async ({ socketId, reason }) => {
      const localSocket = options.getLocalSocket(socketId);
      if (!localSocket) return;
      localSocket.emit('registration_required', { reason });
      await localSocket.leave(options.roomId);
    }));
  }

  if (clientIdsBySocket.size === 0) return true;

  let authorizedClientIds: Set<string>;
  try {
    authorizedClientIds = await options.readAuthorizedClientIds(Array.from(new Set(clientIdsBySocket.values())));
  } catch (error) {
    options.onUnavailable({ stage: 'membership', error });
    return false;
  }

  await Promise.all(Array.from(clientIdsBySocket, async ([socketId, clientId]) => {
    if (authorizedClientIds.has(clientId)) return;
    const localSocket = options.getLocalSocket(socketId);
    if (!localSocket) return;
    localSocket.emit('room_removed', options.roomId);
    localSocket.emit('room_permissions_invalidated', options.roomId);
    await localSocket.leave(options.roomId);
  }));
  return true;
};
