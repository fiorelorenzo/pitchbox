#!/usr/bin/env node
// Regenerates the anonymised LinkedIn markup fixtures in
// extension/tests/content/fixtures/linkedin/ from a real, signed-in LinkedIn session.
//
// Why this exists as a script rather than a one-off: LinkedIn ships obfuscated class
// names and runs layout experiments, so a fixture goes stale and has to be recaptured.
// A fixture nobody can regenerate is a fixture nobody trusts.
//
// It never commits anything personal. Only an attribute allowlist survives, every
// name is mapped to a synthetic one, every piece of prose is replaced, every image and
// href is dropped, and the numeric part of a URN is renumbered. Verify with the audit
// the README describes before committing a regenerated fixture.
//
// Usage:
//   node scripts/capture-linkedin-fixtures.mjs --cdp http://127.0.0.1:9391
//   node scripts/capture-linkedin-fixtures.mjs --cdp <endpoint> --post <activity-urn>
//
// The endpoint is any Chrome with an open CDP port that is signed in to LinkedIn.
// Nothing here is specific to one machine; on Lorenzo's devbox that is
// `omp-chrome up personal`, which prints the endpoint.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(REPO_ROOT, 'extension/tests/content/fixtures/linkedin');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const CDP = arg('cdp');
if (!CDP) {
  console.error('--cdp <http://127.0.0.1:PORT> is required (a Chrome signed in to LinkedIn)');
  process.exit(1);
}
// A post the capturing account may read. Any public post works; its id is renumbered.
const POST_URN = arg('post', 'urn:li:activity:7500526540024344576');
// The capturing account's own vanity slug. It appears inside profile card ids,
// so it is scrubbed out of them; required for the two profile pages below.
const PROFILE_SLUG = arg('profile');
// Recapture one page without touching the others, so a fixture fixed for one
// reader does not churn the three tests that were already passing.
const ONLY = arg('only');
// Extra identifying literals no shape rule catches: a one-word employer, a
// first name on its own, a university. Comma separated, case-insensitive.
const EXTRA_SCRUB = (arg('scrub') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function attach(cdpUrl) {
  const ver = await (await fetch(new URL('/json/version', cdpUrl))).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let seq = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(JSON.stringify(m.error)));
      else res(m.result);
    } else if (m.method) for (const fn of listeners) fn(m);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const n = ++seq;
      pending.set(n, { res, rej });
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (!pending.has(n)) return;
        pending.delete(n);
        rej(new Error(`CDP timeout: ${method}`));
      }, 120_000);
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Page.enable');
  await S('Runtime.enable');

  return {
    close: () => ws.close(),
    async goto(url, timeout = 60_000) {
      const loaded = new Promise((res) => {
        listeners.push(
          (m) => m.sessionId === sessionId && m.method === 'Page.loadEventFired' && res(),
        );
        setTimeout(res, timeout);
      });
      await S('Page.navigate', { url });
      await loaded;
    },
    async eval(fn, ...args) {
      const r = await S('Runtime.evaluate', {
        expression: `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails)
        throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
      return r.result.value;
    },
  };
}

// Runs in the page. Everything below the allowlist is dropped on purpose.
function extractAnonymised(rootSelector, profileSlug, extraScrub) {
  const KEEP = new Set([
    'data-urn',
    'data-id',
    'data-entity-urn',
    'data-view-name',
    'data-control-name',
    'data-testid',
    'data-sdui-anchor-id',
    'data-sdui-screen',
    'data-finite-scroll-hotkey',
    'role',
    'contenteditable',
    'aria-label',
    'aria-hidden',
    'type',
    'placeholder',
    'disabled',
    // Added 2026-09-07 for the profile capture (#389): the profile frontend
    // addresses its cards only by id (`...profile.card.ref<memberRef>About`,
    // `profileCardsExperienceOnly<slug>`), so an anonymised profile page with
    // its ids dropped cannot exercise a single profile selector. The member
    // ref and the vanity slug inside those ids are scrubbed below.
    'id',
  ]);
  const PEOPLE = ['Giulia Bianchi', 'Marco Rossi', 'Elena Conti', 'Paolo Greco', 'Sara Ferrari'];
  const LOREM =
    'We shipped the new ingest path last week and the p99 dropped by half. The interesting part was not the cache, it was realising the retry budget was being spent on requests nobody was waiting for.';

  let next = 0;
  const names = new Map();
  const fakeName = (real) => {
    if (!names.has(real)) names.set(real, PEOPLE[next++ % PEOPLE.length]);
    return names.get(real);
  };
  const NAME_SHAPED = /\p{Lu}\p{Ll}+(\s+\p{Lu}\p{Ll}+)+/gu;

  // Literals the caller knows are identifying and that no shape-based rule
  // catches: a single-word employer, a first name on its own ("Lorenzo lavora
  // qui"), a university. Longest first, so a substring never masks a longer
  // match.
  const EXTRA = (extraScrub ?? []).slice().sort((a, b) => b.length - a.length);
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const extraRe = EXTRA.length ? new RegExp(EXTRA.map(escape).join('|'), 'gi') : null;
  const scrubExtra = (s) => (extraRe ? s.replace(extraRe, 'Acme') : s);

  const scrubText = (raw) => {
    const s = raw.replace(/\s+/g, ' ').trim();
    if (!s || /^\d+$/.test(s)) return s;
    if (s.length <= 24) return scrubExtra(s.replace(NAME_SHAPED, (m) => fakeName(m)));
    return LOREM.slice(0, Math.min(LOREM.length, s.length));
  };
  // `(?!)` never matches, so an absent `--profile` scrubs nothing rather than
  // replacing every string in the page.
  const slugRe = new RegExp(profileSlug ? escape(profileSlug) : '(?!)', 'g');
  // The card names the profile frontend uses as an id suffix. An allowlist,
  // not a pattern: the member ref that precedes them is base64-ish and
  // CamelCase-shaped in places, so any "keep the trailing words" rule leaks
  // characters of the ref into the fixture.
  const CARD_NAMES = [
    'Topcard',
    'About',
    'Services',
    'Featured',
    'Activity',
    'Experience',
    'Education',
    'Skills',
    'Recommendations',
    'Interests',
    'Languages',
    'SalesInsightsOrHighlights',
    'SuggestedForYou',
  ];
  // Renumbering used to map every long digit run to one constant keyed only on
  // its length, which meant six distinct activity ids on a capture became six
  // copies of the same id (found 2026-09-07: it made "these are two different
  // posts" untestable, and server-side dedupe on `(org, external_id)` would
  // have collapsed them). Distinct real ids now get distinct synthetic ones,
  // and the first one keeps the value the older fixtures already carry.
  const seenIds = new Map();
  const renumber = (digits) => {
    if (!seenIds.has(digits)) seenIds.set(digits, seenIds.size + 1);
    const n = String(seenIds.get(digits));
    return '7' + '0'.repeat(Math.max(0, digits.length - 1 - n.length)) + n;
  };
  const scrubAttr = (name, value) => {
    if (name === 'aria-label') return scrubExtra(value.replace(NAME_SHAPED, (m) => fakeName(m)));
    if (name === 'id') {
      // A profile card id carries two identifiers, the member ref
      // (`refACoAAB4sSg8...`) and the vanity slug, and one thing the
      // selectors need: the card name at the end. Both identifiers go, the
      // card name stays.
      return value
        .replace(/ref[A-Za-z0-9_-]{10,}/g, (m) => {
          const card = CARD_NAMES.find((c) => m.endsWith(c));
          return `refEXAMPLEMEMBER${card ?? ''}`;
        })
        .replace(slugRe, 'example-person')
        .replace(/\d{8,}/g, renumber);
    }
    // URN shapes are the thing under test, so keep the shape and renumber the id.
    return value.replace(/\d{8,}/g, renumber);
  };

  const SKIP = new Set(['script', 'style', 'link', 'svg', 'video', 'canvas', 'iframe', 'noscript']);

  const clone = (from, into, depth) => {
    if (depth > 40) return;
    for (const child of from.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const s = scrubText(child.nodeValue ?? '');
        if (s.trim()) into.appendChild(document.createTextNode(s));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName.toLowerCase();
      if (SKIP.has(tag)) continue;
      if (tag === 'img') {
        // Keep the slot so layout-shaped selectors still see it; drop the photo.
        into.appendChild(document.createElement('img'));
        continue;
      }
      const el = document.createElement(tag);
      for (const a of child.attributes)
        if (KEEP.has(a.name)) el.setAttribute(a.name, scrubAttr(a.name, a.value));
      if (tag === 'a') el.setAttribute('href', '/in/example-person/');
      into.appendChild(el);
      clone(child, el, depth + 1);
      if (child.shadowRoot) {
        // A content script has to pierce these, so record them rather than flattening.
        const marker = document.createElement('template');
        marker.setAttribute('data-fixture-shadow-root', 'open');
        el.appendChild(marker);
        clone(child.shadowRoot, marker, depth + 1);
      }
    }
  };

  const root = document.querySelector(rootSelector) ?? document.body;
  const holder = document.createElement('div');
  clone(root, holder, 0);
  return holder.innerHTML;
}

async function settle(page, passes = 2) {
  await page.eval(async (n) => {
    for (let i = 0; i < n; i++) {
      window.scrollBy(0, 1400);
      await new Promise((r) => setTimeout(r, 1500));
    }
    window.scrollTo(0, 0);
  }, passes);
  await new Promise((r) => setTimeout(r, 4000));
}

const PAGES = [
  {
    file: 'feed.html',
    url: 'https://www.linkedin.com/feed/',
    root: '[data-testid="mainFeed"], main',
  },
  {
    file: 'post-detail.html',
    url: `https://www.linkedin.com/feed/update/${POST_URN}/`,
    root: 'main',
  },
  // The operator's own pages, for the persona capture (#389). Both need
  // `--profile <slug>`; without it the slug inside the profile card ids is
  // left as captured, which is the one identifier this anonymiser must not
  // keep. Measured 2026-09-07: the profile page is server-driven UI whose
  // cards are addressable only by id, while the activity page is the classic
  // stack and carries `div[data-urn][role="article"]` per post, so the
  // existing post accessors read it unchanged.
  ...(PROFILE_SLUG
    ? [
        {
          file: 'own-profile.html',
          url: `https://www.linkedin.com/in/${PROFILE_SLUG}/`,
          root: 'main',
          // The About and Experience cards are lazy-mounted below the fold, so
          // the default two scroll passes capture an empty Experience card
          // (measured 2026-09-07, and it made the reader untestable).
          scrollPasses: 8,
        },
        {
          file: 'own-activity.html',
          url: `https://www.linkedin.com/in/${PROFILE_SLUG}/recent-activity/all/`,
          root: 'main',
        },
      ]
    : []),
];

const page = await attach(CDP);
mkdirSync(OUT_DIR, { recursive: true });
for (const p of PAGES.filter((x) => !ONLY || x.file === ONLY)) {
  await page.goto(p.url);
  await settle(page, p.scrollPasses ?? 2);
  const html = await page.eval(extractAnonymised, p.root, PROFILE_SLUG ?? null, EXTRA_SCRUB);
  const path = join(OUT_DIR, p.file);
  writeFileSync(path, `${html}\n`);
  console.log(`${p.file}: ${html.length} bytes`);
}
page.close();
