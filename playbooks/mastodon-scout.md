---
name: mastodon-scout
description: Run a Mastodon outreach scout for a Pitchbox campaign. Discovers candidates via hashtag timelines and drafts a small number of DM-style mentions only when there is a genuine reason to reach out. Never posts anything.
---

# Pitchbox - Mastodon Scout Playbook

You are acting inside a Pitchbox campaign run. All state lives in Postgres; you read and write it exclusively through the **`pitchbox` MCP server** (its tools are named `mcp__pitchbox__*`). Do not shell out and do not touch the database directly. Stay strictly within the steps below.

**This playbook is deliberately conservative.** The fediverse is bot-averse and cold marketing DMs are treated as harassment on most instances. A Mastodon "DM" is a `direct`-visibility status mentioning the target - it is **not** private or end-to-end encrypted the way a real DM is; it is still visible to the recipient's instance admins and can be boosted/quoted by anyone it is federated to. Treat every candidate as a maybe-skip, not a default-yes. A run that drafts zero DMs is a success, not a failure.

## Inputs

The run is already bound to a campaign and run through the environment, so the tools default to the right ids when you omit them. Step 1 returns the canonical `runId` - thread it explicitly into every later tool call.

## Tools

- `run_start` - create/resume the run and load campaign context.
- `mastodon_scout` - fetch Mastodon candidates from target hashtag timelines and stage them.
- `staging_candidates` - read the staged candidates.
- `drafts_create` - write the drafts back.
- `run_finish` - close the run.

Every tool returns JSON. On failure a tool returns an error result (see Failure modes).

## Steps

1. **Start the run and load context.** Call `run_start` (no arguments; it defaults to this session's campaign).

   From the result extract: `runId`, `project` (includes `description` - the project's markdown briefing), `platform`, `campaign.config` (`targetHashtags`, optional `keywords`, `perTagLimit`, `maxAgeHours`, `sinceId`, plus `fitScoreThreshold`, `voice`, `offer`, `systemInstructions`), `accounts`, `blocklist`, `contactedRecently`, `rubricTemplate`. Remember `runId` for every later call.

2. **Fetch raw candidates.** Call `mastodon_scout` with `{ "runId": <runId> }`.

   This scans each hashtag in `campaign.config.targetHashtags` via the Mastodon API, applies the **`#nobot` hard rule** (any author whose bio note or profile fields mention `#nobot`/`nobot` is dropped server-side, no exceptions, not configurable), plus blocklist and contact-history filters, and stages `staging_scout_candidates` rows.

3. **Read the staged candidates.** Call `staging_candidates` with `{ "run": <runId> }`.

   This returns an array of candidate objects, each with `author` (`acct`, `displayName`, `url`, `note`, `followersCount`, `createdAt`), `status` (`id`, `url`, `content`, `createdAt`, `tags`), `matchedHashtag`, `matchedKeyword`. `status.content` is the API's HTML-rendered field (statuses come wrapped in `<p>` tags) - read it for meaning, do not try to reproduce HTML in anything you draft.

4. **Defensive re-check before scoring anyone.** Even though `mastodon_scout` already filters `#nobot`, blocklist, and contact history server-side, re-scan `author.note` for `#nobot` / `nobot` yourself and skip if present. Also skip any candidate whose `author.note` or `status.content` reads as explicitly anti-bot, anti-marketing, or anti-AI - a filter miss there is exactly the kind of person a cold mention would upset most.

5. **For each surviving candidate, score fit 1-5.** Factors:
   - Topical relevance of `status.content` and `matchedHashtag` to the project's `description` and `campaign.config.targetHashtags`. Use `campaign.config.systemInstructions` as additional scoring guidance.
   - Engagement signal (`author.followersCount`, replies/boosts if visible in the content).
   - Tone (genuine curiosity > neutral > dismissive). Skip anything hostile or sarcastic.
   - `matchedKeyword` present is a stronger signal than a bare hashtag hit with no keyword match.

   Drop candidates below `campaign.config.fitScoreThreshold` (default **4** if absent - higher than the Reddit scout's default, reflecting the more conservative bar for a Mastodon mention).

6. **Gate: only draft a DM when there is a genuine reason to reach out.** A high fit score alone is not enough. Only proceed to draft a `dm` for a candidate when at least one of these holds:
   - The candidate's `status.content` directly names the project, asks for exactly the kind of tool it is, or is an explicit request for recommendations that the project genuinely answers.
   - The candidate has clearly already engaged with the project's account or content (visible in the matched status itself, e.g. quoting or replying to something the project posted).

   If neither holds, **do not draft a DM for that candidate.** A candidate that is merely on-topic but has no such signal is a lead worth noting in `reasoning` for a human to follow up on manually - not a cold DM to send. Expect most runs to draft **0-2** DMs even when several candidates score well on fit; that is the intended, soft rate for this playbook.

7. **Draft the DM.** English, first-person, genuine, ~60-90 words - shorter than the Reddit DM norm; a long unsolicited mention reads worse on Mastodon. It **must**:
   - Open by mentioning the candidate with their full `acct` (e.g. `@alice@mastodon.social`) as the first token of the body - Mastodon has no separate "to" field, the mention lives in the status text itself.
   - Reference the concrete detail from `status.content` that justified the outreach in step 6.
   - Follow `campaign.config.voice`: `hardBans` (never use), `dos` (required stylistic elements), `tone`, `openerStyle`, `disclosure` (always include, near the end, one line - who you are and why you're reaching out).
   - Never open with a pitch. Lead with the genuine reason you're mentioning them; the offer (if any) comes last, briefly.
   - The offer text comes from `campaign.config.offer.text` and the product URL from `campaign.config.offer.productUrl`. Never invent an offer. If `campaign.config.offer` is absent, do not draft any DMs this run - there is nothing honest to offer.

8. **Pick the account.** Use the first account from `accounts` whose `role === 'personal'`. Record its `id` as `accountId`.

9. **Build the compose URL.** `${account.instanceUrl}/share?text=<urlencoded body>`. This opens Mastodon's compose intent prefilled with the text but defaults to public visibility - the human must manually switch the visibility picker to "Only people I mention" (direct) before sending. Note this explicitly in `reasoning` so the reviewer doesn't miss it.

10. **Score each draft.** Using `rubricTemplate` from the run context, score the DM 0-100 on the rubric's axes. Be an honest, calibrated critic: most drafts are not 90+; reserve high scores for genuinely specific, well-justified mentions and give low scores to anything that reads generic or pitchy. Include `qualityScore` (0-100 integer) and a one-line `qualityReason` in the draft object.

11. **Write drafts back.** Call `drafts_create` with `{ "runId": <runId>, "drafts": [ ... ] }`, one draft object per candidate that survived step 6.

    > Result: `{ runId, inserted, skipped: [{ targetUser, reason }], dedupSkipped: [...] }` - blocklisted or recently-contacted targets are skipped server-side; log them and do not retry.

    Each draft object:

    ```json
    {
      "accountId": 1,
      "kind": "dm",
      "fitScore": 4,
      "targetUser": "alice@mastodon.social",
      "body": "@alice@mastodon.social <mention body>",
      "composeUrl": "https://mastodon.social/share?text=%40alice%40mastodon.social%20...",
      "reasoning": "Why this candidate cleared the outreach gate in step 6, plus the visibility reminder from step 9.",
      "sourceRef": {
        "statusUrl": "https://mastodon.social/@alice/109...",
        "matchedHashtag": "selfhosted"
      },
      "metadata": { "matchedHashtag": "selfhosted", "matchedKeyword": "self-hosted" },
      "qualityScore": 72,
      "qualityReason": "genuine reply-worthy signal, concrete reference, short and non-pitchy"
    }
    ```

12. **Finish the run.** Call `run_finish` with `{ "runId": <runId>, "status": "success" }`.

## Hard constraints

- Never post or send the mention. The human reviews and sends from the Pitchbox dashboard, and must still fix the visibility manually (step 9).
- Cold DMs are off by default. Only draft one when step 6's gate is satisfied; when in doubt, skip.
- `#nobot` is a hard, non-negotiable skip - never draft to a candidate flagged by it, even if the filter looks over-eager.
- No generic openers, no pitch-first bodies. If you catch yourself writing a mention that could be sent unchanged to any of the candidates, stop and rewrite or drop it.
- Skip candidates whose note or matched status complains about bots, AI, or marketing DMs.
- Respect `contactedRecently` - even though the fetch step already filters, do a defensive check before emitting a draft.
- It is normal and expected for a run to produce zero drafts; do not lower your bar to "fill a quota".

## Failure modes

- If any tool call returns an error result, stop and call `run_finish` with `{ "runId": <runId>, "status": "failed", "error": "<message>" }`.
- If the Mastodon API returns 401/403 (visible in the `mastodon_scout` error), finish with `failed` and include the error message; the daemon's safety brake handles it.
