#!/usr/bin/env node
// Regenerates the anonymised Reddit markup fixture in
// extension/tests/content/fixtures/reddit/ from a real, signed-in Reddit session.
//
// Why this exists: `extension/src/content/shared/reddit-dom.ts` carried a note for
// months saying its fixtures were modeled on public knowledge of the `shreddit-*`
// elements rather than captured, because no browser was available. A selector suite
// built on a guess passes without proving anything, so this captures the real thing
// and the tests replay it.
//
// It never commits anything personal. Only an attribute allowlist survives, authors are
// mapped to synthetic handles, prose is replaced, images and hrefs are dropped, and every
// thing id is renumbered while keeping its `t1_`/`t3_` shape - which is the part under
// test.
//
// Usage:
//   node scripts/capture-reddit-fixtures.mjs --cdp http://127.0.0.1:9391
//   node scripts/capture-reddit-fixtures.mjs --cdp <endpoint> --thread <permalink>
//
// The endpoint is any Chrome with an open CDP port signed in to Reddit. On Lorenzo's
// devbox that is `omp-chrome up personal`, which prints the endpoint.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(REPO_ROOT, 'extension/tests/content/fixtures/reddit');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const CDP = arg('cdp');
if (!CDP) {
  console.error('--cdp <http://127.0.0.1:PORT> is required (a Chrome signed in to Reddit)');
  process.exit(1);
}
// Any thread with comments works; its ids are renumbered on the way out.
const THREAD = arg(
  'thread',
  '/r/forgottenrealms/comments/1vst5rd/which_forgotten_realms_historical_event_deserves/',
);

async function attach(cdpUrl) {
  const ver = await (await fetch(new URL('/json/version', cdpUrl))).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  {
    const { promise, resolve, reject } = Promise.withResolvers();
    ws.onopen = resolve;
    ws.onerror = reject;
    await promise;
  }

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
  const send = (method, params = {}, sessionId) => {
    const { promise, resolve, reject } = Promise.withResolvers();
    const n = ++seq;
    pending.set(n, { res: resolve, rej: reject });
    ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => {
      if (!pending.has(n)) return;
      pending.delete(n);
      reject(new Error(`CDP timeout: ${method}`));
    }, 120_000);
    return promise;
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Page.enable');
  await S('Runtime.enable');

  return {
    close: () => ws.close(),
    async goto(url, timeout = 90_000) {
      const { promise, resolve } = Promise.withResolvers();
      listeners.push(
        (m) => m.sessionId === sessionId && m.method === 'Page.loadEventFired' && resolve(),
      );
      setTimeout(resolve, timeout);
      await S('Page.navigate', { url });
      await promise;
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

// Runs in the page. Everything outside the allowlist is dropped on purpose.
function extractAnonymised(rootSelector, ourHandle, subreddit) {
  const KEEP = new Set([
    // The identity attributes the content scripts actually read.
    'thingid',
    'author',
    'created',
    'permalink',
    'depth',
    'postid',
    'score',
    'content-type',
    // Compose controls.
    'contenteditable',
    'role',
    'aria-label',
    'placeholder',
    'name',
    'type',
    'disabled',
    'slot',
  ]);
  const HANDLES = ['first_author', 'second_author', 'third_author', 'fourth_author'];

  let next = 0;
  const handles = new Map();
  // Our own handle keeps a stable synthetic name, so a test can assert "the comment
  // authored by us" without the fixture carrying a real account.
  handles.set(ourHandle.toLowerCase(), 'fixture_owner');
  const fakeHandle = (real) => {
    const key = real.toLowerCase();
    if (!handles.has(key)) handles.set(key, HANDLES[next++ % HANDLES.length]);
    return handles.get(key);
  };

  // Collect every handle on the page BEFORE cloning, because a real name shows up in
  // places that are not an `author` attribute (`aria-label="Comment from <name>"`,
  // `aria-label="Author: <name>"`, a `/user/<name>` href, and body text). Scrubbing
  // lazily per attribute missed all of those on the first capture.
  const root0 = document.querySelector(rootSelector) ?? document.body;
  for (const el of root0.querySelectorAll('[author]')) fakeHandle(el.getAttribute('author'));
  for (const a of root0.querySelectorAll('a[href*="/user/"]')) {
    const m = /\/user\/([^/?#"\s]+)/.exec(a.getAttribute('href') ?? '');
    if (m) fakeHandle(m[1]);
  }
  for (const el of root0.querySelectorAll('[aria-label], [arialabel]')) {
    const label = el.getAttribute('aria-label') ?? el.getAttribute('arialabel') ?? '';
    const m = /(?:Author:|Comment from|u\/)\s*([A-Za-z0-9_-]{3,20})/.exec(label);
    if (m) fakeHandle(m[1]);
  }
  const scrubHandles = (s) => {
    let out = s;
    for (const [real, fake] of handles) {
      // Handles are case-insensitive on Reddit and appear bare or as `u/<name>`.
      out = out.replace(
        new RegExp(`\\b${real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'),
        fake,
      );
    }
    // The subreddit is not personal, but it also has no business identifying one
    // community in a generic fixture, and it appears bare (a screen-reader label
    // reading "Go to <sub>") as well as prefixed.
    if (subreddit)
      out = out.replace(
        new RegExp(`\\b${subreddit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'),
        'fixture',
      );
    return out;
  };

  const LOREM =
    'the second death of mystra is the one worth telling, since the fallout shows up everywhere and the event itself never does.';
  const scrubText = (raw) => {
    const s = raw.replace(/\s+/g, ' ').trim();
    if (!s || /^\d+$/.test(s)) return s;
    if (s.length <= 24) return scrubHandles(s).replace(/\br\/[A-Za-z0-9_]+/g, 'r/fixture');
    return LOREM.slice(0, Math.min(LOREM.length, s.length));
  };
  // Keep the `t1_`/`t3_` shape, renumber the base36 body: that shape is under test.
  const scrubId = (value) =>
    value.replace(/\b(t[135]_)[a-z0-9]+/gi, (_m, p) => `${p}fixture${++next}`);
  // A permalink carries a bare base36 post id and comment id, plus the real subreddit.
  // The shape is what the selectors care about, so canonicalise the whole path.
  const scrubPath = (value) =>
    value
      .replace(
        /\/r\/[^/\s"]+\/comments\/[a-z0-9]+\/[^/\s"]*\/comment\/[a-z0-9]+\/?/gi,
        () => `/r/fixture/comments/fixturepost/slug/comment/fixture${++next}/`,
      )
      .replace(
        /\/r\/[^/\s"]+\/comments\/[a-z0-9]+(\/[^"\s]*)?/gi,
        '/r/fixture/comments/fixturepost/',
      )
      .replace(/\/user\/[^/\s"]+/g, '/user/fixture_owner')
      .replace(/\/svc\/[^"\s]*/g, '/svc/fixture')
      // Bare `r/<sub>` shows up in placeholders and labels, sometimes wrapped in bidi
      // isolates, so no word boundary here.
      .replace(/r\/[A-Za-z0-9_]+/g, 'r/fixture');
  const scrubAttr = (name, value) => {
    if (name === 'author') return fakeHandle(value);
    return scrubHandles(scrubPath(scrubId(value)));
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
        into.appendChild(document.createElement('img'));
        continue;
      }
      const el = document.createElement(tag);
      for (const a of child.attributes)
        if (KEEP.has(a.name)) el.setAttribute(a.name, scrubAttr(a.name, a.value));
      if (tag === 'a') el.setAttribute('href', '/r/fixture/comments/t3_fixture0/');
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

async function whoami(page) {
  return page.eval(async () => {
    try {
      const r = await fetch('/api/me.json?raw_json=1', { headers: { accept: 'application/json' } });
      if (r.ok) return (await r.json())?.data?.name ?? null;
    } catch {
      // fall through
    }
    return null;
  });
}

const page = await attach(CDP);
await page.goto(`https://www.reddit.com${THREAD}`);
const handle = await whoami(page);
if (!handle) {
  console.error('not signed in to Reddit on this endpoint (api/me.json gave no name)');
  page.close();
  process.exit(1);
}
await page.eval(async () => {
  window.scrollBy(0, 1600);
  await new Promise((r) => setTimeout(r, 2500));
  window.scrollTo(0, 0);
});
const html = await page.eval(
  extractAnonymised,
  'shreddit-app, main, body',
  handle,
  /\/r\/([^/]+)/.exec(THREAD)?.[1] ?? '',
);
mkdirSync(OUT_DIR, { recursive: true });
const out = join(OUT_DIR, 'comment-thread.html');
writeFileSync(out, `${html}\n`);
console.log(`comment-thread.html: ${html.length} bytes (captured as ${handle} -> fixture_owner)`);
page.close();
