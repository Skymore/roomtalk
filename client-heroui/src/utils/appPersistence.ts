import { Room } from "./types";

const USERNAME_KEY = "roomtalk_username";
const CURRENT_VIEW_KEY = "roomtalk_current_view";
const CURRENT_ROOM_KEY = "roomtalk_current_room";

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
  } else {
    localStorage.removeItem(CURRENT_ROOM_KEY);
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
