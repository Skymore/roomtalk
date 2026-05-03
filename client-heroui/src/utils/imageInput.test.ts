import { describe, expect, it } from "vitest";
import {
  getAvailableImageSlots,
  getFirstClipboardImageFile,
  getPasteThrottleMs,
  hasClipboardImageItem,
  INITIAL_PASTE_THROTTLE_MS,
  MAX_IMAGE_FILE_BYTES,
  MAX_MESSAGE_IMAGES,
  shouldResetPasteCount,
  shouldThrottlePaste,
  SUBSEQUENT_PASTE_THROTTLE_MS,
  validateImageFile,
} from "./imageInput";

describe("imageInput", () => {
  it("calculates available image slots without going negative", () => {
    expect(getAvailableImageSlots(0)).toBe(MAX_MESSAGE_IMAGES);
    expect(getAvailableImageSlots(MAX_MESSAGE_IMAGES - 1)).toBe(1);
    expect(getAvailableImageSlots(MAX_MESSAGE_IMAGES)).toBe(0);
    expect(getAvailableImageSlots(MAX_MESSAGE_IMAGES + 2)).toBe(0);
  });

  it("validates image file type, size, and count", () => {
    expect(validateImageFile({ type: "image/png", size: 1024 }, 0)).toEqual({ ok: true });
    expect(validateImageFile({ type: "text/plain", size: 1024 }, 0)).toEqual({
      ok: false,
      error: { errorKey: "onlyImagesAllowed" },
    });
    expect(validateImageFile({ type: "image/png", size: MAX_IMAGE_FILE_BYTES + 1 }, 0)).toEqual({
      ok: false,
      error: { errorKey: "imageTooLarge" },
    });
    expect(validateImageFile({ type: "image/png", size: 1024 }, MAX_MESSAGE_IMAGES)).toEqual({
      ok: false,
      error: { errorKey: "maxImagesReached", max: MAX_MESSAGE_IMAGES },
    });
  });

  it("uses stricter initial paste throttling and allows reset after idle time", () => {
    expect(getPasteThrottleMs(0)).toBe(INITIAL_PASTE_THROTTLE_MS);
    expect(getPasteThrottleMs(1)).toBe(INITIAL_PASTE_THROTTLE_MS);
    expect(getPasteThrottleMs(2)).toBe(SUBSEQUENT_PASTE_THROTTLE_MS);

    expect(shouldThrottlePaste(100, 0, 0)).toBe(false);
    expect(shouldThrottlePaste(1000, 900, 0)).toBe(true);
    expect(shouldThrottlePaste(1000, 700, 0)).toBe(false);
    expect(shouldThrottlePaste(1000, 960, 2)).toBe(true);
    expect(shouldThrottlePaste(1000, 940, 2)).toBe(false);
    expect(shouldResetPasteCount(3000, 1000)).toBe(true);
    expect(shouldResetPasteCount(2999, 1000)).toBe(false);
  });

  it("detects and returns the first pasted image file", () => {
    const image = new File(["image"], "image.png", { type: "image/png" });
    const items = [
      { type: "text/plain", getAsFile: () => null },
      { type: "image/png", getAsFile: () => image },
      { type: "image/jpeg", getAsFile: () => new File(["other"], "other.jpg", { type: "image/jpeg" }) },
    ];

    expect(hasClipboardImageItem(items)).toBe(true);
    expect(getFirstClipboardImageFile(items)).toBe(image);
    expect(hasClipboardImageItem([{ type: "text/plain" }])).toBe(false);
    expect(getFirstClipboardImageFile([{ type: "text/plain" }])).toBeNull();
  });
});
