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
    className={`group flex items-start ${isMine ? "justify-end" : "justify-start"} mb-1`}
    onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* 对方的头像 */}
      {!isMine && (
        <Avatar
          name={message.avatar?.text || undefined}
          icon={!message.avatar?.text ? <Icon icon="lucide:user" /> : undefined}
          color={getValidColor(message.avatar?.color)}
          classNames={{
            base: "mr-2",
          }}
        />
      )}

      <div className={`max-w-[75%] sm:max-w-[60%]`}>
        {/* 显示对方用户名 */}
        {!isMine && message.username && (
          <div className="text-tiny text-default-500 mb-1 ml-1">{message.username}</div>
        )}

        {/* 添加一个高度固定的容器来包裹消息内容和时间戳 */}
        <div className="relative">
          {isImage ? (
            // ========== 图片消息 ==========
            <div className="w-fit">
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
                      : message.content}                    alt="Shared image"
                    className="max-h-[300px] max-w-full object-contain rounded"
                    onError={handleImageError}
                    isBlurred
                  />
                </div>
              )}
            </div>
          ) : (
            // ========== 文本消息（聊天气泡） ==========
            <Card
              className={`
                rounded-lg shadow-sm max-w-full overflow-visible
                ${
                  isMine
                    ? "bg-blue-100 dark:bg-blue-900 text-gray-800 dark:text-white"
                    : "bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-white"
                }
              `}
            >
              <div className="p-3">
                <div className="text-sm whitespace-pre-wrap">
                  <MarkdownContent content={message.content} />
                </div>
              </div>
            </Card>
          )}

          {/* 时间戳 - 始终保持占位，仅改变可见性 */}
          <div
            className={`text-tiny mt-1 text-gray-500 dark:text-gray-400 transition-opacity h-4 ${
              isHovered ? "opacity-100" : "opacity-0 md:group-hover:opacity-70"
            }`}
            aria-hidden={!isHovered}
          >
            {formatTime(message.timestamp)}
          </div>
        </div>
      </div>

      {/* 自己的头像 */}
      {isMine && (
        <Avatar
          name={message.avatar?.text || undefined}
          icon={!message.avatar?.text ? <Icon icon="lucide:user" /> : undefined}
          color={getValidColor(message.avatar?.color) || "primary"}
          classNames={{
            base: "ml-2",
          }}
        />
      )}
    </div>
  );
};