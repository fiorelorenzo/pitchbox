/**
 * Unit words for `web/src/lib/utils/time.ts`'s relative-time and duration
 * formatters (LOR-263). Split out on its own because the five functions
 * there are called from about twenty files across every surface of the
 * dashboard - campaigns, people, conversations, notifications, projects,
 * the inbox detail pane and the run log among them - so no single surface
 * owns this prefix.
 *
 * A handful of entries share identical English/Italian text on purpose:
 * the compact duration/offset formats (`{n}s`, `{min}m {sec}s`, `{hr}h`)
 * are bare unit abbreviations, not sentences, and read the same way in
 * both languages - the parity test's identical-string check only flags
 * strings longer than three words for exactly this reason.
 */
import type { Dict } from '../types.js';

export const timeEn = {
  'time.just-now': 'just now',
  'time.now': 'now',
  'time.seconds-ago': '{n}s ago',
  'time.minutes-ago': '{n} min ago',
  'time.minutes-ago-fine': '{min}m ago',
  'time.minutes-seconds-ago': '{min}m {sec}s ago',
  'time.hours-ago': '{n}h ago',
  'time.hours-minutes-ago': '{hr}h {remMin}m ago',
  'time.days-ago': '{n}d ago',
  'time.overdue': 'overdue',
  'time.due-now': 'due now',
  'time.overdue-by-seconds': 'overdue by {n}s',
  'time.in-seconds': 'in {n}s',
  'time.overdue-by-minutes': 'overdue by {n} min',
  'time.in-minutes': 'in {n} min',
  'time.overdue-by-hours': 'overdue by {n}h',
  'time.in-hours': 'in {n}h',
  'time.overdue-by-days': 'overdue by {n}d',
  'time.in-days': 'in {n}d',
  'time.duration-seconds': '{n}s',
  'time.duration-minutes-seconds': '{min}m {sec}s',
  'time.duration-minutes': '{min}m',
  'time.offset-seconds': '+{n}s',
  'time.offset-minutes-seconds': '+{min}m {sec}s',
  'time.offset-minutes': '+{min}m',
  'time.offset-hours-minutes': '+{hr}h {remMin}m',
  'time.offset-hours': '+{hr}h',
} satisfies Dict;

export const timeIt = {
  'time.just-now': 'proprio ora',
  'time.now': 'adesso',
  'time.seconds-ago': '{n}s fa',
  'time.minutes-ago': '{n} min fa',
  'time.minutes-ago-fine': '{min}m fa',
  'time.minutes-seconds-ago': '{min}m {sec}s fa',
  'time.hours-ago': '{n}h fa',
  'time.hours-minutes-ago': '{hr}h {remMin}m fa',
  'time.days-ago': '{n}g fa',
  'time.overdue': 'in ritardo',
  'time.due-now': 'previsto ora',
  'time.overdue-by-seconds': 'in ritardo di {n}s',
  'time.in-seconds': 'tra {n}s',
  'time.overdue-by-minutes': 'in ritardo di {n} min',
  'time.in-minutes': 'tra {n} min',
  'time.overdue-by-hours': 'in ritardo di {n}h',
  'time.in-hours': 'tra {n}h',
  'time.overdue-by-days': 'in ritardo di {n}g',
  'time.in-days': 'tra {n}g',
  'time.duration-seconds': '{n}s',
  'time.duration-minutes-seconds': '{min}m {sec}s',
  'time.duration-minutes': '{min}m',
  'time.offset-seconds': '+{n}s',
  'time.offset-minutes-seconds': '+{min}m {sec}s',
  'time.offset-minutes': '+{min}m',
  'time.offset-hours-minutes': '+{hr}h {remMin}m',
  'time.offset-hours': '+{hr}h',
} satisfies Dict;
