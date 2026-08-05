import { afterAll, describe, expect, it, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import {
  GET,
  POST,
  PATCH,
  DELETE,
} from '../src/routes/api/campaigns/[id]/keyword-watches/+server.js';

// Exercises the keyword-watches API exactly as the campaign detail page's
// Watches tab drives it: create -> list -> edit -> delete, plus the
// validation failure the form's client-side checks must catch before the
// request ever reaches the server (#233).

async function reset() {
  await getDb().execute(
    sql`TRUNCATE keyword_watches, campaigns, projects RESTART IDENTITY CASCADE`,
  );
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
}

async function seedOrgWithCampaign(slug: string) {
  const db = getDb();
  const [org] = await db.insert(schema.organizations).values({ slug, name: slug }).returning();
  const [project] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug: `${slug}-proj`, name: slug })
    .returning();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, 'reddit'));
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      projectId: project.id,
      platformId: platform.id,
      name: `${slug}-campaign`,
      skillSlug: 'reddit-scout',
      agentRunner: 'claude-code',
      status: 'active',
    })
    .returning();
  return { orgId: org.id, campaignId: campaign.id };
}

function eventFor(
  campaignId: number,
  orgId: number,
  opts: { body?: unknown; url?: string } = {},
): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'member' } },
    params: { id: String(campaignId) },
    request: { json: async () => opts.body ?? null },
    url: new URL(opts.url ?? `http://localhost/api/campaigns/${campaignId}/keyword-watches`),
  } as unknown as RequestEvent;
}

async function rowFor(watchId: number) {
  const [row] = await getDb()
    .select()
    .from(schema.keywordWatches)
    .where(eq(schema.keywordWatches.id, watchId));
  return row;
}

describe('keyword watches CRUD round trip', () => {
  beforeEach(reset);

  it('creates, lists, edits and deletes a watch', async () => {
    const { orgId, campaignId } = await seedOrgWithCampaign('kw-crud');

    // Create - mirrors the "New watch" dialog submit.
    const createRes = await POST(
      eventFor(campaignId, orgId, {
        body: { subreddit: 'askreddit', pattern: 'looking for feedback', matchField: 'title' },
      }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { watch: { id: number } };
    const watchId = created.watch.id;

    // Server fills in the defaults the form relies on (isActive, cooldownMinutes).
    const inserted = await rowFor(watchId);
    expect(inserted.isActive).toBe(true);
    expect(inserted.cooldownMinutes).toBe(30);
    expect(inserted.consecutiveFailures).toBe(0);

    // List - what the Watches tab renders on load.
    const listRes = await GET(eventFor(campaignId, orgId));
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { watches: Array<{ id: number; subreddit: string }> };
    expect(listed.watches).toHaveLength(1);
    expect(listed.watches[0].subreddit).toBe('askreddit');

    // Edit - the dialog's Save action on an existing watch. subreddit is
    // intentionally omitted: the API does not accept it on PATCH.
    const patchRes = await PATCH(
      eventFor(campaignId, orgId, {
        body: {
          watchId,
          pattern: '/\\bfeedback\\b/i',
          matchField: 'selftext',
          cooldownMinutes: 45,
          isActive: false,
        },
      }),
    );
    expect(patchRes.status).toBe(200);
    const updated = await rowFor(watchId);
    expect(updated.pattern).toBe('/\\bfeedback\\b/i');
    expect(updated.matchField).toBe('selftext');
    expect(updated.cooldownMinutes).toBe(45);
    expect(updated.isActive).toBe(false);
    expect(updated.subreddit).toBe('askreddit'); // unchanged - not part of PatchBody

    // Delete - the alert-dialog confirm.
    const deleteRes = await DELETE(
      eventFor(campaignId, orgId, { url: `http://localhost/x?watchId=${watchId}` }),
    );
    expect(deleteRes.status).toBe(200);
    expect(await rowFor(watchId)).toBeUndefined();
  });

  it('rejects a subreddit with characters the form must also reject', async () => {
    const { orgId, campaignId } = await seedOrgWithCampaign('kw-invalid-subreddit');

    const res = await POST(
      eventFor(campaignId, orgId, {
        body: { subreddit: 'r/askreddit', pattern: 'x' }, // "r/" prefix is not allowed
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_body');

    const rows = await getDb()
      .select()
      .from(schema.keywordWatches)
      .where(eq(schema.keywordWatches.campaignId, campaignId));
    expect(rows).toHaveLength(0);
  });

  it('rejects an empty pattern', async () => {
    const { orgId, campaignId } = await seedOrgWithCampaign('kw-invalid-pattern');

    const res = await POST(
      eventFor(campaignId, orgId, { body: { subreddit: 'askreddit', pattern: '' } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_body');
  });

  it('404s editing a watch id that does not belong to the campaign', async () => {
    const { orgId, campaignId } = await seedOrgWithCampaign('kw-cross-campaign');
    const other = await seedOrgWithCampaign('kw-cross-campaign-other');
    const createRes = await POST(
      eventFor(other.campaignId, other.orgId, { body: { subreddit: 'foo', pattern: 'bar' } }),
    );
    const { watch } = (await createRes.json()) as { watch: { id: number } };

    const res = await PATCH(
      eventFor(campaignId, orgId, { body: { watchId: watch.id, isActive: false } }),
    );
    expect(res.status).toBe(404);
  });

  it('404s listing watches for a campaign in a different org', async () => {
    const a = await seedOrgWithCampaign('kw-org-a');
    const b = await seedOrgWithCampaign('kw-org-b');
    await expect(GET(eventFor(a.campaignId, b.orgId))).rejects.toMatchObject({ status: 404 });
  });
});

afterAll(async () => {
  await getPool().end();
});
