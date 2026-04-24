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
