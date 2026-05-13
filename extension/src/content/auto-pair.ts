import { logFromContent } from '../lib/log-from-content.js';

/**
 * Auto-pair content script.
 *
 * Runs on any origin the user has granted host permission for. Detects a
 * Pitchbox dashboard via the `<meta name="pitchbox-pair">` beacon (set in
 * web/src/app.html) and pairs the extension by calling the dashboard's
 * `/api/extension/auto-pair` endpoint. The fetch carries the user's session
 * cookie because we run inside the page origin, so the server can mint a
 * device token tied to the right org without any user input.
 *
 * Idempotent: if the extension already has a token for this origin we skip.
 * The popup's "Pair with this tab" flow injects this same script on demand,
 * so the auto and manual paths converge here.
 */
(async () => {
  const beacon = document.querySelector('meta[name="pitchbox-pair"]');
  if (!beacon) return;

  const backendUrl = `${location.protocol}//${location.host}`;

  // Skip when already paired with the current backend, to avoid burning a new
  // device token on every page load.
  const existing = await chrome.storage.local.get(['backendUrl', 'token']);
  if (existing.token && existing.backendUrl === backendUrl) return;

  let res: Response;
  try {
    res = await fetch(`${backendUrl}/api/extension/auto-pair`, {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    console.warn('[pitchbox] auto-pair fetch failed', err);
    return;
  }
  if (!res.ok) {
    if (res.status === 401) {
      // User isn't signed in yet — quietly skip, we'll retry on next reload.
      return;
    }
    console.warn('[pitchbox] auto-pair non-200', res.status);
    return;
  }

  let body: { token?: string };
  try {
    body = (await res.json()) as { token?: string };
  } catch {
    return;
  }
  if (!body.token) return;

  chrome.runtime.sendMessage(
    { type: 'pitchbox:auto-pair', backendUrl, token: body.token },
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
      } else console.warn('[pitchbox] auto-pair save failed', ack);
    },
  );
})();
