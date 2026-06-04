import React, { useState } from 'react';
import { Button, Dropdown, DropdownTrigger, DropdownMenu, DropdownItem, Popover, PopoverTrigger, PopoverContent, Tooltip } from '@heroui/react';
import { Icon } from "@iconify/react";
import { useTranslation } from "react-i18next";
import { Room, RoomRenameHandler } from "../utils/types";
import { RoomRenameModal } from './RoomRenameModal';

interface ChatHeaderProps {
  currentRoom: Room;
  memberCount: number;
  handleCopyToClipboard: (text: string) => void;
  handleShareRoom: () => void;
  handleToggleSave: () => void;
  handleLeaveRoom: () => void;
  isRoomSaved: (roomId: string) => boolean;
  setView: (view: "chat" | "rooms" | "saved" | "settings") => void;
  clearRoomUrlParam: () => void;
  handleClearChatMessages: () => void;
  handleDeleteRoom: (roomId: string) => void;
  handleRenameRoom: RoomRenameHandler;
  clientId: string;
}

export const ChatHeader: React.FC<ChatHeaderProps> = ({
  currentRoom,
  memberCount,
  handleCopyToClipboard,
  handleShareRoom,
  handleToggleSave,
  handleLeaveRoom,
  isRoomSaved,
  setView,
  clearRoomUrlParam,
  handleClearChatMessages,
  handleDeleteRoom,
  handleRenameRoom,
  clientId
}) => {
  const { t } = useTranslation();
  const isSaved = isRoomSaved(currentRoom.id);
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const canRename = currentRoom.creatorId === clientId;

  const onConfirmLeave = () => {
    handleLeaveRoom();
    setView('rooms');
    clearRoomUrlParam();
  };

  return (
    <>
    <div className="safe-top flex items-center justify-between border-b border-[#dedbd0] bg-[#faf9f5]/90 px-2 py-1 backdrop-blur-md dark:border-[#30302e] dark:bg-[#1d1d1b]/90 md:min-h-16 md:px-4">
      <div className="flex min-w-0 flex-1 items-center pr-1">
        <Button
          isIconOnly
          variant="light"
          aria-label={t('ariaLabelBack')}
          onPress={() => {
            setView("rooms");
            clearRoomUrlParam();
          }}
          className="mr-1 h-8 w-8 min-w-8 rounded-lg text-[#c96442] dark:text-[#d97757] md:hidden"
        >
          <Icon icon="lucide:chevron-left" className="h-5 w-5" />
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap">
          <h2 data-testid="chat-room-title" className="w-[38vw] max-w-[148px] flex-shrink-0 truncate font-serif text-base font-medium leading-tight text-[#141413] dark:text-[#faf9f5] md:w-[360px] md:max-w-[360px] md:text-lg">{currentRoom.name}</h2>
          <div className="flex flex-shrink-0 items-center text-xs text-[#5e5d59] dark:text-[#b0aea5]" data-testid="room-member-count">
            <Icon icon="lucide:users" className="mr-1" width={14} />
            {memberCount}
          </div>
          <div
            className="flex min-w-0 cursor-pointer items-center rounded-md px-1 text-xs text-[#5e5d59] transition-colors hover:bg-[#e8e6dc] dark:text-[#b0aea5] dark:hover:bg-[#30302e]"
            onClick={() => handleCopyToClipboard(currentRoom.id)}
          >
            <Icon icon="lucide:hash" className="mr-1 flex-shrink-0" width={14} />
            <Tooltip content={t("clickToCopyRoomId")}>
              <span className="truncate">
                {currentRoom.id.length > 10 ? `${currentRoom.id.substring(0, 8)}...` : currentRoom.id}
              </span>
            </Tooltip>
            <Icon icon="lucide:copy" className="ml-1 flex-shrink-0 text-[#87867f] dark:text-[#b0aea5]" width={12} />
          </div>
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        <Tooltip content={isSaved ? t('unsave') : t('saveAction')}>
          <Button
            size="sm"
            variant={isSaved ? 'flat' : 'light'}
            onPress={handleToggleSave}
            aria-label={`${isSaved ? t('unsave') : t('saveAction')} ${t('room')}`}
            className={`hidden rounded-lg px-3 md:inline-flex ${
              isSaved
                ? 'bg-[#e8e6dc] text-[#4d4c48] dark:bg-[#30302e] dark:text-[#faf9f5]'
                : 'text-[#5e5d59] data-[hover=true]:bg-[#e8e6dc] dark:text-[#b0aea5] dark:data-[hover=true]:bg-[#30302e]'
            }`}
            startContent={<Icon icon={isSaved ? 'lucide:bookmark-check' : 'lucide:bookmark-plus'} className="h-4 w-4" />}
          >
            {isSaved ? t('savedRooms') : t('saveAction')}
          </Button>
        </Tooltip>
        <Dropdown placement="top-end">
          <DropdownTrigger>
            <Button isIconOnly variant="light" aria-label={t('ariaLabelRoomActions')} className="rounded-lg text-[#5e5d59] dark:text-[#b0aea5]">
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
            {canRename ? (
              <DropdownItem key="renameRoom" startContent={<Icon icon="lucide:pencil" />} onPress={() => setIsRenameOpen(true)}>
                {t('renameRoom')}
              </DropdownItem>
            ) : null}
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
    <RoomRenameModal
      isOpen={isRenameOpen}
      room={currentRoom}
      onClose={() => setIsRenameOpen(false)}
      onRename={handleRenameRoom}
    />
    </>
  );
};
