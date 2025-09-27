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
      setNameError(t('errorRoomNameTooLong') || '房间名不能超过20个字符');
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
      <div className="flex flex-col items-center justify-center h-full p-4">
        <Icon icon="lucide:message-square" className="w-14 h-14 mb-3 text-violet-400" />
        <h2 className="text-lg font-semibold mb-2 bg-gradient-to-r from-violet-600 to-fuchsia-600 bg-clip-text text-transparent">{t('noRoomsAvailable')}</h2>
        <p className="text-default-500 mb-6 text-center text-sm">
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
                inputWrapper: "h-12 rounded-r-none"
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleJoinRoom(); }}
            />
            <Button 
              onPress={handleJoinRoom} 
              isDisabled={!joinRoomId.trim()} 
              className="h-12 px-4 min-w-[120px] rounded-l-none text-sm"
              aria-label={t('joinButton')}
              color="secondary"
            >
              {t('joinButton')}
            </Button>
          </div>
          <Button 
            color="secondary" 
            onPress={handleOpenCreateModal} 
            className="h-12 px-4 min-w-[120px] bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white text-sm"
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
                inputWrapper: "h-12 rounded-r-none"
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleJoinRoom(); }}
            />
            <Button 
              onPress={handleJoinRoom} 
              isDisabled={!joinRoomId.trim()} 
              className="h-12 px-4 min-w-[120px] rounded-l-none text-sm"
              aria-label={t('joinButton')}
              color="secondary"
            >
              {t('joinButton')}
            </Button>
          </div>
          <Button 
            color="secondary" 
            onPress={handleOpenCreateModal} 
            className="w-full h-12 bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white text-sm"
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
                description={t('roomNameMaxLength') || '房间名最多20个字符'}
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
                className="bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white"
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
    <div className="p-4">
      <div className="flex flex-wrap justify-between items-center gap-4 mb-4">
        <h2 className="text-lg font-semibold bg-gradient-to-r from-violet-600 to-fuchsia-600 bg-clip-text text-transparent">{t('home')}</h2>
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
                inputWrapper: "h-10 rounded-r-none"
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleJoinRoom(); }}
            />
            <Button 
              onPress={handleJoinRoom} 
              isDisabled={!joinRoomId.trim()} 
              className="h-10 px-4 min-w-[100px] rounded-l-none text-sm"
              aria-label={t('joinButton')}
              color="secondary"
            >
              {t('joinButton')}
            </Button>
            <Button 
              color="secondary" 
              onPress={handleOpenCreateModal}
              className="h-10 px-4 min-w-[100px] ml-3 bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white text-sm"
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
              className="p-4 hover:bg-gray-100/50 dark:hover:bg-gray-800/30 active:bg-gray-200/50 dark:active:bg-gray-700/40 transition-all duration-200 cursor-pointer border-1 border-violet-100 dark:border-gray-800 shadow-sm"
              isPressable // 使用 isPressable 替代 onClick 以利用 HeroUI 的按压效果
              onPress={() => {
                console.log('Card pressed, selecting room:', room.id);
                onRoomSelect(room.id);
              }}
            >
              <div className="flex items-start">
                <div className="p-2.5 rounded-full bg-gradient-to-r from-violet-500/20 to-fuchsia-500/20 mr-3">
                  <Icon icon="lucide:message-circle" className="text-violet-600 dark:text-violet-400 w-5 h-5" aria-hidden="true" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-medium text-sm mb-1 line-clamp-1">{room.name}</h3>
                  {room.description && (
                    <p className="text-xs text-default-500 mb-2 line-clamp-2">{room.description}</p>
                  )}
                  <div className="flex justify-between items-center mt-2 gap-2">
                    <p className="text-xs text-default-400 truncate flex-shrink min-w-0">
                      <span className="hidden md:inline">ID: </span>
                      <span className="md:hidden">{room.id.substring(0, 8)}...</span>
                      <span className="hidden md:inline">{room.id}</span>
                    </p>
                    
                    {room.createdAt && (
                       <span className="hidden md:inline-block text-xs text-default-400 ml-2 whitespace-nowrap">
                         {formatDate(room.createdAt)}
                       </span>
                    )}
  
                    <div 
                      className="flex items-center gap-0.5 ml-auto flex-shrink-0" // 减小按钮间距
                    >
                       <Tooltip content={copiedRoomId === room.id ? t('copyRoomIdSuccess') : t('copyRoomId') || '复制房间ID'}>
                         <Button
                           isIconOnly
                           size="sm"
                           variant="light" // 使用 light variant
                           className="text-default-500" // 默认颜色
                           onClick={copyRoomId}
                           aria-label={t('copyRoomId') || '复制房间ID'}
                         >
                            <Icon icon={copiedRoomId === room.id ? "lucide:check" : "lucide:copy"} className="w-3.5 h-3.5" />
                          </Button>
                       </Tooltip>
                      <Tooltip content={copiedLinkId === room.id ? t('shareSuccess') : t('share')}>
                        <Button
                          isIconOnly
                          size="sm"
                          variant="light"
                          className="text-default-500"
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
              description={t('roomNameMaxLength') || '房间名最多20个字符'}
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
              className="bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white"
            >
              {t('create')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}; 