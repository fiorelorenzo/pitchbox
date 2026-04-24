import { chromium as rawChromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { RedditEnv } from './env.js';
import type {
  RedditComment,
  RedditPost,
  RedditSubredditAbout,
  RedditSubredditRule,
  RedditUserAbout
} from './types.js';

const chromium = rawChromium.use(StealthPlugin());

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let warmupPromise: Promise<void> | null = null;
let lastRequestAt = 0;

async function ensureContext(env: RedditEnv): Promise<BrowserContext> {
  if (context) return context;
  browser = await chromium.launch({
    headless: env.headless,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled']
  });
  context = await browser.newContext({
    userAgent: CHROME_UA,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  return context;
}

async function warmup(env: RedditEnv): Promise<void> {
  if (warmupPromise) return warmupPromise;
  warmupPromise = (async () => {
    const ctx = await ensureContext(env);
    const page = await ctx.newPage();
    try {
      const res = await page.goto('https://www.reddit.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000
      });
      await page.waitForTimeout(1_000);
      if (process.env.REDDIT_SCOUT_DEBUG === '1') {
        console.error(`  [warmup] status=${res?.status() ?? '?'}`);
      }
    } finally {
      await page.close();
    }
  })();
  return warmupPromise;
}

function jitter(env: RedditEnv): number {
  const span = env.maxIntervalMs - env.minIntervalMs;
  return env.minIntervalMs + Math.floor(Math.random() * span);
}

async function throttle(env: RedditEnv): Promise<void> {
  const wait = lastRequestAt + jitter(env) - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function newPage(env: RedditEnv): Promise<Page> {
  await warmup(env);
  await throttle(env);
  const ctx = await ensureContext(env);
  return ctx.newPage();
}

export type SearchOpts = {
  query: string;
  sort: string;
  timeframe: string;
  limit: number;
};

export type BrowseOpts = {
  subreddit: string;
  sort: 'hot' | 'top' | 'new';
  timeframe: string;
  limit: number;
};

/**
 * Scrolls the page bottom repeatedly until `selector` matches >= `limit` elements
 * or two consecutive scrolls fail to add new matches. Safe for Reddit's lazy-loaded feeds.
 */
async function scrollToLoadMore(
  page: Page,
  selector: string,
  limit: number,
  maxScrolls = 6
): Promise<number> {
  let stalls = 0;
  let count = await page.$$eval(selector, (els) => els.length);
  for (let i = 0; i < maxScrolls; i++) {
    if (count >= limit) return count;
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(900);
    const after = await page.$$eval(selector, (els) => els.length);
    if (after === count) {
      stalls++;
      if (stalls >= 2) return count;
    } else {
      stalls = 0;
      count = after;
    }
  }
  return count;
}

export async function browserSearchPosts(env: RedditEnv, opts: SearchOpts): Promise<RedditPost[]> {
  const qs = new URLSearchParams({
    q: opts.query,
    type: 'link',
    sort: opts.sort,
    t: opts.timeframe
  });
  const url = `https://www.reddit.com/search/?${qs}`;
  const page = await newPage(env);
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const status = res?.status() ?? 0;
    if (status === 403 || status === 401) {
      throw new Error(
        `Reddit ${status} on ${url}. The subreddit may be private/gated or Reddit is rate-limiting anonymous access.`
      );
    }
    await page
      .waitForSelector(
        '[data-testid="search-post-unit"], [data-testid="search-results-empty-state"]',
        { timeout: 8_000 }
      )
      .catch(() => undefined);

    await scrollToLoadMore(page, '[data-testid="search-post-unit"]', opts.limit);

    const posts = await page.$$eval(
      '[data-testid="search-post-unit"]',
      (els, max) => {
        const out: Array<Record<string, unknown>> = [];
        for (const el of els.slice(0, max)) {
          const tracker = el.querySelector(
            'search-telemetry-tracker[data-faceplate-tracking-context]'
          );
          let ctx: {
            post?: { id?: string; title?: string; nsfw?: boolean };
            profile?: { id?: string; name?: string };
          } | null = null;
          try {
            const raw = tracker?.getAttribute('data-faceplate-tracking-context');
            if (raw) ctx = JSON.parse(raw);
          } catch {
            /* fallthrough */
          }
          const anchor = el.querySelector<HTMLAnchorElement>('a[href*="/comments/"]');
          const permalink = anchor ? new URL(anchor.href).pathname : '';
          const subMatch = permalink.match(/^\/r\/([^/]+)\//);
          const subreddit = subMatch ? subMatch[1] : '';

          const timeEl = el.querySelector<HTMLTimeElement>('time[datetime], faceplate-timeago');
          let createdUtc = 0;
          const dt = timeEl?.getAttribute('datetime') ?? timeEl?.getAttribute('ts');
          if (dt) createdUtc = Math.floor(new Date(dt).getTime() / 1000);

          const numEls = Array.from(el.querySelectorAll<HTMLElement>('faceplate-number[number]'));
          const score = numEls[0] ? Number(numEls[0].getAttribute('number')) || 0 : 0;
          const numComments = numEls[1] ? Number(numEls[1].getAttribute('number')) || 0 : 0;

          const id = (ctx?.post?.id ?? '').replace(/^t3_/, '');
          const title =
            ctx?.post?.title ??
            el.querySelector('[data-testid="post-title"]')?.textContent?.trim() ??
            '';
          const author = ctx?.profile?.name ?? '';
          if (!id || !author || !subreddit) continue;

          out.push({
            id,
            subreddit,
            title,
            selftext: '',
            permalink,
            url: permalink,
            score,
            numComments,
            createdUtc,
            author,
            authorFullname: ctx?.profile?.id ?? null,
            over18: !!ctx?.post?.nsfw,
            locked: false,
            stickied: false
          });
        }
        return out;
      },
      opts.limit
    );
    return posts as RedditPost[];
  } finally {
    await page.close();
  }
}

/**
 * Navigate to /r/<sub>/<sort>/?t=<timeframe> and extract posts from `shreddit-post`
 * web components (subreddit listing pages use these rather than search-post-unit).
 * Used for hot-browse sampling of active subs without keyword filtering.
 */
export async function browserBrowseSubreddit(
  env: RedditEnv,
  opts: BrowseOpts
): Promise<RedditPost[]> {
  const sortSegment =
    opts.sort === 'top' ? `top/?t=${encodeURIComponent(opts.timeframe)}` : `${opts.sort}/`;
  const url = `https://www.reddit.com/r/${encodeURIComponent(opts.subreddit)}/${sortSegment}`;
  const page = await newPage(env);
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const status = res?.status() ?? 0;
    if (status === 403 || status === 401) {
      throw new Error(
        `Reddit ${status} on ${url}. The subreddit may be private/gated or Reddit is rate-limiting anonymous access.`
      );
    }
    if (status === 404) return [];
    await page
      .waitForSelector('shreddit-post, [data-testid="search-post-unit"]', { timeout: 8_000 })
      .catch(() => undefined);

    await scrollToLoadMore(page, 'shreddit-post', opts.limit);

    const posts = await page.$$eval(
      'shreddit-post',
      (els, max) => {
        const out: Array<Record<string, unknown>> = [];
        for (const el of els.slice(0, max)) {
          const rawId = el.id || el.getAttribute('id') || '';
          const id = rawId.replace(/^t3_/, '');
          const subPrefixed = el.getAttribute('subreddit-prefixed-name') || '';
          const subreddit =
            subPrefixed.replace(/^\/?r\//, '') || el.getAttribute('subreddit-name') || '';
          const author = el.getAttribute('author') || '';
          const permalink = el.getAttribute('permalink') || '';
          if (!id || !author || !subreddit || author === '[deleted]') continue;

          const timestamp = el.getAttribute('created-timestamp');
          const isLocked =
            el.getAttribute('post-locked') === 'true' || el.getAttribute('is-locked') === 'true';
          const isStickied =
            el.getAttribute('is-stickied') === 'true' || el.getAttribute('stickied') === 'true';
          out.push({
            id,
            subreddit,
            title: el.getAttribute('post-title') || '',
            selftext: '',
            permalink,
            url: el.getAttribute('content-href') || permalink,
            score: Number(el.getAttribute('score')) || 0,
            numComments: Number(el.getAttribute('comment-count')) || 0,
            createdUtc: timestamp ? Math.floor(new Date(timestamp).getTime() / 1000) : 0,
            author,
            authorFullname: el.getAttribute('author-id') || null,
            over18: el.getAttribute('is-nsfw') === 'true',
            locked: isLocked,
            stickied: isStickied,
            linkFlairText: el.getAttribute('post-flair-text') || null
          });
        }
        return out;
      },
      opts.limit
    );
    return posts as RedditPost[];
  } finally {
    await page.close();
  }
}

export async function browserGetUserAbout(
  env: RedditEnv,
  username: string
): Promise<RedditUserAbout | null> {
  const url = `https://www.reddit.com/user/${encodeURIComponent(username)}/`;
  const page = await newPage(env);
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const status = res?.status() ?? 0;
    if (status === 404) return null;
    if (status === 403 || status === 401) {
      throw new Error(`Reddit ${status} on ${url}. Endpoint may be gated or rate-limited.`);
    }

    await page
      .waitForSelector('time[datetime], shreddit-profile-card, [data-testid="profile-sidebar"]', {
        timeout: 6_000
      })
      .catch(() => undefined);

    if (process.env.REDDIT_SCOUT_DEBUG === '1') {
      const dbg = (await page.evaluate(
        "(()=>{const dump=(sel)=>Array.from(document.querySelectorAll(sel)).slice(0,8).map(e=>({tag:e.tagName.toLowerCase(),id:e.id,class:(e.className||'').toString().slice(0,80),aria:e.getAttribute('aria-label'),number:e.getAttribute('number'),text:(e.textContent||'').trim().slice(0,60)}));return{title:document.title,faceplate:dump('faceplate-number'),karmaAny:dump('[id*=karma],[data-testid*=karma],[class*=karma]'),shredditProfileCard:!!document.querySelector('shreddit-profile-card'),timeCount:document.querySelectorAll('time[datetime]').length};})()"
      )) as unknown;
      console.error(`  [debug user ${username}]`, JSON.stringify(dbg, null, 2).slice(0, 2000));
    }

    // String expression to avoid tsx injecting __name helper into the browser context.
    // Strategy: find the karma label ("Karma") and take the closest following number-like text,
    // fallback to the first plain-number span on the page (which on modern Reddit is karma total).
    const info = (await page.evaluate(
      "(()=>{const parseNum=(s)=>{if(!s)return 0;const c=String(s).replace(/[, ]/g,'').toLowerCase();const m=c.match(/^(\\d+(?:\\.\\d+)?)([km]?)$/);if(!m)return Number(c)||0;const n=Number(m[1]);if(m[2]==='k')return Math.round(n*1000);if(m[2]==='m')return Math.round(n*1000000);return Math.round(n);};const isNumText=(t)=>/^\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?[km]?$|^\\d+(?:\\.\\d+)?[km]?$/i.test(String(t||'').trim());let karma=0;const all=Array.from(document.querySelectorAll('span, div, faceplate-number'));for(const el of all){const t=(el.getAttribute('number')||el.textContent||'').trim();if(!t)continue;if(el.children&&el.children.length>0&&el.tagName!=='FACEPLATE-NUMBER')continue;if(isNumText(t)){const n=parseNum(t);if(n>=1){karma=n;break;}}}let createdUtc=0;const time=document.querySelector('time[datetime]');if(time){const dt=time.getAttribute('datetime');if(dt)createdUtc=Math.floor(new Date(dt).getTime()/1000);}return{karma,createdUtc};})()"
    )) as { karma: number; createdUtc: number };

    return {
      name: username,
      id: '',
      totalKarma: info.karma,
      linkKarma: 0,
      commentKarma: 0,
      createdUtc: info.createdUtc,
      isSuspended: false,
      isEmployee: false,
      acceptsFollowers: false
    };
  } finally {
    await page.close();
  }
}

async function fetchJson<T>(env: RedditEnv, url: string): Promise<T | null> {
  const page = await newPage(env);
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const status = res?.status() ?? 0;
    if (status === 404) return null;
    if (status === 403 || status === 401) {
      throw new Error(`Reddit ${status} on ${url}. Endpoint may be gated or rate-limited.`);
    }
    const body = await page.evaluate('document.body.innerText');
    try {
      return JSON.parse(String(body)) as T;
    } catch {
      return null;
    }
  } finally {
    await page.close();
  }
}

type RulesResponse = {
  rules?: Array<{
    short_name?: string;
    description?: string;
    kind?: string;
    priority?: number;
  }>;
};

export async function browserGetSubredditRules(
  env: RedditEnv,
  subreddit: string
): Promise<RedditSubredditRule[]> {
  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/about/rules.json`;
  const data = await fetchJson<RulesResponse>(env, url);
  if (!data?.rules) return [];
  return data.rules.map((r) => ({
    shortName: r.short_name ?? '',
    description: r.description ?? '',
    kind: r.kind ?? '',
    priority: Number(r.priority ?? 0)
  }));
}

type AboutResponse = {
  data?: {
    display_name?: string;
    title?: string;
    subscribers?: number;
    public_description?: string;
    submission_type?: string;
    over18?: boolean;
  };
};

export async function browserGetSubredditAbout(
  env: RedditEnv,
  subreddit: string
): Promise<RedditSubredditAbout | null> {
  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/about.json`;
  const data = await fetchJson<AboutResponse>(env, url);
  if (!data?.data) return null;
  const d = data.data;
  return {
    name: d.display_name ?? subreddit,
    title: d.title ?? '',
    subscribers: Number(d.subscribers ?? 0),
    publicDescription: d.public_description ?? '',
    submissionType: d.submission_type ?? 'any',
    over18: !!d.over18
  };
}

type CommentsResponse = Array<{
  data?: {
    children?: Array<{
      data?: {
        id?: string;
        author?: string;
        score?: number;
        body?: string;
        created_utc?: number;
        stickied?: boolean;
      };
      kind?: string;
    }>;
  };
} | null>;

export async function browserGetPostComments(
  env: RedditEnv,
  permalink: string,
  limit: number
): Promise<RedditComment[]> {
  const clean = permalink.startsWith('/') ? permalink : `/${permalink}`;
  const url = `https://www.reddit.com${clean}.json?limit=${limit}&depth=1&sort=top`;
  const data = await fetchJson<CommentsResponse>(env, url);
  if (!Array.isArray(data) || data.length < 2) return [];
  const commentListing = data[1];
  const children = commentListing?.data?.children ?? [];
  const out: RedditComment[] = [];
  for (const child of children) {
    if (child.kind !== 't1') continue;
    const d = child.data;
    if (!d || !d.body || d.author === '[deleted]' || d.stickied) continue;
    out.push({
      id: d.id ?? '',
      author: d.author ?? '',
      score: Number(d.score ?? 0),
      body: d.body,
      createdUtc: Number(d.created_utc ?? 0)
    });
    if (out.length >= limit) break;
  }
  return out;
}

type PostAndCommentsResponse = Array<{
  data?: {
    children?: Array<{
      data?: {
        id?: string;
        subreddit?: string;
        title?: string;
        selftext?: string;
        permalink?: string;
        url?: string;
        score?: number;
        num_comments?: number;
        created_utc?: number;
        author?: string;
        author_fullname?: string | null;
        over_18?: boolean;
        locked?: boolean;
        stickied?: boolean;
        link_flair_text?: string | null;
        body?: string;
      };
      kind?: string;
    }>;
  };
} | null>;

export async function browserGetPostAndComments(
  env: RedditEnv,
  permalink: string,
  commentLimit: number
): Promise<{ post: RedditPost | null; comments: RedditComment[] }> {
  const clean = permalink.startsWith('/') ? permalink : `/${permalink}`;
  const url = `https://www.reddit.com${clean}.json?limit=${commentLimit}&depth=1&sort=top`;
  const data = await fetchJson<PostAndCommentsResponse>(env, url);
  if (!Array.isArray(data) || data.length < 2) return { post: null, comments: [] };
  const postChild = data[0]?.data?.children?.[0];
  let post: RedditPost | null = null;
  if (postChild?.kind === 't3' && postChild.data?.id) {
    const d = postChild.data;
    post = {
      id: d.id ?? '',
      subreddit: d.subreddit ?? '',
      title: d.title ?? '',
      selftext: d.selftext ?? '',
      permalink: d.permalink ?? '',
      url: d.url ?? '',
      score: Number(d.score ?? 0),
      numComments: Number(d.num_comments ?? 0),
      createdUtc: Number(d.created_utc ?? 0),
      author: d.author ?? '',
      authorFullname: d.author_fullname ?? null,
      over18: !!d.over_18,
      locked: !!d.locked,
      stickied: !!d.stickied,
      linkFlairText: d.link_flair_text ?? null
    };
  }
  const children = data[1]?.data?.children ?? [];
  const comments: RedditComment[] = [];
  for (const child of children) {
    if (child.kind !== 't1') continue;
    const d = child.data;
    if (!d || !d.body || d.author === '[deleted]' || d.stickied) continue;
    comments.push({
      id: d.id ?? '',
      author: d.author ?? '',
      score: Number(d.score ?? 0),
      body: d.body,
      createdUtc: Number(d.created_utc ?? 0)
    });
    if (comments.length >= commentLimit) break;
  }
  return { post, comments };
}

type UserSubmittedResponse = {
  data?: {
    children?: Array<{
      data?: {
        id?: string;
        subreddit?: string;
        title?: string;
        selftext?: string;
        permalink?: string;
        url?: string;
        score?: number;
        num_comments?: number;
        created_utc?: number;
        author?: string;
        author_fullname?: string | null;
        over_18?: boolean;
        locked?: boolean;
        stickied?: boolean;
        link_flair_text?: string | null;
      };
      kind?: string;
    }>;
  };
};

export async function browserGetUserPosts(
  env: RedditEnv,
  username: string,
  limit: number
): Promise<RedditPost[]> {
  const url = `https://www.reddit.com/user/${encodeURIComponent(username)}/submitted.json?limit=${limit}`;
  const data = await fetchJson<UserSubmittedResponse>(env, url);
  const children = data?.data?.children ?? [];
  const out: RedditPost[] = [];
  for (const child of children) {
    if (child.kind !== 't3') continue;
    const d = child.data;
    if (!d || !d.id || !d.author) continue;
    out.push({
      id: d.id,
      subreddit: d.subreddit ?? '',
      title: d.title ?? '',
      selftext: d.selftext ?? '',
      permalink: d.permalink ?? '',
      url: d.url ?? '',
      score: Number(d.score ?? 0),
      numComments: Number(d.num_comments ?? 0),
      createdUtc: Number(d.created_utc ?? 0),
      author: d.author,
      authorFullname: d.author_fullname ?? null,
      over18: !!d.over_18,
      locked: !!d.locked,
      stickied: !!d.stickied,
      linkFlairText: d.link_flair_text ?? null
    });
  }
  return out;
}

export async function closeBrowser(): Promise<void> {
  if (context) {
    await context.close();
    context = null;
  }
  if (browser) {
    await browser.close();
    browser = null;
  }
  warmupPromise = null;
}
