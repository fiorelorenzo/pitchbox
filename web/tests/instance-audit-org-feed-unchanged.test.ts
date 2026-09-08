import { afterAll, describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { hashPassword, createSession } from '@pitchbox/shared/auth';
import { loadAuditFeed } from '../src/lib/server/audit-feed.js';
import { PUT as defaultRunnerPut } from '../src/routes/api/settings/default-runner/+server.js';
import { POST as quotaPost } from '../src/routes/api/settings/quota/+server.js';
import { PUT as webhooksPut } from '../src/routes/api/settings/webhooks/+server.js';
import { POST as modelFunctionsPost } from '../src/routes/api/settings/model-functions/+server.js';
import { actions as retentionActions } from '../src/routes/settings/retention/+page.server.js';
import { type CookieJar, runThroughHandle } from './helpers/handle-harness.js';

// #414 acceptance: "a member's view of the org audit feed is unchanged" is
// an assertion, not a hope. Every instance-wide write recordInstanceAudit
// covers goes through the real route here, against a real org that also has
// its own draft/run events - if any of them leaked a row into the org feed
// (writing to the wrong table, or draft_events/run_events instead of
// instance_audit_log), this test would see the feed grow or change.

const PASSWORD = 'correct-horse-battery';
const originalAuth = process.env.PITCHBOX_AUTH;

async function reset() {
  const db = getDb();
  await db.execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  await db.execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, draft_events, run_events, instance_audit_log RESTART IDENTITY CASCADE`,
  );
  await db.execute(
    sql`DELETE FROM app_config WHERE key IN ('default_runner', 'quota_defaults', 'notification_webhooks', 'retention', 'model_functions')`,
  );
}

async function getDefaultOrgId(): Promise<number> {
  const [org] = await getDb()
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  return org.id;
}

async function seedOrgFeed(orgId: number) {
  const db = getDb();
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: orgId, slug: 'iaof-test', name: 'iaof-test' })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle: 'iaof-tester' })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId: proj.id, platformId: platform.id, name: 'c', skillSlug: 's' })
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
      kind: 'dm',
      body: 'hello',
      targetUser: 'someone',
      state: 'pending_review',
    })
    .returning();
  await db.insert(schema.draftEvents).values({
    draftId: draft.id,
    event: 'created',
    actor: 'agent',
    details: {},
  });
  await db.insert(schema.runEvents).values({
    runId: run.id,
    seq: 1,
    kind: 'started',
    payload: {},
    raw: '{}',
  });
}

async function instanceAdminSession(): Promise<CookieJar> {
  const hash = await hashPassword(PASSWORD);
  const username = 'iaof-admin';
  await getDb()
    .insert(schema.users)
    .values({ username, passwordHash: hash, isInstanceAdmin: true })
    .onConflictDoUpdate({ target: schema.users.username, set: { isInstanceAdmin: true } });
  const [user] = await getDb()
    .select()
    .from(schema.users)
    .where(sql`username = ${username}`);
  const [org] = await getDb()
    .select()
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  await getDb()
    .insert(schema.memberships)
    .values({ organizationId: org.id, userId: user.id, role: 'admin' })
    .onConflictDoUpdate({
      target: [schema.memberships.organizationId, schema.memberships.userId],
      set: { role: 'admin' },
    });
  const session = await createSession(getDb(), user.id);
  return { store: new Map([['pitchbox_session', { value: session.id }]]) };
}

describe('org audit feed is unaffected by instance-wide writes', () => {
  beforeEach(reset);

  it('is byte-identical before and after every instance-wide write', async () => {
    const orgId = await getDefaultOrgId();
    await seedOrgFeed(orgId);
    const before = await loadAuditFeed(orgId);
    expect(before).toHaveLength(2);

    const jar = await instanceAdminSession();
    const call = (req: Request, handler: (e: unknown) => Promise<Response>) =>
      runThroughHandle(req, jar, handler as any);

    await call(
      new Request('http://localhost/api/settings/default-runner', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'claude-code' }),
      }),
      defaultRunnerPut as any,
    );
    await call(
      new Request('http://localhost/api/settings/quota', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      quotaPost as any,
    );
    await call(
      new Request('http://localhost/api/settings/webhooks', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://hooks.example.test/aaa' }),
      }),
      webhooksPut as any,
    );
    await call(
      new Request('http://localhost/api/settings/model-functions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fn: 'assist_suggest', modelId: 'openai/gpt-5-mini' }),
      }),
      modelFunctionsPost as any,
    );
    const fd = new FormData();
    fd.set('drafts_days', '90');
    fd.set('run_events_days', '30');
    fd.set('draft_events_days', '90');
    fd.set('webhook_deliveries_days', '30');
    await call(
      new Request('http://localhost/settings/retention', { method: 'POST', body: fd }),
      retentionActions.default as any,
    );

    // The instance-wide writes above did land somewhere - prove it's not
    // the org feed's own tables that grew silently.
    const auditRows = await getDb().execute(sql`select count(*)::int as n from instance_audit_log`);
    expect((auditRows.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(5);

    const after = await loadAuditFeed(orgId);
    expect(after).toEqual(before);
  });
});

afterAll(async () => {
  if (originalAuth === undefined) delete process.env.PITCHBOX_AUTH;
  else process.env.PITCHBOX_AUTH = originalAuth;
  await getPool().end();
});
