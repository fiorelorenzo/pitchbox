import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatDuration,
  formatOffset,
  relativeTime,
  relativeTimeFine,
  relativeTimeUntil,
} from '../src/lib/utils/time';

// Every function anchors on Date.now(), so pin the clock rather than racing
// real time - a flaky boundary (9.9s vs 10.0s) is exactly the kind of test
// that reads as a real bug when it is really a fixed-time assumption.
const NOW = new Date('2026-09-11T12:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

describe('relativeTime', () => {
  it('falls back to English when locale is omitted, so every existing call site keeps compiling', () => {
    expect(relativeTime(ago(5 * 60 * 1000))).toBe('5 min ago');
  });

  it('reads in Italian once a caller threads the locale through', () => {
    expect(relativeTime(ago(5 * 60 * 1000), 'it')).toBe('5 min fa');
    expect(relativeTime(ago(3 * 1000), 'it')).toBe('proprio ora');
    expect(relativeTime(ago(45 * 1000), 'it')).toBe('45s fa');
    expect(relativeTime(ago(3 * 60 * 60 * 1000), 'it')).toBe('3h fa');
    expect(relativeTime(ago(2 * 24 * 60 * 60 * 1000), 'it')).toBe('2g fa');
  });

  it('returns the placeholder for a missing date in either locale', () => {
    expect(relativeTime(null, 'it')).toBe('-');
  });
});

describe('relativeTimeFine', () => {
  it('distinguishes "now" from "just now" and keeps seconds inside the first hour, in Italian', () => {
    expect(relativeTimeFine(ago(500), 'it')).toBe('adesso');
    expect(relativeTimeFine(ago(5 * 1000), 'it')).toBe('5s fa');
    expect(relativeTimeFine(ago(65 * 1000), 'it')).toBe('1m 5s fa');
    expect(relativeTimeFine(ago(2 * 60 * 1000), 'it')).toBe('2m fa');
    expect(relativeTimeFine(ago(65 * 60 * 1000), 'it')).toBe('1h 5m fa');
    expect(relativeTimeFine(ago(3 * 60 * 60 * 1000), 'it')).toBe('3h fa');
  });
});

describe('relativeTimeUntil', () => {
  it('flags an overdue timestamp distinctly from a future one, in Italian', () => {
    const future = new Date(NOW.getTime() + 5 * 60 * 1000);
    const past = new Date(NOW.getTime() - 5 * 60 * 1000);
    expect(relativeTimeUntil(future, 'it')).toBe('tra 5 min');
    expect(relativeTimeUntil(past, 'it')).toBe('in ritardo di 5 min');
    expect(relativeTimeUntil(new Date(NOW.getTime() + 500), 'it')).toBe('previsto ora');
    expect(relativeTimeUntil(new Date(NOW.getTime() - 500), 'it')).toBe('in ritardo');
  });
});

describe('formatDuration', () => {
  it('keeps the compact unit abbreviations identical across locales', () => {
    expect(formatDuration(45 * 1000)).toBe('45s');
    expect(formatDuration(45 * 1000, 'it')).toBe('45s');
    expect(formatDuration(74 * 1000, 'it')).toBe('1m 14s');
    expect(formatDuration(2 * 60 * 1000, 'it')).toBe('2m');
  });

  it('returns the placeholder for a missing duration', () => {
    expect(formatDuration(null, 'it')).toBe('-');
  });
});

describe('formatOffset', () => {
  it('signs the offset and keeps it locale-stable', () => {
    expect(formatOffset(500, 'it')).toBe('proprio ora');
    expect(formatOffset(45 * 1000, 'it')).toBe('+45s');
    expect(formatOffset(74 * 1000, 'it')).toBe('+1m 14s');
    expect(formatOffset(65 * 60 * 1000, 'it')).toBe('+1h 5m');
  });
});
