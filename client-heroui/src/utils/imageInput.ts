export const MAX_MESSAGE_IMAGES = 9;
export const MAX_IMAGE_FILE_BYTES = 10 * 1024 * 1024;
export const INITIAL_PASTE_THROTTLE_MS = 200;
export const SUBSEQUENT_PASTE_THROTTLE_MS = 50;
export const PASTE_RESET_IDLE_MS = 2000;

export type ImageInputValidationError = {
  errorKey: "onlyImagesAllowed" | "imageTooLarge" | "maxImagesReached";
  max?: number;
};

export type ImageInputValidationResult =
  | { ok: true }
  | { ok: false; error: ImageInputValidationError };

type ClipboardLikeItem = {
  type: string;
  getAsFile?: () => File | null;
};

export const getAvailableImageSlots = (
  currentImageCount: number,
  maxImages = MAX_MESSAGE_IMAGES
) => Math.max(0, maxImages - currentImageCount);

export const validateImageFile = (
  file: Pick<File, "type" | "size">,
  currentImageCount: number,
  maxImages = MAX_MESSAGE_IMAGES,
  maxBytes = MAX_IMAGE_FILE_BYTES
): ImageInputValidationResult => {
  if (currentImageCount >= maxImages) {
    return { ok: false, error: { errorKey: "maxImagesReached", max: maxImages } };
  }

  if (!file.type.startsWith("image/")) {
    return { ok: false, error: { errorKey: "onlyImagesAllowed" } };
  }

  if (file.size > maxBytes) {
    return { ok: false, error: { errorKey: "imageTooLarge" } };
  }

  return { ok: true };
};

export const getPasteThrottleMs = (
  pasteCount: number,
  initialMs = INITIAL_PASTE_THROTTLE_MS,
  subsequentMs = SUBSEQUENT_PASTE_THROTTLE_MS
) => pasteCount <= 1 ? initialMs : subsequentMs;

export const shouldThrottlePaste = (
  now: number,
  lastPasteAt: number,
  pasteCount: number
) => lastPasteAt > 0 && now - lastPasteAt < getPasteThrottleMs(pasteCount);

export const shouldResetPasteCount = (
  now: number,
  lastPasteAt: number,
  idleMs = PASTE_RESET_IDLE_MS
) => now - lastPasteAt >= idleMs;

export const hasClipboardImageItem = (items: ClipboardLikeItem[]) => {
  return items.some(item => item.type.includes("image"));
};

export const getFirstClipboardImageFile = (items: ClipboardLikeItem[]) => {
  const imageItem = items.find(item => item.type.includes("image"));
  return imageItem?.getAsFile?.() ?? null;
};
