/**
 * Ready-made cron shapes for the campaign schedule field, so scheduling a
 * campaign doesn't require knowing cron syntax for the common cases. The
 * raw expression stays fully editable - these just seed it (#234).
 */

export type CronPresetId = 'hourly' | 'daily' | 'weekly' | 'custom';

export const WEEKDAY_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
];

/** "HH:MM" (a native `<input type="time">` value) -> { hour, minute}. Falls back to 09:00 for a malformed or empty string. */
export function parseTimeInput(time: string): { hour: number; minute: number } {
  const [hour, minute] = time.split(':').map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return { hour: 9, minute: 0 };
  return { hour, minute };
}

export function formatTimeInput(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function buildHourlyCron(): string {
  return '0 * * * *';
}

export function buildDailyCron(hour: number, minute: number): string {
  return `${minute} ${hour} * * *`;
}

export function buildWeeklyCron(dayOfWeek: number, hour: number, minute: number): string {
  return `${minute} ${hour} * * ${dayOfWeek}`;
}

export type DetectedPreset =
  | { id: 'hourly' }
  | { id: 'daily'; hour: number; minute: number }
  | { id: 'weekly'; dayOfWeek: number; hour: number; minute: number }
  | { id: 'custom' };

/**
 * Best-effort reverse mapping from a raw cron string to the preset (and its
 * parameters) that would generate it, so editing an existing campaign
 * pre-selects the matching preset tab instead of always defaulting to
 * "Custom".
 */
export function detectPreset(expression: string): DetectedPreset {
  const trimmed = expression.trim();
  if (trimmed === buildHourlyCron()) return { id: 'hourly' };

  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(trimmed);
  if (daily) {
    const minute = Number(daily[1]);
    const hour = Number(daily[2]);
    if (hour <= 23 && minute <= 59) return { id: 'daily', hour, minute };
  }

  const weekly = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/.exec(trimmed);
  if (weekly) {
    const minute = Number(weekly[1]);
    const hour = Number(weekly[2]);
    const dayOfWeek = Number(weekly[3]);
    if (hour <= 23 && minute <= 59) return { id: 'weekly', dayOfWeek, hour, minute };
  }

  return { id: 'custom' };
}
