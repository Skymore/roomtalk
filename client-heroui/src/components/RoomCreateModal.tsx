import React from 'react';
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

interface RoomCreateModalProps {
  isOpen: boolean;
  onClose: () => void;
  roomName: string;
  roomDescription: string;
  nameError: string | null;
  isCreating: boolean;
  onRoomNameChange: (value: string) => void;
  onRoomDescriptionChange: (value: string) => void;
  onCreate: () => void;
}

export const RoomCreateModal: React.FC<RoomCreateModalProps> = ({
  isOpen,
  onClose,
  roomName,
  roomDescription,
  nameError,
  isCreating,
  onRoomNameChange,
  onRoomDescriptionChange,
  onCreate,
}) => {
  const { t } = useTranslation();

  return (
    <Modal isOpen={isOpen} onClose={onClose}>
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">{t('createNewRoom')}</ModalHeader>
        <ModalBody>
          <Input
            label={t('roomName')}
            placeholder={t('enterRoomName')}
            value={roomName}
            onChange={(event) => onRoomNameChange(event.target.value)}
            isRequired
            isInvalid={!!nameError}
            errorMessage={nameError}
            description={t('roomNameMaxLength')}
          />
          <Input
            label={`${t('description')} (${t('optional')})`}
            placeholder={t('describeRoom')}
            value={roomDescription}
            onChange={(event) => onRoomDescriptionChange(event.target.value)}
            className="mt-4"
          />
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={onClose} isDisabled={isCreating}>
            {t('cancel')}
          </Button>
          <Button
            color="secondary"
            onPress={onCreate}
            isLoading={isCreating}
            isDisabled={!roomName.trim() || isCreating}
            className="bg-[#c96442] text-[#faf9f5]"
          >
            {t('create')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};
