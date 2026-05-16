import React, { useEffect, useState } from 'react';
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { validateRoomName } from '../utils/roomState';
import { Room, RoomRenameHandler } from '../utils/types';

interface RoomRenameModalProps {
  isOpen: boolean;
  room: Room | null;
  onClose: () => void;
  onRename: RoomRenameHandler;
}

export const RoomRenameModal: React.FC<RoomRenameModalProps> = ({
  isOpen,
  room,
  onClose,
  onRename,
}) => {
  const { t } = useTranslation();
  const [roomName, setRoomName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setRoomName(room?.name || '');
    setNameError(null);
    setSubmitError(null);
  }, [isOpen, room]);

  const handleClose = () => {
    if (isRenaming) {
      return;
    }
    onClose();
  };

  const handleNameChange = (value: string) => {
    setRoomName(value);
    setNameError(null);
    setSubmitError(null);
  };

  const handleRename = async () => {
    if (!room) {
      return;
    }

    const validation = validateRoomName(roomName);
    if (!validation.ok) {
      setNameError(t(validation.errorKey));
      return;
    }

    if (validation.name === room.name) {
      onClose();
      return;
    }

    setNameError(null);
    setSubmitError(null);
    setIsRenaming(true);
    try {
      await onRename(room.id, validation.name);
      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t('errorRenamingRoom'));
    } finally {
      setIsRenaming(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose}>
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">{t('renameRoom')}</ModalHeader>
        <ModalBody>
          <Input
            autoFocus
            label={t('roomName')}
            placeholder={t('enterRoomName')}
            value={roomName}
            onChange={(event) => handleNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void handleRename();
              }
            }}
            isRequired
            isInvalid={!!nameError || !!submitError}
            errorMessage={nameError || submitError}
            description={t('roomNameMaxLength')}
          />
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={handleClose} isDisabled={isRenaming}>
            {t('cancel')}
          </Button>
          <Button
            color="secondary"
            onPress={handleRename}
            isLoading={isRenaming}
            isDisabled={!roomName.trim() || isRenaming}
            className="bg-[#c96442] text-[#faf9f5]"
          >
            {t('save')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};
