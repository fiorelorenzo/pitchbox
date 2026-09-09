import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  selectExamples,
  MIN_SIMILARITY_SCORE,
  DUPLICATE_SIMILARITY_THRESHOLD,
  type ExampleCandidate,
} from '../src/assist/example-selection.js';

// #578: the few-shot examples in a suggestion's prompt used to be "the
// first MAX_EXAMPLES of whatever order the caller passed" - in practice,
// recency. This exercises `selectExamples`'s replacement: examples chosen
// for the post at hand by lexical overlap, deterministic and explainable,
// with a diversity rule against near-duplicates and a recency fallback
// when nothing in the corpus is actually close to the subject.

const day = (n: number): Date => new Date(2026, 0, n);

function candidate(
  id: number,
  title: string,
  body: string,
  createdAtDay: number,
): ExampleCandidate {
  return { id, title, body, createdAt: day(createdAtDay) };
}

describe('selectExamples', () => {
  // The post and three genuinely on-topic write-ups (database/index/latency
  // vocabulary), plus two genuinely unrelated ones (hiring, onboarding) that
  // are far more recent - so a recency-only baseline and a similarity-based
  // one land on different sets, and the difference is the point of #578.
  const dbPost = {
    text: 'We cut our database p99 latency in half this week after adding an index and fixing a query that was doing a full table scan.',
  };
  const onTopic1 = candidate(
    1,
    'db latency',
    'Adding the right index on that query took our database latency from painful to boring in one afternoon.',
    1,
  );
  const onTopic2 = candidate(
    2,
    'table scan',
    'Turned out a full table scan was our real problem, once we added an index the slow query disappeared overnight.',
    2,
  );
  const onTopic3 = candidate(
    3,
    'boring graph',
    'Our database latency graph finally looks boring after we added an index and killed a query doing a full table scan.',
    3,
  );
  const offTopicRecent1 = candidate(
    4,
    'new hire',
    'Thrilled to welcome our new head of sales to the team this week.',
    20,
  );
  const offTopicRecent2 = candidate(
    5,
    'onboarding',
    'Our new onboarding flow cut signup drop-off by a third in the first week alone.',
    25,
  );
  const dbCorpus = [onTopic1, onTopic2, onTopic3, offTopicRecent1, offTopicRecent2];

  it("picks the examples about the post's own subject, not the most recently written ones", () => {
    const recencyOnlyIds = [...dbCorpus]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 3)
      .map((c) => c.id);

    const result = selectExamples(dbPost, dbCorpus, 3);

    expect(result.mode).toBe('similarity');
    expect(result.examples.map((e) => e.id)).toEqual([3, 1, 2]);
    // The two answers genuinely disagree - the recency-only baseline would
    // have carried two posts (hiring, onboarding) that share nothing with
    // this post's subject.
    expect(result.examples.map((e) => e.id)).not.toEqual(recencyOnlyIds);
    expect(recencyOnlyIds).toEqual([5, 4, 3]);
  });

  it('is explainable: each pick names real shared vocabulary, not a generic label', () => {
    const result = selectExamples(dbPost, dbCorpus, 3);
    for (const example of result.examples) {
      expect(example.reason).toMatch(/^Shares ".+" with the post\.$/);
    }
    expect(result.examples[0]?.reason).toContain('"database"');
  });

  it('is deterministic regardless of the candidate array order', () => {
    const first = selectExamples(dbPost, dbCorpus, 3);
    const shuffled = [offTopicRecent2, onTopic2, offTopicRecent1, onTopic1, onTopic3];
    const second = selectExamples(dbPost, shuffled, 3);
    expect(second).toEqual(first);

    // Same corpus, same order, run twice - not just order-independent but
    // repeatable.
    const third = selectExamples(dbPost, dbCorpus, 3);
    expect(third).toEqual(first);
  });

  it('prefers a distinctly-worded example over near-verbatim rewordings of the top pick', () => {
    const dupPost = {
      text: 'We rebuilt our onboarding flow last quarter and signup drop-off finally stopped being embarrassing.',
    };
    // Three near-verbatim rewordings of one idea (11, 13 are close
    // rewordings of 12's exact sentence structure), one looser rewording of
    // the same idea in different words (14), and one genuinely different
    // post (15).
    const nearVerbatim1 = candidate(
      11,
      'onboarding v1',
      'We rebuilt our onboarding flow this year and signup drop-off finally stopped being embarrassing for us.',
      1,
    );
    const topPick = candidate(
      12,
      'onboarding v2',
      'We rebuilt the onboarding flow last year and our signup drop-off finally stopped being so embarrassing.',
      2,
    );
    const nearVerbatim3 = candidate(
      13,
      'onboarding v3',
      'We rebuilt onboarding again this quarter and signup drop-off finally stopped being an embarrassing number.',
      3,
    );
    const looserRewording = candidate(
      14,
      'onboarding v4',
      'Rebuilding onboarding fixed our embarrassing signup drop-off, finally, after several quarters of trying.',
      4,
    );
    const distinct = candidate(
      15,
      'support queue',
      'Separately, we also switched our support queue to a shared inbox so replies stopped getting lost between three tools.',
      5,
    );
    const dupCorpus = [nearVerbatim1, topPick, nearVerbatim3, looserRewording, distinct];

    // Confirms the fixture premise independently of the module under test:
    // 11 and 13 are textually closer to the top pick (12) than 14 is, by
    // plain whitespace-token overlap.
    const wordsOf = (text: string): Set<string> =>
      new Set(text.toLowerCase().split(/\W+/).filter(Boolean));
    const overlapWithTopPick = (text: string): number => {
      const top = wordsOf(topPick.body);
      const other = wordsOf(text);
      const shared = [...top].filter((w) => other.has(w)).length;
      return shared / Math.max(top.size, other.size);
    };
    expect(overlapWithTopPick(nearVerbatim1.body)).toBeGreaterThan(
      overlapWithTopPick(looserRewording.body),
    );
    expect(overlapWithTopPick(nearVerbatim3.body)).toBeGreaterThan(
      overlapWithTopPick(looserRewording.body),
    );

    const result = selectExamples(dupPost, dupCorpus, 3);

    expect(result.mode).toBe('similarity');
    // The naive "top three by score" would have been 12, 11, 13 - three
    // rewordings of one idea. Diversity dedup rules out 11 and 13 as
    // near-duplicates of 12 (the top pick) and keeps the more differently
    // worded 14 instead, even though 11 and 13 individually read closer to
    // the top pick than 14 does. 15 never qualifies at all - it is a
    // genuinely different post, below MIN_SIMILARITY_SCORE against this
    // one, and a floor cannot be relaxed just to fill the cap.
    expect(result.examples.map((e) => e.id)).toEqual([12, 14]);
  });

  it('falls back to recency, and says so, when nothing in the corpus is topically close', () => {
    const unrelatedPost = {
      text: 'Considering whether to switch our entire team to a four day work week starting next quarter.',
    };
    const noMatchCorpus = [onTopic1, onTopic2, offTopicRecent1, offTopicRecent2];
    const result = selectExamples(unrelatedPost, noMatchCorpus, 3);

    expect(result.mode).toBe('recency');
    // Every candidate's own lexical score is confirmed below the floor -
    // this is a genuine "nothing matched" case, not a fluke of the fixture.
    for (const example of result.examples) {
      expect(example.score).toBeLessThan(MIN_SIMILARITY_SCORE);
    }
    // Recency order: most recently created first, id as the final tie-break.
    expect(result.examples.map((e) => e.id)).toEqual([5, 4, 2]);
    for (const example of result.examples) {
      expect(example.reason).toMatch(/topically close/);
    }
  });

  it('respects the cap even when more than max candidates qualify and none are duplicates', () => {
    const diverseOnTopic = [
      onTopic1,
      onTopic2,
      onTopic3,
      candidate(
        6,
        'checkout latency',
        'A missing index on the orders table was the whole story - once we added it the database stopped complaining about latency during checkout.',
        6,
      ),
      candidate(
        7,
        'unindexed fk',
        'We finally profiled the slow endpoint and found an unindexed foreign key column causing the database to scan the entire table on every request.',
        7,
      ),
      candidate(
        8,
        'query planner',
        'Query planner showed a sequential scan instead of an index lookup, so we added one and database response time dropped immediately.',
        8,
      ),
    ];
    const result = selectExamples(dbPost, diverseOnTopic, 3);
    expect(result.mode).toBe('similarity');
    expect(result.examples).toHaveLength(3);
  });

  it('returns nothing for an empty corpus rather than throwing', () => {
    const result = selectExamples(dbPost, [], 3);
    expect(result.examples).toEqual([]);
  });

  it('DUPLICATE_SIMILARITY_THRESHOLD and MIN_SIMILARITY_SCORE are ordered sensibly', () => {
    // A candidate can never simultaneously be "not similar enough to the
    // post to count" and "so similar to another pick it has to be dropped
    // as a duplicate" in a way that breaks the floor check - the duplicate
    // threshold is the higher bar, as it must be to mean anything.
    expect(DUPLICATE_SIMILARITY_THRESHOLD).toBeGreaterThan(MIN_SIMILARITY_SCORE);
  });
});

// #578's acceptance, matching #570's own test for the same claim
// (assist-voice-profile.test.ts): no model call anywhere in the selection
// path. Asserted by scanning the real source text, so a future import of a
// model client or a Gateway call fails this test immediately rather than
// being caught by review.
describe('no model call in the selection path', () => {
  const FORBIDDEN_PATTERNS = [
    /\bfrom\s+['"]ai['"]/i,
    /@ai-sdk/i,
    /streamText/,
    /generateText/,
    /AI_GATEWAY/,
    /gateway-catalogue/i,
    /agents\/sdk/i,
    /completion\(/,
    /\bfetch\(/,
  ];

  const FILES = ['../src/assist/example-selection.ts'];

  for (const relativePath of FILES) {
    it(`${relativePath} never imports or calls a model`, () => {
      const path = fileURLToPath(new URL(relativePath, import.meta.url));
      const source = readFileSync(path, 'utf8');
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(source).not.toMatch(pattern);
      }
    });
  }
});
