import React from 'react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { RoomPostingSchedule } from '../utils/types';

const DAY_LABEL_KEYS = ['daySun', 'dayMon', 'dayTue', 'dayWed', 'dayThu', 'dayFri', 'daySat'];

interface PostingScheduleDetailsProps {
  postingSchedule?: RoomPostingSchedule;
  showTitle?: boolean;
}

export const PostingScheduleDetails: React.FC<PostingScheduleDetailsProps> = ({
  postingSchedule,
  showTitle = true,
}) => {
  const { t } = useTranslation();
  const postingWindowRows = React.useMemo(() => (
    postingSchedule?.enabled
      ? postingSchedule.windows.map((window) => {
          const days = window.days
            .filter(day => day >= 0 && day < DAY_LABEL_KEYS.length)
            .map(day => t(DAY_LABEL_KEYS[day]))
            .join(', ');
          return {
            days,
            time: `${window.start} - ${window.end}`,
          };
        })
      : []
  ), [postingSchedule, t]);

  return (
    <div className="space-y-2 p-2 text-xs">
      {showTitle && (
        <div className="flex items-center gap-1.5 font-semibold">
          <Icon icon="lucide:calendar-clock" className="h-3.5 w-3.5 text-[#c96442]" />
          {t('postingScheduleDetails')}
        </div>
      )}
      {postingWindowRows.length > 0 ? (
        <div className="space-y-1.5">
          {postingWindowRows.map((window, index) => (
            <div key={`${window.days}-${window.time}-${index}`} className="rounded-md bg-[#f0eee6] px-2 py-1.5 dark:bg-[#2a2a28]">
              <div className="font-medium">{window.days}</div>
              <div className="text-[#5e5d59] dark:text-[#b0aea5]">{window.time}</div>
            </div>
          ))}
          {postingSchedule?.timezone && (
            <div className="text-[11px] text-[#5e5d59] dark:text-[#b0aea5]">
              {postingSchedule.timezone}
            </div>
          )}
        </div>
      ) : (
        <div className="text-[#5e5d59] dark:text-[#b0aea5]">{t('noPostingWindows')}</div>
      )}
    </div>
  );
};
