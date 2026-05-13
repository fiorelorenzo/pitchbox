import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';

const PostBody = z.object({
  kind: z.enum(['dm', 'comment', 'post']),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(8000),
  isActive: z.boolean().optional(),
});

function parseId(p: string): number | null {
  const n = Number(p);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET({ params, url }) {
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });
  const kindFilter = url.searchParams.get('kind');
  const where =
    kindFilter && ['dm', 'comment', 'post'].includes(kindFilter)
      ? and(eq(schema.templates.projectId, id), eq(schema.templates.kind, kindFilter))
      : eq(schema.templates.projectId, id);
  const rows = await getDb()
    .select()
    .from(schema.templates)
    .where(where)
    .orderBy(asc(schema.templates.createdAt));
  return json({ templates: rows });
}

export async function POST({ params, request }) {
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });
  const raw = await request.json().catch(() => null);
  const parsed = PostBody.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  const [row] = await getDb()
    .insert(schema.templates)
    .values({
      projectId: id,
      kind: parsed.data.kind,
      title: parsed.data.title,
      body: parsed.data.body,
      isActive: parsed.data.isActive ?? true,
    })
    .returning();
  return json({ template: row }, { status: 201 });
}
