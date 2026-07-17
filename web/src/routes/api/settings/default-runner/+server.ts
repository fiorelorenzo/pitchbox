import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { AGENT_RUNNER_META } from '@pitchbox/shared/agents/meta';
import { requireInstanceAdmin } from '$lib/server/auth.js';

const Body = z.object({ slug: z.string() });

const KEY = 'default_runner';

export async function GET() {
  const db = getDb();
  const [row] = await db
    .select({ value: schema.appConfig.value })
    .from(schema.appConfig)
    .where(eq(schema.appConfig.key, KEY));
  return json({ slug: (row?.value as { slug?: string })?.slug ?? null });
}

export async function PUT(event: RequestEvent) {
  const { request } = event;
  await requireInstanceAdmin(event);
  const raw = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) throw error(400, 'invalid_body');
  if (!AGENT_RUNNER_META.some((m) => m.slug === parsed.data.slug && m.implemented)) {
    throw error(400, 'runner_not_implemented');
  }
  const value = { slug: parsed.data.slug };
  await getDb()
    .insert(schema.appConfig)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: schema.appConfig.key, set: { value } });
  return json({ ok: true, slug: parsed.data.slug });
}
