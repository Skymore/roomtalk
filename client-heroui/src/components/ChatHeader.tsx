import React, { useEffect, useRef, useState } from 'react';
import {
  Button,
  Chip,
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
  Popover,
  PopoverTrigger,
  PopoverContent,
  Tooltip,
} from '@heroui/react';
import { Icon } from "@iconify/react";
import { useTranslation } from "react-i18next";
import { CodeAgentMode, Room, RoomOnlineMember, RoomPermissions, RoomRenameHandler } from "../utils/types";
import { getRoomMembers } from "../utils/socket";
import { RoomSettingsModal } from './RoomSettingsModal';
import { useIsTouchDevice } from "../hooks/useIsTouchDevice";
import { PostingScheduleDetails } from './PostingScheduleDetails';
import { getCodeAgentBackend, getCodeAgentStatus, isSupportedCodeAgentBackend } from '../utils/codeAgent';
import { getCodeAgentStatusClassName, getCodeAgentStatusLabelKey, getSandboxStatusClassName, getSandboxStatusLabelKey } from '../utils/codeAgentRoom';

interface ChatHeaderProps {
  currentRoom: Room;
  memberCount: number | null;
  isRestoringRoom: boolean;
  handleCopyToClipboard: (text: string) => void;
  handleShareRoom: () => void;
  handleToggleSave: () => void;
  handleLeaveRoom: () => void;
  isRoomSaved: (roomId: string) => boolean;
  setView: (view: "chat" | "rooms" | "saved" | "settings") => void;
  clearRoomUrlParam: () => void;
  handleClearChatMessages: (confirmation: string) => unknown;
  handleDeleteRoom: (roomId: string) => void;
  handleRenameRoom: RoomRenameHandler;
  roomPermissions: RoomPermissions | null;
  clientId: string;
  codeAgentAvailableModes?: CodeAgentMode[];
  codeAgentDefaultMode?: CodeAgentMode;
  onRoomUpdated: (room: Room) => void;
}

export const ChatHeader: React.FC<ChatHeaderProps> = ({
  currentRoom,
  memberCount,
  isRestoringRoom,
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
  roomPermissions,
  clientId,
  codeAgentAvailableModes,
  codeAgentDefaultMode,
  onRoomUpdated,
}) => {
  const { t } = useTranslation();
  const isTouchDevice = useIsTouchDevice();
  const isSaved = isRoomSaved(currentRoom.id);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isScheduleOpen, setIsScheduleOpen] = useState(false);
  const [onlineMembers, setOnlineMembers] = useState<RoomOnlineMember[]>([]);
  const [isLoadingMembers, setIsLoadingMembers] = useState(false);
  const [copiedRoomId, setCopiedRoomId] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canManageRoom = Boolean(roomPermissions?.canManageRoom);
  const hasPostingSchedule = Boolean(currentRoom.postingSchedule?.enabled);
  const codeAgentBackend = getCodeAgentBackend(currentRoom);
  const isCodeAgent = codeAgentBackend !== null;
  const isSupportedCodeAgent = isSupportedCodeAgentBackend(codeAgentBackend);
  const agentStatus = getCodeAgentStatus(currentRoom);

  useEffect(() => () => {
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
  }, []);

  const handleCopyRoomId = () => {
    handleCopyToClipboard(currentRoom.id);
    setCopiedRoomId(true);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopiedRoomId(false), 2000);
  };

  const handleMembersOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      return;
    }
    setIsLoadingMembers(true);
    getRoomMembers(currentRoom.id)
      .then(setOnlineMembers)
      .catch(() => setOnlineMembers([]))
      .finally(() => setIsLoadingMembers(false));
  };

  const onConfirmLeave = () => {
    handleLeaveRoom();
    setView('rooms');
    clearRoomUrlParam();
  };

  return (
    <>
    <div className="safe-top flex min-h-10 items-center justify-between border-b border-[#dedbd0] bg-[#faf9f5]/90 px-2 py-0.5 backdrop-blur-md dark:border-[#30302e] dark:bg-[#1d1d1b]/90 md:min-h-16 md:px-4 md:py-1">
      <div className="flex min-w-0 flex-1 items-center pr-1">
        <Button
          isIconOnly
          variant="light"
          aria-label={t('ariaLabelBack')}
          onPress={() => {
            setView("rooms");
            clearRoomUrlParam();
          }}
          className="mr-1 h-7 w-7 min-w-7 rounded-lg text-[#c96442] dark:text-[#d97757] md:hidden"
        >
          <Icon icon="lucide:chevron-left" className="h-4 w-4" />
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap">
          {isRestoringRoom ? (
            <Icon icon="lucide:loader-circle" className="h-4 w-4 flex-shrink-0 animate-spin text-[#c96442] dark:text-[#d97757]" />
          ) : null}
          <h2 data-testid="chat-room-title" className="w-[38vw] max-w-[148px] flex-shrink-0 truncate font-serif text-base font-medium leading-tight text-[#141413] dark:text-[#faf9f5] md:w-[360px] md:max-w-[360px] md:text-lg">{currentRoom.name}</h2>
          {isCodeAgent && (
            <Chip
              size="sm"
              variant="flat"
              startContent={<Icon icon="lucide:terminal" className="h-3 w-3" />}
              classNames={{
                base: 'hidden h-6 flex-shrink-0 border border-[#c96442]/40 bg-[#c96442]/10 px-1.5 text-[#a34d32] dark:text-[#f0a487] sm:inline-flex',
                content: 'px-0 text-[11px] font-semibold',
              }}
            >
              {t('codeAgentRoomType')}
            </Chip>
          )}
          <Popover placement="bottom-start" onOpenChange={handleMembersOpenChange}>
            <PopoverTrigger>
              <button
                type="button"
                data-testid="room-member-count"
                aria-label={t('onlineMembers')}
                className="flex flex-shrink-0 items-center rounded-md px-1 text-xs text-[#5e5d59] transition-colors hover:bg-[#e8e6dc] dark:text-[#b0aea5] dark:hover:bg-[#30302e]"
              >
                <Icon icon="lucide:users" className="mr-1" width={14} />
                {memberCount ?? "..."}
              </button>
            </PopoverTrigger>
            <PopoverContent className="max-h-64 w-52 items-stretch overflow-y-auto p-2">
              <div className="mb-1 px-1 text-xs font-medium text-[#5e5d59] dark:text-[#b0aea5]">
                {t('onlineMembers')}{memberCount != null ? ` (${memberCount})` : ''}
              </div>
              {isLoadingMembers ? (
                <div className="flex items-center justify-center py-3">
                  <Icon icon="lucide:loader-circle" className="h-4 w-4 animate-spin text-[#c96442] dark:text-[#d97757]" />
                </div>
              ) : onlineMembers.length === 0 ? (
                <div className="px-1 py-2 text-xs text-[#87867f] dark:text-[#b0aea5]">{t('noOnlineMembers')}</div>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {onlineMembers.map((member) => (
                    <li
                      key={member.clientId}
                      className="flex items-center gap-2 rounded-md px-1 py-1 text-sm text-[#141413] dark:text-[#faf9f5]"
                    >
                      <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#3aa76d]" />
                      <span className="truncate">
                        {member.nickname || t('anonymousUser')}
                        {member.clientId === clientId ? ` (${t('you')})` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </PopoverContent>
          </Popover>
          <Tooltip
            content={copiedRoomId ? t('copied') : t('clickToCopyRoomId')}
            isOpen={copiedRoomId ? true : undefined}
            isDisabled={isTouchDevice && !copiedRoomId}
          >
            <div
              role="button"
              tabIndex={0}
              aria-label={t('clickToCopyRoomId')}
              className="flex min-w-0 cursor-pointer items-center rounded-md px-1 text-xs text-[#5e5d59] transition-colors hover:bg-[#e8e6dc] dark:text-[#b0aea5] dark:hover:bg-[#30302e]"
              onClick={handleCopyRoomId}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  handleCopyRoomId();
                }
              }}
            >
              <Icon icon="lucide:hash" className="mr-1 flex-shrink-0" width={14} />
              <span className="truncate">
                {currentRoom.id.length > 10 ? `${currentRoom.id.substring(0, 8)}...` : currentRoom.id}
              </span>
              <Icon
                icon={copiedRoomId ? 'lucide:check' : 'lucide:copy'}
                className={`ml-1 flex-shrink-0 transition-colors ${copiedRoomId ? 'text-[#3aa76d]' : 'text-[#87867f] dark:text-[#b0aea5]'}`}
                width={12}
              />
            </div>
          </Tooltip>
          {isSupportedCodeAgent && (
            <div className="hidden min-w-0 flex-wrap items-center gap-1 md:flex">
              <span className={`inline-flex max-w-[120px] items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${getSandboxStatusClassName(currentRoom.sandboxStatus)}`}>
                <Icon icon="lucide:box" className="h-3 w-3 flex-shrink-0" />
                <span className="truncate">{t(getSandboxStatusLabelKey(currentRoom.sandboxStatus))}</span>
              </span>
              <span className={`inline-flex max-w-[120px] items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${getCodeAgentStatusClassName(agentStatus)}`}>
                <Icon icon="lucide:bot" className="h-3 w-3 flex-shrink-0" />
                <span className="truncate">{t(getCodeAgentStatusLabelKey(agentStatus))}</span>
              </span>
            </div>
          )}
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
            <Button isIconOnly variant="light" aria-label={t('ariaLabelRoomActions')} className="h-7 w-7 min-w-7 rounded-lg text-[#5e5d59] dark:text-[#b0aea5] md:h-9 md:w-9 md:min-w-9">
              <Icon icon="lucide:more-vertical" className="h-4 w-4 md:h-5 md:w-5" />
            </Button>
          </DropdownTrigger>
          <DropdownMenu aria-label={t('ariaLabelRoomActions')}>
            <DropdownItem key="share" startContent={<Icon icon="lucide:share-2" />} onPress={handleShareRoom}>
              {t('share')}
            </DropdownItem>
            {hasPostingSchedule ? (
              <DropdownItem key="postingSchedule" startContent={<Icon icon="lucide:calendar-clock" />} onPress={() => setIsScheduleOpen(true)}>
                {t('postingScheduleDetails')}
              </DropdownItem>
            ) : null}
            {canManageRoom ? (
              <DropdownItem key="roomSettings" startContent={<Icon icon="lucide:settings-2" />} onPress={() => setIsSettingsOpen(true)}>
                {t('settings')}
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
              key="leave"
              className="text-danger"
              color="danger"
              startContent={<Icon icon="lucide:log-out" />}
              onPress={onConfirmLeave}
            >
              {t('leave')}
            </DropdownItem>
          </DropdownMenu>
        </Dropdown>
      </div>
    </div>
    <RoomSettingsModal
      isOpen={isSettingsOpen}
      room={currentRoom}
      roomPermissions={roomPermissions}
      clientId={clientId}
      onClose={() => setIsSettingsOpen(false)}
      onRenameRoom={handleRenameRoom}
      onClearHistory={handleClearChatMessages}
      onDeleteRoom={handleDeleteRoom}
      codeAgentAvailableModes={codeAgentAvailableModes}
      codeAgentDefaultMode={codeAgentDefaultMode}
      onRoomUpdated={onRoomUpdated}
    />
    <Modal isOpen={isScheduleOpen} onClose={() => setIsScheduleOpen(false)} size="sm">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          {t('postingScheduleDetails')}
          <span className="text-xs font-normal text-[#87867f] dark:text-[#b0aea5]">{currentRoom.name}</span>
        </ModalHeader>
        <ModalBody className="pb-5 pt-0">
          <PostingScheduleDetails postingSchedule={currentRoom.postingSchedule} showTitle={false} />
        </ModalBody>
      </ModalContent>
    </Modal>
    </>
  );
};
