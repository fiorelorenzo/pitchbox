// LOR-297: previewCron's English `description` is unchanged by the
// descriptor refactor (the scheduler and any other machine-facing reader
// keep seeing exactly the same text), and `descriptor` carries enough
// structure for a locale-aware renderer to reconstruct it without parsing
// English back apart - see web/tests/cron-descriptor-i18n.test.ts for the
// Italian side of that contract.
import { describe, expect, it } from 'vitest';
import { previewCron } from '../src/cron.js';

const FIXED_NOW = new Date('2026-01-01T00:00:00Z');

describe('previewCron', () => {
  it('describes a fixed daily time as "every day at HH:MM"', () => {
    const preview = previewCron('30 9 * * *', { currentDate: FIXED_NOW });
    if (!preview.valid) throw new Error('expected a valid preview');
    expect(preview.description).toBe('Every day at 09:30');
    expect(preview.descriptor).toEqual({
      kind: 'schedule',
      time: { kind: 'at-times', times: [{ hour: 9, minute: 30 }] },
      day: { kind: 'every-day' },
      months: null,
    });
  });

  it('drops the redundant "every day" when the cadence is already hourly', () => {
    const preview = previewCron('15 * * * *', { currentDate: FIXED_NOW });
    if (!preview.valid) throw new Error('expected a valid preview');
    expect(preview.description).toBe('Every hour at :15');
    expect(preview.descriptor).toEqual({
      kind: 'schedule',
      time: { kind: 'hourly-at-minute', minute: 15 },
      day: { kind: 'every-day' },
      months: null,
    });
  });

  it('keeps a month restriction visible even when the day is otherwise "every day"', () => {
    const preview = previewCron('0 * * 1 *', { currentDate: FIXED_NOW });
    if (!preview.valid) throw new Error('expected a valid preview');
    expect(preview.description).toBe('Every hour at :00, every day in January');
    expect(preview.descriptor).toEqual({
      kind: 'schedule',
      time: { kind: 'hourly-at-minute', minute: 0 },
      day: { kind: 'every-day' },
      months: [1],
    });
  });

  it('collapses Mon-Fri into "every weekday"', () => {
    const preview = previewCron('0 8 * * 1-5', { currentDate: FIXED_NOW });
    if (!preview.valid) throw new Error('expected a valid preview');
    expect(preview.description).toBe('Every weekday at 08:00');
    expect(preview.descriptor).toEqual({
      kind: 'schedule',
      time: { kind: 'at-times', times: [{ hour: 8, minute: 0 }] },
      day: { kind: 'weekday' },
      months: null,
    });
  });

  it('lists specific weekdays with a localized-ready day index, not a rendered name', () => {
    const preview = previewCron('0 18 * * 2,4', { currentDate: FIXED_NOW });
    if (!preview.valid) throw new Error('expected a valid preview');
    expect(preview.description).toBe('Every Tuesday and Thursday at 18:00');
    expect(preview.descriptor).toEqual({
      kind: 'schedule',
      time: { kind: 'at-times', times: [{ hour: 18, minute: 0 }] },
      day: { kind: 'on-weekdays', days: [2, 4] },
      months: null,
    });
  });

  it('describes a step expression as "every N minutes"', () => {
    const preview = previewCron('*/15 * * * *', { currentDate: FIXED_NOW });
    if (!preview.valid) throw new Error('expected a valid preview');
    expect(preview.description).toBe('Every 15 minutes');
    expect(preview.descriptor).toEqual({
      kind: 'schedule',
      time: { kind: 'every-n-minutes', n: 15 },
      day: { kind: 'every-day' },
      months: null,
    });
  });

  it('OR-combines a restricted day-of-month with a restricted day-of-week per cron semantics', () => {
    const preview = previewCron('0 7 1 * 1', { currentDate: FIXED_NOW });
    if (!preview.valid) throw new Error('expected a valid preview');
    expect(preview.description).toBe('On day 1 of the month or on Monday at 07:00');
    expect(preview.descriptor).toEqual({
      kind: 'schedule',
      time: { kind: 'at-times', times: [{ hour: 7, minute: 0 }] },
      day: { kind: 'on-days-of-month-or-weekdays', days: [1], weekdays: [1] },
      months: null,
    });
  });

  it('reports the parser error and no descriptor for an unparseable expression', () => {
    const preview = previewCron('not a cron', { currentDate: FIXED_NOW });
    expect(preview.valid).toBe(false);
    if (preview.valid) throw new Error('expected an invalid preview');
    expect(preview.error.length).toBeGreaterThan(0);
  });

  it('requires a non-empty expression', () => {
    const preview = previewCron('   ');
    expect(preview).toEqual({ valid: false, error: 'Cron expression is required.' });
  });
});
