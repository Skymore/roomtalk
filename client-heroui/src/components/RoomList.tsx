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
  useDisclosure
} from '@heroui/react';
import { Icon } from '@iconify/react';
import { Room } from '../utils/types';
import { createRoom } from '../utils/socket';
import { useTranslation } from 'react-i18next';

interface RoomListProps {
  rooms: Room[];
  onRoomSelect: (roomId: string, isNotOwned?: boolean) => void;
}

export const RoomList: React.FC<RoomListProps> = ({ rooms, onRoomSelect }) => {
  const { t } = useTranslation();
  // 使用useDisclosure实例
  const { isOpen, onOpen, onClose } = useDisclosure();
  const [newRoomName, setNewRoomName] = useState('');
  const [newRoomDescription, setNewRoomDescription] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCreateRoom = async () => {
    if (!newRoomName.trim()) return;
    
    setIsCreating(true);
    try {
      const roomId = await createRoom(newRoomName, newRoomDescription);
      setNewRoomName('');
      setNewRoomDescription('');
      onClose();
      // Optional: automatically join the new room
      onRoomSelect(roomId as string);
    } catch (error) {
      console.error('Error creating room:', error);
    } finally {
      setIsCreating(false);
    }
  };

  // 处理复制房间链接
  const handleCopyRoomLink = (e: React.MouseEvent, roomId: string) => {
    e.stopPropagation();
    
    // 创建完整的房间URL
    const baseUrl = window.location.origin;
    const roomUrl = `${baseUrl}/chat?room=${roomId}`;
    
    navigator.clipboard.writeText(roomUrl)
      .then(() => {
        console.log('Room URL copied:', roomUrl);
        setCopiedId(roomId);
        setTimeout(() => {
          setCopiedId(current => current === roomId ? null : current);
        }, 2000);
      })
      .catch(err => {
        console.error('Could not copy URL:', err);
      });
  };

  if (rooms.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-4">
        <Icon icon="lucide:message-square" className="w-16 h-16 mb-4 text-default-400" />
        <h2 className="text-xl font-semibold mb-2">{t('noRoomsAvailable')}</h2>
        <p className="text-default-500 mb-6 text-center">
          {t('noRoomsDescription')}
        </p>
        <div className="flex gap-2">
          <Button color="primary" onPress={onOpen}>{t('create')}</Button>
        </div>
        
        {/* 创建房间的 Modal */}
        <Modal isOpen={isOpen} onClose={onClose}>
          <ModalContent>
            <ModalHeader className="flex flex-col gap-1">{t('createNewRoom')}</ModalHeader>
            <ModalBody>
              <Input
                label={t('roomName')}
                placeholder={t('enterRoomName')}
                value={newRoomName}
                onChange={(e) => setNewRoomName(e.target.value)}
                isRequired
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
                color="primary" 
                onPress={handleCreateRoom}
                isLoading={isCreating}
                isDisabled={!newRoomName.trim() || isCreating}
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
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold">{t('yourRooms')}</h2>
        <div className="flex gap-2">
          <Button color="primary" size="sm" onPress={onOpen}>{t('create')}</Button>
        </div>
      </div>
      
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {rooms.map(room => (
          <Card 
            key={room.id} 
            className="p-4 hover:bg-content2 hover:shadow-md active:bg-content3 transition-all duration-200 cursor-pointer border border-neutral-200 dark:border-neutral-800"
            isPressable
            onPress={() => {
              console.log('Card pressed, selecting room:', room.id);
              onRoomSelect(room.id);
            }}
          >
            <div className="flex items-start">
              <div className="p-2 rounded-full bg-primary/10 mr-3">
      <Icon icon="lucide:message-circle" className="text-primary" aria-hidden="true" />
              </div>
              <div className="flex-1">
                <h3 className="font-medium">{room.name}</h3>
                {room.description && (
                  <p className="text-sm text-default-500 mt-1">{room.description}</p>
                )}
                <div className="flex justify-between items-center mt-2">
                  <p className="text-xs text-default-400">
                    {t('created')}: {new Date(room.createdAt).toLocaleDateString()}
                  </p>
                  <div className="flex items-center gap-1 copy-button-container">
                    <div 
                      className="cursor-pointer flex items-center gap-1 p-1 rounded hover:bg-gray-100 copy-button"
                      onClick={(e) => handleCopyRoomLink(e, room.id)}
                    >
                      <p className="text-xs text-default-400">
                        {t('share')}
                        {copiedId === room.id && (
                          <span className="ml-1 text-success">{t('copied')}</span>
                        )}
                      </p>
                      <Icon icon="lucide:copy" className="w-3 h-3" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>
      
      {/* 创建房间的 Modal */}
      <Modal isOpen={isOpen} onClose={onClose}>
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">{t('createNewRoom')}</ModalHeader>
          <ModalBody>
            <Input
              label={t('roomName')}
              placeholder={t('enterRoomName')}
              value={newRoomName}
              onChange={(e) => setNewRoomName(e.target.value)}
              isRequired
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
              color="primary" 
              onPress={handleCreateRoom}
              isLoading={isCreating}
              isDisabled={!newRoomName.trim() || isCreating}
            >
              {t('create')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}; 