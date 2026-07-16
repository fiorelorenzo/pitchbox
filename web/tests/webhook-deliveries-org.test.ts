import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { notify, saveWebhooks } from '@pitchbox/shared/notifications';
import { load } from '../src/routes/notifications/+page.server.js';
import { POST as retryPost } from '../src/routes/api/webhooks/deliveries/[id]/retry/+server.js';

async function reset() {
  await getDb().execute(sql`TRUNCATE webhook_deliveries RESTART IDENTITY CASCADE`);
  await getDb().execute(sql`TRUNCATE notifications RESTART IDENTITY CASCADE`);
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
  await saveWebhooks(getDb(), { url: 'https://example.test/hook' });
}

async function seedOrg(slug: string): Promise<number> {
  const db = getDb();
  if (slug === 'default') {
    const [row] = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, 'default'));
    return row.id;
  }
  const [row] = await db
    .insert(schema.organizations)
    .values({ slug, name: slug })
    .returning({ id: schema.organizations.id });
  return row.id;
}

function fakeEvent(orgId: number, params: Record<string, string> = {}): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'admin' } },
    params,
  } as unknown as RequestEvent;
}

afterAll(async () => {
  await getPool().end();
});

describe('webhook deliveries are scoped to the active org', () => {
  beforeEach(reset);

  it('notify() tags the enqueued delivery with the notification org', async () => {
    const orgA = await seedOrg('default');
    const orgB = await seedOrg('wh-org-scope-b');

    await notify(getDb(), { kind: 'a.event', title: 'for org A' }, orgA);
    await notify(getDb(), { kind: 'b.event', title: 'for org B' }, orgB);

    const rows = await getDb()
      .select({
        eventType: schema.webhookDeliveries.eventType,
        orgId: schema.webhookDeliveries.organizationId,
      })
      .from(schema.webhookDeliveries);
    const byEvent = new Map(rows.map((r) => [r.eventType, r.orgId]));
    expect(byEvent.get('notification.a.event')).toBe(orgA);
    expect(byEvent.get('notification.b.event')).toBe(orgB);
  });

  it('the notifications page loader never lists another org delivery', async () => {
    const orgA = await seedOrg('default');
    const orgB = await seedOrg('wh-page-scope-b');

    await notify(getDb(), { kind: 'a.event', title: 'for org A' }, orgA);
    await notify(getDb(), { kind: 'b.event', title: 'for org B' }, orgB);

    const data = await load(fakeEvent(orgA));
    expect(data.deliveries.map((d) => d.eventType)).toEqual(['notification.a.event']);
  });

  it('the retry route 404s when the delivery belongs to a different org', async () => {
    const orgA = await seedOrg('default');
    const orgB = await seedOrg('wh-retry-scope-b');

    await notify(getDb(), { kind: 'b.event', title: 'for org B' }, orgB);
    const [delivery] = await getDb()
      .select({ id: schema.webhookDeliveries.id })
      .from(schema.webhookDeliveries);

    await expect(retryPost(fakeEvent(orgA, { id: String(delivery.id) }))).rejects.toMatchObject({
      status: 404,
    });
  });

  it('the retry route succeeds when the delivery belongs to the caller org', async () => {
    const orgA = await seedOrg('default');

    await notify(getDb(), { kind: 'a.event', title: 'for org A' }, orgA);
    const [delivery] = await getDb()
      .select({ id: schema.webhookDeliveries.id })
      .from(schema.webhookDeliveries);

    const res = await retryPost(fakeEvent(orgA, { id: String(delivery.id) }));
    expect(res.status).toBe(200);
  });
});
