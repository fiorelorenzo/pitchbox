# Hacker News

Hacker News is Pitchbox's second outreach platform. It has no official auth API for outreach and no DM primitive, so Pitchbox never authenticates against it: the human signs in to news.ycombinator.com in their own browser, and Pitchbox only drafts text for the human to paste and submit.

## Setup

Add an HN account from **Projects → [project] → Accounts** with the platform `hackernews` and your `username`. No password or token is stored: HN provides no auth API for outreach, so Pitchbox only tracks the handle.

## What Pitchbox drafts

Two scenarios, each backed by its own playbook:

- **`hn-commenter`** (`playbooks/hn-commenter.md`) fetches candidate stories with `hn_search` and drafts `post_comment` replies on threads where the project genuinely adds value. Never a pitch.
- **`hn-poster`** (`playbooks/hn-poster.md`) studies the current front page, Show HN and Ask HN listings, then drafts 1-3 proactive top-level submissions (`kind: "post"`): a Show HN launch, an Ask HN question, or a plain text post.

Both playbooks call the same `hn_search` tool to fetch listings (`top` / `new` / `best` / `ask` / `show`, optionally filtered by a case-insensitive substring on title/text) from the public Firebase HN API (`hacker-news.firebaseio.com/v0`), and neither ever submits anything: the human reviews the draft in the inbox and posts it themselves.

## Compose URLs

The dashboard's "Open in HN" link is built server-side from the draft kind:

- `post_comment` / `comment_reply` drafts open `news.ycombinator.com/reply?id=<itemId>`, using the story id recorded in the draft's `metadata`.
- `post` drafts (from `hn-poster`) open `news.ycombinator.com/submit`. HN's submit form does not accept query-string prefill, so the human pastes the drafted title and body manually.
- `dm` never applies: HN has no DM primitive, and both playbooks are hard-forbidden from emitting one.

## Quota

Hacker News has no platform-specific entry in the seeded `quota_defaults`, so it falls back to the platform-agnostic defaults: 50/day and 200/week for comments, 5/day and 20/week for posts, 10/day and 50/week for DMs (never used, since HN drafts no DMs). An operator can change these from **Settings → Quota**.

## Limitations

- **No DMs.** The platform has none, so `hn-commenter` and `hn-poster` only ever produce `post_comment` and `post` drafts.
- **No reply tracking.** The daemon's reply poller only polls platforms with a registered reply reader, and Hacker News does not have one yet (not even the inert `NullReplyReader` used for Reddit): a comment or reply thread never auto-advances to `replied`.
- **Rate limits on the Firebase API are generous but undocumented.** The shared adapter caps every listing fetch at 100 items per call regardless of the requested limit.
