import { Room, RoomMemberRole } from '../types';

export const CODE_AGENT_ACCESS_DENIED_MESSAGE = 'You do not have access to this Workspace room';

export function canUseCodeAgentRoom(room: Room, clientId: string, role?: RoomMemberRole | null): boolean {
  if (room.type !== 'codeAgent') {
    return false;
  }

  const access = room.codeAgentAccess || 'owner';
  const isOwner = role === 'owner' || room.creatorId === clientId;
  const isAdmin = role === 'admin';

  return access === 'member' || (access === 'admin' && (isOwner || isAdmin)) || (access === 'owner' && isOwner);
}
