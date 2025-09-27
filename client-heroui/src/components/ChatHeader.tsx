import React from 'react';
import { Button, Dropdown, DropdownTrigger, DropdownMenu, DropdownItem, Popover, PopoverTrigger, PopoverContent, Tooltip } from '@heroui/react';
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
  handleClearChatMessages: () => void;
  handleDeleteRoom: (roomId: string) => void;
  clientId: string;
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
  clearRoomUrlParam,
  handleClearChatMessages,
  handleDeleteRoom,
  clientId
}) => {
  const { t } = useTranslation();
  const isSaved = isRoomSaved(currentRoom.id);

  const onConfirmLeave = () => {
    handleLeaveRoom();
    setView('rooms');
    clearRoomUrlParam();
  };

  return (
    <div className="flex justify-between items-center p-2 border-b border-violet-100 dark:border-gray-800">
      <div className="flex items-center">
        <Button
          isIconOnly
          variant="light"
          aria-label={t('ariaLabelBack')}
          onPress={() => {
            setView("rooms");
            clearRoomUrlParam();
          }}
          className="mr-2 text-violet-500"
        >
          <Icon icon="lucide:chevron-left" width={24} />
        </Button>
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-lg font-semibold truncate max-w-[150px]">{currentRoom.name}</h2>
          <span className="text-default-300">|</span>
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
      <div className="flex items-center">
        <Dropdown placement="top-end">
          <DropdownTrigger>
            <Button isIconOnly variant="light" aria-label={t('ariaLabelRoomActions')}>
              <Icon icon="lucide:more-vertical" width={20} className="md:w-5 w-4" />
            </Button>
          </DropdownTrigger>
          <DropdownMenu aria-label={t('ariaLabelRoomActions')}>
            <DropdownItem key="copyId" startContent={<Icon icon="lucide:copy" />} onPress={() => handleCopyToClipboard(currentRoom.id)}>
              {t('copyRoomIdAction')}
            </DropdownItem>
            <DropdownItem key="share" startContent={<Icon icon="lucide:share-2" />} onPress={handleShareRoom}>
              {t('share')}
            </DropdownItem>
            <DropdownItem 
              key="save" 
              startContent={<Icon icon={isSaved ? "lucide:bookmark-minus" : "lucide:bookmark-plus"} />} 
              onPress={handleToggleSave}
              className={isSaved ? "text-warning-600 dark:text-warning-500" : ""}
            >
              {isSaved ? t('unsave') : t('saveAction')}
            </DropdownItem>
            <DropdownItem 
              key="clearChat" 
              className="text-danger" 
              color="danger" 
              startContent={<Icon icon="lucide:eraser" />} 
              onPress={handleClearChatMessages}
            >
              {t('clearChatHistory')}
            </DropdownItem>
            <DropdownItem 
              key="leave" 
              className="text-danger" 
              color="danger" 
              startContent={<Icon icon="lucide:log-out" />} 
              onPress={onConfirmLeave}
            >
              {t('leave')}
            </DropdownItem>

            {currentRoom.creatorId === clientId ? (
              <DropdownItem key="deleteRoom" className="text-danger" color="danger" startContent={<Icon icon="lucide:trash-2" />} closeOnSelect={false}>
                <Popover placement="left">
                  <PopoverTrigger>
                    <span>{t('deleteRoom')}</span>
                  </PopoverTrigger>
                  <PopoverContent className="p-2">
                    <div className="text-sm font-medium mb-2">{t('confirmDeleteRoomTitle')}</div>
                    <p className="text-xs text-default-500 mb-3">{t('confirmDeleteRoomDescription', { roomName: currentRoom.name })}</p>
                    <Button size="sm" color="danger" onPress={() => handleDeleteRoom(currentRoom.id)} className="w-full">
                      {t('delete')}
                    </Button>
                  </PopoverContent>
                </Popover>
              </DropdownItem>
            ) : null}
          </DropdownMenu>
        </Dropdown>
      </div>
    </div>
  );
}; 