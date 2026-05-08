import { Room, RoomMemberEvent } from "./types";

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
    event: {
      type: event.action,
      userId: event.user.id,
    },
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
