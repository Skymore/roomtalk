import { RoomStore } from '../repositories/store';

export async function hasRoomAccess(store: RoomStore, roomId: string, clientId: string): Promise<boolean> {
  const existingMember = await store.getRoomMember(roomId, clientId);
  if (existingMember) {
    return true;
  }

  const room = await store.getRoomById(roomId);
  if (!room) {
    return false;
  }

  if (room.creatorId !== clientId) {
    return false;
  }

  await store.addRoomMember(roomId, clientId, 'owner', room.createdAt);
  return true;
}
