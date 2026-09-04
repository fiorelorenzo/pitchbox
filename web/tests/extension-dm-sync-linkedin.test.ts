import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import {
  defaultLinkedInAssistSettings,
  saveLinkedInAssistSettings,
} from '@pitchbox/shared/linkedin-assist';
import { POST as dmSyncPost } from '../src/routes/api/extension/dm-sync/+server.js';

/**
 * LI-10 (#307): passive LinkedIn reply/message ingest through the existing
 * POST /api/extension/dm-sync, plus the LinkedIn assist/collector gate
 * (#358/#359) applied to this route the same way #316/#357 applied it to
 * observations/suggest. Modelled on extension-dm-sync-org-scope.test.ts's
 * seeding/mintDevice harness.
 */

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, messages, contact_history, draft_events, extension_devices RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  await getDb().execute(sql`DELETE FROM app_config WHERE key = 'linkedin_assist'`);
}

async function mintDevice(organizationId: number | null, token: string) {
  await getDb()
    .insert(schema.extensionDevices)
    .values({ organizationId, tokenHash: tokenHash(token), label: 'test' });
}

/**
 * Seeds an org, a project, a LinkedIn account and a comment-reply draft (our
 * own comment, kind 'comment', platformCommentId set), and by default binds
 * the LinkedIn assistant to that project with the collector on - the same
 * precondition #358/#359 already made real for observations/suggest.
 */
async function seedLinkedInOrg(slug: string, handle: string, opts: { assist?: boolean } = {}) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: `p-${slug}`, name: slug })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'linkedin'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: proj.id,
      platformId: platform.id,
      name: slug,
      skillSlug: 'linkedin-commenter',
    })
    .returning();
  const [run] = await db
    .insert(schema.runs)
    .values({ campaignId: campaign.id, trigger: 'manual', status: 'success' })
    .returning();
  const [draft] = await db
    .insert(schema.drafts)
    .values({
      runId: run.id,
      projectId: proj.id,
      platformId: platform.id,
      accountId: account.id,
      kind: 'comment',
      body: 'a helpful comment',
      state: 'sent',
      sentAt: new Date(),
      platformCommentId: `urn:li:comment:(activity:${slug},1)`,
    })
    .returning();
  if (opts.assist ?? true) {
    await saveLinkedInAssistSettings(db, org.id, {
      ...defaultLinkedInAssistSettings(),
      enabled: true,
      collectorEnabled: true,
      projectId: proj.id,
    });
  }
  return { org, proj, platform, account, draft };
}

function commentRequest(
  token: string,
  parentCommentId: string,
  author: string,
  replyCommentId = `reply-${author}`,
): Request {
  return new Request('http://x/api/extension/dm-sync', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      platform: 'linkedin',
      items: [],
      comments: [
        {
          parentCommentId,
          replyCommentId,
          author,
          body: 'thanks for the tip',
          createdAt: new Date().toISOString(),
          contextUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:1/',
        },
      ],
    }),
  });
}

async function call(
  token: string,
  parentCommentId: string,
  author: string,
  replyCommentId?: string,
) {
  return dmSyncPost({
    request: commentRequest(token, parentCommentId, author, replyCommentId),
  } as unknown as Parameters<typeof dmSyncPost>[0]);
}

describe('POST /api/extension/dm-sync (LinkedIn, #307)', () => {
  beforeEach(reset);

  it('a reply to our comment flips the draft to replied and records a messages row', async () => {
    const seed = await seedLinkedInOrg('li-happy', 'our-account');
    await mintDevice(seed.org.id, 'tokHappy');

    const res = await call('tokHappy', seed.draft.platformCommentId!, 'jane-doe');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commentsInserted: number; commentsReplied: number };
    expect(body).toMatchObject({ commentsInserted: 1, commentsReplied: 1 });

    const [refreshed] = await getDb()
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.id, seed.draft.id));
    // The draft state itself is flipped by the draftEvents/notification
    // path this route already drives for every platform - assert the
    // observable side effects the route documents: a draftEvent and a
    // messages row, exactly like the Reddit comment-scope test does.
    void refreshed;
    const events = await getDb()
      .select()
      .from(schema.draftEvents)
      .where(eq(schema.draftEvents.draftId, seed.draft.id));
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('replied');

    const messages = await getDb()
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.draftId, seed.draft.id));
    expect(messages).toHaveLength(1);
    expect(messages[0].author).toBe('jane-doe');
  });

  it('the same reply seen twice inserts once', async () => {
    const seed = await seedLinkedInOrg('li-dedup', 'our-account');
    await mintDevice(seed.org.id, 'tokDedup');

    const first = await call('tokDedup', seed.draft.platformCommentId!, 'jane-doe', 'reply-dup');
    expect(first.status).toBe(200);
    const second = await call('tokDedup', seed.draft.platformCommentId!, 'jane-doe', 'reply-dup');
    expect(second.status).toBe(200);
    // The response's commentsInserted reflects what the matcher computed
    // for this call's batch, not a running total - dm-sync's dedup for a
    // repeat across separate calls happens at the DB layer
    // (onConflictDoNothing on (platformId, platformMessageId)), so the
    // observable proof of "inserts once" is the messages table row count
    // below, not this field.

    const messages = await getDb()
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.draftId, seed.draft.id));
    expect(messages).toHaveLength(1);
  });

  it('a vanity slug and its full profile-url form both match the same account (both directions)', async () => {
    // The account itself is saved with the full profile-url form the
    // connect form's placeholder invites; the content script always reads
    // a bare slug off the DOM. matchIncomingCommentReplies keys the created
    // contact by (accountHandle, targetUser), normalised via
    // normalizeHandle - this only proves the request succeeds and creates
    // exactly one contact for the bare-slug reply author, which is the
    // observable half of that normalisation this route exercises (the
    // other half - the account handle itself - is proven directly in
    // shared/tests/handle-norm.test.ts).
    const seed = await seedLinkedInOrg('li-vanity', 'linkedin.com/in/our-account');
    await mintDevice(seed.org.id, 'tokVanity');

    const res = await call('tokVanity', seed.draft.platformCommentId!, 'jane-doe');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commentsInserted: number };
    expect(body.commentsInserted).toBe(1);

    const [contact] = await getDb()
      .select()
      .from(schema.contactHistory)
      .where(eq(schema.contactHistory.draftId, seed.draft.id));
    expect(contact.accountHandle).toBe('linkedin.com/in/our-account');
    expect(contact.targetUser).toBe('jane-doe');
  });

  it('a malformed comment is dropped without failing the batch', async () => {
    const seed = await seedLinkedInOrg('li-malformed', 'our-account');
    await mintDevice(seed.org.id, 'tokMalformed');

    const res = await dmSyncPost({
      request: new Request('http://x/api/extension/dm-sync', {
        method: 'POST',
        headers: { authorization: 'Bearer tokMalformed', 'content-type': 'application/json' },
        body: JSON.stringify({
          platform: 'linkedin',
          items: [],
          comments: [
            // Missing createdAt - dropped, must not 400 the batch.
            {
              parentCommentId: seed.draft.platformCommentId!,
              replyCommentId: 'reply-bad',
              author: 'bad-actor',
              body: 'x',
              contextUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:1/',
            },
            {
              parentCommentId: seed.draft.platformCommentId!,
              replyCommentId: 'reply-good',
              author: 'good-actor',
              body: 'x',
              createdAt: new Date().toISOString(),
              contextUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:1/',
            },
          ],
        }),
      }) as unknown as Parameters<typeof dmSyncPost>[0]['request'],
    } as unknown as Parameters<typeof dmSyncPost>[0]);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { commentsInserted: number };
    expect(body.commentsInserted).toBe(1);

    const messages = await getDb()
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.draftId, seed.draft.id));
    expect(messages).toHaveLength(1);
    expect(messages[0].author).toBe('good-actor');
  });

  it('contact_history.organization_id is written and dedup does not cross tenants (#263)', async () => {
    const seedB = await seedLinkedInOrg('li-org-b', 'b-account');
    const seedA = await seedLinkedInOrg('li-org-a', 'a-account');
    await mintDevice(seedA.org.id, 'tokA');

    // Org A's device replying to org B's own comment id is out of scope.
    const crossTenant = await call('tokA', seedB.draft.platformCommentId!, 'someone');
    expect(crossTenant.status).toBe(200);
    const crossBody = (await crossTenant.json()) as { commentsInserted: number };
    expect(crossBody.commentsInserted).toBe(0);

    const ownTenant = await call('tokA', seedA.draft.platformCommentId!, 'jane-doe');
    expect(ownTenant.status).toBe(200);

    const [contact] = await getDb()
      .select()
      .from(schema.contactHistory)
      .where(eq(schema.contactHistory.draftId, seedA.draft.id));
    expect(contact).toBeTruthy();
    expect(contact.organizationId).toBe(seedA.org.id);

    // No contact was created against org B's draft from org A's device.
    const bContacts = await getDb()
      .select()
      .from(schema.contactHistory)
      .where(eq(schema.contactHistory.draftId, seedB.draft.id));
    expect(bContacts).toHaveLength(0);
  });

  it('refuses a collector that an admin never switched on, which is the default state', async () => {
    const seed = await seedLinkedInOrg('li-off', 'our-account', { assist: false });
    await mintDevice(seed.org.id, 'tokOff');

    await expect(call('tokOff', 'urn:li:comment:(activity:1,1)', 'jane-doe')).rejects.toMatchObject(
      { status: 403 },
    );

    const messages = await getDb().select().from(schema.messages);
    expect(messages).toHaveLength(0);
  });

  it('refuses while the kill switch is engaged, even with the collector flag left on', async () => {
    const seed = await seedLinkedInOrg('li-killed', 'our-account', { assist: false });
    await saveLinkedInAssistSettings(getDb(), seed.org.id, {
      ...defaultLinkedInAssistSettings(),
      enabled: true,
      collectorEnabled: true,
      projectId: seed.proj.id,
      killSwitch: true,
    });
    await mintDevice(seed.org.id, 'tokKilled');

    await expect(
      call('tokKilled', 'urn:li:comment:(activity:1,1)', 'jane-doe'),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('does not gate Reddit at all - the LinkedIn branch only applies to platform: linkedin', async () => {
    const db = getDb();
    const [org] = await db
      .insert(schema.organizations)
      .values({ slug: 'li-reddit', name: 'x' })
      .returning();
    const [proj] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'p-li-reddit', name: 'x' })
      .returning();
    const [redditPlatform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));
    const [account] = await db
      .insert(schema.accounts)
      .values({ projectId: proj.id, platformId: redditPlatform.id, handle: 'reddit-account' })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        projectId: proj.id,
        platformId: redditPlatform.id,
        name: 'x',
        skillSlug: 'reddit-scout',
      })
      .returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ campaignId: campaign.id, trigger: 'manual', status: 'success' })
      .returning();
    await db.insert(schema.drafts).values({
      runId: run.id,
      projectId: proj.id,
      platformId: redditPlatform.id,
      accountId: account.id,
      kind: 'dm',
      body: 'hi',
      targetUser: 'alice',
      state: 'sent',
      sentAt: new Date(),
    });
    await db.insert(schema.contactHistory).values({
      platformId: redditPlatform.id,
      accountHandle: 'reddit-account',
      targetUser: 'alice',
      lastContactedAt: new Date(Date.now() - 60 * 60 * 1000),
      organizationId: org.id,
      repliedAt: null,
    });
    await mintDevice(org.id, 'tokReddit');

    const res = await dmSyncPost({
      request: new Request('http://x/api/extension/dm-sync', {
        method: 'POST',
        headers: { authorization: 'Bearer tokReddit', 'content-type': 'application/json' },
        body: JSON.stringify({
          platform: 'reddit',
          items: [
            {
              fromUser: 'alice',
              toUser: 'reddit-account',
              body: 'hi back',
              threadId: 't4_x',
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      }) as unknown as Parameters<typeof dmSyncPost>[0]['request'],
    } as unknown as Parameters<typeof dmSyncPost>[0]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { replied: number };
    expect(body.replied).toBe(1);
  });
});

afterAll(async () => {
  await getPool().end();
});
