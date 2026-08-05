import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { AGENT_RUNNER_META, type AgentRunnerSlug } from '@pitchbox/shared/agents/meta';
import { loadDefaultRunnerSlug, saveDefaultRunnerSlug } from '@pitchbox/shared/agents/config';
import { requireInstanceAdmin, requireRole } from '$lib/server/auth.js';

const Body = z.object({ slug: z.string() });

// Same view/mutate split as settings/+page.server.ts and
// settings/retention/+page.server.ts: viewing the configured default runner
// is gated to the per-org 'admin' role, changing it is instance-wide config
// so it needs the stricter requireInstanceAdmin (#137).
export async function GET(event: RequestEvent) {
  requireRole(event, 'admin');
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
  await saveDefaultRunnerSlug(getDb(), parsed.data.slug as AgentRunnerSlug);
  return json({ ok: true, slug: parsed.data.slug });
}
