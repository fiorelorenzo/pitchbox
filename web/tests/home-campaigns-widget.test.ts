import { describe, expect, it, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '@pitchbox/shared/db';
import { load as loadHome } from '../src/routes/+page.server.js';

/**
 * The home page's campaigns widget only ever rendered `data.campaigns.slice(0,
 * 6)` with no "view all" link, so anything past the sixth campaign was
 * invisible with no indication it existed (#228). The loader itself was
 * never capped - this proves the fix stays on the render side: the loader
 * keeps returning every campaign so the page can show "view all N" instead
 * of silently dropping them.
 */

async function reset() {
  await getDb().execute(
    sql`TRUNCATE drafts, runs, campaigns, accounts, projects RESTART IDENTITY CASCADE`,
  );
}

function fakeEvent(orgId: number): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'owner' } },
    url: new URL('http://x/'),
    params: {},
  } as unknown as RequestEvent;
}

describe('home page campaigns widget', () => {
  beforeEach(reset);

  it('the loader returns every campaign, not just the six the widget displays', async () => {
    const db = getDb();
    const [org] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(sql`slug = 'default'`);
    const [project] = await db
      .insert(schema.projects)
      .values({ organizationId: org.id, slug: 'home-widget-test', name: 'home-widget-test' })
      .returning();
    const [platform] = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.slug, 'reddit'));

    const campaigns = Array.from({ length: 9 }, (_, i) => ({
      projectId: project.id,
      platformId: platform.id,
      name: `campaign-${i}`,
      skillSlug: 's',
    }));
    await db.insert(schema.campaigns).values(campaigns);

    const data = await loadHome(fakeEvent(org.id));

    expect(data.campaigns).toHaveLength(9);
  });
});
