import { describe, expect, it } from "vitest";
import { COMPOSITION_END_GRACE_MS, isConfirmingIMEComposition } from "./keyboardComposition";

describe("keyboardComposition", () => {
  it("detects active composition from local and native keyboard state", () => {
    expect(isConfirmingIMEComposition({
      isComposing: true,
      lastCompositionEndAt: 0,
      now: 1000,
    })).toBe(true);

    expect(isConfirmingIMEComposition({
      isComposing: false,
      nativeIsComposing: true,
      lastCompositionEndAt: 0,
      now: 1000,
    })).toBe(true);
  });

  it("treats keyCode 229 and the grace window after composition end as composition confirmation", () => {
    expect(isConfirmingIMEComposition({
      isComposing: false,
      keyCode: 229,
      lastCompositionEndAt: 0,
      now: 1000,
    })).toBe(true);

    expect(isConfirmingIMEComposition({
      isComposing: false,
      lastCompositionEndAt: 1000,
      now: 1000 + COMPOSITION_END_GRACE_MS - 1,
    })).toBe(true);

    expect(isConfirmingIMEComposition({
      isComposing: false,
      lastCompositionEndAt: 1000,
      now: 1000 + COMPOSITION_END_GRACE_MS,
    })).toBe(false);
  });
});
