/**
 * DOM lookup helpers for Reddit's compose/comment controls, shared by the
 * content scripts (`dm-compose.ts`, `post-comment.ts`).
 *
 * Newer Reddit surfaces (www.reddit.com) are built from Shadow DOM custom
 * elements (the `shreddit-*` family). A plain `document.querySelector` cannot
 * see past an element's shadow boundary, so if a target ever moves inside a
 * shadow root, the old.reddit.com-style selectors below would return null
 * forever. `queryDeep`/`queryDeepAll` add a fallback that walks open shadow
 * roots breadth-first when the plain (fast-path) query misses. Closed shadow
 * roots are intentionally left unreached: `element.shadowRoot` is null for
 * those by spec, so there is nothing this fallback can pierce there, and it
 * does not attempt to.
 *
 * Checked against a real www.reddit.com thread on 2026-09-04 from a signed-in
 * session, which settled what the fixtures used to only guess at: a comment is a
 * light-DOM `shreddit-comment` element carrying `thingid`, `author`, `created`
 * and `permalink` attributes, and old.reddit.com's `.thing[data-fullname]`
 * markup is gone - that host now serves the same frontend, so there were zero
 * `[data-fullname]` nodes on the page. The compose controls do sit behind
 * shadow boundaries, so the fallback below stays. Regenerate the captured
 * fixture with `node scripts/capture-reddit-fixtures.mjs --cdp <endpoint>`.
 */

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
 * path, works for old.reddit.com-style markup), then fall back to a
 * breadth-first search through any open shadow roots reachable from `root`.
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

export function findComposeTextarea(): HTMLTextAreaElement | null {
  return (
    queryDeep<HTMLTextAreaElement>('textarea[name="text"]') ??
    queryDeep<HTMLTextAreaElement>('textarea[placeholder*="message" i]')
  );
}

export function findComposeSendButton(): HTMLButtonElement | null {
  const direct = queryDeep<HTMLButtonElement>('button[type="submit"]');
  if (direct) return direct;
  return (
    queryDeepAll<HTMLButtonElement>('button').find((b) =>
      /^send$/i.test(b.textContent?.trim() ?? ''),
    ) ?? null
  );
}

export function findCommentTextarea(): HTMLTextAreaElement | HTMLElement | null {
  return (
    queryDeep<HTMLTextAreaElement>('textarea[name="text"]') ??
    queryDeep<HTMLElement>('[contenteditable="true"][role="textbox"]')
  );
}

export function findCommentSubmitButton(root: ParentNode = document): HTMLButtonElement | null {
  return (
    queryDeepAll<HTMLButtonElement>('button', root).find((b) =>
      /comment|reply|post/i.test(b.textContent?.trim() ?? ''),
    ) ?? null
  );
}

/**
 * The `t1_...` thing id of the newest comment on this page authored by
 * `handle`, or null when there is none. This is how a sent comment draft learns
 * its own id: the page the human just commented on is the only place that id
 * exists for us, since Reddit's public JSON answers 403 to any server-side
 * fetch (#337).
 *
 * `notBeforeMs` guards the case that actually goes wrong: the account has
 * commented on this thread before, so "newest by us" is only our comment if it
 * is also newer than the moment we armed the send. Without it, an old comment
 * of ours would be recorded as the one just posted, and every reply to that old
 * comment would be attributed to this draft.
 */
export function findOurCommentId(
  handle: string,
  opts: { notBeforeMs?: number } = {},
): string | null {
  const wanted = handle.toLowerCase();
  let best: { id: string; createdMs: number } | null = null;
  for (const el of queryDeepAll<Element>('[thingid^="t1_"]')) {
    if ((el.getAttribute('author') ?? '').toLowerCase() !== wanted) continue;
    const id = el.getAttribute('thingid');
    if (!id) continue;
    // Reddit renders `created` as an ISO timestamp; treat an unparseable one as
    // "no evidence of when", which the notBeforeMs gate then rejects.
    const createdMs = Date.parse(el.getAttribute('created') ?? '');
    if (opts.notBeforeMs != null && !(createdMs >= opts.notBeforeMs)) continue;
    if (!best || (Number.isFinite(createdMs) && createdMs > best.createdMs)) {
      best = { id, createdMs: Number.isFinite(createdMs) ? createdMs : -Infinity };
    }
  }
  return best?.id ?? null;
}
