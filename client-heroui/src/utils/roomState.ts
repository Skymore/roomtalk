import { Room, RoomMemberEvent } from "./types";

// Room detail/list updates still arrive through an acknowledgement and a
// broadcast path. Durable message synchronization no longer exposes either of
// the old version counters, so metadata falls back to the server timestamp.
export const isNewerRoom = (incoming: Room, existing: Room | null | undefined): boolean => {
  if (!existing || existing.id !== incoming.id) {
    return true;
  }

  if (!existing.updatedAt || !incoming.updatedAt) {
    return true;
  }

  const incomingTime = Date.parse(incoming.updatedAt);
  const existingTime = Date.parse(existing.updatedAt);
  if (Number.isNaN(incomingTime) || Number.isNaN(existingTime)) {
    return true;
  }
  return incomingTime >= existingTime;
};

export const pickNewerRoom = (incoming: Room, existing: Room | null | undefined): Room => {
  return isNewerRoom(incoming, existing) ? incoming : existing as Room;
};

export const upsertRoom = (rooms: Room[], room: Room): Room[] => {
  const existingIndex = rooms.findIndex(existing => existing.id === room.id);
  if (existingIndex === -1) {
    return [...rooms, room];
  }

  const updatedRooms = [...rooms];
  updatedRooms[existingIndex] = room;
  return updatedRooms;
};

export const getRoomActivityAt = (room: Room): string => {
  return room.lastActivityAt || room.createdAt;
};

const getRoomActivityAtTime = (room: Room): number => {
  const time = Date.parse(getRoomActivityAt(room));
  return Number.isFinite(time) ? time : 0;
};

export const sortRoomsByLastActivityDesc = (rooms: Room[]): Room[] => {
  return [...rooms].sort((first, second) => getRoomActivityAtTime(second) - getRoomActivityAtTime(first));
};

export const removeRoomById = (rooms: Room[], roomId: string): Room[] => {
  return rooms.filter(room => room.id !== roomId);
};

export const getRoomMemberUpdate = (currentRoom: Room | null, event: RoomMemberEvent) => {
  if (!currentRoom || event.roomId !== currentRoom.id) {
    return null;
  }

  return {
    count: event.count,
  };
};

export const buildRoomShareUrl = (origin: string, pathname: string, roomId: string): string => {
  const url = new URL(origin + pathname);
  url.searchParams.set("room", roomId);
  return url.toString();
};

export type RoomNameValidationResult =
  | { ok: true; name: string }
  | { ok: false; errorKey: "errorEmptyRoomName" | "errorRoomNameTooLong" };

export const validateRoomName = (name: string, maxLength = 20): RoomNameValidationResult => {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return { ok: false, errorKey: "errorEmptyRoomName" };
  }

  if (trimmedName.length > maxLength) {
    return { ok: false, errorKey: "errorRoomNameTooLong" };
  }

  return { ok: true, name: trimmedName };
};

export const isJoinedRoomForClient = (room: Room, clientId: string): boolean => {
  return room.creatorId !== clientId;
};
