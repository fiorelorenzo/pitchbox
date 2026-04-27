export type IncomingCommentReply = {
  parentCommentId: string;
  replyCommentId: string;
  author: string;
  body: string;
  createdAt: string;
  contextUrl: string;
};

export type CommentDraftRow = {
  draftId: number;
  accountHandle: string;
  platformId: number;
  platformCommentId: string;
};

export type CommentReplyContact = {
  contactId: number;
  accountHandle: string;
  targetUser: string;
  draftId: number;
  repliedAt: Date | null;
};

export type ContactToCreate = {
  accountHandle: string;
  targetUser: string;
  draftId: number;
  platformId: number;
  lastContactedAt: Date;
  repliedAt: Date;
  platformContextUrl: string;
};

export type CommentMessageInsert = {
  contactKey:
    | { kind: 'existing'; contactId: number }
    | { kind: 'create'; accountHandle: string; targetUser: string; draftId: number };
  draftId: number;
  platformId: number;
  author: string;
  isFromUs: false;
  body: string;
  platformMessageId: string;
  createdAtPlatform: Date;
  source: 'extension';
};

export type CommentReplyEvent = {
  draftId: number;
  repliedAt: Date;
};

function norm(handle: string): string {
  return handle.replace(/^u\//i, '').trim().toLowerCase();
}

export function matchIncomingCommentReplies(
  batch: IncomingCommentReply[],
  drafts: CommentDraftRow[],
  existingContacts: CommentReplyContact[],
): {
  contactsToCreate: ContactToCreate[];
  messageInserts: CommentMessageInsert[];
  draftRepliedEvents: CommentReplyEvent[];
} {
  const draftByCommentId = new Map<string, CommentDraftRow>();
  for (const d of drafts) draftByCommentId.set(d.platformCommentId, d);

  type ContactKey = string;
  const contactKey = (account: string, target: string, draftId: number): ContactKey =>
    `${norm(account)}::${norm(target)}::${draftId}`;
  const existingByKey = new Map<ContactKey, CommentReplyContact>();
  for (const c of existingContacts) {
    existingByKey.set(contactKey(c.accountHandle, c.targetUser, c.draftId), c);
  }

  const contactsToCreate: ContactToCreate[] = [];
  const createdKeys = new Set<ContactKey>();
  const messageInserts: CommentMessageInsert[] = [];
  const seenReplyId = new Set<string>();
  const repliedEventsByDraft = new Map<number, Date>();
  const draftsAlreadyRepliedByUser = new Set<ContactKey>();

  for (const c of existingContacts) {
    if (c.repliedAt !== null) {
      draftsAlreadyRepliedByUser.add(contactKey(c.accountHandle, c.targetUser, c.draftId));
    }
  }

  for (const reply of batch) {
    const draft = draftByCommentId.get(reply.parentCommentId);
    if (!draft) continue;

    const dedupKey = `${draft.platformId}::${reply.replyCommentId}`;
    if (seenReplyId.has(dedupKey)) continue;
    seenReplyId.add(dedupKey);

    const target = norm(reply.author);
    const key = contactKey(draft.accountHandle, target, draft.draftId);
    const createdAt = new Date(reply.createdAt);

    const existing = existingByKey.get(key);
    if (existing) {
      messageInserts.push({
        contactKey: { kind: 'existing', contactId: existing.contactId },
        draftId: draft.draftId,
        platformId: draft.platformId,
        author: target,
        isFromUs: false,
        body: reply.body,
        platformMessageId: reply.replyCommentId,
        createdAtPlatform: createdAt,
        source: 'extension',
      });
      if (!draftsAlreadyRepliedByUser.has(key)) {
        const prev = repliedEventsByDraft.get(draft.draftId);
        if (!prev || createdAt < prev) repliedEventsByDraft.set(draft.draftId, createdAt);
        draftsAlreadyRepliedByUser.add(key);
      }
      continue;
    }

    if (!createdKeys.has(key)) {
      contactsToCreate.push({
        accountHandle: draft.accountHandle,
        targetUser: target,
        draftId: draft.draftId,
        platformId: draft.platformId,
        lastContactedAt: createdAt,
        repliedAt: createdAt,
        platformContextUrl: reply.contextUrl,
      });
      createdKeys.add(key);
      const prev = repliedEventsByDraft.get(draft.draftId);
      if (!prev || createdAt < prev) repliedEventsByDraft.set(draft.draftId, createdAt);
      draftsAlreadyRepliedByUser.add(key);
    }

    messageInserts.push({
      contactKey: {
        kind: 'create',
        accountHandle: draft.accountHandle,
        targetUser: target,
        draftId: draft.draftId,
      },
      draftId: draft.draftId,
      platformId: draft.platformId,
      author: target,
      isFromUs: false,
      body: reply.body,
      platformMessageId: reply.replyCommentId,
      createdAtPlatform: createdAt,
      source: 'extension',
    });
  }

  const draftRepliedEvents: CommentReplyEvent[] = [];
  for (const [draftId, repliedAt] of repliedEventsByDraft) {
    draftRepliedEvents.push({ draftId, repliedAt });
  }
  return { contactsToCreate, messageInserts, draftRepliedEvents };
}
