import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import {
  listLatestConfigs,
  saveConfigVersion,
  ConfigConflictError,
  getProjectById,
} from '@pitchbox/shared/projects';

const PostBody = z.object({ key: z.string().min(1).max(120), value: z.unknown() });

function parseId(p: string): number | null {
  const n = Number(p);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET({ params }) {
  const id = parseId(params.id);
  if (!id) return json({ error: 'invalid_id' }, { status: 400 });
  const configs = await listLatestConfigs(getDb(), id);
  return json({ configs });
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
  if (!(await getProjectById(db, id))) {
    return json({ error: 'not_found' }, { status: 404 });
  }
  try {
    const out = await saveConfigVersion(db, id, parsed.data.key, parsed.data.value, null);
    return json({ key: parsed.data.key, version: out.version }, { status: 201 });
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
