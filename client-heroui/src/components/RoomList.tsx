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
  const { isOpen, onOpen, onClose } = useDisclosure();
  const [newRoomName, setNewRoomName] = useState('');
  const [newRoomDescription, setNewRoomDescription] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [joinRoomId, setJoinRoomId] = useState('');

  const handleCreateRoom = async () => {
    if (!newRoomName.trim()) return;
    
    setIsCreating(true);
    try {
      const roomId = await createRoom(newRoomName, newRoomDescription);
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

  const handleCopyRoomLink = (e: React.MouseEvent, roomId: string) => {
    e.stopPropagation();
    
    const baseUrl = window.location.origin;
    const roomUrl = `${baseUrl}/?room=${roomId}`;
    
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
            onPress={onOpen} 
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
            onPress={onOpen} 
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
              onPress={onOpen}
              className="h-10 px-4 min-w-[100px] ml-3 bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white text-sm"
            >
              {t('create')}
            </Button>
          </div>
        </div>
      </div>
      
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {rooms.map(room => (
          <Card 
            key={room.id} 
            className="p-4 hover:bg-gray-100/50 dark:hover:bg-gray-800/30 active:bg-gray-200/50 dark:active:bg-gray-700/40 transition-all duration-200 cursor-pointer"
            isPressable
            onPress={() => {
              console.log('Card pressed, selecting room:', room.id);
              onRoomSelect(room.id);
            }}
          >
            <div className="flex items-start">
              <div className="p-2 rounded-full bg-gradient-to-r from-violet-500/20 to-fuchsia-500/20 mr-3">
                <Icon icon="lucide:message-circle" className="text-violet-600 dark:text-violet-400" aria-hidden="true" />
              </div>
              <div className="flex-1">
                <h3 className="font-medium text-sm">{room.name}</h3>
                {room.description && (
                  <p className="text-xs text-default-500 mt-1">{room.description}</p>
                )}
                <div className="flex justify-between items-center mt-2">
                  <p className="text-xs text-default-400">
                    {t('created')}: {new Date(room.createdAt).toLocaleDateString()}
                  </p>
                  <div className="flex items-center gap-1 copy-button-container">
                    <div 
                      className="cursor-pointer flex items-center gap-1 p-1 rounded hover:bg-violet-100 dark:hover:bg-violet-900/30 copy-button"
                      onClick={(e) => handleCopyRoomLink(e, room.id)}
                    >
                      <p className="text-xs text-violet-600 dark:text-violet-400">
                        {t('share')}
                        {copiedId === room.id && (
                          <span className="ml-1 text-success">{t('copied')}</span>
                        )}
                      </p>
                      <Icon icon="lucide:copy" className="w-3 h-3 text-violet-600 dark:text-violet-400" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>
      
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