import { describe, expect, it } from 'vitest';
import { homeState } from '../../src/lib/home-state.js';
import type { Pairing } from '../../src/lib/storage.js';
import { translate } from '../../src/lib/i18n/index.js';

const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function pairing(over: Partial<Pairing> = {}): Pairing {
  return {
    backendUrl: 'https://preview.pitchbox.app',
    token: 't',
    lastHandshakeAt: iso(60_000),
    syncStatus: { chat: 'ok', legacy: 'ok', capturedAt: iso(60_000) },
    ...over,
  };
}

// The state line is the whole surface's claim (#399/#400): one aggregate, and
// under it the thing that set it. These assert the pair, since an aggregate
// with the wrong detail is exactly the failure the four cards had.
describe('homeState', () => {
  it('calls a first run its own state rather than a fault', () => {
    const s = homeState({ pairings: [], linkedInGranted: false }, NOW);
    expect(s.tone).toBe('idle');
    expect(s.key).toBe('home.state.not-paired');
  });

  it('says what it is ready on, not just that it is ready', () => {
    expect(homeState({ pairings: [pairing()], linkedInGranted: true }, NOW)).toMatchObject({
      tone: 'ok',
      key: 'home.state.ready-linkedin',
    });
    // Access off is not an error - nothing is broken - but "Ready" alone
    // would be a lie about where it is ready.
    expect(homeState({ pairings: [pairing()], linkedInGranted: false }, NOW)).toMatchObject({
      tone: 'ok',
      key: 'home.state.ready',
      detailKey: 'home.state.linkedin-off',
    });
  });

  it('a pairing whose first sync is still due is pending, not degraded (#383)', () => {
    const fresh = pairing({ syncStatus: undefined, lastHandshakeAt: iso(30_000) });
    const s = homeState({ pairings: [fresh], linkedInGranted: true }, NOW);
    expect(s.tone).toBe('pending');
    expect(s.key).toBe('home.state.pending');
    // Past the longest poller interval the first sync should have happened,
    // and then it is a real warning.
    const overdue = pairing({ syncStatus: undefined, lastHandshakeAt: iso(31 * 60_000) });
    expect(homeState({ pairings: [overdue], linkedInGranted: true }, NOW).tone).toBe('warn');
  });

  it('names the channel that set a degraded state, with its host', () => {
    const broken = pairing({
      syncStatus: { chat: 'unauthorized', legacy: 'ok', capturedAt: iso(60_000) },
    });
    const s = homeState({ pairings: [broken], linkedInGranted: true }, NOW);
    expect(s.detailKey).toBe('home.state.channel-chat');
    expect(translate('en', s.detailKey!, s.detailParams)).toContain('preview.pitchbox.app');
  });

  it('names the stale snapshot when no channel is broken', () => {
    const stale = pairing({
      syncStatus: { chat: 'ok', legacy: 'ok', capturedAt: iso(90 * 60_000) },
    });
    expect(homeState({ pairings: [stale], linkedInGranted: true }, NOW)).toMatchObject({
      tone: 'warn',
      detailKey: 'home.state.stale',
    });
  });

  it('a permission Chrome removed outranks sync health (#401)', () => {
    const ok = pairing();
    const s = homeState(
      { pairings: [ok], linkedInGranted: false, linkedInRevokedAt: iso(1000) },
      NOW,
    );
    expect(s.tone).toBe('error');
    expect(s.key).toBe('home.state.access-revoked');
    // And it clears the moment the permission is back, without waiting for
    // the worker to rewrite storage.
    expect(
      homeState({ pairings: [ok], linkedInGranted: true, linkedInRevokedAt: iso(1000) }, NOW).tone,
    ).toBe('ok');
  });

  it('never leaves a non-ok state without naming what set it (D21)', () => {
    const cases = [
      { pairings: [], linkedInGranted: false },
      { pairings: [pairing({ syncStatus: undefined })], linkedInGranted: true },
      {
        pairings: [
          pairing({ syncStatus: { chat: 'ok', legacy: 'error', capturedAt: iso(60_000) } }),
        ],
        linkedInGranted: true,
      },
      { pairings: [pairing()], linkedInGranted: false, linkedInRevokedAt: iso(1000) },
    ];
    for (const input of cases) {
      const s = homeState(input, NOW);
      if (s.tone === 'ok') continue;
      expect(s.detailKey, `${s.tone} left its detail unnamed`).toBeTruthy();
      // Both dictionaries have to be able to say it, or the panel renders a
      // raw key at the one moment the operator needs a sentence.
      for (const loc of ['en', 'it'] as const) {
        expect(translate(loc, s.key)).not.toBe(s.key);
        expect(translate(loc, s.detailKey!, s.detailParams)).not.toBe(s.detailKey);
      }
    }
  });
});
