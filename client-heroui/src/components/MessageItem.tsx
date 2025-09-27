import React from "react";
import { Avatar, Card, Image } from "@heroui/react";
import { Icon } from "@iconify/react";
import { clientId } from "../utils/socket";
import { formatTime } from "../utils/formatters";
import { Message } from "../utils/types";
import { MarkdownContent } from "./MarkdownContent";

interface MessageItemProps {
  message: Message;
}

export const MessageItem: React.FC<MessageItemProps> = ({ message }) => {
  const isMine = message.clientId === clientId;
  const [isHovered, setIsHovered] = React.useState(false);
  const [imageError, setImageError] = React.useState(false);
  const isImage = message.messageType === "image";
  const isAI = message.clientId === 'ai_assistant';
  const isStreaming = isAI && message.status === 'streaming';

  // Handle image loading errors
  const handleImageError = () => {
    setImageError(true);
  };

  // 转换颜色为有效的 Avatar 颜色类型
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
      className={`group flex w-full items-start ${isMine ? "justify-end" : "justify-start"} mb-1`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* 对方的头像或AI头像 */}
      {(!isMine || isAI) && !isMine && (
        <Avatar
          name={message.avatar?.text || undefined}
          icon={isAI ? <Icon icon="lucide:bot" /> : (!message.avatar?.text ? <Icon icon="lucide:user" /> : undefined)}
          color={getValidColor(isAI ? "secondary" : message.avatar?.color)}
          size="sm"
          classNames={{
            base: "mr-1 flex-shrink-0", // Added flex-shrink-0
          }}
        />
      )}

      {/* Message Content Area - 更严格的宽度控制 */}
      <div className={`max-w-[60%] sm:max-w-[65%] flex flex-col min-w-0 ${isMine ? 'items-end' : 'items-start'}`}>
        {/* 显示对方用户名或AI助手名称 */}
        {(!isMine || isAI) && !isMine && (message.username || isAI) && (
          <div className="text-tiny text-default-500 mb-0.5 ml-1">
            {isAI ? (message.username || 'AI Assistant') : message.username}
          </div>
        )}

        {/* Container for message bubble + timestamp - 添加固定宽度和溢出控制 */}
        <div className="relative inline-block max-w-full w-full min-w-0">
          {isImage ? (
            // ========== 图片消息 ==========
            <div className="w-fit"> {/* Ensure image container doesn't force width */}
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
                    className="block max-h-[300px] max-w-full object-contain rounded" // Ensure image is block
                    onError={handleImageError}
                    isBlurred
                  />
                </div>
              )}
            </div>
          ) : (
            // ========== 文本消息（聊天气泡） - MODIFIED ==========
            <Card
              className={`
                rounded-lg shadow-sm max-w-full w-full overflow-hidden
                ${
                  isMine
                    ? "bg-blue-100 dark:bg-blue-900 text-gray-800 dark:text-white"
                    : isAI
                      ? "bg-purple-100 dark:bg-purple-900 text-gray-800 dark:text-white" // Example AI style
                      : "bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-white"
                }
              `}
            >
              {/* 强制约束文本内容宽度 */}
              <div className="p-2 max-w-full">
                {/* 添加更严格的溢出和断词控制 */}
                <div className="text-xs break-words break-all whitespace-pre-wrap overflow-hidden max-w-full">
                  {/* 创建一个额外的容器来约束内部内容 */}
                  <div className="max-w-full overflow-x-auto" style={{ wordBreak: 'break-word', overflowWrap: 'break-word' }}>
                    <MarkdownContent content={message.content} />
                    {/* 为AI消息流添加闪烁光标 */}
                    {isStreaming && (
                      <span className="inline-block w-1.5 h-3 bg-current animate-pulse ml-0.5 align-baseline"></span>
                    )}
                  </div>
                </div>
              </div>
            </Card>
            // ========== END MODIFIED ==========
          )}

          {/* 时间戳 - Placed below the bubble/image */}
          <div
            className={`text-tiny mt-0.5 text-gray-500 dark:text-gray-400 transition-opacity h-3 ${
              isHovered || isStreaming ? "opacity-100" : "opacity-0 md:group-hover:opacity-70"
            } ${isMine ? 'text-right' : 'text-left'}`} // Align timestamp based on sender
            aria-hidden={!isHovered && !isStreaming}
          >
            {formatTime(message.timestamp)}
            {isStreaming && " • Typing..."}
          </div>
        </div> {/* End relative container */}
      </div> {/* End Message Content Area */}

      {/* 自己的头像 */}
      {isMine && !isAI && ( // Don't show avatar for AI assistant itself if isMine=true
        <Avatar
          name={message.avatar?.text || undefined}
          icon={!message.avatar?.text ? <Icon icon="lucide:user" /> : undefined}
          color={getValidColor(message.avatar?.color) || "primary"}
          size="sm"
          classNames={{
            base: "ml-1 flex-shrink-0", // Added flex-shrink-0
          }}
        />
      )}
    </div>
  );
};