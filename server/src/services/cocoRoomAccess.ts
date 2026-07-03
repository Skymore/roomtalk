import { Room, RoomMemberRole } from '../types';

export const COCO_ACCESS_DENIED_MESSAGE = 'You do not have access to this Coco room';

export function canUseCocoRoom(room: Room, clientId: string, role?: RoomMemberRole | null): boolean {
  if (room.type !== 'coco') {
    return false;
  }

  const access = room.cocoAccess || 'owner';
  const isOwner = role === 'owner' || room.creatorId === clientId;
  const isAdmin = role === 'admin';

  return access === 'member' || (access === 'admin' && (isOwner || isAdmin)) || (access === 'owner' && isOwner);
}
