# LinkedIn markup fixtures

Anonymised captures of two real LinkedIn pages, for the selector tests in #303. Regenerate
with `node scripts/capture-linkedin-fixtures.mjs --cdp <endpoint>`, pointed at any Chrome
signed in to LinkedIn.

## What these files are, and why they are two

Captured 2026-09-03 from a signed-in session. They document a fact the LinkedIn design was
written without: **LinkedIn serves two different frontends, and only one of them exposes a
post identifier.**

|                       | `feed.html` (`/feed/`)                                                                     | `post-detail.html` (`/feed/update/urn:li:activity:<id>/`) |
| --------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Stack                 | server-driven UI, React (`data-sdui-screen="com.linkedin.sdui.flagshipnav.feed.MainFeed"`) | the older Ember stack                                     |
| `data-urn`            | 0                                                                                          | 1, the activity URN                                       |
| `data-id`             | 0                                                                                          | 16, comment URNs                                          |
| `data-view-name`      | 0                                                                                          | 1                                                         |
| `data-sdui-anchor-id` | 10                                                                                         | 0                                                         |
| comment composer      | absent                                                                                     | `contenteditable` plus `role="textbox"`                   |

On the feed a post is addressed only by `data-sdui-anchor-id="feed-header-<opaque>-<uuid>"`,
which is a per-render token and not an identifier: it changes on reload, so it cannot be a
dedupe key. The activity URN is not in the feed DOM, not inside its shadow roots, not in any
inline script, and not reachable through React's fiber or props (searched twelve fiber levels
up, seven object levels deep). The only place it leaks is inside a loaded comment's
`urn:li:comment:(activity:<id>,<id>)`, so it exists for a post that already has a comment
rendered and nowhere else.

The consequence for the backlog is recorded in `docs/linkedin-integration-design.md` under
"Two frontends, one identifier" and in the comments on #300, #302 and #303.

## What was stripped

Nothing personal survives capture, because these files sit in a public repo. The script keeps
an attribute allowlist and drops everything else, including class names, which are generated
and would rot the fixture anyway. Every name is mapped to a synthetic one, prose is replaced
with fixed filler, images become empty `<img>` slots, every `href` becomes
`/in/example-person/`, and the numeric part of every URN is renumbered to
`7000000000000000001`.

Audit a regenerated pair before committing it. This should print no names, no URLs, and no
long digit run other than the synthetic one:

```bash
cd extension/tests/content/fixtures/linkedin
grep -ocE 'https?://|licdn|\.jpg|\.png' feed.html post-detail.html   # expect 0
grep -ohE '[0-9]{10,}' feed.html post-detail.html | sort -u          # expect only 7000000000000000001
```

Names are the part a machine cannot fully check, so read the diff. The scrubber replaces
strings of two or more capitalised words, which catches a display name and misses a
single-word handle.
