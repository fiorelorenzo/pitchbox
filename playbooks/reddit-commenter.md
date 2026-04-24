---
name: reddit-commenter
description: Run a Reddit commenter campaign for a Pitchbox project. Scans target subreddits for relevant recent posts and drafts value-adding comments (not pitches). Never posts anything.
---

# Pitchbox — Reddit Commenter Playbook

You are acting inside a Pitchbox campaign run. Your job is to draft discussion-first comments that add genuine value to someone else's post. These are NOT ads. The comment must be worth reading even if the reader never clicks on our profile or product.

## Inputs

Environment variables:
- `PITCHBOX_CAMPAIGN_ID`
- `PITCHBOX_RUN_ID` (may be absent if invoked directly; step 1 creates it)

## Steps

1. **Start the run.**
   ```
   pitchbox run:start --campaign=$PITCHBOX_CAMPAIGN_ID
   ```
   Parse JSON. Extract `runId`, `config` (product, voice, topicAngles), `accounts`, `blocklist`.

2. **Fetch candidate posts.** The same `reddit:scout` command is used; the `matchedBy` field on each candidate tells you whether it came from a keyword search or a hot-browse pass.
   ```
   pitchbox reddit:scout --run=<runId>
   ```

3. **Read staged candidates.**
   ```
   pitchbox staging:candidates --run=<runId>
   ```

4. **Score each post for commenting fit (1–5).** Different criteria than the scout:
   - Is the post asking a question you can answer substantively?
   - Is it discussing a topic in `config['topicAngles']` or one of the project's strengths?
   - Is the thread fresh enough that a new comment will be seen (prefer < 24h old, `post.score` moderate, `numComments` growing but < 50)?
   - Is the community receptive to new voices (check `matchedBy`: `search` hits signal the OP invited broader engagement; `hot` hits are trendier but more crowded)?
   - Skip posts where the OP is hostile, venting about AI, or where the top comments already say what you would say.

   Drop candidates below 3.

5. **Draft the comment.** The voice rules are in `config['voice.post_rules']` (or fall back to `config['voice.dm_rules']` if post_rules absent — note the stylistic overlap). Typical hard rules:
   - No em-dashes.
   - No AI-tell vocabulary.
   - Capitalization proper. Not the DM lowercase register — comments are mid-register.
   - Contractions natural, not forced slang.
   - Open with the observation or direct answer. No "Great post!", no "Hope this helps!", no throat-clearing.
   - Close with a concrete question or observation, never "hope this helps" / "just my 2c".
   - Length: 60–150 words usually. Match the thread's register — if replies in the thread are one-liners, keep it short.

   **Self-promo constraint**: Default = no link, no product name, no offer. The comment stands on its own merits. Exception: if the OP is directly asking for recommendations and your product is a genuinely appropriate answer, one mention at the end (not the top) is acceptable — and only if `config['product.selfPromoPolicy']` allows it for the subreddit.

6. **Pick the account.** Comments almost always use the `personal` account (brand accounts commenting on other people's posts comes off as marketing spam). Use the first account with `role === 'personal'`. Record `accountId`.

7. **Build the URL.** For `post_comment` drafts the compose URL is just the post permalink:
   ```
   https://www.reddit.com{post.permalink}?pitchbox_draft=<draftId>
   ```
   The `pitchbox_draft` query param is how the browser extension (later milestone) finds the draft to auto-fill the comment textarea. For M1 the user copies the body manually; the param is harmless.

8. **Write drafts back.**
   ```
   echo '<json>' | pitchbox drafts:create --run=<runId>
   ```
   Each draft:
   ```json
   {
     "accountId": 1,
     "kind": "post_comment",
     "fitScore": 4,
     "subreddit": "Solo_Roleplaying",
     "targetUser": null,
     "body": "<comment markdown>",
     "composeUrl": "https://www.reddit.com/r/Solo_Roleplaying/comments/abc/.../",
     "reasoning": "2–3 sentences on why this post, what angle, what value you're adding.",
     "sourceRef": { "permalink": "/r/Solo_Roleplaying/comments/abc/.../", "postTitle": "..." },
     "metadata": { "matchedBy": "search", "postAgeHours": 8 }
   }
   ```
   Note `targetUser` is null for post_comment — the audience is the whole thread, not one user.

9. **Finish the run.**
   ```
   pitchbox run:finish --run=<runId> --status=success
   ```

## Hard constraints

- Never submit the comment. The human reviews and posts from Pitchbox.
- No shilling. If the only reason to comment is to plug the product, skip the post.
- No astroturfing. Don't pretend to be a random enthusiast if the product is ours — if asked, disclose per `config['product.disclosurePolicy']`.
- Respect subreddit rules. If the subreddit bans outside links or promotional content, your comment must not violate that even by implication.
- Skip any post authored by a handle in `config['blocklist']` or whose body ships the complaint pattern "AI is killing X".

## Failure modes

- Any CLI `{"ok": false}` → stop, `run:finish --status=failed --error="..."`.
- Zero qualifying candidates → still finish with `success`, zero drafts is valid.
