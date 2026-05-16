import React, { useState } from "react";
import { Avatar, Card, Image, Button, Tooltip } from "@heroui/react";
import { Icon } from "@iconify/react";
import { clientId } from "../utils/socket";
import { formatPercentage, formatTime, formatUsdCost } from "../utils/formatters";
import { Message } from "../utils/types";
import { useTranslation } from "react-i18next";
import { CocoToolMessage } from './CocoToolMessage';

interface MessageItemProps {
  message: Message;
  onStartEdit: (messageId: string) => void;
  onDeleteMessage: (messageId: string) => void;
  onRefreshAI?: (messageId: string, content: string) => void;
}

const tooltipClassNames = {
  content: "border border-[#dedbd0] bg-[#faf9f5] px-2 py-1 text-xs font-medium text-[#141413] shadow-lg dark:border-[#30302e] dark:bg-[#1d1d1b] dark:text-[#faf9f5]",
};

const MarkdownContent = React.lazy(() =>
  import("./MarkdownContent").then(module => ({ default: module.MarkdownContent }))
);

// Helper to copy image to clipboard
async function copyImageToClipboard(base64Image: string): Promise<boolean> {
  if (!base64Image.startsWith('data:image')) {
    console.error("Invalid image data for clipboard");
    return false;
  }
  try {
    const response = await fetch(base64Image);
    const blob = await response.blob();
    // ClipboardItem requires a secure context (HTTPS or localhost)
    if (typeof ClipboardItem === "undefined") {
        console.warn("ClipboardItem API is not available in this context (non-secure?). Falling back to text copy.");
        // Fallback: Copy the base64 string as text
        await navigator.clipboard.writeText(base64Image);
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

export const MessageItem: React.FC<MessageItemProps> = ({
  message,
  onStartEdit,
  onDeleteMessage,
  onRefreshAI
}) => {
  const isMine = message.clientId === clientId;
  const [isHovered, setIsHovered] = React.useState(false);
  const [imageError, setImageError] = React.useState(false);
  const isImage = message.messageType === "image";
  const isText = message.messageType === "text";
  const isAI = message.clientId === 'ai_assistant';
  const isCocoEvent = message.messageType === 'tool_call' || message.messageType === 'tool_result' || message.messageType === 'sandbox_status';
  const isStreaming = isAI && message.status === 'streaming';
  const canBeEdited = isText || (message.messageType === 'ai' && message.status !== 'streaming');
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

  const [copyStatus, setCopyStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const copyResetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  const handleImageError = () => {
    setImageError(true);
  };

  const handleCopyClick = async (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent card click
    if (!isImage) return;
    const imageData = message.content.startsWith('data:')
                      ? message.content
                      : `data:${message.mimeType || 'image/png'};base64,${message.content}`;
    const success = await copyImageToClipboard(imageData);
    setCopyStatus(success ? 'success' : 'error');
    if (copyResetTimerRef.current) {
      clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = setTimeout(() => {
      setCopyStatus('idle');
      copyResetTimerRef.current = null;
    }, 1500); // Reset status after a delay
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

  const showActions = isHovered;
  const renderMessageBody = () => {
    if (isCocoEvent) {
      return <CocoToolMessage message={message} />;
    }

    if (isImage) {
      const imageSrc = message.content.startsWith('data:')
        ? message.content
        : `data:${message.mimeType || 'image/png'};base64,${message.content}`;

      return (
        <div className="w-fit cursor-pointer" onClick={handleCopyClick}>
          <Tooltip
            content={copyStatus === 'success' ? t('copied') : (copyStatus === 'error' ? t('copyFailed') : t('copyImage'))}
            placement="top"
            size="sm"
            classNames={tooltipClassNames}
          >
            {imageError ? (
              <div className="w-fit rounded-md bg-[#e8e6dc] p-2 text-sm text-danger dark:bg-[#30302e]">
                <Icon icon="lucide:alert-triangle" className="inline mr-1" />
                {t('imageLoadFailed')}
              </div>
            ) : (
              <div className="max-w-full rounded-lg border border-[#dedbd0] bg-[#faf9f5] p-0.5 dark:border-[#30302e] dark:bg-[#1d1d1b]">
                <Image
                  src={imageSrc}
                  alt={t('sharedImage')}
                  className="block max-h-[300px] max-w-full object-contain rounded"
                  onError={handleImageError}
                  isBlurred
                />
              </div>
            )}
          </Tooltip>
        </div>
      );
    }

    return (
      <Card
        className={`
          max-w-full w-full overflow-hidden rounded-xl
          ${isMine
            ? "bg-[#e8e6dc] text-[#141413] shadow-[0_0_0_1px_rgba(194,192,182,0.85)] dark:bg-[#30302e] dark:text-[#faf9f5] dark:shadow-[0_0_0_1px_rgba(77,76,72,0.8)]"
            : message.messageType === 'ai'
              ? "bg-[#faf9f5] text-[#141413] shadow-[0_0_0_1px_rgba(222,219,208,0.95)] dark:bg-[#1d1d1b] dark:text-[#faf9f5] dark:shadow-[0_0_0_1px_rgba(48,48,46,0.95)]"
              : "bg-[#f0eee6] text-[#141413] shadow-[0_0_0_1px_rgba(222,219,208,0.95)] dark:bg-[#242421] dark:text-[#faf9f5] dark:shadow-[0_0_0_1px_rgba(61,61,58,0.9)]"
          }
        `}
      >
        <div className="max-w-full p-2.5">
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
    );
  };

  return (
    <div
      data-testid="message-item"
      data-message-id={message.id}
      className={`group mb-1 flex w-full items-start ${isMine ? "justify-end" : "justify-start"}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Opponent's avatar or AI avatar */}
      {(!isMine || isAI) && !isMine && (
        <Avatar
          name={message.avatar?.text || undefined}
          icon={isAI ? <Icon icon="lucide:bot" /> : isCocoEvent ? <Icon icon="lucide:terminal" /> : (!message.avatar?.text ? <Icon icon="lucide:user" /> : undefined)}
          color={getValidColor(isAI || isCocoEvent ? "secondary" : message.avatar?.color)}
          size="sm"
          classNames={{
            base: "mr-2 flex-shrink-0 bg-[#e8e6dc] text-[#4d4c48] dark:bg-[#30302e] dark:text-[#faf9f5]",
          }}
        />
      )}

      {/* Message Content Area */}
      <div className={`flex max-w-[82%] flex-col min-w-0 sm:max-w-[70%] ${isMine ? 'items-end' : 'items-start'}`}>
        {/* Username or AI name */}
        {(!isMine || isAI) && !isMine && (message.username || isAI || isCocoEvent) && (
          <div className="mb-1 ml-1 text-tiny text-[#5e5d59] dark:text-[#b0aea5]">
            {isAI ? (message.username || t('aiAssistantName')) : isCocoEvent ? t('cocoRoomType') : message.username}
          </div>
        )}

        {/* Container for bubble/image */}
        <div className="relative inline-block max-w-full w-full min-w-0">
          {renderMessageBody()}
        </div>
        {/* Timestamp and Actions Area - Below the bubble/image */}
        <div
            className={`mt-0.5 flex min-h-5 max-w-full flex-wrap items-center ${isMine ? 'justify-end' : 'justify-start'}`}
        >
            {/* Timestamp */}
            <span className={`max-w-full text-tiny text-[#87867f] dark:text-[#b0aea5] ${showActions ? 'mr-1' : ''}`}>
              {formatTime(message.timestamp, i18n.language)}
              {isStreaming && ` • ${t('typing')}`}
              {aiCostLabel && ` • ${aiCostLabel}`}
            </span>

            {/* Action Buttons: Show on hover */}
            {showActions && (
              <div className="flex items-center gap-0.5 transition-opacity opacity-100">
                {canBeEdited && (
                  <Tooltip content={t('editMessage')} placement="top" size="sm" delay={500} classNames={tooltipClassNames}>
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
                <Tooltip content={t('deleteMessage')} placement="top" size="sm" delay={500} classNames={tooltipClassNames}>
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
                {/* 刷新按钮 - 仅对AI消息显示 */}
                {isAI && !isStreaming && onRefreshAI && (
                  <Tooltip content={t('retry')} placement="top" size="sm" delay={500} classNames={tooltipClassNames}>
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
              </div>
            )}
            {!showActions && <div className="w-10 h-5"></div>}
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
    </div>
  );
};
