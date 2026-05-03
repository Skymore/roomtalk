import React from 'react';
import { Button, Input } from '@heroui/react';
import { useTranslation } from 'react-i18next';

interface RoomJoinControlProps {
  value: string;
  onValueChange: (value: string) => void;
  onJoin: () => void;
  containerClassName?: string;
  inputHeightClassName?: string;
  buttonClassName?: string;
}

export const RoomJoinControl: React.FC<RoomJoinControlProps> = ({
  value,
  onValueChange,
  onJoin,
  containerClassName = 'flex',
  inputHeightClassName = 'h-10',
  buttonClassName = 'h-10 min-w-[100px]',
}) => {
  const { t } = useTranslation();

  return (
    <div className={containerClassName}>
      <Input
        placeholder={t('enterRoomId')}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        aria-label={t('enterRoomId')}
        className="flex-grow"
        classNames={{
          input: inputHeightClassName,
          inputWrapper: `${inputHeightClassName} rounded-r-none bg-[#faf9f5] border border-[#dedbd0] dark:bg-[#1d1d1b] dark:border-[#30302e]`,
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onJoin();
        }}
      />
      <Button
        onPress={onJoin}
        isDisabled={!value.trim()}
        aria-label={t('joinButton')}
        color="secondary"
        className={`${buttonClassName} rounded-l-none bg-[#30302e] px-4 text-sm text-[#faf9f5] dark:bg-[#faf9f5] dark:text-[#141413]`}
      >
        {t('joinButton')}
      </Button>
    </div>
  );
};
