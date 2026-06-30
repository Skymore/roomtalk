import { describe, expect, it } from "vitest";
import { SENDER_COLOR_THEME_COUNT, generateRandomName, getAvatarColor, getAvatarText, getSenderColorTheme } from "./userProfile";

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

  it("uses stable sender color themes from client ids", () => {
    const theme = getSenderColorTheme("client-1");

    expect(SENDER_COLOR_THEME_COUNT).toBe(16);
    expect(getSenderColorTheme("client-1")).toEqual(theme);
    expect(theme.outlineLight).toMatch(/^rgba\(/);
    expect(theme.outlineDark).toMatch(/^rgba\(/);
    expect(new Set([
      getSenderColorTheme("client-1").outlineLight,
      getSenderColorTheme("client-2").outlineLight,
      getSenderColorTheme("client-3").outlineLight,
    ]).size).toBeGreaterThan(1);
  });
});
