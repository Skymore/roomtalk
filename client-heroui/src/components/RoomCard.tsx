import React from 'react';
import { Button, Card, Chip } from '@heroui/react';
import { Icon } from '@iconify/react';
import { HoverTooltip } from './HoverTooltip';
import { useTranslation } from 'react-i18next';
import { Room } from '../utils/types';
import { formatDate } from '../utils/formatters';
import { getRoomActivityAt } from '../utils/roomState';
import { getCodeAgentBackend, getCodeAgentStatus, isSupportedCodeAgentBackend } from '../utils/codeAgent';
import { getCodeAgentStatusClassName, getCodeAgentStatusLabelKey, getSandboxStatusClassName, getSandboxStatusLabelKey } from '../utils/codeAgentRoom';

interface RoomCardProps {
  room: Room;
  clientId: string;
  copiedRoomId: string | null;
  copiedLinkId: string | null;
  onSelect: (room: Room) => void;
  onCopyRoomId: (roomId: string) => void;
  onCopyRoomLink: (roomId: string) => void;
  onRename: (room: Room) => void;
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
  onRename,
  onDelete,
}) => {
  const { t, i18n } = useTranslation();
  const activityAt = getRoomActivityAt(room);
  const codeAgentBackend = getCodeAgentBackend(room);
  const isCodeAgent = codeAgentBackend !== null;
  const isSupportedCodeAgent = isSupportedCodeAgentBackend(codeAgentBackend);
  const agentStatus = getCodeAgentStatus(room);

  const copyRoomId = () => {
    onCopyRoomId(room.id);
  };

  const copyRoomLink = () => {
    onCopyRoomLink(room.id);
  };

  const deleteRoom = () => {
    onDelete(room);
  };

  const renameRoom = () => {
    onRename(room);
  };

  return (
    <Card
      data-testid="room-card"
      data-room-id={room.id}
      className="cursor-pointer rounded-lg border border-[#dedbd0] bg-[#faf9f5] p-4 shadow-[0_0_0_1px_rgba(194,192,182,0.4)] transition-all duration-200 hover:bg-[#f0eee6] active:bg-[#e8e6dc] dark:border-[#30302e] dark:bg-[#1d1d1b] dark:hover:bg-[#30302e]"
    >
      <div className="flex items-start">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start text-left outline-none"
          onClick={() => onSelect(room)}
        >
          <div className="mr-3 rounded-xl bg-[#e8e6dc] p-2.5 text-[#c96442] dark:bg-[#30302e] dark:text-[#d97757]">
            <Icon icon={isCodeAgent ? 'lucide:terminal' : 'lucide:message-circle'} className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex min-w-0 flex-wrap items-center gap-1.5">
              <h3 className="min-w-0 flex-1 truncate font-medium text-[#141413] dark:text-[#faf9f5]">{room.name}</h3>
              {isCodeAgent && (
                <Chip
                  size="sm"
                  variant="flat"
                  startContent={<Icon icon="lucide:terminal" className="h-3 w-3" />}
                  classNames={{
                    base: 'h-5 flex-shrink-0 border border-[#c96442]/40 bg-[#c96442]/10 px-1.5 text-[#a34d32] dark:text-[#f0a487]',
                    content: 'px-0 text-[10px] font-semibold',
                  }}
                >
                  {t('codeAgentRoomType')}
                </Chip>
              )}
            </div>
            {room.description && (
              <p className="mb-2 line-clamp-2 text-xs text-[#5e5d59] dark:text-[#b0aea5]">{room.description}</p>
            )}
            {isSupportedCodeAgent && (
              <div className="mb-2 flex min-w-0 flex-wrap items-center gap-1.5">
                <span className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${getSandboxStatusClassName(room.sandboxStatus)}`}>
                  <Icon icon="lucide:box" className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate">{t(getSandboxStatusLabelKey(room.sandboxStatus))}</span>
                </span>
                <span className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${getCodeAgentStatusClassName(agentStatus)}`}>
                  <Icon icon="lucide:bot" className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate">{t(getCodeAgentStatusLabelKey(agentStatus))}</span>
                </span>
              </div>
            )}
            <div className="mt-2 flex min-w-0 items-center gap-2">
              <p className="min-w-0 flex-shrink truncate text-xs text-[#87867f] dark:text-[#b0aea5]">
                <span className="hidden md:inline">ID: </span>
                <span className="md:hidden">{room.id.substring(0, 8)}...</span>
                <span className="hidden md:inline">{room.id}</span>
              </p>

              {activityAt && (
                <span className="ml-2 hidden whitespace-nowrap text-xs text-[#87867f] dark:text-[#b0aea5] md:inline-block">
                  {formatDate(activityAt, i18n.language)}
                </span>
              )}
            </div>
          </div>
        </button>
        <div className="ml-2 flex flex-shrink-0 items-center gap-0.5">
              <HoverTooltip content={copiedRoomId === room.id ? t('copyRoomIdSuccess') : t('copyRoomId')}>
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  className="text-[#5e5d59] dark:text-[#b0aea5]"
                  onPress={copyRoomId}
                  aria-label={t('copyRoomId')}
                >
                  <Icon icon={copiedRoomId === room.id ? 'lucide:check' : 'lucide:copy'} className="h-3.5 w-3.5" />
                </Button>
              </HoverTooltip>
              <HoverTooltip content={copiedLinkId === room.id ? t('shareSuccess') : t('share')}>
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  className="text-[#5e5d59] dark:text-[#b0aea5]"
                  onPress={copyRoomLink}
                  aria-label={t('share')}
                >
                  <Icon icon={copiedLinkId === room.id ? 'lucide:check' : 'lucide:share-2'} className="h-3.5 w-3.5" />
                </Button>
              </HoverTooltip>
              {room.creatorId === clientId && (
                <>
                  <HoverTooltip content={t('editRoomName')}>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="light"
                      className="text-[#5e5d59] dark:text-[#b0aea5]"
                      onPress={renameRoom}
                      aria-label={t('editRoomName')}
                    >
                      <Icon icon="lucide:pencil" className="h-3.5 w-3.5" />
                    </Button>
                  </HoverTooltip>
                  <HoverTooltip content={t('deleteRoom')}>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="light"
                      color="danger"
                      className="text-danger-500"
                      onPress={deleteRoom}
                      aria-label={t('deleteRoom')}
                    >
                      <Icon icon="lucide:trash-2" className="h-3.5 w-3.5" />
                    </Button>
                  </HoverTooltip>
                </>
              )}
            </div>
      </div>
    </Card>
  );
};
