---
name: hn-commenter
description: Run a Hacker News commenter campaign. Scans HN listings for relevant recent stories and drafts value-adding comments. Never posts anything.
---

# Pitchbox - Hacker News Commenter Playbook

You are acting inside a Pitchbox campaign run on the `hackernews` platform. HN has no DMs, so every draft is a `post_comment` on a story discussion page. The comment must add real value - not a pitch.

## Inputs

Environment variables:

- `PITCHBOX_CAMPAIGN_ID`
- `PITCHBOX_RUN_ID` (may be absent; step 1 creates it)

## Steps

1. **Start the run.**

   ```
   pitchbox run:start --campaign=$PITCHBOX_CAMPAIGN_ID
   ```

   Parse JSON. Extract `runId`, `project`, `platform` (should be `hackernews`), `campaign.config` (expects `listing` such as `top` / `new` / `ask` / `show`, optional `topicKeywords`, `avoidKeywords`, `voice`, `valuePropositions`, `productUrl`, `systemInstructions`), `accounts`.

2. **Fetch candidate stories.** Run one call per topic keyword (or once with no query) and merge:

   ```
   pitchbox hn:search --listing=<listing> --query="<keyword>" --limit=30
   ```

   The CLI returns `{ ok, data: { items: HnItem[] } }`. Each `HnItem` has `id`, `title`, `text`, `url`, `by`, `score`, `descendants`, `itemUrl`, `composeUrl`.

3. **Score each story for commenting fit (1–5):**
   - Is the post a question, Ask HN, or discussion you can substantively contribute to?
   - Does the title or body overlap with `campaign.config.topicKeywords` or the project's strengths?
   - Is the thread fresh enough to be seen (prefer `descendants < 80`, posted within the last 24h)?
   - Skip stories containing any term from `campaign.config.avoidKeywords`.

   Drop candidates below 3.

4. **Draft each comment.** Honour `campaign.config.voice` (`tone`, `hardBans`, `dos`, `disclosure`). HN-specific guidance:
   - HN comments use plain text with blank-line paragraphs and `*emphasis*`. No Markdown headings, no bullet syntax beyond `- ` lines.
   - Open with the substantive answer or observation. No "Great post!" or "Thanks for sharing".
   - 60–180 words. Match thread register (terse threads get short replies).
   - Default = no link, no product name. One mention is acceptable only if the OP is asking for tool recommendations and the product is genuinely on-topic.

5. **Pick the account.** Use the first account with `role === 'personal'`. HN accounts only carry a `username` - no secret. Record `accountId`.

6. **Build the URL.** The compose URL is HN's reply page for the story:

   ```
   https://news.ycombinator.com/reply?id=<itemId>&pitchbox_draft=<draftId>
   ```

7. **Write drafts back.**

   ```
   echo '<json>' | pitchbox drafts:create --run=<runId>
   ```

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

8. **Finish the run.**
   ```
   pitchbox run:finish --run=<runId> --status=success
   ```

## Hard constraints

- Never submit the comment. The human reviews and posts from Pitchbox.
- No shilling. If the only reason to comment is to plug the product, skip the story.
- Respect HN guidelines: no shallow dismissals, no flamebait, no thread hijacking.
- HN has no DM primitive - never emit drafts with `kind: "dm"`.

## Failure modes

- Any CLI `{"ok": false}` → stop, `run:finish --status=failed --error="..."`.
- Zero qualifying candidates → still finish with `success`, zero drafts is valid.
