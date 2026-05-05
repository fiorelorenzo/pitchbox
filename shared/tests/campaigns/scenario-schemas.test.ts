import { describe, expect, it } from 'vitest';
import { getSchema } from '../../src/campaigns/scenario-schemas';

describe('reddit-scout schema', () => {
  const schema = getSchema('reddit-scout');
  const valid = {
    targetSubreddits: ['rpg'],
    topicKeywords: ['ai dm'],
    avoidKeywords: ['spam'],
    fitScoreThreshold: 3,
    voice: {
      tone: 'casual' as const,
      hardBans: ['—'],
      dos: ['use lowercase opener'],
      openerStyle: 'lowercase-casual' as const,
      disclosure: 'i build this',
    },
    offer: {
      productUrl: 'https://example.com',
      subject: 'founding player invite',
      text: 'short pitch',
    },
    systemInstructions: 'no jargon, casual tone',
  };

  it('accepts a complete valid object', () => {
    expect(schema.parse(valid)).toEqual(valid);
  });

  it('rejects missing required field', () => {
    const rest = { ...valid } as Partial<typeof valid>;
    delete rest.targetSubreddits;
    expect(() => schema.parse(rest)).toThrow();
  });

  it('rejects empty targetSubreddits array', () => {
    expect(() => schema.parse({ ...valid, targetSubreddits: [] })).toThrow();
  });

  it('rejects fitScoreThreshold out of range', () => {
    expect(() => schema.parse({ ...valid, fitScoreThreshold: 6 })).toThrow();
  });

  it('rejects extra unknown fields (strict)', () => {
    expect(() => schema.parse({ ...valid, surprise: 'oops' })).toThrow();
  });
});

describe('reddit-commenter schema', () => {
  const schema = getSchema('reddit-commenter');
  const valid = {
    targetSubreddits: ['rpg'],
    topicKeywords: ['homebrew'],
    avoidKeywords: [],
    voice: {
      tone: 'neutral' as const,
      hardBans: [],
      dos: [],
      disclosure: 'creator here',
    },
    valuePropositions: ['quick session prep'],
    productUrl: 'https://example.com',
    systemInstructions: 'be helpful first',
  };

  it('accepts a complete valid object', () => {
    expect(schema.parse(valid)).toEqual(valid);
  });

  it('rejects invalid productUrl', () => {
    expect(() => schema.parse({ ...valid, productUrl: 'not-a-url' })).toThrow();
  });
});
