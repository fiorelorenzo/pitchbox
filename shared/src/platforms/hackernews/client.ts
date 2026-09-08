import type { HnItem, HnListing } from './types.js';

const API_BASE = 'https://hacker-news.firebaseio.com/v0';
const SITE_BASE = 'https://news.ycombinator.com';

const LISTING_ENDPOINTS: Record<HnListing, string> = {
  top: 'topstories',
  new: 'newstories',
  best: 'beststories',
  ask: 'askstories',
  show: 'showstories',
};

export type RawHnItem = {
  id: number;
  type?: string;
  by?: string;
  time?: number;
  title?: string;
  text?: string;
  url?: string;
  score?: number;
  descendants?: number;
  deleted?: boolean;
  dead?: boolean;
};

export type Fetcher = (url: string) => Promise<unknown>;

const defaultFetcher: Fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HN API ${res.status} for ${url}`);
  return res.json();
};

/** Normalize a raw HN item into the Pitchbox-facing shape. */
export function normalizeItem(raw: RawHnItem): HnItem | null {
  if (!raw || raw.deleted || raw.dead) return null;
  const type = raw.type ?? 'story';
  // Only stories are useful targets for comment outreach.
  if (type !== 'story' && type !== 'job') return null;
  const id = raw.id;
  return {
    id,
    type,
    by: raw.by ?? '',
    time: raw.time ?? 0,
    title: raw.title ?? '',
    text: raw.text ?? null,
    url: raw.url ?? null,
    score: raw.score ?? 0,
    descendants: raw.descendants ?? 0,
    itemUrl: `${SITE_BASE}/item?id=${id}`,
    composeUrl: `${SITE_BASE}/reply?id=${id}`,
  };
}

/**
 * Fetch a listing (top/new/best/ask/show) and hydrate each item via the
 * Firebase HN API. Pure-ish: the network layer is injected so tests can
 * substitute a fixture-driven fetcher.
 */
export async function fetchListings(
  options: { listing?: HnListing; limit?: number; query?: string } = {},
  fetcher: Fetcher = defaultFetcher,
): Promise<HnItem[]> {
  const listing = options.listing ?? 'top';
  const limit = Math.max(1, Math.min(options.limit ?? 30, 100));
  const ids = (await fetcher(`${API_BASE}/${LISTING_ENDPOINTS[listing]}.json`)) as number[];
  if (!Array.isArray(ids)) return [];
  const slice = ids.slice(0, limit);
  const raws = await Promise.all(
    slice.map((id) => fetcher(`${API_BASE}/item/${id}.json`) as Promise<RawHnItem>),
  );
  const items: HnItem[] = [];
  for (const raw of raws) {
    const norm = normalizeItem(raw);
    if (norm) items.push(norm);
  }
  if (!options.query) return items;
  const q = options.query.toLowerCase();
  return items.filter(
    (i) => i.title.toLowerCase().includes(q) || (i.text ?? '').toLowerCase().includes(q),
  );
}

export function itemUrl(id: number): string {
  return `${SITE_BASE}/item?id=${id}`;
}

export function replyUrl(id: number): string {
  return `${SITE_BASE}/reply?id=${id}`;
}

export function submitUrl(): string {
  return `${SITE_BASE}/submit`;
}

export function profileUrl(username: string): string {
  return `${SITE_BASE}/user?id=${encodeURIComponent(username)}`;
}

/** Candidate ids hydrated (via `${API_BASE}/item/:id.json`) before giving up
 * on finding `limit` real stories/jobs - HN's own `submitted` list on a user
 * mixes comments in with stories, so this over-fetches a small, fixed
 * window rather than the whole submission history. */
export const HN_AUTHOR_CANDIDATE_CAP = 30;

/** Default (and max) number of a user's own submissions a source keeps. */
export const HN_AUTHOR_MAX_ITEMS = 10;

export type RawHnUser = {
  id?: string;
  /** Item ids this user has posted (stories, comments, ...), not guaranteed
   * sorted by the HN API. */
  submitted?: number[];
};

/**
 * Fetches a user's most recent story/job submissions. Reuses the exact same
 * per-item hydration `fetchListings` already does
 * (`${API_BASE}/item/:id.json` + `normalizeItem`), just seeded from
 * `${API_BASE}/user/:username.json`'s `submitted` list instead of a listing
 * endpoint - no second HTTP client, no scraping, no credential. `submitted`
 * ids are sorted descending before hydrating (HN ids are monotonically
 * increasing, so a higher id is a later post) since the API gives no
 * ordering guarantee. Returns an empty list for an unknown username (the
 * API answers `null`) rather than throwing.
 */
export async function fetchUserSubmissions(
  username: string,
  options: { limit?: number } = {},
  fetcher: Fetcher = defaultFetcher,
): Promise<HnItem[]> {
  const limit = Math.max(1, Math.min(options.limit ?? HN_AUTHOR_MAX_ITEMS, HN_AUTHOR_MAX_ITEMS));
  const user = (await fetcher(
    `${API_BASE}/user/${encodeURIComponent(username)}.json`,
  )) as RawHnUser | null;
  if (!user || !Array.isArray(user.submitted) || user.submitted.length === 0) return [];

  const candidates = [...user.submitted].sort((a, b) => b - a).slice(0, HN_AUTHOR_CANDIDATE_CAP);
  const raws = await Promise.all(
    candidates.map((id) => fetcher(`${API_BASE}/item/${id}.json`) as Promise<RawHnItem>),
  );
  const items: HnItem[] = [];
  for (const raw of raws) {
    const norm = normalizeItem(raw);
    if (norm) items.push(norm);
    if (items.length >= limit) break;
  }
  return items;
}
