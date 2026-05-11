import { describe, expect, it } from 'vitest';
import { RecommendationItemSchema } from '../../src/campaigns/recommendation-schemas';

const VALID = {
  scenarioSlug: 'reddit-scout' as const,
  name: 'Reddit RPG launch',
  objective:
    'Find tabletop RPG players curious about AI Game Masters and invite them to the alpha.',
};

describe('RecommendationItemSchema', () => {
  it('accepts a complete valid item', () => {
    expect(RecommendationItemSchema.parse(VALID)).toEqual(VALID);
  });

  it('accepts the commenter scenario', () => {
    expect(
      RecommendationItemSchema.parse({ ...VALID, scenarioSlug: 'reddit-commenter' }),
    ).toMatchObject({ scenarioSlug: 'reddit-commenter' });
  });

  it('rejects an unknown scenarioSlug', () => {
    expect(() =>
      RecommendationItemSchema.parse({ ...VALID, scenarioSlug: 'twitter' }),
    ).toThrow();
  });

  it('rejects an empty name', () => {
    expect(() => RecommendationItemSchema.parse({ ...VALID, name: '' })).toThrow();
  });

  it('rejects an empty objective', () => {
    expect(() => RecommendationItemSchema.parse({ ...VALID, objective: '' })).toThrow();
  });

  it('rejects an extra unknown field (strict)', () => {
    expect(() =>
      RecommendationItemSchema.parse({ ...VALID, surprise: 'no' } as unknown),
    ).toThrow();
  });

  it('rejects an objective longer than 2000 chars', () => {
    expect(() =>
      RecommendationItemSchema.parse({ ...VALID, objective: 'x'.repeat(2001) }),
    ).toThrow();
  });
});
