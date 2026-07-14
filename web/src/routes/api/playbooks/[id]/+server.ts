import { json, error, type RequestEvent } from '@sveltejs/kit';
import { getDb, schema } from '$lib/server/db.js';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { requireRole } from '$lib/server/auth.js';

const PatchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(280).nullable().optional(),
  body: z.string().min(1).optional(),
});

function parseId(p: string | undefined): number | null {
  const n = Number(p);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET({ params }: { params: { id: string } }) {
  const id = parseId(params.id);
  if (!id) throw error(400, 'invalid_id');
  const db = getDb();
  const [row] = await db.select().from(schema.playbooks).where(eq(schema.playbooks.id, id));
  if (!row) throw error(404, 'not_found');
  return json({ playbook: row });
}

export async function PATCH(event: RequestEvent) {
  const { params, request } = event;
  const id = parseId(params.id);
  if (!id) throw error(400, 'invalid_id');
  requireRole(event, 'admin');
  const raw = await request.json().catch(() => null);
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) throw error(400, 'invalid_body');
  const db = getDb();
  await db
    .update(schema.playbooks)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(schema.playbooks.id, id));
  return json({ ok: true });
}

export async function DELETE(event: RequestEvent) {
  const { params } = event;
  const id = parseId(params.id);
  if (!id) throw error(400, 'invalid_id');
  requireRole(event, 'admin');
  const db = getDb();
  const [row] = await db
    .select({ isBuiltin: schema.playbooks.isBuiltin })
    .from(schema.playbooks)
    .where(eq(schema.playbooks.id, id));
  if (!row) throw error(404, 'not_found');
  if (row.isBuiltin) throw error(409, 'builtin_protected');
  await db.delete(schema.playbooks).where(eq(schema.playbooks.id, id));
  return json({ ok: true });
}
