import { getDb, schema } from '$lib/server/db.js';
import { desc, eq } from 'drizzle-orm';

export async function load() {
  const db = getDb();

  const entries = await db
    .select({
      id: schema.blocklist.id,
      platformId: schema.blocklist.platformId,
      platformSlug: schema.platforms.slug,
      kind: schema.blocklist.kind,
      value: schema.blocklist.value,
      reason: schema.blocklist.reason,
      scope: schema.blocklist.scope,
      projectId: schema.blocklist.projectId,
      projectSlug: schema.projects.slug,
      addedAt: schema.blocklist.addedAt,
    })
    .from(schema.blocklist)
    .leftJoin(schema.platforms, eq(schema.blocklist.platformId, schema.platforms.id))
    .leftJoin(schema.projects, eq(schema.blocklist.projectId, schema.projects.id))
    .orderBy(desc(schema.blocklist.addedAt));

  const platforms = await db.select().from(schema.platforms).orderBy(schema.platforms.slug);
  const projects = await db.select().from(schema.projects).orderBy(schema.projects.slug);

  return { entries, platforms, projects };
}
