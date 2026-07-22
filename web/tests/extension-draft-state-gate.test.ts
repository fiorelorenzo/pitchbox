import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import { POST as draftSent } from '../src/routes/api/extension/draft/[id]/sent/+server.js';

/**
 * Issue #183: the extension "mark sent" route must not let a draft flip to
 * `sent` from a state where a send is not valid, in particular `rejected`
 * (e.g. the losing side of an A/B variant cascade - see
 * `cascadeRejectSiblings` in shared/src/draft-variants.ts). Only
 * `proposed` / `pending_review` / `approved` are legitimate pre-send states.
 */

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, draft_events, extension_devices RESTART IDENTITY CASCADE`,
  );
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function bearer(id: number, token: string): Request {
  return new Request(`http://x/api/extension/draft/${id}`, {
    method: 'POST',
    body: '{}',
    headers: { authorization: `Bearer ${token}` },
  });
}

async function mintDevice(token: string) {
  await getDb()
    .insert(schema.extensionDevices)
    .values({ organizationId: null, tokenHash: tokenHash(token), label: 'test' });
}

async function seedDraft(state: string) {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, 'default'));
  const [proj] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: `sg-${state}-${Date.now()}`, name: 'state-gate' })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({ projectId: proj.id, platformId: platform.id, handle: `h-${state}-${Date.now()}` })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: proj.id,
      platformId: platform.id,
      name: state,
      skillSlug: 'reddit-scout',
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
      kind: 'dm',
      body: 'hello there',
      targetUser: 'someone',
      state,
    })
    .returning();
  return draft;
}

describe('extension mark-sent route: draft state gate', () => {
  beforeEach(reset);

  it('refuses to send a rejected draft (409 state_locked), leaving it unchanged', async () => {
    const draft = await seedDraft('rejected');
    await mintDevice('tokA');

    await expect(
      draftSent({ params: { id: String(draft.id) }, request: bearer(draft.id, 'tokA') } as never),
    ).rejects.toMatchObject({ status: 409, body: { message: 'state_locked' } });

    const [after] = await getDb()
      .select({ state: schema.drafts.state })
      .from(schema.drafts)
      .where(eq(schema.drafts.id, draft.id));
    expect(after.state).toBe('rejected');

    const events = await getDb()
      .select()
      .from(schema.draftEvents)
      .where(eq(schema.draftEvents.draftId, draft.id));
    expect(events.length).toBe(0);
  });

  it.each(['proposed', 'pending_review', 'approved'])(
    'still sends a legitimate %s draft',
    async (state) => {
      const draft = await seedDraft(state);
      await mintDevice(`tok-${state}`);

      const res = await draftSent({
        params: { id: String(draft.id) },
        request: bearer(draft.id, `tok-${state}`),
      } as never);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });

      const [after] = await getDb()
        .select({ state: schema.drafts.state })
        .from(schema.drafts)
        .where(eq(schema.drafts.id, draft.id));
      expect(after.state).toBe('sent');
    },
  );
});
