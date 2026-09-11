#!/usr/bin/env tsx
/**
 * Converts a raw LinkedIn harvest into shared/src/voice-eval-cases.ts's
 * schema (LOR-44). Not part of the eval runner itself - a one-shot import
 * step, run by hand whenever a fresh harvest lands.
 *
 * Input shape (the harvester's own, undocumented elsewhere): a JSON file
 * with `posts: [{ urn, text, meta? }]` (the operator's own writing) and
 * `commentPairs: [{ urn, postAuthor?, postText, comments: string[] }]`
 * (someone else's post, paired with the operator's own comment(s) under it -
 * `comments` is almost always one string, but a post the operator commented
 * on more than once produces one case per comment, sharing the post).
 *
 * Both input and output live under `private/` (gitignored) - this script
 * never reads or writes anything this repo tracks.
 *
 * Usage: tsx scripts/voice-eval-import.ts [input.json] [output.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  loadVoiceEvalCases,
  VOICE_EVAL_SCHEMA_VERSION,
  type VoiceEvalCase,
  type VoiceEvalCorpusItem,
} from '../shared/src/voice-eval-cases.js';

interface RawPost {
  urn: string;
  text: string;
  meta?: string;
}

interface RawCommentPair {
  urn: string;
  postAuthor?: string;
  postText: string;
  comments: string[];
}

interface RawFile {
  posts: RawPost[];
  commentPairs: RawCommentPair[];
}

const inputPath = process.argv[2] ?? 'private/voice-eval/raw.json';
const outputPath = process.argv[3] ?? 'private/voice-eval/cases.json';

const raw = JSON.parse(readFileSync(inputPath, 'utf8')) as RawFile;

const voiceCorpus: VoiceEvalCorpusItem[] = raw.posts.map((p, i) => ({
  id: p.urn || `post-${i + 1}`,
  text: p.text,
}));

// A post the operator commented on more than once is not one case with two
// replies, it is two independent cases sharing the same post - each comment
// is judged on its own against the same real-reply comparator, and folding
// them together would hide which of two replies actually reads as human.
const cases: VoiceEvalCase[] = raw.commentPairs.flatMap((pair, pairIndex) => {
  if (pair.comments.length === 0) return [];
  return pair.comments.map((comment, commentIndex) => ({
    id:
      pair.comments.length > 1
        ? `${pair.urn}#${commentIndex}`
        : pair.urn || `pair-${pairIndex + 1}`,
    genre: 'unclassified' as const,
    postAuthor: pair.postAuthor,
    post: { text: pair.postText },
    actualReply: comment,
  }));
});

const output = {
  schemaVersion: VOICE_EVAL_SCHEMA_VERSION,
  voiceCorpus,
  cases,
};

writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);

// Fail fast against the real schema rather than leaving a malformed file for
// the runner to discover later.
loadVoiceEvalCases(outputPath);

console.log(
  `Wrote ${voiceCorpus.length} voice-corpus item(s) and ${cases.length} case(s) to ${outputPath}.`,
);
