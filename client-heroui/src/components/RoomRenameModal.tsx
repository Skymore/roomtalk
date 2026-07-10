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
import { HEROUI_VISIBLE_LABEL_ARIA_OVERRIDE } from '../utils/accessibility';
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
  const roomNameValidation = validateRoomName(roomName, 20);
  const displayedNameError = nameError || (
    roomName && !roomNameValidation.ok ? t(roomNameValidation.errorKey) : null
  );

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
    const validation = validateRoomName(value, 20);
    setNameError(value && !validation.ok ? t(validation.errorKey) : null);
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
            aria-label={HEROUI_VISIBLE_LABEL_ARIA_OVERRIDE}
            placeholder={t('enterRoomName')}
            value={roomName}
            onChange={(event) => handleNameChange(event.target.value)}
            maxLength={20}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void handleRename();
              }
            }}
            isRequired
            isInvalid={Boolean(displayedNameError || submitError)}
            errorMessage={displayedNameError || submitError}
            description={displayedNameError ? undefined : t('roomNameCharactersRemaining', {
              count: Math.max(0, 20 - roomName.length),
            })}
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
            isDisabled={!roomNameValidation.ok || roomNameValidation.name === room?.name || isRenaming}
            className="bg-secondary text-secondary-foreground"
          >
            {t('save')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};
