import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scoreCandidate, type ScoreCandidateArgs } from '../src/voice-metrics.js';
import { loadVoiceEvalCases } from '../src/voice-eval-cases.js';

// LOR-44: "sounds like him" is a product claim, not an opinion, and this is
// the deterministic half of proving it - a pure, synchronous scorer over one
// candidate reply, the post it answers, and the operator's own real reply to
// that post. Every fixture below is built to make one hand-checkable claim,
// the same discipline assist-voice-profile.test.ts already follows: not "the
// code runs" but "this exact input produces this exact number".

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/voice-eval/synthetic-cases.json', import.meta.url),
);

function score(args: ScoreCandidateArgs) {
  return scoreCandidate(args);
}

describe('scoreCandidate', () => {
  it('reports near-zero distance when the candidate matches the real reply almost verbatim', () => {
    const reply =
      'I shipped the dashboard update today, and I think the team is genuinely happy with how it turned out.';
    const candidate =
      'I shipped the dashboard update today, and I think the team is genuinely pleased with how it turned out.';
    const result = score({ candidate, post: 'Anything ship this week?', actualReply: reply });
    expect(result.distance.rhythm).not.toBeNull();
    expect(result.distance.rhythm).toBeLessThan(0.2);
    expect(result.distance.voiceMarkers).not.toBeNull();
    expect(result.distance.voiceMarkers).toBeLessThan(0.2);
  });

  it('reports every axis as null (not zero, not one) when the real reply is too short to have a register', () => {
    const result = score({
      candidate:
        'Congratulations on the launch, this is a genuinely impressive milestone for the whole team and I mean that sincerely.',
      post: 'We are opening signups today after eight months of building in private.',
      actualReply: 'Grande!',
    });
    expect(result.distance).toEqual({
      rhythm: null,
      punctuation: null,
      shape: null,
      voiceMarkers: null,
      lexicon: null,
    });
  });

  it('reports every axis as null when there is no real reply at all (a silence case)', () => {
    const result = score({
      candidate: 'Interesting take, though I am not sure I fully agree with the framing here.',
      post: 'Hot take: nobody actually reads the changelog.',
      actualReply: null,
    });
    expect(result.distance).toEqual({
      rhythm: null,
      punctuation: null,
      shape: null,
      voiceMarkers: null,
      lexicon: null,
    });
    // Nothing to compare length against either - no thread, no real reply.
    expect(result.lengthRatio).toBeNull();
    expect(result.lengthComparisonBasis).toBeNull();
  });

  it('gates the lexicon axis on both sides clearing the 200-word floor, not folding a too-short pair into a false match', () => {
    const short = score({
      candidate: 'Great point, thanks for sharing this.',
      post: 'A post about something.',
      actualReply: 'Totally agree with this take.',
    });
    expect(short.distance.lexicon).toBeNull();

    const filler = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
    const long = score({
      candidate: `${filler(210)} leverage`,
      post: 'A post about something.',
      actualReply: filler(210),
    });
    // Candidate uses "leverage" (present -> not "avoided"), the real reply
    // never mentions it (absent -> "avoided") - one word disagrees out of
    // fourteen AVOIDABLE_WORD_CANDIDATES, so the axis is measurable and
    // strictly between identical and maximally different.
    expect(long.distance.lexicon).not.toBeNull();
    expect(long.distance.lexicon).toBeGreaterThan(0);
    expect(long.distance.lexicon).toBeLessThan(1);
  });

  it('measures length ratio against the thread median when given one, else falls back to the real reply', () => {
    const withThread = score({
      candidate: 'One two three four five six seven eight nine ten.',
      post: 'A post.',
      actualReply:
        'A totally different, much longer real reply used only as a fallback comparator here.',
      threadCommentWordCounts: [4, 5, 6],
    });
    expect(withThread.lengthComparisonBasis).toBe('thread-median');
    expect(withThread.lengthRatio).toBe(2); // 10 candidate words / median 5

    const withoutThread = score({
      candidate: 'One two three four five six seven eight nine ten.',
      post: 'A post.',
      actualReply: 'Five real words here now.',
    });
    expect(withoutThread.lengthComparisonBasis).toBe('actual-reply');
    expect(withoutThread.lengthRatio).toBe(2); // 10 candidate words / 5 real-reply words
  });

  it("measures echo as how much of the candidate is made of the post's own words", () => {
    const post = 'We just shipped the new expense reconciliation workflow after months of testing.';
    const copying = score({
      candidate: 'Congrats on shipping the new expense reconciliation workflow!',
      post,
      actualReply: null,
    });
    const original = score({
      candidate: 'Huge milestone, well deserved after all that effort.',
      post,
      actualReply: null,
    });
    expect(copying.echo).not.toBeNull();
    expect(original.echo).not.toBeNull();
    expect(copying.echo!).toBeGreaterThan(original.echo!);
  });

  it('reports echo as null when the candidate has no content words of its own', () => {
    const result = score({
      candidate: '💪',
      post: 'A perfectly ordinary post about something.',
      actualReply: null,
    });
    expect(result.echo).toBeNull();
  });

  it('reports language match only when both sides classify, never a guessed true/false', () => {
    const matching = score({
      candidate: 'This is a great update and I am glad the team shipped it this week.',
      post: 'We shipped a big update to the product this week after a long sprint.',
      actualReply: null,
    });
    expect(matching.languageMatch).toBe(true);

    const mismatched = score({
      candidate: 'Questo aggiornamento è fantastico, complimenti a tutto il team per il lavoro.',
      post: 'We shipped a big update to the product this week after a long sprint.',
      actualReply: null,
    });
    expect(mismatched.languageMatch).toBe(false);

    const unclassifiable = score({ candidate: 'Grande!', post: 'Ok.', actualReply: null });
    expect(unclassifiable.languageMatch).toBeNull();
  });

  it('surfaces checkStyle findings on the candidate verbatim', () => {
    const result = score({
      candidate: 'Great post — really made me think.',
      post: 'A post about something.',
      actualReply: null,
    });
    expect(result.styleFindings.some((f) => f.ruleId === 'em-dash')).toBe(true);
  });
});

describe('scoreCandidate against the committed synthetic fixture', () => {
  it('scores every case in the fixture without throwing, silence case included', () => {
    const file = loadVoiceEvalCases(FIXTURE_PATH);
    for (const c of file.cases) {
      // The eval runner would generate its own candidate via the model; here
      // the real reply itself stands in as "a candidate" purely to prove the
      // scorer runs end to end on every genre in the fixture, offline.
      const candidate = c.actualReply ?? c.post.text;
      expect(() =>
        scoreCandidate({ candidate, post: c.post.text, actualReply: c.actualReply }),
      ).not.toThrow();
    }
  });
});

// LOR-44's own acceptance: no model call anywhere in this scorer. Mirrors
// assist-voice-profile.test.ts's identical check for voice-profile.ts.
describe('no model call in voice-metrics.ts', () => {
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
    /readFileSync|readFile\(/,
  ];

  it('never imports or calls a model, and never touches the filesystem', () => {
    const path = fileURLToPath(new URL('../src/voice-metrics.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(source).not.toMatch(pattern);
    }
  });
});
