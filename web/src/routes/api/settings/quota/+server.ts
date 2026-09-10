import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '$lib/server/db.js';
import { recordInstanceAudit } from '@pitchbox/shared/instance-audit';
import { isCloud } from '@pitchbox/shared/edition';
import { requireInstanceAdmin, requireRole } from '$lib/server/auth.js';

const Window = z
  .object({ perDay: z.number().int().min(0), perWeek: z.number().int().min(0) })
  .refine((w) => w.perWeek >= w.perDay, {
    message: 'perWeek must be >= perDay',
    path: ['perWeek'],
  });

const PlatformLimits = z.object({
  dm: Window,
  comment: Window,
  post: Window,
});

const Body = z.record(z.string().min(1), PlatformLimits);

// Same view/mutate split as settings/+page.server.ts: viewing the platform
// quota defaults is gated to the per-org 'admin' role on self-host; on
// cloud that role is not the right axis (#183, any user can self-create an
// org and become its admin/owner), so the read narrows to
// `requireInstanceAdmin` there too. Saving them is instance-wide config
// either way, so it always needed the stricter requireInstanceAdmin (#137).
export async function GET(event: RequestEvent) {
  if (isCloud()) {
    await requireInstanceAdmin(event);
  } else {
    requireRole(event, 'admin');
  }
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.appConfig)
    .where(eq(schema.appConfig.key, 'quota_defaults'));
  return json(row?.value ?? {});
}

export async function POST(event: RequestEvent) {
  const { request } = event;
  await requireInstanceAdmin(event);
  const raw = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success)
    throw error(
      400,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );

  const db = getDb();
  const [existing] = await db
    .select()
    .from(schema.appConfig)
    .where(eq(schema.appConfig.key, 'quota_defaults'));
  await db
    .insert(schema.appConfig)
    .values({ key: 'quota_defaults', value: parsed.data })
    .onConflictDoUpdate({
      target: schema.appConfig.key,
      set: { value: parsed.data },
    });
  await recordInstanceAudit(db, {
    key: 'quota_defaults',
    actor: event.locals.user ?? null,
    before: existing?.value ?? {},
    after: parsed.data,
  });
  return json({ ok: true });
}
