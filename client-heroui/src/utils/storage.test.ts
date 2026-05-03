import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSavedRooms, isRoomSaved, removeRoom, saveRoom } from "./storage";
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

  clear() {
    this.data.clear();
  }
}

const room = (id: string, name = id): Room => ({
  id,
  name,
  description: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  creatorId: "creator-1",
});

describe("saved room storage", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("saves rooms once and detects saved rooms", () => {
    const first = room("room-1");

    expect(saveRoom(first)).toEqual([first]);
    expect(saveRoom(first)).toEqual([first]);
    expect(getSavedRooms()).toEqual([first]);
    expect(isRoomSaved("room-1")).toBe(true);
    expect(isRoomSaved("missing")).toBe(false);
  });

  it("removes rooms without disturbing the rest", () => {
    const first = room("room-1");
    const second = room("room-2");
    saveRoom(first);
    saveRoom(second);

    expect(removeRoom("room-1")).toEqual([second]);
    expect(getSavedRooms()).toEqual([second]);
  });

  it("falls back to an empty list for invalid stored data", () => {
    localStorage.setItem("saved_rooms", "{invalid");

    expect(getSavedRooms()).toEqual([]);
    expect(isRoomSaved("room-1")).toBe(false);
  });
});
