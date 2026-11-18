/** Locale-aware formatting for the pooled quota view. Pure, React-free. */

import { DAY_MS, HOUR_MS, MINUTE_MS } from './poolModel';

export const formatPoolPercent = (value: number) => `${Math.round(value)}%`;

export const formatSignedPercent = (value: number) => `+${Math.round(value)}%`;

export const formatBurn = (value: number) =>
  `${value > 0 && value < 10 ? value.toFixed(1) : Math.round(value)}%/h`;

export const formatCapacity = (value: number) => `${Number(value.toFixed(2))}x`;

/** Compact duration such as "45m", "15h 49m" or "2d 18h". */
export function formatPoolDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < MINUTE_MS) return '<1m';
  if (safe < HOUR_MS) return `${Math.floor(safe / MINUTE_MS)}m`;
  if (safe < DAY_MS) {
    const hours = Math.floor(safe / HOUR_MS);
    const minutes = Math.floor((safe % HOUR_MS) / MINUTE_MS);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(safe / DAY_MS);
  const hours = Math.floor((safe % DAY_MS) / HOUR_MS);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

const getFormatter = (locale: string, options: Intl.DateTimeFormatOptions) => {
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat(locale, options);
    } catch {
      formatter = new Intl.DateTimeFormat(undefined, options);
    }
    formatterCache.set(key, formatter);
  }
  return formatter;
};

/** "Sun 4:39 PM" */
export const formatWeekdayTime = (ms: number, locale: string) =>
  `${getFormatter(locale, { weekday: 'short' }).format(ms)} ${getFormatter(locale, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(ms)}`;

/** "Nov 5" */
export const formatMonthDay = (ms: number, locale: string) =>
  getFormatter(locale, { month: 'short', day: 'numeric' }).format(ms);

/** "Fri 23" */
export const formatDayTick = (ms: number, locale: string) =>
  `${getFormatter(locale, { weekday: 'short' }).format(ms)} ${new Date(ms).getDate()}`;

/** Local midnights in [start, end]. */
export function localMidnights(start: number, end: number): number[] {
  const out: number[] = [];
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  if (cursor.getTime() < start) cursor.setDate(cursor.getDate() + 1);
  while (cursor.getTime() <= end) {
    out.push(cursor.getTime());
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/** Round an axis maximum up to a readable number. */
export function niceCeil(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((candidate) => normalized <= candidate);
  return (step ?? 10) * magnitude;
}
