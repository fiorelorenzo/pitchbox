export function parseDraftId(href: string): number | null {
  try {
    const url = new URL(href);
    const raw = url.searchParams.get('pitchbox_draft');
    if (!raw) return null;
    if (!/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Read the backend origin the dashboard tagged the compose URL with
 * (`pitchbox_backend`), normalized to an http(s) origin. Lets a compose tab
 * route its armed/sent calls to the backend the draft belongs to when the
 * user has more than one paired. Returns null when absent or not an http(s)
 * origin.
 */
export function parseBackendUrl(href: string): string | null {
  try {
    const raw = new URL(href).searchParams.get('pitchbox_backend');
    if (!raw) return null;
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}
