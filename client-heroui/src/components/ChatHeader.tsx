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
    <div className="safe-top flex items-center justify-between border-b border-[#dedbd0] bg-[#faf9f5]/90 p-2 backdrop-blur-md dark:border-[#30302e] dark:bg-[#1d1d1b]/90">
      <div className="flex min-w-0 items-center">
        <Button
          isIconOnly
          variant="light"
          aria-label={t('ariaLabelBack')}
          onPress={() => {
            setView("rooms");
            clearRoomUrlParam();
          }}
          className="mr-2 rounded-xl text-[#c96442] dark:text-[#d97757]"
        >
          <Icon icon="lucide:chevron-left" width={24} />
        </Button>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 data-testid="chat-room-title" className="max-w-[150px] truncate font-serif text-lg font-medium leading-tight text-[#141413] dark:text-[#faf9f5]">{currentRoom.name}</h2>
          <span className="text-[#c2c0b6]">|</span>
          <div className="flex flex-wrap items-center gap-2 text-xs text-[#5e5d59] dark:text-[#b0aea5]">
            <div className="flex items-center">
              <Icon icon="lucide:users" className="mr-1" width={14} />
              {memberCount}
              {memberEvent && (
                <span className="ml-1 inline-flex items-center gap-1 text-tiny animate-fade-in">
                  <Icon icon={memberEvent.type === "join" ? "lucide:user-plus" : "lucide:user-minus"} width={12} />
                  {memberEvent.userId.substring(0, 4)}...
                </span>
              )}
            </div>
            <div
              className="flex cursor-pointer items-center rounded-md px-1 transition-colors hover:bg-[#e8e6dc] dark:hover:bg-[#30302e]"
              onClick={() => handleCopyToClipboard(currentRoom.id)}
            >
              <Icon icon="lucide:hash" className="mr-1" width={14} />
              <Tooltip content={t("clickToCopyRoomId")}>
                <span>
                  {currentRoom.id.length > 10 ? `${currentRoom.id.substring(0, 8)}...` : currentRoom.id}
                </span>
              </Tooltip>
              <Icon icon="lucide:copy" className="ml-1 text-[#87867f] dark:text-[#b0aea5]" width={12} />
            </div>
          </div>
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center">
        <Dropdown placement="top-end">
          <DropdownTrigger>
            <Button isIconOnly variant="light" aria-label={t('ariaLabelRoomActions')} className="rounded-xl text-[#5e5d59] dark:text-[#b0aea5]">
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
                    <p className="mb-3 text-xs text-[#5e5d59] dark:text-[#b0aea5]">{t('confirmDeleteRoomDescription', { roomName: currentRoom.name })}</p>
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
