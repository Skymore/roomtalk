import React from 'react';
import { Button, Card, Tooltip } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { Room } from '../utils/types';
import { formatDate } from '../utils/formatters';

interface RoomCardProps {
  room: Room;
  clientId: string;
  copiedRoomId: string | null;
  copiedLinkId: string | null;
  onSelect: (roomId: string) => void;
  onCopyRoomId: (roomId: string) => void;
  onCopyRoomLink: (roomId: string) => void;
  onDelete: (room: Room) => void;
}

export const RoomCard: React.FC<RoomCardProps> = ({
  room,
  clientId,
  copiedRoomId,
  copiedLinkId,
  onSelect,
  onCopyRoomId,
  onCopyRoomLink,
  onDelete,
}) => {
  const { t, i18n } = useTranslation();

  const copyRoomId = (event: React.MouseEvent) => {
    event.stopPropagation();
    onCopyRoomId(room.id);
  };

  const copyRoomLink = (event: React.MouseEvent) => {
    event.stopPropagation();
    onCopyRoomLink(room.id);
  };

  const deleteRoom = (event: React.MouseEvent) => {
    event.stopPropagation();
    onDelete(room);
  };

  return (
    <Card
      isPressable
      data-testid="room-card"
      data-room-id={room.id}
      className="cursor-pointer border border-[#dedbd0] bg-[#faf9f5] p-4 shadow-[0_0_0_1px_rgba(194,192,182,0.4)] transition-all duration-200 hover:bg-[#f0eee6] active:bg-[#e8e6dc] dark:border-[#30302e] dark:bg-[#1d1d1b] dark:hover:bg-[#30302e]"
      onPress={() => onSelect(room.id)}
    >
      <div className="flex items-start">
        <div className="mr-3 rounded-xl bg-[#e8e6dc] p-2.5 text-[#c96442] dark:bg-[#30302e] dark:text-[#d97757]">
          <Icon icon="lucide:message-circle" className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="mb-1 line-clamp-1 font-medium text-[#141413] dark:text-[#faf9f5]">{room.name}</h3>
          {room.description && (
            <p className="mb-2 line-clamp-2 text-xs text-[#5e5d59] dark:text-[#b0aea5]">{room.description}</p>
          )}
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="min-w-0 flex-shrink truncate text-xs text-[#87867f] dark:text-[#b0aea5]">
              <span className="hidden md:inline">ID: </span>
              <span className="md:hidden">{room.id.substring(0, 8)}...</span>
              <span className="hidden md:inline">{room.id}</span>
            </p>

            {room.createdAt && (
              <span className="ml-2 hidden whitespace-nowrap text-xs text-[#87867f] dark:text-[#b0aea5] md:inline-block">
                {formatDate(room.createdAt, i18n.language)}
              </span>
            )}

            <div className="ml-auto flex flex-shrink-0 items-center gap-0.5">
              <Tooltip content={copiedRoomId === room.id ? t('copyRoomIdSuccess') : t('copyRoomId')}>
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  className="text-[#5e5d59] dark:text-[#b0aea5]"
                  onClick={copyRoomId}
                  aria-label={t('copyRoomId')}
                >
                  <Icon icon={copiedRoomId === room.id ? 'lucide:check' : 'lucide:copy'} className="h-3.5 w-3.5" />
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
                  <Icon icon={copiedLinkId === room.id ? 'lucide:check' : 'lucide:share-2'} className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
              {room.creatorId === clientId && (
                <Tooltip content={t('deleteRoom')}>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="light"
                    color="danger"
                    className="text-danger-500"
                    onClick={deleteRoom}
                    aria-label={t('deleteRoom')}
                  >
                    <Icon icon="lucide:trash-2" className="h-3.5 w-3.5" />
                  </Button>
                </Tooltip>
              )}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
};
