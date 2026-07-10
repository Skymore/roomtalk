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
import { RoomPostingSchedule, RoomType } from '../utils/types';
import { PostingScheduleEditor } from './PostingScheduleEditor';
import { validateRoomName } from '../utils/roomState';
import { HEROUI_VISIBLE_LABEL_ARIA_OVERRIDE } from '../utils/accessibility';

const ROOM_NAME_MAX_LENGTH = 20;

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
  type?: RoomType;
}

interface RoomCreateModalProps {
  isOpen: boolean;
  onClose: () => void;
  roomName: string;
  roomDescription: string;
  roomType: RoomType;
  nameError: string | null;
  createError: string | null;
  isCreating: boolean;
  isCodeAgentEnabled: boolean;
  onRoomNameChange: (value: string) => void;
  onRoomDescriptionChange: (value: string) => void;
  onRoomTypeChange: (value: RoomType) => void;
  onCreate: (options: RoomCreateOptions) => void;
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
  isCodeAgentEnabled,
  onRoomNameChange,
  onRoomDescriptionChange,
  onRoomTypeChange,
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
    type: roomType,
    postingSchedule: scheduleEnabled
      ? {
          enabled: true,
          timezone: timezone.trim() || 'UTC',
          windows: [{ days: selectedDays, start: startTime, end: endTime }],
        }
      : undefined,
  });

  const scheduleReady = !scheduleEnabled || (selectedDays.length > 0 && startTime !== endTime);
  const roomNameValidation = validateRoomName(roomName, ROOM_NAME_MAX_LENGTH);
  const displayedNameError = nameError || (
    roomName && !roomNameValidation.ok ? t(roomNameValidation.errorKey) : null
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      scrollBehavior="inside"
      placement="auto"
      classNames={{ wrapper: 'roomtalk-modal-viewport' }}
    >
      <ModalContent className="m-0 h-[var(--app-height,100dvh)] max-h-[var(--app-height,100dvh)] w-full max-w-full rounded-none sm:mx-6 sm:my-16 sm:h-auto sm:max-h-[85dvh] sm:max-w-lg sm:rounded-large">
        <ModalHeader className="flex flex-col gap-1 px-4 pb-3 pt-[max(env(safe-area-inset-top),1rem)] sm:px-6 sm:pt-4">
          {t('createNewRoom')}
        </ModalHeader>
        <ModalBody className="min-h-0 flex-1 px-4 pb-4 pt-0 sm:px-6">
          <div className={`grid gap-2 ${isCodeAgentEnabled ? 'grid-cols-1 min-[420px]:grid-cols-2' : 'grid-cols-1'}`} role="radiogroup" aria-label={t('roomType')}>
            {([
              { type: 'chat' as const, icon: 'lucide:message-circle', label: t('chatRoomType'), description: t('chatRoomDescription') },
              ...(isCodeAgentEnabled ? [{ type: 'codeAgent' as const, icon: 'lucide:terminal-square', label: t('codeAgentRoomType'), description: t('codeAgentRoomDescription') }] : []),
            ]).map(option => {
              const isSelected = roomType === option.type;
              return (
                <Button
                  key={option.type}
                  type="button"
                  variant={isSelected ? 'flat' : 'bordered'}
                  color={isSelected ? 'secondary' : 'default'}
                  className={`h-auto min-h-20 justify-start whitespace-normal rounded-lg border px-3 py-3 text-left ${
                    isSelected
                      ? 'border-[#c96442] bg-[#f3d8ca] text-[#7f3f29] data-[hover=true]:!opacity-100 data-[hover=true]:bg-[#eac8b8] dark:bg-[#44271f] dark:text-[#faf9f5] dark:data-[hover=true]:bg-[#553127]'
                      : 'border-[#dedbd0] bg-transparent text-[#4d4c48] data-[hover=true]:!opacity-100 data-[hover=true]:bg-[#efede5] dark:border-[#30302e] dark:text-[#b0aea5] dark:data-[hover=true]:bg-[#282826]'
                  }`}
                  onPress={() => onRoomTypeChange(option.type)}
                  role="radio"
                  aria-checked={isSelected}
                  startContent={<Icon icon={option.icon} className="h-5 w-5 flex-shrink-0" />}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-semibold">{option.label}</span>
                    <span className="mt-1 whitespace-normal text-xs leading-5">{option.description}</span>
                  </span>
                </Button>
              );
            })}
          </div>
          <Input
            label={t('roomName')}
            aria-label={HEROUI_VISIBLE_LABEL_ARIA_OVERRIDE}
            placeholder={t('enterRoomName')}
            value={roomName}
            onChange={(event) => onRoomNameChange(event.target.value)}
            maxLength={ROOM_NAME_MAX_LENGTH}
            isRequired
            isInvalid={Boolean(displayedNameError)}
            errorMessage={displayedNameError}
            description={displayedNameError ? undefined : t('roomNameCharactersRemaining', {
              count: Math.max(0, ROOM_NAME_MAX_LENGTH - roomName.length),
            })}
          />
          {createError && (
            <p role="alert" className="text-sm text-danger">
              {createError}
            </p>
          )}
          <Input
            label={`${t('description')} (${t('optional')})`}
            aria-label={HEROUI_VISIBLE_LABEL_ARIA_OVERRIDE}
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
              aria-label={HEROUI_VISIBLE_LABEL_ARIA_OVERRIDE}
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
        <ModalFooter className="border-t border-[#dedbd0] px-4 pb-[max(env(safe-area-inset-bottom),1rem)] pt-3 dark:border-[#30302e] sm:border-t-0 sm:px-6 sm:pb-4">
          <Button variant="flat" onPress={onClose} isDisabled={isCreating}>
            {t('cancel')}
          </Button>
          <Button
            color="secondary"
            onPress={() => onCreate(buildCreateOptions())}
            isLoading={isCreating}
            isDisabled={!roomNameValidation.ok || isCreating || !scheduleReady}
            className="bg-secondary text-secondary-foreground"
          >
            {t('create')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};
