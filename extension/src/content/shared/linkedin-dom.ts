import type { ActivityEvent } from '../../lib/activity.js';

/**
 * DOM lookup helpers for LinkedIn's feed and post-detail pages, shared by the
 * content scripts that observe and assist on linkedin.com. Mirrors the role
 * of `reddit-dom.ts` in this same directory: every LinkedIn selector in the
 * codebase lives here and nowhere else.
 *
 * LinkedIn ships obfuscated class names and runs layout experiments, so
 * anchor on the attributes LinkedIn uses for its own instrumentation
 * (`data-urn`, `data-id`, `data-view-name`, `data-sdui-anchor-id`,
 * `data-control-name`), never on a generated class name. Where a fallback
 * chain is needed below, it is ordered with a comment explaining why.
 *
 * `queryDeep`/`queryDeepAll` (same shape as `reddit-dom.ts`'s) add a fallback
 * that walks open shadow roots breadth-first when the plain (fast-path) query
 * misses, for the same reason Reddit's `shreddit-*` custom elements need it:
 * a plain `document.querySelector` cannot see past an element's shadow
 * boundary. Closed shadow roots are intentionally left unreached, as they are
 * for Reddit. Measured against the real captures below, neither LinkedIn page
 * kind currently renders any of the markup this module reads inside a shadow
 * root, so the fallback path is not exercised by the fixture tests - kept for
 * the same defensiveness `reddit-dom.ts` documents, since LinkedIn's SDUI
 * stack is a newer surface that could grow shadow-DOM-encapsulated web
 * components the way Reddit's `www.reddit.com` did.
 *
 * ## Two frontends, one identifier
 *
 * Measured 2026-09-03 against a real signed-in session (see
 * `docs/linkedin-integration-design.md`, "Two frontends, one identifier", and
 * the comment on #303). LinkedIn serves two structurally different
 * frontends and this module has to work on both:
 *
 * - The feed (`/feed/`) is server-driven UI ("SDUI"), React underneath
 *   (`data-testid="mainFeed"` on its root). A post is addressed only by
 *   `data-sdui-anchor-id="feed-header-<opaque>-<uuid>"`, a render-scoped
 *   token that changes on reload - not a stable identifier. `data-urn`,
 *   `data-id` and `data-view-name` do not exist anywhere on the feed. The
 *   activity URN is not reachable there at all: not in the DOM, not in any
 *   shadow root, not in an inline script, and not through React's fiber or
 *   memoized props.
 * - A post detail page (`/feed/update/urn:li:activity:<id>/`) is the older
 *   Ember stack: `div[role="article"][data-urn]` carries the activity URN,
 *   `article[data-id]` carries each comment's URN, `data-view-name` is
 *   present, and the comment composer is a `contenteditable` with
 *   `role="textbox"`.
 *
 * So `readPostIdentifier` never invents a URN for a feed post - it reports
 * which frontend it read (`PostIdentifier.frontend`) and what kind of
 * identifier that frontend actually exposes (`PostIdentifier.kind`), rather
 * than assuming a URN exists everywhere the way a single `readPostUrn` name
 * would imply.
 *
 * ## Selector health
 *
 * Every accessor below calls `record()` after it runs, noting a match or a
 * miss against the page kind it was actually called on (`detectPageKind`).
 * `getSelectorHealthReport()` returns the aggregate, and
 * `selectorHealthActivityEvents()` shapes any current misses as the
 * `ActivityEvent` objects `lib/log-from-content.ts` already knows how to
 * forward. This module does not call `logFromContent` itself (it has no
 * chrome-extension-API dependency at all, matching `reddit-dom.ts`), so a
 * consuming content script decides when to drain and log the report.
 * The failure mode this
 * exists to catch is silent breakage, not breakage itself: an assistant that
 * quietly stops finding posts looks identical to a quiet week on LinkedIn.
 *
 * ## What is checked against a real capture, and what is not
 *
 * No browser signed into LinkedIn is available in this environment.
 * `findFeedPosts`, `readPostIdentifier`, `readPostAuthor` and `readPostText`
 * are exercised against the anonymised real captures in
 * `extension/tests/content/fixtures/linkedin/` (see that directory's
 * README for how they were made). `findCommentSubmitButton`,
 * `findPostComposer` and `readOwnProfileHandle` reach past what either
 * capture rendered - the captured comment box has no text typed into it yet,
 * so LinkedIn has not rendered a submit control for it; the post composer
 * only exists once its modal is open; the global identity nav sits outside
 * the captured root (`main`/`[data-testid="mainFeed"]`) - so those three are
 * exercised only against synthetic markup in the test suite, the same
 * disclaimer `reddit-dom.ts` carries for its own untested shadow-DOM
 * fallback. Follow-up: recapture with a typed draft and an open post
 * composer once a live session is available.
 */

/** Page kinds this module knows how to read. `detectPageKind` never guesses past what it can verify. */
export type LinkedInPageKind = 'feed-sdui' | 'post-detail-classic' | 'unknown';

/**
 * A post's identifier, honest about which frontend produced it. Only the
 * classic frontend's `kind: 'urn'` value is a stable, dedupable identifier;
 * the SDUI frontend's `kind: 'render-anchor'` value changes on reload and
 * must not be treated as one (see "Two frontends, one identifier" above).
 */
export type PostIdentifier =
  | { frontend: 'post-detail-classic'; kind: 'urn'; value: string }
  | { frontend: 'feed-sdui'; kind: 'render-anchor'; value: string }
  | { frontend: LinkedInPageKind; kind: 'none'; value: null };

export type PostAuthor = { name: string | null; handle: string | null };

/** One entry per underlying selector attempt, matching the design's "per selector, per page kind" self-check. */
export type LinkedInSelectorId =
  | 'feedPost'
  | 'postIdentifier'
  | 'postAuthor'
  | 'postText'
  | 'commentComposer'
  | 'commentSubmitButton'
  | 'postComposer'
  | 'ownProfileHandle'
  | 'postComments'
  | 'commentAuthor'
  | 'commentBody'
  | 'commentTimestamp';

export type SelectorHealthEntry = {
  selector: LinkedInSelectorId;
  pageKind: LinkedInPageKind;
  matches: number;
  misses: number;
  lastResult: 'match' | 'miss';
  lastCheckedAt: string;
};

/**
 * Breadth-first search of every open shadow root reachable from `root`,
 * collecting `selector` matches found inside each one. Does not include
 * matches in `root`'s own light DOM (callers try that first as the fast path).
 */
function queryAllInShadowRoots(selector: string, root: ParentNode): Element[] {
  const found: Element[] = [];
  const queue: ParentNode[] = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const el of Array.from(current.querySelectorAll('*'))) {
      const shadow = el.shadowRoot;
      if (!shadow) continue;
      found.push(...Array.from(shadow.querySelectorAll(selector)));
      queue.push(shadow);
    }
  }
  return found;
}

/**
 * Shadow-DOM-aware query: try the plain query against `root` first (the fast
 * path, works for every markup this module has actually seen), then fall
 * back to a breadth-first search through any open shadow roots reachable
 * from `root`.
 */
export function queryDeep<T extends Element = Element>(
  selector: string,
  root: ParentNode = document,
): T | null {
  const direct = root.querySelector(selector);
  if (direct) return direct as T;
  const [first] = queryAllInShadowRoots(selector, root);
  return (first as T | undefined) ?? null;
}

/**
 * Same idea as `queryDeep`, but returns every match instead of the first:
 * light-DOM matches on `root` first, then matches found inside any open
 * shadow roots reachable from `root` (breadth-first).
 */
export function queryDeepAll<T extends Element = Element>(
  selector: string,
  root: ParentNode = document,
): T[] {
  const direct = Array.from(root.querySelectorAll(selector)) as T[];
  const inShadow = queryAllInShadowRoots(selector, root) as T[];
  return [...direct, ...inShadow];
}

/** `queryDeep`, but also matching `root` itself - useful once a caller already has the post element in hand. */
function selfOrQueryDeep<T extends Element = Element>(root: Element, selector: string): T | null {
  if (root.matches(selector)) return root as T;
  return queryDeep<T>(selector, root);
}

const health = new Map<string, SelectorHealthEntry>();

function record(selector: LinkedInSelectorId, pageKind: LinkedInPageKind, matched: boolean): void {
  const key = `${selector}:${pageKind}`;
  const prev = health.get(key);
  health.set(key, {
    selector,
    pageKind,
    matches: (prev?.matches ?? 0) + (matched ? 1 : 0),
    misses: (prev?.misses ?? 0) + (matched ? 0 : 1),
    lastResult: matched ? 'match' : 'miss',
    lastCheckedAt: new Date().toISOString(),
  });
}

/** Snapshot of every selector this module has attempted since the last reset. */
export function getSelectorHealthReport(): SelectorHealthEntry[] {
  return Array.from(health.values());
}

/** Clears accumulated selector-health state. Content scripts call this per navigation; tests call it per case. */
export function resetSelectorHealth(): void {
  health.clear();
}

/**
 * Shapes any selector currently reporting a miss into the `ActivityEvent`
 * payload `lib/log-from-content.ts` forwards to the service worker, at warn
 * level as the design specifies. Pure and side-effect free: the caller
 * decides whether and when to actually forward these through
 * `logFromContent`.
 */
export function selectorHealthActivityEvents(
  report: SelectorHealthEntry[] = getSelectorHealthReport(),
): Array<Omit<ActivityEvent, 'id' | 'ts'>> {
  return report
    .filter((entry) => entry.lastResult === 'miss')
    .map((entry) => ({
      level: 'warn',
      source: 'linkedin-dom',
      message: 'activity.linkedin-dom.selector-miss',
      messageParams: {
        selector: entry.selector,
        pageKind: entry.pageKind,
        misses: entry.misses,
        matches: entry.matches,
      },
    }));
}

/**
 * Which of the two frontends `root` is showing, from attributes LinkedIn
 * itself renders differently between them (see module header). Returns
 * `'unknown'` rather than guessing when neither shows up - callers must not
 * treat that as "feed" or "detail" by default.
 */
export function detectPageKind(root: ParentNode = document): LinkedInPageKind {
  if (queryDeep('[data-testid="mainFeed"]', root) || queryDeep('[data-sdui-anchor-id]', root)) {
    return 'feed-sdui';
  }
  if (queryDeep('[data-view-name]', root) || queryDeep('[role="article"][data-urn]', root)) {
    return 'post-detail-classic';
  }
  return 'unknown';
}

function parseProfileHandle(href: string | null | undefined): string | null {
  if (!href) return null;
  const match = href.match(/\/in\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Every rendered post card under `root`, for whichever frontend it is.
 *
 * - Classic: `[role="article"][data-urn]` directly (there is exactly one on
 *   a post detail page; the selector still works if that ever changes).
 * - SDUI feed: every `[data-sdui-anchor-id^="feed-header-"]` element's
 *   nearest `[role="listitem"]` ancestor, deduplicated. A repost can carry
 *   two header anchors sharing one card (the resharer's and the original
 *   author's), which is why dedupe is by container, not by anchor count.
 *   Some feed cards render with no `feed-header-` anchor at all (an embedded
 *   quote-repost, or occasionally none) - those are not returned, because
 *   there is no LinkedIn-authored attribute left to find them by; this is a
 *   real, measured gap, not an oversight.
 */
export function findFeedPosts(root: ParentNode = document): Element[] {
  const pageKind = detectPageKind(root);
  let posts: Element[] = [];
  if (pageKind === 'post-detail-classic') {
    posts = queryDeepAll<Element>('[role="article"][data-urn]', root);
  } else if (pageKind === 'feed-sdui') {
    const headers = queryDeepAll<Element>('[data-sdui-anchor-id^="feed-header-"]', root);
    for (const header of headers) {
      const container = header.closest('[role="listitem"]');
      if (container && !posts.includes(container)) posts.push(container);
    }
  }
  if (pageKind !== 'unknown') record('feedPost', pageKind, posts.length > 0);
  return posts;
}

/**
 * `post`'s identifier, honest about which frontend it came from. `root`
 * (defaults to `post`'s document) is only used to classify the page kind;
 * pass it explicitly in a test that builds a detached fragment.
 */
export function readPostIdentifier(
  post: Element,
  root: ParentNode = post.ownerDocument ?? document,
): PostIdentifier {
  const pageKind = detectPageKind(root);
  if (pageKind === 'post-detail-classic') {
    const value = selfOrQueryDeep(post, '[data-urn]')?.getAttribute('data-urn') ?? null;
    record('postIdentifier', pageKind, value !== null);
    return value === null
      ? { frontend: pageKind, kind: 'none', value: null }
      : { frontend: pageKind, kind: 'urn', value };
  }
  if (pageKind === 'feed-sdui') {
    const anchor = selfOrQueryDeep(post, '[data-sdui-anchor-id^="feed-header-"]');
    const value = anchor?.getAttribute('data-sdui-anchor-id') ?? null;
    record('postIdentifier', pageKind, value !== null);
    return value === null
      ? { frontend: pageKind, kind: 'none', value: null }
      : { frontend: pageKind, kind: 'render-anchor', value };
  }
  return { frontend: 'unknown', kind: 'none', value: null };
}

/**
 * `post`'s author, name plus vanity handle where LinkedIn exposes one.
 *
 * - SDUI feed: the `[data-sdui-anchor-id^="feed-header-"]` element's own
 *   text content is the display name (verified against the capture: exactly
 *   the name, no surrounding noise), and its nearest `<a href>` ancestor
 *   carries the profile link.
 * - Classic: no `data-*` attribute anchors the byline name. The one stable
 *   structural marker is the `aria-hidden="true"` span next to the visible
 *   name span - it exists so a screen reader is not handed the name twice,
 *   so it appears exactly once per byline link and nowhere else this early
 *   in the post (verified against the capture).
 */
export function readPostAuthor(
  post: Element,
  root: ParentNode = post.ownerDocument ?? document,
): PostAuthor {
  const pageKind = detectPageKind(root);
  if (pageKind === 'feed-sdui') {
    const nameEl = selfOrQueryDeep(post, '[data-sdui-anchor-id^="feed-header-"]');
    const name = nameEl?.textContent?.trim() || null;
    record('postAuthor', pageKind, name !== null);
    return { name, handle: parseProfileHandle(nameEl?.closest('a')?.getAttribute('href')) };
  }
  if (pageKind === 'post-detail-classic') {
    const nameEl = queryDeep<HTMLElement>('a[href] [aria-hidden="true"]', post);
    const name = nameEl?.textContent?.trim() || null;
    record('postAuthor', pageKind, name !== null);
    return { name, handle: parseProfileHandle(nameEl?.closest('a')?.getAttribute('href')) };
  }
  return { name: null, handle: null };
}

const MIN_SUBSTANTIAL_TEXT_LENGTH = 30;

/** Concatenation of `el`'s own direct text-node children only - not its descendants' text. */
function ownText(el: Element): string {
  let text = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? '';
  }
  return text.trim();
}

function isWithinExcludedRegion(el: Element, boundary: Element): boolean {
  let node: Element | null = el;
  while (node) {
    if (node.hasAttribute('data-id')) return true;
    if (
      node.getAttribute('role') === 'textbox' ||
      node.getAttribute('contenteditable') === 'true'
    ) {
      return true;
    }
    if (node === boundary) return false;
    node = node.parentElement;
  }
  return false;
}

/**
 * First substantial (>= 30 chars of its own direct text) leaf under `scope`
 * that is not screen-reader-hidden and not inside a comment (`[data-id]`) or
 * a composer (`[role="textbox"]`/`[contenteditable]`). Used as the classic
 * frontend's fallback for `readPostText`, where no `data-*` attribute marks
 * the post body at all.
 */
function firstSubstantialText(scope: ParentNode, boundary: Element): string | null {
  for (const el of queryDeepAll<Element>('span, p, div', scope)) {
    if (el.getAttribute('aria-hidden') === 'true') continue;
    if (isWithinExcludedRegion(el, boundary)) continue;
    const text = ownText(el);
    if (text.length >= MIN_SUBSTANTIAL_TEXT_LENGTH) return text;
  }
  return null;
}

/**
 * `post`'s visible body text.
 *
 * - SDUI feed: every `[data-sdui-anchor-id^="commentary-"]` element inside
 *   `post`, joined - LinkedIn's own instrumentation for the post's text
 *   blocks.
 * - Classic: no `data-*` attribute marks the post body either (see module
 *   header), so this falls back to `firstSubstantialText`, deliberately
 *   scoped away from comments and the composer.
 */
export function readPostText(
  post: Element,
  root: ParentNode = post.ownerDocument ?? document,
): string | null {
  const pageKind = detectPageKind(root);
  if (pageKind === 'feed-sdui') {
    const parts = queryDeepAll<Element>('[data-sdui-anchor-id^="commentary-"]', post)
      .map((el) => el.textContent?.trim() ?? '')
      .filter((s) => s.length > 0);
    const text = parts.length > 0 ? parts.join(' ') : null;
    record('postText', pageKind, text !== null);
    return text;
  }
  if (pageKind === 'post-detail-classic') {
    const text = firstSubstantialText(post, post);
    record('postText', pageKind, text !== null);
    return text;
  }
  return null;
}

/**
 * The open comment box under `root`, verified against the classic post
 * detail capture: a `contenteditable` with `role="textbox"`.
 */
export function findCommentComposer(root: ParentNode = document): HTMLElement | null {
  const pageKind = detectPageKind(root);
  const el = queryDeep<HTMLElement>('[contenteditable="true"][role="textbox"]', root);
  if (pageKind !== 'unknown') record('commentComposer', pageKind, el !== null);
  return el;
}

/**
 * The comment box's submit control under `root`. Primary selector is the
 * locale-independent `button[type="submit"]`, matching `reddit-dom.ts`'s own
 * primary strategy for the same kind of control. Unverified against a live
 * capture: the captured post-detail comment box has no text typed into it,
 * and LinkedIn does not render a submit control for an empty box, so a null
 * result there is the box's genuine (untyped) state, not evidence this
 * selector is broken. Exercised against synthetic "typed" markup in tests.
 */
export function findCommentSubmitButton(root: ParentNode = document): HTMLButtonElement | null {
  const pageKind = detectPageKind(root);
  const el = queryDeep<HTMLButtonElement>('button[type="submit"]', root);
  if (pageKind !== 'unknown') record('commentSubmitButton', pageKind, el !== null);
  return el;
}

/**
 * The "start a post" composer under `root`. Same underlying editor primitive
 * as `findCommentComposer` (see module header) - LinkedIn uses one rich-text
 * editor component for both. Unverified against a live capture: neither
 * fixture shows the post composer's modal open. The caller is expected to
 * scope `root` to the composer's own container once it has detected that
 * modal is open, exactly as it would for `findCommentComposer`.
 */
export function findPostComposer(root: ParentNode = document): HTMLElement | null {
  const pageKind = detectPageKind(root);
  const el = queryDeep<HTMLElement>('[contenteditable="true"][role="textbox"]', root);
  if (pageKind !== 'unknown') record('postComposer', pageKind, el !== null);
  return el;
}

/**
 * The signed-in member's own vanity handle. Unverified against a live
 * capture: LinkedIn's global identity nav sits outside both captured roots
 * (`main`/`[data-testid="mainFeed"]`). `<nav>` is the standard landmark
 * LinkedIn renders its global header inside; the member's own profile link
 * in it is the one self-referential handle on the page that does not depend
 * on which post is on screen.
 */
export function readOwnProfileHandle(root: ParentNode = document): string | null {
  const pageKind = detectPageKind(root);
  const link = queryDeep<HTMLAnchorElement>('nav a[href*="/in/"]', root);
  const handle = parseProfileHandle(link?.getAttribute('href'));
  if (pageKind !== 'unknown') record('ownProfileHandle', pageKind, handle !== null);
  return handle;
}

/**
 * A single rendered comment or reply on a post-detail page (#307). LinkedIn
 * renders a reply as a further `article[data-id]` nested directly inside
 * its parent comment's own article - verified against the real capture
 * (`extension/tests/content/fixtures/linkedin/post-detail.html`): each of
 * its 8 top-level comments contains exactly one nested reply article, and
 * no attribute distinguishes a top-level comment from a reply, only its
 * position in the tree does.
 */
export type LinkedInComment = {
  /** The comment's own URN (its `article`'s `data-id`). */
  id: string | null;
  author: PostAuthor;
  body: string | null;
  /**
   * LinkedIn's own relative-time text (e.g. "2 giorni", "1 day"), never a
   * machine timestamp: the real capture this module is verified against
   * shows every comment's `<time>` carrying no `datetime` attribute and no
   * title, only locale-dependent relative prose. A caller needing an
   * approximate absolute time must parse this itself and fall back to the
   * moment it observed the comment when parsing fails, rather than invent a
   * precision this module cannot supply (see
   * `linkedin-reply-ingest.ts`'s `approximateTimestamp`).
   */
  relativeTime: string | null;
};

/**
 * Every comment `article[data-id]` on a classic post-detail page, in
 * document order - both top-level comments and their nested replies (see
 * `LinkedInComment`'s doc comment). The SDUI feed has no comment markup at
 * all (see module header), so this returns `[]` there.
 */
export function findPostComments(root: ParentNode = document): Element[] {
  const pageKind = detectPageKind(root);
  const comments =
    pageKind === 'post-detail-classic'
      ? queryDeepAll<Element>('article[data-id^="urn:li:comment:"]', root)
      : [];
  if (pageKind !== 'unknown') record('postComments', pageKind, comments.length > 0);
  return comments;
}

/**
 * The comment `comment` is a reply to, when nested - the nearest ancestor
 * comment `article` strictly inside `root`. `null` for a top-level comment,
 * whose parent is the post itself rather than another comment (see
 * `docs/linkedin-integration-design.md`'s `comment_reply` vs `post_comment`
 * draft kinds - a caller resolving a top-level comment's parent needs the
 * post's own identifier from `readPostIdentifier`, not this function).
 */
export function findParentCommentId(comment: Element, root: ParentNode = document): string | null {
  let node = comment.parentElement;
  while (node && node !== root) {
    if (node.matches('article[data-id^="urn:li:comment:"]')) {
      return node.getAttribute('data-id');
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * `queryDeepAll` scoped to `comment` itself, excluding anything that
 * actually belongs to a reply nested inside it - a reply's own header/body
 * must never leak into its parent's reading, and `querySelectorAll` cannot
 * tell the two apart on its own since it descends through the nested
 * `article` unconditionally.
 */
function ownCommentDescendant<T extends Element = Element>(
  comment: Element,
  selector: string,
): T | null {
  const matches = queryDeepAll<T>(selector, comment);
  return matches.find((m) => m.closest('article[data-id^="urn:li:comment:"]') === comment) ?? null;
}

/**
 * `comment`'s author, name plus vanity handle. Verified against the real
 * capture: a comment's byline wraps the visible name in a plain `<span>`,
 * the first one inside the byline's `<h3>` - unlike a post's own byline,
 * where `readPostAuthor` reads an `aria-hidden="true"` duplicate instead
 * (that duplicate exists on a comment byline too, but wraps a badge
 * further along, never the name - the two bylines are not the same
 * structure). Scoped to `comment`'s own header via `ownCommentDescendant`,
 * never a nested reply's.
 */
export function readCommentAuthor(comment: Element, root: ParentNode = document): PostAuthor {
  const pageKind = detectPageKind(root);
  const nameEl = ownCommentDescendant<HTMLElement>(comment, 'h3 span');
  const name = nameEl?.textContent?.trim() || null;
  if (pageKind !== 'unknown') record('commentAuthor', pageKind, name !== null);
  return { name, handle: parseProfileHandle(nameEl?.closest('a')?.getAttribute('href')) };
}

/** `el`'s text, walking every descendant except `excluded` elements and any `<button>` - a comment's "…altro"/"see more" toggle sits inside the same `<section>` as its text and is chrome, not content; a message row's own sender link and timestamp are structural, not body text. */
function textExcluding(el: Element, excluded: ReadonlySet<Element> = new Set()): string {
  let text = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? '';
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as Element;
      if (!excluded.has(child) && child.tagName !== 'BUTTON')
        text += textExcluding(child, excluded);
    }
  }
  return text;
}

/**
 * `comment`'s body text.
 *
 * Verified against the real capture: the body sits inside a `<section>`.
 * A reply's section leads with the comment's own author name wrapped in an
 * `<a href="/in/...">` mention - an accessibility duplicate of the byline
 * in the one captured example, not a distinct "replying to X" chip (its
 * h3 byline carries the same name) - which this strips only when it
 * exactly matches the byline name already read via `readCommentAuthor`, so
 * a genuine @mention of somebody other than the comment's own author is
 * never silently eaten. A top-level comment's section carries no such
 * prefix in the captured example, so nothing is stripped there.
 */
export function readCommentBody(comment: Element, root: ParentNode = document): string | null {
  const pageKind = detectPageKind(root);
  const section = ownCommentDescendant<HTMLElement>(comment, 'section');
  let text = (section ? textExcluding(section) : '').trim();
  if (text) {
    const nameEl = ownCommentDescendant<HTMLElement>(comment, 'h3 span');
    const authorName = nameEl?.textContent?.trim();
    if (authorName && text.startsWith(authorName)) {
      text = text.slice(authorName.length).trim();
    }
  }
  if (pageKind !== 'unknown') record('commentBody', pageKind, text.length > 0);
  return text || null;
}

/**
 * `comment`'s own relative-time text - see `LinkedInComment.relativeTime`'s
 * doc comment for why this is never a machine timestamp.
 */
export function readCommentRelativeTime(
  comment: Element,
  root: ParentNode = document,
): string | null {
  const pageKind = detectPageKind(root);
  const timeEl = ownCommentDescendant<HTMLTimeElement>(comment, 'time');
  const text = timeEl?.textContent?.trim() || null;
  if (pageKind !== 'unknown') record('commentTimestamp', pageKind, text !== null);
  return text;
}

/** A single message event read off LinkedIn's messaging surface (#307). */
export type LinkedInMessageEvent = {
  participant: PostAuthor;
  body: string | null;
  relativeTime: string | null;
};

// How many ancestor levels findMessageEvents climbs from a <time> element
// looking for a profile link before giving up on that event's row. Bounded
// so a miss degrades to "this one event's row could not be read" instead of
// silently walking up to the whole conversation pane and mislabelling every
// message in it as one row.
const MESSAGE_ROW_SEARCH_DEPTH = 6;

/**
 * Every rendered message event on LinkedIn's messaging surface.
 *
 * Unlike every other accessor in this module, this is unverified against
 * ANY real capture, not merely against a typed/opened state the two
 * existing fixtures happen not to show (contrast the disclaimer on
 * `findCommentSubmitButton`/`findPostComposer`/`readOwnProfileHandle`
 * above): no signed-in session with an open conversation was ever
 * available, and no fixture exists for `/messaging` the way `feed.html`/
 * `post-detail.html` exist for the other two pages. Rather than a guessed
 * container hierarchy or a LinkedIn-internal class name (both ruled out by
 * this module's own anchoring policy above), this anchors only on the two
 * landmarks already verified stable elsewhere in this file: a `<time>`
 * element per event, and an `a[href*="/in/"]` profile link for whoever sent
 * it. Not wired into the selector-health self-check above: that mechanism
 * is scoped to `detectPageKind`'s two post frontends (see its own doc
 * comment), and the messaging surface is neither. Exercised only against
 * synthetic markup; needs a recapture with a real open conversation before
 * this disclaimer can be narrowed the way the other three were.
 */
export function findMessageEvents(root: ParentNode = document): LinkedInMessageEvent[] {
  const events: LinkedInMessageEvent[] = [];
  for (const time of queryDeepAll<HTMLTimeElement>('time', root)) {
    let row: Element | null = time.parentElement;
    for (let depth = 0; row && depth < MESSAGE_ROW_SEARCH_DEPTH; depth += 1) {
      if (queryDeep('a[href*="/in/"]', row)) break;
      row = row.parentElement;
    }
    const scope = row && queryDeep('a[href*="/in/"]', row) ? row : time.parentElement;
    if (!scope) continue;
    const link = queryDeep<HTMLAnchorElement>('a[href*="/in/"]', scope);
    const name = link?.textContent?.trim() || null;
    const relativeTime = time.textContent?.trim() || null;
    const excluded = new Set<Element>([time, ...(link ? [link] : [])]);
    let body = textExcluding(scope, excluded).trim();
    if (name && body.startsWith(name)) body = body.slice(name.length).trim();
    events.push({
      participant: { name, handle: parseProfileHandle(link?.getAttribute('href')) },
      body: body || null,
      relativeTime,
    });
  }
  return events;
}
