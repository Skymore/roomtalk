import React, { useState } from 'react';
import { Card, Modal, ModalContent, ModalBody, ModalFooter, Button, Tooltip } from '@heroui/react';
import { Icon } from '@iconify/react';
import { Room } from '../utils/types';
import { removeRoom } from '../utils/storage';
import { useTranslation } from 'react-i18next';

interface SavedRoomListProps {
  rooms: Room[];
  onRoomSelect: (roomId: string, isJoined?: boolean) => void;
  onRoomsChange: (rooms: Room[]) => void;
}

export const SavedRoomList: React.FC<SavedRoomListProps> = ({ 
  rooms, 
  onRoomSelect,
  onRoomsChange
}) => {
  const { t } = useTranslation();
  const [roomToDelete, setRoomToDelete] = useState<string | null>(null);
  
  // 打开删除确认对话框
  const openDeleteConfirm = (e: React.MouseEvent, roomId: string) => {
    e.stopPropagation(); // 停止事件传播，防止触发Card的onClick
    e.preventDefault(); // 阻止默认行为
    console.log('准备删除房间:', roomId);
    setRoomToDelete(roomId);
  };
  
  // 关闭确认对话框
  const closeDeleteConfirm = () => {
    setRoomToDelete(null);
  };
  
  // 确认取消收藏
  const confirmDelete = () => {
    if (!roomToDelete) return;
    
    console.log('确认取消收藏房间:', roomToDelete);
    // Restore original logic: update local storage and notify parent
    const updatedRooms = removeRoom(roomToDelete);
    onRoomsChange(updatedRooms);
    
    // 关闭对话框
    closeDeleteConfirm();
  };

  if (rooms.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-4">
        <Icon icon="lucide:bookmark" className="w-16 h-16 mb-4 text-default-400" />
        <h2 className="text-xl font-semibold mb-2">{t('noSavedRooms')}</h2>
        <p className="text-default-500 mb-6 text-center">
          {t('noSavedRoomsDescription')}
        </p>
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold">{t('savedRooms')}</h2>
        <p className="text-sm text-default-500">
          {t('quickAccess')}
        </p>
      </div>
      
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {rooms.map(room => (
          <Card 
            key={room.id} 
            className="p-4 hover:bg-content2 hover:shadow-md active:bg-content3 transition-all duration-200 cursor-pointer border border-neutral-200 dark:border-neutral-800"
            isPressable
            onPress={() => {
              console.log('Saved room card pressed:', room.id);
              const isJoined = room.creatorId !== localStorage.getItem('clientId');
              onRoomSelect(room.id, isJoined);
            }}
          >
            <div className="flex items-start">
              <div className="p-2 rounded-full bg-primary/10 mr-3">
                <Icon icon="lucide:bookmark" className="text-primary" />
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
                  <div className="flex items-center gap-1">
                    <Tooltip content={t('unsave')}> 
                      <span 
                        className="cursor-pointer p-1 rounded hover:bg-gray-100 inline-flex text-warning-600 dark:text-warning-500"
                        onClick={(e) => openDeleteConfirm(e, room.id)}
                        aria-label={t('unsave')}
                      >
                        <Icon icon="lucide:bookmark-minus" className="w-4 h-4" />
                      </span>
                    </Tooltip>
                  </div>
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>
      
      {/* 删除确认对话框 */}
      <Modal isOpen={!!roomToDelete} onClose={closeDeleteConfirm}>
        <ModalContent>
          <ModalBody className="py-5">
            <div className="flex flex-col items-center gap-2">
              <Icon icon="lucide:alert-triangle" className="text-danger w-10 h-10" />
              <h3 className="text-xl font-medium">{t('confirmUnsave')}</h3>
              <p className="text-center text-default-500">
                {t('confirmUnsaveDescription')}
              </p>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={closeDeleteConfirm}>
              {t('cancel')}
            </Button>
            <Button color="warning" onPress={confirmDelete}>
              {t('unsave')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}; 