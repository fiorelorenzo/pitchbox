---
name: hn-poster
description: Draft proactive Hacker News submissions (Show HN / Ask HN / regular) for a Pitchbox project. Produces title + body drafts. Never submits anything.
---

# Pitchbox - Hacker News Poster Playbook

You are acting inside a Pitchbox campaign run on the `hackernews` platform. Your job is to draft top-level Hacker News submissions (Show HN, Ask HN, or a regular text post) framed by an angle the human picked. The human reviews and submits manually. Never click submit yourself.

## Inputs

Environment variables:

- `PITCHBOX_CAMPAIGN_ID`
- `PITCHBOX_RUN_ID` (may be absent if invoked directly; step 1 creates it)

## Steps

1. **Start the run.**

   ```
   pitchbox run:start --campaign=$PITCHBOX_CAMPAIGN_ID
   ```

   Parse JSON. Extract `runId`, `project` (incl. `description` markdown for high-level context), `platform` (should be `hackernews`), `campaign.config` (`postAngle`, `topicKeywords`, `avoidKeywords`, `voice`, `valuePropositions`, `productUrl`, `systemInstructions`, optional `format` hint such as `show-hn` / `ask-hn` / `text`), `accounts`.

2. **Study what's currently on HN.** Get a feel for what's resonating right now and the formats that already exist on the front page, so you don't ship something that's about to be flagged as duplicate or off-topic.

   ```
   pitchbox hn:search --listing=top --limit=30
   pitchbox hn:search --listing=show --limit=30
   pitchbox hn:search --listing=ask --limit=30
   ```

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

5. **Pick the account.** Use the first account with `role === 'personal'`. HN accounts only carry a `username` - no secret. Record `accountId`.

6. **Build the compose URL.** HN submit page accepts a prefilled title (and url for Show HN):

   ```
   https://news.ycombinator.com/submit
   ```

   The submit form does not honour query-string prefill, so the user pastes title and body manually. Always emit the plain submit URL plus `pitchbox_draft=<draftId>` so the extension's content script can attach.

7. **Persist drafts.** For each surviving draft, emit one row:

   ```json
   {
     "accountId": <pick from accounts[0]>,
     "kind": "post",
     "fitScore": <1-5 - how strong is this for HN today>,
     "targetUser": null,
     "title": "<post title>",
     "body": "<plain-text body, including disclosure where applicable>",
     "composeUrl": "https://news.ycombinator.com/submit",
     "reasoning": "<one sentence: which format + why this angle now>",
     "sourceRef": { "format": "show-hn | ask-hn | text" },
     "metadata": { "format": "show-hn", "url": "<productUrl when format=show-hn>" }
   }
   ```

   Then:

   ```
   pitchbox drafts:create --run=<runId>
   ```

   pipes the JSON array on stdin.

8. **Finish the run.**

   ```
   pitchbox run:finish --run=<runId> --status=success
   ```

   If anything failed irrecoverably:

   ```
   pitchbox run:finish --run=<runId> --status=failed --error="<reason>"
   ```

## Hard rules

- No fabricated metrics, dates, or testimonials.
- One product URL maximum per post, and only on Show HN.
- Title and body must be drafted together (don't generate one without the other).
- Respect HN guidelines: no clickbait, no shallow opinion-bait, no "Show HN" for things you didn't build.
- Never click submit. The dashboard's "Open in HN" link sends the human to `news.ycombinator.com/submit` so they paste and review the post manually.

## Failure modes

- Any CLI `{"ok": false}` -> stop, `run:finish --status=failed --error="..."`.
- Zero qualifying drafts after step 4 -> finish with `success`, zero drafts is valid (means the angle wasn't ripe).
