// LOR-297: CronScheduleField.svelte's live schedule preview calls
// previewCron() client-side on every keystroke, so localizing it can't go
// through a server-rendered key+params payload - it has to render from
// `descriptor` right where it's shown. This is the Italian half of that
// contract (the English side, and the descriptor/description parity it
// must not drift from, is daemon/tests/cron.test.ts).
import { describe, expect, it } from 'vitest';
import { previewCron } from '@pitchbox/daemon/cron';
import { renderCronDescription } from '../src/lib/cron-descriptor-i18n.js';

const FIXED_NOW = new Date('2026-01-01T00:00:00Z');

function preview(expression: string) {
  const result = previewCron(expression, { currentDate: FIXED_NOW });
  if (!result.valid) throw new Error(`expected a valid preview for "${expression}"`);
  return result;
}

describe('renderCronDescription', () => {
  it('renders a genuine Italian sentence for a daily schedule, not the English copied over', () => {
    const p = preview('30 9 * * *');
    expect(renderCronDescription(p.descriptor, 'en')).toBe('Every day at 09:30');
    expect(renderCronDescription(p.descriptor, 'it')).toBe('Ogni giorno alle 09:30');
  });

  it('drops the redundant day phrase for an hourly cadence, in both locales', () => {
    const p = preview('15 * * * *');
    expect(renderCronDescription(p.descriptor, 'en')).toBe('Every hour at :15');
    expect(renderCronDescription(p.descriptor, 'it')).toBe('Ogni ora alle :15');
  });

  it('keeps a month restriction visible in Italian even under a bare "every day"', () => {
    const p = preview('0 * * 1 *');
    expect(renderCronDescription(p.descriptor, 'en')).toBe(
      'Every hour at :00, every day in January',
    );
    expect(renderCronDescription(p.descriptor, 'it')).toBe(
      'Ogni ora alle :00, ogni giorno a gennaio',
    );
  });

  it('translates a localized weekday list rather than the raw day index', () => {
    const p = preview('0 18 * * 2,4');
    expect(renderCronDescription(p.descriptor, 'en')).toBe('Every Tuesday and Thursday at 18:00');
    expect(renderCronDescription(p.descriptor, 'it')).toBe('Ogni Martedì e Giovedì alle 18:00');
  });

  it('pluralizes the step-minutes phrase correctly in Italian', () => {
    const p = preview('*/15 * * * *');
    expect(renderCronDescription(p.descriptor, 'en')).toBe('Every 15 minutes');
    expect(renderCronDescription(p.descriptor, 'it')).toBe('Ogni 15 minuti');
  });

  it('renders the OR-of-day-of-month-and-weekday phrase in Italian', () => {
    const p = preview('0 7 1 * 1');
    expect(renderCronDescription(p.descriptor, 'en')).toBe(
      'On day 1 of the month or on Monday at 07:00',
    );
    expect(renderCronDescription(p.descriptor, 'it')).toBe(
      'Il giorno 1 del mese oppure Lunedì alle 07:00',
    );
  });

  it('renders the custom-schedule fallback key in each locale', () => {
    const descriptor = { kind: 'custom', expression: '0 0 29 2 *' } as const;
    expect(renderCronDescription(descriptor, 'en')).toBe('Custom schedule (0 0 29 2 *)');
    expect(renderCronDescription(descriptor, 'it')).toBe(
      'Pianificazione personalizzata (0 0 29 2 *)',
    );
  });
});
