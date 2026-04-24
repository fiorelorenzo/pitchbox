export type IncomingDm = {
  fromUser: string;
  toUser: string;
  body: string;
  threadId: string;
  createdAt: string;
};

export type ContactRow = {
  id: number;
  accountHandle: string;
  targetUser: string;
  platformId: number;
  draftId: number | null;
  lastContactedAt: Date;
  repliedAt: Date | null;
};

export type MessageInsert = {
  contactId: number;
  draftId: number | null;
  platformId: number;
  author: string;
  isFromUs: boolean;
  body: string;
  platformMessageId: string;
  createdAtPlatform: Date;
  source: 'extension';
};

export type ReplyUpdate = {
  contactId: number;
  draftId: number | null;
  repliedAt: Date;
};

const GRACE_MS = 5 * 60 * 1000;

function norm(handle: string): string {
  return handle.replace(/^u\//i, '').trim().toLowerCase();
}

export function matchIncomingDms(
  batch: IncomingDm[],
  contacts: ContactRow[],
): { inserts: MessageInsert[]; updates: ReplyUpdate[] } {
  const inserts: MessageInsert[] = [];
  const earliestReplyByContact = new Map<number, Date>();
  const seenPlatformMessage = new Set<string>();

  type IndexKey = string;
  const key = (account: string, target: string): IndexKey => `${norm(account)}::${norm(target)}`;
  const byPair = new Map<IndexKey, ContactRow>();
  for (const c of contacts) byPair.set(key(c.accountHandle, c.targetUser), c);

  for (const dm of batch) {
    const from = norm(dm.fromUser);
    const to = norm(dm.toUser);

    const asReply = byPair.get(key(to, from));
    const asOutgoing = byPair.get(key(from, to));
    const contact = asReply ?? asOutgoing;
    if (!contact) continue;

    const createdAt = new Date(dm.createdAt);
    if (createdAt.getTime() < contact.lastContactedAt.getTime() - GRACE_MS) continue;

    const dedupKey = `${contact.platformId}::${dm.threadId}`;
    if (seenPlatformMessage.has(dedupKey)) continue;
    seenPlatformMessage.add(dedupKey);

    const isFromUs = !!asOutgoing && !asReply;
    inserts.push({
      contactId: contact.id,
      draftId: contact.draftId,
      platformId: contact.platformId,
      author: from,
      isFromUs,
      body: dm.body,
      platformMessageId: dm.threadId,
      createdAtPlatform: createdAt,
      source: 'extension',
    });

    if (!isFromUs && contact.repliedAt === null) {
      const existing = earliestReplyByContact.get(contact.id);
      if (!existing || createdAt < existing) {
        earliestReplyByContact.set(contact.id, createdAt);
      }
    }
  }

  const updates: ReplyUpdate[] = [];
  for (const [contactId, repliedAt] of earliestReplyByContact) {
    const c = contacts.find((x) => x.id === contactId)!;
    updates.push({ contactId, draftId: c.draftId, repliedAt });
  }
  return { inserts, updates };
}
