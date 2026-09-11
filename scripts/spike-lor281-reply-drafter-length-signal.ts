#!/usr/bin/env tsx
/**
 * LOR-281 spike: does the reply-drafter's actual domain - a continuation on
 * Reddit, Hacker News or Mastodon, `reply_comment` (public) or `reply_dm`
 * (private), per `playbooks/reply-drafter.md` - carry the length signal
 * LOR-271 found on Lorenzo's LinkedIn DMs
 * (`docs/design/reply-length-signal-spike.md`)?
 *
 * LOR-271 found three candidates on 188 of his real sent LinkedIn DMs (each
 * paired with whatever immediately preceded it) that cleared both a
 * permutation p<0.05 and a conventional medium-or-larger effect: the length
 * of the message he's replying to (r=0.44 raw, r=0.61 log), how long he took
 * to reply (r=0.37 log), and which specific contact he's replying to
 * (eta-squared=0.375, the largest effect anywhere in that spike). It
 * measured all three on a private, reciprocal exchange between people who
 * already know each other. The reply-drafter playbook's own domain is a
 * different shape on at least two axes that matter: it is often the first
 * (and often the only) exchange with that person, and on Reddit/HN it is
 * frequently public rather than a DM.
 *
 * No real corpus of the reply-drafter's own thread-reply pairs (parent
 * message plus the reply Lorenzo actually sent, harvested from a real
 * Reddit/HN/Mastodon account) exists anywhere reachable from this worktree.
 * Checked and ruled out before writing this script: no Reddit/HN export
 * under `private/`, no production database reachable from a worktree, and
 * nothing in this repo's own tables (fresh core seed only, no real
 * campaign history). `--reddit-cases=<path>` below is where that corpus
 * plugs in the day someone harvests it - see `loadRedditCases`'s schema
 * comment - and until then this script does the next best thing instead of
 * pretending the gap does not exist:
 *
 *   1. Re-derives LOR-271's three headline numbers straight from the same
 *      `private/voice-eval/linkedin-export` export, so this spike's doc
 *      never hand-copies a number LOR-271 already published elsewhere.
 *   2. Splits that same corpus on the one axis it can actually test without
 *      new data: whether the conversation is a single exchange (he replied
 *      to that person exactly once - the closest this corpus gets to "a
 *      stranger, once", which is most of what the reply-drafter path
 *      actually faces) or an established back-and-forth (two or more
 *      replies). A candidate whose effect survives in the single-exchange
 *      half at least is not just an artifact of "he already knows this
 *      person"; one that does not is itself an answer for that half of the
 *      analogy - and the single-exchange half is structurally incompatible
 *      with the contact-identity candidate regardless of its effect size
 *      (see the eta-squared section below).
 *
 * Zero model calls, no network, deterministic - the permutation test below
 * uses the same seeded mulberry32 PRNG LOR-271's script uses, so two runs
 * against the same input print byte-identical numbers.
 *
 * Usage:
 *   npx tsx scripts/spike-lor281-reply-drafter-length-signal.ts
 *     [--export-dir=path/to/linkedin-export] [--reddit-cases=path/to/file.json]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
const exportDir = flag('--export-dir') ?? 'private/voice-eval/linkedin-export';
const redditCasesPath = flag('--reddit-cases');

// ---------------------------------------------------------------------------
// Word counting - same convention as LOR-271's script (and voice-eval.ts,
// suggest-prompt.ts): split on whitespace, drop empties.
// ---------------------------------------------------------------------------

function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/u).length : 0;
}

// ---------------------------------------------------------------------------
// Statistics - duplicated from LOR-271's script rather than imported: that
// script is a flat, already-shipped spike deliverable (each function small
// enough to read in one pass, dependency-free by design), and importing from
// it would re-run its own corpus loading and console output as a side
// effect. Byte-identical logic, verified against LOR-271's own printed
// numbers below.
// ---------------------------------------------------------------------------

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

function fisherCI(r: number, n: number): [number, number] | null {
  if (n < 4 || !Number.isFinite(r)) return null;
  const clamped = Math.max(-0.999999, Math.min(0.999999, r));
  const z = Math.atanh(clamped);
  const se = 1 / Math.sqrt(n - 3);
  return [Math.tanh(z - 1.96 * se), Math.tanh(z + 1.96 * se)];
}

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
let seedCounter = 4000; // disjoint from LOR-271's 1000-range so no run of either script ever draws the same permutation stream
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

// ---------------------------------------------------------------------------
// Corpus B loader - identical shape to LOR-271's script: LinkedIn's "Basic"
// personal data export, `messages.csv` inside the zip. Duplicated rather
// than imported for the same self-containment reason as the statistics
// above.
// ---------------------------------------------------------------------------

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
  replyWords: number;
  latencyMinutes: number;
}

const parseDate = (d: string): number =>
  new Date(d.replace(' UTC', 'Z').replace(' ', 'T')).getTime();

const replyPairs: ReplyPair[] = [];
for (const [conversationId, conv] of byConversation) {
  for (let i = 0; i < conv.length; i++) {
    const row = conv[i];
    if (row.from !== OPERATOR_NAME || row.isDraft || !row.content.trim()) continue;
    if (i === 0) continue; // conversation opener, nothing preceded it
    const prev = conv[i - 1];
    if (prev.from === OPERATOR_NAME) continue; // continuation of his own burst, not a reply
    replyPairs.push({
      conversationId,
      precedingWords: wordCount(prev.content),
      replyWords: wordCount(row.content),
      latencyMinutes: (parseDate(row.date) - parseDate(prev.date)) / 60000,
    });
  }
}

const CORPUS_B_FULL = `linkedin messages.csv, all replies to an inbound message (n=${replyPairs.length})`;

// =============================================================================
// Part 1: reproduce LOR-271's three headline numbers from the same export,
// so nothing in this spike's doc is hand-copied from a different run.
// =============================================================================

reportContinuous(
  CORPUS_B_FULL,
  'preceding message length (words)',
  replyPairs.map((p) => p.precedingWords),
  replyPairs.map((p) => p.replyWords),
  "reproduces LOR-271's headline number (issue quotes r=0.44 raw / 0.61 log, n=188)",
);

{
  const withLatency = replyPairs.filter(
    (p) => Number.isFinite(p.latencyMinutes) && p.latencyMinutes >= 0,
  );
  reportContinuous(
    `linkedin messages.csv, replies with a non-negative latency (n=${withLatency.length})`,
    'response latency (minutes)',
    withLatency.map((p) => p.latencyMinutes),
    withLatency.map((p) => p.replyWords),
    "reproduces LOR-271's headline latency number (issue quotes r=0.37 log, n=188)",
  );
}

// Contact-identity is reported descriptively here, not recomputed: LOR-271
// already published it (eta-squared=0.375, n=105 replies across 22 contacts
// with >=3 replies each) and this spike's own point about it is structural,
// not a new number - see Part 2 below.
{
  const perConversationReplyWords = new Map<string, number[]>();
  for (const p of replyPairs) {
    (
      perConversationReplyWords.get(p.conversationId) ??
      perConversationReplyWords.set(p.conversationId, []).get(p.conversationId)!
    ).push(p.replyWords);
  }
  const totalConversations = perConversationReplyWords.size;
  const established = [...perConversationReplyWords.values()].filter((w) => w.length >= 3);
  const establishedReplies = established.reduce((s, w) => s + w.length, 0);
  findings.push({
    corpus: `linkedin messages.csv, distinct conversation partners with >=1 reply (n=${totalConversations})`,
    candidate:
      'which contact he is replying to (feasibility only - LOR-271 already reports the effect)',
    method: 'descriptive (not a hypothesis test)',
    n: totalConversations,
    effect: NaN,
    ci95: 'n/a',
    p: NaN,
    note: `only ${established.length} of ${totalConversations} distinct partners (${round((established.length / totalConversations) * 100, 1)}%) ever reach the >=3-reply floor LOR-271's own eta-squared needed (${establishedReplies} of ${replyPairs.length} total replies); the effect is concentrated in a minority even inside an existing professional network - see Part 2`,
  });
}

// =============================================================================
// Part 2: split the same corpus by relationship depth - single exchange
// (he replied to that person exactly once) vs established (two or more
// replies) - the one axis this corpus can test without new data. A Reddit
// or HN reply is a single exchange far more often than not: the target
// commented once, we reply, and there is usually no ongoing relationship
// behind it the way there is with a LinkedIn contact.
// =============================================================================

const perConversationPairs = new Map<string, ReplyPair[]>();
for (const p of replyPairs) {
  (
    perConversationPairs.get(p.conversationId) ??
    perConversationPairs.set(p.conversationId, []).get(p.conversationId)!
  ).push(p);
}
const singleExchange = [...perConversationPairs.values()].filter((v) => v.length === 1).flat();
const established = [...perConversationPairs.values()].filter((v) => v.length >= 2).flat();

reportContinuous(
  `linkedin messages.csv, single-exchange conversations (n=${singleExchange.length}) - closest proxy this corpus has for a Reddit/HN stranger reply`,
  'preceding message length (words)',
  singleExchange.map((p) => p.precedingWords),
  singleExchange.map((p) => p.replyWords),
  'he replied to this contact exactly once in the whole export - no ongoing relationship behind it',
);
reportContinuous(
  `linkedin messages.csv, established conversations (n=${established.length}) - two or more of his replies to the same contact`,
  'preceding message length (words)',
  established.map((p) => p.precedingWords),
  established.map((p) => p.replyWords),
  'comparison group for the row above - an ongoing relationship, the shape LOR-271 actually measured',
);

{
  const singleLat = singleExchange.filter(
    (p) => Number.isFinite(p.latencyMinutes) && p.latencyMinutes >= 0,
  );
  const establishedLat = established.filter(
    (p) => Number.isFinite(p.latencyMinutes) && p.latencyMinutes >= 0,
  );
  reportContinuous(
    `linkedin messages.csv, single-exchange conversations with a non-negative latency (n=${singleLat.length})`,
    'response latency (minutes)',
    singleLat.map((p) => p.latencyMinutes),
    singleLat.map((p) => p.replyWords),
    'same stranger-like proxy as the preceding-length split above',
  );
  reportContinuous(
    `linkedin messages.csv, established conversations with a non-negative latency (n=${establishedLat.length})`,
    'response latency (minutes)',
    establishedLat.map((p) => p.latencyMinutes),
    establishedLat.map((p) => p.replyWords),
    'comparison group for the row above',
  );
}

// Contact identity cannot be computed on the single-exchange half at all,
// by construction: every "contact" there has exactly one reply, so eta-
// squared over singleton groups would report 100% of variance explained -
// an artifact of group size, not a measurement. Recorded as not computed
// rather than printed as a number, the same posture LOR-271's own script
// takes for candidates it has no data to test (its candidates 8 and 9).
findings.push({
  corpus: `linkedin messages.csv, single-exchange conversations (n=${singleExchange.length})`,
  candidate: 'which contact he is replying to',
  method: 'not computed',
  n: singleExchange.length,
  effect: NaN,
  ci95: 'n/a',
  p: NaN,
  note: 'every contact in this half has exactly one reply by definition (that is what makes it single-exchange), so an eta-squared here would be measuring group size, not a real per-contact effect - structurally uncomputable, not merely thin',
});

// =============================================================================
// Part 3: the reply-drafter's own domain - a real corpus, if one exists.
// =============================================================================

interface RedditCase {
  id: string;
  platform: 'reddit' | 'hn' | 'mastodon';
  replyKind: 'reply_comment' | 'reply_dm';
  /** word count of the parent turn (the target user's message/comment) he is replying to */
  precedingWords: number;
  /** word count of the reply he actually sent */
  replyWords: number;
  /** minutes between the parent turn and his reply, if known */
  latencyMinutes?: number;
  /** anonymised handle of the other party, for the contact-identity candidate */
  contactId?: string;
}

interface RedditCasesFile {
  version: number;
  cases: RedditCase[];
}

/**
 * Loads a real reply-drafter/Reddit-DM corpus, the day one is harvested -
 * same schema either `reply_comment` or `reply_dm` thread-reply pairs can
 * use, `contactId` and `latencyMinutes` optional since not every harvest
 * will carry both. Returns `null` when `--reddit-cases` was not passed or
 * the file does not exist, so the caller can report an explicit zero-data
 * finding rather than silently skipping this part of the spike.
 */
function loadRedditCases(path: string | undefined): RedditCase[] | null {
  if (!path || !existsSync(path)) return null;
  const file: RedditCasesFile = JSON.parse(readFileSync(path, 'utf8'));
  return file.cases;
}

const redditCases = loadRedditCases(redditCasesPath);

if (redditCases && redditCases.length > 0) {
  const CORPUS_R = `${redditCasesPath} (n=${redditCases.length})`;
  reportContinuous(
    CORPUS_R,
    'preceding message length (words)',
    redditCases.map((c) => c.precedingWords),
    redditCases.map((c) => c.replyWords),
    'real reply-drafter/Reddit-DM thread-reply pairs, on the actual domain this issue asks about',
  );
  const withLatency = redditCases.filter(
    (c) => typeof c.latencyMinutes === 'number' && c.latencyMinutes >= 0,
  );
  if (withLatency.length > 0) {
    reportContinuous(
      `${redditCasesPath}, with latency (n=${withLatency.length})`,
      'response latency (minutes)',
      withLatency.map((c) => c.latencyMinutes!),
      withLatency.map((c) => c.replyWords),
      'real reply-drafter/Reddit-DM thread-reply pairs',
    );
  }
  const withContact = redditCases.filter((c) => c.contactId);
  const perContact = new Map<string, number[]>();
  for (const c of withContact)
    (perContact.get(c.contactId!) ?? perContact.set(c.contactId!, []).get(c.contactId!)!).push(
      c.replyWords,
    );
  const qualifying = [...perContact.entries()].filter(([, w]) => w.length >= 3);
  if (qualifying.length >= 2) {
    const groups: Record<string, number[]> = {};
    for (const [id, words] of qualifying) groups[id] = words;
    const groupArrays = Object.values(groups);
    const all = groupArrays.flat();
    const grandMean = mean(all);
    const ssTotal = all.reduce((s, v) => s + (v - grandMean) ** 2, 0);
    const eta =
      ssTotal === 0
        ? 0
        : groupArrays.reduce((s, g) => s + g.length * (mean(g) - grandMean) ** 2, 0) / ssTotal;
    findings.push({
      corpus: `${redditCasesPath}, contacts with >=3 replies (n=${qualifying.reduce((s, [, w]) => s + w.length, 0)} replies across ${qualifying.length} contacts)`,
      candidate: 'which contact he is replying to',
      method: 'eta-squared',
      n: qualifying.reduce((s, [, w]) => s + w.length, 0),
      effect: round(eta),
      ci95: 'n/a',
      p: NaN,
      note: 'permutation p not computed here - see LOR-271 script for the full categorical helper if this ever needs it',
    });
  } else {
    findings.push({
      corpus: `${redditCasesPath}`,
      candidate: 'which contact he is replying to',
      method: 'not computed',
      n: withContact.length,
      effect: NaN,
      ci95: 'n/a',
      p: NaN,
      note: `only ${qualifying.length} contact(s) reach the >=3-reply floor - too few to say anything`,
    });
  }
} else {
  findings.push({
    corpus: redditCasesPath ? `${redditCasesPath} (not found)` : 'none passed via --reddit-cases',
    candidate: 'every candidate, on the reply-drafter/Reddit-DM domain itself',
    method: 'not computed',
    n: 0,
    effect: NaN,
    ci95: 'n/a',
    p: NaN,
    note: 'no real reply-drafter/Reddit-DM thread-reply corpus exists to harvest from this worktree (checked: no Reddit/HN export under private/, no production database reachable here) - see the spike doc for what was checked. Pass --reddit-cases=<path to a harvested corpus of this schema> to test it the moment one exists; no code change needed',
  });
}

// ---------------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------------

console.log(
  `\nLOR-281 reply-drafter length-signal spike - no model calls, no network, deterministic.`,
);
console.log(
  `Corpus B: ${exportDir} messages.csv (${dmRows.length} rows, ${replyPairs.length} replies to an inbound message).`,
);
console.log(
  redditCases
    ? `Reddit/HN corpus: ${redditCasesPath} (${redditCases.length} cases).`
    : `Reddit/HN corpus: none (--reddit-cases not passed or file not found) - see notes below.`,
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
