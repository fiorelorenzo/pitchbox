import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb, schema } from '@pitchbox/shared/db';
import { POST as draftUndeliverable } from '../src/routes/api/extension/draft/[id]/undeliverable/+server.js';

/**
 * Issue #335: the extension marks a DM draft `undeliverable` once Reddit's
 * compose page refuses the recipient ("unable to send a message request to
 * this account"). This is a terminal, non-punitive state distinct from
 * `rejected` - the platform refused delivery, not the human - and it must
 * record the target as uncontactable so a future run does not draft for it
 * again (see cli/tests/commands/drafts-create.test.ts for the loop-closing
 * half of that).
 */

const REASON = 'You are unable to send a message request to this account.';

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects, draft_events, extension_devices, contact_history RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function bearer(
  id: number,
  token: string,
  body: Record<string, unknown> = { reason: REASON },
): Request {
  return new Request(`http://x/api/extension/draft/${id}/undeliverable`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
}

async function mintDevice(token: string, organizationId: number | null = null) {
  await getDb()
    .insert(schema.extensionDevices)
    .values({ organizationId, tokenHash: tokenHash(token), label: 'test' });
}

async function seedDraft(
  state: string,
  opts: { orgSlug?: string; kind?: string; targetUser?: string | null } = {},
) {
  const db = getDb();
  const orgSlug = opts.orgSlug ?? 'default';
  const kind = opts.kind ?? 'dm';
  const targetUser = opts.targetUser === undefined ? 'MyrthDM' : opts.targetUser;
  let [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, orgSlug));
  if (!org) {
    [org] = await db
      .insert(schema.organizations)
      .values({ slug: orgSlug, name: orgSlug })
      .returning();
  }
  const [proj] = await db
    .insert(schema.projects)
    .values({
      organizationId: org.id,
      slug: `und-${state}-${Date.now()}-${Math.random()}`,
      name: 'undeliverable',
    })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [account] = await db
    .insert(schema.accounts)
    .values({
      projectId: proj.id,
      platformId: platform.id,
      handle: `h-${state}-${Date.now()}-${Math.random()}`,
    })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ projectId: proj.id, platformId: platform.id, name: state, skillSlug: 'reddit-scout' })
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
      kind,
      body: 'hello there',
      targetUser,
      state,
    })
    .returning();
  return { draft, org, account, platform };
}

async function readDraft(id: number) {
  const [row] = await getDb().select().from(schema.drafts).where(eq(schema.drafts.id, id));
  return row;
}

describe('extension mark-undeliverable route', () => {
  beforeEach(reset);

  it('flips the draft, keeps the reason verbatim, and records the contact as uncontactable', async () => {
    const { draft, org, account } = await seedDraft('approved');
    await mintDevice('tok-ok');

    const res = await draftUndeliverable({
      params: { id: String(draft.id) },
      request: bearer(draft.id, 'tok-ok'),
    } as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });

    const after = await readDraft(draft.id);
    expect(after.state).toBe('undeliverable');
    expect(after.undeliverableReason).toBe(REASON);

    const events = await getDb()
      .select()
      .from(schema.draftEvents)
      .where(eq(schema.draftEvents.draftId, draft.id));
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('undeliverable');
    expect(events[0].actor).toBe('extension');
    expect(events[0].details).toMatchObject({ reason: REASON });

    const contacts = await getDb()
      .select()
      .from(schema.contactHistory)
      .where(eq(schema.contactHistory.draftId, draft.id));
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      uncontactable: true,
      uncontactableReason: REASON,
      targetUser: 'MyrthDM',
      platformId: draft.platformId,
      accountHandle: account.handle,
      organizationId: org.id,
    });
  });

  it('keeps arbitrary reason text verbatim, whitespace trimmed but otherwise untouched', async () => {
    const { draft } = await seedDraft('approved');
    await mintDevice('tok-verbatim');
    const weird = '  Weird - platform copy with punctuation, casing AND trailing space.  ';

    const res = await draftUndeliverable({
      params: { id: String(draft.id) },
      request: bearer(draft.id, 'tok-verbatim', { reason: weird }),
    } as never);
    expect(res.status).toBe(200);

    const after = await readDraft(draft.id);
    expect(after.undeliverableReason).toBe(weird.trim());
  });

  it('rejects a request with no reason', async () => {
    const { draft } = await seedDraft('approved');
    await mintDevice('tok-noreason');

    await expect(
      draftUndeliverable({
        params: { id: String(draft.id) },
        request: bearer(draft.id, 'tok-noreason', {}),
      } as never),
    ).rejects.toMatchObject({ status: 400 });

    const after = await readDraft(draft.id);
    expect(after.state).toBe('approved');
  });

  it('refuses a draft belonging to another org (404), same as the sibling routes', async () => {
    const { draft } = await seedDraft('approved', { orgSlug: 'other-org' });
    const [defaultOrg] = await getDb()
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, 'default'));
    // Device bound to 'default', not 'other-org'.
    await mintDevice('tok-cross', defaultOrg.id);

    await expect(
      draftUndeliverable({
        params: { id: String(draft.id) },
        request: bearer(draft.id, 'tok-cross'),
      } as never),
    ).rejects.toMatchObject({ status: 404 });

    const after = await readDraft(draft.id);
    expect(after.state).toBe('approved');
  });

  it.each(['sent', 'rejected'])(
    'refuses an illegal source state (409 state_locked): %s',
    async (state) => {
      const { draft } = await seedDraft(state);
      await mintDevice(`tok-${state}`);

      await expect(
        draftUndeliverable({
          params: { id: String(draft.id) },
          request: bearer(draft.id, `tok-${state}`),
        } as never),
      ).rejects.toMatchObject({ status: 409, body: { message: 'state_locked' } });

      const after = await readDraft(draft.id);
      expect(after.state).toBe(state);
      const events = await getDb()
        .select()
        .from(schema.draftEvents)
        .where(eq(schema.draftEvents.draftId, draft.id));
      expect(events).toHaveLength(0);
    },
  );

  it.each(['proposed', 'pending_review', 'approved'])(
    'accepts a legitimate %s draft',
    async (state) => {
      const { draft } = await seedDraft(state);
      await mintDevice(`tok-legit-${state}`);

      const res = await draftUndeliverable({
        params: { id: String(draft.id) },
        request: bearer(draft.id, `tok-legit-${state}`),
      } as never);
      expect(res.status).toBe(200);

      const after = await readDraft(draft.id);
      expect(after.state).toBe('undeliverable');
    },
  );

  it('is idempotent on a repeat call: no duplicate events or contact rows, reason unchanged', async () => {
    const { draft } = await seedDraft('approved');
    await mintDevice('tok-repeat');

    const first = await draftUndeliverable({
      params: { id: String(draft.id) },
      request: bearer(draft.id, 'tok-repeat'),
    } as never);
    expect(first.status).toBe(200);

    const second = await draftUndeliverable({
      params: { id: String(draft.id) },
      request: bearer(draft.id, 'tok-repeat', { reason: 'a different reason string' }),
    } as never);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, alreadyUndeliverable: true });

    const after = await readDraft(draft.id);
    // The second call's different reason never lands - repeat is a no-op.
    expect(after.undeliverableReason).toBe(REASON);

    const events = await getDb()
      .select()
      .from(schema.draftEvents)
      .where(eq(schema.draftEvents.draftId, draft.id));
    expect(events).toHaveLength(1);

    const contacts = await getDb()
      .select()
      .from(schema.contactHistory)
      .where(eq(schema.contactHistory.draftId, draft.id));
    expect(contacts).toHaveLength(1);
  });

  it('does not write a contact_history row for a non-DM kind (nothing to mark uncontactable)', async () => {
    const { draft } = await seedDraft('approved', { kind: 'post_comment', targetUser: null });
    await mintDevice('tok-comment');

    const res = await draftUndeliverable({
      params: { id: String(draft.id) },
      request: bearer(draft.id, 'tok-comment'),
    } as never);
    expect(res.status).toBe(200);

    const after = await readDraft(draft.id);
    expect(after.state).toBe('undeliverable');

    const contacts = await getDb()
      .select()
      .from(schema.contactHistory)
      .where(eq(schema.contactHistory.draftId, draft.id));
    expect(contacts).toHaveLength(0);
  });
});
