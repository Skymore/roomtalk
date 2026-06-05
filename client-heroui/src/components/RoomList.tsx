import React, { useEffect, useRef, useState } from 'react';
import {
  Button,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
} from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { Room, RoomRenameHandler } from '../utils/types';
import { createRoom } from '../utils/socket';
import { buildRoomShareUrl, validateRoomName } from '../utils/roomState';
import { RoomCard } from './RoomCard';
import { RoomCreateModal } from './RoomCreateModal';
import { RoomJoinControl } from './RoomJoinControl';
import { RoomRenameModal } from './RoomRenameModal';

interface RoomListProps {
  rooms: Room[];
  isLoading?: boolean;
  onRoomSelect: (room: Room) => void;
  onRoomSelectById: (roomId: string) => void;
  handleDeleteRoom: (roomId: string) => void;
  handleRenameRoom: RoomRenameHandler;
  clientId: string;
  username: string;
}

export const RoomList: React.FC<RoomListProps> = ({ rooms, isLoading = false, onRoomSelect, onRoomSelectById, handleDeleteRoom, handleRenameRoom, clientId, username }) => {
  const { t } = useTranslation();
  const { isOpen, onOpen, onClose } = useDisclosure();
  const [newRoomName, setNewRoomName] = useState('');
  const [newRoomDescription, setNewRoomDescription] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);
  const [copiedRoomId, setCopiedRoomId] = useState<string | null>(null);
  const [joinRoomId, setJoinRoomId] = useState('');
  const [roomToDelete, setRoomToDelete] = useState<Room | null>(null);
  const [roomToRename, setRoomToRename] = useState<Room | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const {
    isOpen: isDeleteConfirmOpen,
    onOpen: onOpenDeleteConfirm,
    onClose: onCloseDeleteConfirm,
  } = useDisclosure();

  const clearCopyFeedbackTimer = () => {
    if (copyFeedbackTimerRef.current) {
      clearTimeout(copyFeedbackTimerRef.current);
      copyFeedbackTimerRef.current = null;
    }
  };

  useEffect(() => {
    return clearCopyFeedbackTimer;
  }, []);

  const showCopiedLink = (roomId: string) => {
    clearCopyFeedbackTimer();
    setCopiedLinkId(roomId);
    setCopiedRoomId(null);
    copyFeedbackTimerRef.current = setTimeout(() => {
      setCopiedLinkId(current => current === roomId ? null : current);
      copyFeedbackTimerRef.current = null;
    }, 2000);
  };

  const showCopiedRoomId = (roomId: string) => {
    clearCopyFeedbackTimer();
    setCopiedRoomId(roomId);
    setCopiedLinkId(null);
    copyFeedbackTimerRef.current = setTimeout(() => {
      setCopiedRoomId(current => current === roomId ? null : current);
      copyFeedbackTimerRef.current = null;
    }, 2000);
  };

  const handleCreateRoom = async () => {
    const validation = validateRoomName(newRoomName);

    if (!validation.ok) {
      setNameError(t(validation.errorKey));
      return;
    }

    setNameError(null);
    setIsCreating(true);
    try {
      const roomId = await createRoom(validation.name, newRoomDescription);
      setNewRoomName('');
      setNewRoomDescription('');
      onClose();
      onRoomSelectById(roomId as string);
    } catch (error) {
      console.error('Error creating room:', error);
    } finally {
      setIsCreating(false);
    }
  };

  const handleJoinRoom = () => {
    const trimmedId = joinRoomId.trim();
    if (!trimmedId) return;
    onRoomSelectById(trimmedId);
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
    const roomUrl = buildRoomShareUrl(window.location.origin, window.location.pathname, roomId);

    navigator.clipboard.writeText(roomUrl)
      .then(() => showCopiedLink(roomId))
      .catch(err => {
        console.error('Could not copy URL:', err);
      });
  };

  const handleCopyRoomId = (roomId: string) => {
    navigator.clipboard.writeText(roomId)
      .then(() => showCopiedRoomId(roomId))
      .catch(err => {
        console.error('Could not copy Room ID:', err);
      });
  };

  const handleRoomNameChange = (value: string) => {
    setNewRoomName(value);
    setNameError(null);
  };

  const createModal = (
    <RoomCreateModal
      isOpen={isOpen}
      onClose={onClose}
      roomName={newRoomName}
      roomDescription={newRoomDescription}
      nameError={nameError}
      isCreating={isCreating}
      onRoomNameChange={handleRoomNameChange}
      onRoomDescriptionChange={setNewRoomDescription}
      onCreate={handleCreateRoom}
    />
  );

  if (isLoading && rooms.length === 0) {
    return (
      <div className="flex h-full flex-col p-4 md:p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
          <h2 className="font-serif text-2xl font-medium text-[#141413] dark:text-[#faf9f5]">{t('chatRooms')}</h2>
          <Icon icon="lucide:loader-circle" className="h-5 w-5 animate-spin text-[#c96442] dark:text-[#d97757]" />
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className="h-32 animate-pulse rounded-lg border border-[#dedbd0] bg-[#faf9f5] shadow-[0_0_0_1px_rgba(194,192,182,0.35)] dark:border-[#30302e] dark:bg-[#1d1d1b]"
            />
          ))}
        </div>
        {createModal}
      </div>
    );
  }

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

        <div className="hidden w-full max-w-md flex-row gap-3 sm:flex">
          <RoomJoinControl
            value={joinRoomId}
            onValueChange={setJoinRoomId}
            onJoin={handleJoinRoom}
            containerClassName="flex flex-1"
            inputHeightClassName="h-12"
            buttonClassName="h-12 min-w-[120px]"
          />
          <Button
            color="secondary"
            onPress={handleOpenCreateModal}
            className="h-12 min-w-[120px] bg-[#c96442] px-4 text-sm text-[#faf9f5] shadow-[0_0_0_1px_#c96442]"
          >
            {t('create')}
          </Button>
        </div>

        <div className="flex w-full max-w-md flex-col gap-3 sm:hidden">
          <RoomJoinControl
            value={joinRoomId}
            onValueChange={setJoinRoomId}
            onJoin={handleJoinRoom}
            containerClassName="flex w-full"
            inputHeightClassName="h-12"
            buttonClassName="h-12 min-w-[120px]"
          />
          <Button
            color="secondary"
            onPress={handleOpenCreateModal}
            className="h-12 w-full bg-[#c96442] text-sm text-[#faf9f5] shadow-[0_0_0_1px_#c96442]"
          >
            {t('create')}
          </Button>
        </div>

        {createModal}
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <h2 className="font-serif text-2xl font-medium text-[#141413] dark:text-[#faf9f5]">{t('chatRooms')}</h2>
        <div className="flex flex-wrap items-center gap-3">
          <RoomJoinControl
            value={joinRoomId}
            onValueChange={setJoinRoomId}
            onJoin={handleJoinRoom}
          />
          <Button
            color="secondary"
            onPress={handleOpenCreateModal}
            className="h-10 min-w-[100px] bg-[#c96442] px-4 text-sm text-[#faf9f5] shadow-[0_0_0_1px_#c96442]"
          >
            {t('create')}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {rooms.map(room => (
          <RoomCard
            key={room.id}
            room={room}
            clientId={clientId}
            copiedRoomId={copiedRoomId}
            copiedLinkId={copiedLinkId}
            onSelect={onRoomSelect}
            onCopyRoomId={handleCopyRoomId}
            onCopyRoomLink={handleCopyRoomLink}
            onRename={setRoomToRename}
            onDelete={openDeleteModal}
          />
        ))}
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

      {createModal}
      <RoomRenameModal
        isOpen={!!roomToRename}
        room={roomToRename}
        onClose={() => setRoomToRename(null)}
        onRename={handleRenameRoom}
      />
    </div>
  );
};
