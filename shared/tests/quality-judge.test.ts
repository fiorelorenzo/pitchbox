import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '../src/db/client.js';
import { appConfig } from '../src/db/schema.js';
import {
  scoreBand,
  DEFAULT_QUALITY_RUBRIC,
  loadQualityRubric,
  computeDeterministicQuality,
  DETERMINISTIC_QUALITY_MODEL,
  type OperatorCorpusProfile,
} from '../src/quality-judge.js';
import { measureOneText } from '../src/assist/voice-profile.js';
import { checkStyle } from '../src/style-check.js';

// LOR-229: the measurement that justifies this issue - across 27 real cases,
// every quality signal the product had passed the defect that actually loses
// the sale (a suggestion running 17x the real reply's length, and a style
// checker reporting zero findings on all of them). The tests below defend
// exactly the two properties that make that impossible now: a style finding
// always caps the score below green, and an axis the module cannot measure
// is excluded rather than counted as a match.

async function resetRubric() {
  await getDb().execute(sql`DELETE FROM app_config WHERE key = 'quality_rubric'`);
}

// A real, longish piece of writing so `measureOneText` clears every floor
// (register.ts's own word-count floor, and AVOIDED_WORDS_MIN_WORDS for the
// lexicon axis) - built from `computeDeterministicQuality`'s own axes, not a
// second implementation, so the fixture is honest evidence rather than a
// hand-tuned number.
const LONG_OPERATOR_SAMPLE = Array.from(
  { length: 40 },
  (_, i) =>
    `This is sentence number ${i} about the project, written the way I actually talk to people who ask questions.`,
).join(' ');

function corpusFrom(text: string): OperatorCorpusProfile {
  const m = measureOneText(text);
  return {
    rhythm: m.rhythm,
    punctuation: m.punctuation,
    shape: m.shape,
    voiceMarkers: m.voiceMarkers,
    lexicon: m.lexicon,
  };
}

describe('quality-judge', () => {
  describe('scoreBand', () => {
    it('maps scores to UI bands using rubric thresholds', () => {
      expect(scoreBand(null, DEFAULT_QUALITY_RUBRIC)).toBe('none');
      expect(scoreBand(20, DEFAULT_QUALITY_RUBRIC)).toBe('red');
      expect(scoreBand(50, DEFAULT_QUALITY_RUBRIC)).toBe('amber');
      expect(scoreBand(90, DEFAULT_QUALITY_RUBRIC)).toBe('green');
    });
  });

  describe('loadQualityRubric', () => {
    beforeEach(resetRubric);

    it('returns the default when nothing is configured', async () => {
      const rubric = await loadQualityRubric(getDb());
      expect(rubric).toEqual(DEFAULT_QUALITY_RUBRIC);
    });

    it('preserves a real customization untouched', async () => {
      await getDb()
        .insert(appConfig)
        .values({
          key: 'quality_rubric',
          value: { rubric_template: 'Score for our house voice.' },
        });
      const rubric = await loadQualityRubric(getDb());
      expect(rubric.rubric_template).toBe('Score for our house voice.');
    });

    it('migrates a stored row carrying the literal old (pre-LOR-229) default to the new wording, rather than freezing it', async () => {
      const oldDefault =
        'Score the following outreach draft from 0-100 on these axes (clarity, relevance, personalization, tone). Return JSON {"score": number, "reason": string}.';
      await getDb()
        .insert(appConfig)
        .values({
          key: 'quality_rubric',
          value: { rubric_template: oldDefault, threshold_red: 30 },
        });
      const rubric = await loadQualityRubric(getDb());
      expect(rubric.rubric_template).toBe(DEFAULT_QUALITY_RUBRIC.rubric_template);
      expect(rubric.rubric_template).not.toBe(oldDefault);
      // A real customization elsewhere in the same row survives.
      expect(rubric.threshold_red).toBe(30);
    });
  });

  describe('computeDeterministicQuality', () => {
    it('reports null - not a guessed number - when nothing is measurable at all', () => {
      const result = computeDeterministicQuality({
        body: 'hey, thanks for sharing this',
        styleFindings: [],
        corpus: null,
        rubric: DEFAULT_QUALITY_RUBRIC,
      });
      expect(result.score).toBeNull();
      expect(result.measuredAxisCount).toBe(0);
      expect(result.corpusMeasured).toBe(false);
    });

    it('a non-zero style finding count caps the score below green outright, even with no comparable corpus', () => {
      const body = "In today's fast-paced world, it's worth noting the update shipped.";
      const findings = checkStyle(body);
      expect(findings.length).toBeGreaterThan(0);
      const result = computeDeterministicQuality({
        body,
        styleFindings: findings,
        corpus: null,
        rubric: DEFAULT_QUALITY_RUBRIC,
      });
      expect(result.score).not.toBeNull();
      expect(result.score as number).toBeLessThan(DEFAULT_QUALITY_RUBRIC.threshold_green);
      expect(scoreBand(result.score, DEFAULT_QUALITY_RUBRIC)).not.toBe('green');
    });

    it('the style-finding cap holds even when the measured axes alone would otherwise read as a perfect match', () => {
      const corpus = corpusFrom(LONG_OPERATOR_SAMPLE);
      // The candidate IS the corpus sample, so axis distance is ~0 - the
      // best possible case for anything other than style findings.
      const clean = computeDeterministicQuality({
        body: LONG_OPERATOR_SAMPLE,
        styleFindings: [],
        corpus,
        rubric: DEFAULT_QUALITY_RUBRIC,
      });
      expect(clean.score).not.toBeNull();
      expect(scoreBand(clean.score, DEFAULT_QUALITY_RUBRIC)).toBe('green');

      const withFinding = computeDeterministicQuality({
        body: LONG_OPERATOR_SAMPLE,
        styleFindings: checkStyle("in today's fast-paced world"),
        corpus,
        rubric: DEFAULT_QUALITY_RUBRIC,
      });
      expect(withFinding.score as number).toBeLessThan(DEFAULT_QUALITY_RUBRIC.threshold_green);
    });

    it('excludes an unmeasured axis from the average rather than counting it as a match', () => {
      const corpus = corpusFrom(LONG_OPERATOR_SAMPLE);
      // Too short to clear register.ts's own floor: rhythm/punctuation/shape/
      // voiceMarkers/lexicon must all read as unmeasured, only length survives
      // (it only needs a raw word count, not a register).
      const short = computeDeterministicQuality({
        body: 'ok thanks',
        styleFindings: [],
        corpus,
        rubric: DEFAULT_QUALITY_RUBRIC,
      });
      expect(short.distance.rhythm).toBeNull();
      expect(short.distance.punctuation).toBeNull();
      expect(short.distance.shape).toBeNull();
      expect(short.distance.voiceMarkers).toBeNull();
      expect(short.distance.lexicon).toBeNull();
      expect(short.distance.length).not.toBeNull();
      expect(short.measuredAxisCount).toBe(1);
    });

    it('measures the full set of axes against a corpus long enough to compare against, and length ratio above 1 means longer than typical', () => {
      const corpus = corpusFrom(LONG_OPERATOR_SAMPLE);
      const muchLonger = Array.from(
        { length: 400 },
        (_, i) =>
          `Extra padding word number ${i} that nobody who writes short replies would ever use.`,
      ).join(' ');
      const result = computeDeterministicQuality({
        body: muchLonger,
        styleFindings: [],
        corpus,
        rubric: DEFAULT_QUALITY_RUBRIC,
      });
      expect(result.corpusMeasured).toBe(true);
      expect(result.lengthRatio).not.toBeNull();
      expect(result.lengthRatio as number).toBeGreaterThan(1);
      expect(result.measuredAxisCount).toBeGreaterThan(0);
    });

    it('is reproducible: the same body against the same corpus scores identically on two runs', () => {
      const corpus = corpusFrom(LONG_OPERATOR_SAMPLE);
      const args = {
        body: 'A completely ordinary reply about the same subject, written at a normal length for once.',
        styleFindings: [],
        corpus,
        rubric: DEFAULT_QUALITY_RUBRIC,
      };
      const first = computeDeterministicQuality(args);
      const second = computeDeterministicQuality(args);
      expect(second).toEqual(first);
    });

    it('measures echo against the source post the draft answers, null without one (LOR-251)', () => {
      const post =
        'We just shipped the new expense reconciliation workflow after months of testing.';
      const withSource = computeDeterministicQuality({
        body: 'Congrats on shipping the new expense reconciliation workflow!',
        styleFindings: [],
        corpus: null,
        rubric: DEFAULT_QUALITY_RUBRIC,
        post,
      });
      expect(withSource.sourceMeasured).toBe(true);
      expect(withSource.distance.echo).not.toBeNull();
      expect(withSource.distance.echo!).toBeGreaterThan(0);

      const withoutSource = computeDeterministicQuality({
        body: 'Congrats on shipping the new expense reconciliation workflow!',
        styleFindings: [],
        corpus: null,
        rubric: DEFAULT_QUALITY_RUBRIC,
      });
      expect(withoutSource.sourceMeasured).toBe(false);
      expect(withoutSource.distance.echo).toBeNull();
      expect(withoutSource.languageMatch).toBeNull();
      expect(withoutSource.distance.languageMatch).toBeNull();
    });

    it('measures language match against the source post, never a guessed true/false when either side is too short to classify (LOR-251)', () => {
      const matching = computeDeterministicQuality({
        body: 'This is a great update and I am glad the team shipped it this week.',
        styleFindings: [],
        corpus: null,
        rubric: DEFAULT_QUALITY_RUBRIC,
        post: 'We shipped a big update to the product this week after a long sprint.',
      });
      expect(matching.languageMatch).toBe(true);
      expect(matching.distance.languageMatch).toBe(0);

      const mismatched = computeDeterministicQuality({
        body: 'Questo aggiornamento e fantastico, complimenti a tutto il team per il lavoro.',
        styleFindings: [],
        corpus: null,
        rubric: DEFAULT_QUALITY_RUBRIC,
        post: 'We shipped a big update to the product this week after a long sprint.',
      });
      expect(mismatched.languageMatch).toBe(false);
      expect(mismatched.distance.languageMatch).toBe(1);

      const unclassifiable = computeDeterministicQuality({
        body: 'Grande!',
        styleFindings: [],
        corpus: null,
        rubric: DEFAULT_QUALITY_RUBRIC,
        post: 'Ok.',
      });
      expect(unclassifiable.languageMatch).toBeNull();
      expect(unclassifiable.distance.languageMatch).toBeNull();
    });

    it('LOR-265: an explicit pin outranks the post for what "correct" means on this axis', () => {
      const italianBody =
        'Questo aggiornamento e fantastico, complimenti a tutto il team per il lavoro.';
      const englishPost = 'We shipped a big update to the product this week after a long sprint.';

      // Without a pin, an Italian body answering an English post is a
      // mismatch (LOR-251's original behaviour, still the default).
      const withoutPin = computeDeterministicQuality({
        body: italianBody,
        styleFindings: [],
        corpus: null,
        rubric: DEFAULT_QUALITY_RUBRIC,
        post: englishPost,
      });
      expect(withoutPin.languageMatch).toBe(false);
      expect(withoutPin.expectedLanguage).toBe('en');

      // Pinned to Italian, the same Italian body answering the same
      // English post is a match, not a mismatch - the whole reason a pin
      // exists is to make this outcome correct on purpose (LOR-265).
      const withPin = computeDeterministicQuality({
        body: italianBody,
        styleFindings: [],
        corpus: null,
        rubric: DEFAULT_QUALITY_RUBRIC,
        post: englishPost,
        expectedLanguage: 'it',
      });
      expect(withPin.languageMatch).toBe(true);
      expect(withPin.distance.languageMatch).toBe(0);
      expect(withPin.expectedLanguage).toBe('it');
      // Still recorded for transparency - only outranked, never erased.
      expect(withPin.postLanguage).toBe('en');

      // The pin does not launder a wrong answer: a candidate that ignores
      // it is still a real finding, just measured against the pin instead
      // of the post.
      const wrongDespitePin = computeDeterministicQuality({
        body: 'This reply is in English even though the campaign pinned Italian.',
        styleFindings: [],
        corpus: null,
        rubric: DEFAULT_QUALITY_RUBRIC,
        post: englishPost,
        expectedLanguage: 'it',
      });
      expect(wrongDespitePin.languageMatch).toBe(false);
      expect(wrongDespitePin.expectedLanguage).toBe('it');
    });

    it('prefers the visible thread median over the operator corpus median for the length axis (LOR-251)', () => {
      const corpus = corpusFrom(LONG_OPERATOR_SAMPLE);
      const body = 'One two three four five six seven eight nine ten.';
      const withThread = computeDeterministicQuality({
        body,
        styleFindings: [],
        corpus,
        rubric: DEFAULT_QUALITY_RUBRIC,
        threadCommentWordCounts: [4, 5, 6],
      });
      expect(withThread.lengthComparisonBasis).toBe('thread-median');
      expect(withThread.lengthRatio).toBe(2); // 10 candidate words / median 5

      const withoutThread = computeDeterministicQuality({
        body,
        styleFindings: [],
        corpus,
        rubric: DEFAULT_QUALITY_RUBRIC,
      });
      expect(withoutThread.lengthComparisonBasis).toBe('operator-corpus');
    });

    it('a proactive post with no source still scores from style and corpus alone, source axes null rather than a guessed zero (LOR-251)', () => {
      const corpus = corpusFrom(LONG_OPERATOR_SAMPLE);
      const result = computeDeterministicQuality({
        body: LONG_OPERATOR_SAMPLE,
        styleFindings: [],
        corpus,
        rubric: DEFAULT_QUALITY_RUBRIC,
      });
      expect(result.score).not.toBeNull();
      expect(result.sourceMeasured).toBe(false);
      expect(result.distance.echo).toBeNull();
      expect(result.distance.languageMatch).toBeNull();
      expect(result.languageMatch).toBeNull();
    });
  });

  describe('DETERMINISTIC_QUALITY_MODEL', () => {
    it('is a sentinel string, never mistakable for a real Gateway model id', () => {
      expect(DETERMINISTIC_QUALITY_MODEL).toBe('deterministic');
      expect(DETERMINISTIC_QUALITY_MODEL).not.toContain('/');
    });
  });
});
