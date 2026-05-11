import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';

const PatchBody = z.object({
  handle: z.string().min(1).max(64).optional(),
  role: z.enum(['personal', 'brand']).optional(),
});

function parseId(p: string): number | null {
  const n = Number(p);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function PATCH({ params, request }) {
  const projectId = parseId(params.id);
  const accountId = parseId(params.accountId);
  if (!projectId || !accountId) return json({ error: 'invalid_id' }, { status: 400 });
  const raw = await request.json().catch(() => null);
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  await getDb()
    .update(schema.accounts)
    .set(parsed.data)
    .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.projectId, projectId)));
  return json({ ok: true });
}

export async function DELETE({ params }) {
  const projectId = parseId(params.id);
  const accountId = parseId(params.accountId);
  if (!projectId || !accountId) return json({ error: 'invalid_id' }, { status: 400 });
  await getDb()
    .delete(schema.accounts)
    .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.projectId, projectId)));
  return json({ ok: true });
}
