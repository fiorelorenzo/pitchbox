import { describe, expect, it } from 'vitest';
import {
  measureVoiceCorpus,
  describeVoiceProfile,
  MIN_ITEMS_TO_DERIVE,
  type VoiceCorpusItem,
  type VoiceMeasurement,
} from '../src/assist/voice-profile.js';

// #407: the operator's own voice, derived from what they have actually
// written rather than shipped as a raw list of captured posts. A
// measurement, not a model call, for the reasons `assist/register.ts` (#406)
// already established for the room's half of the mix - what is worth
// pinning here is the corpus-level version of the same discipline: a corpus
// too small says nothing, a trait or phrase has to repeat across separate
// pieces of writing to count as a habit, and excluding a piece of writing
// changes what comes out.

const SHORT_FIRST_PERSON = [
  'I shipped the new dashboard today. It took longer than I hoped. The team is happy with it now.',
  "I fixed the flaky test suite this week. It was harder than expected. My team is relieved it's done.",
  'I wrapped up the migration this morning. It went smoother than planned. We are all glad it is finished.',
];

const LONG_IMPERSONAL = [
  'The dashboard redesign shipped this week after several rounds of internal review and testing across every team involved in the rollout process.',
  'The onboarding flow moved to a single guided wizard after customer interviews revealed the previous multi-page form confused nearly half of new signups every single week.',
];

function corpusOf(texts: string[]): VoiceCorpusItem[] {
  return texts.map((text, i) => ({ id: i + 1, kind: 'voice_sample' as const, text }));
}

describe('measureVoiceCorpus', () => {
  it('says nothing about a corpus too small to derive anything, but still counts it', () => {
    const corpus = corpusOf([
      'Shipped the new search today, took three tries to get it right.',
      'Thanks for the feedback, I will look into it this week.',
    ]);
    expect(corpus.length).toBeLessThan(MIN_ITEMS_TO_DERIVE);
    const m = measureVoiceCorpus(corpus);
    expect(m.measurable).toBe(false);
    expect(m.itemCount).toBe(2);
    expect(m.wordCount).toBeGreaterThan(0);
    expect(m.traits).toEqual([]);
    expect(m.openings).toEqual([]);
    expect(describeVoiceProfile(m)).toBeNull();
  });

  it('reports only the trait a clear majority of the corpus shares, not one two of five happen to have', () => {
    const m = measureVoiceCorpus(corpusOf([...SHORT_FIRST_PERSON, ...LONG_IMPERSONAL]));
    expect(m.measurable).toBe(true);
    expect(m.traits).toContain('first-person');
    expect(m.traits).toContain('short-sentences');
    // Two of five is not a majority: the minority register must not appear
    // alongside the one that actually dominates.
    expect(m.traits).not.toContain('impersonal');
    expect(m.traits).not.toContain('long-sentences');
  });

  describe('recurring openings', () => {
    // Six items: three open on "Just shipped", three do not. Sized so that
    // dropping two of the three still leaves a corpus large enough to
    // derive something (this isolates the phrase's own repeat count from
    // the separate "corpus too small" cutoff).
    const withRepeat: VoiceCorpusItem[] = [
      {
        id: 1,
        kind: 'voice_sample',
        text: 'Just shipped campaign search today. Took three tries to get the ranking right.',
      },
      {
        id: 2,
        kind: 'message',
        text: 'Just shipped the new onboarding flow after two weeks of quiet work on it.',
      },
      {
        id: 3,
        kind: 'draft',
        text: 'Just shipped a fix for the flaky test suite, small change, big relief for the team.',
      },
      {
        id: 4,
        kind: 'template',
        text: 'Excited to announce our new pricing page is live, let me know what you think.',
      },
      {
        id: 5,
        kind: 'message',
        text: 'Working through customer interviews this week, learned a lot about pricing sensitivity.',
      },
      {
        id: 6,
        kind: 'draft',
        text: 'Wrapped up the migration this morning, the team should notice a real speed difference.',
      },
    ];

    it('finds a phrase that opens at least a tenth of the corpus', () => {
      const m = measureVoiceCorpus(withRepeat);
      expect(m.openings).toContain('Just shipped');
    });

    it('excluding the items that shared it drops the phrase - the corpus decides, not a helper', () => {
      const withoutTwo = withRepeat.filter((c) => c.id !== 1 && c.id !== 3);
      expect(withoutTwo.length).toBeGreaterThanOrEqual(MIN_ITEMS_TO_DERIVE);
      const m = measureVoiceCorpus(withoutTwo);
      expect(m.openings).not.toContain('Just shipped');
    });
  });

  it('finds a closing phrase repeated across separate items', () => {
    const corpus = corpusOf([
      'Small release today, nothing dramatic, let me know what you think.',
      'Rough week behind us, glad it is over, let me know what you think.',
      'Big milestone for the team this quarter, let me know what you think.',
      'Nothing exciting to report this week, just steady progress on the roadmap.',
    ]);
    const m = measureVoiceCorpus(corpus);
    expect(m.closings).toContain('what you think.');
  });

  describe('reused words', () => {
    it('requires coverage across separate items, not repetition inside one', () => {
      const corpus = corpusOf([
        // "shipped" appears five times, but only in this one item.
        'Shipped shipped shipped shipped shipped campaign search feature this week to a small group of beta testers for validation purposes today.',
        'The team worked hard on the migration this quarter and finally got it across the line yesterday afternoon.',
        'Our team celebrated the launch today after months of careful planning and constant effort this year.',
        'The support team answered every ticket within an hour this week during the incident response effort.',
      ]);
      const m = measureVoiceCorpus(corpus);
      expect(m.commonWords).toContain('team');
      expect(m.commonWords).not.toContain('shipped');
    });
  });
});

describe('describeVoiceProfile', () => {
  it('assembles the measured pieces into prose, omitting whichever came back empty', () => {
    const full: VoiceMeasurement = {
      itemCount: 12,
      wordCount: 640,
      measurable: true,
      traits: ['first-person', 'short-sentences'],
      wordsPerSentence: 9,
      openings: ['Just shipped'],
      closings: ['what you think.'],
      commonWords: ['team', 'shipped'],
    };
    const described = describeVoiceProfile(full)!;
    expect(described).toMatch(/12 pieces of their own writing/);
    expect(described).toMatch(/640 words/);
    expect(described).toMatch(/first person, speaking as themselves/);
    expect(described).toMatch(/9 words per sentence/);
    expect(described).toContain('Often opens with "Just shipped"');
    expect(described).toContain('Often closes with "what you think."');
    expect(described).toContain('team, shipped');

    const noPhrasesOrWords: VoiceMeasurement = {
      ...full,
      openings: [],
      closings: [],
      commonWords: [],
    };
    const withoutExtras = describeVoiceProfile(noPhrasesOrWords)!;
    expect(withoutExtras).not.toMatch(/Often opens/);
    expect(withoutExtras).not.toMatch(/Often closes/);
    expect(withoutExtras).not.toMatch(/Reuses/);
  });

  it('says nothing when the corpus was measurable but had no dominant trait, phrase or word', () => {
    const flat: VoiceMeasurement = {
      itemCount: 5,
      wordCount: 300,
      measurable: true,
      traits: [],
      wordsPerSentence: 0,
      openings: [],
      closings: [],
      commonWords: [],
    };
    expect(describeVoiceProfile(flat)).toBeNull();
  });

  it('returns null outright for an unmeasurable corpus regardless of its counts', () => {
    const tooSmall: VoiceMeasurement = {
      itemCount: 2,
      wordCount: 40,
      measurable: false,
      traits: [],
      wordsPerSentence: 0,
      openings: [],
      closings: [],
      commonWords: [],
    };
    expect(describeVoiceProfile(tooSmall)).toBeNull();
  });
});
