# LinkedIn Member Data Portability - spike (LOR-246)

Status: spike, not approved. No implementation, no LinkedIn application created, no
access request submitted, no token generated. This document is the deliverable.

All LinkedIn documentation below was read on **2026-09-11**, starting from
`https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-3rd-party/`
and following it to the Snapshot, Changelog, and authentication references it links to. The
DMA API surface is versioned and moves (the 3rd-party page alone lists eleven monikers from
`li-dma-data-portability-unversioned` through `2026-08`); re-read every URL in the Sources
section before anything here gets built, not just before it ships.

## Corrections to the issue

The issue that opened this spike was written from a search on 2026-09-11 and gets two things
wrong. Both matter enough to state plainly rather than build around quietly.

1. **"EEA members only" is narrower than what LinkedIn actually says.** The Member Data
   Portability (3rd Party) product page does say "Only LinkedIn users from the European
   Economic Area are allowed to consent" - but three other LinkedIn sources, including the
   sibling Member Data Portability (Member) product page, all give a wider and mutually
   consistent scope: **EU, EEA, or Switzerland** ("Designated Countries" in LinkedIn's own
   terminology, which explicitly excludes the UK). The 3rd-party page's own wording looks like
   the outlier, not the other three. Treat the eligible set as EU/EEA/Switzerland, and confirm
   against a real consent screen before launch, because this is the one geography fact with
   three-to-one docs disagreement rather than one source repeated three times.
2. **"A token that expires after a year" conflates two different things that expire on two
   different schedules**, and the real shape is worse for an always-on integration than either
   framing alone suggests:
   - The **access token** LinkedIn issues is good for **60 days** (`expires_in: 5184000`
     seconds), per the general OAuth doc every DMA page defers to. It has to be refreshed well
     before then.
   - The **member's consent** is what lasts "up to 1 year before you will need to re-consent"
     (LinkedIn Help, cited below) - a re-authorization screen, not a token field.
   - Whether an application can refresh the 60-day access token **programmatically** (`POST
/oauth/v2/accessToken` with `grant_type=refresh_token`) for the full year, or whether it
     has to re-drive the member's browser through LinkedIn's OAuth prompt every 60 days, depends
     on a _third_, separately-gated feature - "Programmatic Refresh Tokens" - which LinkedIn's
     own doc says is available "for all approved Marketing Developer Platform (MDP) partners."
     Nothing in the DMA Portability docs states that a Member Data Portability (3rd Party)
     grant also carries this. See "What the docs do not say" below - this is the single fact
     most load-bearing for the recommendation, and it is unresolved.
   - Separately, the _stored data_ itself has no fixed retention cap under the legal terms for
     **Member** Portability Data: you may keep it "for so long as you have all necessary rights
     to do so," and must delete it immediately on the member's request or account closure. (A
     flat one-year storage cap does exist in the same terms, but it's scoped to Pages
     Portability "Standardized Data," a different program.) So "the token expires after a year"
     undersells what's actually true (access token: 60 days) and overclaims what isn't (a
     one-year data-deletion clock that the terms don't actually impose on Member data).

## 1. Which product and which scopes

**Member Data Portability (3rd Party)**, scope `r_dma_portability_3rd_party`. This is the
product that lets an application fetch a _different_ person's (the consenting member's) data;
its sibling, **Member Data Portability (Member)**, is a self-serve tool where a member builds
their own personal app against a LinkedIn-provided default Company Page and pulls a token by
hand from LinkedIn's own OAuth Token Generator in the Developer Portal - that shape doesn't fit
a multi-tenant product onboarding many operators, and the issue was right to reject it (it
doesn't reject it explicitly, but the shape only works for a single self-owned app).

Getting access to the 3rd-party product requires, in order: a LinkedIn Company Page, a
Developer Application tied to it, super-admin verification of that Company Page association,
and then a **Request access** click on the app's Products tab that opens a **business
verification form**: business email (verified by return email, personal addresses rejected),
organization's legal name, registered address, website, and privacy policy. This is the account
identity Pitchbox's application, not this spike, submits - not done here.

Two APIs come with the grant:

- **Member Snapshot API** (`GET https://api.linkedin.com/rest/memberSnapshotData?q=criteria`,
  fixed header `Linkedin-Version: 202312` regardless of which monthly version the rest of the
  product line is on) - a point-in-time dump of the member's historical data, domain by domain.
- **Member Changelog API** (`GET
https://api.linkedin.com/rest/memberChangeLogs?q=memberAndApplication`) - an incremental feed
  of the member's interactions from the moment they consented, capped to the **last 28 days**
  no matter how far back `startTime` asks.

Relevant Snapshot domains, from the full domain list (54 domains, most irrelevant here):
`MEMBER_SHARE_INFO` ("all shared or re-shared posts, including date, URL, shared comments, and
visibility status") and `ALL_COMMENTS` ("comments you've made, excluding those on posts in
Groups"). Neither domain's _field_ schema is documented beyond one worked example for a third
domain (`PROFILE`) - see "What the docs do not say" below.

## 2. Where the client lives, and the compliance question

### The existing rule, read precisely

`tests/compliance/linkedin-boundary.ts` did not do what the issue's summary of it implied.
Rule 1 (`checkNetworkTargets`) is called, in `checkAll`, against exactly one directory:
`extension/src` (`defaultRepoPaths().extensionSrcDir`). Rule 5
(`checkLinkedinPlatformNetworkCalls`) is called against exactly one other directory:
`shared/src/platforms/linkedin/`. Before this spike, **nothing scanned any other directory in
the repository for a fetch toward linkedin.com** - not `shared/src/` at large, not `cli/`, not
`web/`. That's not a bug in the six rules as written; each one does exactly what its own
fixture-tested fixture proves it does. But it means the honesty guarantee the docs state -
quoted below - was true of the repo as it stood only because no such client existed anywhere,
not because the checker would have caught one landing outside those two directories. A new
server-side client placed in, say, `shared/src/linkedin-dma/` would have passed CI silently,
by accident of scope rather than by a decision anyone made. That is exactly the failure mode
the issue warns against ("never a rule to relax quietly") - except here the risk isn't relaxing
an existing rule, it's a gap in what the rule ever covered.

### What a consented server call actually is

A member who explicitly authorizes Pitchbox through LinkedIn's own OAuth consent screen, after
which Pitchbox's server calls an API LinkedIn built for exactly this purpose, is not scraping by
any definition LinkedIn's own User Agreement or Portability API Terms use - scraping is
"access[ing] LinkedIn content outside the Portability APIs," which this by definition is not.
It is also not the thing every existing compliance rule and every existing doc sentence was
written to prohibit: those are about the _extension_ reaching into a page the human's browser
rendered, and about _linkedin-poster_/_linkedin-commenter_'s adjacent "no server-side automation
of linkedin.com, in any form" rule, itself scoped to Playwright/headless-browser automation of
the _site_, not an OAuth-authorized REST API pull. The two are genuinely different things.

But the current doc language does not say "the extension" - it says the product:

- `docs/voice.md:22-23` - _"The boundary that makes this safe: no code path in this product
  ever issues a request toward linkedin.com."_
- `docs/linkedin-integration-design.md:32` (compliance rule 2) - _"**No request to linkedin.com
  is ever initiated by Pitchbox.**"_
- `docs/linkedin-integration-design.md:41` (Decisions, item 1) - _"**The extension is the
  adapter.** There is no server-side LinkedIn client in v1."_
- `docs/platforms/linkedin.md:16` - _"**No request to linkedin.com is ever initiated by
  Pitchbox.**"_
- `docs/in-page-agent.md:15-16` - _"...that no code on either side ever issues a request toward
  linkedin.com or licdn."_
- `shared/src/platforms/linkedin/index.ts:1-6` (code comment, load-bearing) - _"nothing under
  shared/src/platforms/linkedin/ ever makes a network call, and never will - the whole point of
  this directory (design decision 1) is that LinkedIn has no server-side client in this
  product."_

If this design is ever implemented, every one of those six sentences becomes false as
literally written, and that is **Lorenzo's call, not this spike's** - the issue says so
explicitly, and it's right to. What this spike can do is say exactly where the line would need
to move: from "no request, ever, from anywhere in the product" to "no request from the
browser extension or from the LinkedIn platform adapter; a member-consented, OAuth-authorized
Data Portability client is the one named exception, and it never touches a LinkedIn session
credential, never automates the site, and lives in one auditable place." That's a real, weaker
claim than the current one, and a genuine reduction in what "no code path in this product" gets
to mean marketing-wise. (The public landing site, `pitchbox-landing`, is a separate repository
not checked out here; whoever implements this must audit its copy too before any wording
changes, and this spike did not.)

### Where the client goes, and the checker change that makes it a decision instead of an accident

`shared/src/platforms/linkedin/` is out, for two independent reasons: rule 5 forbids any
network code there unconditionally, and its own doc comment (quoted above) states as the
directory's entire reason for existing that it never will. Reusing it would mean either
breaking rule 5 or special-casing it, both worse than picking a new location.

The recommendation is a new top-level module, sibling to `shared/src/platforms/`,
`shared/src/mail/`, and `shared/src/stripe/` (an existing precedent for exactly this shape - a
third-party HTTP API with its own `client.ts`/`env.ts`): **`shared/src/linkedin-portability/`**.
Not nested under `platforms/`, on purpose - so it never reads as part of "the LinkedIn platform
adapter" whose entire premise this would otherwise contradict, and so a future reader scanning
directory names never has to re-derive the distinction between "the LinkedIn adapter" (browser
extension, no network, ever) and "the LinkedIn Data Portability client" (server, network,
member-consented, entirely separate concern) from a comment instead of from the layout.

Rather than leave that directory as one more place the checker doesn't happen to look - the
same accident that let rule 1/5's narrow scope pass silently until now - this spike adds a
**seventh compliance rule** that makes the exception explicit and enforced, demonstrated and
tested in this PR:

- **`checkRepoWideLinkedinNetworkTargets`** (`tests/compliance/linkedin-boundary.ts`) walks the
  _entire repository_ (every `.ts`/`.svelte` file, same exclusions as every other rule here) for
  a `fetch`/`XMLHttpRequest`/`sendBeacon` call whose target mentions `linkedin`/`licdn`, and
  fails on every one **except** inside `shared/src/linkedin-portability/`
  (`LINKEDIN_NETWORK_ALLOWLIST`). It is wired into `checkAll`, so it is now part of the same
  required CI check as the other six rules.
- Two new fixtures under `tests/compliance/fixtures/rule7-repo-wide-linkedin/` prove both
  directions with the identical call: one inside the allowlisted directory (passes), one
  outside it (flagged, rule 7, message names the allowlist).
- A third test confirms the real repo passes today with this rule alone - correctly, since the
  allowlisted directory doesn't exist yet. Nothing is implemented; the rule is reserved, not
  populated.
- Scanning the whole repository (rather than one fixed directory, like every other rule here)
  surfaced a real false positive the narrow rules never could have hit: the existing
  `linkedin`/`licdn` target regex matched `web/src/routes/settings/linkedin-assist/+page.svelte`'s
  own same-origin `fetch('/api/settings/linkedin-assist')`, because the string "linkedin" sits in
  Pitchbox's own route name, not in a LinkedIn host. Fixed in the same shared detector rule 1
  and rule 7 now both use (`isUnambiguousSameOriginPath`): a target whose source text is an
  unambiguous relative path (`'/...'`, not `'//...'` or an absolute URL) is never treated as a
  LinkedIn network call, regardless of what word appears later in the path. Rule 1 never hit
  this because nothing under `extension/src` happens to fetch a relative path containing
  "linkedin"; a repo-wide rule found it on its first real run.

This turns "a server-side client would have slipped past the existing rules by accident of
scope" into "a server-side client has exactly one place it is allowed to exist, and that
place is named in a test, not inferred." Verified locally: `pnpm run test:linkedin-compliance`

- 17 passed (was 15; +2 new tests for rule 7 itself, plus the existing "zero violations across
  the real repo" test now also covers it via `checkAll`), 4.06s.

## 3. The token model

A new table is needed - not a migration in this spike (none run), but named here for whoever
picks this up. `accounts` (the existing per-account credential table, e.g. Mastodon's
`instanceUrl`/`accessTokenEncrypted`) is scoped to `project_id`, because an outreach account
sends _as_ a specific identity on a specific project. A Data Portability connection is not
that: it feeds `operator_voice_samples`, which is scoped to `organization_id` directly, and
there is exactly one voice per organization, not one per project. So the new table -
tentatively `linkedin_portability_connections` - is organization-scoped, alongside
`operator_voice_samples`, not project-scoped like `accounts`:

- `organization_id` (FK, one row per org, like `operator_voice_samples`).
- `access_token_encrypted`, `refresh_token_encrypted` - same `iv:tag:ciphertext` packed format
  `shared/src/crypto.ts` already uses for Mastodon's token, same `ENCRYPTION_KEY`.
- `access_token_expires_at`, `refresh_token_expires_at` - both returned by the token exchange;
  refresh proactively, not on 401.
- `member_urn` - the `owner`/`actor` URN the Changelog/`memberAuthorizations` responses key on,
  needed to attribute a captured item back to the right org's operator.
- `changelog_cursor` - the last `processedAt` timestamp successfully consumed, per the
  Changelog docs' own recommendation (use the latest `processedAt` as the next `startTime`).
- `status` (`active` / `revoked` / `expired`) and `consent_granted_at`, `consent_expires_at`
  (~1 year out, for a "re-consent needed soon" UI notice - LinkedIn gives no push notification
  for this, see below).
- Revocable from the UI (Settings, alongside the existing extension-device revoke pattern), and
  from the CLI, mirroring the existing "not asking for a password, an identity" posture
  `docs/platforms/linkedin.md:48` already states for outreach accounts - this is different
  (data, not identity), but the "revocable, no silent retention past revoke" principle carries
  over directly from the legal terms' "delete immediately on request" clause.

**Consent revocation has no webhook.** A member can disconnect Pitchbox at any time from their
own LinkedIn settings (Settings & Privacy → Data privacy → Permitted Services), and Pitchbox
only learns about it the next time it calls the API and gets a 401 - there's a `GET/POST
.../rest/memberAuthorizations` FINDER that can be polled to check compliance-archiving status,
but nothing pushes a revoke event to us. **Degradation on any of these failure modes -
revoked, access token unrefreshable, consent lapsed past a year - must be silent and complete:
fall back to whatever corpus already exists (manual import, extension capture, or nothing),
never block a suggestion, and surface a plain "reconnect LinkedIn" notice in Settings the same
way an expired Mastodon token would.** This matches point 3's requirement exactly and costs
nothing new to build on top of the existing `recordVoiceSamples`/`importVoiceSamples` split,
neither of which has ever depended on a live connection to produce a suggestion.

## 4. The ingest path

Both APIs feed the exact same writer that already exists, `importVoiceSamples(db,
organizationId, platformId, items: ImportedVoiceItem[])`
(`shared/src/operator-profile.ts:246`) - the same function the CLI's `voice:import` and the
companion upload action already call, deduped on the same
`(organization_id, external_id)` unique index, tagged `source: 'import'` by that function
already. No third writer, matching the issue's explicit instruction, and matching what already
exists: `recordVoiceSamples` (source `capture`, the extension's passive DOM read) is a
different, unrelated path that stays exactly as it is.

Concretely: a connect-time **Snapshot** pull over the `MEMBER_SHARE_INFO` and `ALL_COMMENTS`
domains, converted to `ImportedVoiceItem[]` (`genre: 'post'`/`'comment'`, `text`, `url`,
`postedAt`, `context` for a comment's parent post) exactly like `voice-import.ts`'s CSV parser
already produces from the manual export - this is the "measured on day one" bulk fill the issue
wants. Then a recurring **Changelog** poll (see cost below) for anything created since
`changelog_cursor`, mapped the same way, keeping the corpus current with zero pages to visit.
`deriveExternalId`'s existing hashing scheme (`li-import-${genre}:${hash(url ?? '' + text)}`)
already produces a stable id from content alone, with no assumption baked in about _how_ the
row reached the pipeline - so a post captured by the extension, imported from a manual export,
and later also seen through the Snapshot/Changelog API would collide safely on the same row
without a fourth id scheme.

### What the docs do not say

Two real gaps, found by reading rather than assumed away:

1. **Neither Snapshot's `snapshotData` nor Changelog's `resourceName` has a published field
   schema for the domains this needs.** The Snapshot API reference shows exactly one worked
   response, for the `PROFILE` domain; `MEMBER_SHARE_INFO` and `ALL_COMMENTS` are named and
   described in one sentence each in the domain list, with no sample payload. The Changelog API
   reference documents the _envelope_ (`resourceName`, `resourceId`, `activity`,
   `processedActivity`, ...) with one worked example for a `messages` resource, and states
   flatly that `resourceName` is "name of resource being acted upon" with no enumeration of
   values - a web search turned up no third-party documentation of the actual values either (a
   community SDK, `@microfox/linkedin-member-data-portability`, wraps both endpoints without
   adding this). **The exact field mapping for both domains cannot be finalized from
   documentation alone; it needs a real sandbox response inspected once access exists**, which
   this spike deliberately does not obtain.
2. **Whether the 3rd-Party Data Portability grant carries "Programmatic Refresh Tokens"
   eligibility is not stated anywhere in the DMA docs.** If it does not, the 60-day access token
   cannot be refreshed by a background job at all - refreshing it requires re-driving the
   member's browser through LinkedIn's OAuth consent redirect (silent only if that browser
   session is still logged into linkedin.com), which is a fundamentally different, far more
   fragile operational shape than "polls quietly forever until the yearly re-consent." This is
   the single fact that would most change the recommendation below, and it can only be
   confirmed once a real application exists in LinkedIn's Developer Portal - which this spike
   does not create.

## 5. Non-EEA users

Unchanged, and this needs no new design: the existing upload path
(`voice-import.ts`/`voice-import-archive.ts`, the `pitchbox voice:import` CLI command, and the
`/companion/voice` upload form action) stays exactly as it is and remains the only path for
every operator outside EU/EEA/Switzerland - which, per the Digital Markets Act's own scope, is
most of the world - and for any EU/EEA/Switzerland operator who simply prefers a one-time
upload over standing consent. Nothing about this design deprecates or degrades it.

## 6. What it costs to run

LinkedIn's own Changelog guidance recommends polling **once per hour per member**, at
`count=10` (upper bound 50), specifically to avoid latency and QPS spikes on their side. That's
a new recurring job, one per connected organization, needing: a due-for-refresh check on the
access token (refresh comfortably before the 60-day mark, contingent on the programmatic-
refresh question above), the Changelog call itself with the stored cursor, mapping and writing
through `importVoiceSamples`, and per-connection failure isolation so one org's expired token or
LinkedIn outage never stalls another org's poll or the daemon's existing campaign scheduler -
the same posture `campaigns.consecutive_failures`/backoff already takes for a failing campaign,
worth mirroring rather than inventing a second failure-handling shape. This is a real, ongoing
operational surface: N organizations means N LinkedIn calls an hour, indefinitely, for as long
as each stays connected - not a one-time cost like the Snapshot pull or the manual upload.

## Recommendation

**Worth building, but not yet, and not as the next thing.** The case for it is real: EEA/EU
customers are a meaningful share of Lorenzo's stated market (Italian and international-but-
European), and a corpus that fills itself at connect time and stays current with no page to
visit is a materially better onboarding than a manual export a customer has to remember to
redo. But three things should be resolved before this is scheduled as an implementation issue,
not after:

1. **The programmatic-refresh question (point 4, gap 2) needs a real answer, not an
   assumption**, because it decides whether this is "connect once, stays current for a year"
   or "the member is quietly asked to re-authenticate in a browser roughly every two months" -
   the latter is a materially worse product than the manual upload it's meant to replace, since
   the upload at least only asks once. This can only be resolved by actually creating the
   LinkedIn application and inspecting what a real token exchange returns - which is the one
   step this spike was explicitly told not to take.
2. **The field-schema gap (point 4, gap 1) means the exact `ImportedVoiceItem` mapping can't be
   fully written until a sandboxed response exists to look at**, so any implementation issue
   should budget for that discovery as its own step, not assume the mapping is a known quantity
   going in.
3. **The wording change in section 2 is Lorenzo's decision to make explicitly**, before any
   code lands, not a side effect of the code landing - six sentences across five files (four in
   this repo, one in a separate repo not checked here) currently state an absolute claim this
   design would make conditionally true.

Given all three, the honest sequencing is: **this spike settles the shape (product, location,
token model, compliance mechanism); a follow-up issue does the LinkedIn application and the
two real-sandbox questions above as an explicit discovery step before committing to the ingest
mapping or the refresh architecture; only then does building the client become a normal
implementation issue.** Building the manual path "properly first" isn't the alternative here -
it already exists and is already the same writer this design reuses - so the real choice isn't
manual-vs-API, it's building the API integration now on documentation with two known holes, or
spending one more narrowly-scoped step closing those holes first. The second is worth the
delay.

## Sources

All read 2026-09-11.

- <https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-3rd-party/> - product overview, access request steps, business verification requirements, `r_dma_portability_3rd_party` scope, "European Economic Area" consent line.
- <https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-member/> - the sibling self-serve product, its own Company Page requirement, `r_dma_portability_self_serve` scope, "European Economic Area and Switzerland" consent line.
- <https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/shared/member-snapshot-api> - Snapshot API request/response shape, fixed `Linkedin-Version: 202312`, pagination, one worked `PROFILE` example.
- <https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/shared/member-changelog-api> - Changelog API request/response shape, 28-day window, hourly-poll/`count=10` recommendation, `memberAuthorizations` FINDER, undocumented `resourceName` enumeration.
- <https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/shared/snapshot-domain> - full Snapshot domain list, including `MEMBER_SHARE_INFO` and `ALL_COMMENTS`.
- <https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/recent-changes> - versioned changelog of domain additions/deprecations.
- <https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow> - 3-legged OAuth flow, 60-day access token (`expires_in: 5184000`), browser-redirect-based "seamless" refresh description.
- <https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens> - programmatic refresh token mechanism, 365-day refresh token TTL, eligibility stated as "approved Marketing Developer Platform (MDP) partners" - not stated to include DMA Portability partners.
- <https://www.linkedin.com/help/linkedin/answer/a519947/third-party-applications-data-use> - "up to 1 year before you will need to re-consent," Designated Countries scope, Permitted Services disconnect flow.
- <https://www.linkedin.com/help/linkedin/answer/a7149943> - "Designated Countries" defined as EU, EEA, and Switzerland (not the UK).
- <https://www.linkedin.com/help/linkedin/answer/a6214075> - "EU/EEA and Switzerland" restated for the Member portability APIs generally.
- <https://www.linkedin.com/legal/l/portability-api-terms> - Additional Terms for the DMA Portability API Programs: storage duration (Member Portability Data: while legal basis holds, delete on request/closure; Pages "Standardized Data": up to one year, a different program), scraping/"Non-Official Content" prohibition, suspension/termination terms.
- <https://github.com/microfox-ai/microfox/blob/main/packages/linkedin-member-data-portability/README.md> - third-party SDK wrapper, checked for an undocumented `resourceName` enumeration; found none.

Repository facts cited above (not LinkedIn documentation, read directly from this checkout on
2026-09-11): `docs/voice.md`, `docs/linkedin-integration-design.md`, `docs/platforms/linkedin.md`,
`docs/in-page-agent.md`, `shared/src/platforms/linkedin/index.ts`, `shared/src/voice-import.ts`,
`shared/src/voice-import-archive.ts`, `shared/src/operator-profile.ts`, `shared/src/crypto.ts`,
`shared/src/db/schema.ts` (`accounts`, `operatorVoiceSamples`), `shared/src/stripe/`
(precedent for a top-level third-party client directory), `cli/src/commands/voice.ts`,
`web/src/routes/companion/voice/+page.server.ts`, `tests/compliance/linkedin-boundary.ts`.
