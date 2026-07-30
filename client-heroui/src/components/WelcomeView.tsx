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
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden p-5 sm:p-8">
      <div aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,rgba(201,100,66,0.12),transparent_42%)] dark:bg-[radial-gradient(circle_at_50%_30%,rgba(217,119,87,0.12),transparent_42%)]" />
      <div className="relative flex w-full max-w-xl flex-col items-center rounded-3xl border border-[#dedbd0]/80 bg-[#faf9f5]/80 px-6 py-10 text-center shadow-[0_24px_70px_rgba(39,36,31,0.08)] backdrop-blur-sm dark:border-[#30302e] dark:bg-[#1d1d1b]/80 sm:px-10 sm:py-12">
        <img src="/roomtalk-logo.svg" alt="" aria-hidden="true" className="mb-5 h-16 w-16 drop-shadow-sm" />
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#a34d32] dark:text-[#f0a487]">RoomTalk</p>
        <h2 className="mb-3 font-serif text-3xl font-medium leading-tight text-[#141413] dark:text-[#faf9f5] sm:text-4xl">{t('welcomeMessage')}</h2>
        <p className="mb-7 max-w-md text-sm leading-6 text-[#5e5d59] dark:text-[#b0aea5] sm:text-base sm:leading-7">{t('welcomeDescription')}</p>
        <Button
          color="secondary"
          onPress={onEnterRooms}
          endContent={<Icon icon="lucide:arrow-right" className="h-4 w-4" />}
          className="min-h-11 min-w-40 bg-secondary px-5 font-medium text-secondary-foreground shadow-[0_0_0_1px_#c96442]"
        >
          {t('browseRooms')}
        </Button>
      </div>
    </div>
  );
};
