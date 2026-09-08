// shared/src/assist/tone.ts
//
// The tone vocabulary (#405), on its own so both sides can have it: the
// settings module (`shared/src/linkedin-assist.ts`) reaches a database, and
// the prompt builder (`suggest-prompt.ts`) is documented as pure and unable to
// reach one. A leaf module with no imports is what keeps that true - putting
// these next to the settings would have pulled the db client into the prompt.

/**
 * How a suggestion should sound. `match-room` is the default and the reason
 * the rest are named options rather than free text: mixing the operator's own
 * voice with the register of the post being answered
 * (`shared/src/assist/register.ts`) is what a human does, and the fixed
 * registers exist for when they want to override it.
 *
 * `custom` carries the operator's own sentence, which keeps the semantics the
 * persona notes field already had: their words, verbatim, into the prompt.
 * House style outranks every option, `custom` included
 * (`shared/src/house-style.ts`).
 */
export const ASSIST_TONES = [
  'match-room',
  'professional',
  'plain',
  'warm',
  'technical',
  'custom',
] as const;

export type AssistTone = (typeof ASSIST_TONES)[number];

export const DEFAULT_ASSIST_TONE: AssistTone = 'match-room';

/** Ceiling on the free-text tone, matching the persona-notes ceiling in the prompt. */
export const ASSIST_TONE_NOTES_MAX = 500;

export function isAssistTone(value: unknown): value is AssistTone {
  return typeof value === 'string' && (ASSIST_TONES as readonly string[]).includes(value);
}
