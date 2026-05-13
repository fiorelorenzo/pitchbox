import { json, error } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';

const PostBody = z.object({
  slug: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1).max(120),
  description: z.string().max(280).optional(),
  body: z.string().min(1),
});

export async function GET() {
  const db = getDb();
  const rows = await db.select().from(schema.playbooks).orderBy(desc(schema.playbooks.updatedAt));
  return json({ playbooks: rows });
}

export async function POST({ request }: { request: Request }) {
  const body = await request.json().catch(() => null);
  const parsed = PostBody.safeParse(body);
  if (!parsed.success) throw error(400, 'invalid_body');
  const db = getDb();
  const [existing] = await db
    .select({ id: schema.playbooks.id })
    .from(schema.playbooks)
    .where(eq(schema.playbooks.slug, parsed.data.slug));
  if (existing) throw error(409, 'slug_taken');
  const [row] = await db
    .insert(schema.playbooks)
    .values({
      slug: parsed.data.slug,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      body: parsed.data.body,
      isBuiltin: false,
    })
    .returning();
  return json({ playbook: row });
}
