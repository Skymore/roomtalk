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
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-[#e8e6dc] text-[#c96442] shadow-[0_0_0_1px_rgba(194,192,182,0.75)] dark:bg-[#30302e] dark:text-[#d97757]">
          <Icon icon="lucide:bookmark" className="h-8 w-8" />
        </div>
        <h2 className="mb-2 font-serif text-xl font-medium text-[#141413] dark:text-[#faf9f5]">{t('noSavedRooms')}</h2>
        <p className="mb-6 max-w-md text-sm leading-6 text-[#5e5d59] dark:text-[#b0aea5]">
          {t('noSavedRoomsDescription')}
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="font-serif text-2xl font-medium text-[#141413] dark:text-[#faf9f5]">{t('savedRooms')}</h2>
        <p className="text-sm text-[#5e5d59] dark:text-[#b0aea5]">
          {t('quickAccess')}
        </p>
      </div>

      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {rooms.map(room => (
          <Card
            key={room.id}
            className="cursor-pointer border border-[#dedbd0] bg-[#faf9f5] p-4 shadow-[0_0_0_1px_rgba(194,192,182,0.4)] transition-all duration-200 hover:bg-[#f0eee6] active:bg-[#e8e6dc] dark:border-[#30302e] dark:bg-[#1d1d1b] dark:hover:bg-[#30302e]"
            isPressable
            onPress={() => {
              console.log('Saved room card pressed:', room.id);
              const isJoined = room.creatorId !== localStorage.getItem('clientId');
              onRoomSelect(room.id, isJoined);
            }}
          >
            <div className="flex items-start">
              <div className="mr-3 rounded-xl bg-[#e8e6dc] p-2 text-[#c96442] dark:bg-[#30302e] dark:text-[#d97757]">
                <Icon icon="lucide:bookmark" />
              </div>
              <div className="flex-1">
                <h3 className="font-medium text-[#141413] dark:text-[#faf9f5]">{room.name}</h3>
                {room.description && (
                  <p className="mt-1 text-sm text-[#5e5d59] dark:text-[#b0aea5]">{room.description}</p>
                )}
                <div className="flex justify-between items-center mt-2">
                  <p className="text-xs text-[#87867f] dark:text-[#b0aea5]">
                    {t('created')}: {new Date(room.createdAt).toLocaleDateString()}
                  </p>
                  <div className="flex items-center gap-1">
                    <Tooltip content={t('unsave')}>
                      <span
                        className="inline-flex cursor-pointer rounded p-1 text-[#c96442] hover:bg-[#e8e6dc] dark:text-[#d97757] dark:hover:bg-[#30302e]"
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
              <p className="text-center text-[#5e5d59] dark:text-[#b0aea5]">
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
