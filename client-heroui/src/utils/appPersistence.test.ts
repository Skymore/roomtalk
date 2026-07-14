import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStoredRoomPermissionsForClient,
  getStoredRoom,
  getStoredRoomPermissions,
  getStoredUsername,
  getStoredView,
  saveCurrentRoom,
  saveCurrentRoomPermissions,
  saveCurrentView,
  saveUsername,
} from "./appPersistence";
import { Room, RoomPermissions } from "./types";

class MemoryStorage {
  private data = new Map<string, string>();

  getItem(key: string) {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.data.set(key, value);
  }

  removeItem(key: string) {
    this.data.delete(key);
  }
}

describe("appPersistence", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  it("persists username", () => {
    expect(getStoredUsername()).toBe("");
    expect(saveUsername("Sky")).toBe("Sky");
    expect(getStoredUsername()).toBe("Sky");
  });

  it("persists and validates the current view", () => {
    expect(getStoredView()).toBe("rooms");
    saveCurrentView("chat");
    expect(getStoredView()).toBe("chat");
    localStorage.setItem("roomtalk_current_view", "invalid");
    expect(getStoredView()).toBe("rooms");
  });

  it("persists current room and clears invalid JSON", () => {
    const room: Room = {
      id: "room-1",
      name: "General",
      createdAt: "2026-05-03T10:00:00.000Z",
      creatorId: "client-1",
    };

    saveCurrentRoom(room);
    expect(getStoredRoom()).toEqual(room);

    localStorage.setItem("roomtalk_current_room", "{invalid");
    expect(getStoredRoom()).toBeNull();
    expect(localStorage.getItem("roomtalk_current_room")).toBeNull();
  });

  it("restores current-room permissions only for the same room and client", () => {
    const permissions: RoomPermissions = {
      roomId: "room-1",
      clientId: "client-1",
      role: "member",
      canPost: true,
      canEditAnyMessage: false,
      canDeleteAnyMessage: false,
      canClearHistory: false,
      canManageRoom: false,
      canManageAdmins: false,
      canManageMembers: false,
      canTransferOwnership: false,
      canUseCodeAgent: true,
    };

    saveCurrentRoomPermissions(permissions);
    expect(getStoredRoomPermissions("room-1", "client-1")).toEqual(permissions);
    expect(getStoredRoomPermissions("room-1", "client-2")).toBeNull();
    expect(localStorage.getItem("roomtalk_current_room_permissions")).toBeNull();
  });

  it("clears retained permissions when the current room changes or closes", () => {
    const permissions: RoomPermissions = {
      roomId: "room-1",
      clientId: "client-1",
      role: "owner",
      canPost: true,
      canEditAnyMessage: true,
      canDeleteAnyMessage: true,
      canClearHistory: true,
      canManageRoom: true,
      canManageAdmins: true,
      canManageMembers: true,
      canTransferOwnership: true,
      canUseCodeAgent: true,
    };
    const firstRoom: Room = {
      id: "room-1",
      name: "First",
      createdAt: "2026-05-03T10:00:00.000Z",
      creatorId: "client-1",
    };

    saveCurrentRoom(firstRoom);
    saveCurrentRoomPermissions(permissions);
    saveCurrentRoom({ ...firstRoom, id: "room-2", name: "Second" });
    expect(localStorage.getItem("roomtalk_current_room_permissions")).toBeNull();

    saveCurrentRoomPermissions(permissions);
    saveCurrentRoom(null);
    expect(localStorage.getItem("roomtalk_current_room_permissions")).toBeNull();
  });

  it("clears corrupt permission snapshots and snapshots for a client cache reset", () => {
    localStorage.setItem("roomtalk_current_room_permissions", JSON.stringify({
      roomId: "room-1",
      clientId: "client-1",
      canPost: "yes",
    }));
    expect(getStoredRoomPermissions("room-1", "client-1")).toBeNull();

    saveCurrentRoomPermissions({
      roomId: "room-1",
      clientId: "client-1",
      role: null,
      canPost: false,
      canEditAnyMessage: false,
      canDeleteAnyMessage: false,
      canClearHistory: false,
      canManageRoom: false,
      canManageAdmins: false,
      canManageMembers: false,
      canTransferOwnership: false,
      canUseCodeAgent: false,
    });
    clearStoredRoomPermissionsForClient("client-2");
    expect(getStoredRoomPermissions("room-1", "client-1")).not.toBeNull();
    clearStoredRoomPermissionsForClient("client-1");
    expect(localStorage.getItem("roomtalk_current_room_permissions")).toBeNull();
  });
});
