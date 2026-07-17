# Mastodon platform integration - design

Status: approved 2026-07-17. Tracks GitHub issue #128 (third outreach platform, chosen after Reddit + Hacker News).

## Summary

Add Mastodon as the third outreach platform. Unlike Reddit (Playwright-scraped, anonymous, extension-dependent for replies), Mastodon exposes an open REST API, so the adapter is a thin authenticated HTTP client: no Playwright, no stealth stack, no Chrome extension. Reply detection runs fully server-side in the daemon.

Pitchbox stays human-in-the-loop: the agent researches and drafts, the human approves. Sending is manual by default (like Reddit/HN); a campaign can opt in to auto-posting via the API on approval.

## Decisions (settled 2026-07-17)

1. **Send model:** manual by default; a per-campaign `autoPost` flag lets Pitchbox post via the API on approval. Both paths run through `evaluateDraftSend` (blocklist + quota) first.
2. **Auth:** per-account, paste an access token. An account carries its own `instanceUrl` + an access token created in that instance's developer settings, stored encrypted with `ENCRYPTION_KEY`. No OAuth callback infrastructure (YAGNI).
3. **Scenarios (v1):** all three, at parity with Reddit - `scout`->DM, `commenter`, `poster`.
4. **Reply detection:** a real server-side `MastodonReplyReader` (polls `/api/v1/notifications` for mentions). The daemon reply-poller, inert for Reddit, is real for Mastodon.
5. **Guardrails / tone:** conservative. The fediverse is hostile to cold marketing/DMs; playbooks prioritize genuine, contextual replies, discourage cold DMs, and respect `#nobot` and opt-outs. `#nobot` is a hard, non-configurable skip in the scout.

## Scenario mapping (draft.kind)

- `dm` -> a `direct`-visibility status mentioning the target (Mastodon "DM"; note it is not private/E2E).
- `comment` -> a reply status (`in_reply_to_id` = the target status), visibility public or unlisted.
- `post` -> a top-level public status (toot) with hashtags.

## Architecture

### Platform + accounts

- Seed a `mastodon` row in `platforms` (seed:core).
- Reuse the `accounts` table. Add an `instance_url` column; store the access token encrypted (reuse the existing encrypted-credential field or add one). `handle` is the fully qualified `@user@instance`. On connect, validate with `GET /api/v1/accounts/verify_credentials`.
- Connection UI: a Settings/Accounts form to paste instance URL + token, with instructions to create an app in the instance's dev settings.

### Adapter (`shared/src/platforms/mastodon/`)

- `types.ts`: Mastodon API shapes (Status, Account, Notification, Context).
- `client.ts`: fetch-based REST client, bearer token, honors `X-RateLimit-*` headers with backoff. Methods: `verifyCredentials`, `hashtagTimeline(tag, sinceId)`, `getStatus(id)`, `postStatus({status, inReplyToId?, visibility})`, `notifications({sinceId, types:['mention']})`.
- `scout.ts`: target discovery via hashtag timelines (Mastodon lacks reliable full-text search) plus keyword filtering, honoring the `#nobot` hard-rule (skip authors whose bio/fields contain `#nobot`/`nobot`), recency, and the blocklist.
- `reply-reader.ts`: `MastodonReplyReader implements ReplyReader` - reads mentions from `/api/v1/notifications` since the cursor, maps to `Reply[]` (`targetUser`, `at`, `preview`). Registered in the daemon's reply-reader registry for `mastodon` (real, not Null).
- `index.ts`: exports + registration.

### MCP tool surface

Mirror the Reddit/HN pattern: expose Mastodon actions as `mcp__pitchbox__mastodon_*` tools in `cli/src/mcp/server.ts` (backed by the adapter), so playbooks drive them. At minimum a scout/search tool and a post/reply tool; ids stay session-bound (never chosen by the agent), consistent with the existing surface.

### Send path (human-in-the-loop, two modes)

- **Manual (default):** draft -> approve -> a "Open on Mastodon" action (copies the text and opens the account's instance) -> "Mark as sent". No extension needed.
- **Auto-post (`autoPost` campaign flag):** on approve, Pitchbox calls `postStatus` (mapped visibility + `inReplyToId` for comments), stores the returned status id/URL, auto-marks the draft `sent`, and logs `contact_history`.
- Both run through `evaluateDraftSend` (blocklist + quota) before anything is sent.

### Reply matching

- On send, store the posted Mastodon status id on the draft (a new `platform_post_id` column, or reuse `platform_comment_id`). The reply-reader matches a mention whose `in_reply_to_id` equals our status id (or from the target user) -> draft `replied` + message recorded. Fully server-side in the daemon reply-poller (which becomes real for Mastodon).

### Quota + blocklist

- Quota: add `mastodon` to `quota_defaults` with conservative per-day/per-week limits for dm/comment/post. Per-account limits already supported.
- Blocklist: reuse kinds `user` (a `@handle`) and `keyword` (skip statuses containing it). `#nobot` is an implicit hard-rule in the scout, not a blocklist entry.

### Playbooks

Three conservative markdown playbooks driving the MCP tools: `mastodon-scout`, `mastodon-commenter`, `mastodon-poster`. Tone baked in: genuine/contextual replies, cold DMs discouraged, honor `#nobot` and opt-outs, soft rates.

## What is NOT needed (vs Reddit)

No Playwright/stealth, no anonymous-scrape env, no Chrome extension for Mastodon. Only authenticated REST.

## Testing

Unit tests with mocked `fetch` (no live API calls): the client (incl. rate-limit backoff), scout filtering (`#nobot`, blocklist, recency, keyword), reply-reader mapping, scenario->API mapping, the auto-post path, and quota/blocklist gating on the send path.

## Implementation breakdown (issues)

Sequenced with dependencies; most are file-disjoint for parallel execution once the foundation lands.

- **MAS-1 (foundation):** `mastodon` platform seed; account model (`instance_url` + encrypted token, migration); connect UI + `verify_credentials`.
- **MAS-2 (foundation):** Mastodon REST client + types (mock-fetch tested). Parallel with MAS-1.
- **MAS-3:** scout (hashtag-timeline discovery + `#nobot`/keyword/blocklist filtering) + `mastodon_scout` MCP tool. Depends on MAS-2.
- **MAS-4:** `MastodonReplyReader` + daemon registration for `mastodon`. Depends on MAS-2.
- **MAS-5:** send path - scenario->API mapping, manual + auto-post (per-campaign flag), `platform_post_id` migration + reply matching, `evaluateDraftSend` integration, post/reply MCP tool. Depends on MAS-1 + MAS-2.
- **MAS-6:** the three conservative playbooks. Mostly independent (drafts against the MCP tool names).
- **MAS-7:** quota defaults + blocklist handling for `mastodon`. Small, mostly independent.

Wave 1: MAS-1, MAS-2. Wave 2: MAS-3, MAS-4, MAS-5. Wave 3: MAS-6, MAS-7.

## Out of scope (v1)

OAuth flow (paste-token only), full-text search beyond hashtags, Mastodon-native polls/media, cross-instance account discovery beyond federation-visible timelines.
