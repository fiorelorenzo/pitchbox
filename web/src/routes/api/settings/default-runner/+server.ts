import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { AGENT_RUNNER_META, type AgentRunnerSlug } from '@pitchbox/shared/agents/meta';
import { loadDefaultRunnerSlug, saveDefaultRunnerSlug } from '@pitchbox/shared/agents/config';
import { isCloud, isRunnerAllowed } from '@pitchbox/shared/edition';
import { recordInstanceAudit } from '@pitchbox/shared/instance-audit';
import { requireInstanceAdmin, requireRole } from '$lib/server/auth.js';

const Body = z.object({ slug: z.string() });

// Same view/mutate split as settings/+page.server.ts and
// settings/retention/+page.server.ts: viewing the configured default runner
// is gated to the per-org 'admin' role on self-host, matching #237/#254's
// original split; on cloud that role is not the right axis (#183, any user
// can self-create an org and become its admin/owner), so the read narrows
// to `requireInstanceAdmin` there too. Changing it is instance-wide config
// either way, so it always needed the stricter requireInstanceAdmin (#137).
export async function GET(event: RequestEvent) {
  if (isCloud()) {
    await requireInstanceAdmin(event);
  } else {
    requireRole(event, 'admin');
  }
  return json({ slug: await loadDefaultRunnerSlug(getDb()) });
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
  if (!isRunnerAllowed(parsed.data.slug)) {
    throw error(400, 'runner_not_allowed');
  }
  const db = getDb();
  const before = await loadDefaultRunnerSlug(db);
  await saveDefaultRunnerSlug(db, parsed.data.slug as AgentRunnerSlug);
  await recordInstanceAudit(db, {
    key: 'default_runner',
    actor: event.locals.user ?? null,
    before: { slug: before },
    after: { slug: parsed.data.slug },
  });
  return json({ ok: true, slug: parsed.data.slug });
}
