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
 * Complete payloads are allowed only when every local socket has a verified
 * server-side identity and PostgreSQL membership was read successfully.
 * Missing Redis identity is unknown, not unauthorized: socket.data survives a
 * Redis flush and is a safe fallback because the server writes it only after a
 * successful authenticated registration.
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
  const unresolvedSocketIds: string[] = [];
  for (const socketId of options.socketIds) {
    const localSocket = options.getLocalSocket(socketId);
    if (!localSocket) continue;
    const storedClientId = storedClientIds.get(socketId);
    const localClientId = typeof localSocket.data?.roomtalkClientId === 'string'
      ? localSocket.data.roomtalkClientId
      : undefined;
    if (storedClientId && localClientId && storedClientId !== localClientId) {
      unresolvedSocketIds.push(socketId);
      continue;
    }
    const clientId = storedClientId || localClientId;
    if (!clientId) {
      unresolvedSocketIds.push(socketId);
      continue;
    }
    clientIdsBySocket.set(socketId, clientId);
  }

  if (unresolvedSocketIds.length > 0) {
    options.onUnavailable({ stage: 'identity', unresolvedSocketIds });
    return false;
  }

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
