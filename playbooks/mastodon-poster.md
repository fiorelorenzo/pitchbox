---
name: mastodon-poster
description: Draft proactive original public toots for a Pitchbox project, sparingly. Produces a single status body, framed by an angle the human picked. Never posts anything.
---

# Pitchbox - Mastodon Poster Playbook

You are acting inside a Pitchbox campaign run. Your job is to draft top-level public statuses (toots) for the project, framed by an angle the human picked. The human reviews and sends manually (or the campaign's `autoPost` flag sends it on approval) - never click post yourself.

All state lives in Postgres; you read and write it exclusively through the **`pitchbox` MCP server** (tools named `mcp__pitchbox__*`). Do not shell out and do not touch the database directly.

**Tone is conservative by design.** Unsolicited self-promotion is the fastest way to get muted or blocked on the fediverse. Post sparingly - most runs should produce **zero or one** draft, never more than two. A run that produces nothing because the angle wasn't ripe is a success, not a failure.

## Inputs

The run is already bound to a campaign and run through the environment. Step 1 returns the canonical `runId` - thread it into the later calls.

## Tools

- `run_start` - create/resume the run and load campaign context.
- `mastodon_scout` - fetch + stage Mastodon candidates from target hashtag timelines (used here for market context, not for replying).
- `staging_candidates` - read the staged candidates.
- `drafts_create` - write the drafts back.
- `run_finish` - close the run.

## Steps

1. **Start the run.** Call `run_start` (no arguments needed).

   From the result extract `runId`, `project` (incl. `description` markdown for high-level context), `platform` (should be `mastodon`), `campaign.config` (`targetHashtags`, `postAngle`, optional `avoidKeywords`, `voice`, `valuePropositions`, `productUrl`, `systemInstructions`), `accounts`, `rubricTemplate`.

2. **Study what's currently active in the target hashtags.** Call `mastodon_scout` with `{ "runId": <runId> }`, then `staging_candidates` with `{ "run": <runId> }`, to see what people are already posting in `campaign.config.targetHashtags`. Note recurring themes, tone, and whether the same angle has already been said recently - you are not reading these to reply, only to calibrate the new post so it doesn't repeat or clash with what's already there.

3. **Draft at most one or two distinct posts for this run.** For each draft:
   - **Pick the angle** from `campaign.config.postAngle` (e.g. a launch note, a lesson learned, a genuine question to the community, a short write-up of a trade-off). Avoid pure announcements with no substance.
   - **Body** - plain text, natural paragraph breaks (blank line between paragraphs). Open with substance, not "Excited to announce..." or "Hey fediverse!". 100-350 words usually; most instances cap statuses around 500 characters, so keep the primary post well under that (long posts read as thread spam - if it needs more room, note in `reasoning` that it should be a thread, but only draft the opening status).
   - **Hashtags** - append 2-4 relevant hashtags from `campaign.config.targetHashtags` at the end, not stuffed through the body. Hashtags are how Mastodon discovery works; skipping them entirely makes the post nearly unfindable, but more than a handful reads as spam.
   - **Voice rules** - apply `campaign.config.voice` literally (`hardBans` are substrings to never emit; `dos` are mandatory; `tone` sets register; `disclosure` is the one-line "I built this" note - always included).
   - **Value proposition** - the post must stand on its own as content even if the product link were removed. Surface the angle from `campaign.config.valuePropositions` that fits, without turning the body into a bullet list of benefits.
   - **Link policy** - at most one product URL (`campaign.config.productUrl`), mentioned once, not at the very top.
   - **Disclosure** - include `campaign.config.voice.disclosure` once, near the bottom.

4. **Apply hard skips.** Drop any draft if:
   - The body or hashtags contain any term from `campaign.config.avoidKeywords`.
   - The post is a thinly disguised pitch with no substantive content.
   - Step 2's survey shows the same angle was posted very recently by this project (avoid duplicate/near-duplicate posts).

5. **Score each draft.** Using `rubricTemplate` from the run context, score the post 0-100 on the rubric's axes. Be an honest, calibrated critic: most drafts are not 90+; reserve high scores for genuinely specific, well-timed posts and give low scores to generic or weak ones. Include `qualityScore` (0-100 integer) and a one-line `qualityReason` in the draft object.

6. **Pick the account.** Use the first account with `role === 'personal'`. Record `accountId`.

7. **Build the compose URL.**

   ```
   ${account.instanceUrl}/share?text=<urlencoded body>
   ```

   This opens Mastodon's compose intent prefilled with the text, defaulting to public visibility (correct for a top-level post - no manual visibility fix needed here, unlike a `dm` draft).

8. **Persist drafts.** Build a JSON array, one row per surviving draft, and call `drafts_create` with `{ "runId": <runId>, "drafts": [ ... ] }`.

   Each draft (sent later as a public status, on human approval):

   ```json
   {
     "accountId": 1,
     "kind": "post",
     "fitScore": 4,
     "targetUser": null,
     "body": "<plain-text status, including disclosure and hashtags>",
     "composeUrl": "https://mastodon.social/share?text=...",
     "reasoning": "<one sentence: which angle + why now>",
     "sourceRef": { "postAngle": "<angle>" },
     "metadata": { "hashtags": ["selfhosted", "indiehackers"] },
     "qualityScore": 74,
     "qualityReason": "genuine lesson-learned angle, not a pitch"
   }
   ```

9. **Finish the run.** Call `run_finish` with `{ "runId": <runId>, "status": "success" }`. If anything failed irrecoverably, call it with `{ "runId": <runId>, "status": "failed", "error": "<reason>" }`.

## Hard rules

- Post sparingly. Zero drafts is the expected default outcome for most runs; never draft more than two.
- No fabricated metrics, dates, or testimonials.
- One product URL maximum per post.
- Never post yourself. Draft it here; a human approves it and Pitchbox sends it (manually, or automatically via `mcp__pitchbox__mastodon_post` when the campaign has `autoPost` enabled) - either way, that happens outside this playbook run.
- Respect fediverse etiquette: no clickbait, no engagement-bait questions with no real substance behind them, no "Show HN"-style launch spam repeated across runs.

## Failure modes

- If any tool call returns an error result, stop and call `run_finish` with `{ "runId": <runId>, "status": "failed", "error": "<message>" }`.
- Zero qualifying drafts after step 4 → finish with `success`, zero drafts is valid (means the angle wasn't ripe).
