import { json, error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { requireOrgId } from '$lib/server/auth.js';
import { projectBelongsToOrg } from '@pitchbox/shared/orgs';

const PatchBody = z.object({
  handle: z.string().min(1).max(64).optional(),
  role: z.enum(['personal', 'brand']).optional(),
  isDefault: z.boolean().optional(),
  dailyLimit: z.number().int().positive().nullable().optional(),
  weeklyLimit: z.number().int().positive().nullable().optional(),
});

function parseId(p: string | undefined): number | null {
  const n = Number(p);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function PATCH(event: RequestEvent) {
  const { params, request } = event;
  const projectId = parseId(params.id);
  const accountId = parseId(params.accountId);
  if (!projectId || !accountId) return json({ error: 'invalid_id' }, { status: 400 });
  const orgId = await requireOrgId(event);
  if (!(await projectBelongsToOrg(getDb(), projectId, orgId))) throw error(404, 'not_found');
  const raw = await request.json().catch(() => null);
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  const db = getDb();

  // Setting isDefault=true clears the previous default for the same (project, platform).
  if (parsed.data.isDefault === true) {
    const [current] = await db
      .select({ platformId: schema.accounts.platformId })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.projectId, projectId)));
    if (!current) return json({ error: 'not_found' }, { status: 404 });
    await db
      .update(schema.accounts)
      .set({ isDefault: false })
      .where(
        and(
          eq(schema.accounts.projectId, projectId),
          eq(schema.accounts.platformId, current.platformId),
        ),
      );
  }

  await db
    .update(schema.accounts)
    .set(parsed.data)
    .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.projectId, projectId)));
  return json({ ok: true });
}

export async function DELETE(event: RequestEvent) {
  const { params } = event;
  const projectId = parseId(params.id);
  const accountId = parseId(params.accountId);
  if (!projectId || !accountId) return json({ error: 'invalid_id' }, { status: 400 });
  const orgId = await requireOrgId(event);
  if (!(await projectBelongsToOrg(getDb(), projectId, orgId))) throw error(404, 'not_found');
  await getDb()
    .delete(schema.accounts)
    .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.projectId, projectId)));
  return json({ ok: true });
}
