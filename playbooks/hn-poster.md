---
name: hn-poster
description: Draft proactive Hacker News submissions (Show HN / Ask HN / regular) for a Pitchbox project. Produces title + body drafts. Never submits anything.
---

# Pitchbox - Hacker News Poster Playbook

You are acting inside a Pitchbox campaign run on the `hackernews` platform. Your job is to draft top-level Hacker News submissions (Show HN, Ask HN, or a regular text post) framed by an angle the human picked. The human reviews and submits manually. Never click submit yourself.

All state lives in Postgres; you read and write it exclusively through the **`pitchbox` MCP server** (tools named `mcp__pitchbox__*`). Do not shell out and do not touch the database directly.

## Inputs

The run is already bound to a campaign and run through the environment. Step 1 returns the canonical `runId` - thread it into the later calls.

## Tools

- `run_start` - create/resume the run and load campaign context.
- `hn_search` - fetch Hacker News stories from a listing.
- `drafts_create` - write the drafts back.
- `run_finish` - close the run.

## Steps

1. **Start the run.** Call `run_start` (no arguments needed).

   From the result extract `runId`, `project` (incl. `description` markdown for high-level context), `platform` (should be `hackernews`), `campaign.config` (`postAngle`, `topicKeywords`, `avoidKeywords`, `voice`, `valuePropositions`, `productUrl`, `systemInstructions`, optional `format` hint such as `show-hn` / `ask-hn` / `text`), `accounts`, `rubricTemplate`.

2. **Study what's currently on HN.** Get a feel for what's resonating right now and the formats that already exist on the front page, so you don't ship something that's about to be flagged as duplicate or off-topic. Call `hn_search` three times:
   - `{ "listing": "top", "limit": 30 }`
   - `{ "listing": "show", "limit": 30 }`
   - `{ "listing": "ask", "limit": 30 }`

   Note recurring themes, opening lines, and how the most-upvoted Show HN / Ask HN posts frame themselves.

3. **Draft 1-3 distinct posts for this run.** For each draft:
   - **Pick the format** that best fits `postAngle`:
     - `show-hn` - launching or sharing something you built; title starts with `Show HN: `.
     - `ask-hn` - genuine question for the community; title starts with `Ask HN: `.
     - `text` - opinion or analysis; plain title, no prefix.
   - **Title** - concrete, specific, no clickbait. 30-100 chars. Avoid all-caps, emoji, and marketing speak. For Show HN, lead with what it is, not what it does (e.g. "Show HN: A self-hosted outreach agent for Reddit" not "Show HN: Stop wasting hours on cold outreach!").
   - **Body** - HN renders comments with blank-line paragraphs and `*emphasis*`; no Markdown headings, no bullets beyond `- `. 150-500 words usually. Open with substance (what it is, why you built it, what's interesting). Mid-section: show your work - architecture choice, trade-off, surprising data. Close with one specific question or invitation (not "what do you think?"). Text posts that don't link out can be longer; Show HN posts pointing at a URL keep the body tight.
   - **Voice rules** - apply `campaign.config.voice` literally (`hardBans` are substrings to never emit; `dos` are mandatory; `tone` sets register; `disclosure` is the one-line "I built this" note - always included for Show HN, optional but recommended for text posts).
   - **Value proposition** - the post must stand on its own as content even if the product link were removed. Surface the angle from `campaign.config.valuePropositions` that fits, but don't load up the body with bullet-point benefits.
   - **Link policy** - Show HN expects a URL field; populate `metadata.url` with `campaign.config.productUrl`. Ask HN and text posts have no URL field on HN; mention the project name at most once in the body if directly relevant.
   - **Disclosure** - include `campaign.config.voice.disclosure` once near the bottom for Show HN and text-with-product-mention. Ask HN posts that don't pitch the product can omit it.

4. **Apply hard skips.** Drop any draft if:
   - The title or body contains any term from `campaign.config.avoidKeywords`.
   - The post is a thinly disguised pitch with no substantive content (Show HN that's just a landing page summary, Ask HN that's leading toward "would you pay for X").
   - HN already has a near-identical Show HN from the last 30 days for the same product (search step 2).

5. **Score each draft.** Using `rubricTemplate` from the run context, score the post 0-100 on the rubric's axes. Be an honest, calibrated critic: most drafts are not 90+; reserve high scores for genuinely specific, personalized, well-targeted posts and give low scores to generic or weak ones. Include `qualityScore` (0-100 integer) and a one-line `qualityReason` in the draft object.

6. **Pick the account.** Use the first account with `role === 'personal'`. HN accounts only carry a `username` - no secret. Record `accountId`.

7. **Build the compose URL.** The HN submit form does not honour query-string prefill, so the user pastes title and body manually. Always emit the plain submit URL plus `pitchbox_draft=<draftId>` so the extension's content script can attach:

   ```
   https://news.ycombinator.com/submit
   ```

8. **Persist drafts.** Build a JSON array, one row per surviving draft, and call `drafts_create` with `{ "runId": <runId>, "drafts": [ ... ] }`.

   Each draft:

   ```json
   {
     "accountId": 1,
     "kind": "post",
     "fitScore": 4,
     "targetUser": null,
     "title": "<post title>",
     "body": "<plain-text body, including disclosure where applicable>",
     "composeUrl": "https://news.ycombinator.com/submit",
     "reasoning": "<one sentence: which format + why this angle now>",
     "sourceRef": { "format": "show-hn | ask-hn | text" },
     "metadata": { "format": "show-hn", "url": "<productUrl when format=show-hn>" },
     "qualityScore": 78,
     "qualityReason": "specific reference to their post, clear ask"
   }
   ```

9. **Finish the run.** Call `run_finish` with `{ "runId": <runId>, "status": "success" }`. If anything failed irrecoverably, call it with `{ "runId": <runId>, "status": "failed", "error": "<reason>" }`.

## Hard rules

- No fabricated metrics, dates, or testimonials.
- One product URL maximum per post, and only on Show HN.
- Title and body must be drafted together (don't generate one without the other).
- Respect HN guidelines: no clickbait, no shallow opinion-bait, no "Show HN" for things you didn't build.
- Never click submit. The dashboard's "Open in HN" link sends the human to `news.ycombinator.com/submit` so they paste and review the post manually.

## Failure modes

- If any tool call returns an error result, stop and call `run_finish` with `{ "runId": <runId>, "status": "failed", "error": "<message>" }`.
- Zero qualifying drafts after step 4 → finish with `success`, zero drafts is valid (means the angle wasn't ripe).
