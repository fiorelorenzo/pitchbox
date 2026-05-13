import { getDb, schema } from '$lib/server/db.js';
import { desc } from 'drizzle-orm';

export async function load() {
  const db = getDb();
  const rows = await db
    .select({
      id: schema.playbooks.id,
      slug: schema.playbooks.slug,
      name: schema.playbooks.name,
      description: schema.playbooks.description,
      isBuiltin: schema.playbooks.isBuiltin,
      updatedAt: schema.playbooks.updatedAt,
    })
    .from(schema.playbooks)
    .orderBy(desc(schema.playbooks.updatedAt));
  return { playbooks: rows };
}
