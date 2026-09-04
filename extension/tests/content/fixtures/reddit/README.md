# Reddit markup fixture

One anonymised capture of a real, signed-in `www.reddit.com` comment thread, for the
selector tests in `tests/content/reddit-dom.test.ts`. Regenerate with
`node scripts/capture-reddit-fixtures.mjs --cdp <endpoint>`, pointed at any Chrome signed
in to Reddit.

## Why it exists

`extension/src/content/shared/reddit-dom.ts` carried this note from the day it was
written until 2026-09-04:

> NOTE: no browser is available in this environment, so this fallback could not be checked
> against a live Reddit page. The jsdom fixtures in `tests/content/reddit-dom.test.ts` use
> synthetic shadow-DOM markup modeled on public knowledge of Reddit's web components, not
> a captured snapshot.

A selector suite built on a guess is green whether or not the selectors work, which is the
worst of both: it costs maintenance and proves nothing. This is the capture that note asked
for.

## What the capture settled

Three things the synthetic fixtures had wrong or unknowable:

- **A comment is a light-DOM `shreddit-comment` element**, not something behind a shadow
  boundary. It carries `thingid` (`t1_...`), `author`, `created` (ISO 8601), `permalink`,
  `depth` and `postid` (`t3_...`) as plain attributes. That is where `findOurCommentId`
  reads from, and it is the only place a sent comment's own id can be read: Reddit's
  public JSON answers 403 to any server-side fetch (#337).
- **old.reddit.com's `.thing[data-fullname]` markup is gone.** The captured page has zero
  `[data-fullname]` nodes, and `old.reddit.com` now serves the same frontend, so a
  selector written for the legacy DOM is dead code rather than a fallback.
- **The compose controls really are inside shadow roots** (221 open roots in this
  capture), so `queryDeep`/`queryDeepAll` earn their keep. The `<template
  data-fixture-shadow-root="open">` markers in the fixture are where a shadow root was,
  and the test re-attaches them as real shadow roots before querying.

## Anonymisation

The capture script keeps an attribute allowlist and drops everything else. Authors become
`first_author`…`fourth_author`, the capturing account becomes `fixture_owner`, every thing
id keeps its `t1_`/`t3_` shape and is renumbered, permalinks and `/user/` paths are
canonicalised, the subreddit becomes `fixture`, prose longer than 24 characters is replaced
with a fixed sentence, and images, hrefs and scripts are dropped.

Verify a regenerated capture before committing it. This is the audit that caught three
separate leaks while this fixture was being written (a handle inside an `aria-label`, a
bare base36 comment id inside `permalink`, and the subreddit name inside a screen-reader
label):

```bash
node -e '
const h = require("fs").readFileSync("extension/tests/content/fixtures/reddit/comment-thread.html","utf8");
for (const pat of [/your-handle/i, /redd\.it|redditmedia/i, /https?:\/\//i]) {
  const m = h.match(pat);
  console.log(String(pat), m ? "LEAK: " + h.slice(m.index - 25, m.index + 35) : "clean");
}'
```

Add the real handles, subreddit and thread id of whatever session produced the capture to
that list: the point is to check the values that were actually on the page, not the ones
that happened to be there in September 2026.


## compose-undeliverable.html (synthetic, not captured)

Unlike `comment-thread.html` above, this one is **not** a real capture. Issue #335
needed a fixture for Reddit's "you are unable to send a message request to this
account" DM-compose error before any live, signed-in Chrome endpoint was reachable
from the environment that wrote the detection code, so this file is hand-written -
modeled on the same `shreddit-*`/`faceplate-*` custom-element family and shadow-DOM
convention the capture above already verified, using the exact wording issue #335
quotes from a real session, but never checked against Reddit's live compose page.

`scripts/capture-reddit-fixtures.mjs --target compose --recipient <handle>` now
supports capturing the real thing (point `--recipient` at an account that has
already declined message requests from the signed-in session). Regenerate this
file with it and replace this section once that capture exists; until then, treat
`findUndeliverableReason`'s tests against this fixture as "the selectors read the
shape the issue describes", not "this is what Reddit currently renders".
