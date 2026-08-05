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
 */
import { CronExpressionParser } from 'cron-parser';
import type { CronExpression } from 'cron-parser';

export type CronPreview =
  { valid: true; description: string; nextRuns: Date[] } | { valid: false; error: string };

/** Structural subset of cron-parser's CronField that describe() needs. */
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

function describeTime(minuteField: FieldLike, hourField: FieldLike): string {
  const minutes = numericValues(minuteField);
  const hours = numericValues(hourField);

  if (minuteField.isWildcard && hourField.isWildcard) return 'every minute';

  if (hourField.isWildcard) {
    const step = stepSize(minutes, 60);
    if (step) return `every ${step} minute${step === 1 ? '' : 's'}`;
    if (minutes.length === 1) return `every hour at :${pad2(minutes[0])}`;
    return `every hour at minutes ${joinList(minutes.map(String))}`;
  }

  if (minuteField.isWildcard) {
    return `every minute during hour${hours.length === 1 ? '' : 's'} ${joinList(hours.map(pad2))}`;
  }

  const hourStep = stepSize(hours, 24);
  if (hourStep && minutes.length === 1) {
    return `every ${hourStep} hour${hourStep === 1 ? '' : 's'} at :${pad2(minutes[0])}`;
  }

  const times: string[] = [];
  for (const h of hours) for (const m of minutes) times.push(`${pad2(h)}:${pad2(m)}`);
  return `at ${joinList(times)}`;
}

function describeDays(dayOfMonth: FieldLike, month: FieldLike, dayOfWeek: FieldLike): string {
  const weekdayNames = (values: number[]) =>
    [...new Set(values.map((v) => v % 7))].sort((a, b) => a - b).map((v) => DAY_NAMES[v]);

  let dayPart: string;
  if (dayOfWeek.isWildcard && dayOfMonth.isWildcard) {
    dayPart = 'every day';
  } else if (!dayOfWeek.isWildcard && dayOfMonth.isWildcard) {
    const names = weekdayNames(numericValues(dayOfWeek));
    if (names.length === 5 && !names.includes('Sunday') && !names.includes('Saturday')) {
      dayPart = 'every weekday';
    } else if (names.length === 2 && names.includes('Sunday') && names.includes('Saturday')) {
      dayPart = 'every weekend';
    } else {
      dayPart = `every ${joinList(names)}`;
    }
  } else if (dayOfWeek.isWildcard && !dayOfMonth.isWildcard) {
    dayPart = `on day ${joinList(numericValues(dayOfMonth).map(String))} of the month`;
  } else {
    // Standard cron semantics: when both fields are restricted they are
    // OR'd together, not intersected.
    const names = weekdayNames(numericValues(dayOfWeek));
    dayPart = `on day ${joinList(numericValues(dayOfMonth).map(String))} of the month or on ${joinList(names)}`;
  }

  if (!month.isWildcard) {
    dayPart += ` in ${joinList(numericValues(month).map((m) => MONTH_NAMES[m - 1]))}`;
  }

  return dayPart;
}

function describe(expr: CronExpression): string {
  const { minute, hour, dayOfMonth, month, dayOfWeek } = expr.fields;
  const timePhrase = describeTime(minute, hour);
  const dayPhrase = describeDays(dayOfMonth, month, dayOfWeek);

  const phrase =
    timePhrase.startsWith('every') && dayPhrase !== 'every day'
      ? `${timePhrase}, ${dayPhrase}`
      : timePhrase.startsWith('every')
        ? timePhrase
        : `${dayPhrase} ${timePhrase}`;
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
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
    try {
      description = describe(parsed);
    } catch {
      description = `Custom schedule (${parsed.stringify()})`;
    }
    return { valid: true, description, nextRuns };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}
