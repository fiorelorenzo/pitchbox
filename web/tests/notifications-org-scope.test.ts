import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb, getPool, schema } from '@pitchbox/shared/db';
import { notify } from '@pitchbox/shared/notifications';
import { GET, POST } from '../src/routes/api/notifications/+server.js';
import { load } from '../src/routes/notifications/+page.server.js';

async function reset() {
  await getDb().execute(sql`TRUNCATE notifications RESTART IDENTITY CASCADE`);
  await getDb().execute(sql`DELETE FROM organizations WHERE slug != 'default'`);
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

function fakeEvent(orgId: number): RequestEvent {
  return {
    locals: { org: { id: orgId, slug: 'x', role: 'owner' } },
  } as unknown as RequestEvent;
}

afterAll(async () => {
  await getPool().end();
});

describe('notifications are scoped to the active org', () => {
  beforeEach(reset);

  it('GET /api/notifications never returns another org notification or unread count', async () => {
    const orgA = await seedOrg('default');
    const orgB = await seedOrg('notif-route-scope-b');

    await notify(getDb(), { kind: 'a.event', title: 'for org A' }, orgA);
    await notify(getDb(), { kind: 'b.event', title: 'for org B' }, orgB);
    await notify(getDb(), { kind: 'b.event2', title: 'also org B' }, orgB);

    const resA = await GET(fakeEvent(orgA));
    const bodyA = (await resA.json()) as {
      notifications: Array<{ kind: string }>;
      unread: number;
    };
    expect(bodyA.notifications.map((n) => n.kind)).toEqual(['a.event']);
    expect(bodyA.unread).toBe(1);

    const resB = await GET(fakeEvent(orgB));
    const bodyB = (await resB.json()) as {
      notifications: Array<{ kind: string }>;
      unread: number;
    };
    expect(bodyB.notifications.map((n) => n.kind).sort()).toEqual(['b.event', 'b.event2']);
    expect(bodyB.unread).toBe(2);
  });

  it('POST /api/notifications (mark all read) never marks another org read', async () => {
    const orgA = await seedOrg('default');
    const orgB = await seedOrg('notif-route-scope-mark-b');

    await notify(getDb(), { kind: 'a.event', title: 'for org A' }, orgA);
    await notify(getDb(), { kind: 'b.event', title: 'for org B' }, orgB);

    const res = await POST(fakeEvent(orgA));
    const body = (await res.json()) as { unread: number };
    expect(body.unread).toBe(0);

    const resB = await GET(fakeEvent(orgB));
    const bodyB = (await resB.json()) as { unread: number };
    expect(bodyB.unread).toBe(1);
  });

  it('the notifications page loader never lists another org notification', async () => {
    const orgA = await seedOrg('default');
    const orgB = await seedOrg('notif-page-scope-b');

    await notify(getDb(), { kind: 'a.event', title: 'for org A' }, orgA);
    await notify(getDb(), { kind: 'b.event', title: 'for org B' }, orgB);

    const data = await load(fakeEvent(orgA));
    expect(data.notifications.map((n) => n.kind)).toEqual(['a.event']);
  });
});
