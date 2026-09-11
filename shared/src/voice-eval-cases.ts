// shared/src/voice-eval-cases.ts (LOR-44)
//
// The eval set's schema and loader. The set itself never lives in this
// public repo - the cases quote other people's real LinkedIn posts, so it
// belongs in `private/` (already in `.gitignore`) as
// `private/voice-eval/cases.json`, and the path is configurable
// (`PITCHBOX_EVAL_CASES`) so a harvest can live anywhere on disk. What ships
// here is the shape and the loader, plus a small synthetic fixture
// (`shared/tests/fixtures/voice-eval/synthetic-cases.json`, five invented
// cases, no real person) so the scorer's own unit tests run in CI with no
// private data.
//
// Kept separate from `voice-metrics.ts` on purpose: that module is pure and
// synchronous (no fs, no model, no I/O of any kind), and reading a file off
// disk is neither.

import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const VOICE_EVAL_SCHEMA_VERSION = 1;

/** The genres the issue asks the set to deliberately cover, plus
 * 'unclassified' for a harvested case nobody has hand-labelled yet - a
 * wrong guess at genre is worse than an honest "not sorted", so the loader
 * never infers one. */
export const VOICE_EVAL_GENRES = [
  'launch',
  'technical-thread',
  'hiring',
  'disagreement',
  'image-led',
  'italian',
  'silence',
  'comment-reply',
  'unclassified',
] as const;
export type VoiceEvalGenre = (typeof VOICE_EVAL_GENRES)[number];

// A minimal, structural subset of assist/suggest-prompt.ts's ObservedPost/
// ObservedThread - just enough for the runner to build a real
// buildSuggestionPrompt call and for the length-ratio axis to read a room's
// comment lengths, without dragging that module's full surface (author
// handles, images, reply targets) into a case file that mostly won't have
// any of it.
const CaseThreadSchema = z.object({
  comments: z.array(z.object({ body: z.string().min(1) })),
});

const VoiceEvalCaseSchema = z.object({
  /** Stable within the file - printed in both tables as the row's evidence,
   * so a finding can be traced back to the case without renumbering. */
  id: z.string().min(1),
  genre: z.enum(VOICE_EVAL_GENRES).default('unclassified'),
  /** Free text, evidence only - never read by the scorer. */
  postAuthor: z.string().optional(),
  post: z.object({
    text: z.string().min(1),
    /** Other people's visible replies under the post, when known - feeds
     * the length-ratio axis's ideal comparator (the room's median). Absent
     * in every case harvested so far (LinkedIn's own thread was never
     * captured, only the post and Lorenzo's own comment on it), so the
     * runner falls back to comparing against `actualReply`'s own length -
     * see voice-metrics.ts's `lengthComparisonBasis`. */
    thread: CaseThreadSchema.optional(),
  }),
  /** What Lorenzo actually wrote under this post. Null only for a genuine
   * "the right answer was silence" case - the one genre a real activity
   * feed cannot supply on its own, since nobody's timeline records what
   * they chose not to write; today that genre lives only in the synthetic
   * fixture. */
  actualReply: z.string().min(1).nullable(),
});
export type VoiceEvalCase = z.infer<typeof VoiceEvalCaseSchema>;

const VoiceEvalCorpusItemSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});
export type VoiceEvalCorpusItem = z.infer<typeof VoiceEvalCorpusItemSchema>;

const VoiceEvalFileSchema = z.object({
  schemaVersion: z.literal(VOICE_EVAL_SCHEMA_VERSION),
  /** Lorenzo's own writing, kind `voice_sample` feed for
   * `assist/voice-profile.ts`'s `measureVoiceCorpus` - the "full" run's
   * operator corpus, exactly what the product would derive a
   * `VoiceProfileSummary` from. Empty or absent makes a "full" run and a
   * `--thin` run the same run, which is an honest degenerate case rather
   * than an error. */
  voiceCorpus: z.array(VoiceEvalCorpusItemSchema).default([]),
  cases: z.array(VoiceEvalCaseSchema).min(1),
});
export type VoiceEvalFile = z.infer<typeof VoiceEvalFileSchema>;

export const DEFAULT_VOICE_EVAL_CASES_PATH = 'private/voice-eval/cases.json';

/** Thrown when no case file exists at the resolved path - the caller (the
 * runner script) turns this into one readable line and a clean exit, never
 * a stack trace, per the issue's own acceptance criterion. */
export class VoiceEvalCasesNotFoundError extends Error {
  constructor(public readonly path: string) {
    super(
      `No voice-eval case file at "${path}". Set PITCHBOX_EVAL_CASES to point at one, or place one at ` +
        `${DEFAULT_VOICE_EVAL_CASES_PATH} (gitignored - see shared/src/voice-eval-cases.ts for the schema, ` +
        'or shared/tests/fixtures/voice-eval/synthetic-cases.json for a small worked example).',
    );
    this.name = 'VoiceEvalCasesNotFoundError';
  }
}

/** `PITCHBOX_EVAL_CASES` when set (trimmed of surrounding whitespace so a
 * stray newline from a shell export can't send the loader looking for a
 * path that never exists), else the repo-relative default. */
export function resolveVoiceEvalCasesPath(): string {
  const fromEnv = process.env.PITCHBOX_EVAL_CASES?.trim();
  return fromEnv ? fromEnv : DEFAULT_VOICE_EVAL_CASES_PATH;
}

/**
 * Reads and validates a case file. Throws `VoiceEvalCasesNotFoundError` when
 * the path does not exist, or a zod error when it exists but does not match
 * the schema - either way the caller decides how to present it, this
 * function never prints anything itself.
 */
export function loadVoiceEvalCases(path: string = resolveVoiceEvalCasesPath()): VoiceEvalFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      throw new VoiceEvalCasesNotFoundError(path);
    }
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  return VoiceEvalFileSchema.parse(parsed);
}
