import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import {
  getProjectById,
  updateProject,
  deleteProject,
  ProjectDeleteSlugMismatchError,
  listLatestConfigs,
} from '@pitchbox/shared/projects';

const PatchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  defaultAgentRunner: z.string().min(1).optional(),
});

const DeleteBody = z.object({ confirmSlug: z.string().min(1) });

function parseId(idParam: string): number | null {
  const n = Number(idParam);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET({ params }) {
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });
  const db = getDb();
  const project = await getProjectById(db, id);
  if (!project) return json({ error: 'not_found' }, { status: 404 });
  const configs = await listLatestConfigs(db, id);
  const accounts = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.projectId, id));
  return json({ project, configs, accounts });
}

export async function PATCH({ params, request }) {
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });
  const raw = await request.json().catch(() => null);
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  const db = getDb();
  const project = await getProjectById(db, id);
  if (!project) return json({ error: 'not_found' }, { status: 404 });
  await updateProject(db, id, parsed.data);
  return json({ ok: true });
}

export async function DELETE({ params, request }) {
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });
  const raw = await request.json().catch(() => null);
  const parsed = DeleteBody.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_body' }, { status: 400 });
  }
  try {
    await deleteProject(getDb(), id, parsed.data.confirmSlug);
  } catch (e) {
    if (e instanceof ProjectDeleteSlugMismatchError) {
      return json({ error: 'slug_mismatch' }, { status: 400 });
    }
    throw e;
  }
  return json({ ok: true });
}
