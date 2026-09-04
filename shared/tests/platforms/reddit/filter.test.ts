import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_POST_AGE_HOURS,
  filterCandidates,
} from '../../../src/platforms/reddit/filter.js';
import type { ScoutCandidate } from '../../../src/platforms/reddit/types.js';

const NOW = new Date('2026-07-17T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const HOUR_SECONDS = 3600;

// Adapt candidate shape to whatever the ported filter expects.
// If filter expects the full ScoutCandidate, use that; if it expects only { user: { name } },
// use that minimal shape. Read filter.ts first.

describe('filterCandidates', () => {
  // Defaults to a post created exactly at NOW so age-based tests (which override
  // createdUtc explicitly) don't accidentally interact with the handle-filter tests.
  const cand = (name: string, opts: { createdUtc?: number } = {}): ScoutCandidate => ({
    user: { name, karma: 100, createdUtc: 0 },
    post: {
      title: 't',
      selftext: 's',
      permalink: '/r/x/p/1',
      score: 1,
      subreddit: 'x',
      numComments: 0,
      createdUtc: opts.createdUtc ?? NOW_SECONDS,
    },
    profileUrl: `https://www.reddit.com/user/${name}/`,
    composeUrlBase: `https://www.reddit.com/message/compose?to=${name}`,
    matchedBy: 'search',
  });

  it('filters already-contacted handles', () => {
    const out = filterCandidates([cand('alice'), cand('bob')], {
      contactedHandles: new Set(['alice']),
      blockedHandles: new Set(),
      now: NOW,
    });
    expect(out.candidates.map((c) => c.user.name)).toEqual(['bob']);
  });

  it('filters blocklisted handles', () => {
    const out = filterCandidates([cand('alice'), cand('bob')], {
      contactedHandles: new Set(),
      blockedHandles: new Set(['bob']),
      now: NOW,
    });
    expect(out.candidates.map((c) => c.user.name)).toEqual(['alice']);
  });

  describe('recency cap (#338)', () => {
    it('keeps a 3-hour-old post', () => {
      const out = filterCandidates(
        [cand('alice', { createdUtc: NOW_SECONDS - 3 * HOUR_SECONDS })],
        {
          contactedHandles: new Set(),
          blockedHandles: new Set(),
          maxPostAgeHours: 72,
          now: NOW,
        },
      );
      expect(out.candidates.map((c) => c.user.name)).toEqual(['alice']);
      expect(out.droppedByAge).toBe(0);
    });

    it('drops a 21-day-old post (the run 12 case)', () => {
      const out = filterCandidates(
        [cand('alice', { createdUtc: NOW_SECONDS - 21 * 24 * HOUR_SECONDS })],
        { contactedHandles: new Set(), blockedHandles: new Set(), maxPostAgeHours: 72, now: NOW },
      );
      expect(out.candidates).toEqual([]);
      expect(out.droppedByAge).toBe(1);
    });

    it('keeps a post exactly at the boundary', () => {
      const out = filterCandidates(
        [cand('alice', { createdUtc: NOW_SECONDS - 72 * HOUR_SECONDS })],
        {
          contactedHandles: new Set(),
          blockedHandles: new Set(),
          maxPostAgeHours: 72,
          now: NOW,
        },
      );
      expect(out.candidates.map((c) => c.user.name)).toEqual(['alice']);
      expect(out.droppedByAge).toBe(0);
    });

    it('drops a post one second past the boundary', () => {
      const out = filterCandidates(
        [cand('alice', { createdUtc: NOW_SECONDS - 72 * HOUR_SECONDS - 1 })],
        { contactedHandles: new Set(), blockedHandles: new Set(), maxPostAgeHours: 72, now: NOW },
      );
      expect(out.candidates).toEqual([]);
      expect(out.droppedByAge).toBe(1);
    });

    it('falls back to the default cap when maxPostAgeHours is absent from an existing campaign config', () => {
      const withinDefault = cand('alice', {
        createdUtc: NOW_SECONDS - (DEFAULT_MAX_POST_AGE_HOURS - 1) * HOUR_SECONDS,
      });
      const beyondDefault = cand('bob', {
        createdUtc: NOW_SECONDS - (DEFAULT_MAX_POST_AGE_HOURS + 1) * HOUR_SECONDS,
      });
      const out = filterCandidates([withinDefault, beyondDefault], {
        contactedHandles: new Set(),
        blockedHandles: new Set(),
        // maxPostAgeHours deliberately omitted, mirroring a campaign whose
        // config predates this key.
        now: NOW,
      });
      expect(out.candidates.map((c) => c.user.name)).toEqual(['alice']);
      expect(out.droppedByAge).toBe(1);
    });

    it('an explicit null falls back to the default cap, same as absent', () => {
      const out = filterCandidates(
        [cand('alice', { createdUtc: NOW_SECONDS - 21 * 24 * HOUR_SECONDS })],
        {
          contactedHandles: new Set(),
          blockedHandles: new Set(),
          maxPostAgeHours: null,
          now: NOW,
        },
      );
      expect(out.candidates).toEqual([]);
      expect(out.droppedByAge).toBe(1);
    });

    it('an explicit 0 caps immediately, dropping a post from a second ago - it does not mean "no cap"', () => {
      const out = filterCandidates([cand('alice', { createdUtc: NOW_SECONDS - 1 })], {
        contactedHandles: new Set(),
        blockedHandles: new Set(),
        maxPostAgeHours: 0,
        now: NOW,
      });
      expect(out.candidates).toEqual([]);
      expect(out.droppedByAge).toBe(1);
    });
  });
});
