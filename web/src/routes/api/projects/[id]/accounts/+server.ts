import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';

const PostBody = z.object({
  handle: z.string().min(1).max(64),
  role: z.enum(['personal', 'brand']),
  platformSlug: z.string().min(1),
});

function parseId(p: string): number | null {
  const n = Number(p);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET({ params }) {
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });
  const accounts = await getDb()
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.projectId, id));
  return json({ accounts });
}

export async function POST({ params, request }) {
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });
  const raw = await request.json().catch(() => null);
  const parsed = PostBody.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  const db = getDb();
  const [platform] = await db
    .select()
    .from(schema.platforms)
    .where(eq(schema.platforms.slug, parsed.data.platformSlug));
  if (!platform) {
    return json({ error: 'unknown_platform' }, { status: 400 });
  }
  const [row] = await db
    .insert(schema.accounts)
    .values({
      projectId: id,
      platformId: platform.id,
      handle: parsed.data.handle,
      role: parsed.data.role,
    })
    .returning();
  return json({ account: row }, { status: 201 });
}
