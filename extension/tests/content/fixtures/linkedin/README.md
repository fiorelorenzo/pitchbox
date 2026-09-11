# LinkedIn markup fixtures

Anonymised captures of four real LinkedIn pages. Regenerate with
`node scripts/capture-linkedin-fixtures.mjs --cdp <endpoint>`, pointed at any Chrome signed
in to LinkedIn. Add `--profile <slug>` (the capturing account's own vanity slug) to also
(re)capture `own-profile.html`/`own-activity.html`, and `--only <file>` to regenerate a
single file without churning the others.

## What these files are

`feed.html` and `post-detail.html` were captured 2026-09-03, for the selector tests in
#303. They document a fact the LinkedIn design was written without: **LinkedIn serves two
different frontends, and only one of them exposes a post identifier.**

`own-profile.html` and `own-activity.html` were captured 2026-09-07, for the persona
capture in #389/#391. They document a second fact the original design was written
without: **the profile page (`/in/<slug>/`) is a third frontend, distinct from both of
the above, and it exposes no `h1`, no `data-view-name` and no canonical link at all.**

|                       | `feed.html` (`/feed/`)                                                                     | `post-detail.html` (`/feed/update/urn:li:activity:<id>/`) | `own-profile.html` (`/in/<slug>/`) | `own-activity.html` (`/in/<slug>/recent-activity/all/`) |
| --------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------- |
| Stack                 | server-driven UI, React (`data-sdui-screen="com.linkedin.sdui.flagshipnav.feed.MainFeed"`) | the older Ember stack                                     | server-driven UI, React            | the older Ember stack                                    |
| `data-urn`            | 0                                                                                          | 1, the activity URN                                       | 0                                    | 6, one per activity URN                                  |
| `data-id`             | 0                                                                                          | 16, comment URNs                                          | 0                                    | 0                                                          |
| `data-view-name`      | 0                                                                                          | 1                                                          | 0                                    | 1                                                          |
| `data-sdui-anchor-id` | 10                                                                                         | 0                                                           | 0                                    | 0                                                          |
| `<link rel="canonical">` / `og:url` | absent                                                                       | absent                                                     | absent                              | absent                                                    |
| `<h1>` for the person | absent                                                                                     | present (the human-readable body headline, not the person) | absent                              | absent                                                    |
| comment composer      | absent                                                                                     | `contenteditable` plus `role="textbox"`                   | n/a                                  | n/a                                                        |

On the feed a post is addressed only by `data-sdui-anchor-id="feed-header-<opaque>-<uuid>"`,
which is a per-render token and not an identifier: it changes on reload, so it cannot be a
dedupe key. The activity URN is not in the feed DOM, not inside its shadow roots, not in any
inline script, and not reachable through React's fiber or props (searched twelve fiber levels
up, seven object levels deep). The only place it leaks is inside a loaded comment's
`urn:li:comment:(activity:<id>,<id>)`, so it exists for a post that already has a comment
rendered and nowhere else.

The consequence for the backlog is recorded in `docs/linkedin-integration-design.md` under
"Two frontends, one identifier" and in the comments on #300, #302 and #303.

## own-profile.html: addressable only by id, and two layout variants

Measured 2026-09-07 against a real signed-in profile page: `document.querySelector('link[rel=canonical]')`
is null, there is no `<meta property="og:url">`, and there is no `<h1>` anywhere for the
person (the person's name is an `<h2>`). The only `<meta>` names present are `viewport`,
`como-t`, `como-err`, `trusted-types`, `storage-inventory`, `como-pk`. Every card this
frontend renders is addressable only by its own `id` - `com.linkedin.sdui.profile.card.ref<memberRef><CardName>`
for the topcard/about/experience-adjacent cards, `profileCards<Section><slug>` for the
cards below the fold - which is why the `id` attribute was added to the capture script's
keep-list 2026-09-07 (previously dropped like every other attribute not in the allowlist).
A profile-card id carries two identifiers that must not survive anonymisation, the member
ref and the vanity slug; both are scrubbed, and the card name suffix (`Topcard`, `About`,
`Activity`, ...) is kept because the selectors need it.

There are two layout variants of this page: with an Experience card
(`profileCardsExperienceOnly<slug>`, populated) and without one (the same id, present and
structurally rendered, but with zero `<li>` rows - its own sibling card is literally named
`profileCardsBelowActivityPart1WithoutExp<slug>`). **The account captured here renders the
"without" variant** - verified live, not just on this file: `[id*="profileCardsExperienceOnly"]`
on the real page is a non-trivial (4000+ character) rendered skeleton with `querySelectorAll('li').length === 0`
after scrolling past it and waiting for it to mount. `readOwnProfile`'s own doc comment in
`linkedin-dom.ts` covers the selector this reads and why an empty `experiences` array here
is a tested, legitimate outcome rather than a selector miss.

## own-activity.html: distinct urns, feed.html/post-detail.html: not

The id/URN-renumbering scrubber assigns each *distinct* digit run seen during one capture
its own synthetic number (`7000000000000000001`, `...0002`, ...), in first-seen order, so
`own-activity.html`'s six activity cards carry six distinct urns - the property that
matters for the server's dedupe, which is keyed on `external_id`. `feed.html` and
`post-detail.html` only ever contained one distinct digit run each (there is exactly one
real activity urn on a post-detail page, and the feed carries none at all), so they still
read `...0001` throughout; that is not a fixture bug, just a smaller capture.

## What was stripped

Nothing personal survives capture, because these files sit in a public repo. The script keeps
an attribute allowlist and drops everything else, including class names, which are generated
and would rot the fixture anyway. Every name is mapped to a synthetic one, prose is replaced
with fixed filler, images become empty `<img>` slots, every `href` becomes
`/in/example-person/`, and the numeric part of every URN/id is renumbered as described above.

Audit a regenerated or hand-scrubbed file before committing it. This should print no names, no
URLs, and no long digit run other than the renumbered ones:

```bash
cd extension/tests/content/fixtures/linkedin
grep -ocE 'https?://|licdn|\.jpg|\.png' *.html                      # expect 0
grep -ohE '[0-9]{10,}' *.html | sort -u                             # expect only 700...0001, 700...0002, ...
```

That first check is a paragraph, not a guarantee: LOR-252 found ten real `lnkd.in`
shortlinks, a real `x.com` handle and a real `pitchbox.app` URL sitting in the committed
fixtures for months, all of them in an anchor's link *text* rather than its `href` (which
scrubHref already rewrote), because the capture script's short-text branch let anything
under 24 characters through unscrubbed until #LOR-228 fixed it - and the fixtures already
committed were never re-scrubbed until then. `extension/tests/content/linkedin-fixture-links.test.ts`
is the runnable form of this check: it globs every file in this directory, and fails,
naming the file and the exact match, if any link resolves anywhere other than the
reserved, non-resolving `example.com` - not merely "anywhere that isn't linkedin.com",
since an `x.com` handle or a company domain is just as identifying as a real LinkedIn URL.
Run it (`pnpm exec vitest run extension/tests/content/linkedin-fixture-links.test.ts`)
after any hand edit or recapture; it also runs with the rest of the suite.

Names are the part a machine cannot fully check, so read the diff. The scrubber replaces
strings of two or more capitalised words, which catches a display name and misses a
single-word handle.
