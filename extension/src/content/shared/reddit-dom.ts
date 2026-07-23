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
 * NOTE: no browser is available in this environment, so this fallback could
 * not be checked against a live Reddit page. The jsdom fixtures in
 * `tests/content/reddit-dom.test.ts` use synthetic shadow-DOM markup modeled
 * on public knowledge of Reddit's web components, not a captured snapshot.
 * Follow-up: capture a real www.reddit.com DOM snapshot once a browser
 * environment is available and replay it as a fixture here.
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
