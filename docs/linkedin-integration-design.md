# LinkedIn platform integration - design

Status: approved 2026-09-03. Tracks epics #296 and #297, milestone `v1.5 - LinkedIn`. The two epics are "LinkedIn as an extension-mediated platform" and "In-page LinkedIn assistant" (fourth outreach platform, chosen after Reddit + Hacker News + Mastodon).

## Summary

Add LinkedIn as the fourth outreach platform, and with it a second, separate surface: an in-page assistant that suggests comments and posts inside linkedin.com while the human browses.

LinkedIn does not fit either adapter shape the codebase already has. Reddit is scraped server-side with Playwright and leans on the Chrome extension only to detect a send; Mastodon is a thin authenticated REST client with no extension at all. LinkedIn has no discovery API, no third-party comment API and no self-serve messaging API, and its User Agreement section 8.2 prohibits both scraping (explicitly including browser add-ons) and automated engagement. The only legitimate data plane is the human's own logged-in browser, driven by the human.

So the Chrome extension is not a complement to LinkedIn support. **The extension is the LinkedIn adapter.**

## Why LinkedIn is neither Reddit nor Mastodon

| Capability                      | Reddit             | Mastodon                    | LinkedIn                                                                                                                                  |
| ------------------------------- | ------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Target discovery                | Playwright scrape  | `GET /api/v1/timelines/tag` | No API at any tier                                                                                                                        |
| Comment on a third party's post | scrape + extension | `POST /api/v1/statuses`     | Not available: `r_member_social` is "granted to select developers only", `w_organization_social` only covers pages the member administers |
| Direct message                  | extension          | `direct` visibility status  | Partner programs only                                                                                                                     |
| Post to own profile             | scrape             | `POST /api/v1/statuses`     | `w_member_social`, self-serve via the "Share on LinkedIn" product, about 100 calls per day per member                                     |
| Read own notifications          | extension poll     | `GET /api/v1/notifications` | No API at any self-serve tier                                                                                                             |

Sources: LinkedIn's own developer docs for [getting access](https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access), [Share on LinkedIn](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin) and the [Comments API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api), plus LinkedIn Help on [prohibited software and extensions](https://www.linkedin.com/help/linkedin/answer/a1341387).

The asymmetry that decides the design: a restricted Reddit account costs a throwaway handle, a restricted LinkedIn account costs the user's professional identity, their connections and their message history. Taplio, which drove engagement through a Chrome extension holding the `li_at` session cookie, had its own company page restricted in LinkedIn's April 2025 enforcement wave, and its users reported warnings and temporary restrictions. That is the failure mode this design exists to avoid, and it is why the boundary below is written as a set of prohibitions rather than as guidance.

## The compliance boundary (hard rules)

These are non-negotiable and enforced in CI, not left to reviewer memory. Each one has a counterexample already in the codebase, which is the point: the existing Reddit code does these things legitimately for Reddit and must not be copied for LinkedIn.

1. **No LinkedIn session credential ever leaves the browser.** No `li_at`, no CSRF token, no `localStorage` or cookie read whose value is transmitted anywhere. Counterexample not to copy: `extension/src/content/chat-token.ts`, which reads Reddit's Matrix access token out of `localStorage` and forwards it to the service worker so the server-side poller can use it.
2. **No request to linkedin.com is ever initiated by Pitchbox.** The extension reads only the DOM the human's own navigation already rendered. No `fetch`, no `XMLHttpRequest`, no voluntary navigation, no background polling of a LinkedIn endpoint. This extends to a post's attached image: when image-aware suggestions are on, the pixels the assistant sees come from `chrome.tabs.captureVisibleTab` on the tab already open (`extension/src/background/capture-post-media.ts`, #569) - **capture the rendered tab, never fetch licdn** - not a `fetch` of the media's own licdn URL, which would be exactly the request this rule forbids. Counterexample not to copy: `extension/src/background/inbox-sync.ts`, which fetches `reddit.com/message/inbox.json` on a `chrome.alarms` schedule.
3. **No synthetic interaction.** Pitchbox never calls `.click()` on a LinkedIn control, never dispatches a synthetic submit, never submits on the human's behalf. It may insert text into a composer the human opened, in response to an explicit action by the human, and nothing more. The human presses LinkedIn's own button.
4. **No server-side automation of linkedin.com.** No Playwright, no headless browser, no stealth stack pointed at LinkedIn, in any edition, local or cloud.
5. **Direct messages are off.** The `dm` quota for LinkedIn ships at zero and there is no `linkedin-scout` scenario. Cold DM on LinkedIn requires either InMail or a connection request, and unsolicited connection-plus-pitch is the single behaviour most reliably associated with restriction.

CI enforcement (LI-11): a test over `extension/src/` that fails on a `fetch`/`XMLHttpRequest` whose URL mentions linkedin, on a cookie or session-storage read under a LinkedIn content script, and on a synthetic `.click()`/`dispatchEvent` targeting a LinkedIn control. A rule that only lives in a document is a rule that a future agent breaks while every test passes.

## Decisions (settled 2026-09-03)

1. **The extension is the adapter.** There is no server-side LinkedIn client in v1. `shared/src/platforms/linkedin/` holds URN parsing, candidate normalisation and mapping helpers, and no network code.
2. **Two planes, deliberately separate.** Asynchronous campaigns and in-page assistance are different subsystems that share only the ledger. A campaign run never talks to a browser; an in-page suggestion never goes through a campaign, a cron, a playbook or the MCP server.
3. **Scenarios (v1):** `linkedin-commenter` and `linkedin-poster` only. No scout, no DM.
4. **Reply detection:** none server-side. `NullReplyReader`, like Reddit. Replies and messages are ingested passively when the human is already looking at the relevant LinkedIn page.
5. **Accounts carry no credential.** A LinkedIn account row is an identity (vanity handle plus display name), not a secret. There is nothing to encrypt because there is nothing stored.
6. **The official API stays out of v1.** `w_member_social` would allow genuine auto-posting to the member's own profile, but it needs three-legged OAuth with a hosted redirect URI, which is exactly the infrastructure the Mastodon design deliberately avoided by pasting a token. Recorded as a spike, not built.
7. **Host permission is requested on demand.** `*://*.linkedin.com/*` is not added to `host_permissions`. It is granted through the existing `optional_host_permissions` path when the user turns the assistant on.

## Scenario mapping (draft.kind)

No new draft kind is needed. The four in `shared/src/quota-types.ts:4` already cover LinkedIn:

- `post_comment` -> a comment on somebody else's post, keyed by the post's `urn:li:activity:...`.
- `comment_reply` -> a reply to a comment on our own post, keyed by the comment's `urn:li:comment:(...)`.
- `post` -> a top-level feed post from the connected account.
- `dm` -> reserved, quota zero, no scenario produces one in v1.

## Architecture

### Plane 1: asynchronous campaigns

LinkedIn has no discovery API, so an asynchronous LinkedIn campaign has no targets unless the browser supplies them. That is what the observation buffer is for.

**Observation collection.** A content script on linkedin.com watches, through a `MutationObserver`, the feed and post pages the human is already scrolling. For each post that renders it records the stable identifiers LinkedIn puts in the markup (`data-urn`, `data-id`, `data-view-name`), the author's vanity handle, the visible text, and the timestamp. It initiates nothing. It posts batches to the server on a debounce.

**What that turned out to mean, measured 2026-09-04 (#365).** The paragraph above was written before anyone captured the real markup, and it is optimistic about the feed. LinkedIn serves two frontends: `/feed/` is server-driven UI where a post carries only `data-sdui-anchor-id`, a per-render token that changes on reload, while a post-detail page and a profile's recent-activity list are the older stack and do carry the activity URN. `observed_targets.external_id` is `NOT NULL` and is the dedup key, so a feed sighting has nothing honest to store: the collector that shipped (#302) reads feed cards for selector health and queues only URN-bearing ones.

The consequence is that the buffer fills from posts the human deliberately opens, not from scrolling, so the candidate volume this plane can offer a campaign is much smaller than this section assumed. The URN is not in the feed DOM, its shadow roots, an inline script, or React's props (searched twelve fiber levels up, seven object levels deep); it leaks only inside an already-rendered comment's `urn:li:comment:(activity:<id>,<id>)`. Reaching "copy link to post" through the card's overflow menu would need a synthetic click, which the compliance check fails the build on, correctly.

**Decided 2026-09-07 (#365): accepted as it is.** The feed contributes selector health and nothing else, and no further attempt is made to identify a feed post. Two consequences follow, and they are the point of writing this down. The **in-page assistant (plane 2) is LinkedIn's primary surface**, because it works on the post in front of the human and needs no candidate pool at all; the campaign path stays supported but secondary, working on however few posts the human happened to open. And **candidate volume is a function of the human's own navigation**, so a LinkedIn campaign that reports no candidates is behaving correctly rather than failing, and nothing in the product should treat an empty buffer as a fault.

The alternative that was considered and deliberately deferred: observing **people** from the feed, where `/in/<slug>/` is present and stable, making `observed_targets` a row per person instead of per post. It was not rejected on its merits, it was judged premature. It buys a list of authors worth presiding over, which the assistant could use to prioritise, but it does not restore campaign volume, since commenting still needs a post and the post still comes from the human's navigation. Revisit it once a real outreach loop has run end to end in a deployed environment (#287) and it is known whether the scarce thing is finding people or finding posts.

**Storage.** `staging_scout_candidates` cannot hold these: it is `run_id NOT NULL` with `onDelete: cascade` (`shared/src/db/schema.ts:283-290`), so a row cannot exist before the run that consumes it. A new table is required:

`observed_targets` - organization and project scoped, one row per `(platform_id, external_id)` with `onConflictDoNothing` for dedupe, carrying `author_handle`, `text`, `observed_at`, `url` and a `consumed_by_run_id`. Pruned by the existing retention loop (`daemon/src/retention.ts`) on a short window, because a LinkedIn post is not worth commenting on a week later anyway.

**Consumption.** A `linkedin_candidates` MCP tool drains the unconsumed rows for the run's project into `staging_scout_candidates` for that run, then the playbook proceeds exactly as `mastodon-commenter` does: read staging, score fit, draft, `run_finish`. The playbook contract, the finish-tool requirement in `shared/src/runlog/contract.ts` and the house-style invariant all stay untouched.

**Send.** The draft lands in the Inbox with a `composeUrl` pointing at the real LinkedIn post. The human opens it, the content script offers the drafted comment, the human presses LinkedIn's button, and the extension reports through the routes that already exist: `POST /api/extension/draft/[id]/armed` then `.../sent`. `isExtensionAutomated` (`web/src/lib/platforms/presenter.ts:57`) gains `linkedin`, which is accurate in the same limited sense it is accurate for Reddit: the extension detects the human's send, it does not perform it.

### Plane 2: in-page assistance, in real time

This plane does not create a campaign, does not schedule anything and does not run a playbook. It is a dedicated synchronous API.

`POST /api/extension/suggest`, authenticated by the existing device bearer token (`requireExtensionAuth`), org-scoped like every other extension route. Body: the observed post context plus the project to write as. Response: server-sent events streaming the suggestion as it is produced, so the panel shows text arriving instead of a spinner with nothing behind it.

**What produces the text.** A tool-calling agent loop, not a single turn:
`runSuggestion` (`web/src/lib/server/suggest.ts`) builds the prompt from the
project's voice profile, the post and the house-style rules, then drives up
to six steps against seven read-only tools declared once in
`shared/src/assist/tools.ts` - reading the thread, looking at an attached
image, the target's contact history, the operator's voice, project
knowledge, the operator's own prior takes, and a closing style check on the
draft - before the writing turn. Still no campaign, no cron, no playbook,
and still no `runs` row until the human accepts (see "Bookkeeping" below):
the loop is its own isolated tool surface, driven natively by whichever
runner backs the org (native tool calls on the SDK path, a dedicated
`pitchbox-assist-mcp` entry point on the ACP path), never the 26-tool
campaign MCP server. This keeps the product's authentication model intact
exactly as before - Pitchbox authenticates through the human's own `claude`
CLI subscription on the ACP path, and a required provider API key to run the
loop in-process on every edition would break self-hosting for the sake of a
faster first token - see the design of record,
[`docs/design/in-page-agent.md`](design/in-page-agent.md), for that argument
and the two alternatives it rejects. The same document owns the step and
budget contract (a soft budget past which the agent is told to answer with
what it has, a hard ceiling past which whatever draft text has already
streamed is what the operator gets rather than an error) and the tool
contracts and refusal shapes; this document does not restate them. The panel
narrates the loop through the same SSE `status` event it already used for a
bare "reading the post" line, one tool name at a time in plain language,
rather than a second channel.

**Bookkeeping, which is where the two planes touch.** A suggestion is ephemeral until the human accepts it. On accept, the server materialises a real `drafts` row so the ledger stays complete: blocklist and quota are evaluated through `evaluateDraftSend` exactly as on the campaign path, `contact_history` gets its row, and analytics counts it. `drafts.run_id` is `NOT NULL` (`shared/src/db/schema.ts:296-298`), so rather than making that column nullable the accept path creates a `runs` row of a new `kind = 'assist'` (project-targeted, no campaign), which also gives the assist path the token and cost accounting the `runs` table already carries. The `runs_kind_target_chk` constraint gains that kind.

The separation Lorenzo asked for holds where it matters: no cron, no campaign, no playbook, no MCP, a dedicated real-time endpoint. What is shared is the ledger, because a comment that Pitchbox helped write and that does not appear in quota, contact history or analytics is a hole in the product's own accounting.

**The surface itself** is a panel mounted into a shadow root on linkedin.com, so LinkedIn's stylesheet and ours cannot reach each other. Svelte and Tailwind are already in the extension bundle, and the token layer is already duplicated at `extension/src/sidepanel/app.css` (see `docs/design/DECISIONS.md` D2), but nothing in `extension/src/content/` renders any UI today: every existing content script only reads and writes fields that LinkedIn or Reddit already put on the page. This is a genuinely new surface, so it goes through the brief gate before any markup is written.

### Accounts

Seed a `linkedin` row in `platforms` (`shared/src/db/seed-core.ts`). Reuse `accounts` with `handle` as the vanity slug (`linkedin.com/in/<handle>`). No `instance_url`, no encrypted token, no migration: unlike Mastodon there is no credential, because authentication is the human's own browser session and it never leaves it. Connection is a confirmation step, not a secret: the extension reads the logged-in profile's own handle off the page and the dashboard asks the human to confirm it.

### Quota and blocklist

Quota defaults in `shared/src/db/seed-core.ts` `QUOTA_DEFAULTS`, and deliberately much tighter than the other platforms, because the constraint here is reputational rather than technical. Eight comments a day and thirty a week; one post a day and four a week; DM zero. These are defaults an operator can lower and, unlike the other platforms, the ceiling is not raisable past a hard cap in code: an account that comments forty times a day is indistinguishable from a bot to LinkedIn's velocity monitoring, and the product should not offer that setting.

Blocklist reuses the existing kinds: `user` for a vanity handle, `keyword` for post text. No LinkedIn-specific kind.

### Reply detection

`NullReplyReader` registered for `linkedin` in `daemon/src/reply-readers.ts`. When the human has their own post, their notifications or their messaging open, the content script reads what is already rendered and posts it to `POST /api/extension/dm-sync` with `platform: 'linkedin'`, which already takes the platform as a parameter. `matchIncomingCommentReplies` matches on `platformCommentId`, which for LinkedIn is the comment URN. This is weaker coverage than Reddit's polling by design: a reply that arrives while the human never opens LinkedIn is simply seen later, which is an acceptable cost for not issuing a single unrequested request.

### DOM fragility, the main engineering risk

LinkedIn ships obfuscated class names and runs layout experiments, so any selector written today is temporary. Mitigations:

- One module, `extension/src/content/shared/linkedin-dom.ts`, mirroring `reddit-dom.ts`. Every selector lives there and nowhere else.
- Anchor on the attributes LinkedIn uses for its own instrumentation (`data-urn`, `data-id`, `data-view-name`, `data-control-name`), never on generated class names.
- A selector-health self-check that reports, per selector, whether it matched on pages where it should have, into the extension activity log and up to the dashboard. The failure mode to prevent is not breakage, which is certain, but silent breakage: an assistant that quietly stops finding posts looks identical to a quiet week.

### Two frontends, one identifier (measured 2026-09-03, corrects the above)

The bullets above assume one LinkedIn. There are two, and the difference decides what passive observation can do.

The feed (`/feed/`) is now server-driven UI: `data-sdui-screen="com.linkedin.sdui.flagshipnav.feed.MainFeed"`, React underneath, and a post is addressed only by `data-sdui-anchor-id="feed-header-<opaque>-<uuid>"`. That token changes on reload, so it is a render address and not an identifier. None of `data-urn`, `data-id` or `data-view-name` exists on the feed at all. Measured against a real signed-in session: the activity URN is not in the feed DOM, not inside its shadow roots, not in any inline script, and not reachable through React's fiber or memoized props (twelve fiber levels up, seven object levels deep). It leaks in exactly one place, inside a rendered comment's `urn:li:comment:(activity:<id>,<id>)`, so only for a post that already has a comment on screen.

A post detail page (`/feed/update/urn:li:activity:<id>/`) is still the older Ember stack and behaves as the bullets assume: `div[data-urn]` carries the activity URN, `data-id` carries comment URNs, `data-view-name` is present, and the comment composer is a `contenteditable` with `role="textbox"`. The URN is also in the URL.

Both pages are captured as anonymised fixtures in `extension/tests/content/fixtures/linkedin/`, regenerable with `scripts/capture-linkedin-fixtures.mjs`.

**What this changes.** `observed_targets` dedupes on `(platform_id, external_id)`, and on the feed there is no `external_id` to dedupe on. Three ways out, and only one is acceptable:

1. Click each post's control menu to copy its permalink. That is no longer passive observation, it is synthesising clicks on LinkedIn, which the compliance boundary forbids outright.
2. Patch `window.fetch` in the main world and read LinkedIn's own SDUI payloads. Technically available and worse than the first: it is instrumenting their traffic rather than reading what the human is looking at, and the defensibility of this whole feature rests on the opposite.
3. Observe with an identifier only where one exists, which is the post the human opened.

Take the third. It is also what `docs/design/DECISIONS.md` D11 already decided for the panel, which anchors to the post the human acted on and nowhere else, so the two planes agree rather than fight. The practical shape: a feed sighting can still record author, text and timestamp for context, but it is not a dedupable target and must not create an `observed_targets` row; a post the human opens produces the row, with the URN as its `external_id`. The follow-up cost is that the candidate pool fills more slowly than a feed scrape would fill it, which is the correct trade given the alternative is one of the first two options.

### Plane 3: project sources, read once by a human, kept until the next visit (spike, 2026-09-08, #435)

Context: #398 gives a project a set of `project_sources` rows instead of one thing at a time, and #431's implementation (#466, in review) already reserves three kinds for LinkedIn - `linkedin_company`, `linkedin_profile`, `linkedin_post` (`shared/src/project-sources.ts`) - as values nobody implements yet. Neither plane above produces one of these: plane 1 fills `observed_targets` for a campaign to drain, plane 2 answers one live suggestion. A project source is a third shape again: a row that persists a description of something on LinkedIn for a project's context, the way `github_sources` persists a repo's README.

**The shape that passes every rule, proven against real pages 2026-09-08.** Nothing changes about who reads: the same architecture as plane 1's `linkedin-observe.ts` and LI-21's `linkedin-profile-capture.ts` - a content script registered host-wide, gated on `location.pathname`, reading only what the human's own navigation rendered and posting the result to our own backend. What is new is what it is for: instead of an ephemeral queue row or a live suggestion, it fills (or refreshes) one `project_sources` row's `output`.

Verified directly against real, signed-in LinkedIn pages rather than by reading the code and assuming: a throwaway MV3 content script (no repo code, no `fetch`, no click) loaded via `Extensions.loadUnpacked` over raw CDP against the `personal` `omp-chrome` profile, matched `https://www.linkedin.com/*`, gated on path, and read three real URLs purely from the rendered DOM:

- **Company** (a real company's `/company/<slug>/` overview page): the org name (`h1`), its LinkedIn tagline, industry, HQ location, follower count and headcount band, and the full "Overview" description paragraph. One post's activity URN also leaked onto this page, from the pinned/recent-post widget the overview tab embeds - unlike the plain feed, an overview page is not URN-free.
- **Profile** (a real third party's `/in/<slug>/`, not the operator's own): `[id$="Topcard"]` and `[data-testid="expandable-text-box"]` - the exact selectors `linkedin-dom.ts`'s `readOwnProfile` already uses for the operator's own persona - returned the same shape for someone else's public profile: name, headline, current employer, location, follower count and About text, unchanged.
- **Post** (a real `/feed/update/urn:li:activity:.../` permalink, reached from the URN the company page leaked above): `data-urn` on the article, the author, the relative timestamp, the full post body, and the reaction/comment/repost counts.

No prohibition was in tension with any of this. No request left the browser for linkedin.com or licdn once the extension's own backend call was made; nothing touched `document.cookie`, storage or `chrome.cookies`; nothing called `.click()` or dispatched a synthetic submit; nothing used `chrome.alarms` (a source refresh has no schedule to keep, see below); nothing under `shared/src/platforms/linkedin/` made a network call; and `https://www.linkedin.com/*` stayed the existing optional host permission this whole document already relies on. `pnpm run test:linkedin-compliance` needs no change for any of this: the spike ran a scratch extension outside the repo precisely so the checker's real scan set never had to move, and #436 builds inside that same scan set rather than widening it.

**1. Who initiates: the human, always - the dashboard cannot ask for a page that is not open.** Adding a source from the project page cannot make anything happen immediately, however the button reads. The one lawful trigger stays "the human's own navigation" (rule 2), and the dashboard is never the human looking at linkedin.com. So `createProjectSource(kind: 'linkedin_company' | 'linkedin_profile' | 'linkedin_post', config: { url })` from the project page creates a **pending** row only - `output: null`, `fetchedAt: null` - honestly reported as "waiting for you to open it," not "added." The fill happens the way plane 1 already fills `observed_targets`: the content script, on every LinkedIn page load, asks the server (a small `GET`, matching `linkedin-observe.ts`'s own assist-state poll) whether the page it just landed on matches a pending source for the operator's org - by vanity slug for `linkedin_company`, by handle for `linkedin_profile`, by activity URN for `linkedin_post` - and if it does, reads it exactly as the spike did and posts the result to fill that row. **The operator has to actually visit the company page, the profile or the post once**, the same way LI-9's send detection needs the human to open the post regardless of what a campaign wanted. A pending row nobody ever visits stays pending, and that is the honest state to show, not a spinner.

**2. What may be kept, and refreshing needs a second visit.** Rule 2 permits reading what the navigation rendered; it does not, on its own, say for how long the read may be kept. The line is the one this document's own `observed_targets` and Mastodon's reply detection already draw: a passive capture of a rendered page is not a credential and not a live feed, so keeping it as `project_sources.output` is the same category of thing `github_sources` already does for a README fetched over the real GitHub API - the difference is only _how_ the read happened, not whether keeping the result is allowed. There is nothing session-shaped to expire, because nothing here ever read a cookie or a token. A refresh is not automatic and cannot be, for the same reason the initial fill cannot be: no alarm, no poll of linkedin.com, no cron. A manual "refresh" on the dashboard can only clear `output`/`fetchedAt` and flip the row back to pending; it cannot itself fetch anything. **A LinkedIn source's staleness is bounded by the operator's own browsing habits, not by a schedule** - worth a "last read" date in the UI rather than an implied freshness the product cannot deliver.

**3. Which of the three kinds is actually reachable.** All three are, proven above, but not equally worth building in one pass. `linkedin_post` is strongest: `readPostIdentifier`'s classic-frontend path (already shipped for plane 1) already returns the URN this needs, and `readPostText`/`readPostAuthor` already exist - a source is exactly one already-observed post promoted to a standing row instead of a consumable one, no new selector work. `linkedin_profile` is second: the spike shows `readOwnProfile`'s selectors generalize to a third party's profile with zero changes - the "own" in the name was never a selector constraint, only a persona-capture policy choice enforced server-side by the `not_your_profile` guard, and a project source makes no such claim so it needs no such guard. `linkedin_company` is real but new work: no `linkedin-dom.ts` accessor reads an org page today, its markup (`org-top-card`, a follower/headcount-band pair, an "Overview" body) is unlike anything the module currently handles, and this document's own "Out of scope (v1)" already parked company pages once - for the official API, which needs Community Management partner approval. That objection does not reach a DOM read (nobody is calling that API), but the selector work is real and unstarted. **Worth building, but third**, after `linkedin_post` and `linkedin_profile` ship and its own selectors get written and fixture-tested the way the other two were.

**4. What the compliance checker would have to allow: nothing.** No rule needs relaxing, which is the finding worth stating plainly rather than discovering mid-implementation. The new code is a content script reading the DOM - rules 1-4 already permit exactly this shape, since it is the same shape `linkedin-observe.ts` and `linkedin-profile-capture.ts` already pass - plus a new server route (a `project-source-match` endpoint, matching `POST /api/extension/observations`'s own precedent) that is entirely outside `extension/src/` and therefore outside every rule's scan set already. If a later revision of any of the three kinds needs something the checker does not already allow - a click, a fetch toward linkedin.com, a cookie read - that is not a case to special-case past the checker; it is a case this design has already ruled out.

## What is NOT needed (vs Reddit and Mastodon)

No server-side HTTP client, no Playwright, no stealth stack, no credential storage, no encryption, no OAuth, no reply poller, no scout tool that fetches anything.

## Testing

- URN parsing and candidate normalisation: pure unit tests over captured markup fixtures, no live pages.
- `observed_targets` ingest: dedupe on repeat observation, org scoping, retention pruning.
- The compliance boundary: the CI check described above. This one is not optional and not conditional on a platform being present, because a check that can be skipped on some inputs is a check that reports green on the case it exists for.
- Scenario registry, quota defaults and presenter: the same assertions the Mastodon work added.
- The suggest endpoint: auth, org scoping, and that an accepted suggestion produces exactly one draft, one `assist` run, one quota decrement and one `contact_history` row.
- Selector health: fixtures for a matching page and a deliberately broken one, asserting the broken one reports rather than throws.

## Implementation breakdown (issues)

Two epics. Everything in the first is blocked on #288: no campaign run has ever produced a draft in a deployed environment, and a fourth platform on top of an unproven loop multiplies what has to be debugged at once. The second epic is not blocked, because in-page assistance does not use the campaign loop at all.

**Epic A - LinkedIn as an extension-mediated platform** (#296)

- **LI-1** (#298) design: this document.
- **LI-2** (#299) foundation: `linkedin` platform row, scenario registry (`SCENARIO_SLUGS`, `ScenarioPlatformSlug`, `SCENARIO_META`), quota defaults, web presenter, credential-free account model, connect UI. Single owner, because it is one edit across the enumerations.
- **LI-3** (#300) `observed_targets` table plus ingest service. Owns the migration, so it does not run concurrently with any other migration-authoring issue.
- **LI-4** (#301) `POST /api/extension/observations`. Depends on LI-3.
- **LI-5** (#302) the passive observation collector content script.
- **LI-6** (#303) `linkedin-dom.ts` plus selector-health reporting.
- **LI-7** (#304) `linkedin_candidates` MCP tool. Depends on LI-3.
- **LI-8** (#305) the `linkedin-commenter` and `linkedin-poster` playbooks.
- **LI-9** (#306) send detection on LinkedIn, reusing `armed`/`sent`.
- **LI-10** (#307) passive reply and message ingest through `dm-sync`.
- **LI-11** (#308) the compliance boundary, enforced in CI.
- **LI-12** (#309) docs page.
- **LI-22** (#319) spike: the official `w_member_social` API for own-profile posting. Recorded, deliberately not built in v1.

**Epic B - In-page LinkedIn assistant** (#297)

- **LI-13** (#310) the brief for the in-page surface, through the brief gate.
- **LI-14** (#311) the shadow-DOM panel host: Svelte mount, tokens, i18n.
- **LI-15** (#312) `POST /api/extension/suggest`: dedicated, synchronous, streamed.
- **LI-16** (#313) materialising an accepted suggestion into the ledger: the `assist` run kind, quota, contact history.
- **LI-17** (#314) in-page comment assist on the feed and on a post page.
- **LI-18** (#315) in-page post composer assist.
- **LI-19** (#316) assist settings: per-project binding, daily caps, kill switch.
- **LI-20** (#317) on-demand host permission grant.
- **LI-21** (#318) warm the assist session pool, if and only if first-suggestion latency proves to be a real problem.

Waves: LI-1 and LI-13 first. Then LI-2, LI-3, LI-14. Then LI-4, LI-5, LI-6, LI-15. Then LI-7, LI-8, LI-9, LI-10, LI-11, LI-16, LI-17, LI-20. Then LI-12, LI-18, LI-19, LI-21.

## Out of scope (v1)

Three-legged OAuth and the official Posts API (recorded as a spike). Direct messages, InMail and connection requests in any form. LinkedIn company pages, which need Community Management partner approval. Articles and newsletters. Sales Navigator. Any reading of LinkedIn data the human did not themselves navigate to.
