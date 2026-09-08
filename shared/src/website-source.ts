// A website whose text is kept and refreshed on demand (#433). This is the
// second `project_sources` kind after `github` (shared/src/github-sources.ts),
// and it follows that module's shape rather than inventing a second one: a
// fetch failure is recorded on the source's own `fetch_error` and never
// thrown, so a project with three sources and one dead link still reads -
// only that one row goes stale.
//
// The only fetching primitives that existed in this repo before this file
// were the Reddit Playwright scraper and the HN Algolia client
// (shared/src/platforms/), neither of which fits an arbitrary marketing/docs
// URL: Reddit's stack drags a real Chromium for a page that needs none, and
// HN's client only ever talks to a fixed JSON API. This crawl instead does a
// plain `fetch` plus `html-to-text`.
//
// Dependency choice: `html-to-text` vs `@mozilla/readability` (+ `jsdom`) vs
// hand-rolled `cheerio` extraction, compared on 2026-09-08.
// - `@mozilla/readability` needs a live DOM (jsdom under Node), and jsdom is
//   a full HTML/CSS/layout engine - installing one to read text off a page
//   we already have as a string is the "drags in a browser" case this issue
//   calls out to avoid, for a algorithm tuned to isolate one article from
//   chrome, which is narrower than "whatever text is on the page" (a docs
//   sidebar is exactly the kind of content Readability is designed to
//   discard).
// - `cheerio` gives a jQuery-like DOM but not text extraction: this module
//   would still have to hand-write block/inline handling, whitespace
//   collapsing and list/heading formatting, which is the actual work
//   `html-to-text` already does.
// - `html-to-text` (10.0.1) is a parser (`htmlparser2`) plus a handful of
//   pure-JS selector/formatting packages (`selderee`, `parseley`,
//   `deepmerge-ts`) - five packages total, none of them a DOM or a browser,
//   actively maintained (published within the month at the time of this
//   change), and it already skips `<script>`/`<style>` and renders
//   headings/paragraphs/lists as readable text out of the box. That is the
//   one installed here.
import { schema, type Db } from './db/client.js';
import { eq } from 'drizzle-orm';
import { convert } from 'html-to-text';
import { createProjectSource, type ProjectSourceRow } from './project-sources.js';

/** Identifies this crawler to a `robots.txt`. A distinct name (rather than
 * reusing a browser UA) is what lets a site operator distinguish "Pitchbox
 * fetched this on a project's behalf" from ordinary traffic and write a
 * `User-agent: PitchboxBot` group if they want to treat it differently from
 * `*`. */
export const WEBSITE_USER_AGENT = 'PitchboxBot/1.0 (+https://pitchbox.app)';

/** Per-request budget. A page that never responds (a hung TCP connection, a
 * host behind a black-holed firewall) would otherwise stall a run
 * indefinitely - this runs inside a request handler on a shared deployment,
 * so every fetch this module makes carries one. */
export const WEBSITE_FETCH_TIMEOUT_MS = 8_000;

/** Per-page byte cap, enforced while streaming the response body rather than
 * after buffering it whole - a page that serves gigabytes never gets fully
 * read into memory in the first place. */
export const WEBSITE_MAX_BYTES_PER_PAGE = 2 * 1024 * 1024;

/** One page by default, or up to this many when `crawlLinks` is set (the
 * root page plus same-host links found on it). "A small cap" per the issue -
 * enough to pick up a docs site's landing page and a couple of its children
 * without turning one source into an open-ended crawl. */
export const WEBSITE_MAX_PAGES = 5;

/** Clamp on the combined extracted text actually stored on the source row -
 * this feeds a prompt (like `README_EXCERPT_MAX_CHARS` in
 * `github-sources.ts`), not an archive of the site. */
export const WEBSITE_MAX_TEXT_CHARS = 20_000;

/** What this module needs from `fetch`: a string URL, an abort signal, and a
 * `Response` whose body can be streamed. Narrower than `typeof fetch` for the
 * same reason `GithubFetch` is in `github-sources.ts` - a test double only
 * has to satisfy this shape. */
export type WebsiteFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface RobotsRules {
  isAllowed(pathname: string): boolean;
}

const ALLOW_ALL: RobotsRules = { isAllowed: () => true };

/**
 * A minimal `robots.txt` parser: groups by `User-agent`, `Disallow`/`Allow`
 * rules within a group, longest-matching-path-prefix wins (the standard
 * tie-break - RFC 9309 §2.2.2). No wildcard/`$`-anchor support, since the
 * issue's bar is "a disallow is honoured" against a real fixture, not a
 * conformance suite - a real docs/marketing site's `robots.txt` is
 * overwhelmingly plain path prefixes.
 */
export function parseRobotsTxt(text: string, userAgent: string): RobotsRules {
  type Rule = { path: string; allow: boolean };
  type Group = { agents: string[]; rules: Rule[] };
  const groups: Group[] = [];
  let current: Group | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]!.trim();
    if (!line) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === 'user-agent') {
      // Consecutive User-agent lines (before any rule) belong to the same
      // group and share whatever Allow/Disallow rules follow.
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (field === 'disallow' && current) {
      if (value !== '') current.rules.push({ path: value, allow: false });
    } else if (field === 'allow' && current) {
      if (value !== '') current.rules.push({ path: value, allow: true });
    }
  }

  const lowerAgent = userAgent.toLowerCase();
  const group =
    groups.find((g) => g.agents.some((a) => lowerAgent.includes(a) || a.includes(lowerAgent))) ??
    groups.find((g) => g.agents.includes('*'));
  const rules = group?.rules ?? [];
  if (rules.length === 0) return ALLOW_ALL;

  return {
    isAllowed(pathname: string): boolean {
      let best: Rule | null = null;
      for (const rule of rules) {
        if (pathname.startsWith(rule.path) && (!best || rule.path.length > best.path.length)) {
          best = rule;
        }
      }
      return best ? best.allow : true;
    },
  };
}

/** Fetches and parses `${origin}/robots.txt`. Any failure (network error,
 * timeout, non-2xx, no file at all) is treated as "allow everything" - a
 * missing or broken robots.txt is not a reason to refuse a page a browser
 * would happily load. */
export async function fetchRobotsTxt(
  origin: string,
  fetchImpl: WebsiteFetch,
  timeoutMs: number,
  userAgent: string,
): Promise<RobotsRules> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${origin}/robots.txt`, { signal: controller.signal });
    if (!res.ok) return ALLOW_ALL;
    const text = await res.text();
    return parseRobotsTxt(text, userAgent);
  } catch {
    return ALLOW_ALL;
  } finally {
    clearTimeout(timer);
  }
}

type CappedFetchResult =
  { ok: true; body: string; bytes: number; truncated: boolean } | { ok: false; reason: string };

/**
 * Fetches one URL with a timeout and a byte cap enforced while streaming -
 * the cap is checked chunk-by-chunk against the response body's reader, so a
 * page that serves an unbounded/huge stream is cut off and read as its first
 * `maxBytes`, never buffered whole first.
 */
async function fetchCapped(
  url: string,
  fetchImpl: WebsiteFetch,
  opts: { maxBytes: number; timeoutMs: number },
): Promise<CappedFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, { signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted)
        return { ok: false, reason: `timed out after ${opts.timeoutMs}ms` };
      return { ok: false, reason: `network error: ${(err as Error).message}` };
    }
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType && !/text\/html|text\/plain|application\/xhtml/.test(contentType)) {
      return { ok: false, reason: `unsupported content-type: ${contentType}` };
    }

    if (!res.body) {
      const text = await res.text();
      const bytes = Buffer.byteLength(text, 'utf8');
      const truncated = bytes > opts.maxBytes;
      return {
        ok: true,
        body: truncated
          ? Buffer.from(text, 'utf8').subarray(0, opts.maxBytes).toString('utf8')
          : text,
        bytes: truncated ? opts.maxBytes : bytes,
        truncated,
      };
    }

    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = opts.maxBytes - total;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      if (chunk.byteLength < value.byteLength) truncated = true;
      chunks.push(Buffer.from(chunk));
      total += chunk.byteLength;
      if (total >= opts.maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    return { ok: true, body: Buffer.concat(chunks).toString('utf8'), bytes: total, truncated };
  } catch (err) {
    if (controller.signal.aborted)
      return { ok: false, reason: `timed out after ${opts.timeoutMs}ms` };
    return { ok: false, reason: `network error: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Renders HTML to readable plain text: headings, paragraphs and lists kept
 * as text, script/style/images dropped, link targets dropped (the anchor
 * text alone reads better in a prompt than `text [https://...]` repeated for
 * every nav item). */
export function extractPageText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
    ],
  }).trim();
}

/** Same-host `<a href>` targets on a page, resolved against `baseUrl`,
 * deduplicated, `baseUrl` itself excluded. A hand-written regex rather than a
 * DOM parse - the same reasoning as the dependency note above: this only
 * needs `href` values, not a tree. */
export function extractSameHostLinks(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const seen = new Set<string>([base.toString()]);
  const links: string[] = [];
  const hrefRe = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRe.exec(html))) {
    const raw = match[1] ?? match[2] ?? '';
    if (!raw || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('tel:'))
      continue;
    let resolved: URL;
    try {
      resolved = new URL(raw, base);
    } catch {
      continue;
    }
    resolved.hash = '';
    if (resolved.hostname !== base.hostname) continue;
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
    const normalized = resolved.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    links.push(normalized);
  }
  return links;
}

export interface WebsiteCrawlOptions {
  /** Injectable fetch, defaults to the global one. Tests substitute a real
   * fixture server rather than a mock, since the byte cap and the robots
   * honouring both depend on real streaming/response behaviour. */
  fetchImpl?: WebsiteFetch;
  timeoutMs?: number;
  maxBytesPerPage?: number;
  /** Total page cap including the root page. Clamped to
   * `WEBSITE_MAX_PAGES` regardless of what a caller passes. */
  maxPages?: number;
  /** Follow same-host links found on the root page, up to `maxPages`. Off by
   * default: "one page by default, optionally the pages it links" (#433). */
  crawlLinks?: boolean;
  userAgent?: string;
}

export interface WebsiteCrawlPage {
  url: string;
  text: string;
  bytes: number;
  truncated: boolean;
}

export type WebsiteCrawlResult =
  { ok: true; pages: WebsiteCrawlPage[] } | { ok: false; reason: string };

/**
 * Fetches one page (and optionally the same-host pages it links to, up to a
 * small cap), honouring `robots.txt`, a per-page byte cap and a timeout on
 * every request. Never throws: every failure mode - an invalid URL, a
 * disallow, a network error, a bad status - comes back as `{ ok: false }`
 * for the caller to record as that source's own `fetch_error`.
 */
export async function crawlWebsite(
  rootUrl: string,
  opts: WebsiteCrawlOptions = {},
): Promise<WebsiteCrawlResult> {
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = opts.timeoutMs ?? WEBSITE_FETCH_TIMEOUT_MS;
  const maxBytesPerPage = opts.maxBytesPerPage ?? WEBSITE_MAX_BYTES_PER_PAGE;
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? WEBSITE_MAX_PAGES, WEBSITE_MAX_PAGES));
  const userAgent = opts.userAgent ?? WEBSITE_USER_AGENT;

  let root: URL;
  try {
    root = new URL(rootUrl);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  if (root.protocol !== 'http:' && root.protocol !== 'https:') {
    return { ok: false, reason: 'only http(s) URLs are supported' };
  }

  const robots = await fetchRobotsTxt(root.origin, fetchImpl, timeoutMs, userAgent);
  if (!robots.isAllowed(root.pathname || '/')) {
    return { ok: false, reason: 'robots.txt disallows fetching this page' };
  }

  const rootFetch = await fetchCapped(root.toString(), fetchImpl, {
    maxBytes: maxBytesPerPage,
    timeoutMs,
  });
  if (!rootFetch.ok) return { ok: false, reason: rootFetch.reason };

  const pages: WebsiteCrawlPage[] = [
    {
      url: root.toString(),
      text: extractPageText(rootFetch.body),
      bytes: rootFetch.bytes,
      truncated: rootFetch.truncated,
    },
  ];

  if (opts.crawlLinks && maxPages > 1) {
    const candidates = extractSameHostLinks(rootFetch.body, root.toString()).filter((link) =>
      robots.isAllowed(new URL(link).pathname || '/'),
    );
    for (const link of candidates) {
      if (pages.length >= maxPages) break;
      const pageFetch = await fetchCapped(link, fetchImpl, {
        maxBytes: maxBytesPerPage,
        timeoutMs,
      });
      if (!pageFetch.ok) continue; // best-effort: one broken linked page does not fail the whole source
      pages.push({
        url: link,
        text: extractPageText(pageFetch.body),
        bytes: pageFetch.bytes,
        truncated: pageFetch.truncated,
      });
    }
  }

  return { ok: true, pages };
}

/** The `output` jsonb shape for a `website` `project_sources` row. */
export interface WebsiteSourceOutput {
  url: string;
  pages: Array<{ url: string; text: string }>;
  /** All pages' text joined, clamped to `WEBSITE_MAX_TEXT_CHARS` - what a
   * prompt actually reads, so a caller does not have to re-join and re-clamp
   * `pages` itself every time. */
  text: string;
  fetchedPageCount: number;
}

/**
 * Refreshes one `website` source's cached text unconditionally - "refreshed
 * on demand" (#433) means the caller decides when, not a TTL like
 * `github-sources.ts`'s anonymous-API budget forces. Never throws: a crawl
 * failure becomes this row's own `fetch_error`, leaving whatever `output` it
 * last carried untouched (mirrors `recordFetchError` in
 * `github-sources.ts`), so a project with several sources still reads when
 * one of them is down.
 */
export async function refreshWebsiteSource(
  db: Db,
  id: number,
  opts: WebsiteCrawlOptions = {},
): Promise<void> {
  const [row] = await db
    .select()
    .from(schema.projectSources)
    .where(eq(schema.projectSources.id, id));
  if (!row || row.kind !== 'website') return;

  const config = row.config as { url?: unknown };
  const url = typeof config.url === 'string' ? config.url : '';
  if (!url) {
    await db
      .update(schema.projectSources)
      .set({
        fetchError: 'source has no url configured',
        fetchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.projectSources.id, id));
    return;
  }

  const result = await crawlWebsite(url, opts);
  if (!result.ok) {
    await db
      .update(schema.projectSources)
      .set({ fetchError: result.reason, fetchedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.projectSources.id, id));
    return;
  }

  const joinedText = result.pages.map((p) => p.text).join('\n\n---\n\n');
  const output: WebsiteSourceOutput = {
    url,
    pages: result.pages.map((p) => ({ url: p.url, text: p.text })),
    text:
      joinedText.length > WEBSITE_MAX_TEXT_CHARS
        ? joinedText.slice(0, WEBSITE_MAX_TEXT_CHARS)
        : joinedText,
    fetchedPageCount: result.pages.length,
  };

  await db
    .update(schema.projectSources)
    .set({ output, fetchError: null, fetchedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.projectSources.id, id));
}

export type AddWebsiteSourceResult =
  | { ok: true; source: ProjectSourceRow }
  | { ok: false; code: 'invalid_url'; reason: string }
  | { ok: false; code: 'not_found' };

/**
 * Adds a website source to a project and does its first fetch inline, so the
 * caller gets back a source that already has text (or already has its
 * error) rather than an empty row that only fills in on a later refresh -
 * mirrors `addGithubSource`.
 */
export async function addWebsiteSource(
  db: Db,
  organizationId: number,
  projectId: number,
  url: string,
  opts: WebsiteCrawlOptions = {},
): Promise<AddWebsiteSourceResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, code: 'invalid_url', reason: 'not a valid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, code: 'invalid_url', reason: 'only http(s) URLs are supported' };
  }

  const created = await createProjectSource(db, organizationId, projectId, 'website', {
    url: parsed.toString(),
  });
  if (!created) return { ok: false, code: 'not_found' };

  await refreshWebsiteSource(db, created.id, opts);

  const [fresh] = await db
    .select()
    .from(schema.projectSources)
    .where(eq(schema.projectSources.id, created.id));
  return { ok: true, source: fresh ?? created };
}
