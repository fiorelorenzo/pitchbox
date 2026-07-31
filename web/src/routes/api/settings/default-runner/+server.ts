import { json, error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db.js';
import { AGENT_RUNNER_META, type AgentRunnerSlug } from '@pitchbox/shared/agents/meta';
import { loadDefaultRunnerSlug, saveDefaultRunnerSlug } from '@pitchbox/shared/agents/config';
import { requireInstanceAdmin } from '$lib/server/auth.js';

const Body = z.object({ slug: z.string() });

export async function GET() {
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
