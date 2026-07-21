import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import { GET as draftGet } from '../src/routes/api/extension/draft/[id]/+server.js';
import { POST as draftArmed } from '../src/routes/api/extension/draft/[id]/armed/+server.js';
import { POST as draftSent } from '../src/routes/api/extension/draft/[id]/sent/+server.js';

/**
 * Cross-tenant isolation for the extension bearer-token draft routes
 * (private advisory GHSA-f92q-m443-cwwr, EXT-10). A device token minted for
 * org A must not be able to read, arm, or mark-sent a draft belonging to org B
 * by guessing its numeric id. A device with a null org (the self-host /
 * auth-off fallback) keeps full access, mirroring requireRole's no-op there.
 */

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, draft_events, extension_devices RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function bearer(
  token: string,
  url = 'http://x/api/extension/draft/1',
  init: { method?: string; body?: string } = {},
) {
  return new Request(url, {
    ...init,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function seedOrgWithDraft(slug: string) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: `p-${slug}`, name: slug })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle: `h-${slug}` })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId: proj.id, platformId: platform.id, name: slug, skillSlug: 'reddit-scout' })
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
      body: 'secret body',
      targetUser: 'victim',
      state: 'pending_review',
    })
    .returning();
  return { org, draft };
}

async function mintDevice(organizationId: number | null, token: string) {
  await getDb()
    .insert(schema.extensionDevices)
    .values({ organizationId, tokenHash: tokenHash(token), label: 'test' });
}

describe('extension draft routes: cross-tenant org scoping', () => {
  beforeEach(reset);

  it('a device token for org A cannot READ org B a draft (404, no body leak)', async () => {
    const { draft: bDraft } = await seedOrgWithDraft('org-b');
    const { org: orgA } = await seedOrgWithDraft('org-a');
    await mintDevice(orgA.id, 'tokA');

    await expect(
      draftGet({
        params: { id: String(bDraft.id) },
        request: bearer('tokA'),
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('a device token for org A cannot ARM org B a draft (404)', async () => {
    const { draft: bDraft } = await seedOrgWithDraft('org-b');
    const { org: orgA } = await seedOrgWithDraft('org-a');
    await mintDevice(orgA.id, 'tokA');

    await expect(
      draftArmed({
        params: { id: String(bDraft.id) },
        request: bearer('tokA', 'http://x', { method: 'POST', body: '{}' }),
      } as never),
    ).rejects.toMatchObject({ status: 404 });

    const events = await getDb()
      .select()
      .from(schema.draftEvents)
      .where(eq(schema.draftEvents.draftId, bDraft.id));
    expect(events.length).toBe(0);
  });

  it('a device token for org A cannot mark-SENT org B a draft (404)', async () => {
    const { draft: bDraft } = await seedOrgWithDraft('org-b');
    const { org: orgA } = await seedOrgWithDraft('org-a');
    await mintDevice(orgA.id, 'tokA');

    await expect(
      draftSent({
        params: { id: String(bDraft.id) },
        request: bearer('tokA', 'http://x', { method: 'POST', body: '{}' }),
      } as never),
    ).rejects.toMatchObject({ status: 404 });

    const [after] = await getDb()
      .select({ state: schema.drafts.state })
      .from(schema.drafts)
      .where(eq(schema.drafts.id, bDraft.id));
    expect(after.state).toBe('pending_review');
  });

  it('a device token for org A CAN read and arm its own draft', async () => {
    const { org: orgA, draft: aDraft } = await seedOrgWithDraft('org-a');
    await mintDevice(orgA.id, 'tokA');

    const getRes = await draftGet({
      params: { id: String(aDraft.id) },
      request: bearer('tokA'),
    } as never);
    expect(getRes.status).toBe(200);
    expect(((await getRes.json()) as { body: string }).body).toBe('secret body');

    const armRes = await draftArmed({
      params: { id: String(aDraft.id) },
      request: bearer('tokA', 'http://x', { method: 'POST', body: '{}' }),
    } as never);
    expect(armRes.status).toBe(200);
  });

  it('a null-org device (self-host / auth-off) keeps full access', async () => {
    const { draft: aDraft } = await seedOrgWithDraft('org-a');
    await mintDevice(null, 'tokNull');

    const getRes = await draftGet({
      params: { id: String(aDraft.id) },
      request: bearer('tokNull'),
    } as never);
    expect(getRes.status).toBe(200);
  });
});
