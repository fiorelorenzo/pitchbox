/**
 * Which theme the page the panel is standing on is drawn in (LOR-211, refines
 * D10 and D30).
 *
 * D10 held the in-page panel to a dark card on every page, so the human could
 * never mistake it for LinkedIn's own interface. That signal turned out to be
 * carried by the mark, the hairline, the geometry and the behaviour rather
 * than by the ground colour, and a black box on a light feed reads as foreign
 * instead of as ours. So the panel follows the host: light card on a light
 * page, dark card on LinkedIn's dark mode.
 *
 * **Never a LinkedIn class or attribute.** LinkedIn's own theme marker
 * (whatever it is called this quarter) is exactly the kind of selector #303
 * exists to stop us from depending on, and getting it wrong is invisible: the
 * panel would just be the wrong colour. What the panel reads instead is the
 * ground it is literally standing on, the first opaque background colour
 * walking up from `body`, which is a rendered fact rather than a name. Only
 * when the page paints nothing at all (every element transparent, which is
 * what a bare fixture or a jsdom document looks like) does it fall back to
 * the OS preference through `prefers-color-scheme`.
 */

export type HostTheme = 'light' | 'dark';

/**
 * Below this relative luminance the ground counts as dark. Deliberately not
 * 0.5: the two grounds this has to separate are nowhere near the middle
 * (LinkedIn's light feed is `#f4f2ee`, luminance ~0.89; its dark one is about
 * `#1b1f23`, luminance ~0.014), and a mid-grey page is better served by the
 * light card, whose text is near-black and therefore the safer default when
 * the answer is genuinely ambiguous.
 */
const DARK_LUMINANCE_MAX = 0.4;

/** One channel of the sRGB -> relative luminance transfer function (WCAG 2). */
function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * WCAG relative luminance of a computed `background-color`, or `null` when
 * the value is transparent or in a syntax this does not parse.
 *
 * Only `rgb()`/`rgba()` are parsed, in both the legacy comma form and the
 * modern space-separated one, because that is what `getComputedStyle` hands
 * back for a background colour in every engine this runs in. A page that
 * authors its background in `oklch()` or `color()` resolves to something this
 * returns `null` for, and the walk simply continues to the next ancestor -
 * which is the honest outcome, since guessing at a syntax would be worse than
 * falling through to the OS preference.
 */
export function backgroundLuminance(color: string): number | null {
  const match = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (!match) return null;
  const parts = match[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map((part) => Number.parseFloat(part));
  if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) return null;
  // A fully transparent background paints nothing, so it says nothing about
  // the ground: `rgba(0, 0, 0, 0)` is what every unpainted element computes
  // to, and reading it as black is how a light page ends up with a dark panel.
  const alpha = parts.length > 3 ? parts[3] : 1;
  if (!(alpha > 0)) return null;
  const [r, g, b] = parts;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * The theme of `doc`, from the first ancestor of `body` that actually paints
 * a background. `body` first and `documentElement` after it, which is the
 * order the page paints them in.
 */
export function detectHostTheme(doc: Document = document): HostTheme {
  const view = doc.defaultView;
  if (!view) return 'light';
  for (const el of [doc.body, doc.documentElement]) {
    if (!el) continue;
    const luminance = backgroundLuminance(view.getComputedStyle(el).backgroundColor);
    if (luminance === null) continue;
    return luminance < DARK_LUMINANCE_MAX ? 'dark' : 'light';
  }
  return view.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Calls `onChange` whenever the host's theme changes, and returns the
 * unsubscribe.
 *
 * A panel can be open across the flip: LinkedIn's dark-mode switch restyles
 * the page in place with no reload, and a panel that keeps its mount-time
 * ground until the human closes it is the visible half of this bug. The
 * observer watches attributes on `html` and `body` only (a theme switch is a
 * class or an inline custom property on one of those two, whatever it is
 * named), never the subtree, so a feed that mutates continuously does not
 * turn this into a hot loop.
 */
export function observeHostTheme(
  onChange: (theme: HostTheme) => void,
  doc: Document = document,
): () => void {
  const view = doc.defaultView;
  let current = detectHostTheme(doc);

  const check = () => {
    const next = detectHostTheme(doc);
    if (next === current) return;
    current = next;
    onChange(next);
  };

  let observer: MutationObserver | null = null;
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(check);
    const options: MutationObserverInit = {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
    };
    if (doc.documentElement) observer.observe(doc.documentElement, options);
    if (doc.body) observer.observe(doc.body, options);
  }

  // Covers the fallback branch above: a page that paints no background of its
  // own follows the OS, and the OS can change while the panel is open.
  const media = view?.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
  media?.addEventListener('change', check);

  return () => {
    observer?.disconnect();
    observer = null;
    media?.removeEventListener('change', check);
  };
}
