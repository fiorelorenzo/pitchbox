import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';

const Window = z
  .object({ perDay: z.number().int().min(0), perWeek: z.number().int().min(0) })
  .refine((w) => w.perWeek >= w.perDay, { message: 'perWeek must be >= perDay' });

const PlatformLimits = z.object({
  dm: Window,
  comment: Window,
  post: Window,
});

const Body = z.object({
  reddit: PlatformLimits,
});

export async function GET() {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.appConfig)
    .where(eq(schema.appConfig.key, 'quota_defaults'));
  return json(row?.value ?? {});
}

export async function POST({ request }: { request: Request }) {
  const raw = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) throw error(400, parsed.error.issues.map((i) => i.message).join('; '));

  const db = getDb();
  await db
    .insert(schema.appConfig)
    .values({ key: 'quota_defaults', value: parsed.data })
    .onConflictDoUpdate({
      target: schema.appConfig.key,
      set: { value: parsed.data },
    });
  return json({ ok: true });
}
