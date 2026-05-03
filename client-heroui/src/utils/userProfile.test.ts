import { describe, expect, it } from "vitest";
import { generateRandomName, getAvatarColor, getAvatarText } from "./userProfile";

const fixedRandom = (values: number[]) => {
  let index = 0;
  return () => values[index++ % values.length];
};

describe("userProfile", () => {
  it("generates localized random names", () => {
    expect(generateRandomName("zh-CN", fixedRandom([0, 0]))).toBe("可爱小猫");
    expect(generateRandomName("ja", fixedRandom([0, 0]))).toBe("ふわふわうさぎ");
    expect(generateRandomName("ko", fixedRandom([0, 0]))).toBe("포근한 토끼");
    expect(generateRandomName("hi", fixedRandom([0, 0]))).toBe("प्यारा खरगोश");
    expect(generateRandomName("en", fixedRandom([0, 0]))).toBe("FluffyBunny");
  });

  it("extracts avatar text for empty, CJK, and latin names", () => {
    expect(getAvatarText("")).toBe("?");
    expect(getAvatarText("小猫")).toBe("小");
    expect(getAvatarText("sky")).toBe("S");
  });

  it("uses stable avatar colors", () => {
    expect(getAvatarColor("sky")).toBe(getAvatarColor("sky"));
    expect(["primary", "secondary", "success", "warning", "danger"]).toContain(getAvatarColor("sky"));
    expect(getAvatarColor("")).toBe("primary");
  });
});
