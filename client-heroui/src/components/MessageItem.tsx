import React, { useState } from "react";
import {
  Avatar,
  Card,
  Button,
  Tooltip,
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
} from "@heroui/react";
import { Icon } from "@iconify/react";
import { clientId, getAudioTranscription, getMediaDownloadUrl, requestAudioTranscription, sendA2UIAction } from "../utils/socket";
import { formatPercentage, formatTime, formatUsdCost } from "../utils/formatters";
import { A2UIActionEvent, AudioTranscription, Message, MessageMediaAsset, RoomPermissions } from "../utils/types";
import { useTranslation } from "react-i18next";
import { useIsTouchDevice } from "../hooks/useIsTouchDevice";
import { useCachedMedia } from "../hooks/useCachedMedia";
import { useStickerUrl, useStickerName } from "../hooks/useStickers";
import { MediaViewerModal } from "./MediaViewerModal";
import { getVideoPreviewUrl } from "../utils/videoPreview";
import { buildMediaFilename, saveUrlAsFile } from "../utils/mediaDownload";
import { A2UIRenderer } from "./A2UIRenderer";
import { getRoomAIRequestSettings } from "../utils/aiRequestSettings";

interface MessageItemProps {
  message: Message;
  roomPermissions: RoomPermissions | null;
  onStartEdit: (messageId: string) => void;
  onDeleteMessage: (messageId: string) => void;
  onRefreshAI?: (messageId: string, content: string) => void;
  onReply: (message: Message) => void;
}

type ReplyReferenceValue = NonNullable<Message['replyTo']>;
type Translate = (key: string, values?: { name?: string }) => string;

const tooltipClassNames = {
  content: "border border-[#dedbd0] bg-[#faf9f5] px-2 py-1 text-xs font-medium text-[#141413] shadow-lg dark:border-[#30302e] dark:bg-[#1d1d1b] dark:text-[#faf9f5]",
};

const formatByteSize = (byteSize?: number, language?: string) => {
  if (typeof byteSize !== 'number' || !Number.isFinite(byteSize) || byteSize <= 0) {
    return '';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = byteSize;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${new Intl.NumberFormat(language || 'en', {
    maximumFractionDigits: value < 10 && unitIndex > 0 ? 1 : 0,
  }).format(value)} ${units[unitIndex]}`;
};

const importMarkdownContent = () => import("./MarkdownContent");

const MarkdownContent = React.lazy(() =>
  importMarkdownContent().then(module => ({ default: module.MarkdownContent }))
);

// Eagerly warm the lazily-loaded markdown chunk so the first rendered message
// doesn't flash plain text before upgrading to rendered markdown.
export const preloadMarkdownContent = () => {
  void importMarkdownContent();
};

// Helper to copy image to clipboard
async function copyImageToClipboard(imageSource: string): Promise<boolean> {
  if (!imageSource.startsWith('data:image') && !imageSource.startsWith('http') && !imageSource.startsWith('/')) {
    console.error("Invalid image data for clipboard");
    return false;
  }
  try {
    const response = await fetch(imageSource);
    const blob = await response.blob();
    // ClipboardItem requires a secure context (HTTPS or localhost)
    if (typeof ClipboardItem === "undefined") {
        console.warn("ClipboardItem API is not available in this context (non-secure?). Falling back to text copy.");
        // Fallback: copy the signed image URL as text.
        await navigator.clipboard.writeText(imageSource);
        return true; // Indicate success for text copy
    }
    const item = new ClipboardItem({ [blob.type]: blob });
    await navigator.clipboard.write([item]);
    console.log("Image copied to clipboard");
    return true;
  } catch (error) {
    console.error("Failed to copy image:", error);
    return false;
  }
}

const getReplyMediaLabel = (replyTo: ReplyReferenceValue, t: Translate) => {
  if (replyTo.messageType === "sticker") {
    return t("sticker");
  }
  if (replyTo.messageType !== "media") {
    return replyTo.preview;
  }

  const mediaKind = replyTo.mediaAsset?.kind || replyTo.mediaKind;
  if (mediaKind === "audio") return t("voiceMessage");
  if (mediaKind === "video") return t("videoMessage");
  if (mediaKind === "file") return t("fileAttachment");
  return t("sharedImage");
};

const getPlayableMediaKind = (mediaAsset?: MessageMediaAsset) => {
  if (!mediaAsset) {
    return undefined;
  }
  return mediaAsset.kind === "image" || mediaAsset.kind === "audio" || mediaAsset.kind === "video"
    ? mediaAsset.kind
    : undefined;
};

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

const ReplyReference: React.FC<{
  replyTo: ReplyReferenceValue;
  roomId: string;
}> = ({ replyTo, roomId }) => {
  const { t } = useTranslation();
  const [signedUrl, setSignedUrl] = React.useState<string | null>(null);
  const [mediaError, setMediaError] = React.useState(false);
  const mediaAsset = replyTo.mediaAsset;
  const playableMediaKind = getPlayableMediaKind(mediaAsset);
  const canRenderMedia = replyTo.messageType === "media" && Boolean(mediaAsset?.id && playableMediaKind);
  const replySenderName = replyTo.username
    || (replyTo.messageType === "ai" ? t("aiAssistantName") : t("participant"));
  const fallbackPreview = getReplyMediaLabel(replyTo, t);
  const { cacheBodyFetchKey, markMediaLoadedForCache } = useDeferredMediaCacheFetchKey(signedUrl);
  const { mediaUrl: displayMediaUrl, posterUrl } = useCachedMedia({
    assetId: mediaAsset?.id,
    url: signedUrl,
    kind: playableMediaKind,
    mimeType: mediaAsset?.mimeType,
    byteSize: mediaAsset?.byteSize,
    cacheBodyFetchKey,
  });

  React.useEffect(() => {
    if (!canRenderMedia || !mediaAsset?.id) {
      setSignedUrl(null);
      setMediaError(false);
      return () => {};
    }

    let cancelled = false;
    setSignedUrl(null);
    setMediaError(false);

    getMediaDownloadUrl({ roomId, assetId: mediaAsset.id })
      .then(({ url }) => {
        if (!cancelled) {
          setSignedUrl(url);
        }
      })
      .catch((error) => {
        console.error("Failed to get quoted media URL:", error);
        if (!cancelled) {
          setMediaError(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [canRenderMedia, mediaAsset?.id, roomId]);

  let content: React.ReactNode = <div className="truncate">{fallbackPreview}</div>;
  if (canRenderMedia && displayMediaUrl && !mediaError) {
    if (playableMediaKind === "image") {
      content = (
        <img
          src={displayMediaUrl}
          alt={t("sharedImage")}
          crossOrigin="anonymous"
          className="mt-1 block max-h-32 max-w-full rounded-md bg-black/5 object-contain dark:bg-white/5"
          onLoad={markMediaLoadedForCache}
          onError={() => setMediaError(true)}
        />
      );
    } else if (playableMediaKind === "video") {
      content = (
        <video
          controls
          src={displayMediaUrl}
          poster={posterUrl || undefined}
          crossOrigin="anonymous"
          className="mt-1 block max-h-44 max-w-full rounded-md bg-black"
          preload="metadata"
          playsInline
          onLoadedData={markMediaLoadedForCache}
          onError={() => setMediaError(true)}
        />
      );
    } else if (playableMediaKind === "audio") {
      content = (
        <audio
          controls
          src={displayMediaUrl}
          crossOrigin="anonymous"
          className="roomtalk-audio-player mt-1 block h-8 min-w-[160px] max-w-full"
          onCanPlay={markMediaLoadedForCache}
          onError={() => setMediaError(true)}
        />
      );
    }
  }

  return (
    <div className="mb-2 max-w-full overflow-hidden border-l-2 border-[#c96442] pl-2 text-xs text-[#5e5d59] dark:text-[#b0aea5]">
      <div className="truncate font-medium">{t("replyingTo", { name: replySenderName })}</div>
      {content}
    </div>
  );
};

const MessageItemComponent: React.FC<MessageItemProps> = ({
  message,
  roomPermissions,
  onStartEdit,
  onDeleteMessage,
  onRefreshAI,
  onReply,
}) => {
  const isMine = message.clientId === clientId;
  const isTouchDevice = useIsTouchDevice();
  const [mediaError, setMediaError] = React.useState(false);
  const [videoPreviewError, setVideoPreviewError] = React.useState(false);
  const [signedMediaUrl, setSignedMediaUrl] = React.useState<string | null>(null);
  const [isMediaViewerOpen, setIsMediaViewerOpen] = React.useState(false);
  const [audioTranscription, setAudioTranscription] = React.useState<AudioTranscription | null>(null);
  const [isAudioTranscriptionLoading, setIsAudioTranscriptionLoading] = React.useState(false);
  const [isAudioTranscriptHidden, setIsAudioTranscriptHidden] = React.useState(false);
  const mediaRetryCountRef = React.useRef(0);
  const isMedia = message.messageType === "media";
  const mediaKind = message.mediaAsset?.kind;
  const isImage = isMedia && mediaKind === "image";
  const isAudio = isMedia && mediaKind === "audio";
  const isVideo = isMedia && mediaKind === "video";
  const isFile = isMedia && mediaKind === "file";
  const isSticker = message.messageType === "sticker";
  const stickerUrl = useStickerUrl(isSticker ? message.content : undefined);
  const stickerName = useStickerName(isSticker ? message.content : undefined);
  const isText = message.messageType === "text";
  const isAI = message.clientId === 'ai_assistant';
  const isStreaming = isAI && message.status === 'streaming';
  const isPending = message.deliveryStatus === 'pending';
  const isFailed = message.deliveryStatus === 'failed';
  const canBeEdited = isText || (message.messageType === 'ai' && message.status !== 'streaming');
  const canEditMessage = canBeEdited && (isMine || Boolean(roomPermissions?.canEditAnyMessage));
  const canDeleteMessage = isMine || Boolean(roomPermissions?.canDeleteAnyMessage);
  const { t, i18n } = useTranslation();
  const aiMetadataParts = isAI
    ? [
        message.aiModel?.label,
        message.cost ? formatUsdCost(message.cost.totalUsd) : null,
        message.cost?.estimated ? t('estimatedCost') : null,
        typeof message.usage?.cacheHitRate === 'number'
          ? `${t('cacheHitRate')} ${formatPercentage(message.usage.cacheHitRate)}`
          : null,
      ].filter(Boolean)
    : [];
  const aiCostLabel = aiMetadataParts.join(' · ');
  const replyReference = message.replyTo ? (
    <ReplyReference replyTo={message.replyTo} roomId={message.roomId} />
  ) : null;
  const handleA2UIAction = React.useCallback((action: A2UIActionEvent) => {
    sendA2UIAction({
      roomId: message.roomId,
      messageId: message.id,
      action,
      ...getRoomAIRequestSettings(message.roomId),
    }).catch((error) => {
      console.error("Failed to send A2UI action:", error);
    });
  }, [message.id, message.roomId]);

  const [copyStatus, setCopyStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [liked, setLiked] = useState(false);
  const [disliked, setDisliked] = useState(false);
  const copyResetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  React.useEffect(() => {
    if (!signedMediaUrl || mediaError || (!isImage && !isVideo)) {
      setIsMediaViewerOpen(false);
    }
  }, [isImage, isVideo, mediaError, signedMediaUrl]);

  const loadSignedMediaUrl = React.useCallback(() => {
    if (!isMedia || !message.mediaAsset?.id) {
      setSignedMediaUrl(null);
      setMediaError(false);
      return () => {};
    }

    let cancelled = false;
    setSignedMediaUrl(null);
    setMediaError(false);
    setVideoPreviewError(false);

    getMediaDownloadUrl({ roomId: message.roomId, assetId: message.mediaAsset.id })
      .then(({ url }) => {
        if (!cancelled) {
          setSignedMediaUrl(url);
        }
      })
      .catch((error) => {
        console.error("Failed to get media URL:", error);
        if (!cancelled) {
          setMediaError(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isMedia, message.mediaAsset?.id, message.roomId]);

  React.useEffect(() => {
    mediaRetryCountRef.current = 0;
    return loadSignedMediaUrl();
  }, [loadSignedMediaUrl]);

  React.useEffect(() => {
    if (!isAudio) {
      setAudioTranscription(null);
      setIsAudioTranscriptionLoading(false);
      setIsAudioTranscriptHidden(false);
      return () => {};
    }

    let cancelled = false;
    setAudioTranscription(null);
    setIsAudioTranscriptionLoading(false);
    setIsAudioTranscriptHidden(false);

    getAudioTranscription({ roomId: message.roomId, messageId: message.id })
      .then((record) => {
        if (!cancelled) {
          setAudioTranscription(record);
        }
      })
      .catch((error) => {
        console.error("Failed to load audio transcription:", error);
      });

    return () => {
      cancelled = true;
    };
  }, [isAudio, message.id, message.roomId]);

  React.useEffect(() => {
    if (!isAudio || (audioTranscription?.status !== 'pending' && audioTranscription?.status !== 'processing')) {
      return () => {};
    }

    let cancelled = false;
    const poll = () => {
      getAudioTranscription({ roomId: message.roomId, messageId: message.id })
        .then((record) => {
          if (!cancelled) {
            setAudioTranscription(record);
          }
        })
        .catch((error) => {
          console.error("Failed to refresh audio transcription:", error);
        });
    };
    const timer = window.setInterval(poll, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [audioTranscription?.status, isAudio, message.id, message.roomId]);

  const handleMediaError = () => {
    if (message.mediaAsset?.id && mediaRetryCountRef.current < 1) {
      mediaRetryCountRef.current += 1;
      loadSignedMediaUrl();
      return;
    }

    setMediaError(true);
  };

  const handleVideoPreviewError = () => {
    if (message.mediaAsset?.id && mediaRetryCountRef.current < 1) {
      mediaRetryCountRef.current += 1;
      loadSignedMediaUrl();
      return;
    }

    setVideoPreviewError(true);
  };

  const handleRequestAudioTranscription = async () => {
    if (!isAudio || isAudioTranscriptionLoading) {
      return;
    }

    setIsAudioTranscriptionLoading(true);
    try {
      const record = await requestAudioTranscription({ roomId: message.roomId, messageId: message.id });
      setAudioTranscription(record);
      setIsAudioTranscriptHidden(false);
    } catch (error) {
      console.error("Failed to request audio transcription:", error);
      setAudioTranscription({
        assetId: message.mediaAsset?.id || '',
        roomId: message.roomId,
        messageId: message.id,
        status: 'failed',
        error: error instanceof Error ? error.message : t('audioTranscriptionFailed'),
      });
    } finally {
      setIsAudioTranscriptionLoading(false);
    }
  };

  const handleDownloadFile = async () => {
    if (!signedMediaUrl) {
      return;
    }
    await saveUrlAsFile(signedMediaUrl, buildMediaFilename(message));
  };

  const canOpenMediaViewer = Boolean(signedMediaUrl && !mediaError && (isImage || isVideo));
  const { cacheBodyFetchKey, markMediaLoadedForCache } = useDeferredMediaCacheFetchKey(signedMediaUrl);
  const { mediaUrl: displayMediaUrl, posterUrl: videoPosterUrl } = useCachedMedia({
    assetId: message.mediaAsset?.id,
    url: signedMediaUrl,
    kind: isImage ? "image" : isAudio ? "audio" : isVideo ? "video" : undefined,
    mimeType: message.mediaAsset?.mimeType,
    byteSize: message.mediaAsset?.byteSize,
    cacheBodyFetchKey,
  });
  const videoPreviewUrl = displayMediaUrl && isVideo ? getVideoPreviewUrl(displayMediaUrl) : null;

  const audioTranscriptionStatus = audioTranscription?.status || 'not_requested';
  const isAudioTranscriptionRunning = audioTranscriptionStatus === 'pending' || audioTranscriptionStatus === 'processing';
  const audioTranscriptText = audioTranscription?.transcript?.trim() || '';
  const shouldShowAudioTranscript = audioTranscriptionStatus === 'completed' && !isAudioTranscriptHidden;
  const shouldShowAudioTranscriptionButton = isAudio && (
    audioTranscriptionStatus === 'not_requested' ||
    audioTranscriptionStatus === 'failed' ||
    (audioTranscriptionStatus === 'completed' && isAudioTranscriptHidden)
  );

  const audioTranscriptionContent = isAudio ? (
    <div className={`mt-1 flex max-w-[260px] flex-col gap-1 ${isMine ? 'items-end' : 'items-start'}`}>
      {shouldShowAudioTranscriptionButton && (
        <Button
          size="sm"
          variant="flat"
          className="h-7 min-w-0 rounded-md bg-[#e8e6dc] px-2 text-xs font-medium text-[#4d4c48] dark:bg-[#30302e] dark:text-[#faf9f5]"
          startContent={<Icon icon={audioTranscriptionStatus === 'failed' ? "lucide:refresh-cw" : "lucide:captions"} className="h-3.5 w-3.5" />}
          onPress={audioTranscriptionStatus === 'completed' ? () => setIsAudioTranscriptHidden(false) : handleRequestAudioTranscription}
          isLoading={isAudioTranscriptionLoading}
          isDisabled={isAudioTranscriptionLoading}
        >
          {audioTranscriptionStatus === 'completed' ? t('showAudioTranscript') : audioTranscriptionStatus === 'failed' ? t('retryAudioTranscription') : t('transcribeAudio')}
        </Button>
      )}
      {isAudioTranscriptionRunning && (
        <div className="flex items-center gap-1 rounded-md bg-[#e8e6dc] px-2 py-1 text-xs text-[#5e5d59] dark:bg-[#30302e] dark:text-[#b0aea5]">
          <Icon icon="lucide:loader-2" className="h-3.5 w-3.5 animate-spin" />
          {t('audioTranscribing')}
        </div>
      )}
      {audioTranscriptionStatus === 'failed' && audioTranscription?.error && (
        <div className="max-w-full rounded-md bg-danger-500/10 px-2 py-1 text-xs text-danger-600 dark:text-danger-300">
          {audioTranscription.error}
        </div>
      )}
      {shouldShowAudioTranscript && (
        <div className="relative max-w-full rounded-lg bg-[#1d1d1b]/90 px-3 py-2 pr-8 text-left text-sm leading-6 text-[#faf9f5] shadow-[0_0_0_1px_rgba(20,20,19,0.18)] dark:bg-[#242421] dark:shadow-[0_0_0_1px_rgba(77,76,72,0.8)]">
          <div className="whitespace-pre-wrap break-words">{audioTranscriptText || t('audioTranscriptionEmpty')}</div>
          <Tooltip content={t('hideAudioTranscript')} placement="top" size="sm" delay={500} classNames={tooltipClassNames} isDisabled={isTouchDevice}>
            <Button
              isIconOnly
              size="sm"
              variant="light"
              aria-label={t('hideAudioTranscript')}
              className="absolute right-1 top-1 h-6 w-6 min-w-0 text-[#faf9f5]/75"
              onPress={() => setIsAudioTranscriptHidden(true)}
            >
              <Icon icon="lucide:eye-off" className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
        </div>
      )}
    </div>
  ) : null;

  const handleOpenMediaViewer = () => {
    if (canOpenMediaViewer) {
      setIsMediaViewerOpen(true);
    }
  };

  let mediaContent: React.ReactNode = null;
  if (isMedia) {
    if (mediaError) {
      mediaContent = (
        <div className="w-fit rounded-lg bg-[#e8e6dc] px-3 py-2 text-sm text-danger shadow-[0_0_0_1px_rgba(194,192,182,0.75)] dark:bg-[#30302e]">
          <Icon icon="lucide:alert-triangle" className="inline mr-1" />
          {t('mediaLoadFailed')}
        </div>
      );
    } else if (isFile) {
      const fileName = message.mediaAsset?.filename || buildMediaFilename(message);
      const fileSize = formatByteSize(message.mediaAsset?.byteSize, i18n.language);
      mediaContent = (
        <div className="flex w-[min(20rem,100%)] items-center gap-3 rounded-lg bg-[#f0eee6] px-3 py-2 text-[#141413] shadow-[0_0_0_1px_rgba(222,219,208,0.95)] dark:bg-[#242421] dark:text-[#faf9f5] dark:shadow-[0_0_0_1px_rgba(61,61,58,0.9)]">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md bg-[#e8e6dc] text-[#5e5d59] dark:bg-[#30302e] dark:text-[#b0aea5]">
            <Icon icon="lucide:file" className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1 text-left">
            <div className="truncate text-sm font-medium">{fileName}</div>
            {fileSize && <div className="text-xs text-[#5e5d59] dark:text-[#b0aea5]">{fileSize}</div>}
          </div>
          <Tooltip content={t('downloadFile')} placement="top" size="sm" delay={500} classNames={tooltipClassNames} isDisabled={isTouchDevice}>
            <Button
              isIconOnly
              size="sm"
              variant="light"
              aria-label={t('downloadFile')}
              className="h-8 w-8 min-w-8 flex-shrink-0 text-[#c96442] dark:text-[#d97757]"
              onPress={handleDownloadFile}
              isDisabled={!signedMediaUrl}
            >
              <Icon icon="lucide:download" className="h-4 w-4" />
            </Button>
          </Tooltip>
        </div>
      );
    } else if (displayMediaUrl && isImage) {
      mediaContent = (
        <div className="relative inline-block max-w-full overflow-hidden rounded-xl bg-black/5 shadow-[0_0_0_1px_rgba(194,192,182,0.45)] dark:bg-white/5 dark:shadow-[0_0_0_1px_rgba(77,76,72,0.8)]">
          <button
            type="button"
            aria-label={t('openMediaViewer')}
            className="block max-w-full cursor-zoom-in rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c96442] dark:focus-visible:ring-[#d97757]"
            onClick={handleOpenMediaViewer}
          >
            <img
              src={displayMediaUrl}
              alt={t('sharedImage')}
              crossOrigin="anonymous"
              className="block max-h-[300px] max-w-full object-contain"
              onLoad={markMediaLoadedForCache}
              onError={handleMediaError}
            />
          </button>
        </div>
      );
    } else if (displayMediaUrl && isAudio) {
      mediaContent = (
        <div className={`flex w-fit max-w-full flex-col ${isMine ? 'items-end' : 'items-start'}`}>
          <audio
            controls
            src={displayMediaUrl}
            crossOrigin="anonymous"
            className="roomtalk-audio-player block h-9 min-w-[180px] max-w-[240px]"
            onCanPlay={markMediaLoadedForCache}
            onError={handleMediaError}
          />
          {audioTranscriptionContent}
        </div>
      );
    } else if (displayMediaUrl && isVideo) {
      const fileName = message.mediaAsset?.filename || buildMediaFilename(message);
      const fileSize = formatByteSize(message.mediaAsset?.byteSize, i18n.language);
      mediaContent = videoPreviewError ? (
        <div className="flex w-[min(20rem,100%)] items-center gap-3 rounded-lg bg-[#f0eee6] px-3 py-2 text-[#141413] shadow-[0_0_0_1px_rgba(222,219,208,0.95)] dark:bg-[#242421] dark:text-[#faf9f5] dark:shadow-[0_0_0_1px_rgba(61,61,58,0.9)]">
          <button
            type="button"
            aria-label={t('openMediaViewer')}
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md bg-[#e8e6dc] text-[#5e5d59] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c96442] dark:bg-[#30302e] dark:text-[#b0aea5] dark:focus-visible:ring-[#d97757]"
            onClick={handleOpenMediaViewer}
          >
            <Icon icon="lucide:video-off" className="h-5 w-5" />
          </button>
          <button
            type="button"
            aria-label={t('openMediaViewer')}
            className="min-w-0 flex-1 text-left focus-visible:outline-none"
            onClick={handleOpenMediaViewer}
          >
            <div className="truncate text-sm font-medium">{fileName}</div>
            <div className="text-xs text-[#5e5d59] dark:text-[#b0aea5]">
              {fileSize ? `${t('videoPreviewUnsupported')} · ${fileSize}` : t('videoPreviewUnsupported')}
            </div>
          </button>
          <Tooltip content={t('downloadMedia')} placement="top" size="sm" delay={500} classNames={tooltipClassNames} isDisabled={isTouchDevice}>
            <Button
              isIconOnly
              size="sm"
              variant="light"
              aria-label={t('downloadMedia')}
              className="h-8 w-8 min-w-8 flex-shrink-0 text-[#c96442] dark:text-[#d97757]"
              onPress={handleDownloadFile}
              isDisabled={!signedMediaUrl}
            >
              <Icon icon="lucide:download" className="h-4 w-4" />
            </Button>
          </Tooltip>
        </div>
      ) : (
        <div className="relative inline-block max-w-full overflow-hidden rounded-xl bg-black shadow-[0_0_0_1px_rgba(20,20,19,0.35)]">
          <button
            type="button"
            aria-label={t('openMediaViewer')}
            className="group/video relative flex max-w-full cursor-zoom-in items-center justify-center rounded-xl bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c96442] dark:focus-visible:ring-[#d97757]"
            onClick={handleOpenMediaViewer}
          >
            <video
              src={videoPreviewUrl || displayMediaUrl}
              poster={videoPosterUrl || undefined}
              crossOrigin="anonymous"
              className="pointer-events-none block max-h-[360px] max-w-full object-contain"
              preload="metadata"
              muted
              playsInline
              onLoadedData={markMediaLoadedForCache}
              onError={handleVideoPreviewError}
            />
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/10 transition group-hover/video:bg-black/20">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/45 text-white shadow-lg backdrop-blur">
                <Icon icon="lucide:play" className="ml-0.5 h-6 w-6" />
              </span>
            </span>
          </button>
        </div>
      );
    } else {
      mediaContent = (
        <div className="flex h-24 w-36 items-center justify-center rounded-xl bg-[#e8e6dc] text-[#87867f] shadow-[0_0_0_1px_rgba(194,192,182,0.75)] dark:bg-[#30302e] dark:text-[#b0aea5] dark:shadow-[0_0_0_1px_rgba(77,76,72,0.8)]">
          <Icon icon={isAudio ? "lucide:audio-lines" : isVideo ? "lucide:video" : isFile ? "lucide:file" : "lucide:image"} className="h-5 w-5" />
        </div>
      );
    }
  }

  const handleCopyMessage = async () => {
    const success = isImage
      ? signedMediaUrl
        ? await copyImageToClipboard(signedMediaUrl)
        : false
      : await navigator.clipboard.writeText(message.content).then(() => true).catch((error) => {
        console.error("Failed to copy message:", error);
        return false;
      });

    setCopyStatus(success ? 'success' : 'error');
    if (copyResetTimerRef.current) {
      clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = setTimeout(() => {
      setCopyStatus('idle');
      copyResetTimerRef.current = null;
    }, 1500); // Reset status after a delay
  };

  const toggleLike = () => {
    setLiked((value) => !value);
    if (!liked) setDisliked(false);
  };

  const toggleDislike = () => {
    setDisliked((value) => !value);
    if (!disliked) setLiked(false);
  };

  // 修改成不使用事件参数的简单处理函数，避免类型错误
  const handleRefreshAIClick = () => {
    if (isAI && onRefreshAI && !isStreaming) {
      onRefreshAI(message.id, message.content);
    }
  };

  const getValidColor = (
    color: string | undefined
  ): "primary" | "secondary" | "success" | "warning" | "danger" | "default" | undefined => {
    if (!color) return "default";
    if (["primary", "secondary", "success", "warning", "danger", "default"].includes(color)) {
      return color as "primary" | "secondary" | "success" | "warning" | "danger" | "default";
    }
    return "default";
  };

  return (
    <div
      data-testid="message-item"
      data-message-id={message.id}
      className={`group mb-1 flex w-full items-start ${isMine ? "justify-end" : "justify-start"}`}
    >
      {/* Opponent's avatar or AI avatar */}
      {(!isMine || isAI) && !isMine && (
        <Avatar
          name={message.avatar?.text || undefined}
          icon={isAI ? <Icon icon="lucide:bot" /> : (!message.avatar?.text ? <Icon icon="lucide:user" /> : undefined)}
          color={getValidColor(isAI ? "secondary" : message.avatar?.color)}
          size="sm"
          classNames={{
            base: "mr-2 flex-shrink-0 bg-[#e8e6dc] text-[#4d4c48] dark:bg-[#30302e] dark:text-[#faf9f5]",
          }}
        />
      )}

      {/* Message Content Area */}
      <div className={`flex max-w-[82%] flex-col min-w-0 sm:max-w-[70%] ${isMine ? 'items-end' : 'items-start'}`}>
        {/* Username or AI name */}
        {(!isMine || isAI) && !isMine && (message.username || isAI) && (
          <div className="mb-1 ml-1 text-tiny text-[#5e5d59] dark:text-[#b0aea5]">
            {isAI ? (message.username || t('aiAssistantName')) : message.username}
          </div>
        )}

        {/* Container for bubble/image */}
        <div className="relative inline-block w-fit max-w-full min-w-0">
          {isMedia ? (
            <div className="w-fit max-w-full">
              {replyReference}
              {mediaContent}
            </div>
          ) : isSticker ? (
            // ========== Sticker Message ==========
            <div className="w-fit max-w-full">
              {replyReference}
              {stickerUrl ? (
                <Tooltip content={stickerName} placement="top" size="sm" delay={400} classNames={tooltipClassNames} isDisabled={isTouchDevice || !stickerName}>
                  <img
                    src={stickerUrl}
                    alt={stickerName || t('sticker')}
                    className="block h-auto w-[120px] max-w-full select-none sm:w-[140px]"
                    draggable={false}
                    loading="lazy"
                  />
                </Tooltip>
              ) : (
                <div className="flex h-[120px] w-[120px] items-center justify-center rounded-xl bg-[#e8e6dc] text-[#8a8a85] dark:bg-[#30302e] sm:h-[140px] sm:w-[140px]">
                  <Icon icon="lucide:sticker" className="h-6 w-6" />
                </div>
              )}
            </div>
          ) : (
            // ========== Text Message (Display Mode) ==========
            <>
              <Card
                className={`
                  w-fit max-w-full overflow-hidden rounded-xl
                  ${isPending ? "opacity-70" : ""}
                  ${isMine
                    ? "bg-[#e8e6dc] text-[#141413] shadow-[0_0_0_1px_rgba(194,192,182,0.85)] dark:bg-[#30302e] dark:text-[#faf9f5] dark:shadow-[0_0_0_1px_rgba(77,76,72,0.8)]"
                    : message.messageType === 'ai'
                      ? "bg-[#faf9f5] text-[#141413] shadow-[0_0_0_1px_rgba(222,219,208,0.95)] dark:bg-[#1d1d1b] dark:text-[#faf9f5] dark:shadow-[0_0_0_1px_rgba(48,48,46,0.95)]"
                      : "bg-[#f0eee6] text-[#141413] shadow-[0_0_0_1px_rgba(222,219,208,0.95)] dark:bg-[#242421] dark:text-[#faf9f5] dark:shadow-[0_0_0_1px_rgba(61,61,58,0.9)]"
                  }
                  ${isFailed ? "ring-1 ring-danger-500/75" : ""}
                `}
              >
                <div className="max-w-full px-2 py-1.5">
                  {replyReference}
                  <div className="max-w-full overflow-hidden whitespace-pre-wrap break-words text-sm leading-6">
                    <div className="max-w-full overflow-x-auto" style={{ wordBreak: 'break-word', overflowWrap: 'break-word' }}>
                      <React.Suspense fallback={
                        <div className="whitespace-pre-wrap break-words">
                          {message.content}
                          {isStreaming && (
                            <span className="inline-block w-1.5 h-3 bg-current animate-pulse ml-0.5 align-baseline"></span>
                          )}
                        </div>
                      }>
                        <MarkdownContent content={message.content} isStreaming={isStreaming} />
                      </React.Suspense>
                    </div>
                  </div>
                </div>
              </Card>
              {message.uiPayload && (
                <A2UIRenderer
                  payload={message.uiPayload}
                  roomId={message.roomId}
                  messageId={message.id}
                  onAction={handleA2UIAction}
                />
              )}
            </>
          )}
        </div>
        {/* Timestamp and Actions Area - Below the bubble/image */}
        <div
            className={`mt-0.5 flex min-h-5 max-w-full flex-wrap items-center ${isMine ? 'justify-end' : 'justify-start'}`}
        >
            {/* Timestamp */}
            <span className="mr-1 max-w-full text-tiny text-[#87867f] dark:text-[#b0aea5]">
              {formatTime(message.timestamp, i18n.language)}
              {isStreaming && ` • ${t('typing')}`}
              {isPending && ` • ${t('messageSending')}`}
              {isFailed && ` • ${message.deliveryError || t('messageFailedToSend')}`}
              {aiCostLabel && ` • ${aiCostLabel}`}
            </span>

            <div className="ml-1 flex items-center gap-0.5">
              <Tooltip
                content={copyStatus === 'success' ? t('copied') : (copyStatus === 'error' ? t('copyFailed') : (isImage ? t('copyImage') : t('copy')))}
                placement="top"
                size="sm"
                delay={500}
                classNames={tooltipClassNames}
                isDisabled={isTouchDevice}
              >
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  aria-label={isImage ? t('copyImage') : t('copy')}
                  className={`h-5 w-5 min-w-0 ${copyStatus === 'success' ? 'text-[#c96442] dark:text-[#d97757]' : 'text-[#5e5d59] dark:text-[#b0aea5]'}`}
                  onPress={handleCopyMessage}
                  isDisabled={isMedia && (!isImage || !signedMediaUrl || mediaError)}
                >
                  <Icon icon={copyStatus === 'success' ? "lucide:check" : "lucide:copy"} width={12} height={12}/>
                </Button>
              </Tooltip>
              <Tooltip content={t('replyToMessage')} placement="top" size="sm" delay={500} classNames={tooltipClassNames} isDisabled={isTouchDevice}>
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  aria-label={t('replyToMessage')}
                  className="h-5 w-5 min-w-0 text-[#5e5d59] dark:text-[#b0aea5]"
                  onPress={() => onReply(message)}
                  isDisabled={isStreaming}
                >
                  <Icon icon="lucide:reply" width={12} height={12}/>
                </Button>
              </Tooltip>
              {canEditMessage && (
                <Tooltip content={t('editMessage')} placement="top" size="sm" delay={500} classNames={tooltipClassNames} isDisabled={isTouchDevice}>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="light"
                    aria-label={t('editMessage')}
                    className="h-5 w-5 min-w-0 text-[#5e5d59] dark:text-[#b0aea5]"
                    onPress={() => onStartEdit(message.id)}
                  >
                    <Icon icon="lucide:pencil" width={12} height={12}/>
                  </Button>
                </Tooltip>
              )}
              {canDeleteMessage && (
                <Tooltip content={t('deleteMessage')} placement="top" size="sm" delay={500} classNames={tooltipClassNames} isDisabled={isTouchDevice}>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="light"
                    aria-label={t('deleteMessage')}
                    className="h-5 w-5 min-w-0 text-danger-500"
                    onPress={() => onDeleteMessage(message.id)}
                  >
                    <Icon icon="lucide:trash-2" width={12} height={12}/>
                  </Button>
                </Tooltip>
              )}
              {/* 刷新按钮 - 仅对AI消息显示 */}
              {isAI && !isStreaming && onRefreshAI && (
                <Tooltip content={t('retry')} placement="top" size="sm" delay={500} classNames={tooltipClassNames} isDisabled={isTouchDevice}>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="light"
                    aria-label={t('retry')}
                    className="h-5 w-5 min-w-0 text-[#c96442] dark:text-[#d97757]"
                    onPress={handleRefreshAIClick}
                    isDisabled={isStreaming}
                  >
                    <Icon icon="lucide:refresh-cw" width={12} height={12}/>
                  </Button>
                </Tooltip>
              )}
              <Dropdown placement="top-end">
                <DropdownTrigger>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="light"
                    aria-label={t('moreActions')}
                    className="h-5 w-5 min-w-0 text-[#5e5d59] dark:text-[#b0aea5]"
                    isDisabled={isStreaming}
                  >
                    <Icon icon="lucide:more-horizontal" width={12} height={12}/>
                  </Button>
                </DropdownTrigger>
                <DropdownMenu aria-label={t('moreActions')}>
                  <DropdownItem
                    key="like"
                    startContent={<Icon icon="lucide:thumbs-up" />}
                    onPress={toggleLike}
                    className={liked ? "text-[#c96442] dark:text-[#d97757]" : ""}
                  >
                    {liked ? t('cancelLike') : t('like')}
                  </DropdownItem>
                  <DropdownItem
                    key="dislike"
                    startContent={<Icon icon="lucide:thumbs-down" />}
                    onPress={toggleDislike}
                    className={disliked ? "text-[#c96442] dark:text-[#d97757]" : ""}
                  >
                    {disliked ? t('cancelDislike') : t('dislike')}
                  </DropdownItem>
                </DropdownMenu>
              </Dropdown>
            </div>
        </div>
      </div>

      {/* Your avatar */}
      {isMine && !isAI && (
        <Avatar
          name={message.avatar?.text || undefined}
          icon={!message.avatar?.text ? <Icon icon="lucide:user" /> : undefined}
          color={getValidColor(message.avatar?.color) || "primary"}
          size="sm"
          classNames={{
            base: "ml-2 flex-shrink-0 bg-[#30302e] text-[#faf9f5] dark:bg-[#faf9f5] dark:text-[#141413]",
          }}
        />
      )}
      <MediaViewerModal
        isOpen={isMediaViewerOpen && canOpenMediaViewer}
        src={signedMediaUrl}
        kind={isVideo ? "video" : "image"}
        title={t('mediaViewer')}
        alt={isVideo ? t('videoMessage') : t('sharedImage')}
        roomId={message.roomId}
        assetId={message.mediaAsset?.id}
        mimeType={message.mediaAsset?.mimeType}
        byteSize={message.mediaAsset?.byteSize}
        createdAt={message.timestamp}
        onClose={() => setIsMediaViewerOpen(false)}
      />
    </div>
  );
};

// Memoized: switching rooms, scrolling, cost/modal state changes etc. must not
// re-render every message. Handlers passed in are kept reference-stable by the
// parent, so an item only re-renders when its own `message` actually changes.
export const MessageItem = React.memo(MessageItemComponent);
