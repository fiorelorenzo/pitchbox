import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { loadWebhooks, saveWebhooks } from '@pitchbox/shared/notifications';
import { recordInstanceAudit } from '@pitchbox/shared/instance-audit';
import { requireInstanceAdmin } from '$lib/server/auth.js';

const Body = z.object({
  url: z.url().nullable(),
});

export async function PUT(event: RequestEvent) {
  const { request } = event;
  await requireInstanceAdmin(event);
  const raw = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) throw error(400, 'invalid_body');
  const db = getDb();
  const before = await loadWebhooks(db);
  await saveWebhooks(db, { url: parsed.data.url ?? undefined });
  // `url` is redacted by recordInstanceAudit's own field-name rule (a
  // webhook target can carry a bearer token in its path or query string) -
  // the row gets a fingerprint, never the URL itself.
  await recordInstanceAudit(db, {
    key: 'notification_webhooks',
    actor: event.locals.user ?? null,
    before: { url: before.url ?? null },
    after: { url: parsed.data.url },
  });
  return json({ ok: true });
}
