/**
 * CORS for `/api/extension/*`.
 *
 * These routes are called by the extension's content scripts, which run in
 * the page's origin, so the browser preflights them and the allowlist below
 * is what decides whether the extension can talk to this server at all.
 *
 * It lived inline in hooks.server.ts and held the two Reddit origins only,
 * which is how the entire LinkedIn in-page surface shipped dead (#379): from
 * a real linkedin.com page every call failed with "Response to preflight
 * request doesn't pass access control check". Nothing caught it because the
 * server answers a request with no `Origin` (curl, the dashboard's own
 * fetches) exactly as before, and under `vite dev` the page origin is
 * localhost. It is its own module now so a test can assert the allowlist
 * without importing hooks.server.ts, whose module body reaps orphaned runs
 * against the database.
 *
 * A page origin the extension does not inject into has no business here, so
 * the answer for anything else is the literal `null` origin rather than a
 * wildcard: `access-control-allow-origin: *` would let any site on the
 * internet spend a stolen device token from a victim's browser.
 */
export const EXTENSION_ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
  'https://www.reddit.com',
  'https://old.reddit.com',
  'https://www.linkedin.com',
]);

export function extensionCorsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && EXTENSION_ALLOWED_ORIGINS.has(origin) ? origin : 'null';
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}
