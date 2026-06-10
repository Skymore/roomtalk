import { describe, expect, it } from "vitest";
import {
  buildRoomShareUrl,
  isNewerRoom,
  pickNewerRoom,
  getRoomActivityAt,
  getRoomMemberUpdate,
  isJoinedRoomForClient,
  removeRoomById,
  sortRoomsByLastActivityDesc,
  upsertRoom,
  validateRoomName,
} from "./roomState";
import { Room, RoomMemberEvent } from "./types";

const room = (id: string, name = id): Room => ({
  id,
  name,
  description: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  creatorId: "creator-1",
});

describe("roomState", () => {
  it("appends new rooms and replaces duplicates in place", () => {
    const first = room("room-1", "Original");
    const second = room("room-2", "Second");
    const updated = room("room-1", "Updated");

    expect(upsertRoom([first], second)).toEqual([first, second]);
    expect(upsertRoom([first, second], updated)).toEqual([updated, second]);
  });

  it("removes rooms by id", () => {
    const first = room("room-1");
    const second = room("room-2");

    expect(removeRoomById([first, second], "room-1")).toEqual([second]);
    expect(removeRoomById([first], "missing")).toEqual([first]);
  });

  it("sorts by last activity with a created-at fallback", () => {
    const first = room("room-1", "First");
    const second = room("room-2", "Second");
    const third = room("room-3", "Third");
    first.createdAt = "2026-01-01T00:00:00.000Z";
    second.createdAt = "2026-01-02T00:00:00.000Z";
    third.createdAt = "2026-01-03T00:00:00.000Z";
    first.lastActivityAt = "2026-01-05T00:00:00.000Z";

    expect(getRoomActivityAt(second)).toBe(second.createdAt);
    expect(sortRoomsByLastActivityDesc([second, first, third])).toEqual([first, third, second]);
  });

  it("maps member updates only for the active room", () => {
    const event: RoomMemberEvent = {
      roomId: "room-1",
      user: { id: "user-1" },
      count: 3,
      action: "join",
      timestamp: "2026-01-01T00:00:00.000Z",
    };

    expect(getRoomMemberUpdate(room("room-2"), event)).toBeNull();
    expect(getRoomMemberUpdate(room("room-1"), event)).toEqual({
      count: 3,
    });
  });

  it("builds a share URL with the room query param", () => {
    expect(buildRoomShareUrl("https://example.com", "/chat", "room-1")).toBe("https://example.com/chat?room=room-1");
    expect(buildRoomShareUrl("https://example.com", "/chat?ignored=1", "room 1")).toBe("https://example.com/chat?ignored=1&room=room+1");
  });

  it("validates room names", () => {
    expect(validateRoomName("  My Room  ")).toEqual({ ok: true, name: "My Room" });
    expect(validateRoomName("   ")).toEqual({ ok: false, errorKey: "errorEmptyRoomName" });
    expect(validateRoomName("a".repeat(21))).toEqual({ ok: false, errorKey: "errorRoomNameTooLong" });
  });

  it("detects saved rooms joined from another creator", () => {
    expect(isJoinedRoomForClient(room("room-1"), "creator-1")).toBe(false);
    expect(isJoinedRoomForClient(room("room-1"), "other-client")).toBe(true);
  });

  it("orders room payloads by updatedAt with last-write-wins", () => {
    const older = { ...room("room-1"), updatedAt: "2026-06-08T10:00:00.000Z" };
    const newer = { ...room("room-1"), updatedAt: "2026-06-08T10:05:00.000Z" };

    expect(isNewerRoom(newer, older)).toBe(true);
    expect(isNewerRoom(older, newer)).toBe(false);
    // 等值放行:同一写入经 ack 与广播两条路径到达必须幂等
    expect(isNewerRoom(newer, { ...newer })).toBe(true);
    expect(pickNewerRoom(older, newer)).toBe(newer);
    expect(pickNewerRoom(newer, older)).toBe(newer);
  });

  it("accepts payloads when either side lacks a usable updatedAt", () => {
    const stamped = { ...room("room-1"), updatedAt: "2026-06-08T10:05:00.000Z" };
    const unstamped = room("room-1");
    const corrupted = { ...room("room-1"), updatedAt: "not-a-date" };

    expect(isNewerRoom(unstamped, stamped)).toBe(true);
    expect(isNewerRoom(stamped, unstamped)).toBe(true);
    // 损坏的本地 stamp 不得永久卡死后续有效更新
    expect(isNewerRoom(stamped, corrupted)).toBe(true);
    expect(isNewerRoom(corrupted, stamped)).toBe(true);
  });

  it("always accepts payloads for a different room id", () => {
    const current = { ...room("room-1"), updatedAt: "2026-06-08T10:05:00.000Z" };
    const other = { ...room("room-2"), updatedAt: "2026-06-08T09:00:00.000Z" };

    expect(isNewerRoom(other, current)).toBe(true);
  });
});
