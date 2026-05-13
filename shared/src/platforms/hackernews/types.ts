/**
 * Normalized Hacker News types. Mirrors the shape returned by the Firebase
 * HN API (https://github.com/HackerNews/API) but exposes only the fields
 * Pitchbox actually consumes.
 */
export type HnListing = 'top' | 'new' | 'best' | 'ask' | 'show';

export type HnItem = {
  id: number;
  /** "story" | "comment" | "job" | "poll" | "pollopt" — we only normalize stories. */
  type: string;
  by: string;
  time: number;
  title: string;
  /** Optional self-post body (HTML on HN; we keep it as-is). */
  text: string | null;
  /** External link if the story is a link-post. */
  url: string | null;
  score: number;
  descendants: number;
  /** Pre-built URL to the HN discussion page. */
  itemUrl: string;
  /** Pre-built URL to open the reply composer on HN. */
  composeUrl: string;
};

export interface HnSearchOptions {
  listing?: HnListing;
  /** Case-insensitive substring filter on title/text. */
  query?: string;
  /** Max number of items to fetch and return. */
  limit?: number;
}
