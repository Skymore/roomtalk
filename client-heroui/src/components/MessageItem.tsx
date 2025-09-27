import React, { useState } from "react";
import { Avatar, Card, Image, Button, Tooltip } from "@heroui/react";
import { Icon } from "@iconify/react";
import { clientId } from "../utils/socket";
import { formatTime } from "../utils/formatters";
import { Message } from "../utils/types";
import { MarkdownContent } from "./MarkdownContent";
import { useTranslation } from "react-i18next";

interface MessageItemProps {
  message: Message;
  onStartEdit: (messageId: string) => void;
  onDeleteMessage: (messageId: string) => void;
  onRefreshAI?: (messageId: string, content: string) => void;
}

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
  const isStreaming = isAI && message.status === 'streaming';
  const canBeEdited = isText || (message.messageType === 'ai' && message.status !== 'streaming');
  const { t } = useTranslation();

  const [copyStatus, setCopyStatus] = useState<'idle' | 'success' | 'error'>('idle');

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
    setTimeout(() => setCopyStatus('idle'), 1500); // Reset status after a delay
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

  return (
    <div
      className={`group flex w-full items-start ${isMine ? "justify-end" : "justify-start"} mb-1`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Opponent's avatar or AI avatar */} 
      {(!isMine || isAI) && !isMine && (
        <Avatar
          name={message.avatar?.text || undefined}
          icon={isAI ? <Icon icon="lucide:bot" /> : (!message.avatar?.text ? <Icon icon="lucide:user" /> : undefined)}
          color={getValidColor(isAI ? "secondary" : message.avatar?.color)}
          size="sm"
          classNames={{
            base: "mr-1 flex-shrink-0",
          }}
        />
      )}

      {/* Message Content Area */} 
      <div className={`max-w-[60%] sm:max-w-[65%] flex flex-col min-w-0 ${isMine ? 'items-end' : 'items-start'}`}> 
        {/* Username or AI name */} 
        {(!isMine || isAI) && !isMine && (message.username || isAI) && (
          <div className="text-tiny text-default-500 mb-0.5 ml-1">
            {isAI ? (message.username || 'AI Assistant') : message.username}
          </div>
        )}

        {/* Container for bubble/image */} 
        <div className="relative inline-block max-w-full w-full min-w-0">
          {isImage ? (
            <div className="w-fit cursor-pointer" onClick={handleCopyClick}> 
              <Tooltip content={copyStatus === 'success' ? 'Copied!' : (copyStatus === 'error' ? 'Copy Failed' : 'Copy Image')} placement="top" size="sm">
                {imageError ? (
                  <div className="text-sm text-danger p-2 bg-gray-100 dark:bg-gray-700 rounded-md w-fit">
                    <Icon icon="lucide:alert-triangle" className="inline mr-1" />
                    Failed to load image
                  </div>
                ) : (
                  <div className="border border-gray-200 dark:border-gray-600 rounded-md p-0.5 max-w-full">
                    <Image
                      src={isImage
                        ? (message.content.startsWith('data:')
                            ? message.content
                            : `data:${message.mimeType || 'image/png'};base64,${message.content}`)
                        : message.content}
                      alt="Shared image"
                      className="block max-h-[300px] max-w-full object-contain rounded"
                      onError={handleImageError}
                      isBlurred
                    />
                  </div>
                )}
              </Tooltip>
            </div>
          ) : (
            // ========== Text Message (Display Mode) ========== 
            <Card
              className={`
                rounded-lg shadow-sm max-w-full w-full overflow-hidden
                ${isMine
                  ? "bg-blue-100 dark:bg-blue-900 text-gray-800 dark:text-white"
                  : message.messageType === 'ai' 
                    ? "bg-purple-100 dark:bg-purple-900 text-gray-800 dark:text-white"
                    : "bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-white"
                }
              `}
            >
              <div className="p-2 max-w-full">
                <div className="text-xs break-words break-all whitespace-pre-wrap overflow-hidden max-w-full">
                  <div className="max-w-full overflow-x-auto" style={{ wordBreak: 'break-word', overflowWrap: 'break-word' }}>
                    <MarkdownContent content={message.content} />
                    {isStreaming && (
                      <span className="inline-block w-1.5 h-3 bg-current animate-pulse ml-0.5 align-baseline"></span>
                    )}
                  </div>
                </div>
              </div>
            </Card>
            // ========== END MODIFIED ==========
          )}
        </div>
        {/* Timestamp and Actions Area - Below the bubble/image */} 
        <div
            className={`flex items-center mt-0.5 h-5 ${isMine ? 'justify-end' : 'justify-start'}`}
        >
            {/* Timestamp */} 
            <span className={`text-tiny text-gray-500 dark:text-gray-400 ${showActions ? 'mr-1' : ''}`}> 
              {formatTime(message.timestamp)}
              {isStreaming && " • Typing..."}
            </span>

            {/* Action Buttons: Show on hover */}
            {showActions && (
              <div className="flex items-center gap-0.5 transition-opacity opacity-100">
                {canBeEdited && (
                  <Tooltip content={t('editMessage')} placement="top" size="sm" delay={500}>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="light"
                      className="min-w-0 w-5 h-5 text-default-500"
                      onPress={() => onStartEdit(message.id)}
                    >
                      <Icon icon="lucide:pencil" width={12} height={12}/>
                    </Button>
                  </Tooltip>
                )}
                <Tooltip content={t('deleteMessage')} placement="top" size="sm" delay={500}>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="light"
                    className="min-w-0 w-5 h-5 text-danger-500"
                    onPress={() => onDeleteMessage(message.id)}
                  >
                    <Icon icon="lucide:trash-2" width={12} height={12}/>
                  </Button>
                </Tooltip>
                {/* 刷新按钮 - 仅对AI消息显示 */}
                {isAI && !isStreaming && onRefreshAI && (
                  <Tooltip content={t('retry')} placement="top" size="sm" delay={500}>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="light"
                      className="min-w-0 w-5 h-5 text-primary-500"
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
            base: "ml-1 flex-shrink-0",
          }}
        />
      )}
    </div>
  );
};