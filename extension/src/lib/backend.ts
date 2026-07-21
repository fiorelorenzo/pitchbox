/**
 * The backend origin the extension talks to. On a fresh install this defaults
 * to the production origin (baked in at build time, overridable via
 * VITE_DEFAULT_BACKEND_URL for a self-hosted or preview build). Users can add
 * further backends at runtime from the side panel; pairings are stored per
 * backend in chrome.storage.local (see storage.ts). See
 * docs/extension-connection-design.md for the full model.
 */

const RAW_DEFAULT =
  (import.meta.env.VITE_DEFAULT_BACKEND_URL as string | undefined) || 'https://pitchbox.app';

/** The build-time default backend origin, normalized (no trailing slash). */
export const DEFAULT_BACKEND_URL: string =
  normalizeBackendUrl(RAW_DEFAULT) ?? 'https://pitchbox.app';

/**
 * Validate and normalize a user-entered backend URL: require an http(s)
 * origin, strip any path/query/hash and the trailing slash, and lowercase the
 * host. Returns null when the input is not a usable http(s) URL.
 */
export function normalizeBackendUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  // A `scheme:` without `//` (e.g. `javascript:...`, `data:...`) is never a
  // backend origin - reject rather than coerce it into an https host.
  if (!hasScheme && /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  // Allow the user to omit the scheme; assume https for a bare host.
  const withScheme = hasScheme ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.hostname) return null;
  return `${url.protocol}//${url.host}`;
}
