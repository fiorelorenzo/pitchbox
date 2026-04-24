import { describe, expect, it } from 'vitest';
import { filterCandidates } from '../../../src/platforms/reddit/filter.js';

// Adapt candidate shape to whatever the ported filter expects.
// If filter expects the full ScoutCandidate, use that; if it expects only { user: { name } },
// use that minimal shape. Read filter.ts first.

describe('filterCandidates', () => {
  const cand = (name: string): any => ({
    user: { name, karma: 100, createdUtc: 0 },
    post: {
      title: 't',
      selftext: 's',
      permalink: '/r/x/p/1',
      score: 1,
      subreddit: 'x',
      numComments: 0,
      createdUtc: 0,
    },
    profileUrl: `https://www.reddit.com/user/${name}/`,
    composeUrlBase: `https://www.reddit.com/message/compose?to=${name}`,
    matchedBy: 'search',
  });

  it('filters already-contacted handles', () => {
    const out = filterCandidates([cand('alice'), cand('bob')], {
      contactedHandles: new Set(['alice']),
      blockedHandles: new Set(),
    } as any);
    expect(out.map((c: any) => c.user.name)).toEqual(['bob']);
  });

  it('filters blocklisted handles', () => {
    const out = filterCandidates([cand('alice'), cand('bob')], {
      contactedHandles: new Set(),
      blockedHandles: new Set(['bob']),
    } as any);
    expect(out.map((c: any) => c.user.name)).toEqual(['alice']);
  });
});
