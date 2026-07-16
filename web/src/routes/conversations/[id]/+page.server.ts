import { error } from '@sveltejs/kit';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { decodeThreadId } from './thread-id.js';
import { loadPendingReplyDraft } from '@pitchbox/shared/reply-drafter';
import { listProjects } from '@pitchbox/shared/projects';
import { draftBelongsToOrg } from '@pitchbox/shared/orgs';
import { requireOrgId } from '$lib/server/auth.js';

export async function load(event: import('@sveltejs/kit').RequestEvent) {
  const { params } = event;
  let key;
  try {
    key = decodeThreadId(params.id as string);
  } catch {
    throw error(400, 'invalid thread id');
  }

  const db = getDb();
  // requireOrgId (not resolveOrgId) so an unresolved org 404s instead of
  // silently falling through to listProjects({ organizationId: null }),
  // which returns every org's projects and defeats the scoping below.
  const orgId = await requireOrgId(event);
  const projects = await listProjects(db, { organizationId: orgId });
  const projectIds = projects.map((p) => p.id);
  const hasProjects = projectIds.length > 0;

  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, key.platform));
  if (!platform) throw error(404, 'platform not found');

  // contact_history is the per-(account_handle, target_user, platform) source of
  // truth; we may have several rows for the same pair if the agent contacted
  // the user multiple times - pick the most recent for first/last/outcome.
  const contacts = await db
    .select()
    .from(schema.contactHistory)
    .where(
      and(
        eq(schema.contactHistory.platformId, platform.id),
        eq(schema.contactHistory.accountHandle, key.accountHandle),
        eq(schema.contactHistory.targetUser, key.targetUser),
      ),
    )
    .orderBy(desc(schema.contactHistory.lastContactedAt));

  if (contacts.length === 0) throw error(404, 'thread not found');

  const latest = contacts[0];
  const oldest = contacts[contacts.length - 1];
  const contactIds = contacts.map((c) => c.id);

  // Parent draft for the thread = the draft attached to the most recent
  // contact_history row (that's the one the agent last produced for the pair).
  // contact_history is a global accepted residual (see the
  // organization-isolation design doc), so a thread id reached by an org-B
  // user can point at an org-A contact whose draft belongs to org A - never
  // return that draft to a caller outside its org.
  let parentDraft: typeof schema.drafts.$inferSelect | null = null;
  if (latest.draftId != null && (await draftBelongsToOrg(db, latest.draftId, orgId))) {
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, latest.draftId));
    parentDraft = d ?? null;
  }

  // Load every message attached to any contact_history row in this thread,
  // chronologically ascending. Messages are attributed to an org through the
  // draft they were matched to (drafts.projectId); a message with no draftId
  // cannot be attributed to any org, so it is excluded here rather than risk
  // showing it across tenants.
  const messageColumns = {
    id: schema.messages.id,
    contactId: schema.messages.contactId,
    author: schema.messages.author,
    isFromUs: schema.messages.isFromUs,
    body: schema.messages.body,
    createdAt: schema.messages.createdAtPlatform,
    source: schema.messages.source,
    draftId: schema.messages.draftId,
    draftKind: schema.drafts.kind,
  };
  let rows: Array<{
    id: number;
    contactId: number;
    author: string;
    isFromUs: boolean;
    body: string;
    createdAt: Date;
    source: string;
    draftId: number | null;
    draftKind: string | null;
  }> = [];

  if (hasProjects) {
    rows = await db
      .select(messageColumns)
      .from(schema.messages)
      .innerJoin(schema.drafts, eq(schema.messages.draftId, schema.drafts.id))
      .where(
        and(
          contactIds.length === 1
            ? eq(schema.messages.contactId, contactIds[0])
            : inArray(schema.messages.contactId, contactIds),
          inArray(schema.drafts.projectId, projectIds),
        ),
      )
      .orderBy(asc(schema.messages.createdAtPlatform));
  }

  // Reply drafting (issue #49): show the pending auto-drafted reply (if any)
  // attached to one of this thread's inbound messages. Same residual risk as
  // parentDraft above - contactIds come from the global contact_history, so
  // the reply draft they resolve to can belong to another org; never return
  // it to a caller outside its org.
  let replyDraft = null as Awaited<ReturnType<typeof loadPendingReplyDraft>> | null;
  for (const cid of contactIds) {
    const found = await loadPendingReplyDraft(db, cid);
    if (found) {
      replyDraft = found;
      break;
    }
  }
  if (replyDraft && !(await draftBelongsToOrg(db, replyDraft.id, orgId))) {
    replyDraft = null;
  }

  return {
    replyDraft,
    thread: {
      id: params.id,
      accountHandle: key.accountHandle,
      targetUser: key.targetUser,
      platform: key.platform,
    },
    messages: rows.map((r) => ({
      id: r.id,
      author: r.author,
      isFromUs: r.isFromUs,
      body: r.body,
      createdAt: r.createdAt,
      source: r.source,
      // `kind` here is the kind of the draft the message belongs to (when the
      // extension was able to attribute it). It drives the per-message badge:
      // `dm` vs `post_comment` vs unknown.
      kind: r.draftKind ?? null,
    })),
    parentDraft: parentDraft
      ? {
          id: parentDraft.id,
          kind: parentDraft.kind,
          body: parentDraft.body,
          state: parentDraft.state,
          sentAt: parentDraft.sentAt,
        }
      : null,
    contactHistory: {
      firstContactedAt: oldest.lastContactedAt,
      lastContactedAt: latest.lastContactedAt,
      repliedAt: latest.repliedAt,
      outcome: latest.repliedAt ? 'replied' : 'awaiting',
      platformContextUrl: latest.platformContextUrl,
      chatRoomId: latest.chatRoomId,
    },
  };
}
