import { beforeEach, describe, expect, it, vi } from "vitest";
import { getStoredRoom, getStoredUsername, getStoredView, saveCurrentRoom, saveCurrentView, saveUsername } from "./appPersistence";
import { Room } from "./types";

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
});
