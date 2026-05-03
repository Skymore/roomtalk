const LANGUAGE_LOCALES: Record<string, string> = {
  en: 'en-US',
  zh: 'zh-CN',
  hi: 'hi-IN',
  ja: 'ja-JP',
  ko: 'ko-KR',
};

const resolveLocale = (language?: string): string => {
  const normalized = (language || 'en').toLowerCase();
  const baseLanguage = normalized.split('-')[0];

  return LANGUAGE_LOCALES[baseLanguage] || language || 'en-US';
};

export const formatTime = (timestamp: string, language?: string): string => {
  const date = new Date(timestamp);
  const now = new Date();

  if (!Number.isFinite(date.getTime())) {
    return '';
  }

  const locale = resolveLocale(language);
  const timeFormatter = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
  });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDay = Math.floor((startOfToday.getTime() - startOfDate.getTime()) / 86_400_000);

  // 今天内的消息显示时间
  if (diffDay <= 0) {
    return timeFormatter.format(date);
  }

  // 昨天的消息
  if (diffDay === 1) {
    const relativeFormatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    return `${relativeFormatter.format(-1, 'day')} ${timeFormatter.format(date)}`;
  }

  // 7天内的消息显示星期几
  if (diffDay < 7) {
    const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(date);
    return `${weekday} ${timeFormatter.format(date)}`;
  }

  // 更早的消息显示完整日期
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
};

export const formatDate = (dateString: string | number | Date | undefined, language?: string): string => {
  if (!dateString) return '';

  const date = new Date(dateString);
  if (!Number.isFinite(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat(resolveLocale(language), {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).format(date);
};

export const formatUsdCost = (value?: number | null): string => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return '$0.000000';
  }

  if (value < 0.000001) {
    return '<$0.000001';
  }

  if (value < 0.01) {
    return `$${value.toFixed(6)}`;
  }

  if (value < 1) {
    return `$${value.toFixed(4)}`;
  }

  return `$${value.toFixed(2)}`;
};
