---
name: reddit-scout
description: Run a Reddit outreach scout for a Pitchbox campaign. Fetches candidates, filters, drafts personalised DMs, and writes them back to Pitchbox. Never sends anything.
---

# Pitchbox - Reddit Scout Playbook

You are acting inside a Pitchbox campaign run. All state lives in Postgres; you read and write it exclusively through the **`pitchbox` MCP server** (its tools are named `mcp__pitchbox__*`). Do not shell out and do not touch the database directly. Stay strictly within the steps below.

## Inputs

The run is already bound to a campaign and run through the environment, so the tools default to the right ids when you omit them. Step 1 returns the canonical `runId` - thread it explicitly into every later tool call.

## Tools

- `run_start` - create/resume the run and load campaign context.
- `reddit_scout` - fetch Reddit candidates and stage them.
- `staging_candidates` - read the staged candidates.
- `drafts_create` - write the drafts back.
- `run_finish` - close the run.

Every tool returns JSON. On failure a tool returns an error result (see Failure modes).

## Steps

1. **Start the run and load context.** Call `run_start` (no arguments; it defaults to this session's campaign).

   From the result extract: `runId`, `project` (includes `description` - the project's markdown briefing), `platform`, `campaign.config` (the strict-validated structured scout profile), `accounts`, `blocklist`, `contactedRecently`, `rubricTemplate`. Remember `runId` for every later call.

2. **Fetch raw candidates.** Call `reddit_scout` with `{ "runId": <runId> }`.

   This fetches Reddit via the Pitchbox backend, applies blocklist + contact-history filters, and stages `staging_scout_candidates` rows.

3. **Read the staged candidates.** Call `staging_candidates` with `{ "run": <runId> }`.

   This returns an array of candidate objects, each with `user`, `post`, `profileUrl`, `composeUrlBase`, `matchedBy`.

4. **For each candidate, do the following:**

   **a. Score them 1-5 (fit).** Factors:
   - Topical relevance of the matched post to the project's `description` and the target subreddits in `campaign.config.targetSubreddits`. Use `campaign.config.systemInstructions` as additional scoring guidance.
   - Engagement signal (karma, post score, comments).
   - Tone (genuine curiosity > dismissive > hostile). Skip hostile.
   - For `matchedBy === 'hot'` candidates (no keyword match, they just showed up in a target subreddit), score primarily on subreddit relevance and post engagement, and keep the DM opener loose ("saw you active on r/X" rather than quoting a specific post).

   Skip candidates scoring below `campaign.config.fitScoreThreshold` (default 3 if absent).

   **b. Draft a DM.** English, first-person, casual, ~80-100 words. Reference a concrete detail from the candidate's matched post. The DM **must** follow the voice rules in `campaign.config.voice`:
   - `voice.hardBans` - banned words/phrases. Never use them.
   - `voice.dos` - required stylistic elements (e.g. contractions, lowercase opener).
   - `voice.tone` - overall tone (e.g. `casual`).
   - `voice.openerStyle` - opener convention (e.g. `lowercase-casual` → "hey," not "Hey,").
   - `voice.disclosure` - closing self-disclosure / signature line. Always include it.

   Treat `campaign.config.systemInstructions` as additional voice & content guidance - it overrides defaults.

   The offer text comes from `campaign.config.offer.text` and the product URL from `campaign.config.offer.productUrl`. Never invent an offer.

   **c. Build the compose URL.** Take `composeUrlBase` from the candidate, append `&subject=<urlencoded>&message=<urlencoded>`. Subject comes from `campaign.config.offer.subject`.

5. **Pick the account.** Use the first account from `accounts` whose `role === 'personal'`. Record its `id` as `accountId`.

6. **Score each draft.** Using `rubricTemplate` from the run context, score the DM 0-100 on the rubric's axes. Be an honest, calibrated critic: most drafts are not 90+; reserve high scores for genuinely specific, personalized, well-targeted DMs and give low scores to generic or weak ones. Include `qualityScore` (0-100 integer) and a one-line `qualityReason` in the draft object.

7. **Write drafts back.** Call `drafts_create` with `{ "runId": <runId>, "drafts": [ ... ] }`, one draft object per candidate you scored at or above the threshold.

   > Result: `{ runId, inserted, skipped: [{ targetUser, reason }], dedupSkipped: [...] }` - blocklisted or recently-contacted targets are skipped server-side; log them and do not retry.

   Each draft object:

   ```json
   {
     "accountId": 1,
     "kind": "dm",
     "fitScore": 4,
     "subreddit": "rpg",
     "targetUser": "alice",
     "body": "<DM markdown>",
     "composeUrl": "https://www.reddit.com/message/compose?to=alice&subject=...&message=...",
     "reasoning": "2-4 sentences citing specific words from their post.",
     "sourceRef": { "permalink": "/r/rpg/comments/abc/.../" },
     "metadata": { "matchedBy": "search" },
     "qualityScore": 78,
     "qualityReason": "specific reference to their post, clear ask"
   }
   ```

8. **Finish the run.** Call `run_finish` with `{ "runId": <runId>, "status": "success" }`.

## Hard constraints

- Never send the DM. The human reviews and sends from the Pitchbox dashboard.
- No generic openers. If you catch yourself writing "I saw your post about X" without a concrete quote, stop and rewrite.
- Skip candidates whose post complains about AI; don't recruit people who'll push back publicly.
- Respect `contactedRecently` - even though the fetch step already filters, do a defensive check before emitting a draft.
- If fewer than 3 candidates survive scoring, still finish the run with `success`; it's valid to produce zero drafts.

## Failure modes

- If any tool call returns an error result, stop and call `run_finish` with `{ "runId": <runId>, "status": "failed", "error": "<message>" }`.
- If Reddit returns 401/403 (visible in the `reddit_scout` error), finish with `failed` and include the error message; the daemon's safety brake handles it.
