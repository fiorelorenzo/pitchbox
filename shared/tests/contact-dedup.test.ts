import { describe, it, expect, beforeEach } from 'vitest';
import { getDb, schema } from '../src/db/client.js';
import { checkContactDedup, parseDedupPolicy } from '../src/contact-dedup.js';
import { eq, sql } from 'drizzle-orm';

async function platformId(slug: string) {
  const db = getDb();
  const [p] = await db.select().from(schema.platforms).where(eq(schema.platforms.slug, slug));
  return p!.id;
}

async function insertHistory(platformId: number, targetUser: string, daysAgo: number) {
  const db = getDb();
  const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  await db.insert(schema.contactHistory).values({
    platformId,
    accountHandle: 'tester',
    targetUser,
    lastContactedAt: when,
  });
}

describe('checkContactDedup', () => {
  beforeEach(async () => {
    await getDb().execute(sql`TRUNCATE contact_history RESTART IDENTITY CASCADE`);
  });

  it('returns withinWindow=true when prior contact lies inside window', async () => {
    const pid = await platformId('reddit');
    await insertHistory(pid, 'alice', 10);
    const r = await checkContactDedup(getDb(), {
      platformId: pid,
      targetUser: 'alice',
      windowDays: 90,
    });
    expect(r.withinWindow).toBe(true);
    expect(r.priorContactedAt).toBeInstanceOf(Date);
  });

  it('returns withinWindow=false when prior contact is outside window', async () => {
    const pid = await platformId('reddit');
    await insertHistory(pid, 'bob', 120);
    const r = await checkContactDedup(getDb(), {
      platformId: pid,
      targetUser: 'bob',
      windowDays: 90,
    });
    expect(r.withinWindow).toBe(false);
    expect(r.priorContactedAt).toBeInstanceOf(Date);
  });

  it('returns nulls when no prior contact exists', async () => {
    const pid = await platformId('reddit');
    const r = await checkContactDedup(getDb(), {
      platformId: pid,
      targetUser: 'nobody',
      windowDays: 90,
    });
    expect(r.withinWindow).toBe(false);
    expect(r.priorContactedAt).toBeNull();
  });
});

describe('parseDedupPolicy', () => {
  it('returns defaults for unknown input', () => {
    const p = parseDedupPolicy(null);
    expect(p.windowDays).toBe(90);
    expect(p.mode).toBe('warn');
  });

  it('honours window_days and mode', () => {
    const p = parseDedupPolicy({ window_days: 30, mode: 'skip' });
    expect(p.windowDays).toBe(30);
    expect(p.mode).toBe('skip');
  });
});
