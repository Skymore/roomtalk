import React from 'react';
import { Button, Select, SelectItem, Switch } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { HEROUI_VISIBLE_LABEL_ARIA_OVERRIDE } from '../utils/accessibility';

const DAY_OPTIONS = [
  { value: 0, labelKey: 'daySun' },
  { value: 1, labelKey: 'dayMon' },
  { value: 2, labelKey: 'dayTue' },
  { value: 3, labelKey: 'dayWed' },
  { value: 4, labelKey: 'dayThu' },
  { value: 5, labelKey: 'dayFri' },
  { value: 6, labelKey: 'daySat' },
];

const MAJOR_TIMEZONES = [
  { value: 'UTC', label: 'UTC' },
  { value: 'America/Los_Angeles', label: 'Los Angeles' },
  { value: 'America/Denver', label: 'Denver' },
  { value: 'America/Chicago', label: 'Chicago' },
  { value: 'America/New_York', label: 'New York' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Paris', label: 'Paris / Berlin' },
  { value: 'Asia/Dubai', label: 'Dubai' },
  { value: 'Asia/Kolkata', label: 'India' },
  { value: 'Asia/Singapore', label: 'Singapore' },
  { value: 'Asia/Shanghai', label: 'Beijing / Shanghai / Hong Kong' },
  { value: 'Asia/Tokyo', label: 'Tokyo / Seoul' },
  { value: 'Australia/Sydney', label: 'Sydney' },
];

const formatOffsetLabel = (timezone: string) => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
      hour: '2-digit',
    }).formatToParts(new Date());
    const value = parts.find(part => part.type === 'timeZoneName')?.value || 'GMT';
    if (value === 'GMT') {
      return 'UTC+00:00';
    }

    const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(value);
    if (!match) {
      return value.replace('GMT', 'UTC');
    }

    return `UTC${match[1]}${match[2].padStart(2, '0')}:${match[3] || '00'}`;
  } catch {
    return 'UTC';
  }
};

const buildTimezoneOption = (value: string, label: string) => ({
  value,
  label,
  displayLabel: `${formatOffsetLabel(value)} ${label}`,
});

const getTimezoneOptions = (timezone: string) => {
  const options = MAJOR_TIMEZONES.map(option => buildTimezoneOption(option.value, option.label));
  if (!timezone || options.some(option => option.value === timezone)) {
    return options;
  }

  return [buildTimezoneOption(timezone, timezone), ...options];
};

const selectClassNames = {
  trigger: 'min-h-11 h-11 rounded-lg border border-[#dedbd0] bg-[#faf9f5] shadow-none dark:border-[#30302e] dark:bg-[#1d1d1b]',
  value: 'text-sm font-semibold text-[#141413] dark:text-[#faf9f5]',
  popoverContent: 'border border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]',
  listboxWrapper: 'max-h-56 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:#5e5d59_transparent]',
} as const;

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'));
const MINUTE_OPTIONS = Array.from({ length: 12 }, (_, step) => String(step * 5).padStart(2, '0'));

const splitTime = (value: string): [string, string] => {
  const [hour = '09', minute = '00'] = value.split(':');
  return [hour.padStart(2, '0'), minute.padStart(2, '0')];
};

interface TimeFieldProps {
  label: string;
  value: string;
  onChange: (time: string) => void;
}

const TimeField: React.FC<TimeFieldProps> = ({ label, value, onChange }) => {
  const [hour, minute] = splitTime(value);
  const minuteOptions = MINUTE_OPTIONS.includes(minute)
    ? MINUTE_OPTIONS
    : [...MINUTE_OPTIONS, minute].sort();

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-[#5e5d59] dark:text-[#b0aea5]">{label}</span>
      <div className="flex items-center gap-1.5">
        <Select
          aria-label={`${label} (hour)`}
          selectedKeys={[hour]}
          disallowEmptySelection
          classNames={selectClassNames}
          onSelectionChange={(keys) => {
            const next = Array.from(keys)[0]?.toString();
            if (next) onChange(`${next}:${minute}`);
          }}
        >
          {HOUR_OPTIONS.map((item) => (
            <SelectItem key={item} textValue={item}>{item}</SelectItem>
          ))}
        </Select>
        <span className="text-sm font-semibold text-[#5e5d59] dark:text-[#8f8d86]">:</span>
        <Select
          aria-label={`${label} (minute)`}
          selectedKeys={[minute]}
          disallowEmptySelection
          classNames={selectClassNames}
          onSelectionChange={(keys) => {
            const next = Array.from(keys)[0]?.toString();
            if (next) onChange(`${hour}:${next}`);
          }}
        >
          {minuteOptions.map((item) => (
            <SelectItem key={item} textValue={item}>{item}</SelectItem>
          ))}
        </Select>
      </div>
    </div>
  );
};

interface PostingScheduleEditorProps {
  enabled: boolean;
  timezone: string;
  startTime: string;
  endTime: string;
  selectedDays: number[];
  onEnabledChange: (enabled: boolean) => void;
  onTimezoneChange: (timezone: string) => void;
  onStartTimeChange: (time: string) => void;
  onEndTimeChange: (time: string) => void;
  onSelectedDaysChange: (days: number[]) => void;
}

export const PostingScheduleEditor: React.FC<PostingScheduleEditorProps> = ({
  enabled,
  timezone,
  startTime,
  endTime,
  selectedDays,
  onEnabledChange,
  onTimezoneChange,
  onStartTimeChange,
  onEndTimeChange,
  onSelectedDaysChange,
}) => {
  const { t } = useTranslation();
  const timezoneOptions = React.useMemo(() => {
    return getTimezoneOptions(timezone);
  }, [timezone]);

  const toggleDay = (day: number) => {
    onSelectedDaysChange(
      selectedDays.includes(day)
        ? selectedDays.filter((value) => value !== day)
        : [...selectedDays, day].sort((a, b) => a - b),
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[#5e5d59] dark:text-[#b0aea5]">
          <Icon icon="lucide:clock-3" className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="truncate">{t('postingSchedule')}</span>
        </div>
        <Switch
          size="sm"
          isSelected={enabled}
          onValueChange={onEnabledChange}
          classNames={{
            base: 'flex-shrink-0',
            label: 'text-xs font-medium text-[#5e5d59] dark:text-[#b0aea5]',
          }}
        >
          {enabled ? t('enabled') : t('disabled')}
        </Switch>
      </div>

      {enabled && (
        <div className="space-y-3">
          <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_2rem_minmax(0,1fr)]">
            <TimeField label={t('startTime')} value={startTime} onChange={onStartTimeChange} />
            <div className="hidden h-11 items-center justify-center text-[#5e5d59] dark:text-[#8f8d86] sm:flex">
              <Icon icon="lucide:arrow-right" className="h-4 w-4" />
            </div>
            <TimeField label={t('endTime')} value={endTime} onChange={onEndTimeChange} />
          </div>

          <Select
            label={t('timezone')}
            aria-label={HEROUI_VISIBLE_LABEL_ARIA_OVERRIDE}
            selectedKeys={[timezone]}
            onSelectionChange={(keys) => {
              const selected = Array.from(keys)[0]?.toString();
              if (selected) onTimezoneChange(selected);
            }}
            classNames={{
              trigger: 'min-h-11 rounded-lg border border-[#dedbd0] bg-[#faf9f5] shadow-none dark:border-[#30302e] dark:bg-[#1d1d1b]',
              value: 'text-sm font-semibold text-[#141413] dark:text-[#faf9f5]',
              popoverContent: 'border border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]',
              listboxWrapper: 'max-h-64 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:#5e5d59_transparent]',
            }}
          >
            {timezoneOptions.map((item) => (
              <SelectItem key={item.value} textValue={item.displayLabel}>
                {item.displayLabel}
              </SelectItem>
            ))}
          </Select>

          <div className="grid grid-cols-7 gap-1.5">
            {DAY_OPTIONS.map((day) => {
              const selected = selectedDays.includes(day.value);
              return (
                <Button
                  key={day.value}
                  size="sm"
                  variant={selected ? 'solid' : 'flat'}
                  className={`h-8 min-w-0 rounded-lg px-0 text-xs font-semibold ${
                    selected
                      ? 'bg-secondary text-secondary-foreground shadow-[0_0_0_1px_rgba(173,82,55,0.65)]'
                      : 'bg-[#e8e6dc] text-[#5e5d59] dark:bg-[#30302e] dark:text-[#b0aea5]'
                  }`}
                  onPress={() => toggleDay(day.value)}
                >
                  {t(day.labelKey)}
                </Button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
