import { describe, expect, it } from 'vitest';
import { describeScenarioSchema } from '../../src/campaigns/schema-to-prompt';

describe('describeScenarioSchema', () => {
  it('produces a markdown listing every reddit-scout field', () => {
    const md = describeScenarioSchema('reddit-scout');
    for (const field of [
      'targetSubreddits',
      'topicKeywords',
      'avoidKeywords',
      'fitScoreThreshold',
      'voice.tone',
      'voice.hardBans',
      'voice.dos',
      'voice.openerStyle',
      'voice.disclosure',
      'offer.productUrl',
      'offer.subject',
      'offer.text',
      'systemInstructions',
    ]) {
      expect(md).toContain(field);
    }
    expect(md).toMatch(/casual.*neutral.*professional/);
    expect(md).toMatch(/lowercase-casual.*question-led.*observational/);
  });

  it('produces a markdown listing every reddit-commenter field', () => {
    const md = describeScenarioSchema('reddit-commenter');
    for (const field of [
      'targetSubreddits',
      'valuePropositions',
      'productUrl',
      'voice.tone',
      'voice.disclosure',
      'systemInstructions',
    ]) {
      expect(md).toContain(field);
    }
  });

  it('output is deterministic (same input → same string)', () => {
    expect(describeScenarioSchema('reddit-scout')).toBe(describeScenarioSchema('reddit-scout'));
  });
});
