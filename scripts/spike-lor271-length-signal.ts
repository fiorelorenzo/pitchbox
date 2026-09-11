#!/usr/bin/env tsx
/**
 * LOR-271 spike: post length does not predict the length of Lorenzo's
 * reply (r=0.118 raw, 0.382 log-scaled on the 27-case corpus - LOR-253's
 * rejected premise). This script asks what, if anything, does.
 *
 * Pure statistics over two already-harvested, real corpora. No model call,
 * no network, no cost, fully deterministic - two runs against the same
 * input print byte-identical numbers (the permutation test below uses a
 * seeded PRNG rather than `Math.random()` for exactly that reason):
 *
 *   - `private/voice-eval/cases.json` - 27 real LinkedIn post+comment pairs
 *     (the post he answered, and the comment he actually wrote under it).
 *   - `private/voice-eval/linkedin-export/*.zip*` - Lorenzo's own LinkedIn
 *     "Basic" data export. `messages.csv` inside it carries his 233 real
 *     sent DMs (not a draft, not empty), each paired here with whatever
 *     immediately preceded it in the same conversation.
 *
 * Every continuous-vs-continuous or binary-vs-continuous candidate is
 * reported as Pearson's r (a point-biserial correlation *is* a Pearson
 * correlation of a 0/1 variable, so one function covers both), against
 * both the raw word count and the log1p-scaled word count, with a Fisher-z
 * 95% CI and a permutation p-value. A categorical candidate (genre, which
 * contact he is replying to) gets eta-squared plus a permutation p-value
 * for the same null (group membership carries no information).
 *
 * Usage:
 *   npx tsx scripts/spike-lor271-length-signal.ts
 *     [--cases=path/to/cases.json] [--export-dir=path/to/linkedin-export]
 *
 * Requires the system `unzip` binary (already relied on to inspect the
 * export by hand) to read `messages.csv` out of the LinkedIn zip without
 * adding a new dependency to the root workspace for one throwaway script.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { classifyLanguage } from '../shared/src/assist/voice-profile.js';
import { readPostRegister, type PostRegister } from '../shared/src/assist/register.js';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
const casesPath = flag('--cases') ?? 'private/voice-eval/cases.json';
const exportDir = flag('--export-dir') ?? 'private/voice-eval/linkedin-export';

// ---------------------------------------------------------------------------
// Word counting - the same simple convention every other length axis in
// this codebase uses (voice-eval.ts's own `wordCount`, suggest-prompt.ts's):
// split on whitespace, drop empties.
// ---------------------------------------------------------------------------

function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/u).length : 0;
}

// ---------------------------------------------------------------------------
// Statistics. Deliberately dependency-free (no scipy/numpy equivalent in
// this Node toolchain) - every function below is small enough to read in
// one pass, and a permutation test needs nothing but a decent shuffle.
// ---------------------------------------------------------------------------

/** mulberry32 - a small, deterministic PRNG. Seeded per test so a
 * permutation p-value reproduces byte-for-byte on every run, which matters
 * here: "every number in this doc is reproducible from a stated command"
 * is the acceptance criterion, and `Math.random()` would violate it. */
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const sorted = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  if (dx2 === 0 || dy2 === 0) return NaN;
  return num / Math.sqrt(dx2 * dy2);
}

/** Fisher z-transform 95% CI for a Pearson r. Used as an approximation for
 * point-biserial r too (a 0/1 predictor is just a Pearson correlation) -
 * standard practice, not exact for small n, which is why every finding
 * below also carries a permutation p-value that makes no such assumption. */
function fisherCI(r: number, n: number): [number, number] | null {
  if (n < 4 || !Number.isFinite(r)) return null;
  const clamped = Math.max(-0.999999, Math.min(0.999999, r));
  const z = Math.atanh(clamped);
  const se = 1 / Math.sqrt(n - 3);
  return [Math.tanh(z - 1.96 * se), Math.tanh(z + 1.96 * se)];
}

/** Two-sided permutation p-value: how often a random shuffle of `ys`
 * produces a statistic at least as extreme as the one actually observed.
 * Makes no distributional assumption, which matters at n=27. */
function permutationTest(
  xs: number[],
  ys: number[],
  statistic: (xs: number[], ys: number[]) => number,
  seed: number,
  iterations = 9999,
): number {
  const observed = Math.abs(statistic(xs, ys));
  if (!Number.isFinite(observed)) return NaN;
  const rng = mulberry32(seed);
  const shuffled = ys.slice();
  let atLeastAsExtreme = 0;
  for (let k = 0; k < iterations; k++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    if (Math.abs(statistic(xs, shuffled)) >= observed) atLeastAsExtreme++;
  }
  return (atLeastAsExtreme + 1) / (iterations + 1);
}

function etaSquared(groups: number[][]): number {
  const all = groups.flat();
  const grandMean = mean(all);
  const ssTotal = all.reduce((s, v) => s + (v - grandMean) ** 2, 0);
  if (ssTotal === 0) return 0;
  const ssBetween = groups.reduce((s, g) => s + g.length * (mean(g) - grandMean) ** 2, 0);
  return ssBetween / ssTotal;
}

/** Permutation p-value for eta-squared: reshuffle which pooled value goes
 * to which group, keeping group sizes fixed - the null is "group identity
 * carries no information about the value." */
function etaPermutationTest(groups: number[][], seed: number, iterations = 9999): number {
  const observed = etaSquared(groups);
  const sizes = groups.map((g) => g.length);
  const pooled = groups.flat();
  const rng = mulberry32(seed);
  const indices = pooled.map((_, i) => i);
  let atLeastAsExtreme = 0;
  for (let k = 0; k < iterations; k++) {
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    let offset = 0;
    const shuffledGroups: number[][] = [];
    for (const size of sizes) {
      shuffledGroups.push(indices.slice(offset, offset + size).map((idx) => pooled[idx]));
      offset += size;
    }
    if (etaSquared(shuffledGroups) >= observed) atLeastAsExtreme++;
  }
  return (atLeastAsExtreme + 1) / (iterations + 1);
}

function round(x: number, digits = 3): number {
  if (!Number.isFinite(x)) return NaN;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

// ---------------------------------------------------------------------------
// Findings table
// ---------------------------------------------------------------------------

interface Finding {
  corpus: string;
  candidate: string;
  method: string;
  n: number;
  effect: number;
  ci95: string;
  p: number;
  note: string;
}

const findings: Finding[] = [];

// Bumped by a fixed prime per test rather than reused, so no two tests draw
// the same permutation stream - still fully deterministic across runs.
let seedCounter = 1000;
function nextSeed(): number {
  seedCounter += 7919;
  return seedCounter;
}

function reportContinuous(
  corpus: string,
  candidate: string,
  xs: number[],
  ys: number[],
  note: string,
): void {
  const n = xs.length;
  const rRaw = pearson(xs, ys);
  const ciRaw = fisherCI(rRaw, n);
  const pRaw = permutationTest(xs, ys, pearson, nextSeed());
  findings.push({
    corpus,
    candidate: `${candidate} (raw)`,
    method: 'pearson r',
    n,
    effect: round(rRaw),
    ci95: ciRaw ? `[${round(ciRaw[0])}, ${round(ciRaw[1])}]` : 'n/a',
    p: round(pRaw, 4),
    note,
  });
  const logXs = xs.map((v) => Math.log1p(Math.max(0, v)));
  const logYs = ys.map((v) => Math.log1p(Math.max(0, v)));
  const rLog = pearson(logXs, logYs);
  const ciLog = fisherCI(rLog, n);
  const pLog = permutationTest(logXs, logYs, pearson, nextSeed());
  findings.push({
    corpus,
    candidate: `${candidate} (log-log)`,
    method: 'pearson r',
    n,
    effect: round(rLog),
    ci95: ciLog ? `[${round(ciLog[0])}, ${round(ciLog[1])}]` : 'n/a',
    p: round(pLog, 4),
    note,
  });
}

function reportBinary(
  corpus: string,
  candidate: string,
  binary: number[],
  ys: number[],
  note: string,
): void {
  const n = binary.length;
  const logYs = ys.map((v) => Math.log1p(Math.max(0, v)));
  const groupFalse = ys.filter((_, i) => binary[i] === 0);
  const groupTrue = ys.filter((_, i) => binary[i] === 1);
  const r = pearson(binary, logYs);
  const ci = fisherCI(r, n);
  const p = permutationTest(binary, logYs, pearson, nextSeed());
  findings.push({
    corpus,
    candidate,
    method: 'point-biserial r (log outcome)',
    n,
    effect: round(r),
    ci95: ci ? `[${round(ci[0])}, ${round(ci[1])}]` : 'n/a',
    p: round(p, 4),
    note: `${note} - median words: false=${round(median(groupFalse), 1)} (n=${groupFalse.length}), true=${round(median(groupTrue), 1)} (n=${groupTrue.length})`,
  });
}

function reportCategorical(
  corpus: string,
  candidate: string,
  groups: Record<string, number[]>,
  note: string,
): void {
  const entries = Object.entries(groups).filter(([, v]) => v.length > 0);
  const n = entries.reduce((s, [, v]) => s + v.length, 0);
  const groupArrays = entries.map(([, v]) => v);
  const eta = etaSquared(groupArrays);
  const p = etaPermutationTest(groupArrays, nextSeed());
  const breakdown = entries
    .map(([k, v]) => `${k}=${round(median(v), 1)}w(n=${v.length})`)
    .join(', ');
  findings.push({
    corpus,
    candidate,
    method: 'eta-squared',
    n,
    effect: round(eta),
    ci95: 'n/a',
    p: round(p, 4),
    note: `${note} - ${breakdown}`,
  });
}

// =============================================================================
// Corpus A: private/voice-eval/cases.json - 27 real post+comment pairs
// =============================================================================

interface CaseA {
  id: string;
  kind: string;
  post: { urn: string; author: string; text: string; url: string; words: number; language: string };
  reference: string;
  referenceWords: number;
  referenceLanguage: string;
  selfAuthoredPost: boolean;
  tags: string[];
}

interface CasesFile {
  version: number;
  cases: CaseA[];
}

const casesFile: CasesFile = JSON.parse(readFileSync(casesPath, 'utf8'));
const cases = casesFile.cases;

const CORPUS_A = `cases.json (n=${cases.length})`;

// 1. Post length (words) - the premise LOR-253 was rejected on. Reproduced
//    here rather than quoted from the issue, so this script is the one
//    source of truth for every number in the doc it feeds.
reportContinuous(
  CORPUS_A,
  'post length (words)',
  cases.map((c) => c.post.words),
  cases.map((c) => c.referenceWords),
  "reproduces LOR-253/LOR-271's rejected baseline (issue quotes r=0.118 raw / 0.382 log)",
);

// 2. Does the post ask a question at all? Direct substring test, not
//    register.ts's `readPostRegister` (its MIN_WORDS_TO_DESCRIBE=12 floor
//    would drop exactly the short posts this corpus is full of).
reportBinary(
  CORPUS_A,
  'post contains a "?"',
  cases.map((c) => (c.post.text.includes('?') ? 1 : 0)),
  cases.map((c) => c.referenceWords),
  `${cases.filter((c) => c.post.text.includes('?')).length}/${cases.length} posts ask a question`,
);

// 3. Technical/jargon register. Reuses register.ts's own `readPostRegister`
//    (code-or-jargon and numbers traits) rather than a second regex, and
//    respects its MIN_WORDS_TO_DESCRIBE floor - a post too short to
//    describe a register at all is excluded, not guessed at.
{
  const withRegister = cases
    .map((c) => ({ c, register: readPostRegister(c.post.text) }))
    .filter((x): x is { c: CaseA; register: PostRegister } => x.register !== null);
  const binary = withRegister.map((x) =>
    x.register.traits.includes('code-or-jargon') || x.register.traits.includes('numbers') ? 1 : 0,
  );
  reportBinary(
    CORPUS_A,
    'post register reads as technical (code-or-jargon/numbers)',
    binary,
    withRegister.map((x) => x.c.referenceWords),
    `${cases.length - withRegister.length} of ${cases.length} posts fell below register.ts's own MIN_WORDS_TO_DESCRIBE floor and were excluded rather than guessed at`,
  );
}

// 4. Genre, by a keyword heuristic invented for this spike (not an
//    existing classifier - none exists in the codebase for this axis).
//    Deliberately coarse: four keyword buckets plus 'other'.
{
  type Genre = 'launch' | 'hiring' | 'celebration' | 'event' | 'other';
  const GENRE_PATTERNS: Array<[Genre, RegExp]> = [
    [
      'launch',
      /\b(lanciat\w*|rilasciat\w*|released?|shipped|launch(ed|ing)?|siamo\s+live|now\s+live|in\s+produzione)\b/iu,
    ],
    [
      'hiring',
      /\b(hiring|stiamo\s+cercando|cerchiamo|posizione\s+apert\w*|open\s+role|candidat\w*)\b/iu,
    ],
    ['celebration', /\b(congratulazioni|complimenti|congrats?|bravo|auguri|felicitazioni)\b/iu],
    [
      'event',
      /\b(evento|meetup|conference|workshop|residency|hackathon|birra&build|builder\s+residency)\b/iu,
    ],
  ];
  function classifyGenre(text: string): Genre {
    for (const [genre, pattern] of GENRE_PATTERNS) {
      if (pattern.test(text)) return genre;
    }
    return 'other';
  }
  const groups: Record<string, number[]> = {};
  for (const c of cases) {
    const genre = classifyGenre(c.post.text);
    (groups[genre] ??= []).push(c.referenceWords);
  }
  reportCategorical(
    CORPUS_A,
    'post genre (keyword heuristic: launch/hiring/celebration/event/other)',
    groups,
    'heuristic invented for this spike, not an existing classifier - buckets are coarse and mostly small',
  );
}

// 5. Replying on his own post vs commenting on someone else's - already a
//    field in the harvested corpus (`selfAuthoredPost`).
reportBinary(
  CORPUS_A,
  'replying on his own post (selfAuthoredPost)',
  cases.map((c) => (c.selfAuthoredPost ? 1 : 0)),
  cases.map((c) => c.referenceWords),
  `${cases.filter((c) => c.selfAuthoredPost).length}/${cases.length} cases are on his own post`,
);

// 6. Post language.
reportBinary(
  CORPUS_A,
  'post language is English (vs Italian)',
  cases.map((c) => (c.post.language === 'en' ? 1 : c.post.language === 'it' ? 0 : NaN)),
  cases.map((c) => c.referenceWords),
  `post.language values seen: ${[...new Set(cases.map((c) => c.post.language))].join(', ')}`,
);

// 7. Is the post's author someone he has already answered more than once
//    in this same 27-case set (a "repeat contact" proxy)? Restricted to
//    comments on someone else's post - self-authored posts are already
//    covered by candidate 5 and would double-count "Lorenzo Fiore" as a
//    repeat author for an unrelated reason.
{
  const others = cases.filter((c) => !c.selfAuthoredPost);
  const authorCounts = new Map<string, number>();
  for (const c of others)
    authorCounts.set(c.post.author, (authorCounts.get(c.post.author) ?? 0) + 1);
  reportBinary(
    `cases.json, comments on others' posts (n=${others.length})`,
    "post author appears more than once in this set ('repeat contact' proxy)",
    others.map((c) => ((authorCounts.get(c.post.author) ?? 0) >= 2 ? 1 : 0)),
    others.map((c) => c.referenceWords),
    `${[...authorCounts.values()].filter((n) => n >= 2).length} distinct authors appear twice each`,
  );
}

// 8. Addressed by name. Recorded, not computed as a statistic: too few
//    cases to say anything (see doc).
{
  const mentionsLorenzo = cases.filter((c) => !c.selfAuthoredPost && /lorenzo/iu.test(c.post.text));
  findings.push({
    corpus: CORPUS_A,
    candidate: 'post addresses him by name ("Lorenzo")',
    method: 'not computed',
    n: mentionsLorenzo.length,
    effect: NaN,
    ci95: 'n/a',
    p: NaN,
    note: `only ${mentionsLorenzo.length} of ${cases.length - cases.filter((c) => c.selfAuthoredPost).length} non-self-authored posts mention his name at all - too few to say anything, see doc`,
  });
}

// 9. Existing comment count / room signal, and thread position. Recorded
//    as explicitly untestable: voice-eval-cases.ts's own schema comment
//    says the thread was "Absent in every case harvested so far", and this
//    harvest predates any ordering information.
findings.push({
  corpus: CORPUS_A,
  candidate: 'existing comment count under the post / thread position',
  method: 'not computed',
  n: 0,
  effect: NaN,
  ci95: 'n/a',
  p: NaN,
  note: 'no case in this harvest carries thread data (voice-eval-cases.ts CaseThreadSchema is documented as absent from every case harvested so far) - untestable with data on hand, see doc',
});

// =============================================================================
// Corpus B: private/voice-eval/linkedin-export - 233 sent DMs
// =============================================================================

interface DmRow {
  conversationId: string;
  from: string;
  date: string;
  content: string;
  isDraft: boolean;
}

function loadMessagesCsvText(dir: string): string {
  const zipName = readdirSync(dir).find((f) => f.toLowerCase().endsWith('.zip'));
  if (!zipName) throw new Error(`No .zip export found in ${dir}`);
  return execFileSync('unzip', ['-p', join(dir, zipName), 'messages.csv'], {
    maxBuffer: 1024 * 1024 * 64,
  }).toString('utf8');
}

/** Minimal RFC4180-ish CSV parser: quoted fields, embedded commas/newlines,
 * doubled-quote escaping. `messages.csv` needs exactly this - LinkedIn
 * message bodies routinely contain both. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (c === '\r') continue;
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function loadDmRows(dir: string): DmRow[] {
  const rows = parseCsv(loadMessagesCsvText(dir));
  const header = rows[0];
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`messages.csv missing column ${name}`);
    return i;
  };
  const iConv = col('CONVERSATION ID');
  const iFrom = col('FROM');
  const iDate = col('DATE');
  const iContent = col('CONTENT');
  const iDraft = col('IS MESSAGE DRAFT');
  return rows
    .slice(1)
    .filter((r) => r.length === header.length)
    .map((r) => ({
      conversationId: r[iConv],
      from: r[iFrom],
      date: r[iDate],
      content: r[iContent],
      isDraft: r[iDraft] === 'Yes',
    }));
}

const OPERATOR_NAME = 'Lorenzo Fiore';

const dmRows = loadDmRows(exportDir);
const byConversation = new Map<string, DmRow[]>();
for (const row of dmRows) {
  (
    byConversation.get(row.conversationId) ??
    byConversation.set(row.conversationId, []).get(row.conversationId)!
  ).push(row);
}
for (const conv of byConversation.values()) {
  conv.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

interface ReplyPair {
  conversationId: string;
  precedingWords: number;
  precedingAsksQuestion: boolean;
  precedingLanguage: 'en' | 'it' | 'unknown';
  replyWords: number;
  latencyMinutes: number;
}

const parseDate = (d: string): number =>
  new Date(d.replace(' UTC', 'Z').replace(' ', 'T')).getTime();

const replyPairs: ReplyPair[] = [];
const allSentWords: number[] = [];
const openerFlags: number[] = [];
const perConversationReplyWords = new Map<string, number[]>();
let sentValidCount = 0;
let continuationCount = 0;

for (const [conversationId, conv] of byConversation) {
  for (let i = 0; i < conv.length; i++) {
    const row = conv[i];
    if (row.from !== OPERATOR_NAME || row.isDraft || !row.content.trim()) continue;
    sentValidCount++;
    const words = wordCount(row.content);
    allSentWords.push(words);
    if (i === 0) {
      openerFlags.push(1);
      continue;
    }
    openerFlags.push(0);
    const prev = conv[i - 1];
    if (prev.from === OPERATOR_NAME) {
      continuationCount++;
      continue;
    }
    replyPairs.push({
      conversationId,
      precedingWords: wordCount(prev.content),
      precedingAsksQuestion: prev.content.includes('?'),
      precedingLanguage: classifyLanguage(prev.content),
      replyWords: words,
      latencyMinutes: (parseDate(row.date) - parseDate(prev.date)) / 60000,
    });
    const list = perConversationReplyWords.get(conversationId) ?? [];
    list.push(words);
    perConversationReplyWords.set(conversationId, list);
  }
}

const CORPUS_B_SENT = `linkedin messages.csv, sent (n=${sentValidCount})`;
const CORPUS_B_REPLY = `linkedin messages.csv, replies to an inbound message (n=${replyPairs.length})`;

// 10. Same test as candidate 1, at far larger n, on real DMs instead of
//     LinkedIn post comments: does the length of what he's replying to
//     predict the length of what he writes back?
reportContinuous(
  CORPUS_B_REPLY,
  'preceding message length (words)',
  replyPairs.map((p) => p.precedingWords),
  replyPairs.map((p) => p.replyWords),
  'same test as post-length above, on DMs rather than post comments',
);

// 11. Does the incoming message ask a question?
reportBinary(
  CORPUS_B_REPLY,
  'preceding message contains a "?"',
  replyPairs.map((p) => (p.precedingAsksQuestion ? 1 : 0)),
  replyPairs.map((p) => p.replyWords),
  `${replyPairs.filter((p) => p.precedingAsksQuestion).length}/${replyPairs.length} preceding messages ask a question`,
);

// 12. Is this the first message of the conversation (he is opening cold,
//     not replying to anything) rather than a reply or a continuation of
//     his own burst?
reportBinary(
  CORPUS_B_SENT,
  'message is the conversation opener (cold open, not a reply)',
  openerFlags,
  allSentWords,
  `${openerFlags.filter((f) => f === 1).length}/${sentValidCount} sent messages are conversation openers, ${continuationCount} are continuations of his own prior message and excluded from the reply tests above`,
);

// 13. Language of the message he is replying to.
{
  const known = replyPairs.filter((p) => p.precedingLanguage !== 'unknown');
  reportBinary(
    `linkedin messages.csv, replies with a classified preceding language (n=${known.length})`,
    'preceding message language is English (vs Italian)',
    known.map((p) => (p.precedingLanguage === 'en' ? 1 : 0)),
    known.map((p) => p.replyWords),
    `${replyPairs.length - known.length} preceding messages classified 'unknown' (too short/mixed for classifyLanguage) and were excluded`,
  );
}

// 14. Contact frequency: is a message exchanged in a longer-running
//     conversation answered at greater length? Aggregated to one point per
//     conversation (total message count vs. the median length of his
//     replies in it) rather than per message, so one chatty contact can't
//     dominate the sample the way it would if each of his replies counted
//     separately.
{
  const conversationIds = [...perConversationReplyWords.keys()];
  reportContinuous(
    `linkedin messages.csv, conversations with >=1 reply (n=${conversationIds.length})`,
    'total messages in the conversation (established-ness)',
    conversationIds.map((id) => byConversation.get(id)!.length),
    conversationIds.map((id) => median(perConversationReplyWords.get(id)!)),
    'one point per conversation (its total row count vs. the median of his reply lengths in it), not one point per reply',
  );
}

// 15. Response latency.
{
  const withLatency = replyPairs.filter(
    (p) => Number.isFinite(p.latencyMinutes) && p.latencyMinutes >= 0,
  );
  reportContinuous(
    `linkedin messages.csv, replies with a non-negative latency (n=${withLatency.length})`,
    'response latency (minutes)',
    withLatency.map((p) => p.latencyMinutes),
    withLatency.map((p) => p.replyWords),
    `${replyPairs.length - withLatency.length} pairs excluded (negative latency, a same-second export ordering artifact)`,
  );
}

// 16. Who the other person is: restricted to conversations with at least 3
//     of his replies (an "established contact" floor, chosen the same way
//     MIN_ITEMS_TO_DERIVE gates a corpus too thin to say something honest
//     about). Contacts are anonymised (contact-01, contact-02, ...) in
//     every printed table - this is a statistic about the spread across
//     people, not an identification of any of them.
{
  const qualifying = [...perConversationReplyWords.entries()].filter(
    ([, words]) => words.length >= 3,
  );
  const groups: Record<string, number[]> = {};
  qualifying.forEach(([, words], i) => {
    groups[`contact-${String(i + 1).padStart(2, '0')}`] = words;
  });
  reportCategorical(
    `linkedin messages.csv, established contacts with >=3 replies (n=${qualifying.reduce((s, [, w]) => s + w.length, 0)} replies across ${qualifying.length} contacts)`,
    'which contact he is replying to (anonymised)',
    groups,
    'contact identity only, not content - labels are anonymised on purpose',
  );
}

// ---------------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------------

console.log(`\nLOR-271 length-signal spike - no model calls, no network, deterministic.`);
console.log(`Corpus A: ${casesPath} (${cases.length} cases).`);
console.log(
  `Corpus B: ${exportDir} messages.csv (${dmRows.length} rows, ${sentValidCount} valid sent, ${replyPairs.length} classified as a reply to an inbound message).`,
);
console.log(`${findings.length} candidate finding(s) below.\n`);
console.table(
  findings.map((f) => ({
    corpus: f.corpus,
    candidate: f.candidate,
    method: f.method,
    n: f.n,
    effect: f.effect,
    ci95: f.ci95,
    p: f.p,
  })),
);
console.log('\nNotes (group breakdowns, exclusions):');
for (const f of findings) {
  console.log(`- [${f.candidate}] ${f.note}`);
}
