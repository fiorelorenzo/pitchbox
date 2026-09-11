/**
 * Cron parsing, validation, and human-readable preview for campaign
 * schedules. The scheduler (`scheduler.ts`) and the web UI (campaign
 * create/edit forms, the campaigns list, and the campaign detail page)
 * both import this module instead of parsing cron independently, so the UI
 * can never accept an expression the scheduler will reject, or reject one
 * the scheduler would have run happily (#234).
 *
 * `@pitchbox/web` depends on `@pitchbox/daemon` (it can embed this same
 * daemon in-process, see `embed.ts`), so it reaches this module via the
 * `@pitchbox/daemon/cron` export instead of adding its own `cron-parser`
 * dependency and risking the two libraries drifting apart.
 *
 * `description` (and `error`) stay English always (LOR-297): this module
 * has no notion of a request locale, and previewCron's raw text is also
 * what a future machine-facing caller (logging, a diagnostic) would want
 * unchanged. A caller that shows the successful preview to a person - today
 * only `CronScheduleField.svelte` - renders `descriptor` instead, in its
 * own locale, rather than parsing this English sentence back apart. See
 * `web/src/lib/cron-descriptor-i18n.ts`.
 */
import { CronExpressionParser } from 'cron-parser';

export type CronPreview =
  | { valid: true; description: string; nextRuns: Date[]; descriptor: CronDescriptor }
  | { valid: false; error: string };

/** Structural subset of cron-parser's CronField that the describers need. */
type FieldLike = { isWildcard: boolean; values: ReadonlyArray<number | string> };

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function numericValues(field: FieldLike): number[] {
  return field.values.filter((v): v is number => typeof v === 'number');
}

/** "1, 2 and 3" - reads better than a bare comma list for 2+ items. */
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Detects an evenly spaced "step from zero" field (what a step expression
 * like `minute/15` expands into) so it can be described as "every N
 * minutes/hours" instead of a raw list.
 */
function stepSize(values: number[], rangeSize: number): number | null {
  if (values.length < 2 || values[0] !== 0) return null;
  const step = values[1] - values[0];
  if (step <= 0) return null;
  const expectedCount = Math.floor((rangeSize - 1) / step) + 1;
  if (values.length !== expectedCount) return null;
  for (let i = 1; i < values.length; i++) {
    if (values[i] - values[i - 1] !== step) return null;
  }
  return step;
}

/**
 * Locale-neutral shape of what the time/day fields resolve to - numbers and
 * a finite set of tags, no rendered text - so a caller that knows the
 * reader's language can compose its own sentence from it (LOR-297) instead
 * of localising by pattern-matching the English one.
 */
export type CronTimeDescriptor =
  | { kind: 'every-minute' }
  | { kind: 'every-n-minutes'; n: number }
  | { kind: 'hourly-at-minute'; minute: number }
  | { kind: 'hourly-at-minutes'; minutes: number[] }
  | { kind: 'every-minute-during-hours'; hours: number[] }
  | { kind: 'every-n-hours-at-minute'; n: number; minute: number }
  | { kind: 'at-times'; times: { hour: number; minute: number }[] };

export type CronDayDescriptor =
  | { kind: 'every-day' }
  | { kind: 'weekday' }
  | { kind: 'weekend' }
  | { kind: 'on-weekdays'; days: number[] }
  | { kind: 'on-days-of-month'; days: number[] }
  | { kind: 'on-days-of-month-or-weekdays'; days: number[]; weekdays: number[] };

export type CronDescriptor =
  | { kind: 'schedule'; time: CronTimeDescriptor; day: CronDayDescriptor; months: number[] | null }
  | { kind: 'custom'; expression: string };

function timeDescriptor(minuteField: FieldLike, hourField: FieldLike): CronTimeDescriptor {
  const minutes = numericValues(minuteField);
  const hours = numericValues(hourField);

  if (minuteField.isWildcard && hourField.isWildcard) return { kind: 'every-minute' };

  if (hourField.isWildcard) {
    const step = stepSize(minutes, 60);
    if (step) return { kind: 'every-n-minutes', n: step };
    if (minutes.length === 1) return { kind: 'hourly-at-minute', minute: minutes[0] };
    return { kind: 'hourly-at-minutes', minutes };
  }

  if (minuteField.isWildcard) {
    return { kind: 'every-minute-during-hours', hours };
  }

  const hourStep = stepSize(hours, 24);
  if (hourStep && minutes.length === 1) {
    return { kind: 'every-n-hours-at-minute', n: hourStep, minute: minutes[0] };
  }

  const times: { hour: number; minute: number }[] = [];
  for (const h of hours) for (const m of minutes) times.push({ hour: h, minute: m });
  return { kind: 'at-times', times };
}

function dayDescriptor(
  dayOfMonth: FieldLike,
  month: FieldLike,
  dayOfWeek: FieldLike,
): { day: CronDayDescriptor; months: number[] | null } {
  const weekdaysOf = (values: number[]) =>
    [...new Set(values.map((v) => v % 7))].sort((a, b) => a - b);

  let day: CronDayDescriptor;
  if (dayOfWeek.isWildcard && dayOfMonth.isWildcard) {
    day = { kind: 'every-day' };
  } else if (!dayOfWeek.isWildcard && dayOfMonth.isWildcard) {
    const weekdays = weekdaysOf(numericValues(dayOfWeek));
    if (weekdays.length === 5 && !weekdays.includes(0) && !weekdays.includes(6)) {
      day = { kind: 'weekday' };
    } else if (weekdays.length === 2 && weekdays.includes(0) && weekdays.includes(6)) {
      day = { kind: 'weekend' };
    } else {
      day = { kind: 'on-weekdays', days: weekdays };
    }
  } else if (dayOfWeek.isWildcard && !dayOfMonth.isWildcard) {
    day = { kind: 'on-days-of-month', days: numericValues(dayOfMonth) };
  } else {
    // Standard cron semantics: when both fields are restricted they are
    // OR'd together, not intersected.
    day = {
      kind: 'on-days-of-month-or-weekdays',
      days: numericValues(dayOfMonth),
      weekdays: weekdaysOf(numericValues(dayOfWeek)),
    };
  }

  const months = month.isWildcard ? null : numericValues(month);
  return { day, months };
}

function renderTimeEn(time: CronTimeDescriptor): string {
  switch (time.kind) {
    case 'every-minute':
      return 'every minute';
    case 'every-n-minutes':
      return `every ${time.n} minute${time.n === 1 ? '' : 's'}`;
    case 'hourly-at-minute':
      return `every hour at :${pad2(time.minute)}`;
    case 'hourly-at-minutes':
      return `every hour at minutes ${joinList(time.minutes.map(String))}`;
    case 'every-minute-during-hours':
      return `every minute during hour${time.hours.length === 1 ? '' : 's'} ${joinList(time.hours.map(pad2))}`;
    case 'every-n-hours-at-minute':
      return `every ${time.n} hour${time.n === 1 ? '' : 's'} at :${pad2(time.minute)}`;
    case 'at-times':
      return `at ${joinList(time.times.map((t) => `${pad2(t.hour)}:${pad2(t.minute)}`))}`;
  }
}

function renderDayEn(day: CronDayDescriptor, months: number[] | null): string {
  let dayPart: string;
  switch (day.kind) {
    case 'every-day':
      dayPart = 'every day';
      break;
    case 'weekday':
      dayPart = 'every weekday';
      break;
    case 'weekend':
      dayPart = 'every weekend';
      break;
    case 'on-weekdays':
      dayPart = `every ${joinList(day.days.map((d) => DAY_NAMES[d]))}`;
      break;
    case 'on-days-of-month':
      dayPart = `on day ${joinList(day.days.map(String))} of the month`;
      break;
    case 'on-days-of-month-or-weekdays':
      dayPart = `on day ${joinList(day.days.map(String))} of the month or on ${joinList(day.weekdays.map((d) => DAY_NAMES[d]))}`;
      break;
  }
  if (months) {
    dayPart += ` in ${joinList(months.map((m) => MONTH_NAMES[m - 1]))}`;
  }
  return dayPart;
}

/**
 * Parses and validates a cron expression with the exact library the
 * scheduler uses, always interpreting it in UTC (matching `scheduler.ts`
 * and the "times are in UTC" copy shown next to the raw field). On success,
 * returns a human-readable description and the next few concrete run
 * times; on failure, returns the parser's own error message so the caller
 * can show it verbatim instead of a generic "invalid" toast.
 */
export function previewCron(
  expression: string,
  opts: { currentDate?: Date; count?: number } = {},
): CronPreview {
  const trimmed = expression.trim();
  if (!trimmed) return { valid: false, error: 'Cron expression is required.' };
  try {
    const parsed = CronExpressionParser.parse(trimmed, {
      currentDate: opts.currentDate ?? new Date(),
      tz: 'UTC',
    });
    const nextRuns = parsed.take(opts.count ?? 3).map((d) => d.toDate());
    let description: string;
    let descriptor: CronDescriptor;
    try {
      const { minute, hour, dayOfMonth, month, dayOfWeek } = parsed.fields;
      const time = timeDescriptor(minute, hour);
      const { day, months } = dayDescriptor(dayOfMonth, month, dayOfWeek);
      const timePhrase = renderTimeEn(time);
      const dayPhrase = renderDayEn(day, months);
      const phrase =
        timePhrase.startsWith('every') && dayPhrase !== 'every day'
          ? `${timePhrase}, ${dayPhrase}`
          : timePhrase.startsWith('every')
            ? timePhrase
            : `${dayPhrase} ${timePhrase}`;
      description = phrase.charAt(0).toUpperCase() + phrase.slice(1);
      descriptor = { kind: 'schedule', time, day, months };
    } catch {
      description = `Custom schedule (${parsed.stringify()})`;
      descriptor = { kind: 'custom', expression: parsed.stringify() };
    }
    return { valid: true, description, nextRuns, descriptor };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}
