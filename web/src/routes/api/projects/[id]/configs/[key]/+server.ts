import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import {
  saveConfigVersion,
  deleteConfigKey,
  ConfigConflictError,
  getProjectById,
} from '@pitchbox/shared/projects';

const PatchBody = z.object({
  value: z.unknown(),
  expectedPreviousVersion: z.number().int().min(1),
});

function parseId(p: string): number | null {
  const n = Number(p);
  return Number.isInteger(n) && n > 0 ? n : null;
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
  if (!(await getProjectById(db, id))) {
    return json({ error: 'not_found' }, { status: 404 });
  }
  try {
    const out = await saveConfigVersion(
      db,
      id,
      params.key,
      parsed.data.value,
      parsed.data.expectedPreviousVersion,
    );
    return json({ version: out.version });
  } catch (e) {
    if (e instanceof ConfigConflictError) {
      return json({ error: 'conflict', latestVersion: e.latestVersion }, { status: 409 });
    }
    if (e instanceof z.ZodError) {
      return json({ error: 'invalid_value', issues: e.issues }, { status: 400 });
    }
    throw e;
  }
}

export async function DELETE({ params }) {
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });
  await deleteConfigKey(getDb(), id, params.key);
  return json({ ok: true });
}
