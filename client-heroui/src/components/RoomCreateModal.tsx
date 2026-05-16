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
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { RoomType } from '../utils/types';

interface RoomCreateModalProps {
  isOpen: boolean;
  onClose: () => void;
  roomName: string;
  roomDescription: string;
  roomType: RoomType;
  nameError: string | null;
  createError: string | null;
  isCreating: boolean;
  onRoomNameChange: (value: string) => void;
  onRoomDescriptionChange: (value: string) => void;
  onRoomTypeChange: (value: RoomType) => void;
  onCreate: () => void;
}

export const RoomCreateModal: React.FC<RoomCreateModalProps> = ({
  isOpen,
  onClose,
  roomName,
  roomDescription,
  roomType,
  nameError,
  createError,
  isCreating,
  onRoomNameChange,
  onRoomDescriptionChange,
  onRoomTypeChange,
  onCreate,
}) => {
  const { t } = useTranslation();

  return (
    <Modal isOpen={isOpen} onClose={onClose}>
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">{t('createNewRoom')}</ModalHeader>
        <ModalBody>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('roomType')}>
            {([
              { type: 'chat' as const, icon: 'lucide:message-circle', label: t('chatRoomType'), description: t('chatRoomDescription') },
              { type: 'coco' as const, icon: 'lucide:terminal-square', label: t('cocoRoomType'), description: t('cocoRoomDescription') },
            ]).map(option => {
              const isSelected = roomType === option.type;
              return (
                <Button
                  key={option.type}
                  type="button"
                  variant={isSelected ? 'flat' : 'bordered'}
                  color={isSelected ? 'secondary' : 'default'}
                  className={`h-auto min-h-20 justify-start rounded-lg border px-3 py-3 text-left ${
                    isSelected
                      ? 'border-[#c96442] bg-[#f3d8ca] text-[#7f3f29] dark:bg-[#44271f] dark:text-[#faf9f5]'
                      : 'border-[#dedbd0] bg-transparent text-[#4d4c48] dark:border-[#30302e] dark:text-[#b0aea5]'
                  }`}
                  onPress={() => onRoomTypeChange(option.type)}
                  role="radio"
                  aria-checked={isSelected}
                  startContent={<Icon icon={option.icon} className="h-5 w-5 flex-shrink-0" />}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-semibold">{option.label}</span>
                    <span className="mt-1 line-clamp-2 text-xs opacity-75">{option.description}</span>
                  </span>
                </Button>
              );
            })}
          </div>
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
          {createError && (
            <p role="alert" className="text-sm text-danger">
              {createError}
            </p>
          )}
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
