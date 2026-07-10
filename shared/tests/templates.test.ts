import { describe, it, expect, beforeEach } from 'vitest';
import { getDb, schema } from '../src/db/client.js';
import { loadActiveTemplates } from '../src/templates.js';
import { sql } from 'drizzle-orm';

async function makeProject(slug: string) {
  const db = getDb();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(sql`slug = 'default'`);
  const [p] = await db
    .insert(schema.projects)
    .values({ organizationId: org.id, slug, name: slug })
    .returning({ id: schema.projects.id });
  return p.id;
}

describe('loadActiveTemplates', () => {
  beforeEach(async () => {
    await getDb().execute(sql`TRUNCATE templates, projects RESTART IDENTITY CASCADE`);
  });

  it('returns only active templates for the project, filtered by kind', async () => {
    const projA = await makeProject('tpl-test-a');
    const projB = await makeProject('tpl-test-b');
    const db = getDb();
    await db.insert(schema.templates).values([
      { projectId: projA, kind: 'comment', title: 'c1', body: 'b1', isActive: true },
      { projectId: projA, kind: 'comment', title: 'c2-archived', body: 'b2', isActive: false },
      { projectId: projA, kind: 'dm', title: 'dm1', body: 'd1', isActive: true },
      { projectId: projB, kind: 'comment', title: 'other', body: 'x', isActive: true },
    ]);

    const comments = await loadActiveTemplates(db, { projectId: projA, kind: 'comment' });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.title).toBe('c1');

    const all = await loadActiveTemplates(db, { projectId: projA });
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.title).sort()).toEqual(['c1', 'dm1']);
  });

  it('excludes archived templates even without kind filter', async () => {
    const proj = await makeProject('tpl-test-archived');
    const db = getDb();
    await db.insert(schema.templates).values([
      { projectId: proj, kind: 'dm', title: 'live', body: 'b', isActive: true },
      { projectId: proj, kind: 'dm', title: 'dead', body: 'b', isActive: false },
    ]);
    const rows = await loadActiveTemplates(db, { projectId: proj });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('live');
  });
});
