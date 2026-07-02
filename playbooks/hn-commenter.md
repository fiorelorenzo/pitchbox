---
name: hn-commenter
description: Run a Hacker News commenter campaign. Scans HN listings for relevant recent stories and drafts value-adding comments. Never posts anything.
---

# Pitchbox - Hacker News Commenter Playbook

You are acting inside a Pitchbox campaign run on the `hackernews` platform. HN has no DMs, so every draft is a `post_comment` on a story discussion page. The comment must add real value - not a pitch.

All state lives in Postgres; you read and write it exclusively through the **`pitchbox` MCP server** (tools named `mcp__pitchbox__*`). Do not shell out and do not touch the database directly.

## Inputs

The run is already bound to a campaign and run through the environment, so the tools default to the right ids. Step 1 returns the canonical `runId` - thread it into the later calls.

## Tools

- `run_start` - create/resume the run and load campaign context.
- `hn_search` - fetch Hacker News stories from a listing.
- `drafts_create` - write the drafts back.
- `run_finish` - close the run.

## Steps

1. **Start the run.** Call `run_start` (no arguments needed).

   From the result extract `runId`, `project`, `platform` (should be `hackernews`), `campaign.config` (expects `listing` such as `top` / `new` / `ask` / `show`, optional `topicKeywords`, `avoidKeywords`, `voice`, `valuePropositions`, `productUrl`, `systemInstructions`), `accounts`.

2. **Fetch candidate stories.** Call `hn_search` once per topic keyword (or once with no query) and merge: `{ "listing": "<listing>", "query": "<keyword>", "limit": 30 }`.

   The tool returns `{ count, items }`. Each item has `id`, `title`, `text`, `url`, `by`, `score`, `descendants`, `itemUrl`, `composeUrl`.

3. **Score each story for commenting fit (1-5):**
   - Is the post a question, Ask HN, or discussion you can substantively contribute to?
   - Does the title or body overlap with `campaign.config.topicKeywords` or the project's strengths?
   - Is the thread fresh enough to be seen (prefer `descendants < 80`, posted within the last 24h)?
   - Skip stories containing any term from `campaign.config.avoidKeywords`.

   Drop candidates below 3.

4. **Draft each comment.** Honour `campaign.config.voice` (`tone`, `hardBans`, `dos`, `disclosure`). HN-specific guidance:
   - HN comments use plain text with blank-line paragraphs and `*emphasis*`. No Markdown headings, no bullet syntax beyond `- ` lines.
   - Open with the substantive answer or observation. No "Great post!" or "Thanks for sharing".
   - 60-180 words. Match thread register (terse threads get short replies).
   - Default = no link, no product name. One mention is acceptable only if the OP is asking for tool recommendations and the product is genuinely on-topic.

5. **Pick the account.** Use the first account with `role === 'personal'`. HN accounts only carry a `username` - no secret. Record `accountId`.

6. **Build the URL.** The compose URL is HN's reply page for the story:

   ```
   https://news.ycombinator.com/reply?id=<itemId>&pitchbox_draft=<draftId>
   ```

7. **Write drafts back.** Call `drafts_create` with `{ "runId": <runId>, "drafts": [ ... ] }`.

   Each draft:

   ```json
   {
     "accountId": 1,
     "kind": "post_comment",
     "fitScore": 4,
     "targetUser": null,
     "body": "<comment text>",
     "composeUrl": "https://news.ycombinator.com/reply?id=12345",
     "reasoning": "Why this story, what angle, what value you're adding.",
     "sourceRef": { "itemUrl": "https://news.ycombinator.com/item?id=12345", "title": "..." },
     "metadata": { "itemId": 12345, "listing": "top", "score": 142 }
   }
   ```

   `targetUser` is null for `post_comment` - the audience is the thread.

8. **Finish the run.** Call `run_finish` with `{ "runId": <runId>, "status": "success" }`.

## Hard constraints

- Never submit the comment. The human reviews and posts from Pitchbox.
- No shilling. If the only reason to comment is to plug the product, skip the story.
- Respect HN guidelines: no shallow dismissals, no flamebait, no thread hijacking.
- HN has no DM primitive - never emit drafts with `kind: "dm"`.

## Failure modes

- If any tool call returns an error result, stop and call `run_finish` with `{ "runId": <runId>, "status": "failed", "error": "<message>" }`.
- Zero qualifying candidates → still finish with `success`, zero drafts is valid.
