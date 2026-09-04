# LinkedIn

LinkedIn is Pitchbox's fourth outreach platform, and it is shaped differently from the other three on purpose. This page is about that shape: what Pitchbox does on LinkedIn, what it deliberately never does, and why. For the full architecture and the reasoning behind every decision below, see the [design doc](/linkedin-integration-design).

## No API, so the browser is the discovery mechanism

LinkedIn has no discovery API, no third-party comment API and no self-serve messaging API at any developer tier. Reading a third party's post well enough to comment on it (`r_member_social`) is "granted to select developers only"; `w_organization_social` only covers pages a member administers; a self-serve message API does not exist outside partner programs.

So there is nothing on linkedin.com for a Pitchbox server to call or scrape. The only legitimate source of a LinkedIn candidate is the human's own logged-in browser, while the human is already looking at LinkedIn. The Chrome extension is not an add-on to LinkedIn support, it is the adapter: a content script watches the pages the human is already on and records what LinkedIn already rendered there. It initiates nothing. (Which pages actually yield a candidate is narrower than it sounds: see the tradeoff section below.)

## What Pitchbox never does on LinkedIn

Section 8.2 of LinkedIn's User Agreement prohibits scraping, browser plugins used to scrape, and bots that create, comment on, like or share content on a member's behalf. That is not a technicality Pitchbox works around: it is the reason the LinkedIn integration is shaped the way it is. A restricted Reddit account costs a throwaway handle; a restricted LinkedIn account costs a real professional identity, its connections and its message history. So the rules below are prohibitions, not guidance.

- **No LinkedIn session credential ever leaves the browser.** No `li_at`, no CSRF token, no cookie or storage value read and transmitted anywhere.
- **No request to linkedin.com is ever initiated by Pitchbox.** The extension reads only the DOM the human's own navigation already rendered: no fetch, no background polling, no voluntary navigation to a LinkedIn URL.
- **No synthetic interaction.** Pitchbox never calls `.click()` on a LinkedIn control and never dispatches a synthetic submit. It may insert drafted text into a composer the human already opened, and nothing more. The human presses LinkedIn's own button, always.
- **No server-side automation of linkedin.com.** No Playwright, no headless browser, no stealth stack pointed at LinkedIn, in any edition.
- **No direct messages.** The `dm` quota ships at zero and there is no `linkedin-scout` scenario to produce one. Cold DMs and unsolicited connection requests are the behavior most reliably associated with LinkedIn restricting an account, so Pitchbox does not offer it.

## Why this looks different from Reddit and Mastodon

The shape of a platform integration follows what that platform actually allows, not a house preference:

| Capability                     | Reddit                        | Mastodon                                    | LinkedIn                                                         |
| ------------------------------ | ----------------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| Target discovery               | Server-side Playwright scrape | `GET /api/v1/timelines/tag`                 | No API at any tier: the extension observes what the human opened |
| Comment on someone else's post | Scrape + extension            | `POST /api/v1/statuses`                     | Not available at any self-serve tier                             |
| Post to your own profile       | Scrape                        | `POST /api/v1/statuses`, optional auto-post | Self-serve API exists but is out of scope for v1 (see below)     |
| Direct message                 | Extension                     | `direct`-visibility status                  | Off entirely                                                     |

Reddit's own rules tolerate server-side scraping, so Pitchbox scrapes it server-side with Playwright. Mastodon exposes an open REST API, so Pitchbox posts through it directly and can optionally auto-post with a pasted token. Neither option is available on LinkedIn, so the extension mediates instead: comments and top-level posts only, drafted from what the human's own browser already rendered, sent by the human's own click.

## The tradeoff: a slower-filling candidate pool

Because nothing is fetched or scraped, a LinkedIn candidate only arrives while a human is actually browsing LinkedIn with the extension installed and turned on. That candidate pool fills more slowly than a feed scrape would fill it. That is the correct trade given the alternative: the only ways to fill it faster are synthesizing a click to read a post's permalink, or patching the page's own network calls to read LinkedIn's internal payloads underneath it, and both sit on the wrong side of the boundary above.

It is also narrower than "while a human browses". Measured against real captured markup on 2026-09-04: the feed LinkedIn serves today is a server-driven UI where a post has no stable identifier at all, only a token that changes on reload, so a feed card cannot be recorded as a candidate. What can is a post the human actually opens, and a post in a profile's recent-activity list, which still carry the activity URN. So scrolling contributes nothing to the pool; opening a post does.

## LinkedIn's own posting API, deliberately not used

`w_member_social` would let a connected member's own posts go out through LinkedIn's official API without the human pressing a button. It needs three-legged OAuth with a hosted redirect URI, and self-hosting Pitchbox should not require registering a LinkedIn developer app to work. It is recorded as a spike, not built, for v1.

## Connecting an account

Add a LinkedIn account from **Projects → [project] → Accounts** with your public vanity slug (`linkedin.com/in/<slug>`) and a display name. There is no password or session to enter, because Pitchbox never asks for one: a LinkedIn account row is an identity, not a credential.

## Quota defaults

LinkedIn ships with the tightest limits of any platform, because the constraint here is reputational rather than technical: an account that comments dozens of times a day looks like a bot to LinkedIn's velocity monitoring, regardless of whether a human approved every draft.

| Kind           | Per day | Per week |
| -------------- | ------- | -------- |
| Comment        | 8       | 30       |
| Post           | 1       | 4        |
| Direct message | 0       | 0        |

An operator can lower these from **Settings → Quota**. Unlike the other platforms, LinkedIn's ceiling is not meant to be raised past these defaults: the product deliberately does not offer a setting for that.

## Status

Most of the LinkedIn work tracked on the `v1.5 - LinkedIn` milestone (epics #296 and #297) is still open. What is merged today:

- The `linkedin` platform row, its two scenarios (`linkedin-commenter`, `linkedin-poster`), the quota defaults above, and the credential-free account model, including the connect form described above.
- An Inbox presenter that knows how to render a LinkedIn draft (vanity-slug labels, "Send clicked on LinkedIn").
- Send detection: the extension detects the human's own click on LinkedIn's comment/post submit control and flips the draft to `sent`.
- Passive reply and message ingest for asynchronous campaigns: a content script reads rendered comment replies and messages when the human has the relevant LinkedIn page open, through the same `POST /api/extension/dm-sync` Reddit uses. Coverage is necessarily partial - see "The tradeoff" above and the Browser extension card on **Settings → Browser extension** - and gated by the same assistant/collector switches as the observation collector (below).
- On the in-page assistant side: an approved design brief, the shadow-DOM panel component the assistant will render into, the real-time suggestion endpoint that will produce its drafted text, the browser-side observation collector, and the settings that gate both (per-project binding, daily caps, kill switch).

What is still open, and so does nothing useful yet if you try it: the tool that drains observations into a campaign run and the two playbooks themselves. On the in-page assistant side: actually mounting the panel on a LinkedIn page, turning an accepted suggestion into a real draft, and the on-demand host-permission grant the panel needs to run at all. A LinkedIn campaign can already be created from the dashboard, since the scenario picker does not know which platforms are finished, but with none of the above landed it has nothing to draft from yet.
