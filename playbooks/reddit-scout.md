---
name: reddit-scout
description: Run a Reddit outreach scout for a Pitchbox campaign. Fetches candidates, filters, drafts personalised DMs, and writes them back to Pitchbox. Never sends anything.
---

# Pitchbox — Reddit Scout Playbook

You are acting inside a Pitchbox campaign run. All state lives in Postgres; the `pitchbox` CLI is the only way to read or write it. Stay strictly within the steps below.

## Inputs

Environment variables available to you:

- `PITCHBOX_CAMPAIGN_ID` — the campaign id to run.
- `PITCHBOX_RUN_ID` — the run id created by the scheduler (may be absent if the CLI was invoked directly; in that case the first step creates one).

## Steps

1. **Start the run and load context.** Shell out:

   ```
   pitchbox run:start --campaign=$PITCHBOX_CAMPAIGN_ID
   ```

   Parse the JSON. Extract: `runId`, `project`, `platform`, `campaign.config` (the scout profile), `config` (product, voice, offer, templates), `accounts`, `blocklist`, `contactedRecently`.

2. **Fetch raw candidates.** Shell out:

   ```
   pitchbox reddit:scout --run=<runId>
   ```

   This fetches Reddit via the Pitchbox backend, applies blocklist + contact-history filters, and writes `staging_scout_candidates` rows.

3. **Read the staged candidates.** Shell out:

   ```
   pitchbox staging:candidates --run=<runId>
   ```

   This returns an array of candidate objects, each with `user`, `post`, `profileUrl`, `composeUrlBase`, `matchedBy`.

4. **For each candidate, do the following:**

   **a. Score them 1–5 (fit).** Factors:
   - Topical relevance of the matched post to the product pitch in `config['product.pitch']`.
   - Engagement signal (karma, post score, comments).
   - Tone (genuine curiosity > dismissive > hostile). Skip hostile.
   - For `matchedBy === 'hot'` candidates (no keyword match, they just showed up in a target subreddit), score primarily on subreddit relevance and post engagement, and keep the DM opener loose ("saw you active on r/X" rather than quoting a specific post).

   Skip candidates scoring 2 or below.

   **b. Draft a DM.** English, first-person, casual, ~80–100 words. Reference a concrete detail from the candidate's matched post. The DM **must** follow the voice rules in `config['voice.dm_rules']` (hard bans, do's, examples). Typical hard rules:
   - No em-dashes (—). Use periods or commas.
   - Contractions required ("i've", "i'm", "don't").
   - No AI-tell vocabulary (the list of banned words lives in the voice config).
   - Lowercase casual opener ("hey," not "Hey,").
   - Close with the disclosure/signature from `config['voice.dm_rules'].disclosure`.

   The offer text, product URL, and any fixed phrasing come from `config['offer']` and `config['product.*']`. Never invent an offer.

   **c. Build the compose URL.** Take `composeUrlBase` from the candidate, append `&subject=<urlencoded>&message=<urlencoded>`. Subject comes from `config['offer'].composeSubject` (or fall back to `founding player invite` style — lowercase, matches the DM voice).

5. **Pick the account.** Use the first account from `accounts` whose `role` matches `config['product.defaultAccountRole']` (default: `personal`). Record its `id` as `accountId`.

6. **Write drafts back.** Build a JSON array of draft objects, one per candidate you scored ≥3, and pipe it to:

   ```
   echo '<json>' | pitchbox drafts:create --run=<runId>
   ```

   > Response: `{ ok, inserted, skipped: [{targetUser, reason}] }` — blocklisted targets are silently skipped, log them and do not retry.

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
     "reasoning": "2–4 sentences citing specific words from their post.",
     "sourceRef": { "permalink": "/r/rpg/comments/abc/.../" },
     "metadata": { "matchedBy": "search" }
   }
   ```

7. **Finish the run.** Shell out:
   ```
   pitchbox run:finish --run=<runId> --status=success
   ```

## Hard constraints

- Never send the DM. The human reviews and sends from the Pitchbox dashboard.
- No generic openers. If you catch yourself writing "I saw your post about X" without a concrete quote, stop and rewrite.
- Skip candidates whose post complains about AI; don't recruit people who'll push back publicly.
- Respect `contactedRecently` — even though the fetch step already filters, do a defensive check before emitting a draft.
- If fewer than 3 candidates survive scoring, still finish the run with `success`; it's valid to produce zero drafts.

## Failure modes

- If any CLI step returns `{"ok": false, ...}`, stop and finish the run with `--status=failed --error="<message>"`.
- If Reddit returns 401/403 (visible in the `reddit:scout` error), finish with `failed` and include the error message; the daemon's safety brake handles it.
