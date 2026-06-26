import React from "react";
import { createPortal } from "react-dom";
import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useTranslation } from "react-i18next";
import { useCachedMedia } from "../hooks/useCachedMedia";
import { getRoomMediaHistory } from "../utils/socket";
import { getCachedMediaBlob } from "../utils/mediaCache";
import { RoomMediaHistoryItem, RoomMediaHistoryKindFilter } from "../utils/types";
import { getVideoPreviewUrl } from "../utils/videoPreview";
import {
  HORIZONTAL_TRACK_MIN_TRANSITION_MS,
  getHorizontalBoundaryResistedOffset,
  getHorizontalPageTarget,
  getHorizontalSettleTransitionMs,
} from "../hooks/useSwipePager";

type ViewerMediaKind = "image" | "video";
type MediaStageVariant = "viewer" | "historyPreview";
type MediaHistoryFilter = "all" | RoomMediaHistoryKindFilter;

interface MediaViewerModalProps {
  isOpen: boolean;
  src: string | null;
  kind: ViewerMediaKind;
  title: string;
  alt: string;
  roomId: string;
  assetId?: string;
  mimeType?: string;
  byteSize?: number;
  createdAt?: string;
  onClose: () => void;
}

interface ViewerButtonProps {
  label: string;
  icon: string;
  onPress: () => void;
  className?: string;
  isDisabled?: boolean;
}

type ActiveMedia = {
  assetId?: string;
  src: string;
  kind: ViewerMediaKind;
  mimeType?: string;
  byteSize?: number;
  createdAt?: string;
};

type ImagePan = {
  x: number;
  y: number;
};

interface MediaStageProps {
  media: ActiveMedia;
  mediaItems: ActiveMedia[];
  activeIndex: number;
  alt: string;
  variant: MediaStageVariant;
  visualRootRef?: React.RefObject<HTMLElement | null>;
  canGoPrevious: boolean;
  canGoNext: boolean;
  previousLabel: string;
  nextLabel: string;
  onPrevious: () => void;
  onNext: () => void;
  onDismiss: () => void;
  imageZoom: number;
  imagePan: ImagePan;
  onImageTransformChange: (zoom: number, pan: ImagePan) => void;
  className?: string;
}

interface MediaStageItemProps {
  item: ActiveMedia;
  alt: string;
  isActive: boolean;
  imageZoom: number;
  imagePan: ImagePan;
  videoGestureHandlers?: {
    onPointerDown: React.PointerEventHandler<HTMLVideoElement>;
    onPointerMove: React.PointerEventHandler<HTMLVideoElement>;
    onPointerUp: React.PointerEventHandler<HTMLVideoElement>;
    onPointerCancel: React.PointerEventHandler<HTMLVideoElement>;
  };
}

interface MediaHistoryGridItemProps {
  item: RoomMediaHistoryItem;
  isActive: boolean;
  sharedImageLabel: string;
  openMediaLabel: string;
  onSelect: (item: RoomMediaHistoryItem) => void;
}

const HISTORY_PAGE_SIZE = 36;
const SWIPE_DOWN_THRESHOLD = 64;
const TAP_THRESHOLD = 8;
const MIN_IMAGE_ZOOM = 1;
const MAX_IMAGE_ZOOM = 6;
const DOUBLE_TAP_DELAY_MS = 220;
const DOUBLE_TAP_DISTANCE = 34;
const VERTICAL_VELOCITY_THRESHOLD = 0.55;
const VERTICAL_STAGE_SNAP_TRANSITION_MS = 220;
const WHEEL_ZOOM_STEP = 0.28;
const DEFAULT_ZOOMED_IMAGE_SCALE = 2;
const ZERO_IMAGE_PAN: ImagePan = { x: 0, y: 0 };
const MEDIA_HISTORY_FILTERS: MediaHistoryFilter[] = ["all", "image", "video"];

const getMediaHistoryFilterLabelKey = (filter: MediaHistoryFilter) => (
  filter === "all"
    ? "mediaHistoryFilterAll"
    : filter === "image"
      ? "mediaHistoryFilterImages"
      : "mediaHistoryFilterVideos"
);

const useDeferredMediaCacheFetchKey = (resetKey: string | null) => {
  const [cacheBodyFetchKey, setCacheBodyFetchKey] = React.useState<number | null>(null);

  React.useEffect(() => {
    setCacheBodyFetchKey(null);
  }, [resetKey]);

  const markMediaLoadedForCache = React.useCallback(() => {
    setCacheBodyFetchKey(value => (value ?? 0) + 1);
  }, []);

  return { cacheBodyFetchKey, markMediaLoadedForCache };
};

const mediaFileExtensions: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

type NavigatorWithMediaShare = Navigator & {
  canShare?: (data: { files?: File[] }) => boolean;
  share?: (data: { title?: string; text?: string; url?: string; files?: File[] }) => unknown;
};

const ViewerButton: React.FC<ViewerButtonProps> = ({ label, icon, onPress, className = "", isDisabled = false }) => (
  <Button
    isIconOnly
    aria-label={label}
    title={label}
    isDisabled={isDisabled}
    className={`h-11 w-11 min-w-0 rounded-full bg-white/10 text-white shadow-lg backdrop-blur-md transition hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/80 disabled:cursor-not-allowed disabled:opacity-45 ${className}`}
    onPress={onPress}
  >
    <Icon icon={icon} className="h-5 w-5" />
  </Button>
);

const MediaStageItem: React.FC<MediaStageItemProps> = ({ item, alt, isActive, imageZoom, imagePan, videoGestureHandlers }) => {
  const { t } = useTranslation();
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [videoPreviewError, setVideoPreviewError] = React.useState(false);
  const { cacheBodyFetchKey, markMediaLoadedForCache } = useDeferredMediaCacheFetchKey(item.src);
  const { mediaUrl, posterUrl } = useCachedMedia({
    assetId: item.assetId,
    url: item.src,
    kind: item.kind,
    mimeType: item.mimeType,
    byteSize: item.byteSize,
    cacheBodyFetchKey,
  });
  const displayUrl = mediaUrl || item.src;

  React.useEffect(() => {
    setVideoPreviewError(false);
  }, [displayUrl, item.kind]);

  React.useEffect(() => {
    if (item.kind !== "video" || isActive) return;
    try {
      videoRef.current?.pause();
    } catch {
      // Some test and embedded browser environments expose video elements without media controls.
    }
  }, [isActive, item.kind]);

  if (item.kind === "image") {
    const isZoomed = isActive && imageZoom > MIN_IMAGE_ZOOM;
    return (
      <img
        src={displayUrl}
        alt={alt}
        crossOrigin="anonymous"
        className={`max-h-full max-w-full select-none object-contain will-change-transform ${isZoomed ? "cursor-grab active:cursor-grabbing" : isActive ? "cursor-zoom-in" : ""}`}
        style={isActive ? {
          transform: `translate3d(${imagePan.x}px, ${imagePan.y}px, 0) scale(${imageZoom})`,
          transition: "transform 160ms ease-out",
        } : undefined}
        onLoad={markMediaLoadedForCache}
        draggable={false}
      />
    );
  }

  if (videoPreviewError) {
    return (
      <div className="flex max-w-md flex-col items-center gap-4 rounded-xl border border-white/10 bg-white/[0.06] px-6 py-8 text-center text-white shadow-2xl">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white/10 text-white">
          <Icon icon="lucide:video-off" className="h-7 w-7" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-semibold text-white">{t("videoPreviewUnsupported")}</p>
          <p className="text-xs text-white/60">{item.mimeType || t("videoMessage")}</p>
        </div>
        <a
          href={displayUrl}
          download={getMediaFileName(item)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-10 items-center gap-2 rounded-full bg-white px-4 text-sm font-semibold text-[#141413] transition hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
        >
          <Icon icon="lucide:download" className="h-4 w-4" />
          {t("downloadMedia")}
        </a>
      </div>
    );
  }

  return (
    <video
      ref={videoRef}
      key={displayUrl}
      src={displayUrl}
      poster={posterUrl || undefined}
      crossOrigin="anonymous"
      className="max-h-full w-full max-w-5xl bg-black object-contain sm:rounded-lg"
      controls={isActive}
      playsInline
      preload="metadata"
      onLoadedData={markMediaLoadedForCache}
      onError={() => setVideoPreviewError(true)}
      {...(isActive ? videoGestureHandlers : undefined)}
    />
  );
};

const MediaHistoryGridItem: React.FC<MediaHistoryGridItemProps> = ({
  item,
  isActive,
  sharedImageLabel,
  openMediaLabel,
  onSelect,
}) => {
  const [videoPreviewError, setVideoPreviewError] = React.useState(false);
  const { cacheBodyFetchKey, markMediaLoadedForCache } = useDeferredMediaCacheFetchKey(item.url);
  const { mediaUrl, posterUrl } = useCachedMedia({
    assetId: item.assetId,
    url: item.url,
    kind: item.kind,
    mimeType: item.mimeType,
    byteSize: item.byteSize,
    cacheBodyFetchKey,
  });
  const displayUrl = mediaUrl || item.url;

  React.useEffect(() => {
    setVideoPreviewError(false);
  }, [displayUrl, item.kind]);

  return (
    <button
      type="button"
      aria-label={openMediaLabel}
      className={`relative aspect-square cursor-pointer overflow-hidden bg-black/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 ${isActive ? "ring-2 ring-[#d97757]" : ""}`}
      onClick={() => onSelect(item)}
    >
      {item.kind === "image" ? (
        <img
          src={displayUrl}
          alt={sharedImageLabel}
          crossOrigin="anonymous"
          className="h-full w-full object-cover"
          loading="lazy"
          onLoad={markMediaLoadedForCache}
        />
      ) : videoPreviewError ? (
        <div className="flex h-full w-full items-center justify-center bg-black/50 text-white/80">
          <Icon icon="lucide:video-off" className="h-7 w-7" />
        </div>
      ) : (
        <>
          <video
            src={getVideoPreviewUrl(displayUrl)}
            poster={posterUrl || undefined}
            crossOrigin="anonymous"
            className="h-full w-full object-cover"
            preload="metadata"
            muted
            playsInline
            onLoadedData={markMediaLoadedForCache}
            onError={() => setVideoPreviewError(true)}
          />
          <span className="absolute inset-0 flex items-center justify-center bg-black/20">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/45 text-white">
              <Icon icon="lucide:play" className="ml-0.5 h-4 w-4" />
            </span>
          </span>
        </>
      )}
    </button>
  );
};

const getMediaKey = (media: ActiveMedia) => media.assetId || media.src;

const isSameMedia = (first: ActiveMedia, second: ActiveMedia) => {
  if (first.assetId && second.assetId) {
    return first.assetId === second.assetId;
  }
  return first.src === second.src;
};

const getMediaTime = (media: ActiveMedia) => {
  if (!media.createdAt) return Number.POSITIVE_INFINITY;
  const time = new Date(media.createdAt).getTime();
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
};

const getHistoryItemTime = (item: RoomMediaHistoryItem) => {
  const time = new Date(item.createdAt).getTime();
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
};

const compareMediaAscending = (first: ActiveMedia, second: ActiveMedia) => {
  const timeDelta = getMediaTime(first) - getMediaTime(second);
  return timeDelta || getMediaKey(first).localeCompare(getMediaKey(second));
};

const compareHistoryItemAscending = (first: RoomMediaHistoryItem, second: RoomMediaHistoryItem) => {
  const timeDelta = getHistoryItemTime(first) - getHistoryItemTime(second);
  return timeDelta || first.assetId.localeCompare(second.assetId);
};

const historyItemToActiveMedia = (item: RoomMediaHistoryItem): ActiveMedia => ({
  assetId: item.assetId,
  src: item.url,
  kind: item.kind,
  mimeType: item.mimeType,
  byteSize: item.byteSize,
  createdAt: item.createdAt,
});

const getMediaFileName = (media: ActiveMedia) => {
  const extension = media.mimeType
    ? mediaFileExtensions[media.mimeType] || media.mimeType.split("/")[1]?.split(";")[0]?.replace(/[^a-z0-9]/gi, "")
    : undefined;
  const fallbackExtension = media.kind === "video" ? "mp4" : "jpg";
  return `roomtalk-${media.kind}-${media.assetId || "media"}.${extension || fallbackExtension}`;
};

const triggerBrowserDownload = (url: string, fileName: string, openInNewTab = false) => {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener noreferrer";
  if (openInNewTab) {
    anchor.target = "_blank";
  }
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
};

const downloadMediaUrl = async (url: string, fileName: string) => {
  if (typeof document === "undefined") return;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch media: ${response.status}`);
    }

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    triggerBrowserDownload(objectUrl, fileName);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (error) {
    console.warn("Falling back to direct media download:", error);
    triggerBrowserDownload(url, fileName, true);
  }
};

const downloadMediaBlob = (blob: Blob, fileName: string) => {
  if (typeof document === "undefined") return;

  const objectUrl = URL.createObjectURL(blob);
  triggerBrowserDownload(objectUrl, fileName);
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
};

const getMonthKey = (timestamp: string) => {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
};

const formatMonthLabel = (timestamp: string, language?: string) => {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(language || undefined, {
    year: "numeric",
    month: "long",
  }).format(date);
};

const groupHistoryByMonth = (items: RoomMediaHistoryItem[], language?: string) => {
  const groups: Array<{ key: string; label: string; items: RoomMediaHistoryItem[] }> = [];
  const byKey = new Map<string, { key: string; label: string; items: RoomMediaHistoryItem[] }>();

  for (const item of items) {
    const key = getMonthKey(item.createdAt);
    if (!key) continue;

    let group = byKey.get(key);
    if (!group) {
      group = { key, label: formatMonthLabel(item.createdAt, language), items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }

  return groups;
};

const MediaStage: React.FC<MediaStageProps> = ({
  media,
  mediaItems,
  activeIndex,
  alt,
  variant,
  visualRootRef,
  canGoPrevious,
  canGoNext,
  previousLabel,
  nextLabel,
  onPrevious,
  onNext,
  onDismiss,
  imageZoom,
  imagePan,
  onImageTransformChange,
  className = "",
}) => {
  type GestureMode = "idle" | "tap" | "horizontal" | "vertical" | "pan" | "pinch" | "ignored";
  type GesturePoint = { x: number; y: number };
  type GestureMetrics = { width: number; height: number; left: number; top: number };
  type GestureState = {
    mode: GestureMode;
    pointerId: number | null;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    startTime: number;
    width: number;
    height: number;
    startZoom: number;
    startPan: ImagePan;
    currentZoom: number;
    currentPan: ImagePan;
    pinchDistance?: number;
    pinchCenter?: GesturePoint;
    metrics: GestureMetrics;
    allowTapDismiss: boolean;
  };
  type PendingDomTransforms = {
    image?: { zoom: number; pan: ImagePan; transition: boolean };
    stage?: { offset: number; height: number; transition: boolean; durationMs: number };
    track?: { translateX: number; transition: boolean; durationMs: number };
  };

  const stageRef = React.useRef<HTMLElement | null>(null);
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const pointerPositionsRef = React.useRef<Map<number, GesturePoint>>(new Map());
  const pointerSequenceRef = React.useRef(false);
  const mouseGestureActiveRef = React.useRef(false);
  const gestureRef = React.useRef<GestureState | null>(null);
  const imageTransformRef = React.useRef({ zoom: imageZoom, pan: imagePan });
  const lastTapRef = React.useRef<{ x: number; y: number; time: number } | null>(null);
  const pendingDomTransformsRef = React.useRef<PendingDomTransforms>({});
  const transformFrameRef = React.useRef<number | null>(null);
  const tapTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const capturedPointerIdsRef = React.useRef<Set<number>>(new Set());
  const [trackWidth, setTrackWidth] = React.useState(0);
  const isHistoryPreview = variant === "historyPreview";
  const trackItems = mediaItems.length > 0 ? mediaItems : [media];
  const safeActiveIndex = activeIndex >= 0 && activeIndex < trackItems.length ? activeIndex : 0;
  const activeStageMedia = trackItems[safeActiveIndex] || media;
  const activeStageMediaKey = getMediaKey(activeStageMedia);

  const now = () => (
    typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now()
  );

  const clearTapTimer = React.useCallback(() => {
    if (tapTimerRef.current) {
      clearTimeout(tapTimerRef.current);
      tapTimerRef.current = null;
    }
  }, []);

  const isInteractiveTarget = (target: EventTarget) => (
    target instanceof Element && Boolean(target.closest("button,a,input,textarea,select,[role='button']"))
  );

  const isVideoTarget = (target: EventTarget) => (
    target instanceof Element && Boolean(target.closest("video"))
  );

  const flushDomTransforms = React.useCallback(() => {
    transformFrameRef.current = null;
    const pending = pendingDomTransformsRef.current;
    pendingDomTransformsRef.current = {};

    if (pending.track) {
      const trackElement = trackRef.current;
      if (trackElement) {
        trackElement.style.transition = pending.track.transition
          ? `transform ${pending.track.durationMs}ms cubic-bezier(0.2, 0, 0, 1)`
          : "none";
        trackElement.style.transform = `translate3d(${pending.track.translateX}px, 0, 0)`;
      }
    }

    if (pending.stage) {
      const stageElement = stageRef.current;
      if (stageElement) {
        const normalizedOffset = Math.max(0, pending.stage.offset);
        const rawProgress = Math.min(1, normalizedOffset / Math.max(1, pending.stage.height * 0.55));
        const easedProgress = 1 - Math.pow(1 - rawProgress, 1.45);
        const scale = Math.max(0.78, 1 - easedProgress * 0.22);
        const backdropOpacity = Math.max(0.28, 1 - easedProgress * 0.72);
        const chromeOpacity = Math.max(0, 1 - rawProgress * 2.25);
        const transition = pending.stage.transition
          ? `transform ${pending.stage.durationMs}ms cubic-bezier(0.2, 0, 0, 1), opacity ${pending.stage.durationMs}ms cubic-bezier(0.2, 0, 0, 1)`
          : "none";
        const rootElement = visualRootRef?.current;
        stageElement.style.transition = pending.stage.transition
          ? transition
          : "none";
        stageElement.style.transform = normalizedOffset === 0
          ? "translate3d(0, 0, 0) scale(1)"
          : `translate3d(0, ${normalizedOffset}px, 0) scale(${scale})`;
        stageElement.style.opacity = "1";
        if (rootElement) {
          rootElement.style.transition = pending.stage.transition
            ? `background-color ${pending.stage.durationMs}ms cubic-bezier(0.2, 0, 0, 1)`
            : "none";
          rootElement.style.backgroundColor = `rgba(8, 8, 7, ${backdropOpacity})`;
          rootElement.style.setProperty("--media-viewer-chrome-opacity", String(chromeOpacity));
          rootElement.style.setProperty(
            "--media-viewer-chrome-transition",
            pending.stage.transition ? `opacity ${pending.stage.durationMs}ms cubic-bezier(0.2, 0, 0, 1)` : "none",
          );
        }
      }
    }

    if (pending.image) {
      const imageElement = stageRef.current?.querySelector('[data-active-media="true"] img') as HTMLImageElement | null;
      if (imageElement) {
        imageElement.style.transition = pending.image.transition ? "transform 180ms ease-out" : "none";
        imageElement.style.transform = `translate3d(${pending.image.pan.x}px, ${pending.image.pan.y}px, 0) scale(${pending.image.zoom})`;
      }
    }
  }, [visualRootRef]);

  const scheduleDomTransformFlush = React.useCallback(() => {
    if (transformFrameRef.current !== null) {
      return;
    }

    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      flushDomTransforms();
      return;
    }

    transformFrameRef.current = window.requestAnimationFrame(flushDomTransforms);
  }, [flushDomTransforms]);

  const getStageMetrics = React.useCallback((): GestureMetrics => {
    const stage = stageRef.current;
    const rect = stage?.getBoundingClientRect();
    const width = trackRef.current?.clientWidth
      || stage?.clientWidth
      || rect?.width
      || (typeof window !== "undefined" ? window.innerWidth : 1)
      || 1;
    const height = stage?.clientHeight
      || rect?.height
      || (typeof window !== "undefined" ? window.innerHeight : 1)
      || 1;
    return {
      width,
      height,
      left: rect && rect.width > 0 ? rect.left : 0,
      top: rect && rect.height > 0 ? rect.top : 0,
    };
  }, []);

  const getCurrentTrackWidth = React.useCallback(() => getStageMetrics().width, [getStageMetrics]);

  const getStagePoint = React.useCallback((clientX: number, clientY: number, metrics = getStageMetrics()): GesturePoint => {
    return {
      x: clientX - metrics.left - (metrics.width / 2),
      y: clientY - metrics.top - (metrics.height / 2),
    };
  }, [getStageMetrics]);

  const clampZoom = (zoom: number) => Math.max(MIN_IMAGE_ZOOM, Math.min(MAX_IMAGE_ZOOM, zoom));

  const clampImagePan = React.useCallback((pan: ImagePan, zoom: number, metrics = getStageMetrics()): ImagePan => {
    if (zoom <= MIN_IMAGE_ZOOM) {
      return ZERO_IMAGE_PAN;
    }

    const maxX = Math.max(0, (metrics.width * (zoom - 1)) / 2);
    const maxY = Math.max(0, (metrics.height * (zoom - 1)) / 2);
    return {
      x: Math.max(-maxX, Math.min(maxX, pan.x)),
      y: Math.max(-maxY, Math.min(maxY, pan.y)),
    };
  }, [getStageMetrics]);

  const applyActiveImageTransform = React.useCallback((zoom: number, pan: ImagePan, transition = false) => {
    imageTransformRef.current = { zoom, pan };
    pendingDomTransformsRef.current.image = { zoom, pan, transition };
    scheduleDomTransformFlush();
  }, [scheduleDomTransformFlush]);

  const commitImageTransform = React.useCallback((nextZoom: number, nextPan: ImagePan, transition = true, metrics?: GestureMetrics) => {
    const clampedZoom = clampZoom(nextZoom);
    const normalizedZoom = clampedZoom <= MIN_IMAGE_ZOOM + 0.01 ? MIN_IMAGE_ZOOM : clampedZoom;
    const normalizedPan = normalizedZoom <= MIN_IMAGE_ZOOM ? ZERO_IMAGE_PAN : clampImagePan(nextPan, normalizedZoom, metrics);
    applyActiveImageTransform(normalizedZoom, normalizedPan, transition);
    onImageTransformChange(normalizedZoom, normalizedPan);
  }, [applyActiveImageTransform, clampImagePan, onImageTransformChange]);

  const getBoundaryResistedOffset = React.useCallback((offset: number, metrics = getStageMetrics()) => {
    return getHorizontalBoundaryResistedOffset(offset, metrics.width, canGoPrevious, canGoNext);
  }, [canGoNext, canGoPrevious, getStageMetrics]);

  const applyTrackOffset = React.useCallback((
    offset: number,
    transition = false,
    metrics = getStageMetrics(),
    durationMs = HORIZONTAL_TRACK_MIN_TRANSITION_MS,
  ) => {
    pendingDomTransformsRef.current.track = {
      translateX: (-safeActiveIndex * metrics.width) + offset,
      transition,
      durationMs,
    };
    scheduleDomTransformFlush();
  }, [getStageMetrics, safeActiveIndex, scheduleDomTransformFlush]);

  const applyVerticalOffset = React.useCallback((
    offset: number,
    transition = false,
    metrics = getStageMetrics(),
    durationMs = VERTICAL_STAGE_SNAP_TRANSITION_MS,
  ) => {
    pendingDomTransformsRef.current.stage = {
      offset,
      height: Math.max(1, metrics.height),
      transition,
      durationMs,
    };
    scheduleDomTransformFlush();
  }, [getStageMetrics, scheduleDomTransformFlush]);

  const resetVerticalVisuals = React.useCallback(() => {
    const rootElement = visualRootRef?.current;
    if (rootElement) {
      rootElement.style.transition = "none";
      rootElement.style.backgroundColor = "";
      rootElement.style.setProperty("--media-viewer-chrome-opacity", "1");
      rootElement.style.setProperty("--media-viewer-chrome-transition", "none");
    }
    const stageElement = stageRef.current;
    if (stageElement) {
      stageElement.style.transition = "none";
      stageElement.style.transform = "translate3d(0, 0, 0) scale(1)";
      stageElement.style.opacity = "1";
    }
  }, [visualRootRef]);

  const getDistance = React.useCallback((first: GesturePoint, second: GesturePoint) => (
    Math.hypot(second.x - first.x, second.y - first.y)
  ), []);

  const getCenter = React.useCallback((first: GesturePoint, second: GesturePoint): GesturePoint => ({
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  }), []);

  const zoomAtPoint = React.useCallback((clientX: number, clientY: number, nextZoom: number) => {
    const currentTransform = imageTransformRef.current;
    const metrics = getStageMetrics();
    const targetZoom = clampZoom(nextZoom);
    if (targetZoom <= MIN_IMAGE_ZOOM) {
      commitImageTransform(MIN_IMAGE_ZOOM, ZERO_IMAGE_PAN, true, metrics);
      return;
    }

    const point = getStagePoint(clientX, clientY, metrics);
    const ratio = targetZoom / Math.max(MIN_IMAGE_ZOOM, currentTransform.zoom);
    const nextPan = clampImagePan({
      x: point.x - ((point.x - currentTransform.pan.x) * ratio),
      y: point.y - ((point.y - currentTransform.pan.y) * ratio),
    }, targetZoom, metrics);
    commitImageTransform(targetZoom, nextPan, true, metrics);
  }, [clampImagePan, commitImageTransform, getStageMetrics, getStagePoint]);

  const handleDoubleTap = React.useCallback((clientX: number, clientY: number) => {
    if (activeStageMedia.kind !== "image") {
      onDismiss();
      return;
    }

    const currentTransform = imageTransformRef.current;
    const targetZoom = currentTransform.zoom > MIN_IMAGE_ZOOM ? MIN_IMAGE_ZOOM : DEFAULT_ZOOMED_IMAGE_SCALE;
    zoomAtPoint(clientX, clientY, targetZoom);
  }, [activeStageMedia.kind, onDismiss, zoomAtPoint]);

  const scheduleTapDismiss = React.useCallback((clientX: number, clientY: number) => {
    const currentTime = now();
    const lastTap = lastTapRef.current;
    const isImageDoubleTap = activeStageMedia.kind === "image"
      && lastTap
      && currentTime - lastTap.time <= DOUBLE_TAP_DELAY_MS
      && Math.hypot(clientX - lastTap.x, clientY - lastTap.y) <= DOUBLE_TAP_DISTANCE;

    if (isImageDoubleTap) {
      clearTapTimer();
      lastTapRef.current = null;
      handleDoubleTap(clientX, clientY);
      return;
    }

    clearTapTimer();
    lastTapRef.current = { x: clientX, y: clientY, time: currentTime };
    tapTimerRef.current = setTimeout(() => {
      lastTapRef.current = null;
      tapTimerRef.current = null;
      onDismiss();
    }, activeStageMedia.kind === "image" ? DOUBLE_TAP_DELAY_MS : 0);
  }, [activeStageMedia.kind, clearTapTimer, handleDoubleTap, onDismiss]);

  const beginSinglePointGesture = React.useCallback((clientX: number, clientY: number, pointerId: number | null, target: EventTarget) => {
    if (isInteractiveTarget(target)) {
      gestureRef.current = null;
      return false;
    }

    const currentTime = now();
    const lastTap = lastTapRef.current;
    if (
      activeStageMedia.kind === "image"
      && lastTap
      && currentTime - lastTap.time <= DOUBLE_TAP_DELAY_MS
      && Math.hypot(clientX - lastTap.x, clientY - lastTap.y) <= DOUBLE_TAP_DISTANCE
    ) {
      clearTapTimer();
    }

    const metrics = getStageMetrics();
    const currentTransform = imageTransformRef.current;
    gestureRef.current = {
      mode: "tap",
      pointerId,
      startX: clientX,
      startY: clientY,
      lastX: clientX,
      lastY: clientY,
      startTime: currentTime,
      width: metrics.width,
      height: metrics.height,
      startZoom: currentTransform.zoom,
      startPan: currentTransform.pan,
      currentZoom: currentTransform.zoom,
      currentPan: currentTransform.pan,
      metrics,
      allowTapDismiss: !isVideoTarget(target),
    };
    return true;
  }, [activeStageMedia.kind, clearTapTimer, getStageMetrics]);

  const beginPinchGesture = React.useCallback(() => {
    const points = Array.from(pointerPositionsRef.current.values()).slice(0, 2);
    if (points.length < 2 || activeStageMedia.kind !== "image") {
      gestureRef.current = null;
      return;
    }

    clearTapTimer();
    const metrics = getStageMetrics();
    applyTrackOffset(0, true, metrics);
    applyVerticalOffset(0, true, metrics);
    const center = getCenter(points[0], points[1]);
    const currentTransform = imageTransformRef.current;
    gestureRef.current = {
      mode: "pinch",
      pointerId: null,
      startX: center.x,
      startY: center.y,
      lastX: center.x,
      lastY: center.y,
      startTime: now(),
      width: metrics.width,
      height: metrics.height,
      startZoom: currentTransform.zoom,
      startPan: currentTransform.pan,
      currentZoom: currentTransform.zoom,
      currentPan: currentTransform.pan,
      pinchDistance: Math.max(1, getDistance(points[0], points[1])),
      pinchCenter: getStagePoint(center.x, center.y, metrics),
      metrics,
      allowTapDismiss: true,
    };
  }, [activeStageMedia.kind, applyTrackOffset, applyVerticalOffset, clearTapTimer, getCenter, getDistance, getStageMetrics, getStagePoint]);

  const updatePinchGesture = React.useCallback(() => {
    const state = gestureRef.current;
    if (!state || state.mode !== "pinch" || !state.pinchDistance || !state.pinchCenter) return;

    const points = Array.from(pointerPositionsRef.current.values()).slice(0, 2);
    if (points.length < 2) return;

    const center = getCenter(points[0], points[1]);
    const stageCenter = getStagePoint(center.x, center.y, state.metrics);
    const distance = Math.max(1, getDistance(points[0], points[1]));
    const nextZoom = clampZoom(state.startZoom * (distance / state.pinchDistance));
    const ratio = nextZoom / Math.max(MIN_IMAGE_ZOOM, state.startZoom);
    const nextPan = nextZoom <= MIN_IMAGE_ZOOM
      ? ZERO_IMAGE_PAN
      : clampImagePan({
        x: stageCenter.x - ((state.pinchCenter.x - state.startPan.x) * ratio),
        y: stageCenter.y - ((state.pinchCenter.y - state.startPan.y) * ratio),
      }, nextZoom, state.metrics);

    state.currentZoom = nextZoom;
    state.currentPan = nextPan;
    applyActiveImageTransform(nextZoom, nextPan, false);
  }, [applyActiveImageTransform, clampImagePan, getCenter, getDistance, getStagePoint]);

  const updateSinglePointGesture = React.useCallback((clientX: number, clientY: number) => {
    const state = gestureRef.current;
    if (!state || state.mode === "pinch") return;

    state.lastX = clientX;
    state.lastY = clientY;
    const deltaX = clientX - state.startX;
    const deltaY = clientY - state.startY;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);
    const isZoomedImage = activeStageMedia.kind === "image" && state.startZoom > MIN_IMAGE_ZOOM;

    if (state.mode === "tap" && (absX > TAP_THRESHOLD || absY > TAP_THRESHOLD)) {
      clearTapTimer();
      if (deltaY > 0 && absY > absX * 1.15) {
        state.mode = "vertical";
      } else if (isZoomedImage) {
        state.mode = "pan";
      } else if (absX > absY * 1.1) {
        state.mode = "horizontal";
      } else {
        state.mode = "ignored";
      }
    }

    if (state.mode === "horizontal") {
      applyTrackOffset(getBoundaryResistedOffset(deltaX, state.metrics), false, state.metrics);
      return;
    }

    if (state.mode === "vertical") {
      applyVerticalOffset(deltaY, false, state.metrics);
      return;
    }

    if (state.mode === "pan") {
      const nextPan = clampImagePan({
        x: state.startPan.x + deltaX,
        y: state.startPan.y + deltaY,
      }, state.startZoom, state.metrics);
      state.currentPan = nextPan;
      applyActiveImageTransform(state.startZoom, nextPan, false);
    }
  }, [activeStageMedia.kind, applyActiveImageTransform, applyTrackOffset, applyVerticalOffset, clampImagePan, clearTapTimer, getBoundaryResistedOffset]);

  const finishSinglePointGesture = React.useCallback((clientX: number, clientY: number) => {
    const state = gestureRef.current;
    if (!state || state.mode === "pinch") return;

    updateSinglePointGesture(clientX, clientY);
    const finalState = gestureRef.current;
    if (!finalState || finalState.mode === "pinch") return;

    const deltaX = clientX - finalState.startX;
    const deltaY = clientY - finalState.startY;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);
    const elapsed = Math.max(1, now() - finalState.startTime);
    const velocityY = deltaY / elapsed;

    gestureRef.current = null;
    mouseGestureActiveRef.current = false;

    if (finalState.mode === "horizontal") {
      const pageTarget = getHorizontalPageTarget({
        deltaX,
        deltaY,
        elapsedMs: elapsed,
        width: finalState.width,
        canGoPrevious,
        canGoNext,
      });

      if (pageTarget?.direction === "next") {
        applyTrackOffset(pageTarget.settleOffset, true, finalState.metrics, pageTarget.durationMs);
        onNext();
        return;
      }

      if (pageTarget?.direction === "previous") {
        applyTrackOffset(pageTarget.settleOffset, true, finalState.metrics, pageTarget.durationMs);
        onPrevious();
        return;
      }

      applyTrackOffset(
        0,
        true,
        finalState.metrics,
        getHorizontalSettleTransitionMs(deltaX, elapsed, finalState.width),
      );
      return;
    }

    if (finalState.mode === "vertical") {
      const shouldDismiss = deltaY > SWIPE_DOWN_THRESHOLD
        || (velocityY > VERTICAL_VELOCITY_THRESHOLD && deltaY > TAP_THRESHOLD * 2 && absY > absX * 1.1);
      if (shouldDismiss) {
        resetVerticalVisuals();
        onDismiss();
        return;
      }
      applyVerticalOffset(0, true, finalState.metrics);
      return;
    }

    if (finalState.mode === "pan") {
      if (absX <= TAP_THRESHOLD && absY <= TAP_THRESHOLD) {
        if (finalState.allowTapDismiss) {
          scheduleTapDismiss(clientX, clientY);
        }
        return;
      }
      commitImageTransform(finalState.currentZoom, finalState.currentPan, true, finalState.metrics);
      return;
    }

    if (finalState.mode === "tap") {
      if (finalState.allowTapDismiss) {
        scheduleTapDismiss(clientX, clientY);
      }
      return;
    }

    applyTrackOffset(0, true, finalState.metrics);
    applyVerticalOffset(0, true, finalState.metrics);
  }, [applyTrackOffset, applyVerticalOffset, canGoNext, canGoPrevious, commitImageTransform, onDismiss, onNext, onPrevious, resetVerticalVisuals, scheduleTapDismiss, updateSinglePointGesture]);

  const finishPinchGesture = React.useCallback(() => {
    const state = gestureRef.current;
    if (!state || state.mode !== "pinch") return;

    gestureRef.current = null;
    commitImageTransform(state.currentZoom, state.currentPan, true, state.metrics);
  }, [commitImageTransform]);

  React.useLayoutEffect(() => {
    const updateTrackWidth = () => {
      setTrackWidth(getCurrentTrackWidth());
    };

    updateTrackWidth();
    const observedElement = trackRef.current || stageRef.current;
    if (!observedElement || typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateTrackWidth);
      return () => window.removeEventListener("resize", updateTrackWidth);
    }

    const observer = new ResizeObserver(updateTrackWidth);
    observer.observe(observedElement);
    return () => observer.disconnect();
  }, [getCurrentTrackWidth]);

  React.useLayoutEffect(() => {
    applyTrackOffset(0, false);
  }, [activeStageMediaKey, applyTrackOffset, trackWidth]);

  React.useLayoutEffect(() => {
    const nextPan = imageZoom <= MIN_IMAGE_ZOOM ? ZERO_IMAGE_PAN : clampImagePan(imagePan, imageZoom);
    imageTransformRef.current = { zoom: imageZoom, pan: nextPan };
    applyActiveImageTransform(imageZoom, nextPan, true);
    if (nextPan.x !== imagePan.x || nextPan.y !== imagePan.y) {
      onImageTransformChange(imageZoom, nextPan);
    }
  }, [activeStageMediaKey, applyActiveImageTransform, clampImagePan, imagePan, imageZoom, onImageTransformChange, trackWidth]);

  React.useEffect(() => () => {
    clearTapTimer();
    capturedPointerIdsRef.current.clear();
    if (transformFrameRef.current !== null && typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(transformFrameRef.current);
      transformFrameRef.current = null;
    }
    pendingDomTransformsRef.current = {};
    resetVerticalVisuals();
  }, [clearTapTimer, resetVerticalVisuals]);

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    pointerSequenceRef.current = true;
    if (isInteractiveTarget(event.target)) {
      return;
    }

    pointerPositionsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!isVideoTarget(event.target) && typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
      capturedPointerIdsRef.current.add(event.pointerId);
    }

    if (pointerPositionsRef.current.size >= 2) {
      beginPinchGesture();
      return;
    }

    beginSinglePointGesture(event.clientX, event.clientY, event.pointerId, event.target);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (!pointerPositionsRef.current.has(event.pointerId)) return;

    pointerPositionsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const state = gestureRef.current;
    if (state?.mode === "pinch") {
      updatePinchGesture();
      return;
    }
    if (state?.pointerId === event.pointerId) {
      updateSinglePointGesture(event.clientX, event.clientY);
    }
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const state = gestureRef.current;
    if (state?.mode === "pinch") {
      finishPinchGesture();
    } else if (state?.pointerId === event.pointerId) {
      finishSinglePointGesture(event.clientX, event.clientY);
    }

    pointerPositionsRef.current.delete(event.pointerId);
    if (capturedPointerIdsRef.current.has(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      capturedPointerIdsRef.current.delete(event.pointerId);
    }
    if (pointerPositionsRef.current.size === 0) {
      gestureRef.current = null;
      window.setTimeout(() => {
        pointerSequenceRef.current = false;
      }, 350);
    }
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLElement>) => {
    const cancelledState = gestureRef.current;
    pointerPositionsRef.current.delete(event.pointerId);
    if (capturedPointerIdsRef.current.has(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      capturedPointerIdsRef.current.delete(event.pointerId);
    }
    if (cancelledState?.mode === "pinch" || cancelledState?.mode === "pan") {
      commitImageTransform(imageTransformRef.current.zoom, imageTransformRef.current.pan, true, cancelledState.metrics);
    }
    gestureRef.current = null;
    mouseGestureActiveRef.current = false;
    applyTrackOffset(0, true, cancelledState?.metrics);
    applyVerticalOffset(0, true, cancelledState?.metrics);
    window.setTimeout(() => {
      pointerSequenceRef.current = false;
    }, 350);
  };

  const videoGestureHandlers = {
    onPointerDown: (event: React.PointerEvent<HTMLVideoElement>) => {
      handlePointerDown(event);
      event.stopPropagation();
    },
    onPointerMove: (event: React.PointerEvent<HTMLVideoElement>) => {
      handlePointerMove(event);
      event.stopPropagation();
    },
    onPointerUp: (event: React.PointerEvent<HTMLVideoElement>) => {
      handlePointerUp(event);
      event.stopPropagation();
    },
    onPointerCancel: (event: React.PointerEvent<HTMLVideoElement>) => {
      handlePointerCancel(event);
      event.stopPropagation();
    },
  };

  const handleMouseDown = (event: React.MouseEvent<HTMLElement>) => {
    if (pointerSequenceRef.current || event.button !== 0) return;
    mouseGestureActiveRef.current = beginSinglePointGesture(event.clientX, event.clientY, null, event.target);
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLElement>) => {
    if (pointerSequenceRef.current || !mouseGestureActiveRef.current) return;
    updateSinglePointGesture(event.clientX, event.clientY);
  };

  const handleMouseUp = (event: React.MouseEvent<HTMLElement>) => {
    if (pointerSequenceRef.current || !mouseGestureActiveRef.current) return;
    finishSinglePointGesture(event.clientX, event.clientY);
  };

  const handleMouseLeave = (event: React.MouseEvent<HTMLElement>) => {
    if (pointerSequenceRef.current || !mouseGestureActiveRef.current) return;
    finishSinglePointGesture(event.clientX, event.clientY);
  };

  const handleDoubleClick = (event: React.MouseEvent<HTMLElement>) => {
    if (isInteractiveTarget(event.target) || isVideoTarget(event.target)) return;
    event.preventDefault();
    clearTapTimer();
    lastTapRef.current = null;
    handleDoubleTap(event.clientX, event.clientY);
  };

  const handleWheel = (event: React.WheelEvent<HTMLElement>) => {
    if (activeStageMedia.kind !== "image" || isInteractiveTarget(event.target)) {
      return;
    }

    event.preventDefault();
    const currentTransform = imageTransformRef.current;
    zoomAtPoint(
      event.clientX,
      event.clientY,
      currentTransform.zoom + (event.deltaY < 0 ? WHEEL_ZOOM_STEP : -WHEEL_ZOOM_STEP),
    );
  };

  const slideWidth = trackWidth || getCurrentTrackWidth();
  const trackTranslateX = -safeActiveIndex * slideWidth;

  return (
    <main
      ref={stageRef}
      data-testid={isHistoryPreview ? "history-media-stage" : "media-viewer-stage"}
      className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-0 py-20 will-change-[transform,opacity] sm:px-8 ${className}`}
      style={{ touchAction: "none", transformOrigin: "center center" }}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      onDoubleClick={handleDoubleClick}
    >
      <div
        ref={trackRef}
        data-testid="media-carousel-track"
        className="flex h-full w-full will-change-transform"
        style={{ transform: `translate3d(${trackTranslateX}px, 0, 0)` }}
      >
        {trackItems.map((item, index) => {
          const isActive = index === safeActiveIndex;
          return (
            <div
              key={getMediaKey(item)}
              data-active-media={isActive ? "true" : undefined}
              className="flex h-full min-w-full items-center justify-center px-1.5 sm:px-2"
              aria-hidden={!isActive}
            >
              <MediaStageItem
                item={item}
                alt={alt}
                isActive={isActive}
                imageZoom={isActive ? imageZoom : MIN_IMAGE_ZOOM}
                imagePan={isActive ? imagePan : ZERO_IMAGE_PAN}
                videoGestureHandlers={isActive ? videoGestureHandlers : undefined}
              />
            </div>
          );
        })}
      </div>

      {canGoPrevious && (
        <div className="pointer-events-none absolute left-3 top-1/2 hidden -translate-y-1/2 sm:block">
          <ViewerButton
            label={previousLabel}
            icon="lucide:chevron-left"
            onPress={onPrevious}
            className="pointer-events-auto h-12 w-12 bg-black/35"
          />
        </div>
      )}
      {canGoNext && (
        <div className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 sm:block">
          <ViewerButton
            label={nextLabel}
            icon="lucide:chevron-right"
            onPress={onNext}
            className="pointer-events-auto h-12 w-12 bg-black/35"
          />
        </div>
      )}
    </main>
  );
};

export const MediaViewerModal: React.FC<MediaViewerModalProps> = ({
  isOpen,
  src,
  kind,
  title,
  alt,
  roomId,
  assetId,
  mimeType,
  byteSize,
  createdAt,
  onClose,
}) => {
  const { t, i18n } = useTranslation();
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const statusResetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialHistoryRequestKeyRef = React.useRef<string | null>(null);
  const historyRequestSequenceRef = React.useRef(0);
  const [activeMedia, setActiveMedia] = React.useState<ActiveMedia | null>(null);
  const [downloadStatus, setDownloadStatus] = React.useState<"idle" | "done">("idle");
  const [shareStatus, setShareStatus] = React.useState<"idle" | "done" | "error">("idle");
  const [isHistoryOpen, setIsHistoryOpen] = React.useState(false);
  const [isHistoryPreviewOpen, setIsHistoryPreviewOpen] = React.useState(false);
  const [hasViewedHistoryItem, setHasViewedHistoryItem] = React.useState(false);
  const [historyItems, setHistoryItems] = React.useState<RoomMediaHistoryItem[]>([]);
  const [historyCursor, setHistoryCursor] = React.useState<string | null>(null);
  const [hasMoreHistory, setHasMoreHistory] = React.useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = React.useState(false);
  const [historyError, setHistoryError] = React.useState(false);
  const [historyFilter, setHistoryFilter] = React.useState<MediaHistoryFilter>("all");
  const [imageZoom, setImageZoom] = React.useState(MIN_IMAGE_ZOOM);
  const [imagePan, setImagePan] = React.useState<ImagePan>(ZERO_IMAGE_PAN);

  const resetImageZoom = React.useCallback(() => {
    setImageZoom(MIN_IMAGE_ZOOM);
    setImagePan(ZERO_IMAGE_PAN);
  }, []);

  const handleImageTransformChange = React.useCallback((nextZoom: number, nextPan: ImagePan) => {
    const clampedZoom = Math.max(MIN_IMAGE_ZOOM, Math.min(MAX_IMAGE_ZOOM, nextZoom));
    setImageZoom(clampedZoom);
    setImagePan(clampedZoom <= MIN_IMAGE_ZOOM ? ZERO_IMAGE_PAN : nextPan);
  }, []);

  const loadHistory = React.useCallback(async (
    mode: "reset" | "more",
    filterOverride?: MediaHistoryFilter,
    beforeOverride?: string | null,
  ) => {
    if (isHistoryLoading && mode === "more") return null;

    const requestSequence = historyRequestSequenceRef.current + 1;
    historyRequestSequenceRef.current = requestSequence;
    const nextFilter = filterOverride ?? historyFilter;
    setIsHistoryLoading(true);
    setHistoryError(false);
    try {
      const page = await getRoomMediaHistory({
        roomId,
        before: beforeOverride ?? (mode === "more" ? historyCursor : null),
        limit: HISTORY_PAGE_SIZE,
        ...(nextFilter === "all" ? {} : { kind: nextFilter }),
      });
      if (historyRequestSequenceRef.current !== requestSequence) {
        return null;
      }
      setHistoryCursor(page.nextCursor || null);
      setHasMoreHistory(page.hasMore);
      setHistoryItems(prev => {
        const next = mode === "reset" ? page.items : [...prev, ...page.items];
        const seen = new Set<string>();
        return next.filter(item => {
          if (seen.has(item.assetId)) return false;
          seen.add(item.assetId);
          return true;
        });
      });
      return page.items;
    } catch (error) {
      if (historyRequestSequenceRef.current !== requestSequence) {
        return null;
      }
      console.error("Failed to load media history:", error);
      setHistoryError(true);
      return null;
    } finally {
      if (historyRequestSequenceRef.current === requestSequence) {
        setIsHistoryLoading(false);
      }
    }
  }, [historyCursor, historyFilter, isHistoryLoading, roomId]);

  React.useEffect(() => {
    if (!src) {
      setActiveMedia(null);
      return;
    }

    setActiveMedia({
      assetId,
      src,
      kind,
      mimeType,
      byteSize,
      createdAt,
    });
  }, [assetId, byteSize, createdAt, isOpen, kind, mimeType, src]);

  React.useEffect(() => {
    initialHistoryRequestKeyRef.current = null;
    historyRequestSequenceRef.current += 1;
    setIsHistoryOpen(false);
    setIsHistoryPreviewOpen(false);
    setHasViewedHistoryItem(false);
    setHistoryItems([]);
    setHistoryCursor(null);
    setHasMoreHistory(false);
    setHistoryError(false);
    setHistoryFilter("all");
    setIsHistoryLoading(false);
  }, [roomId]);

  React.useEffect(() => {
    if (!isOpen) {
      setIsHistoryOpen(false);
      setIsHistoryPreviewOpen(false);
      resetImageZoom();
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("input,textarea,select")) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        if (isHistoryPreviewOpen) {
          setIsHistoryPreviewOpen(false);
          return;
        }
        if (isHistoryOpen) {
          if (hasViewedHistoryItem) {
            onClose();
          } else {
            setIsHistoryOpen(false);
          }
          return;
        }
        onClose();
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    requestAnimationFrame(() => {
      dialogRef.current?.focus();
    });

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [hasViewedHistoryItem, isHistoryOpen, isHistoryPreviewOpen, isOpen, onClose, resetImageZoom]);

  React.useEffect(() => {
    if (!isHistoryOpen) {
      setIsHistoryPreviewOpen(false);
    }
  }, [isHistoryOpen]);

  React.useEffect(() => {
    const requestKey = `${roomId}:${historyFilter}`;
    if (!isOpen || !activeMedia || initialHistoryRequestKeyRef.current === requestKey) {
      return;
    }

    initialHistoryRequestKeyRef.current = requestKey;
    void loadHistory("reset");
  }, [activeMedia, historyFilter, isOpen, loadHistory, roomId]);

  React.useEffect(() => {
    return () => {
      if (statusResetTimerRef.current) {
        clearTimeout(statusResetTimerRef.current);
      }
    };
  }, []);

  const carouselItems = React.useMemo(() => {
    const nextItems = historyItems.map(historyItemToActiveMedia);
    if (activeMedia && !nextItems.some(item => isSameMedia(item, activeMedia))) {
      nextItems.push(activeMedia);
    }

    const seen = new Set<string>();
    return nextItems
      .sort(compareMediaAscending)
      .filter(item => {
        const key = getMediaKey(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [activeMedia, historyItems]);

  const historyItemsOldestFirst = React.useMemo(() => (
    [...historyItems].sort(compareHistoryItemAscending)
  ), [historyItems]);

  const activeMediaIndex = React.useMemo(() => {
    if (!activeMedia) return -1;
    return carouselItems.findIndex(item => isSameMedia(item, activeMedia));
  }, [activeMedia, carouselItems]);

  const activeMediaKey = activeMedia ? getMediaKey(activeMedia) : "";

  React.useEffect(() => {
    resetImageZoom();
  }, [activeMediaKey, resetImageZoom]);

  const goToMedia = React.useCallback(async (offset: -1 | 1) => {
    if (!activeMedia) return;

    const currentIndex = carouselItems.findIndex(item => isSameMedia(item, activeMedia));
    if (currentIndex < 0) return;

    const nextMedia = carouselItems[currentIndex + offset];
    if (nextMedia) {
      setActiveMedia(nextMedia);
      return;
    }

    if (offset < 0 && hasMoreHistory && !isHistoryLoading) {
      const loadedItems = await loadHistory("more");
      const firstLoadedItem = loadedItems?.[0];
      if (firstLoadedItem) {
        setActiveMedia(historyItemToActiveMedia(firstLoadedItem));
      }
    }
  }, [activeMedia, carouselItems, hasMoreHistory, isHistoryLoading, loadHistory]);

  const handlePreviousMedia = React.useCallback(() => {
    void goToMedia(-1);
  }, [goToMedia]);

  const handleNextMedia = React.useCallback(() => {
    void goToMedia(1);
  }, [goToMedia]);

  React.useEffect(() => {
    if (!isOpen) return;

    const handleArrowKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("input,textarea,select")) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        handlePreviousMedia();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        handleNextMedia();
      }
    };

    window.addEventListener("keydown", handleArrowKey);
    return () => window.removeEventListener("keydown", handleArrowKey);
  }, [handleNextMedia, handlePreviousMedia, isOpen]);

  const showTemporaryStatus = (type: "download" | "share", value: "done" | "error") => {
    if (type === "download") {
      setDownloadStatus("done");
    } else {
      setShareStatus(value === "done" ? "done" : "error");
    }

    if (statusResetTimerRef.current) {
      clearTimeout(statusResetTimerRef.current);
    }
    statusResetTimerRef.current = setTimeout(() => {
      setDownloadStatus("idle");
      setShareStatus("idle");
      statusResetTimerRef.current = null;
    }, 1500);
  };

  const handleOpenHistory = () => {
    setIsHistoryOpen(true);
    setHasViewedHistoryItem(false);
    if ((historyItems.length === 0 || historyError) && !isHistoryLoading) {
      void loadHistory("reset");
    }
  };

  const handleHistoryFilterChange = (nextFilter: MediaHistoryFilter) => {
    if (nextFilter === historyFilter) return;
    setHistoryFilter(nextFilter);
    setHistoryItems([]);
    setHistoryCursor(null);
    setHasMoreHistory(false);
    setHistoryError(false);
    setIsHistoryPreviewOpen(false);
    initialHistoryRequestKeyRef.current = `${roomId}:${nextFilter}`;
    if (isHistoryOpen) {
      void loadHistory("reset", nextFilter, null);
    }
  };

  const handleSelectHistoryItem = (item: RoomMediaHistoryItem) => {
    setActiveMedia(historyItemToActiveMedia(item));
    setIsHistoryPreviewOpen(true);
    setHasViewedHistoryItem(true);
  };

  const handleDownload = async () => {
    if (!activeMedia) return;
    const fileName = getMediaFileName(activeMedia);
    const cachedBlob = await getCachedMediaBlob(activeMedia.assetId);
    if (cachedBlob) {
      downloadMediaBlob(cachedBlob, fileName);
    } else {
      await downloadMediaUrl(activeMedia.src, fileName);
    }
    showTemporaryStatus("download", "done");
  };

  const handleShare = async () => {
    if (!activeMedia) return;

    const navigatorWithShare = navigator as NavigatorWithMediaShare;
    const shareTitle = activeMedia.kind === "video" ? t("videoMessage") : t("sharedImage");

    try {
      const cachedBlob = await getCachedMediaBlob(activeMedia.assetId);
      if (cachedBlob && typeof File !== "undefined") {
        const file = new File([cachedBlob], getMediaFileName(activeMedia), {
          type: cachedBlob.type || activeMedia.mimeType || "application/octet-stream",
        });
        if (
          typeof navigatorWithShare.share === "function"
          && typeof navigatorWithShare.canShare === "function"
          && navigatorWithShare.canShare({ files: [file] })
        ) {
          await navigatorWithShare.share({
            title: shareTitle,
            text: shareTitle,
            files: [file],
          });
          showTemporaryStatus("share", "done");
          return;
        }
      }

      if (typeof navigatorWithShare.share === "function") {
        await navigatorWithShare.share({
          title: shareTitle,
          text: shareTitle,
          url: activeMedia.src,
        });
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(activeMedia.src);
      } else {
        throw new Error("Web Share and Clipboard APIs are unavailable");
      }
      showTemporaryStatus("share", "done");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      console.error("Failed to share media:", error);
      showTemporaryStatus("share", "error");
    }
  };

  const handleBackdropMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  if (!isOpen || !activeMedia || typeof document === "undefined") {
    return null;
  }

  const downloadIcon = downloadStatus === "done" ? "lucide:check" : "lucide:download";
  const shareIcon = shareStatus === "done"
    ? "lucide:check"
    : shareStatus === "error"
      ? "lucide:alert-circle"
      : "lucide:share-2";
  const historyGroups = groupHistoryByMonth(historyItemsOldestFirst, i18n.language);
  const canGoPrevious = activeMediaIndex > 0 || hasMoreHistory;
  const canGoNext = activeMediaIndex >= 0 && activeMediaIndex < carouselItems.length - 1;
  const activePosition = activeMediaIndex >= 0 ? `${activeMediaIndex + 1} / ${Math.max(carouselItems.length, activeMediaIndex + 1)}` : "";
  const renderActionToolbar = (centerAction: { label: string; icon: string; onPress: () => void }) => (
    <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-white/10 bg-white/10 px-3 py-2 shadow-2xl backdrop-blur-xl">
      <ViewerButton label={t("downloadMedia")} icon={downloadIcon} onPress={() => { void handleDownload(); }} />
      <ViewerButton label={centerAction.label} icon={centerAction.icon} onPress={centerAction.onPress} />
      <ViewerButton label={t("shareMedia")} icon={shareIcon} onPress={() => { void handleShare(); }} />
    </div>
  );

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      className="fixed inset-0 z-[1000] flex h-[var(--app-height,100dvh)] w-screen flex-col overflow-hidden bg-[#080807] text-white outline-none"
      onMouseDown={handleBackdropMouseDown}
    >
      <header
        className="safe-top pointer-events-none absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-black/80 to-transparent px-3 pb-8"
        style={{
          opacity: "var(--media-viewer-chrome-opacity, 1)",
          transition: "var(--media-viewer-chrome-transition, none)",
        }}
      >
        <div className="pointer-events-auto flex h-14 items-center gap-2">
          <ViewerButton label={t("close")} icon="lucide:x" onPress={onClose} className="bg-white/10" />
          <div className="min-w-0 flex-1 text-center text-sm font-semibold text-white/95 sm:text-base">
            <span className="block truncate">{title}</span>
          </div>
          <div className="h-11 w-11" aria-hidden="true" />
        </div>
      </header>

      <MediaStage
        media={activeMedia}
        mediaItems={carouselItems}
        activeIndex={activeMediaIndex}
        alt={alt}
        variant="viewer"
        visualRootRef={dialogRef}
        canGoPrevious={canGoPrevious}
        canGoNext={canGoNext}
        previousLabel={t("previousMedia")}
        nextLabel={t("nextMedia")}
        onPrevious={handlePreviousMedia}
        onNext={handleNextMedia}
        onDismiss={onClose}
        imageZoom={imageZoom}
        imagePan={imagePan}
        onImageTransformChange={handleImageTransformChange}
      />

      <footer
        className="safe-bottom pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-2 bg-gradient-to-t from-black/80 to-transparent px-4 pt-8"
        style={{
          opacity: "var(--media-viewer-chrome-opacity, 1)",
          transition: "var(--media-viewer-chrome-transition, none)",
        }}
      >
        <div className="mb-3">
          {renderActionToolbar({ label: t("openMediaHistory"), icon: "lucide:grid-3x3", onPress: handleOpenHistory })}
        </div>
      </footer>

      <span className="sr-only" aria-live="polite">{activePosition}</span>

      {isHistoryOpen && (
        <section
          aria-label={t("mediaHistory")}
          className="safe-top safe-bottom absolute inset-0 z-40 flex flex-col bg-[#111110] text-white"
        >
          {isHistoryPreviewOpen ? (
            <>
              <header
                className="pointer-events-none absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-black/80 to-transparent px-3 pb-8"
                style={{
                  opacity: "var(--media-viewer-chrome-opacity, 1)",
                  transition: "var(--media-viewer-chrome-transition, none)",
                }}
              >
                <div className="pointer-events-auto flex h-14 items-center gap-2">
                  <ViewerButton label={t("backToMediaHistory")} icon="lucide:chevron-left" onPress={() => setIsHistoryPreviewOpen(false)} className="h-10 w-10 bg-white/10" />
                  <div className="min-w-0 flex-1 text-center text-sm font-semibold text-white/95">
                    <span className="block truncate">{t("mediaHistory")}</span>
                  </div>
                  <div className="h-10 w-10 text-right text-xs text-white/60" aria-hidden="true">{activePosition}</div>
                </div>
              </header>
              <MediaStage
                media={activeMedia}
                mediaItems={carouselItems}
                activeIndex={activeMediaIndex}
                alt={alt}
                variant="historyPreview"
                visualRootRef={dialogRef}
                canGoPrevious={canGoPrevious}
                canGoNext={canGoNext}
                previousLabel={t("previousMedia")}
                nextLabel={t("nextMedia")}
                onPrevious={handlePreviousMedia}
                onNext={handleNextMedia}
                onDismiss={() => setIsHistoryPreviewOpen(false)}
                imageZoom={imageZoom}
                imagePan={imagePan}
                onImageTransformChange={handleImageTransformChange}
              />
              <footer
                className="safe-bottom pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-2 bg-gradient-to-t from-black/80 to-transparent px-4 pt-8"
                style={{
                  opacity: "var(--media-viewer-chrome-opacity, 1)",
                  transition: "var(--media-viewer-chrome-transition, none)",
                }}
              >
                <div className="mb-3">
                  {renderActionToolbar({ label: t("backToMediaHistory"), icon: "lucide:grid-3x3", onPress: () => setIsHistoryPreviewOpen(false) })}
                </div>
              </footer>
            </>
          ) : (
            <>
              <header className="flex h-16 flex-shrink-0 items-center gap-2 border-b border-white/10 px-3">
                {hasViewedHistoryItem ? (
                  <ViewerButton label={t("close")} icon="lucide:x" onPress={onClose} className="h-10 w-10" />
                ) : (
                  <ViewerButton label={t("closeMediaHistory")} icon="lucide:chevron-left" onPress={() => setIsHistoryOpen(false)} className="h-10 w-10" />
                )}
                <div className="min-w-0 flex-1">
                  <Dropdown placement="bottom-start">
                    <DropdownTrigger>
                      <Button
                        variant="light"
                        className="-ml-2 h-auto min-w-0 justify-start gap-1 rounded-lg px-2 py-1 text-left text-white hover:bg-white/10"
                        aria-label={`${t("mediaHistory")} ${t(getMediaHistoryFilterLabelKey(historyFilter))}`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-base font-semibold leading-tight">{t("mediaHistory")}</span>
                          <span className="block truncate text-xs font-normal text-white/55">
                            {t("mediaHistoryRecentMonths")} · {t(getMediaHistoryFilterLabelKey(historyFilter))}
                          </span>
                        </span>
                        <Icon icon="lucide:chevron-down" className="h-4 w-4 flex-shrink-0 text-white/65" />
                      </Button>
                    </DropdownTrigger>
                    <DropdownMenu
                      aria-label={t("mediaHistory")}
                      selectedKeys={[historyFilter]}
                      selectionMode="single"
                      onAction={(key) => handleHistoryFilterChange(key as MediaHistoryFilter)}
                    >
                      {MEDIA_HISTORY_FILTERS.map(filter => (
                        <DropdownItem key={filter}>
                          {t(getMediaHistoryFilterLabelKey(filter))}
                        </DropdownItem>
                      ))}
                    </DropdownMenu>
                  </Dropdown>
                </div>
              </header>

              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-5 pt-4">
                {(hasMoreHistory || isHistoryLoading) && (
                  <div className="flex justify-center pb-4">
                    <Button
                      size="sm"
                      className="rounded-full bg-white/10 px-4 text-white hover:bg-white/20"
                      isLoading={isHistoryLoading}
                      onPress={() => { void loadHistory(historyItems.length === 0 ? "reset" : "more"); }}
                    >
                      {isHistoryLoading ? t("loadingMore") : t("loadMoreMedia")}
                    </Button>
                  </div>
                )}

                {historyGroups.map(group => (
                  <section key={group.key} className="mb-6">
                    <h3 className="mb-3 text-sm font-semibold text-white/90">{group.label}</h3>
                    <div className="grid grid-cols-4 gap-1 sm:grid-cols-6 md:grid-cols-8">
                      {group.items.map(item => (
                        <MediaHistoryGridItem
                          key={item.assetId}
                          item={item}
                          isActive={item.assetId === activeMedia.assetId}
                          sharedImageLabel={t("sharedImage")}
                          openMediaLabel={t("openMediaItem")}
                          onSelect={handleSelectHistoryItem}
                        />
                      ))}
                    </div>
                  </section>
                ))}

                {!isHistoryLoading && historyItems.length === 0 && !historyError && (
                  <div className="flex min-h-[220px] flex-col items-center justify-center text-center text-white/60">
                    <Icon icon="lucide:images" className="mb-3 h-8 w-8" />
                    <p className="text-sm font-medium">{t("noMediaHistory")}</p>
                  </div>
                )}

                {historyError && (
                  <div className="flex min-h-[180px] flex-col items-center justify-center text-center text-white/70">
                    <Icon icon="lucide:alert-circle" className="mb-3 h-8 w-8 text-[#d97757]" />
                    <p className="text-sm font-medium">{t("mediaHistoryLoadFailed")}</p>
                  </div>
                )}

              </div>
            </>
          )}
        </section>
      )}
    </div>,
    document.body
  );
};
