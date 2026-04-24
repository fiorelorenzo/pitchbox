import { json, error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireExtensionAuth } from '$lib/server/extension-auth.js';

export async function POST({ params, request }: { params: { id: string }; request: Request }) {
  await requireExtensionAuth(request);
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw error(400, 'invalid id');
  const body = (await request.json().catch(() => ({}))) as { composedAt?: string };

  const db = getDb();
  const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, id));
  if (!draft) throw error(404, 'draft not found');

  await db.insert(schema.draftEvents).values({
    draftId: id,
    event: 'armed',
    actor: 'extension',
    details: body.composedAt ? { composedAt: body.composedAt } : {},
  });
  return json({ ok: true });
}
