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
}

type ActiveMedia = {
  assetId?: string;
  src: string;
  kind: ViewerMediaKind;
  mimeType?: string;
  byteSize?: number;
  createdAt?: string;
};

interface MediaStageProps {
  media: ActiveMedia;
  mediaItems: ActiveMedia[];
  activeIndex: number;
  alt: string;
  variant: MediaStageVariant;
  canGoPrevious: boolean;
  canGoNext: boolean;
  previousLabel: string;
  nextLabel: string;
  onPrevious: () => void;
  onNext: () => void;
  onSwipeDown?: () => void;
  onTapMedia?: () => void;
  className?: string;
}

interface MediaStageItemProps {
  item: ActiveMedia;
  alt: string;
  isActive: boolean;
  onTapImage?: () => void;
}

interface MediaHistoryGridItemProps {
  item: RoomMediaHistoryItem;
  isActive: boolean;
  sharedImageLabel: string;
  openMediaLabel: string;
  onSelect: (item: RoomMediaHistoryItem) => void;
}

const HISTORY_PAGE_SIZE = 36;
const SWIPE_THRESHOLD = 48;
const SWIPE_DOWN_THRESHOLD = 64;
const TAP_THRESHOLD = 8;
const MEDIA_HISTORY_FILTERS: MediaHistoryFilter[] = ["all", "image", "video"];

const getMediaHistoryFilterLabelKey = (filter: MediaHistoryFilter) => (
  filter === "all"
    ? "mediaHistoryFilterAll"
    : filter === "image"
      ? "mediaHistoryFilterImages"
      : "mediaHistoryFilterVideos"
);

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

const ViewerButton: React.FC<ViewerButtonProps> = ({ label, icon, onPress, className = "" }) => (
  <Button
    isIconOnly
    aria-label={label}
    title={label}
    className={`h-11 w-11 min-w-0 rounded-full bg-white/10 text-white shadow-lg backdrop-blur-md transition hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/80 ${className}`}
    onPress={onPress}
  >
    <Icon icon={icon} className="h-5 w-5" />
  </Button>
);

const MediaStageItem: React.FC<MediaStageItemProps> = ({ item, alt, isActive, onTapImage }) => {
  const { mediaUrl, posterUrl } = useCachedMedia({
    assetId: item.assetId,
    url: item.src,
    kind: item.kind,
    mimeType: item.mimeType,
    byteSize: item.byteSize,
  });
  const displayUrl = mediaUrl || item.src;

  if (item.kind === "image") {
    return (
      <img
        src={displayUrl}
        alt={alt}
        className={`max-h-full max-w-full select-none object-contain ${onTapImage && isActive ? "cursor-zoom-out" : ""}`}
        draggable={false}
        onClick={isActive ? onTapImage : undefined}
      />
    );
  }

  return (
    <video
      key={displayUrl}
      src={getVideoPreviewUrl(displayUrl)}
      poster={posterUrl || undefined}
      className="max-h-full w-full max-w-5xl bg-black object-contain sm:rounded-lg"
      controls={isActive}
      autoPlay={isActive}
      playsInline
      preload="metadata"
      muted={!isActive}
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
  const { mediaUrl, posterUrl } = useCachedMedia({
    assetId: item.assetId,
    url: item.url,
    kind: item.kind,
    mimeType: item.mimeType,
    byteSize: item.byteSize,
  });
  const displayUrl = mediaUrl || item.url;

  return (
    <button
      type="button"
      aria-label={openMediaLabel}
      className={`relative aspect-square cursor-pointer overflow-hidden bg-black/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 ${isActive ? "ring-2 ring-[#d97757]" : ""}`}
      onClick={() => onSelect(item)}
    >
      {item.kind === "image" ? (
        <img src={displayUrl} alt={sharedImageLabel} className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <>
          <video
            src={getVideoPreviewUrl(displayUrl)}
            poster={posterUrl || undefined}
            className="h-full w-full object-cover"
            preload="metadata"
            muted
            playsInline
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
  canGoPrevious,
  canGoNext,
  previousLabel,
  nextLabel,
  onPrevious,
  onNext,
  onSwipeDown,
  onTapMedia,
  className = "",
}) => {
  const pointerStartRef = React.useRef<{ x: number; y: number } | null>(null);
  const activePointerIdRef = React.useRef<number | null>(null);
  const pointerSequenceRef = React.useRef(false);
  const suppressClickRef = React.useRef(false);
  const stageRef = React.useRef<HTMLElement | null>(null);
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const [trackWidth, setTrackWidth] = React.useState(0);
  const [dragOffset, setDragOffset] = React.useState(0);
  const [isDragging, setIsDragging] = React.useState(false);
  const isHistoryPreview = variant === "historyPreview";
  const trackItems = mediaItems.length > 0 ? mediaItems : [media];
  const safeActiveIndex = activeIndex >= 0 && activeIndex < trackItems.length ? activeIndex : 0;
  const activeStageMedia = trackItems[safeActiveIndex] || media;

  const isInteractiveTarget = (target: EventTarget) => (
    target instanceof Element && Boolean(target.closest("button,a,input,textarea,select,[role='button']"))
  );

  const getCurrentTrackWidth = () => (
    trackRef.current?.clientWidth ||
    stageRef.current?.clientWidth ||
    (typeof window !== "undefined" ? window.innerWidth : 1) ||
    1
  );

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
  }, []);

  const getBoundaryResistedOffset = (offset: number) => {
    const isPastPreviousEdge = offset > 0 && !canGoPrevious;
    const isPastNextEdge = offset < 0 && !canGoNext;
    if (!isPastPreviousEdge && !isPastNextEdge) {
      return offset;
    }

    const width = getCurrentTrackWidth();
    const distance = Math.abs(offset);
    const resisted = width * (1 - (1 / ((distance / width) * 0.55 + 1)));
    return Math.sign(offset) * Math.min(resisted, width * 0.45);
  };

  const beginGesture = (x: number, y: number, target: EventTarget) => {
    if (isInteractiveTarget(target)) {
      pointerStartRef.current = null;
      return false;
    }

    suppressClickRef.current = false;
    pointerStartRef.current = { x, y };
    setTrackWidth(getCurrentTrackWidth());
    setIsDragging(true);
    setDragOffset(0);
    return true;
  };

  const updateGesture = (x: number, y: number) => {
    const start = pointerStartRef.current;
    if (!start) return;

    const deltaX = x - start.x;
    const deltaY = y - start.y;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);
    if (absX <= TAP_THRESHOLD && absY <= TAP_THRESHOLD) {
      setDragOffset(0);
      return;
    }

    if (absY > absX * 1.25) {
      setDragOffset(0);
      return;
    }

    setDragOffset(getBoundaryResistedOffset(deltaX));
  };

  const finishGesture = (x: number, y: number) => {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    setIsDragging(false);
    setDragOffset(0);
    if (!start) return;

    const deltaX = x - start.x;
    const deltaY = y - start.y;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);
    const swipeThreshold = Math.min(96, Math.max(SWIPE_THRESHOLD, getCurrentTrackWidth() * 0.18));

    if (absX > swipeThreshold && absX > absY * 1.2) {
      suppressClickRef.current = true;
      if (deltaX < 0 && canGoNext) {
        onNext();
      } else if (deltaX > 0 && canGoPrevious) {
        onPrevious();
      }
      return;
    }

    if (onSwipeDown && deltaY > SWIPE_DOWN_THRESHOLD && absY > absX * 1.15) {
      suppressClickRef.current = true;
      onSwipeDown();
      return;
    }

    if (onTapMedia && media.kind === "image" && absX <= TAP_THRESHOLD && absY <= TAP_THRESHOLD) {
      suppressClickRef.current = true;
      onTapMedia();
    }
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    const target = event.target;
    if (event.pointerType && event.isPrimary === false) {
      return;
    }

    pointerSequenceRef.current = true;
    if (beginGesture(event.clientX, event.clientY, target)) {
      activePointerIdRef.current = event.pointerId;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    updateGesture(event.clientX, event.clientY);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLElement>) => {
    finishGesture(event.clientX, event.clientY);
    if (activePointerIdRef.current !== null) {
      event.currentTarget.releasePointerCapture?.(activePointerIdRef.current);
      activePointerIdRef.current = null;
    }
    window.setTimeout(() => {
      pointerSequenceRef.current = false;
    }, 350);
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLElement>) => {
    pointerStartRef.current = null;
    if (activePointerIdRef.current !== null) {
      event.currentTarget.releasePointerCapture?.(activePointerIdRef.current);
      activePointerIdRef.current = null;
    }
    setIsDragging(false);
    setDragOffset(0);
    window.setTimeout(() => {
      pointerSequenceRef.current = false;
    }, 350);
  };

  const handleMouseDown = (event: React.MouseEvent<HTMLElement>) => {
    if (pointerSequenceRef.current) return;
    beginGesture(event.clientX, event.clientY, event.target);
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLElement>) => {
    if (pointerSequenceRef.current) return;
    updateGesture(event.clientX, event.clientY);
  };

  const handleMouseUp = (event: React.MouseEvent<HTMLElement>) => {
    if (pointerSequenceRef.current) {
      pointerSequenceRef.current = false;
      return;
    }
    finishGesture(event.clientX, event.clientY);
  };

  const handleImageClick = () => {
    if (!onTapMedia) return;
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onTapMedia();
  };

  const slideWidth = isDragging ? getCurrentTrackWidth() : (trackWidth || getCurrentTrackWidth());
  const trackTranslateX = (-safeActiveIndex * slideWidth) + dragOffset;

  return (
    <main
      ref={stageRef}
      data-testid={isHistoryPreview ? "history-media-stage" : "media-viewer-stage"}
      className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-0 py-20 sm:px-8 ${className}`}
      style={{ touchAction: activeStageMedia.kind === "image" ? "none" : "pan-y" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      <div
        ref={trackRef}
        data-testid="media-carousel-track"
        className={`flex h-full w-full will-change-transform ${isDragging ? "" : "transition-transform duration-300 ease-out"}`}
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
                onTapImage={onTapMedia ? handleImageClick : undefined}
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
  }, [assetId, byteSize, createdAt, kind, mimeType, src]);

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
  }, [hasViewedHistoryItem, isHistoryOpen, isHistoryPreviewOpen, isOpen, onClose]);

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
      <header className="safe-top pointer-events-none absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-black/80 to-transparent px-3 pb-8">
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
        canGoPrevious={canGoPrevious}
        canGoNext={canGoNext}
        previousLabel={t("previousMedia")}
        nextLabel={t("nextMedia")}
        onPrevious={handlePreviousMedia}
        onNext={handleNextMedia}
      />

      <footer className="safe-bottom pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center bg-gradient-to-t from-black/80 to-transparent px-4 pt-8">
        <div className="pointer-events-auto mb-3 flex items-center gap-3 rounded-full border border-white/10 bg-white/10 px-3 py-2 shadow-2xl backdrop-blur-xl">
          <ViewerButton label={t("downloadMedia")} icon={downloadIcon} onPress={() => { void handleDownload(); }} />
          <ViewerButton label={t("openMediaHistory")} icon="lucide:grid-3x3" onPress={handleOpenHistory} />
          <ViewerButton label={t("shareMedia")} icon={shareIcon} onPress={() => { void handleShare(); }} />
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
              <header className="pointer-events-none absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-black/80 to-transparent px-3 pb-8">
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
                canGoPrevious={canGoPrevious}
                canGoNext={canGoNext}
                previousLabel={t("previousMedia")}
                nextLabel={t("nextMedia")}
                onPrevious={handlePreviousMedia}
                onNext={handleNextMedia}
                onSwipeDown={() => setIsHistoryPreviewOpen(false)}
                onTapMedia={() => setIsHistoryPreviewOpen(false)}
              />
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
