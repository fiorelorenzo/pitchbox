import { getSettings, type Pairing } from '../lib/storage.js';
import { logFromContent } from '../lib/log-from-content.js';
import type { AutoPairOutcome } from '../lib/auto-pair-outcome.js';

/**
 * Auto-pair content script.
 *
 * Runs on any origin the user has granted host permission for. Detects a
 * Pitchbox dashboard via the `<meta name="pitchbox-pair">` beacon (set in
 * web/src/app.html) and pairs the extension by calling the dashboard's
 * `/api/extension/auto-pair` endpoint. The fetch carries the user's session
 * cookie because we run inside the page origin, so the server can mint a
 * device token tied to the right org without any user input.
 * Idempotent: if the extension already has a pairing for this backend we
 * skip. The popup's "Pair with this tab" flow injects this same script on
 * demand, so the auto and manual paths converge here.
 *
 * Every terminal branch reports an `AutoPairOutcome` over the
 * `pitchbox:auto-pair-outcome` runtime message (see reportOutcome below).
 * The passive page-load run has nobody listening for it; the manual
 * "Pair with this tab" flow in ConnectionCard.svelte is the one that cares,
 * so it can surface a specific, actionable message instead of leaving the
 * click looking like it did nothing.
 */

/** Fire-and-forget report of this run's outcome to any listening UI. */
function reportOutcome(backendUrl: string, outcome: AutoPairOutcome): void {
  try {
    chrome.runtime.sendMessage({ type: 'pitchbox:auto-pair-outcome', backendUrl, outcome });
  } catch {
    // Worker may be sleeping or the extension context invalidated; drop silently.
  }
}

/** True when `pairings` already has an entry for `backendUrl`. */
export function isAlreadyPaired(pairings: Pairing[], backendUrl: string): boolean {
  return pairings.some((p) => p.backendUrl === backendUrl);
}

export async function runAutoPair(): Promise<void> {
  const backendUrl = `${location.protocol}//${location.host}`;

  const beacon = document.querySelector('meta[name="pitchbox-pair"]');
  if (!beacon) {
    reportOutcome(backendUrl, { kind: 'no-dashboard' });
    return;
  }

  // Skip when already paired with the current backend, to avoid burning a new
  // device token on every page load. Reads the live `pairings` array via
  // getSettings() rather than the legacy single-backend keys - storage.ts
  // migrates and deletes those on first read, so checking them directly
  // would only work once and then re-pair on every subsequent load.
  const { pairings } = await getSettings();
  if (isAlreadyPaired(pairings, backendUrl)) {
    reportOutcome(backendUrl, { kind: 'already-paired' });
    return;
  }

  let res: Response;
  try {
    // #195: POST, not GET - this mints a device token as a side effect, and
    // must not be reachable as a "safe" cross-site GET that rides an ambient
    // session cookie.
    res = await fetch(`${backendUrl}/api/extension/auto-pair`, {
      method: 'POST',
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    console.warn('[pitchbox] auto-pair fetch failed', err);
    reportOutcome(backendUrl, { kind: 'network-error' });
    return;
  }
  if (!res.ok) {
    if (res.status === 401) {
      // User isn't signed in yet - the passive page-load run just retries on
      // the next reload; the manual "Pair with this tab" flow surfaces this
      // to the user via the outcome report below.
      console.warn('[pitchbox] auto-pair: not signed in');
      reportOutcome(backendUrl, { kind: 'unauthorized' });
      return;
    }
    console.warn('[pitchbox] auto-pair non-200', res.status);
    reportOutcome(backendUrl, { kind: 'server-error', httpStatus: res.status });
    return;
  }

  let body: { token?: string; orgName?: string; deviceLabel?: string };
  try {
    body = (await res.json()) as { token?: string; orgName?: string; deviceLabel?: string };
  } catch {
    reportOutcome(backendUrl, { kind: 'server-error' });
    return;
  }
  if (!body.token) {
    reportOutcome(backendUrl, { kind: 'server-error' });
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: 'pitchbox:auto-pair',
      backendUrl,
      token: body.token,
      orgName: body.orgName,
      deviceLabel: body.deviceLabel,
    },
    (ack) => {
      if (ack?.ok) {
        console.log('[pitchbox] paired with', backendUrl);
        logFromContent({
          level: 'info',
          source: 'pairing',
          message: 'activity.pairing.added',
          messageParams: { host: location.host },
          backendUrl: location.origin,
        });
        reportOutcome(backendUrl, { kind: 'paired' });
      } else {
        console.warn('[pitchbox] auto-pair save failed', ack);
        reportOutcome(backendUrl, { kind: 'server-error' });
      }
    },
  );
}

void runAutoPair();
