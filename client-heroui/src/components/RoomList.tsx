import React, { useState } from 'react';
import {
  Card,
  Button,
  Input,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
  Tooltip,
} from '@heroui/react';
import { Icon } from '@iconify/react';
import { Room } from '../utils/types';
import { createRoom } from '../utils/socket';
import { useTranslation } from 'react-i18next';

interface RoomListProps {
  rooms: Room[];
  onRoomSelect: (roomId: string, isNotOwned?: boolean) => void;
  handleDeleteRoom: (roomId: string) => void;
  clientId: string;
  username: string;
}

// Helper function to format date (can be customized)
const formatDate = (dateString: string | number | Date | undefined): string => {
  if (!dateString) return 'N/A';
  try {
    // More concise date formatting for desktop view
    return new Date(dateString).toLocaleDateString(undefined, {
      year: 'numeric', month: 'numeric', day: 'numeric'
    });
  } catch (e) {
    console.error("Error formatting date:", e);
    return 'Invalid Date';
  }
};

export const RoomList: React.FC<RoomListProps> = ({ rooms, onRoomSelect, handleDeleteRoom, clientId, username }) => {
  const { t } = useTranslation();
  const { isOpen, onOpen, onClose } = useDisclosure();
  const [newRoomName, setNewRoomName] = useState('');
  const [newRoomDescription, setNewRoomDescription] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);
  const [copiedRoomId, setCopiedRoomId] = useState<string | null>(null);
  const [joinRoomId, setJoinRoomId] = useState('');
  const [roomToDelete, setRoomToDelete] = useState<Room | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const {
    isOpen: isDeleteConfirmOpen,
    onOpen: onOpenDeleteConfirm,
    onClose: onCloseDeleteConfirm
  } = useDisclosure();

  const handleCreateRoom = async () => {
    const trimmedName = newRoomName.trim();

    // 验证房间名长度
    if (!trimmedName) {
      setNameError(t('errorEmptyRoomName'));
      return;
    }

    if (trimmedName.length > 20) {
      setNameError(t('errorRoomNameTooLong'));
      return;
    }

    setNameError(null);
    setIsCreating(true);
    try {
      const roomId = await createRoom(trimmedName, newRoomDescription);
      setNewRoomName('');
      setNewRoomDescription('');
      onClose();
      onRoomSelect(roomId as string);
    } catch (error) {
      console.error('Error creating room:', error);
    } finally {
      setIsCreating(false);
    }
  };

  const handleJoinRoom = () => {
    const trimmedId = joinRoomId.trim();
    if (!trimmedId) return;
    console.log('Attempting to join room with ID:', trimmedId);
    onRoomSelect(trimmedId, true);
    setJoinRoomId('');
  };

  const handleOpenCreateModal = () => {
    setNewRoomName(`${username}'s Room`);
    setNewRoomDescription('');
    setNameError(null);
    onOpen();
  };

  const openDeleteModal = (room: Room) => {
    setRoomToDelete(room);
    onOpenDeleteConfirm();
  };

  const confirmRoomDelete = () => {
    if (roomToDelete) {
      handleDeleteRoom(roomToDelete.id);
    }
    onCloseDeleteConfirm();
  };

  const handleCopyRoomLink = (roomId: string) => {
    const baseUrl = window.location.origin;
    const roomUrl = `${baseUrl}/?room=${roomId}`;

    navigator.clipboard.writeText(roomUrl)
      .then(() => {
        console.log('Room URL copied:', roomUrl);
        setCopiedLinkId(roomId);
        setCopiedRoomId(null);
        setTimeout(() => {
          setCopiedLinkId(current => current === roomId ? null : current);
        }, 2000);
      })
      .catch(err => {
        console.error('Could not copy URL:', err);
      });
  };

  const handleCopyRoomId = (roomId: string) => {
    navigator.clipboard.writeText(roomId)
      .then(() => {
        console.log('Room ID copied:', roomId);
        setCopiedRoomId(roomId);
        setCopiedLinkId(null);
        setTimeout(() => {
          setCopiedRoomId(current => current === roomId ? null : current);
        }, 2000);
      })
      .catch(err => {
        console.error('Could not copy Room ID:', err);
      });
  };

  if (rooms.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#e8e6dc] text-[#c96442] shadow-[0_0_0_1px_rgba(194,192,182,0.75)] dark:bg-[#30302e] dark:text-[#d97757]">
          <Icon icon="lucide:message-square" className="h-7 w-7" />
        </div>
        <h2 className="mb-2 font-serif text-xl font-medium text-[#141413] dark:text-[#faf9f5]">{t('noRoomsAvailable')}</h2>
        <p className="mb-6 max-w-md text-sm leading-6 text-[#5e5d59] dark:text-[#b0aea5]">
          {t('noRoomsDescription')}
        </p>

        {/* 桌面版：水平排列 */}
        <div className="hidden sm:flex flex-row gap-3 w-full max-w-md">
          <div className="flex flex-1">
            <Input
              placeholder={t('enterRoomId')}
              value={joinRoomId}
              onChange={(e) => setJoinRoomId(e.target.value)}
              aria-label={t('enterRoomId')}
              className="flex-grow"
              classNames={{
                input: "h-12",
                inputWrapper: "h-12 rounded-r-none bg-[#faf9f5] border border-[#dedbd0] dark:bg-[#1d1d1b] dark:border-[#30302e]"
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleJoinRoom(); }}
            />
            <Button
              onPress={handleJoinRoom}
              isDisabled={!joinRoomId.trim()}
              aria-label={t('joinButton')}
              color="secondary"
              className="h-12 min-w-[120px] rounded-l-none bg-[#30302e] px-4 text-sm text-[#faf9f5] dark:bg-[#faf9f5] dark:text-[#141413]"
            >
              {t('joinButton')}
            </Button>
          </div>
          <Button
            color="secondary"
            onPress={handleOpenCreateModal}
            className="h-12 min-w-[120px] bg-[#c96442] px-4 text-sm text-[#faf9f5] shadow-[0_0_0_1px_#c96442]"
          >
            {t('create')}
          </Button>
        </div>

        {/* 移动版：垂直排列 */}
        <div className="flex flex-col sm:hidden gap-3 w-full max-w-md">
          <div className="flex w-full">
            <Input
              placeholder={t('enterRoomId')}
              value={joinRoomId}
              onChange={(e) => setJoinRoomId(e.target.value)}
              aria-label={t('enterRoomId')}
              className="flex-grow"
              classNames={{
                input: "h-12",
                inputWrapper: "h-12 rounded-r-none bg-[#faf9f5] border border-[#dedbd0] dark:bg-[#1d1d1b] dark:border-[#30302e]"
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleJoinRoom(); }}
            />
            <Button
              onPress={handleJoinRoom}
              isDisabled={!joinRoomId.trim()}
              aria-label={t('joinButton')}
              color="secondary"
              className="h-12 min-w-[120px] rounded-l-none bg-[#30302e] px-4 text-sm text-[#faf9f5] dark:bg-[#faf9f5] dark:text-[#141413]"
            >
              {t('joinButton')}
            </Button>
          </div>
          <Button
            color="secondary"
            onPress={handleOpenCreateModal}
            className="h-12 w-full bg-[#c96442] text-sm text-[#faf9f5] shadow-[0_0_0_1px_#c96442]"
          >
            {t('create')}
          </Button>
        </div>

        <Modal isOpen={isOpen} onClose={onClose}>
          <ModalContent>
            <ModalHeader className="flex flex-col gap-1">{t('createNewRoom')}</ModalHeader>
            <ModalBody>
              <Input
                label={t('roomName')}
                placeholder={t('enterRoomName')}
                value={newRoomName}
                onChange={(e) => {
                  setNewRoomName(e.target.value);
                  setNameError(null);
                }}
                isRequired
                isInvalid={!!nameError}
                errorMessage={nameError}
                description={t('roomNameMaxLength')}
              />
              <Input
                label={`${t('description')} (${t('optional')})`}
                placeholder={t('describeRoom')}
                value={newRoomDescription}
                onChange={(e) => setNewRoomDescription(e.target.value)}
                className="mt-4"
              />
            </ModalBody>
            <ModalFooter>
              <Button
                variant="flat"
                onPress={onClose}
                isDisabled={isCreating}
              >
                {t('cancel')}
              </Button>
              <Button
                color="secondary"
                onPress={handleCreateRoom}
                isLoading={isCreating}
                isDisabled={!newRoomName.trim() || isCreating}
                className="bg-[#c96442] text-[#faf9f5]"
              >
                {t('create')}
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <h2 className="font-serif text-2xl font-medium text-[#141413] dark:text-[#faf9f5]">{t('home')}</h2>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex">
            <Input
              placeholder={t('enterRoomId')}
              value={joinRoomId}
              onChange={(e) => setJoinRoomId(e.target.value)}
              aria-label={t('enterRoomId')}
              className="flex-grow"
              classNames={{
                input: "h-10",
                inputWrapper: "h-10 rounded-r-none bg-[#faf9f5] border border-[#dedbd0] dark:bg-[#1d1d1b] dark:border-[#30302e]"
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleJoinRoom(); }}
            />
            <Button
              onPress={handleJoinRoom}
              isDisabled={!joinRoomId.trim()}
              className="h-10 min-w-[100px] rounded-l-none bg-[#30302e] px-4 text-sm text-[#faf9f5] dark:bg-[#faf9f5] dark:text-[#141413]"
              aria-label={t('joinButton')}
              color="secondary"
            >
              {t('joinButton')}
            </Button>
            <Button
              color="secondary"
              onPress={handleOpenCreateModal}
              className="ml-3 h-10 min-w-[100px] bg-[#c96442] px-4 text-sm text-[#faf9f5] shadow-[0_0_0_1px_#c96442]"
            >
              {t('create')}
            </Button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {rooms.map(room => {
          // 为每个房间创建单独的事件处理函数，避免事件冒泡
          const copyRoomId = (e: React.MouseEvent) => {
            e.stopPropagation();
            handleCopyRoomId(room.id);
          };

          const copyRoomLink = (e: React.MouseEvent) => {
            e.stopPropagation();
            handleCopyRoomLink(room.id);
          };

          const deleteRoom = (e: React.MouseEvent) => {
            e.stopPropagation();
            openDeleteModal(room);
          };

          return (
            <Card
              key={room.id}
              className="cursor-pointer border border-[#dedbd0] bg-[#faf9f5] p-4 shadow-[0_0_0_1px_rgba(194,192,182,0.4)] transition-all duration-200 hover:bg-[#f0eee6] active:bg-[#e8e6dc] dark:border-[#30302e] dark:bg-[#1d1d1b] dark:hover:bg-[#30302e]"
              isPressable // 使用 isPressable 替代 onClick 以利用 HeroUI 的按压效果
              onPress={() => {
                console.log('Card pressed, selecting room:', room.id);
                onRoomSelect(room.id);
              }}
            >
              <div className="flex items-start">
                <div className="mr-3 rounded-xl bg-[#e8e6dc] p-2.5 text-[#c96442] dark:bg-[#30302e] dark:text-[#d97757]">
                  <Icon icon="lucide:message-circle" className="h-5 w-5" aria-hidden="true" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="mb-1 line-clamp-1 font-medium text-[#141413] dark:text-[#faf9f5]">{room.name}</h3>
                  {room.description && (
                    <p className="mb-2 line-clamp-2 text-xs text-[#5e5d59] dark:text-[#b0aea5]">{room.description}</p>
                  )}
                  <div className="flex justify-between items-center mt-2 gap-2">
                    <p className="min-w-0 flex-shrink truncate text-xs text-[#87867f] dark:text-[#b0aea5]">
                      <span className="hidden md:inline">ID: </span>
                      <span className="md:hidden">{room.id.substring(0, 8)}...</span>
                      <span className="hidden md:inline">{room.id}</span>
                    </p>

                    {room.createdAt && (
                       <span className="ml-2 hidden whitespace-nowrap text-xs text-[#87867f] dark:text-[#b0aea5] md:inline-block">
                         {formatDate(room.createdAt)}
                       </span>
                    )}

                    <div
                      className="flex items-center gap-0.5 ml-auto flex-shrink-0" // 减小按钮间距
                    >
                       <Tooltip content={copiedRoomId === room.id ? t('copyRoomIdSuccess') : t('copyRoomId')}>
                         <Button
                           isIconOnly
                           size="sm"
                           variant="light" // 使用 light variant
                           className="text-[#5e5d59] dark:text-[#b0aea5]" // 默认颜色
                           onClick={copyRoomId}
                           aria-label={t('copyRoomId')}
                         >
                            <Icon icon={copiedRoomId === room.id ? "lucide:check" : "lucide:copy"} className="w-3.5 h-3.5" />
                          </Button>
                       </Tooltip>
                      <Tooltip content={copiedLinkId === room.id ? t('shareSuccess') : t('share')}>
                        <Button
                          isIconOnly
                          size="sm"
                          variant="light"
                          className="text-[#5e5d59] dark:text-[#b0aea5]"
                          onClick={copyRoomLink}
                          aria-label={t('share')}
                        >
                          <Icon icon={copiedLinkId === room.id ? "lucide:check" : "lucide:share-2"} className="w-3.5 h-3.5" />
                        </Button>
                      </Tooltip>
                      {room.creatorId === clientId && (
                        <Tooltip content={t('deleteRoom')}>
                          <Button
                            isIconOnly
                            size="sm"
                            variant="light"
                            color="danger" // 明确指定 danger 颜色
                            className="text-danger-500" // 确保文字也是 danger 颜色
                            onClick={deleteRoom}
                            aria-label={t('deleteRoom')}
                          >
                            <Icon icon="lucide:trash-2" className="w-3.5 h-3.5" />
                          </Button>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <Modal isOpen={isDeleteConfirmOpen} onClose={onCloseDeleteConfirm}>
        <ModalContent>
          <ModalHeader>{t('confirmDeleteRoomTitle')}</ModalHeader>
          <ModalBody>
            <p>{t('confirmDeleteRoomDescription', { roomName: roomToDelete?.name })}</p>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={onCloseDeleteConfirm}>
              {t('cancel')}
            </Button>
            <Button color="danger" onPress={confirmRoomDelete}>
              {t('delete')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={isOpen} onClose={onClose}>
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">{t('createNewRoom')}</ModalHeader>
          <ModalBody>
            <Input
              label={t('roomName')}
              placeholder={t('enterRoomName')}
              value={newRoomName}
              onChange={(e) => {
                setNewRoomName(e.target.value);
                setNameError(null);
              }}
              isRequired
              isInvalid={!!nameError}
              errorMessage={nameError}
              description={t('roomNameMaxLength')}
            />
            <Input
              label={`${t('description')} (${t('optional')})`}
              placeholder={t('describeRoom')}
              value={newRoomDescription}
              onChange={(e) => setNewRoomDescription(e.target.value)}
              className="mt-4"
            />
          </ModalBody>
          <ModalFooter>
            <Button
              variant="flat"
              onPress={onClose}
              isDisabled={isCreating}
            >
              {t('cancel')}
            </Button>
            <Button
              color="secondary"
              onPress={handleCreateRoom}
              isLoading={isCreating}
              isDisabled={!newRoomName.trim() || isCreating}
              className="bg-[#c96442] text-[#faf9f5]"
            >
              {t('create')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
};
