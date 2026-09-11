#!/usr/bin/env tsx
/**
 * Measures `classifyLanguage` (LOR-286) against two private, gitignored
 * corpora under `private/voice-eval/`, neither of which this script ever
 * prints a body from:
 *
 *   - `cases.json` - LOR-280's 27 hand-labelled real LinkedIn post/comment
 *     replies (`reference`, `referenceLanguageLabel`: `it`/`en`/
 *     `unlabelable`, restored 2026-09-11 after the original labels were
 *     lost with LOR-280's own worktree - see the file's own
 *     `referenceLanguageLabels` block for the recovery note). Scored as
 *     agree/swap-wrong/conservative-miss against the classifier's output.
 *   - `messages.csv` - the operator's real LinkedIn message export, filtered
 *     to their own 233 sent, non-draft, non-empty messages. No hand labels
 *     exist for these; this table is just the en/it/unknown split.
 *
 * "Confidently wrong" is narrow on purpose: the classifier named a real
 * language (en/it) and the hand label names the *other* real language - an
 * actual language swap, the one regression LOR-286 must not cause.
 * "Conservative miss" is the opposite shape and LOR-286's actual target:
 * the classifier said `unknown` on text a human hand-labelled `it`/`en`.
 *
 * Missing input file -> a readable message and a skipped table, never a
 * stack trace, same discipline as `scripts/voice-eval.ts`.
 *
 * Usage: pnpm run eval:voice-language
 */
import { existsSync, readFileSync } from 'node:fs';
import { classifyLanguage } from '../shared/src/assist/voice-profile.js';

const CASES_PATH = process.env.PITCHBOX_EVAL_CASES ?? 'private/voice-eval/cases.json';
const MESSAGES_PATH = process.env.PITCHBOX_EVAL_MESSAGES ?? 'private/voice-eval/messages.csv';

type Verdict = 'en' | 'it' | 'unknown';
type HandLabel = 'en' | 'it' | 'unlabelable';

// ---------------------------------------------------------------------------
// cases.json
// ---------------------------------------------------------------------------

interface EvalCase {
  id: string;
  reference: string;
  referenceLanguageLabel: HandLabel;
}

interface CasesFile {
  cases: EvalCase[];
}

function scoreCases(): void {
  if (!existsSync(CASES_PATH)) {
    console.log(`\ncases.json: skipped (no file at ${CASES_PATH}).`);
    return;
  }
  const file = JSON.parse(readFileSync(CASES_PATH, 'utf8')) as CasesFile;
  let agree = 0;
  // A real language swap against the hand label - the one regression
  // LOR-286 must not cause.
  let swapWrong = 0;
  // The classifier said `unknown` on text hand-labelled a real language -
  // LOR-286's actual target failure mode.
  let conservativeMiss = 0;
  // The classifier named a real language on text hand-labelled
  // `unlabelable` ("no language marker of any kind", per the corpus's own
  // method note) - a genuine false positive, not merely a disagreement,
  // since `unlabelable` is a stronger claim than an ordinary miss.
  let realWhenUnlabelable = 0;
  const swapWrongIds: string[] = [];
  const missIds: string[] = [];
  const realWhenUnlabelableIds: string[] = [];
  for (const c of file.cases) {
    const predicted: Verdict = classifyLanguage(c.reference);
    const hand = c.referenceLanguageLabel;
    const handAsVerdict: Verdict = hand === 'unlabelable' ? 'unknown' : hand;
    if (predicted === handAsVerdict) {
      agree++;
    } else if (predicted === 'unknown') {
      conservativeMiss++;
      missIds.push(c.id);
    } else if (hand === 'unlabelable') {
      realWhenUnlabelable++;
      realWhenUnlabelableIds.push(c.id);
    } else {
      swapWrong++;
      swapWrongIds.push(c.id);
    }
  }
  const unknownPredicted = file.cases.filter(
    (c) => classifyLanguage(c.reference) === 'unknown',
  ).length;
  console.log(`\ncases.json (${file.cases.length} hand-labelled cases):`);
  console.table([
    {
      agree,
      confidentlyWrong: swapWrong,
      unknownPredicted,
      unknownButShouldBeALanguage: conservativeMiss,
      realButHandSaysUnlabelable: realWhenUnlabelable,
    },
  ]);
  if (swapWrongIds.length > 0)
    console.log(`  confidently wrong (en/it swap): ${swapWrongIds.join(', ')}`);
  if (realWhenUnlabelableIds.length > 0) {
    console.log(`  real language, hand says unlabelable: ${realWhenUnlabelableIds.join(', ')}`);
  }
  if (missIds.length > 0) console.log(`  unknown but should be a language: ${missIds.join(', ')}`);
}

// ---------------------------------------------------------------------------
// messages.csv - a small RFC 4180 parser (quoted fields, embedded commas,
// escaped quotes, newlines inside a quoted field). No dependency pulled in
// for a script that never ships.
// ---------------------------------------------------------------------------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      // swallow, \n (or end of input) closes the row
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function scoreMessages(): void {
  if (!existsSync(MESSAGES_PATH)) {
    console.log(`\nmessages.csv: skipped (no file at ${MESSAGES_PATH}).`);
    return;
  }
  const rows = parseCsv(readFileSync(MESSAGES_PATH, 'utf8'));
  const [header, ...body] = rows;
  const col = (name: string): number => header.indexOf(name);
  const fromCol = col('FROM');
  const contentCol = col('CONTENT');
  const draftCol = col('IS MESSAGE DRAFT');
  if (fromCol < 0 || contentCol < 0 || draftCol < 0) {
    console.log(`\nmessages.csv: skipped (unexpected header shape at ${MESSAGES_PATH}).`);
    return;
  }

  // The operator's own name is not hardcoded: it is whichever FROM value
  // sends the most messages in their own export - by construction, that is
  // always the account owner, since every conversation in a personal export
  // has them on one side.
  const fromCounts = new Map<string, number>();
  for (const r of body) {
    const from = r[fromCol]?.trim();
    if (from) fromCounts.set(from, (fromCounts.get(from) ?? 0) + 1);
  }
  let operator = '';
  let operatorCount = 0;
  for (const [name, count] of fromCounts) {
    if (count > operatorCount) {
      operator = name;
      operatorCount = count;
    }
  }

  const sent = body.filter((r) => {
    if (r[fromCol]?.trim() !== operator) return false;
    if (!r[contentCol]?.trim()) return false;
    const isDraft = r[draftCol]?.trim().toLowerCase();
    if (isDraft === 'true' || isDraft === '1' || isDraft === 'yes') return false;
    return true;
  });

  const counts: Record<Verdict, number> = { en: 0, it: 0, unknown: 0 };
  for (const r of sent) counts[classifyLanguage(r[contentCol])]++;

  const total = sent.length;
  const pct = (n: number): string => (total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '-');
  console.log(`\nmessages.csv: ${total} real sent message(s).`);
  console.table([
    {
      en: counts.en,
      it: counts.it,
      unknown: counts.unknown,
      unknownPct: pct(counts.unknown),
    },
  ]);
}

scoreCases();
scoreMessages();
