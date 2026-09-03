# LinkedIn platform integration - design

Status: approved 2026-09-03. Tracks the two epics "LinkedIn as an extension-mediated platform" and "In-page LinkedIn assistant" (fourth outreach platform, chosen after Reddit + Hacker News + Mastodon).

## Summary

Add LinkedIn as the fourth outreach platform, and with it a second, separate surface: an in-page assistant that suggests comments and posts inside linkedin.com while the human browses.

LinkedIn does not fit either adapter shape the codebase already has. Reddit is scraped server-side with Playwright and leans on the Chrome extension only to detect a send; Mastodon is a thin authenticated REST client with no extension at all. LinkedIn has no discovery API, no third-party comment API and no self-serve messaging API, and its User Agreement section 8.2 prohibits both scraping (explicitly including browser add-ons) and automated engagement. The only legitimate data plane is the human's own logged-in browser, driven by the human.

So the Chrome extension is not a complement to LinkedIn support. **The extension is the LinkedIn adapter.**

## Why LinkedIn is neither Reddit nor Mastodon

| Capability | Reddit | Mastodon | LinkedIn |
|---|---|---|---|
| Target discovery | Playwright scrape | `GET /api/v1/timelines/tag` | No API at any tier |
| Comment on a third party's post | scrape + extension | `POST /api/v1/statuses` | Not available: `r_member_social` is "granted to select developers only", `w_organization_social` only covers pages the member administers |
| Direct message | extension | `direct` visibility status | Partner programs only |
| Post to own profile | scrape | `POST /api/v1/statuses` | `w_member_social`, self-serve via the "Share on LinkedIn" product, about 100 calls per day per member |
| Read own notifications | extension poll | `GET /api/v1/notifications` | No API at any self-serve tier |

Sources: LinkedIn's own developer docs for [getting access](https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access), [Share on LinkedIn](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin) and the [Comments API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api), plus LinkedIn Help on [prohibited software and extensions](https://www.linkedin.com/help/linkedin/answer/a1341387).

The asymmetry that decides the design: a restricted Reddit account costs a throwaway handle, a restricted LinkedIn account costs the user's professional identity, their connections and their message history. Taplio, which drove engagement through a Chrome extension holding the `li_at` session cookie, had its own company page restricted in LinkedIn's April 2025 enforcement wave, and its users reported warnings and temporary restrictions. That is the failure mode this design exists to avoid, and it is why the boundary below is written as a set of prohibitions rather than as guidance.

## The compliance boundary (hard rules)

These are non-negotiable and enforced in CI, not left to reviewer memory. Each one has a counterexample already in the codebase, which is the point: the existing Reddit code does these things legitimately for Reddit and must not be copied for LinkedIn.

1. **No LinkedIn session credential ever leaves the browser.** No `li_at`, no CSRF token, no `localStorage` or cookie read whose value is transmitted anywhere. Counterexample not to copy: `extension/src/content/chat-token.ts`, which reads Reddit's Matrix access token out of `localStorage` and forwards it to the service worker so the server-side poller can use it.
2. **No request to linkedin.com is ever initiated by Pitchbox.** The extension reads only the DOM the human's own navigation already rendered. No `fetch`, no `XMLHttpRequest`, no voluntary navigation, no background polling of a LinkedIn endpoint. Counterexample not to copy: `extension/src/background/inbox-sync.ts`, which fetches `reddit.com/message/inbox.json` on a `chrome.alarms` schedule.
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

**Storage.** `staging_scout_candidates` cannot hold these: it is `run_id NOT NULL` with `onDelete: cascade` (`shared/src/db/schema.ts:283-290`), so a row cannot exist before the run that consumes it. A new table is required:

`observed_targets` - organization and project scoped, one row per `(platform_id, external_id)` with `onConflictDoNothing` for dedupe, carrying `author_handle`, `text`, `observed_at`, `url` and a `consumed_by_run_id`. Pruned by the existing retention loop (`daemon/src/retention.ts`) on a short window, because a LinkedIn post is not worth commenting on a week later anyway.

**Consumption.** A `linkedin_candidates` MCP tool drains the unconsumed rows for the run's project into `staging_scout_candidates` for that run, then the playbook proceeds exactly as `mastodon-commenter` does: read staging, score fit, draft, `run_finish`. The playbook contract, the finish-tool requirement in `shared/src/runlog/contract.ts` and the house-style invariant all stay untouched.

**Send.** The draft lands in the Inbox with a `composeUrl` pointing at the real LinkedIn post. The human opens it, the content script offers the drafted comment, the human presses LinkedIn's button, and the extension reports through the routes that already exist: `POST /api/extension/draft/[id]/armed` then `.../sent`. `isExtensionAutomated` (`web/src/lib/platforms/presenter.ts:57`) gains `linkedin`, which is accurate in the same limited sense it is accurate for Reddit: the extension detects the human's send, it does not perform it.

### Plane 2: in-page assistance, in real time

This plane does not create a campaign, does not schedule anything and does not run a playbook. It is a dedicated synchronous API.

`POST /api/extension/suggest`, authenticated by the existing device bearer token (`requireExtensionAuth`), org-scoped like every other extension route. Body: the observed post context plus the project to write as. Response: server-sent events streaming the suggestion as it is produced, so the panel shows text arriving instead of a spinner with nothing behind it.

**What produces the text.** A single-turn agent invocation with no playbook and no MCP server attached: the prompt is the project's voice profile, the post, and the house-style rules. One shot, no tool loop, no `runs` row driving it. This keeps the product's authentication model intact, which matters more than the last few seconds of latency: Pitchbox authenticates through the human's own `claude` CLI subscription, and introducing a required provider API key would break self-hosting for the sake of a faster first token. Expect five to ten seconds for the first suggestion, dominated by process spawn. If that proves too slow in real use, warm-session pooling is a recorded follow-up (LI-21), not a thing to build speculatively.

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

**Epic A - LinkedIn as an extension-mediated platform**

- **LI-1** design: this document.
- **LI-2** foundation: `linkedin` platform row, scenario registry (`SCENARIO_SLUGS`, `ScenarioPlatformSlug`, `SCENARIO_META`), quota defaults, web presenter, credential-free account model, connect UI. Single owner, because it is one edit across the enumerations.
- **LI-3** `observed_targets` table plus ingest service. Owns the migration, so it does not run concurrently with any other migration-authoring issue.
- **LI-4** `POST /api/extension/observations`. Depends on LI-3.
- **LI-5** the passive observation collector content script.
- **LI-6** `linkedin-dom.ts` plus selector-health reporting.
- **LI-7** `linkedin_candidates` MCP tool. Depends on LI-3.
- **LI-8** the `linkedin-commenter` and `linkedin-poster` playbooks.
- **LI-9** send detection on LinkedIn, reusing `armed`/`sent`.
- **LI-10** passive reply and message ingest through `dm-sync`.
- **LI-11** the compliance boundary, enforced in CI.
- **LI-12** docs page.

**Epic B - In-page LinkedIn assistant**

- **LI-13** the brief for the in-page surface, through the brief gate.
- **LI-14** the shadow-DOM panel host: Svelte mount, tokens, i18n.
- **LI-15** `POST /api/extension/suggest`: dedicated, synchronous, streamed.
- **LI-16** materialising an accepted suggestion into the ledger: the `assist` run kind, quota, contact history.
- **LI-17** in-page comment assist on the feed and on a post page.
- **LI-18** in-page post composer assist.
- **LI-19** assist settings: per-project binding, daily caps, kill switch.
- **LI-20** on-demand host permission grant.
- **LI-21** warm the assist session pool, if and only if first-suggestion latency proves to be a real problem.

Waves: LI-1 and LI-13 first. Then LI-2, LI-3, LI-14. Then LI-4, LI-5, LI-6, LI-15. Then LI-7, LI-8, LI-9, LI-10, LI-11, LI-16, LI-17, LI-20. Then LI-12, LI-18, LI-19, LI-21.

## Out of scope (v1)

Three-legged OAuth and the official Posts API (recorded as a spike). Direct messages, InMail and connection requests in any form. LinkedIn company pages, which need Community Management partner approval. Articles and newsletters. Sales Navigator. Any reading of LinkedIn data the human did not themselves navigate to.
