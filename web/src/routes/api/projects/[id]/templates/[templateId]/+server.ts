import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireOrgId } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';

const PatchBody = z.object({
  kind: z.enum(['dm', 'comment', 'post']).optional(),
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(8000).optional(),
  isActive: z.boolean().optional(),
});

function parseId(p: string | undefined): number | null {
  const n = Number(p);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function PATCH(event: RequestEvent) {
  const { params, request } = event;
  const projectId = parseId(params.id);
  const templateId = parseId(params.templateId);
  if (!projectId || !templateId) return json({ error: 'invalid_id' }, { status: 400 });
  const orgId = await requireOrgId(event);
  if (!(await projectBelongsToOrg(getDb(), projectId, orgId))) throw error(404, 'not_found');
  const raw = await request.json().catch(() => null);
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  const [row] = await getDb()
    .update(schema.templates)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(and(eq(schema.templates.id, templateId), eq(schema.templates.projectId, projectId)))
    .returning();
  if (!row) return json({ error: 'not_found' }, { status: 404 });
  return json({ template: row });
}

export async function DELETE(event: RequestEvent) {
  const { params } = event;
  const projectId = parseId(params.id);
  const templateId = parseId(params.templateId);
  if (!projectId || !templateId) return json({ error: 'invalid_id' }, { status: 400 });
  const orgId = await requireOrgId(event);
  if (!(await projectBelongsToOrg(getDb(), projectId, orgId))) throw error(404, 'not_found');
  const [row] = await getDb()
    .delete(schema.templates)
    .where(and(eq(schema.templates.id, templateId), eq(schema.templates.projectId, projectId)))
    .returning();
  if (!row) return json({ error: 'not_found' }, { status: 404 });
  return json({ ok: true });
}
