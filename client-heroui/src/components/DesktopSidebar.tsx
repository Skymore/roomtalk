import React, { useState } from 'react';
import {
  Avatar,
  Button,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Tooltip,
} from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { AppView } from '../utils/appPersistence';
import { formatDate } from '../utils/formatters';
import { getLanguageOption, languageOptions } from '../utils/languages';
import { buildRoomShareUrl, getRoomActivityAt, validateRoomName } from '../utils/roomState';
import { createRoom } from '../utils/socket';
import { Room, RoomRenameHandler, RoomType } from '../utils/types';
import { getAvatarColor, getAvatarText } from '../utils/userProfile';
import { RoomCreateModal } from './RoomCreateModal';
import { RoomRenameModal } from './RoomRenameModal';

interface DesktopSidebarProps {
  clientId: string;
  username: string;
  view: AppView;
  setView: (view: AppView) => void;
  rooms: Room[];
  savedRooms: Room[];
  currentRoom: Room | null;
  i18n: any;
  changeLanguage: (lang: string) => void;
  toggleTheme: () => void;
  isDark: boolean;
  handleCopyToClipboard: (text: string) => void;
  onRoomSelect: (roomId: string) => void;
  onDeleteRoom: (roomId: string) => void;
  onUnsaveRoom: (roomId: string) => void;
  onRenameRoom: RoomRenameHandler;
  isCocoEnabled: boolean;
}

interface SidebarNavItemProps {
  icon: string;
  label: string;
  isActive: boolean;
  onPress: () => void;
  isDisabled?: boolean;
  isCollapsed?: boolean;
}

const SidebarNavItem: React.FC<SidebarNavItemProps> = ({
  icon,
  label,
  isActive,
  onPress,
  isDisabled,
  isCollapsed,
}) => {
  const button = (
    <Button
      fullWidth={!isCollapsed}
      isIconOnly={isCollapsed}
      size="sm"
      variant="light"
      onPress={onPress}
      isDisabled={isDisabled}
      aria-label={label}
      className={`${isCollapsed ? 'h-10 w-10 min-w-10 justify-center px-0' : 'h-10 justify-start px-3'} rounded-lg text-sm font-medium ${
      isActive
        ? '!bg-[#c96442] !text-[#faf9f5] shadow-[0_0_0_1px_#c96442]'
        : 'text-[#5e5d59] data-[hover=true]:bg-[#e8e6dc] dark:text-[#b0aea5] dark:data-[hover=true]:bg-[#30302e]'
      }`}
      startContent={!isCollapsed ? <Icon icon={icon} className="h-4 w-4" /> : undefined}
    >
      {isCollapsed ? <Icon icon={icon} className="h-4 w-4" /> : label}
    </Button>
  );

  return isCollapsed ? (
    <Tooltip content={label} placement="right">
      {button}
    </Tooltip>
  ) : button;
};

interface SidebarRoomRowProps {
  clientId: string;
  room: Room;
  isActive: boolean;
  icon: string;
  isCollapsed: boolean;
  onPress: () => void;
  onCopyRoomId: (roomId: string) => void;
  onShareRoom: (room: Room) => void;
  onRenameRoom?: (room: Room) => void;
  onDeleteRoom?: (room: Room) => void;
  onUnsaveRoom?: (room: Room) => void;
}

const SidebarRoomRow: React.FC<SidebarRoomRowProps> = ({
  clientId,
  room,
  isActive,
  icon,
  isCollapsed,
  onPress,
  onCopyRoomId,
  onShareRoom,
  onRenameRoom,
  onDeleteRoom,
  onUnsaveRoom,
}) => {
  const { t, i18n } = useTranslation();
  const activityAt = getRoomActivityAt(room);
  const canManageRoom = room.creatorId === clientId;

  if (isCollapsed) {
    return (
      <Tooltip content={room.name} placement="right">
        <button
          type="button"
          onClick={onPress}
          aria-label={`${t('room')}: ${room.name}`}
          className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
            isActive
              ? 'bg-[#c96442] text-[#faf9f5]'
              : 'text-[#c96442] hover:bg-[#e8e6dc] dark:text-[#d97757] dark:hover:bg-[#30302e]'
          }`}
        >
          <Icon icon={icon} className="h-4 w-4" />
        </button>
      </Tooltip>
    );
  }

  return (
    <div
      className={`group flex w-full min-w-0 items-start gap-1 rounded-lg pr-1 transition-colors ${
        isActive
          ? 'bg-[#e8e6dc] text-[#141413] dark:bg-[#30302e] dark:text-[#faf9f5]'
          : 'text-[#5e5d59] hover:bg-[#f0eee6] dark:text-[#b0aea5] dark:hover:bg-[#242422]'
      }`}
    >
      <button
        type="button"
        onClick={onPress}
        className="flex min-w-0 flex-1 items-start gap-2 rounded-lg px-2.5 py-2 text-left"
      >
        <span
          className={`mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg ${
            isActive
              ? 'bg-[#c96442] text-[#faf9f5]'
              : 'bg-[#e8e6dc] text-[#c96442] dark:bg-[#30302e] dark:text-[#d97757]'
          }`}
        >
          <Icon icon={icon} className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium leading-5">{room.name}</span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-[#87867f] dark:text-[#8f8d86]">
            <Icon icon="lucide:hash" className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{room.id.length > 10 ? `${room.id.slice(0, 8)}...` : room.id}</span>
            {activityAt && (
              <>
                <span className="text-[#c2c0b6] dark:text-[#4d4c48]">·</span>
                <span className="truncate">{formatDate(activityAt, i18n.language)}</span>
              </>
            )}
          </span>
          {room.description && (
            <span className="mt-1 block truncate text-xs text-[#87867f] dark:text-[#8f8d86]">
              {room.description}
            </span>
          )}
        </span>
        <span className="sr-only">{t('room')}</span>
      </button>

      <span className="mt-1.5 flex flex-shrink-0 items-center gap-0.5 opacity-80 transition-opacity group-hover:opacity-100">
        <Tooltip content={t('copyRoomId')}>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            aria-label={`${t('copyRoomId')} ${room.id}`}
            className="h-7 w-7 min-w-7 rounded-md text-[#87867f] hover:text-[#141413] dark:text-[#8f8d86] dark:hover:text-[#faf9f5]"
            onPress={() => onCopyRoomId(room.id)}
          >
            <Icon icon="lucide:copy" className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
        <Tooltip content={t('share')}>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            aria-label={`${t('share')} ${room.id}`}
            className="h-7 w-7 min-w-7 rounded-md text-[#87867f] hover:text-[#141413] dark:text-[#8f8d86] dark:hover:text-[#faf9f5]"
            onPress={() => onShareRoom(room)}
          >
            <Icon icon="lucide:share-2" className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
        {onUnsaveRoom && (
          <Tooltip content={t('unsave')}>
            <Button
              isIconOnly
              size="sm"
              variant="light"
              aria-label={`${t('unsave')} ${room.id}`}
              className="h-7 w-7 min-w-7 rounded-md text-[#87867f] hover:text-[#141413] dark:text-[#8f8d86] dark:hover:text-[#faf9f5]"
              onPress={() => onUnsaveRoom(room)}
            >
              <Icon icon="lucide:bookmark-minus" className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
        )}
        {canManageRoom && !onUnsaveRoom && onRenameRoom && onDeleteRoom && (
          <>
            <Tooltip content={t('editRoomName')}>
              <Button
                isIconOnly
                size="sm"
                variant="light"
                aria-label={`${t('editRoomName')} ${room.id}`}
                className="h-7 w-7 min-w-7 rounded-md text-[#87867f] hover:text-[#141413] dark:text-[#8f8d86] dark:hover:text-[#faf9f5]"
                onPress={() => onRenameRoom(room)}
              >
                <Icon icon="lucide:pencil" className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
            <Tooltip content={t('deleteRoom')}>
              <Button
                isIconOnly
                size="sm"
                variant="light"
                color="danger"
                aria-label={`${t('removeRoomFromSidebar')} ${room.id}`}
                className="h-7 w-7 min-w-7 rounded-md text-danger-500"
                onPress={() => onDeleteRoom(room)}
              >
                <Icon icon="lucide:trash-2" className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
          </>
        )}
      </span>
    </div>
  );
};

export const DesktopSidebar: React.FC<DesktopSidebarProps> = ({
  clientId,
  username,
  view,
  setView,
  rooms,
  savedRooms,
  currentRoom,
  i18n,
  changeLanguage,
  toggleTheme,
  isDark,
  handleCopyToClipboard,
  onRoomSelect,
  onDeleteRoom,
  onUnsaveRoom,
  onRenameRoom,
  isCocoEnabled,
}) => {
  const { t } = useTranslation();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [joinRoomId, setJoinRoomId] = useState('');
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newRoomName, setNewRoomName] = useState('');
  const [newRoomDescription, setNewRoomDescription] = useState('');
  const [newRoomType, setNewRoomType] = useState<RoomType>('chat');
  const [nameError, setNameError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [roomToDelete, setRoomToDelete] = useState<Room | null>(null);
  const [roomToRename, setRoomToRename] = useState<Room | null>(null);
  const currentLanguage = getLanguageOption(i18n.language);

  const handleJoinRoom = () => {
    const trimmedRoomId = joinRoomId.trim();
    if (!trimmedRoomId) return;
    onRoomSelect(trimmedRoomId);
    setJoinRoomId('');
  };

  const openCreateModal = () => {
    setNewRoomName(`${username}'s Room`);
    setNewRoomDescription('');
    setNewRoomType('chat');
    setNameError(null);
    setCreateError(null);
    setIsCreateOpen(true);
  };

  const closeCreateModal = () => {
    if (isCreating) return;
    setIsCreateOpen(false);
  };

  const handleRoomNameChange = (value: string) => {
    setNewRoomName(value);
    setNameError(null);
    setCreateError(null);
  };

  const handleCreateRoom = async () => {
    const validation = validateRoomName(newRoomName);

    if (!validation.ok) {
      setNameError(t(validation.errorKey));
      return;
    }

    setNameError(null);
    setCreateError(null);
    setIsCreating(true);
    try {
      const roomId = await createRoom(validation.name, newRoomDescription, isCocoEnabled ? newRoomType : 'chat');
      setNewRoomName('');
      setNewRoomDescription('');
      setNewRoomType('chat');
      setIsCreateOpen(false);
      onRoomSelect(roomId as string);
    } catch (error) {
      console.error('Error creating room from sidebar:', error);
      setCreateError(error instanceof Error ? error.message : t('createRoomFailed'));
    } finally {
      setIsCreating(false);
    }
  };

  const handleShareRoom = (room: Room) => {
    const roomUrl = buildRoomShareUrl(window.location.origin, window.location.pathname, room.id);
    handleCopyToClipboard(roomUrl);
  };

  const handleConfirmDeleteRoom = () => {
    if (roomToDelete) {
      onDeleteRoom(roomToDelete.id);
      setRoomToDelete(null);
    }
  };

  return (
    <>
      <aside
        className={`hidden h-full flex-shrink-0 flex-col border-r border-[#dedbd0] bg-[#faf9f5] transition-[width] duration-200 dark:border-[#30302e] dark:bg-[#1d1d1b] md:flex ${
          isCollapsed ? 'w-[72px]' : 'w-[320px] xl:w-[348px]'
        }`}
      >
        <div
          className={`flex h-16 flex-shrink-0 items-center border-b border-[#dedbd0] dark:border-[#30302e] ${
            isCollapsed ? 'justify-center gap-1 px-2' : 'justify-between px-4'
          }`}
        >
          <button
            type="button"
            onClick={() => currentRoom ? setView('chat') : setView('rooms')}
            className="flex min-w-0 items-center gap-2 rounded-lg text-left"
          >
            <img src="/roomtalk-logo.svg" alt="RoomTalk Logo" className="h-8 w-8 flex-shrink-0" />
            {!isCollapsed && (
              <span className="truncate font-serif text-base font-medium text-[#141413] dark:text-[#faf9f5]">
                RoomTalk
              </span>
            )}
          </button>

          <Tooltip content={isCollapsed ? t('expandSidebar') : t('collapseSidebar')} placement="right">
            <Button
              isIconOnly
              size="sm"
              variant="light"
              aria-label={isCollapsed ? t('expandSidebar') : t('collapseSidebar')}
              onPress={() => setIsCollapsed((collapsed) => !collapsed)}
              className="h-8 w-8 min-w-8 rounded-lg text-[#5e5d59] dark:text-[#b0aea5]"
            >
              <Icon icon={isCollapsed ? 'lucide:panel-left-open' : 'lucide:panel-left-close'} className="h-4 w-4" />
            </Button>
          </Tooltip>
        </div>

        <div
          className={`flex flex-shrink-0 flex-col gap-2 border-b border-[#dedbd0] dark:border-[#30302e] ${
            isCollapsed ? 'items-center p-2' : 'p-3'
          }`}
        >
          {isCollapsed ? (
            <>
              <Tooltip content={t('create')} placement="right">
                <Button
                  isIconOnly
                  size="sm"
                  color="secondary"
                  aria-label={t('createRoomFromSidebar')}
                  onPress={openCreateModal}
                  className="h-10 w-10 min-w-10 rounded-lg bg-[#c96442] text-[#faf9f5]"
                >
                  <Icon icon="lucide:plus" className="h-4 w-4" />
                </Button>
              </Tooltip>
              <Tooltip content={t('joinButton')} placement="right">
                <Button
                  isIconOnly
                  size="sm"
                  variant="flat"
                  aria-label={t('expandSidebarToJoinRoom')}
                  onPress={() => setIsCollapsed(false)}
                  className="h-10 w-10 min-w-10 rounded-lg bg-[#e8e6dc] text-[#4d4c48] dark:bg-[#30302e] dark:text-[#faf9f5]"
                >
                  <Icon icon="lucide:log-in" className="h-4 w-4" />
                </Button>
              </Tooltip>
            </>
          ) : (
            <>
              <Button
                fullWidth
                color="secondary"
                aria-label={t('createRoomFromSidebar')}
                onPress={openCreateModal}
                className="h-10 justify-start rounded-lg bg-[#c96442] px-3 text-sm text-[#faf9f5] shadow-[0_0_0_1px_#c96442]"
                startContent={<Icon icon="lucide:plus" className="h-4 w-4" />}
              >
                {t('create')}
              </Button>
              <div className="flex w-full">
                <Input
                  placeholder={t('enterRoomId')}
                  value={joinRoomId}
                  onChange={(event) => setJoinRoomId(event.target.value)}
                  aria-label={t('enterRoomIdInSidebar')}
                  className="min-w-0 flex-1"
                  classNames={{
                    input: 'h-10',
                    inputWrapper: 'h-10 rounded-r-none border border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]',
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') handleJoinRoom();
                  }}
                />
                <Button
                  color="secondary"
                  aria-label={t('joinRoomFromSidebar')}
                  onPress={handleJoinRoom}
                  isDisabled={!joinRoomId.trim()}
                  className="h-10 min-w-[88px] rounded-l-none bg-[#30302e] px-3 text-sm text-[#faf9f5] dark:bg-[#faf9f5] dark:text-[#141413]"
                >
                  {t('joinButton')}
                </Button>
              </div>
            </>
          )}

        </div>

        <div className={`min-h-0 flex-1 overflow-y-auto ${isCollapsed ? 'px-2 py-3' : 'px-3 py-4'}`}>
          <section className={isCollapsed ? 'mb-3' : 'mb-5'}>
            {!isCollapsed && (
              <div className="mb-2 flex items-center justify-between px-1">
                <h2 className="text-xs font-semibold uppercase text-[#87867f] dark:text-[#8f8d86]">
                  {t('rooms')}
                </h2>
                <span className="text-xs text-[#87867f] dark:text-[#8f8d86]">{rooms.length}</span>
              </div>
            )}
            <div className={isCollapsed ? 'flex flex-col items-center gap-1' : 'space-y-1'}>
              {rooms.length > 0 ? (
                rooms.map((room) => (
                  <SidebarRoomRow
                    key={room.id}
                    clientId={clientId}
                    room={room}
                    isActive={currentRoom?.id === room.id && view === 'chat'}
                    icon={room.type === 'coco' ? 'lucide:terminal-square' : 'lucide:message-square'}
                    isCollapsed={isCollapsed}
                    onPress={() => onRoomSelect(room.id)}
                    onCopyRoomId={handleCopyToClipboard}
                    onShareRoom={handleShareRoom}
                    onRenameRoom={setRoomToRename}
                    onDeleteRoom={setRoomToDelete}
                  />
                ))
              ) : !isCollapsed ? (
                <p className="rounded-lg px-2.5 py-2 text-xs leading-5 text-[#87867f] dark:text-[#8f8d86]">
                  {t('noRoomsAvailable')}
                </p>
              ) : null}
            </div>
          </section>

          <section>
            {!isCollapsed && (
              <div className="mb-2 flex items-center justify-between px-1">
                <h2 className="text-xs font-semibold uppercase text-[#87867f] dark:text-[#8f8d86]">
                  {t('savedRooms')}
                </h2>
                <span className="text-xs text-[#87867f] dark:text-[#8f8d86]">{savedRooms.length}</span>
              </div>
            )}
            <div className={isCollapsed ? 'flex flex-col items-center gap-1' : 'space-y-1'}>
              {savedRooms.length > 0 ? (
                savedRooms.map((room) => (
                  <SidebarRoomRow
                    key={room.id}
                    clientId={clientId}
                    room={room}
                    isActive={currentRoom?.id === room.id && view === 'chat'}
                    icon="lucide:bookmark"
                    isCollapsed={isCollapsed}
                    onPress={() => onRoomSelect(room.id)}
                    onCopyRoomId={handleCopyToClipboard}
                    onShareRoom={handleShareRoom}
                    onUnsaveRoom={(savedRoom) => onUnsaveRoom(savedRoom.id)}
                  />
                ))
              ) : !isCollapsed ? (
                <p className="rounded-lg px-2.5 py-2 text-xs leading-5 text-[#87867f] dark:text-[#8f8d86]">
                  {t('noSavedRooms')}
                </p>
              ) : null}
            </div>
          </section>
        </div>

        <div
          className={`flex flex-shrink-0 flex-col border-t border-[#dedbd0] dark:border-[#30302e] ${
            isCollapsed ? 'items-center gap-2 p-2' : 'gap-3 p-3'
          }`}
        >
          {isCollapsed ? (
            <>
              <Tooltip content={username} placement="right">
                <Avatar name={getAvatarText(username)} color={getAvatarColor(username) as any} size="sm" />
              </Tooltip>
              <Tooltip content={t('copyUserId')} placement="right">
                <Button
                  isIconOnly
                  size="sm"
                  variant="flat"
                  onPress={() => handleCopyToClipboard(clientId)}
                  aria-label={`${t('copyUserId')} ${clientId}`}
                  className="h-10 w-10 min-w-10 rounded-lg bg-[#e8e6dc] text-[#4d4c48] dark:bg-[#30302e] dark:text-[#faf9f5]"
                >
                  <Icon icon="lucide:fingerprint" className="h-4 w-4" />
                </Button>
              </Tooltip>
              <SidebarNavItem
                icon="lucide:settings"
                label={t('settings')}
                isActive={view === 'settings'}
                onPress={() => setView('settings')}
                isCollapsed={isCollapsed}
              />
              <Tooltip content={isDark ? t('lightMode') : t('darkMode')} placement="right">
                <Button
                  isIconOnly
                  size="sm"
                  variant="flat"
                  onPress={toggleTheme}
                  aria-label={isDark ? t('switchToLightMode') : t('switchToDarkMode')}
                  className="h-10 w-10 min-w-10 rounded-lg bg-[#e8e6dc] text-[#4d4c48] dark:bg-[#30302e] dark:text-[#faf9f5]"
                >
                  <Icon icon={isDark ? 'lucide:sun' : 'lucide:moon'} className="h-4 w-4" />
                </Button>
              </Tooltip>
            </>
          ) : (
            <>
              <div className="flex min-w-0 items-center gap-2">
                <Avatar name={getAvatarText(username)} color={getAvatarColor(username) as any} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[#141413] dark:text-[#faf9f5]">{username}</p>
                  <p className="truncate text-xs text-[#87867f] dark:text-[#8f8d86]">{t('profile')}</p>
                </div>
                <Tooltip
                  content={
                    <div className="max-w-[240px]">
                      <p className="text-xs font-medium">{t('userId')}</p>
                      <p className="break-all text-[11px] opacity-80">{clientId}</p>
                    </div>
                  }
                >
                  <Button
                    isIconOnly
                    size="sm"
                    variant="flat"
                    onPress={() => handleCopyToClipboard(clientId)}
                    aria-label={`${t('copyUserId')} ${clientId}`}
                    className="h-8 w-8 min-w-8 flex-shrink-0 rounded-lg bg-[#e8e6dc] text-[#5e5d59] dark:bg-[#30302e] dark:text-[#b0aea5]"
                  >
                    <Icon icon="lucide:fingerprint" className="h-3.5 w-3.5" />
                  </Button>
                </Tooltip>
              </div>

              <div className="flex items-center gap-2">
                <Dropdown>
                  <DropdownTrigger>
                    <Button
                      size="sm"
                      variant="flat"
                      className="min-w-0 flex-1 justify-start rounded-lg bg-[#e8e6dc] px-2 text-[#4d4c48] dark:bg-[#30302e] dark:text-[#faf9f5]"
                      startContent={<Icon icon="lucide:languages" className="h-4 w-4" />}
                      endContent={<Icon icon="lucide:chevron-down" className="h-3.5 w-3.5" />}
                    >
                      <span className="truncate">{currentLanguage.displayName}</span>
                    </Button>
                  </DropdownTrigger>
                  <DropdownMenu aria-label={t('languageSelection')}>
                    {languageOptions.map((option) => (
                      <DropdownItem
                        key={option.key}
                        textValue={t(option.labelKey)}
                        onPress={() => changeLanguage(option.key)}
                        startContent={<Icon icon={option.icon} />}
                      >
                        {t(option.labelKey)}
                      </DropdownItem>
                    ))}
                  </DropdownMenu>
                </Dropdown>

                <Tooltip content={t('settings')}>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="flat"
                    onPress={() => setView('settings')}
                    aria-label={t('settings')}
                    className={`h-8 w-8 min-w-8 rounded-lg ${
                      view === 'settings'
                        ? '!bg-[#c96442] !text-[#faf9f5]'
                        : 'bg-[#e8e6dc] text-[#4d4c48] dark:bg-[#30302e] dark:text-[#faf9f5]'
                    }`}
                  >
                    <Icon icon="lucide:settings" className="h-4 w-4" />
                  </Button>
                </Tooltip>

                <Tooltip content={isDark ? t('lightMode') : t('darkMode')}>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="flat"
                    onPress={toggleTheme}
                    aria-label={isDark ? t('switchToLightMode') : t('switchToDarkMode')}
                    className="rounded-lg bg-[#e8e6dc] text-[#4d4c48] dark:bg-[#30302e] dark:text-[#faf9f5]"
                  >
                    <Icon icon={isDark ? 'lucide:sun' : 'lucide:moon'} className="h-4 w-4" />
                  </Button>
                </Tooltip>
              </div>
            </>
          )}
        </div>
      </aside>

      <RoomCreateModal
        isOpen={isCreateOpen}
        onClose={closeCreateModal}
        roomName={newRoomName}
        roomDescription={newRoomDescription}
        roomType={newRoomType}
        nameError={nameError}
        createError={createError}
        isCreating={isCreating}
        isCocoEnabled={isCocoEnabled}
        onRoomNameChange={handleRoomNameChange}
        onRoomDescriptionChange={setNewRoomDescription}
        onRoomTypeChange={setNewRoomType}
        onCreate={handleCreateRoom}
      />

      <Modal isOpen={!!roomToDelete} onClose={() => setRoomToDelete(null)}>
        <ModalContent>
          <ModalHeader>{t('confirmDeleteRoomTitle')}</ModalHeader>
          <ModalBody>
            <p>{t('confirmDeleteRoomDescription', { roomName: roomToDelete?.name })}</p>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={() => setRoomToDelete(null)}>
              {t('cancel')}
            </Button>
            <Button color="danger" onPress={handleConfirmDeleteRoom}>
              {t('delete')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <RoomRenameModal
        isOpen={!!roomToRename}
        room={roomToRename}
        onClose={() => setRoomToRename(null)}
        onRename={onRenameRoom}
      />
    </>
  );
};
