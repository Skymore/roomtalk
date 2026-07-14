import { Room, RoomPermissions } from "./types";

const USERNAME_KEY = "roomtalk_username";
const CURRENT_VIEW_KEY = "roomtalk_current_view";
const CURRENT_ROOM_KEY = "roomtalk_current_room";
const CURRENT_ROOM_PERMISSIONS_KEY = "roomtalk_current_room_permissions";

const ROOM_PERMISSION_BOOLEAN_FIELDS = [
  "canPost",
  "canEditAnyMessage",
  "canDeleteAnyMessage",
  "canClearHistory",
  "canManageRoom",
  "canManageAdmins",
  "canManageMembers",
  "canTransferOwnership",
  "canUseCodeAgent",
] as const satisfies readonly (keyof RoomPermissions)[];

const isRoomPermissions = (value: unknown): value is RoomPermissions => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RoomPermissions>;
  return typeof candidate.roomId === "string"
    && Boolean(candidate.roomId)
    && typeof candidate.clientId === "string"
    && Boolean(candidate.clientId)
    && (candidate.role === null || candidate.role === "owner" || candidate.role === "admin" || candidate.role === "member")
    && ROOM_PERMISSION_BOOLEAN_FIELDS.every((field) => typeof candidate[field] === "boolean")
    && (candidate.postingRestrictionReason === undefined || typeof candidate.postingRestrictionReason === "string");
};

const readStoredRoomPermissions = (): RoomPermissions | null => {
  const permissionsJson = localStorage.getItem(CURRENT_ROOM_PERMISSIONS_KEY);
  if (!permissionsJson) return null;

  try {
    const permissions = JSON.parse(permissionsJson) as unknown;
    if (isRoomPermissions(permissions)) return permissions;
  } catch {
    // Invalid JSON is removed below.
  }
  localStorage.removeItem(CURRENT_ROOM_PERMISSIONS_KEY);
  return null;
};

export type AppView = "chat" | "rooms" | "saved" | "settings";

export const saveUsername = (name: string) => {
  localStorage.setItem(USERNAME_KEY, name);
  return name;
};

export const getStoredUsername = (): string => {
  return localStorage.getItem(USERNAME_KEY) || "";
};

export const clearStoredUsername = () => {
  localStorage.removeItem(USERNAME_KEY);
};

export const saveCurrentView = (view: string) => {
  localStorage.setItem(CURRENT_VIEW_KEY, view);
};

export const getStoredView = (): AppView => {
  const storedView = localStorage.getItem(CURRENT_VIEW_KEY);
  return storedView === "chat" || storedView === "rooms" || storedView === "saved" || storedView === "settings"
    ? storedView
    : "rooms";
};

export const saveCurrentRoom = (room: Room | null) => {
  if (room) {
    localStorage.setItem(CURRENT_ROOM_KEY, JSON.stringify(room));
    const storedPermissions = readStoredRoomPermissions();
    if (storedPermissions && storedPermissions.roomId !== room.id) {
      localStorage.removeItem(CURRENT_ROOM_PERMISSIONS_KEY);
    }
  } else {
    localStorage.removeItem(CURRENT_ROOM_KEY);
    localStorage.removeItem(CURRENT_ROOM_PERMISSIONS_KEY);
  }
};

export const getStoredRoom = (): Room | null => {
  const roomJson = localStorage.getItem(CURRENT_ROOM_KEY);
  if (!roomJson) {
    return null;
  }

  try {
    return JSON.parse(roomJson) as Room;
  } catch {
    localStorage.removeItem(CURRENT_ROOM_KEY);
    return null;
  }
};

export const saveCurrentRoomPermissions = (permissions: RoomPermissions | null) => {
  if (permissions) {
    localStorage.setItem(CURRENT_ROOM_PERMISSIONS_KEY, JSON.stringify(permissions));
  } else {
    localStorage.removeItem(CURRENT_ROOM_PERMISSIONS_KEY);
  }
};

export const getStoredRoomPermissions = (roomId: string, clientId: string): RoomPermissions | null => {
  const permissions = readStoredRoomPermissions();
  if (!permissions) return null;
  if (permissions.roomId === roomId && permissions.clientId === clientId) {
    return permissions;
  }
  localStorage.removeItem(CURRENT_ROOM_PERMISSIONS_KEY);
  return null;
};

export const clearStoredRoomPermissionsForClient = (clientId: string) => {
  const permissions = readStoredRoomPermissions();
  if (permissions?.clientId === clientId) {
    localStorage.removeItem(CURRENT_ROOM_PERMISSIONS_KEY);
  }
};
