import { describe, it, expect, beforeEach } from 'vitest';
import { getDb, schema } from '../src/db/client.js';
import { checkContactDedup, parseDedupPolicy } from '../src/contact-dedup.js';
import { eq, sql } from 'drizzle-orm';

async function platformId(slug: string) {
  const db = getDb();
  const [p] = await db.select().from(schema.platforms).where(eq(schema.platforms.slug, slug));
  return p!.id;
}

// Resolves an org by slug, creating it on first use. `onConflictDoNothing`
// makes this safe to call across repeated test runs against the shared test
// DB (the 'default' org always exists; a second org is created once).
async function ensureOrg(slug: string) {
  const db = getDb();
  await db.insert(schema.organizations).values({ slug, name: slug }).onConflictDoNothing();
  const [org] = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, slug));
  return org!.id;
}

async function insertHistory(
  platformId: number,
  targetUser: string,
  daysAgo: number,
  organizationId: number,
) {
  const db = getDb();
  const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  await db.insert(schema.contactHistory).values({
    platformId,
    accountHandle: 'tester',
    targetUser,
    lastContactedAt: when,
    organizationId,
  });
}

describe('checkContactDedup', () => {
  beforeEach(async () => {
    await getDb().execute(sql`TRUNCATE contact_history RESTART IDENTITY CASCADE`);
  });

  it('returns withinWindow=true when prior contact lies inside window', async () => {
    const pid = await platformId('reddit');
    const orgId = await ensureOrg('default');
    await insertHistory(pid, 'alice', 10, orgId);
    const r = await checkContactDedup(getDb(), {
      platformId: pid,
      targetUser: 'alice',
      windowDays: 90,
      organizationId: orgId,
    });
    expect(r.withinWindow).toBe(true);
    expect(r.priorContactedAt).toBeInstanceOf(Date);
  });

  it('returns withinWindow=false when prior contact is outside window', async () => {
    const pid = await platformId('reddit');
    const orgId = await ensureOrg('default');
    await insertHistory(pid, 'bob', 120, orgId);
    const r = await checkContactDedup(getDb(), {
      platformId: pid,
      targetUser: 'bob',
      windowDays: 90,
      organizationId: orgId,
    });
    expect(r.withinWindow).toBe(false);
    expect(r.priorContactedAt).toBeInstanceOf(Date);
  });

  it('returns nulls when no prior contact exists', async () => {
    const pid = await platformId('reddit');
    const orgId = await ensureOrg('default');
    const r = await checkContactDedup(getDb(), {
      platformId: pid,
      targetUser: 'nobody',
      windowDays: 90,
      organizationId: orgId,
    });
    expect(r.withinWindow).toBe(false);
    expect(r.priorContactedAt).toBeNull();
  });

  it('does not dedupe the same (platformId, targetUser) across organizations', async () => {
    const pid = await platformId('reddit');
    const orgA = await ensureOrg('default');
    const orgB = await ensureOrg('dedup-test-org-b');
    // Org A contacted this handle recently, well inside any window.
    await insertHistory(pid, 'shared-handle', 1, orgA);
    // Org B checking the same platform + handle must see no prior contact:
    // org A's outreach history is invisible to org B.
    const r = await checkContactDedup(getDb(), {
      platformId: pid,
      targetUser: 'shared-handle',
      windowDays: 90,
      organizationId: orgB,
    });
    expect(r.priorContactedAt).toBeNull();
    expect(r.withinWindow).toBe(false);
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
