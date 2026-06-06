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
import { RoomPostingSchedule } from '../utils/types';
import { PostingScheduleEditor } from './PostingScheduleEditor';

const getLocalTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export interface RoomCreateOptions {
  password?: string;
  postingSchedule?: RoomPostingSchedule | null;
}

interface RoomCreateModalProps {
  isOpen: boolean;
  onClose: () => void;
  roomName: string;
  roomDescription: string;
  nameError: string | null;
  isCreating: boolean;
  onRoomNameChange: (value: string) => void;
  onRoomDescriptionChange: (value: string) => void;
  onCreate: (options: RoomCreateOptions) => void;
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
  const [password, setPassword] = React.useState('');
  const [scheduleEnabled, setScheduleEnabled] = React.useState(false);
  const [timezone, setTimezone] = React.useState(getLocalTimezone());
  const [startTime, setStartTime] = React.useState('09:00');
  const [endTime, setEndTime] = React.useState('17:00');
  const [selectedDays, setSelectedDays] = React.useState<number[]>([0, 1, 2, 3, 4, 5, 6]);

  React.useEffect(() => {
    if (!isOpen) return;

    setPassword('');
    setScheduleEnabled(false);
    setTimezone(getLocalTimezone());
    setStartTime('09:00');
    setEndTime('17:00');
    setSelectedDays([0, 1, 2, 3, 4, 5, 6]);
  }, [isOpen]);

  const buildCreateOptions = (): RoomCreateOptions => ({
    password: password.trim() || undefined,
    postingSchedule: scheduleEnabled
      ? {
          enabled: true,
          timezone: timezone.trim() || 'UTC',
          windows: [{ days: selectedDays, start: startTime, end: endTime }],
        }
      : undefined,
  });

  const scheduleReady = !scheduleEnabled || (selectedDays.length > 0 && startTime !== endTime);

  return (
    <Modal isOpen={isOpen} onClose={onClose} scrollBehavior="inside" classNames={{ wrapper: 'roomtalk-modal-viewport' }}>
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
          <div className="mt-4 space-y-3 border-t border-[#dedbd0] pt-4 dark:border-[#30302e]">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#141413] dark:text-[#faf9f5]">
              <Icon icon="lucide:key-round" className="h-4 w-4 text-[#c96442]" />
              {t('roomPassword')}
            </div>
            <Input
              type="password"
              label={`${t('password')} (${t('optional')})`}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
            />
          </div>
          <div className="mt-4 border-t border-[#dedbd0] pt-4 dark:border-[#30302e]">
            <PostingScheduleEditor
              enabled={scheduleEnabled}
              timezone={timezone}
              startTime={startTime}
              endTime={endTime}
              selectedDays={selectedDays}
              onEnabledChange={setScheduleEnabled}
              onTimezoneChange={setTimezone}
              onStartTimeChange={setStartTime}
              onEndTimeChange={setEndTime}
              onSelectedDaysChange={setSelectedDays}
            />
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={onClose} isDisabled={isCreating}>
            {t('cancel')}
          </Button>
          <Button
            color="secondary"
            onPress={() => onCreate(buildCreateOptions())}
            isLoading={isCreating}
            isDisabled={!roomName.trim() || isCreating || !scheduleReady}
            className="bg-[#c96442] text-[#faf9f5]"
          >
            {t('create')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};
