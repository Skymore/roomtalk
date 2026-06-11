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
import { clientId, getMediaDownloadUrl } from "../utils/socket";
import { formatPercentage, formatTime, formatUsdCost } from "../utils/formatters";
import { Message, RoomPermissions } from "../utils/types";
import { useTranslation } from "react-i18next";
import { useIsTouchDevice } from "../hooks/useIsTouchDevice";
import { MediaViewerModal } from "./MediaViewerModal";
import { getVideoPreviewUrl } from "../utils/videoPreview";

interface MessageItemProps {
  message: Message;
  roomPermissions: RoomPermissions | null;
  onStartEdit: (messageId: string) => void;
  onDeleteMessage: (messageId: string) => void;
  onRefreshAI?: (messageId: string, content: string) => void;
  onReply: (message: Message) => void;
}

const tooltipClassNames = {
  content: "border border-[#dedbd0] bg-[#faf9f5] px-2 py-1 text-xs font-medium text-[#141413] shadow-lg dark:border-[#30302e] dark:bg-[#1d1d1b] dark:text-[#faf9f5]",
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
  const [signedMediaUrl, setSignedMediaUrl] = React.useState<string | null>(null);
  const [isMediaViewerOpen, setIsMediaViewerOpen] = React.useState(false);
  const mediaRetryCountRef = React.useRef(0);
  const isMedia = message.messageType === "media";
  const mediaKind = message.mediaAsset?.kind;
  const isImage = isMedia && mediaKind === "image";
  const isAudio = isMedia && mediaKind === "audio";
  const isVideo = isMedia && mediaKind === "video";
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
  const replySenderName = message.replyTo?.username
    || (message.replyTo?.messageType === 'ai' ? t('aiAssistantName') : t('participant'));
  const replyPreview = message.replyTo?.messageType === 'media'
    ? (message.replyTo.mediaKind === 'audio'
      ? t('voiceMessage')
      : message.replyTo.mediaKind === 'video'
        ? t('videoMessage')
        : t('sharedImage'))
    : message.replyTo?.preview;
  const replyReference = message.replyTo ? (
    <div className="mb-2 max-w-full border-l-2 border-[#c96442] pl-2 text-xs text-[#5e5d59] dark:text-[#b0aea5]">
      <div className="truncate font-medium">{t('replyingTo', { name: replySenderName })}</div>
      <div className="truncate">{replyPreview}</div>
    </div>
  ) : null;

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

  const handleMediaError = () => {
    if (message.mediaAsset?.id && mediaRetryCountRef.current < 1) {
      mediaRetryCountRef.current += 1;
      loadSignedMediaUrl();
      return;
    }

    setMediaError(true);
  };

  const canOpenMediaViewer = Boolean(signedMediaUrl && !mediaError && (isImage || isVideo));
  const videoPreviewUrl = signedMediaUrl && isVideo ? getVideoPreviewUrl(signedMediaUrl) : null;

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
    } else if (signedMediaUrl && isImage) {
      mediaContent = (
        <div className="relative inline-block max-w-full overflow-hidden rounded-xl bg-black/5 shadow-[0_0_0_1px_rgba(194,192,182,0.45)] dark:bg-white/5 dark:shadow-[0_0_0_1px_rgba(77,76,72,0.8)]">
          <button
            type="button"
            aria-label={t('openMediaViewer')}
            className="block max-w-full cursor-zoom-in rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c96442] dark:focus-visible:ring-[#d97757]"
            onClick={handleOpenMediaViewer}
          >
            <img
              src={signedMediaUrl}
              alt={t('sharedImage')}
              className="block max-h-[300px] max-w-full object-contain"
              onError={handleMediaError}
            />
          </button>
        </div>
      );
    } else if (signedMediaUrl && isAudio) {
      mediaContent = (
        <audio
          controls
          src={signedMediaUrl}
          className="roomtalk-audio-player block h-9 min-w-[180px] max-w-[240px]"
          onError={handleMediaError}
        />
      );
    } else if (signedMediaUrl && isVideo) {
      mediaContent = (
        <div className="relative inline-block max-w-full overflow-hidden rounded-xl bg-black shadow-[0_0_0_1px_rgba(20,20,19,0.35)]">
          <button
            type="button"
            aria-label={t('openMediaViewer')}
            className="group/video relative flex max-w-full cursor-zoom-in items-center justify-center rounded-xl bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c96442] dark:focus-visible:ring-[#d97757]"
            onClick={handleOpenMediaViewer}
          >
            <video
              src={videoPreviewUrl || signedMediaUrl}
              className="pointer-events-none block max-h-[360px] max-w-full object-contain"
              preload="metadata"
              muted
              playsInline
              onError={handleMediaError}
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
          <Icon icon={isAudio ? "lucide:audio-lines" : isVideo ? "lucide:video" : "lucide:image"} className="h-5 w-5" />
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
          ) : (
            // ========== Text Message (Display Mode) ==========
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
            // ========== END MODIFIED ==========
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
