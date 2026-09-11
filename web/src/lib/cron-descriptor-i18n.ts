/**
 * Renders `@pitchbox/daemon/cron`'s locale-neutral `CronDescriptor` into the
 * reader's own language (LOR-297). `previewCron()` itself stays English
 * always - it is also the scheduler's own machine-facing text, and it has
 * no notion of a request locale to push through - so this is the "localize
 * at the render" half of that split, called from `CronScheduleField.svelte`
 * where the schedule preview is actually shown.
 */
import { t, tn, type Locale } from './i18n/index.js';
import type { CronDayDescriptor, CronDescriptor, CronTimeDescriptor } from '@pitchbox/daemon/cron';

const WEEKDAY_KEYS = [
  'campaigns.cron.weekday.sunday',
  'campaigns.cron.weekday.monday',
  'campaigns.cron.weekday.tuesday',
  'campaigns.cron.weekday.wednesday',
  'campaigns.cron.weekday.thursday',
  'campaigns.cron.weekday.friday',
  'campaigns.cron.weekday.saturday',
] as const;

const MONTH_KEYS = [
  'campaigns.cron.month.january',
  'campaigns.cron.month.february',
  'campaigns.cron.month.march',
  'campaigns.cron.month.april',
  'campaigns.cron.month.may',
  'campaigns.cron.month.june',
  'campaigns.cron.month.july',
  'campaigns.cron.month.august',
  'campaigns.cron.month.september',
  'campaigns.cron.month.october',
  'campaigns.cron.month.november',
  'campaigns.cron.month.december',
] as const;

/** Cadence kinds whose English rendering starts with "every" - the same
 * grammatical distinction `daemon/src/cron.ts`'s `describe()` makes with a
 * `startsWith('every')` check on its own rendered string, expressed here
 * against the tag instead since this renderer never produces English. */
const REPEATING_TIME_KINDS: Record<CronTimeDescriptor['kind'], boolean> = {
  'every-minute': true,
  'every-n-minutes': true,
  'hourly-at-minute': true,
  'hourly-at-minutes': true,
  'every-minute-during-hours': true,
  'every-n-hours-at-minute': true,
  'at-times': false,
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function joinLocalized(items: string[], locale: Locale): string {
  if (items.length <= 1) return items[0] ?? '';
  const and = t(locale, 'campaigns.cron.desc.list-and');
  return `${items.slice(0, -1).join(', ')} ${and} ${items[items.length - 1]}`;
}

function renderTime(time: CronTimeDescriptor, locale: Locale): string {
  switch (time.kind) {
    case 'every-minute':
      return t(locale, 'campaigns.cron.desc.every-minute');
    case 'every-n-minutes':
      return tn(locale, 'campaigns.cron.desc.every-n-minutes', time.n);
    case 'hourly-at-minute':
      return t(locale, 'campaigns.cron.desc.hourly-at-minute', { minute: pad2(time.minute) });
    case 'hourly-at-minutes':
      return t(locale, 'campaigns.cron.desc.hourly-at-minutes', {
        minutes: joinLocalized(time.minutes.map(String), locale),
      });
    case 'every-minute-during-hours':
      return tn(locale, 'campaigns.cron.desc.every-minute-during-hours', time.hours.length, {
        hours: joinLocalized(time.hours.map(pad2), locale),
      });
    case 'every-n-hours-at-minute':
      return tn(locale, 'campaigns.cron.desc.every-n-hours-at-minute', time.n, {
        minute: pad2(time.minute),
      });
    case 'at-times':
      return t(locale, 'campaigns.cron.desc.at-times', {
        times: joinLocalized(
          time.times.map((tm) => `${pad2(tm.hour)}:${pad2(tm.minute)}`),
          locale,
        ),
      });
  }
}

function renderDay(day: CronDayDescriptor, months: number[] | null, locale: Locale): string {
  let dayPart: string;
  switch (day.kind) {
    case 'every-day':
      dayPart = t(locale, 'campaigns.cron.desc.every-day');
      break;
    case 'weekday':
      dayPart = t(locale, 'campaigns.cron.desc.weekday');
      break;
    case 'weekend':
      dayPart = t(locale, 'campaigns.cron.desc.weekend');
      break;
    case 'on-weekdays':
      dayPart = t(locale, 'campaigns.cron.desc.on-weekdays', {
        days: joinLocalized(
          day.days.map((d) => t(locale, WEEKDAY_KEYS[d])),
          locale,
        ),
      });
      break;
    case 'on-days-of-month':
      dayPart = t(locale, 'campaigns.cron.desc.on-days-of-month', {
        days: joinLocalized(day.days.map(String), locale),
      });
      break;
    case 'on-days-of-month-or-weekdays':
      dayPart = t(locale, 'campaigns.cron.desc.on-days-of-month-or-weekdays', {
        days: joinLocalized(day.days.map(String), locale),
        weekdays: joinLocalized(
          day.weekdays.map((d) => t(locale, WEEKDAY_KEYS[d])),
          locale,
        ),
      });
      break;
  }
  if (months) {
    dayPart += ` ${t(locale, 'campaigns.cron.desc.in-months', {
      months: joinLocalized(
        months.map((m) => t(locale, MONTH_KEYS[m - 1])),
        locale,
      ),
    })}`;
  }
  return dayPart;
}

/** Mirrors `daemon/src/cron.ts`'s own English combinator: a repeating
 * cadence with nothing else to say about the day (bare "every day", no
 * month restriction) drops the day phrase as redundant; a repeating
 * cadence with anything more to say joins with a comma; a fixed time
 * always states the day first. */
export function renderCronDescription(descriptor: CronDescriptor, locale: Locale): string {
  if (descriptor.kind === 'custom') {
    return t(locale, 'campaigns.cron.desc.custom-schedule', { expression: descriptor.expression });
  }
  const timePhrase = renderTime(descriptor.time, locale);
  const dayPhrase = renderDay(descriptor.day, descriptor.months, locale);
  const isBareEveryDay = descriptor.day.kind === 'every-day' && descriptor.months === null;
  const isRepeating = REPEATING_TIME_KINDS[descriptor.time.kind];

  const phrase = isRepeating
    ? isBareEveryDay
      ? timePhrase
      : `${timePhrase}, ${dayPhrase}`
    : `${dayPhrase} ${timePhrase}`;
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}
