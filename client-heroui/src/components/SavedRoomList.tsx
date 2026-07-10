import React, { useState } from 'react';
import { Modal, ModalContent, ModalBody, ModalFooter, Button, Card } from '@heroui/react';
import { Icon } from '@iconify/react';
import { HoverTooltip } from './HoverTooltip';
import { Room } from '../utils/types';
import { useTranslation } from 'react-i18next';
import { formatDate } from '../utils/formatters';

interface SavedRoomListProps {
  rooms: Room[];
  isLoading?: boolean;
  onRoomSelect: (room: Room) => void;
  onUnsaveRoom: (roomId: string) => void;
}

export const SavedRoomList: React.FC<SavedRoomListProps> = ({
  rooms,
  isLoading = false,
  onRoomSelect,
  onUnsaveRoom,
}) => {
  const { t, i18n } = useTranslation();
  const [roomToDelete, setRoomToDelete] = useState<string | null>(null);

  // 打开删除确认对话框
  const openDeleteConfirm = (roomId: string) => {
    setRoomToDelete(roomId);
  };

  // 关闭确认对话框
  const closeDeleteConfirm = () => {
    setRoomToDelete(null);
  };

  // 确认取消收藏
  const confirmDelete = () => {
    if (!roomToDelete) return;

    onUnsaveRoom(roomToDelete);

    // 关闭对话框
    closeDeleteConfirm();
  };

  const selectRoom = (room: Room) => {
    onRoomSelect(room);
  };

  if (isLoading && rooms.length === 0) {
    return (
      <div className="flex h-full flex-col p-4 md:p-6">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="font-serif text-2xl font-medium text-[#141413] dark:text-[#faf9f5]">{t('savedRooms')}</h2>
          <Icon icon="lucide:loader-circle" className="h-5 w-5 animate-spin text-[#c96442] dark:text-[#d97757]" />
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className="h-28 animate-pulse rounded-lg border border-[#dedbd0] bg-[#faf9f5] shadow-[0_0_0_1px_rgba(194,192,182,0.35)] dark:border-[#30302e] dark:bg-[#1d1d1b]"
            />
          ))}
        </div>
      </div>
    );
  }

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
            className="cursor-pointer rounded-lg border border-[#dedbd0] bg-[#faf9f5] p-4 shadow-[0_0_0_1px_rgba(194,192,182,0.4)] transition-all duration-200 hover:bg-[#f0eee6] active:bg-[#e8e6dc] dark:border-[#30302e] dark:bg-[#1d1d1b] dark:hover:bg-[#30302e]"
          >
            <div className="flex items-start">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-start text-left outline-none"
                onClick={() => selectRoom(room)}
              >
                <div className="mr-3 rounded-xl bg-[#e8e6dc] p-2 text-[#c96442] dark:bg-[#30302e] dark:text-[#d97757]">
                  <Icon icon="lucide:bookmark" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-medium text-[#141413] dark:text-[#faf9f5]">{room.name}</h3>
                  {room.description && (
                    <p className="mt-1 text-sm text-[#5e5d59] dark:text-[#b0aea5]">{room.description}</p>
                  )}
                  <p className="text-xs text-[#5e5d59] dark:text-[#b0aea5]">
                    {t('created')}: {formatDate(room.createdAt, i18n.language)}
                  </p>
                </div>
              </button>
              <div className="ml-2 flex flex-shrink-0 items-center gap-1">
                    <HoverTooltip content={t('unsave')}>
                      <Button
                        size="sm"
                        variant="light"
                        color="warning"
                        className="h-8 rounded-md px-2 text-secondary"
                        onPress={() => openDeleteConfirm(room.id)}
                        aria-label={t('unsave')}
                        startContent={<Icon icon="lucide:bookmark-minus" className="h-4 w-4" />}
                      >
                        {t('unsave')}
                      </Button>
                    </HoverTooltip>
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
