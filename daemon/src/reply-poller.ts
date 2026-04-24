import { getDb, schema } from '@pitchbox/shared/db';
import { and, asc, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { logger } from './logger.js';
import { getReplyReader } from './reply-readers.js';

const log = logger('reply-poller');

/** Only poll DMs sent in the last N days — nothing older is worth checking. */
const LOOKBACK_DAYS = 14;
/** Wait at least this long between re-checks of the same contact. */
const RECHECK_SECONDS = 15 * 60;

/** Oldest first, and only contacts needing a check. */
async function pickContactsToCheck(limit: number) {
  const db = getDb();
  const cutoff = new Date(Date.now() - RECHECK_SECONDS * 1000);

  return db
    .select({
      id: schema.contactHistory.id,
      platformId: schema.contactHistory.platformId,
      platformSlug: schema.platforms.slug,
      accountHandle: schema.contactHistory.accountHandle,
      targetUser: schema.contactHistory.targetUser,
      lastContactedAt: schema.contactHistory.lastContactedAt,
      draftId: schema.contactHistory.draftId,
    })
    .from(schema.contactHistory)
    .innerJoin(schema.platforms, eq(schema.contactHistory.platformId, schema.platforms.id))
    .where(
      and(
        isNull(schema.contactHistory.repliedAt),
        sql`${schema.contactHistory.lastContactedAt} > now() - interval '${sql.raw(`${LOOKBACK_DAYS} days`)}'`,
        or(
          isNull(schema.contactHistory.replyCheckedAt),
          lt(schema.contactHistory.replyCheckedAt, cutoff),
        ),
      ),
    )
    .orderBy(asc(schema.contactHistory.replyCheckedAt), desc(schema.contactHistory.lastContactedAt))
    .limit(limit);
}

async function markReplyChecked(contactId: number): Promise<void> {
  const db = getDb();
  await db
    .update(schema.contactHistory)
    .set({ replyCheckedAt: new Date() })
    .where(eq(schema.contactHistory.id, contactId));
}

async function recordReply(contactId: number, draftId: number | null, at: Date): Promise<void> {
  const db = getDb();
  await db
    .update(schema.contactHistory)
    .set({ repliedAt: at, replyCheckedAt: new Date() })
    .where(eq(schema.contactHistory.id, contactId));
  if (draftId != null) {
    await db.insert(schema.draftEvents).values({
      draftId,
      event: 'replied',
      actor: 'daemon',
      details: { at: at.toISOString() },
    });
  }
}

/**
 * One poll tick:
 *  - pick a batch of unanswered contacts needing re-check
 *  - group by (platform, account) and read the reply inbox once per group
 *  - for each matched reply, record it
 *  - for the rest, just bump reply_checked_at so we don't re-poll too soon
 */
export async function tick(): Promise<{ checked: number; newReplies: number; skipped: number }> {
  const contacts = await pickContactsToCheck(50);
  if (contacts.length === 0) return { checked: 0, newReplies: 0, skipped: 0 };

  type GroupKey = string;
  const groups = new Map<GroupKey, typeof contacts>();
  for (const c of contacts) {
    const k = `${c.platformSlug}::${c.accountHandle}`;
    const arr = groups.get(k) ?? [];
    arr.push(c);
    groups.set(k, arr);
  }

  let newReplies = 0;
  let skipped = 0;

  for (const [key, group] of groups) {
    const [platformSlug, accountHandle] = key.split('::');
    const reader = getReplyReader(platformSlug);
    if (!reader) {
      log.debug(`no reply reader for platform "${platformSlug}" — skipping ${group.length}`);
      skipped += group.length;
      for (const c of group) await markReplyChecked(c.id);
      continue;
    }

    const since = new Date(Math.min(...group.map((c) => new Date(c.lastContactedAt).getTime())));

    let replies;
    try {
      replies = await reader.readReplies({ accountHandle, since });
    } catch (err) {
      log.warn(`reader ${platformSlug}:${accountHandle} threw — skipping group`, err);
      continue;
    }

    const repliedByUser = new Map<string, Date>();
    for (const r of replies) repliedByUser.set(r.targetUser.toLowerCase(), r.at);

    for (const c of group) {
      const at = repliedByUser.get(c.targetUser.toLowerCase());
      if (at) {
        await recordReply(c.id, c.draftId, at);
        newReplies++;
        log.info(`reply from ${platformSlug}:u/${c.targetUser} (contact #${c.id})`);
      } else {
        await markReplyChecked(c.id);
      }
    }
  }

  return { checked: contacts.length, newReplies, skipped };
}
