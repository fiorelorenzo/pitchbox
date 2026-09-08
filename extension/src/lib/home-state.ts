import { pairingHealth, overallHealth, type Pairing } from './storage.js';

/**
 * The one line at the top of home, derived rather than composed in markup
 * (#399/#400). Keeping it here means the state can be tested without a DOM,
 * and means the panel cannot invent a state the data does not support - the
 * bug class this surface replaces was four cards each holding a third of the
 * answer and none of them wrong on its own.
 *
 * D21 in docs/design/DECISIONS.md is the rule this implements: one worst-of
 * indicator, and directly under it the line naming what set it. So `detail`
 * is never optional when `tone` is anything but `ok`.
 */
export type HomeTone = 'ok' | 'pending' | 'warn' | 'error' | 'idle';

export type HomeState = {
  tone: HomeTone;
  /** i18n key for the state line itself, in the product's own words. */
  key: string;
  /** i18n key naming what set that state, or null when there is nothing to name. */
  detailKey: string | null;
  detailParams?: Record<string, string | number>;
};

export type HomeInput = {
  pairings: Pairing[];
  /** Read back from `chrome.permissions`, never from our record of asking (D22). */
  linkedInGranted: boolean;
  /**
   * #401: set by the background worker when Chrome drops a permission we
   * previously held. A revoke the operator made themselves and a revoke that
   * happened behind their back read the same to us, so both surface.
   */
  linkedInRevokedAt?: string;
};

/**
 * The worst channel across every pairing, named, so the state line's detail
 * can say which one. `legacy` wins a tie because it is the channel that
 * carries direct messages, which is the one the operator is waiting on.
 */
function failingChannel(pairings: Pairing[]): 'chat' | 'legacy' | null {
  for (const p of pairings) {
    const s = p.syncStatus;
    if (!s) continue;
    if (s.legacy === 'error' || s.legacy === 'unauthorized') return 'legacy';
    if (s.chat === 'error' || s.chat === 'unauthorized') return 'chat';
  }
  return null;
}

export function homeState(input: HomeInput, now: number = Date.now()): HomeState {
  const { pairings, linkedInGranted, linkedInRevokedAt } = input;

  // Nothing paired is not a fault: it is the first run, and #247 settled that
  // it offers exactly one working control. So it gets its own tone rather
  // than borrowing the red one.
  if (pairings.length === 0) {
    return { tone: 'idle', key: 'home.state.not-paired', detailKey: 'home.state.not-paired-hint' };
  }

  // A permission Chrome dropped outranks sync health: with it off, the
  // in-page assistant is not running at all, which is the thing the operator
  // came to this panel to check.
  if (linkedInRevokedAt && !linkedInGranted) {
    return {
      tone: 'error',
      key: 'home.state.access-revoked',
      detailKey: 'home.state.access-revoked-detail',
    };
  }

  const worst = overallHealth(pairings, now);
  // The pairing that set the overall health, so the detail line can name it.
  const p = pairings.find((each) => pairingHealth(each, now) === worst);
  let host = p?.backendUrl ?? '';
  try {
    host = new URL(host).host;
  } catch {
    // Keep the raw string: a malformed backendUrl is still more useful in
    // the detail line than an empty one.
  }

  if (worst === 'error' || worst === 'warn') {
    const channel = failingChannel(pairings);
    if (channel) {
      return {
        tone: worst,
        key: worst === 'error' ? 'home.state.sync-error' : 'home.state.degraded',
        detailKey: channel === 'chat' ? 'home.state.channel-chat' : 'home.state.channel-legacy',
        detailParams: { host },
      };
    }
    // No channel is broken, so what set this is the snapshot's age: the
    // background worker has not reported in (#178's dead-worker case).
    return {
      tone: worst,
      key: 'home.state.degraded',
      detailKey: 'home.state.stale',
      detailParams: { host },
    };
  }

  if (worst === 'pending') {
    // #383: paired a moment ago, first sync still due. Nothing has gone
    // wrong, and saying "needs attention" here is the bug.
    return {
      tone: 'pending',
      key: 'home.state.pending',
      detailKey: 'home.state.pending-detail',
      detailParams: { host },
    };
  }

  // Everything the operator can see is working. The line still has to say on
  // what, since "ready" without "on LinkedIn" is not an answer.
  return {
    tone: 'ok',
    key: linkedInGranted ? 'home.state.ready-linkedin' : 'home.state.ready',
    detailKey: linkedInGranted ? null : 'home.state.linkedin-off',
  };
}
