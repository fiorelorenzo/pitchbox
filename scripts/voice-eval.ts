#!/usr/bin/env tsx
/**
 * The eval runner (LOR-44): generates a real suggestion for every case in
 * the set, using the same prompt builder the in-page assistant uses today
 * (`buildSuggestionPrompt`), and scores it against the operator's own real
 * reply with `voice-metrics.ts`'s pure, synchronous scorer. Deliberately not
 * part of `pnpm test`: it spends model calls and is not deterministic, and a
 * suite that spends money on every push is a suite people disable.
 *
 * Two tables print, one row per case:
 *   - the deterministic table (style findings, per-axis distance, length
 *     ratio, echo, language match) - needs no model to score once a
 *     candidate exists, and reproduces byte-for-byte across two runs on the
 *     same candidates (see the cache below).
 *   - the judged table, second-class: a model shown a shuffled pair (the
 *     real reply, the suggestion) and asked which a human wrote. Useful only
 *     in aggregate, never the gate.
 *
 * No `AI_GATEWAY_API_KEY`, and nothing cached yet? Every case falls back to
 * an offline self-check - the candidate is the operator's own real reply,
 * scored against itself - which proves the deterministic table runs end to
 * end with zero network calls, and is never presented as a real evaluation.
 *
 * `--thin` withholds the operator's own corpus (the voice profile handed to
 * the prompt becomes `voice-defaults.ts`'s `DEFAULT_VOICE_PROFILE`, exactly
 * what a brand-new account gets) rather than the one `measureVoiceCorpus`
 * derives from `voiceCorpus` in the case file.
 *
 * Usage:
 *   pnpm run eval:voice [--thin] [--limit=N] [--cases=path] [--regenerate] [--no-judge]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { generateText } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import {
  loadVoiceEvalCases,
  resolveVoiceEvalCasesPath,
  VoiceEvalCasesNotFoundError,
  type VoiceEvalCase,
  type VoiceEvalFile,
} from '../shared/src/voice-eval-cases.js';
import { scoreCandidate, type VoiceCandidateScore } from '../shared/src/voice-metrics.js';
import { buildSuggestionPrompt, type ObservedPost } from '../shared/src/assist/suggest-prompt.js';
import { splitSuggestion } from '../shared/src/assist/envelope.js';
import {
  measureVoiceCorpus,
  describeVoiceProfile,
  measureVoiceCorpusByGenre,
  describeVoiceProfileForGenre,
} from '../shared/src/assist/voice-profile.js';
import { DEFAULT_VOICE_PROFILE } from '../shared/src/assist/voice-defaults.js';
import type { VoiceProfileSummary } from '../shared/src/assist/context.js';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const thin = argv.includes('--thin');
const regenerate = argv.includes('--regenerate');
const skipJudge = argv.includes('--no-judge');
const flag = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
const casesPathArg = flag('--cases');
const limitArg = flag('--limit');
const limit = limitArg ? Number(limitArg) : undefined;

const MODEL_ID = process.env.PITCHBOX_EVAL_MODEL || 'google/gemini-3.1-flash-lite';
const JUDGE_MODEL_ID = process.env.PITCHBOX_EVAL_JUDGE_MODEL || MODEL_ID;
const apiKey = process.env.AI_GATEWAY_API_KEY;
const gateway = apiKey ? createGateway({ apiKey }) : null;

// ---------------------------------------------------------------------------
// Load the set. A missing file is a readable message and a clean exit, never
// a stack trace - the issue's own acceptance criterion.
// ---------------------------------------------------------------------------

let file: VoiceEvalFile;
try {
  file = loadVoiceEvalCases(casesPathArg);
} catch (err) {
  if (err instanceof VoiceEvalCasesNotFoundError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(`The case file did not match the expected schema: ${(err as Error).message}`);
  process.exit(1);
}

const cases = limit && limit > 0 ? file.cases.slice(0, limit) : file.cases;

// ---------------------------------------------------------------------------
// The voice profile the prompt is built with - exactly what `main` derives
// today when `--thin` is absent, `voice-defaults.ts`'s own default otherwise.
//
// This used to hand `buildSuggestionPrompt` a bare `{ summary }`, which meant
// `lengthTarget`'s comment-genre path (`medianCommentWords`) never fired in
// this harness at all - every eval run silently skipped that section of the
// prompt, so any per-case number this script reported for a `post_comment`
// case was measuring a prompt the product does not actually send. The set's
// own `actualReply` texts *are* the operator's real comment corpus, so they
// feed `measureVoiceCorpusByGenre` the same way a real derivation would,
// tagged 'comment' - computed once over the whole set and applied to every
// case, the same way a real `operator_voice_profiles` row is derived once
// from history and then applied prospectively.
// ---------------------------------------------------------------------------

function resolveVoiceProfileSummary(): VoiceProfileSummary | null {
  if (thin || file.voiceCorpus.length === 0) {
    return {
      summary: DEFAULT_VOICE_PROFILE.summary,
      commentSummary: null,
      editSignature: null,
      medianCommentWords: null,
    };
  }
  const pooled = measureVoiceCorpus(
    file.voiceCorpus.map((c, i) => ({ id: i + 1, kind: 'voice_sample' as const, text: c.text })),
  );
  const summary = describeVoiceProfile(pooled) ?? DEFAULT_VOICE_PROFILE.summary;

  const commentCorpus = cases
    .filter((c): c is VoiceEvalCase & { actualReply: string } => c.actualReply !== null)
    .map((c, i) => ({
      id: i + 1,
      kind: 'voice_sample' as const,
      genre: 'comment' as const,
      text: c.actualReply,
    }));
  const commentMeasurement = measureVoiceCorpusByGenre(commentCorpus).comment;

  return {
    summary,
    commentSummary: describeVoiceProfileForGenre('comment', commentMeasurement),
    editSignature: null,
    medianCommentWords:
      commentMeasurement.rhythm.medianItemWords > 0
        ? commentMeasurement.rhythm.medianItemWords
        : null,
  };
}

const voiceProfileSummary = resolveVoiceProfileSummary();

// ---------------------------------------------------------------------------
// A generated-candidate cache, so the deterministic table can be re-scored
// (and re-printed byte-for-byte) without spending another model call or
// risking the model's own nondeterminism between two runs. Keyed by mode
// (thin/full) so the two never overwrite each other. Always under the
// gitignored `private/voice-eval/` directory, regardless of where the case
// file itself lives - a run against the committed synthetic fixture (as the
// module's own smoke test does) must never write a scratch file next to it.
// ---------------------------------------------------------------------------

const cacheDir = 'private/voice-eval/.cache';
const cachePath = `${cacheDir}/${basename(casesPathArg ?? resolveVoiceEvalCasesPath())}${thin ? '.thin' : ''}.candidates.json`;

function loadCache(): Record<string, string | null> {
  if (!existsSync(cachePath)) return {};
  try {
    return JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, string | null>;
  } catch {
    return {};
  }
}

function saveCache(cache: Record<string, string | null>): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
}

const cache = loadCache();
let cacheChanged = false;

// ---------------------------------------------------------------------------
// Candidate generation - the one part of this script that is not
// deterministic and not free. `buildSuggestionPrompt` is the exact prompt
// builder the in-page assistant uses today (`match-room` tone, no persona,
// no projects/repos - this eval is about the voice, not the project-picking
// half of the prompt).
// ---------------------------------------------------------------------------

async function generateCandidate(
  c: VoiceEvalCase,
): Promise<{ candidate: string | null; skipped: boolean }> {
  if (!gateway) {
    // Offline self-check: proves the harness runs end to end with zero
    // network calls, never presented as a real evaluation - see module
    // header.
    return { candidate: c.actualReply, skipped: c.actualReply === null };
  }
  const post: ObservedPost = {
    text: c.post.text,
    thread: c.post.thread
      ? {
          comments: c.post.thread.comments,
          renderedCount: c.post.thread.comments.length,
          truncated: false,
        }
      : undefined,
  };
  const prompt = buildSuggestionPrompt({
    kind: 'post_comment',
    post,
    persona: null,
    voiceProfile: voiceProfileSummary,
    projects: [],
    repos: [],
    tone: 'match-room',
  });
  const response = await generateText({
    model: gateway(MODEL_ID),
    messages: [{ role: 'user', content: prompt }],
  });
  const envelope = splitSuggestion(response.text);
  return { candidate: envelope.draft, skipped: envelope.skipped };
}

// ---------------------------------------------------------------------------
// The judged half: a model shown a shuffled pair, asked which a human wrote.
// Second-class by construction - see the module header.
// ---------------------------------------------------------------------------

interface JudgeResult {
  correct: boolean;
}

async function judgeCase(real: string, candidate: string): Promise<JudgeResult | null> {
  if (!gateway) return null;
  const swap = Math.random() < 0.5;
  const a = swap ? candidate : real;
  const b = swap ? real : candidate;
  const realLabel = swap ? 'B' : 'A';
  const prompt =
    'Two replies to the same social-media post are shown below, labeled A and B. One was written by a ' +
    'human, the other by an AI assistant. Reply with exactly one character, A or B, naming which one you ' +
    `think a human wrote - nothing else.\n\nA: ${a}\n\nB: ${b}`;
  const response = await generateText({
    model: gateway(JUDGE_MODEL_ID),
    messages: [{ role: 'user', content: prompt }],
  });
  const letter = response.text.trim().charAt(0).toUpperCase();
  if (letter !== 'A' && letter !== 'B') return null;
  return { correct: letter === realLabel };
}

// ---------------------------------------------------------------------------
// Run every case.
// ---------------------------------------------------------------------------

interface CaseResult {
  case: VoiceEvalCase;
  candidate: string | null;
  skipped: boolean;
  metrics: VoiceCandidateScore | null;
  judged: JudgeResult | null;
}

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/u).length : 0;
}

const results: CaseResult[] = [];

for (const c of cases) {
  const cached = !regenerate && Object.prototype.hasOwnProperty.call(cache, c.id);
  let candidate: string | null;
  let skipped: boolean;
  if (cached) {
    candidate = cache[c.id]!;
    skipped = candidate === null;
  } else {
    const generated = await generateCandidate(c);
    candidate = generated.candidate;
    skipped = generated.skipped;
    cache[c.id] = candidate;
    cacheChanged = true;
  }

  const metrics =
    candidate !== null
      ? scoreCandidate({
          candidate,
          post: c.post.text,
          actualReply: c.actualReply,
          threadCommentWordCounts: c.post.thread?.comments.map((cm) => wordCount(cm.body)),
        })
      : null;

  const judged =
    !skipJudge && gateway && candidate !== null && c.actualReply !== null
      ? await judgeCase(c.actualReply, candidate)
      : null;

  results.push({ case: c, candidate, skipped, metrics, judged });
}

if (cacheChanged) saveCache(cache);

// ---------------------------------------------------------------------------
// Print. Two tables, one row per case.
// ---------------------------------------------------------------------------

console.log(
  `\nvoice-eval: ${results.length} case(s), ${thin ? 'thin (no operator corpus)' : 'full'} mode.`,
);
if (!gateway) {
  console.log(
    'No AI_GATEWAY_API_KEY: running an offline self-check (candidate = the real reply, scored against ' +
      'itself). This proves the harness runs end to end with zero network calls - it is not a real ' +
      'evaluation. Set AI_GATEWAY_API_KEY for a real baseline.\n',
  );
}

const deterministicRows = results.map((r) => ({
  id: r.case.id,
  genre: r.case.genre,
  words: r.metrics?.candidateWordCount ?? (r.skipped ? 'skipped' : 'n/a'),
  lengthRatio: r.metrics?.lengthRatio ?? 'n/a',
  lengthBasis: r.metrics?.lengthComparisonBasis ?? 'n/a',
  styleFindings: r.metrics?.styleFindings.length ?? 'n/a',
  rhythm: r.metrics?.distance.rhythm ?? 'n/a',
  punctuation: r.metrics?.distance.punctuation ?? 'n/a',
  shape: r.metrics?.distance.shape ?? 'n/a',
  voiceMarkers: r.metrics?.distance.voiceMarkers ?? 'n/a',
  lexicon: r.metrics?.distance.lexicon ?? 'n/a',
  echo: r.metrics?.echo ?? 'n/a',
  languageMatch: r.metrics?.languageMatch ?? 'n/a',
}));
console.log('Deterministic table:');
console.table(deterministicRows);

if (!skipJudge && gateway) {
  const judgedRows = results
    .filter((r) => r.judged !== null)
    .map((r) => ({ id: r.case.id, judgeCorrect: r.judged!.correct }));
  const correctCount = judgedRows.filter((r) => r.judgeCorrect).length;
  console.log(
    `\nJudged table (second-class, aggregate only - ${judgedRows.length} case(s) judged):`,
  );
  console.table(judgedRows);
  if (judgedRows.length > 0) {
    console.log(
      `Judge correctly identified the real reply in ${correctCount}/${judgedRows.length} case(s) ` +
        `(${Math.round((correctCount / judgedRows.length) * 100)}%) - lower is better for "sounds like him".`,
    );
  }
} else if (!gateway) {
  console.log('\nJudged table: skipped (no AI_GATEWAY_API_KEY).');
} else if (skipJudge) {
  console.log('\nJudged table: skipped (--no-judge).');
}
