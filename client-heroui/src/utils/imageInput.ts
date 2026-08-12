export const MAX_MESSAGE_IMAGES = 9;
export const MAX_IMAGE_FILE_BYTES = 10 * 1024 * 1024;
export const INITIAL_PASTE_THROTTLE_MS = 200;
export const SUBSEQUENT_PASTE_THROTTLE_MS = 50;
export const PASTE_RESET_IDLE_MS = 2000;

// HTML's accept attribute cannot express `image/*` except SVG. Keep the
// picker to common raster formats, then apply the server-aligned runtime
// check below to pasted and programmatically selected files as well.
export const MEDIA_PICKER_ACCEPT = [
  "image/apng",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/jxl",
  "image/png",
  "image/tiff",
  "image/webp",
  "image/x-icon",
  "video/*",
  ".m4v",
  ".mov",
  ".mp4",
  ".qt",
  ".webm",
].join(",");

export type ImageInputValidationError = {
  errorKey: "onlyImagesAllowed" | "unsupportedMediaType" | "imageTooLarge" | "maxImagesReached";
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

export const isAllowedImageMediaMimeType = (mimeType: string) => {
  const normalized = mimeType.trim().toLowerCase();
  if (normalized.includes("\n") || normalized.includes("\r")) {
    return false;
  }

  const baseMimeType = normalized.split(";", 1)[0].trim();
  return baseMimeType.startsWith("image/")
    && baseMimeType !== "image/svg+xml";
};

export const validateImageFile = (
  file: Pick<File, "type" | "size">,
  currentImageCount: number,
  maxImages = MAX_MESSAGE_IMAGES,
  maxBytes = MAX_IMAGE_FILE_BYTES
): ImageInputValidationResult => {
  if (currentImageCount >= maxImages) {
    return { ok: false, error: { errorKey: "maxImagesReached", max: maxImages } };
  }

  if (!file.type.trim().toLowerCase().startsWith("image/")) {
    return { ok: false, error: { errorKey: "onlyImagesAllowed" } };
  }

  if (!isAllowedImageMediaMimeType(file.type)) {
    return { ok: false, error: { errorKey: "unsupportedMediaType" } };
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
