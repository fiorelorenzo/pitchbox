import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { saveWebhooks } from '@pitchbox/shared/notifications';

const Body = z.object({
  url: z.string().url().nullable(),
});

export async function PUT({ request }: { request: Request }) {
  const raw = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) throw error(400, 'invalid_body');
  const db = getDb();
  await saveWebhooks(db, { url: parsed.data.url ?? undefined });
  return json({ ok: true });
}
