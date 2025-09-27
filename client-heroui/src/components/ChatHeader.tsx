import React from 'react';
import { Button, Tooltip } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useTranslation } from "react-i18next";
import { Room } from "../utils/types";

interface ChatHeaderProps {
  currentRoom: Room;
  memberCount: number;
  memberEvent: { type: "join" | "leave"; userId: string } | null;
  handleCopyToClipboard: (text: string) => void;
  handleShareRoom: () => void;
  handleToggleSave: () => void;
  handleLeaveRoom: () => void;
  isRoomSaved: (roomId: string) => boolean;
  setView: (view: "chat" | "rooms" | "saved" | "settings") => void;
  clearRoomUrlParam: () => void;
}

export const ChatHeader: React.FC<ChatHeaderProps> = ({
  currentRoom,
  memberCount,
  memberEvent,
  handleCopyToClipboard,
  handleShareRoom,
  handleToggleSave,
  handleLeaveRoom,
  isRoomSaved,
  setView,
  clearRoomUrlParam
}) => {
  const { t } = useTranslation();

  return (
    <div className="flex justify-between items-center p-2 border-b border-violet-100 dark:border-gray-800">
      <div className="flex items-center">
        <Button
          isIconOnly
          variant="light"
          aria-label="Back"
          onPress={() => {
            setView("rooms");
            clearRoomUrlParam();
          }}
          className="mr-2 text-violet-500"
        >
          <Icon icon="lucide:chevron-left" width={24} />
        </Button>
        <div>
          <h2 className="text-xl font-bold truncate max-w-[150px]">{currentRoom.name}</h2>
          <div className="flex flex-wrap items-center gap-2 text-xs text-default-500">
            <div className="flex items-center">
              <Icon icon="lucide:users" className="mr-1" width={14} />
              {memberCount}
              {memberEvent && (
                <span className="ml-1 text-tiny animate-fade-in">
                  {memberEvent.type === "join" ? "🎉" : "🚶"} {memberEvent.userId.substring(0, 4)}...
                </span>
              )}
            </div>
            <div
              className="flex items-center cursor-pointer"
              onClick={() => handleCopyToClipboard(currentRoom.id)}
            >
              <Icon icon="lucide:hash" className="mr-1" width={14} />
              <Tooltip content={t("clickToCopyRoomId")}>
                <span>
                  {currentRoom.id.length > 10 ? `${currentRoom.id.substring(0, 8)}...` : currentRoom.id}
                </span>
              </Tooltip>
              <Icon icon="lucide:copy" className="ml-1 text-default-400" width={12} />
            </div>
          </div>
        </div>
      </div>
      <div className="flex">
        <Button
          isIconOnly
          variant="light"
          aria-label="Share"
          onPress={handleShareRoom}
          className="mr-1 md:w-10 md:h-10 w-8 h-8 text-violet-500"
        >
          <Icon icon="lucide:share" width={20} className="md:w-5 w-4" />
        </Button>
        <Button
          isIconOnly
          variant="light"
          aria-label="Save"
          onPress={handleToggleSave}
          className={`${isRoomSaved(currentRoom.id) ? "text-amber-500" : "text-violet-500"} mr-1 md:w-10 md:h-10 w-8 h-8`}
        >
          <Icon
            icon={isRoomSaved(currentRoom.id) ? "lucide:bookmark-minus" : "lucide:bookmark-plus"}
            width={20}
            className="md:w-5 w-4"
          />
        </Button>
        <Button
          isIconOnly
          variant="light"
          aria-label="Leave"
          onPress={handleLeaveRoom}
          className="text-rose-500 md:w-10 md:h-10 w-8 h-8"
        >
          <Icon icon="lucide:log-out" width={20} className="md:w-5 w-4" />
        </Button>
      </div>
    </div>
  );
}; 