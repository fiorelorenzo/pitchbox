/**
 * Relative-time and duration formatting, shared by every surface that shows
 * a timestamp (drafts, runs, campaigns, contacts, the run log, ...). Each
 * function takes an optional trailing `locale` (LOR-263): omit it and the
 * catalogue's own fallback resolves English, so every existing call site
 * keeps compiling and rendering exactly as before until its own surface
 * threads `locale` through - this file is the one place that owns the
 * `time.*` prefix (dict/time.ts) precisely because ~20 files reach it and no
 * single surface's PR should have to touch every one of them at once.
 */
import { t, type Locale } from '$lib/i18n/index.js';

/** Formats a date as a human-readable relative time string, e.g. "5 min ago" */
export function relativeTime(
  date: Date | string | null | undefined,
  locale?: Locale | null,
): string {
  if (!date) return '-';
  const d = typeof date === 'string' ? new Date(date) : date;
  const diffMs = Date.now() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 10) return t(locale, 'time.just-now');
  if (diffSec < 60) return t(locale, 'time.seconds-ago', { n: diffSec });
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t(locale, 'time.minutes-ago', { n: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t(locale, 'time.hours-ago', { n: diffHr });
  const diffDay = Math.floor(diffHr / 24);
  return t(locale, 'time.days-ago', { n: diffDay });
}

/** Formats a duration in ms as a human-readable string, e.g. "1m 14s" */
export function formatDuration(ms: number | null | undefined, locale?: Locale | null): string {
  if (ms == null) return '-';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return t(locale, 'time.duration-seconds', { n: totalSec });
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0
    ? t(locale, 'time.duration-minutes-seconds', { min, sec })
    : t(locale, 'time.duration-minutes', { min });
}

/** Formats a relative offset in ms from run start, e.g. "+2s", "+1m 14s" */
export function formatOffset(ms: number, locale?: Locale | null): string {
  if (ms < 1000) return t(locale, 'time.just-now');
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return t(locale, 'time.offset-seconds', { n: totalSec });
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) {
    return sec > 0
      ? t(locale, 'time.offset-minutes-seconds', { min, sec })
      : t(locale, 'time.offset-minutes', { min });
  }
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0
    ? t(locale, 'time.offset-hours-minutes', { hr, remMin })
    : t(locale, 'time.offset-hours', { hr });
}

/**
 * Granular relative time for the runlog. Avoids the "just now" blanket that
 * groups every event arriving in a streaming burst, and keeps seconds visible
 * inside the first hour so adjacent events read as distinct.
 *   - <1s   -> "now"
 *   - <60s  -> "5s ago"
 *   - <60m  -> "1m 5s ago"
 *   - <24h  -> "1h 5m ago"
 *   - else  -> "Xd ago"
 */
export function relativeTimeFine(
  date: Date | string | null | undefined,
  locale?: Locale | null,
): string {
  if (!date) return '-';
  const d = typeof date === 'string' ? new Date(date) : date;
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 1000) return t(locale, 'time.now');
  const totalSec = Math.floor(diffMs / 1000);
  if (totalSec < 60) return t(locale, 'time.seconds-ago', { n: totalSec });
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) {
    return sec > 0
      ? t(locale, 'time.minutes-seconds-ago', { min, sec })
      : t(locale, 'time.minutes-ago-fine', { min });
  }
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) {
    return remMin > 0
      ? t(locale, 'time.hours-minutes-ago', { hr, remMin })
      : t(locale, 'time.hours-ago', { n: hr });
  }
  const day = Math.floor(hr / 24);
  return t(locale, 'time.days-ago', { n: day });
}

/**
 * Formats a future timestamp relative to now, e.g. "in 5 min", "in 2h" - the
 * counterpart to `relativeTime` for a scheduled next run. A timestamp that
 * has already passed is flagged "overdue" rather than misreported as "in
 * -5 min": an active campaign's next run should never lag behind now, so
 * this doubles as a diagnostic signal (#234).
 */
export function relativeTimeUntil(
  date: Date | string | null | undefined,
  locale?: Locale | null,
): string {
  if (!date) return '-';
  const d = typeof date === 'string' ? new Date(date) : date;
  const diffMs = d.getTime() - Date.now();
  const overdue = diffMs < 0;
  const diffSec = Math.floor(Math.abs(diffMs) / 1000);
  if (diffSec < 10) return t(locale, overdue ? 'time.overdue' : 'time.due-now');
  if (diffSec < 60) {
    return overdue
      ? t(locale, 'time.overdue-by-seconds', { n: diffSec })
      : t(locale, 'time.in-seconds', { n: diffSec });
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return overdue
      ? t(locale, 'time.overdue-by-minutes', { n: diffMin })
      : t(locale, 'time.in-minutes', { n: diffMin });
  }
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) {
    return overdue
      ? t(locale, 'time.overdue-by-hours', { n: diffHr })
      : t(locale, 'time.in-hours', { n: diffHr });
  }
  const diffDay = Math.floor(diffHr / 24);
  return overdue
    ? t(locale, 'time.overdue-by-days', { n: diffDay })
    : t(locale, 'time.in-days', { n: diffDay });
}
