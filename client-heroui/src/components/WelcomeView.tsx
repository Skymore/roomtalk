import React from 'react';
import { Button } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';

interface WelcomeViewProps {
  onEnterRooms: () => void;
}

export const WelcomeView: React.FC<WelcomeViewProps> = ({ onEnterRooms }) => {
  const { t } = useTranslation();

  return (
    <div className="flex h-full w-full flex-col items-center justify-center overflow-y-auto p-6 text-center">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-[#e8e6dc] text-[#c96442] shadow-[0_0_0_1px_rgba(194,192,182,0.75)] dark:bg-[#30302e] dark:text-[#d97757]">
        <Icon icon="lucide:message-circle" className="h-8 w-8" />
      </div>
      <h2 className="mb-2 font-serif text-2xl font-medium leading-tight text-[#141413] dark:text-[#faf9f5]">{t('welcomeMessage')}</h2>
      <p className="mb-6 max-w-md text-sm leading-6 text-[#5e5d59] dark:text-[#b0aea5]">{t('welcomeDescription')}</p>
      <Button
        color="secondary"
        onPress={onEnterRooms}
        startContent={<Icon icon="lucide:users" />}
        className="bg-secondary text-secondary-foreground shadow-[0_0_0_1px_#c96442]"
      >
        {t('home')}
      </Button>
    </div>
  );
};
