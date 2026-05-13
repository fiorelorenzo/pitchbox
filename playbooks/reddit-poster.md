---
name: reddit-poster
description: Draft proactive top-level Reddit posts in target subreddits for a Pitchbox project. Produces title + body drafts. Never submits anything.
---

# Pitchbox — Reddit Poster Playbook

You are acting inside a Pitchbox campaign run. Your job is to draft top-level Reddit submissions (text posts only) in target subreddits, framed by an angle the human picked. The human reviews and submits manually. Never click submit yourself.

## Inputs

Environment variables:

- `PITCHBOX_CAMPAIGN_ID`
- `PITCHBOX_RUN_ID` (may be absent if invoked directly; step 1 creates it)

## Steps

1. **Start the run.**

   ```
   pitchbox run:start --campaign=$PITCHBOX_CAMPAIGN_ID
   ```

   Parse JSON. Extract `runId`, `project` (incl. `description` markdown for high-level context), `platform`, `campaign.config` (`targetSubreddits`, `topicKeywords`, `avoidKeywords`, `postAngle`, `voice`, `valuePropositions`, `productUrl`, `systemInstructions`), `accounts`, `blocklist`, `contactedRecently`.

2. **Study each target subreddit.** For every subreddit in `campaign.config.targetSubreddits`:

   ```
   pitchbox reddit:subreddit-snapshot --subreddit=<name>
   ```

   - Read the top 25 posts of the week (titles, body excerpts, score, comment counts).
   - Note recurring formats (e.g. "Show & tell", weekly threads, AMA cadence).
   - Note moderation / self-promo rules implied by what survives.

3. **Draft one or more posts per subreddit.** Aim for 1-3 distinct posts per subreddit (not more) for this run. For each draft:
   - **Pick the format** that fits the subreddit and the `postAngle`. Acceptable formats: launch / show-and-tell, lessons-learned story, question-led discussion, comparison or teardown. Avoid pure announcements without a substantive body.
   - **Title** — concrete, specific, no clickbait. 30-120 chars. Avoid all-caps. Avoid leading `[Show]` / `[Help]` prefixes unless the subreddit conventionally uses them.
   - **Body** — markdown. 200-600 words usually. Open with the hook (not "Hey everyone!"). Mid-section: substance — show your work, share data, explain trade-offs. Close with a concrete question that invites discussion (not "what do you think?").
   - **Voice rules** — apply `campaign.config.voice` literally (`hardBans` are substrings to never emit; `dos` are mandatory; `tone` sets register; `disclosure` is the one-line "I built this" note required by every subreddit's self-promo rules).
   - **Value proposition** — surface the angle from `campaign.config.valuePropositions` that best fits the post, but the post must stand on its own as content even if the product link were removed.
   - **Link policy** — at most one product URL (`campaign.config.productUrl`), placed in context rather than at the top. Subreddits with strict self-promo rules: skip the link, mention the project name only.
   - **Disclosure** — include `campaign.config.voice.disclosure` once near the bottom, before the closing question.

4. **Apply hard skips.** Drop any draft if:
   - The subreddit appears in `blocklist` with `kind=subreddit` (global or project scope).
   - The title or body contains any term from `campaign.config.avoidKeywords`.
   - The subreddit's recent top posts show explicit "no self-promotion" / "no AI-generated content" rules and the draft can't reasonably claim to be human-authored substantive content.

5. **Persist drafts.** For each surviving draft, emit one row:

   ```json
   {
     "accountId": <pick from accounts[0]>,
     "kind": "post",
     "fitScore": <1-5 — how strong is this for the subreddit>,
     "targetUser": null,
     "title": "<post title>",
     "body": "<markdown body, including disclosure>",
     "composeUrl": "https://www.reddit.com/r/<sub>/submit?title=<urlencoded title>&text=<urlencoded body>",
     "reasoning": "<one sentence: which angle + why this subreddit>",
     "sourceRef": { "subreddit": "<sub>", "format": "<launch | lessons | discussion | comparison>" },
     "metadata": { "subreddit": "<sub>" }
   }
   ```

   Then:

   ```
   pitchbox drafts:create --run=<runId>
   ```

   pipes the JSON array on stdin.

6. **Finish the run.**

   ```
   pitchbox run:finish --run=<runId> --status=success
   ```

   If anything failed irrecoverably:

   ```
   pitchbox run:finish --run=<runId> --status=failed --error="<reason>"
   ```

## Hard rules

- One product URL maximum per post; subreddit rules trump everything.
- Disclosure line is mandatory on every post.
- No fabricated metrics, dates, or testimonials.
- Title and body must be drafted together (don't generate one without the other).
- Never click submit. The dashboard's "Open in Reddit" link sends the human to Reddit's submit form with the title + body prefilled.
