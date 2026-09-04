import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import {
  defaultLinkedInAssistSettings,
  saveLinkedInAssistSettings,
} from '@pitchbox/shared/linkedin-assist';
import { getAccountUsage } from '@pitchbox/shared/quota';
import { updateDraftWithVersion } from '../src/lib/server/draft-state.js';
import { POST as accept } from '../src/routes/api/extension/suggest/accept/+server.js';
import { POST as markSent } from '../src/routes/api/extension/draft/[id]/sent/+server.js';

/**
 * The other half of the real-time plane (#313): `/suggest` produces text
 * nobody has committed to anything yet, and this is what turns an accepted
 * suggestion into a real, ledgered `drafts` row - through the same
 * blocklist/dedup/quota gates a campaign draft goes through, so accepting
 * something Pitchbox helped write is never invisible to quota, contact
 * history or analytics.
 */

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, draft_events, contact_history, blocklist, extension_devices RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  await getDb().execute(sql`DELETE FROM app_config WHERE key = 'linkedin_assist'`);
  await getDb().execute(sql`DELETE FROM app_config WHERE key = 'dedup_policy'`);
}

async function seedOrgProject(slug: string, opts: { assist?: boolean } = {}) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: `p-${slug}`, name: slug, description: `about ${slug}` })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'linkedin'));
  if (opts.assist ?? true) {
    await saveLinkedInAssistSettings(db, org.id, {
      ...defaultLinkedInAssistSettings(),
      enabled: true,
      projectId: project.id,
    });
  }
  return { org, project, platform };
}

async function seedAccount(
  projectId: number,
  platformId: number,
  overrides: Partial<typeof schema.accounts.$inferInsert> = {},
) {
  const [account] = await getDb()
    .insert(schema.accounts)
    .values({ projectId, platformId, handle: 'lorenzo', active: true, ...overrides })
    .returning();
  return account;
}

async function mintDevice(organizationId: number | null, token: string) {
  await getDb()
    .insert(schema.extensionDevices)
    .values({
      organizationId,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      label: 'test',
    });
}

function request(token: string | null, body: unknown) {
  return new Request('http://x/api/extension/suggest/accept', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });
}

const POST_BODY = {
  kind: 'post_comment' as const,
  post: {
    urn: 'urn:li:activity:7000000000000000001',
    authorHandle: 'jane-doe',
    authorName: 'Jane Doe',
    url: 'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/',
  },
  body: 'We hit the same wall and cut p99 in half by batching the writes.',
  usage: {
    inputTokens: 2,
    outputTokens: 41,
    cacheReadTokens: 812,
    cacheCreationTokens: 0,
    costUsd: 0.0091,
  },
  ms: 8123,
};

describe('POST /api/extension/suggest/accept', () => {
  beforeEach(reset);

  it('refuses a request with no bearer token', async () => {
    await expect(
      accept({ request: request(null, { ...POST_BODY, projectId: 1 }) } as never),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('404s a project outside the device org, so it leaks no other tenant ids', async () => {
    const { project: bProject } = await seedOrgProject('acc-org-b');
    const { org: orgA } = await seedOrgProject('acc-org-a');
    await mintDevice(orgA.id, 'tokA');

    await expect(
      accept({ request: request('tokA', { ...POST_BODY, projectId: bProject.id }) } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses for an org that never turned the assistant on', async () => {
    const { org, project, platform } = await seedOrgProject('acc-off', { assist: false });
    await seedAccount(project.id, platform.id);
    await mintDevice(org.id, 'tokOff');

    const res = await accept({
      request: request('tokOff', { ...POST_BODY, projectId: project.id }),
    } as never);
    expect(await res.json()).toMatchObject({ refused: 'assist_disabled' });
    expect(await getDb().select().from(schema.drafts)).toHaveLength(0);
    expect(await getDb().select().from(schema.runs)).toHaveLength(0);
  });

  it('names the kill switch distinctly', async () => {
    const { org, project, platform } = await seedOrgProject('acc-killed', { assist: false });
    await seedAccount(project.id, platform.id);
    await saveLinkedInAssistSettings(getDb(), org.id, {
      ...defaultLinkedInAssistSettings(),
      enabled: true,
      projectId: project.id,
      killSwitch: true,
    });
    await mintDevice(org.id, 'tokKilled');

    const res = await accept({
      request: request('tokKilled', { ...POST_BODY, projectId: project.id }),
    } as never);
    expect(await res.json()).toMatchObject({ refused: 'kill_switch' });
  });

  it('refuses to write as a project of the same org that is not the bound one', async () => {
    const { org, project, platform } = await seedOrgProject('acc-bound');
    await seedAccount(project.id, platform.id);
    const [other] = await getDb()
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'p-other', name: 'other', description: 'other' })
      .returning();
    await mintDevice(org.id, 'tokBound');

    const res = await accept({
      request: request('tokBound', { ...POST_BODY, projectId: other.id }),
    } as never);
    expect(await res.json()).toMatchObject({
      refused: 'project_not_bound',
      boundProjectId: project.id,
    });
  });

  it('materialises exactly one draft and one terminal assist run, carrying cache tokens through honestly', async () => {
    const { org, project, platform } = await seedOrgProject('acc-happy');
    const account = await seedAccount(project.id, platform.id);
    await mintDevice(org.id, 'tokHappy');

    const res = await accept({
      request: request('tokHappy', { ...POST_BODY, projectId: project.id }),
    } as never);
    const body = (await res.json()) as { ok: boolean; draftId: number; runId: number };
    expect(body.ok).toBe(true);

    const runs = await getDb().select().from(schema.runs);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: body.runId,
      kind: 'assist',
      campaignId: null,
      projectId: project.id,
      status: 'success',
      inputTokens: 2,
      outputTokens: 41,
      cacheReadTokens: 812,
      cacheCreationTokens: 0,
    });
    expect(runs[0].costUsd).toBe('0.0091');
    expect(runs[0].finishedAt).not.toBeNull();

    const drafts = await getDb().select().from(schema.drafts);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      runId: body.runId,
      projectId: project.id,
      accountId: account.id,
      kind: 'post_comment',
      state: 'pending_review',
      targetUser: 'jane-doe',
      body: POST_BODY.body,
      version: 0,
    });
    expect(drafts[0].sourceRef).toMatchObject({ externalId: POST_BODY.post.urn });
  });

  it('refuses no_account when the project has no active LinkedIn account, with no partial write', async () => {
    const { org, project } = await seedOrgProject('acc-noacct');
    await mintDevice(org.id, 'tokNoAcct');

    const res = await accept({
      request: request('tokNoAcct', { ...POST_BODY, projectId: project.id }),
    } as never);
    expect(await res.json()).toMatchObject({ refused: 'no_account' });
    expect(await getDb().select().from(schema.drafts)).toHaveLength(0);
    expect(await getDb().select().from(schema.runs)).toHaveLength(0);
  });

  it('refuses a blocklisted target with no partial write', async () => {
    const { org, project, platform } = await seedOrgProject('acc-blocked');
    await seedAccount(project.id, platform.id);
    await mintDevice(org.id, 'tokBlocked');
    await getDb()
      .insert(schema.blocklist)
      .values({ platformId: platform.id, kind: 'user', value: 'jane-doe', scope: 'global' });

    const res = await accept({
      request: request('tokBlocked', { ...POST_BODY, projectId: project.id }),
    } as never);
    expect(await res.json()).toMatchObject({ refused: 'blocked' });
    expect(await getDb().select().from(schema.drafts)).toHaveLength(0);
    expect(await getDb().select().from(schema.runs)).toHaveLength(0);
  });

  it('refuses an exhausted daily quota with no partial write', async () => {
    const { org, project, platform } = await seedOrgProject('acc-quota');
    await seedAccount(project.id, platform.id, { dailyLimit: 0 });
    await mintDevice(org.id, 'tokQuota');

    const res = await accept({
      request: request('tokQuota', { ...POST_BODY, projectId: project.id }),
    } as never);
    expect(await res.json()).toMatchObject({ refused: 'quota_exhausted', window: 'day' });
    expect(await getDb().select().from(schema.drafts)).toHaveLength(0);
    expect(await getDb().select().from(schema.runs)).toHaveLength(0);
  });

  it('an accepted draft flows through send exactly like a campaign draft: one quota decrement, one contact_history row', async () => {
    const { org, project, platform } = await seedOrgProject('acc-send');
    const account = await seedAccount(project.id, platform.id);
    await mintDevice(org.id, 'tokSend');

    const acceptRes = await accept({
      request: request('tokSend', { ...POST_BODY, projectId: project.id }),
    } as never);
    const { draftId } = (await acceptRes.json()) as { draftId: number };

    const sentReq = new Request(`http://x/api/extension/draft/${draftId}/sent`, {
      method: 'POST',
      headers: { authorization: 'Bearer tokSend' },
      body: JSON.stringify({}),
    });
    const sentRes = await markSent({ params: { id: String(draftId) }, request: sentReq } as never);
    expect(sentRes.status).toBe(200);
    expect(await sentRes.json()).toMatchObject({ ok: true });

    const [draft] = await getDb().select().from(schema.drafts).where(eq(schema.drafts.id, draftId));
    expect(draft.state).toBe('sent');
    expect(draft.sentAt).not.toBeNull();

    const contacts = await getDb()
      .select()
      .from(schema.contactHistory)
      .where(eq(schema.contactHistory.draftId, draftId));
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      platformId: platform.id,
      accountHandle: account.handle,
      targetUser: 'jane-doe',
      organizationId: org.id,
    });

    // Quota decrement: getAccountUsage now counts this sent draft against
    // the account's comment usage for the day.
    const usage = await getAccountUsage(getDb(), account.id);
    expect(usage.comment.day).toBe(1);
  });

  it('holds optimistic locking on the created draft: a stale version is rejected, the current one succeeds', async () => {
    const { org, project, platform } = await seedOrgProject('acc-version');
    await seedAccount(project.id, platform.id);
    await mintDevice(org.id, 'tokVersion');

    const acceptRes = await accept({
      request: request('tokVersion', { ...POST_BODY, projectId: project.id }),
    } as never);
    const { draftId } = (await acceptRes.json()) as { draftId: number };

    const [fresh] = await getDb().select().from(schema.drafts).where(eq(schema.drafts.id, draftId));
    expect(fresh.version).toBe(0);

    const stale = await updateDraftWithVersion(draftId, fresh.version + 1, { state: 'approved' });
    expect(stale.kind).toBe('conflict');
    const [afterStale] = await getDb()
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.id, draftId));
    expect(afterStale.state).toBe('pending_review');

    const ok = await updateDraftWithVersion(draftId, fresh.version, { state: 'approved' });
    expect(ok.kind).toBe('ok');
    const [afterOk] = await getDb()
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.id, draftId));
    expect(afterOk.state).toBe('approved');
    expect(afterOk.version).toBe(1);
  });
});
