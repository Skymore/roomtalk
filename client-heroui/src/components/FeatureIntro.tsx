import React from 'react';
import { Button } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';

const storageKeyForFeature = (featureKey: string) => `ftue:${featureKey}`;

export interface FeatureIntroProps {
  featureKey: string;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => unknown;
  actionIcon?: string;
}

export const resetFeatureIntroForTests = (featureKey: string) => {
  localStorage.removeItem(storageKeyForFeature(featureKey));
};

export const FeatureIntro: React.FC<FeatureIntroProps> = ({
  featureKey,
  title,
  description,
  actionLabel,
  onAction,
  actionIcon,
}) => {
  const { t } = useTranslation();
  const [isDismissed, setIsDismissed] = React.useState(() => (
    localStorage.getItem(storageKeyForFeature(featureKey)) === 'dismissed'
  ));
  const [isRunningAction, setIsRunningAction] = React.useState(false);

  const handleDismiss = () => {
    localStorage.setItem(storageKeyForFeature(featureKey), 'dismissed');
    setIsDismissed(true);
  };

  const handleAction = async () => {
    if (!onAction) {
      return;
    }
    setIsRunningAction(true);
    try {
      await onAction();
    } finally {
      setIsRunningAction(false);
    }
  };

  if (isDismissed) {
    return null;
  }

  return (
    <div className="rounded-lg border border-[#dedbd0] bg-[#f2f0e8] p-3 dark:border-[#3b3a36] dark:bg-[#23221f]">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[#c96442] text-[#faf9f5]">
          <Icon icon="lucide:sparkles" className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-[#141413] dark:text-[#faf9f5]">{title}</div>
          <p className="mt-1 text-xs leading-5 text-[#66645e] dark:text-[#b0aea5]">{description}</p>
          {actionLabel && onAction && (
            <Button
              size="sm"
              color="secondary"
              className="mt-3 bg-[#c96442] text-[#faf9f5]"
              isLoading={isRunningAction}
              startContent={!isRunningAction && actionIcon ? <Icon icon={actionIcon} className="h-4 w-4" /> : undefined}
              onPress={handleAction}
            >
              {actionLabel}
            </Button>
          )}
        </div>
        <Button
          isIconOnly
          size="sm"
          variant="light"
          className="h-7 w-7 min-w-7 flex-shrink-0 text-[#77756f] dark:text-[#b0aea5]"
          onPress={handleDismiss}
          aria-label={t('dismissIntro')}
        >
          <Icon icon="lucide:x" className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
};
