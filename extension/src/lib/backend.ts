/**
 * The backend origin the extension talks to. On a fresh install this defaults
 * to the production origin (baked in at build time, overridable via
 * VITE_DEFAULT_BACKEND_URL for a self-hosted or preview build). Users can add
 * further backends at runtime from the side panel; pairings are stored per
 * backend in chrome.storage.local (see storage.ts). See
 * docs/extension-connection-design.md for the full model.
 *
 * Read from a plain `__PITCHBOX_DEFAULT_BACKEND_URL__` define rather than
 * `import.meta.env.VITE_DEFAULT_BACKEND_URL` (2026-09-08, #445). Vite owns
 * `import.meta.env` for any `VITE_`-prefixed name and fills it from `.env`
 * files, not from the process environment, so a `define` under that key was
 * silently ignored: measured on this repo, a build with
 * `VITE_DEFAULT_BACKEND_URL=https://preview.pitchbox.app` produced artifacts
 * carrying `https://pitchbox.app` in every one of them, side panel and
 * content scripts alike. The documented override did nothing, and a preview
 * install only ever reached preview because its pairing named it explicitly.
 */

declare const __PITCHBOX_DEFAULT_BACKEND_URL__: string | undefined;

const RAW_DEFAULT =
  (typeof __PITCHBOX_DEFAULT_BACKEND_URL__ === 'string'
    ? __PITCHBOX_DEFAULT_BACKEND_URL__
    : undefined) || 'https://pitchbox.app';

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
