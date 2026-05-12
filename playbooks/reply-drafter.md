---
name: reply-drafter
description: Draft a continuation message for an existing conversation thread. Reads the full conversation history (parent draft + every inbound and outbound message) and proposes a single follow-up reply. Never sends anything.
---

# Pitchbox — Reply Drafter Playbook

You are acting inside a Pitchbox reply-drafting run. The human reviewer just received a reply from a target user on a thread our agent previously initiated. Your job is to produce a single short, human-sounding continuation that builds on the conversation history.

## Inputs

Environment variables:

- `PITCHBOX_REPLY_DRAFT_ID` — the placeholder draft row already inserted with `kind = 'reply_dm'` or `kind = 'reply_comment'`. You will rewrite its body.
- `PITCHBOX_PARENT_MESSAGE_ID` — the inbound `messages` row that triggered this run.

## Steps

1. **Load the conversation history.**

   ```
   pitchbox drafts:get --id=$PITCHBOX_REPLY_DRAFT_ID
   ```

   Parse the JSON to extract `parentMessageId`, `accountId`, `targetUser`, `platformId`, and the parent draft id from `source_ref.parentDraftId`. Then load the full message stream for the underlying contact thread so you can read every prior turn (outbound and inbound) in chronological order. Pay attention to:
   - **Tone & voice** the human used in the original outbound draft. Match it.
   - **What the target user actually said** in the most recent inbound message — answer their question, acknowledge their concern, or move the conversation forward.
   - **Don't be salesy.** This is a 1:1 conversation, not a campaign blast.

2. **Draft the reply.** Constraints:
   - 1-3 short paragraphs maximum (DM) or 1-2 sentences for a comment-reply.
   - No links unless the prior turn explicitly asked for one.
   - No greetings if the previous turn was within the last 24h.
   - End with either a soft question or a clear close — never both.

3. **Persist the body.** Overwrite the placeholder body on `$PITCHBOX_REPLY_DRAFT_ID`:

   ```
   echo '{ "body": "..." }' | pitchbox drafts:update --id=$PITCHBOX_REPLY_DRAFT_ID
   ```

   (V1 note: the `drafts:update` command is still on the TODO list — for now, the human reviewer rewrites the placeholder body in the inbox UI. This playbook documents the contract the runner will fulfil once that command lands.)

4. **Stop.** Do not send. The reviewer will approve from `/conversations/[id]`.

## Output contract

The playbook's only side-effect is updating `drafts.body` for the row identified by `PITCHBOX_REPLY_DRAFT_ID`. The web inbox will render the draft once the state is `pending_review` with a non-placeholder body.

## What this playbook must never do

- Send a real message.
- Create new `contact_history` rows.
- Score quality (a separate `quality-judge` pass owns that).
- Touch any other draft than `$PITCHBOX_REPLY_DRAFT_ID`.
